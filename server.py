"""
AI Cover Studio — local FastAPI server (Python sidecar for the Electron app).

Exposes the engine over HTTP on 127.0.0.1 so the Electron renderer (plain
HTML/JS) can drive it. Long-running jobs (convert, train) run in background
threads and stream progress + live logs to the UI over Server-Sent Events.

Endpoints
    GET  /api/health                 → readiness + hardware summary
    GET  /api/models                 → list installed voice models
    POST /api/models/import          → copy .pth/.index files (by local path)
    POST /api/convert                → start a cover job  → {job_id}
    POST /api/train                  → start a training job → {job_id}
    GET  /api/jobs/{id}/events        → SSE: progress / log / done / error
    GET  /api/outputs/{name}          → download/stream a finished cover
    POST /api/shutdown                → graceful stop (called by Electron on quit)

Run standalone for development:
    .venv/bin/python server.py --port 8760
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

import engine

app = FastAPI(title="AI Cover Studio")

# The renderer is loaded from a file:// origin (packaged) or localhost (dev);
# allow any local origin since the server only binds to 127.0.0.1.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Job registry — each long task streams events to its own queue
# ---------------------------------------------------------------------------
class Job:
    __slots__ = ("id", "q", "done", "result", "error")

    def __init__(self) -> None:
        self.id = uuid.uuid4().hex
        self.q: "queue.Queue[dict]" = queue.Queue()
        self.done = False
        self.result: Optional[dict] = None
        self.error: Optional[str] = None

    def put(self, event: dict) -> None:
        self.q.put(event)


JOBS: dict[str, Job] = {}
_train_lock = threading.Lock()  # one training job at a time


def _run_job(job: Job, fn, *args, **kwargs) -> None:
    """Execute fn in this thread, translating callbacks into SSE events."""
    def progress_cb(frac: float, step: str, note: str = "") -> None:
        job.put({"type": "progress", "fraction": round(frac, 4),
                 "step": step, "note": note})

    def log_cb(line: str) -> None:
        job.put({"type": "log", "line": line})

    kwargs["progress_cb"] = progress_cb
    kwargs["log_cb"] = log_cb
    try:
        result = fn(*args, **kwargs)
        job.result = result if isinstance(result, dict) else {"path": str(result)}
        job.put({"type": "done", "result": job.result})
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI
        engine.log.exception("Job %s failed", job.id)
        job.error = str(exc)
        job.put({"type": "error", "message": str(exc)})
    finally:
        job.done = True
        job.put({"type": "_eof"})  # sentinel so the SSE generator can stop


def _start(job: Job, fn, *args, **kwargs) -> None:
    threading.Thread(target=_run_job, args=(job, fn, *args),
                     kwargs=kwargs, daemon=True).start()


# ---------------------------------------------------------------------------
# Basic endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "hardware": engine.hardware_summary(),
            "sample_rates": engine.SAMPLE_RATE_CHOICES,
            "data_dir": str(engine.DATA_DIR)}


@app.get("/api/models")
def models() -> dict:
    return {"models": engine.list_voice_models()}


@app.post("/api/models/import")
def import_models(payload: dict) -> dict:
    """Import .pth/.index files chosen via the native OS file dialog (paths)."""
    paths = payload.get("paths", [])
    return engine.import_model_files(paths)


@app.post("/api/models/import-bundle")
def import_voice_bundle(payload: dict) -> dict:
    """Import one user-selected RVC voice and its optional search index."""
    try:
        return engine.import_voice_bundle(
            str(payload.get("pth_path", "")),
            str(payload.get("index_path", "")),
            str(payload.get("name", "")),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Model library management (additive; the ML engine is untouched)
#
# These are thin file-management helpers over engine.MODELS_DIR / OUTPUT_DIR.
# They never touch model weights or training logic — only list, rename, delete,
# and serve files the user already owns on their own machine.
# ---------------------------------------------------------------------------
def _index_files_for(stem: str) -> list[Path]:
    """.index files that clearly belong to a model named `stem`."""
    return [p for p in engine.MODELS_DIR.glob("*.index") if p.stem.startswith(stem)]


@app.get("/api/models/meta")
def models_meta() -> dict:
    """List installed models with on-disk metadata (size, modified time)."""
    out = []
    for name in engine.list_voice_models():
        pth = engine.MODELS_DIR / f"{name}.pth"
        try:
            st = pth.stat()
        except OSError:
            continue
        idx = _index_files_for(name)
        idx_size = sum(p.stat().st_size for p in idx if p.exists())
        out.append({
            "name": name,
            "size": st.st_size + idx_size,
            "modified": st.st_mtime,
            "has_index": bool(idx),
        })
    return {"models": out}


@app.post("/api/models/rename")
def rename_model(payload: dict) -> dict:
    """Rename a model's .pth (and any paired .index files) in place."""
    old = Path(str(payload.get("old", ""))).stem
    new = engine.safe_model_name(str(payload.get("new", "")))
    if not old or not new:
        raise HTTPException(status_code=400, detail="Both old and new names are required.")
    src = engine.MODELS_DIR / f"{old}.pth"
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Model '{old}' not found.")
    dst = engine.MODELS_DIR / f"{new}.pth"
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"A model named '{new}' already exists.")
    src.rename(dst)
    for idx in _index_files_for(old):
        idx.rename(engine.MODELS_DIR / (new + idx.name[len(old):]))
    return {"name": new, "models": engine.list_voice_models()}


@app.post("/api/models/delete")
def delete_model(payload: dict) -> dict:
    """Delete a model's .pth and any paired .index files."""
    name = Path(str(payload.get("name", ""))).stem
    pth = engine.MODELS_DIR / f"{name}.pth"
    if not name or not pth.exists():
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found.")
    pth.unlink()
    for idx in _index_files_for(name):
        try:
            idx.unlink()
        except OSError:
            pass
    return {"deleted": name, "models": engine.list_voice_models()}


@app.get("/api/models/file/{name}")
def model_file(name: str) -> FileResponse:
    """Serve a model's .pth so the renderer can export it via the save dialog."""
    safe = Path(name).stem
    pth = engine.MODELS_DIR / f"{safe}.pth"
    if not pth.exists():
        raise HTTPException(status_code=404, detail="Model not found.")
    return FileResponse(str(pth), media_type="application/octet-stream",
                        filename=f"{safe}.pth")


# ---------------------------------------------------------------------------
# Generated-cover library (additive)
# ---------------------------------------------------------------------------
@app.get("/api/outputs")
def list_outputs() -> dict:
    """List finished covers (final_cover_*.mp3) with size + modified time."""
    items = []
    for p in engine.OUTPUT_DIR.glob("final_cover_*.mp3"):
        try:
            st = p.stat()
        except OSError:
            continue
        items.append({"name": p.name, "size": st.st_size, "modified": st.st_mtime})
    items.sort(key=lambda x: x["modified"], reverse=True)
    return {"covers": items}


@app.post("/api/outputs/delete")
def delete_output(payload: dict) -> dict:
    """Delete a single finished cover by filename."""
    safe = Path(str(payload.get("name", ""))).name
    path = engine.OUTPUT_DIR / safe
    if not safe.startswith("final_cover_") or not path.exists():
        raise HTTPException(status_code=404, detail="Output not found.")
    path.unlink()
    return {"deleted": safe}


# ---------------------------------------------------------------------------
# Upload helper — save an UploadFile to a temp path the engine can read
# ---------------------------------------------------------------------------
def _save_upload(upload: UploadFile, prefix: str) -> str:
    suffix = Path(upload.filename or "").suffix or ".bin"
    fd, tmp = tempfile.mkstemp(prefix=prefix, suffix=suffix,
                               dir=str(engine.OUTPUT_DIR))
    with os.fdopen(fd, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    return tmp


# ---------------------------------------------------------------------------
# Convert (cover generation)
# ---------------------------------------------------------------------------
@app.post("/api/convert")
def convert(
    model_name: str = Form(...),
    pitch_shift: int = Form(0),
    index_rate: float = Form(0.75),
    vocal_gain_db: float = Form(0.0),
    song: UploadFile = File(...),
) -> dict:
    song_path = _save_upload(song, "song_")
    job = Job()
    JOBS[job.id] = job
    _start(job, engine.generate_cover, model_name, song_path,
           int(pitch_shift), float(index_rate), float(vocal_gain_db))
    return {"job_id": job.id}


# ---------------------------------------------------------------------------
# Train
# ---------------------------------------------------------------------------
@app.post("/api/train")
def train(
    model_name: str = Form("my_voice"),
    sample_rate: str = Form("40000"),
    epochs: int = Form(300),
    dataset_dir: str = Form(""),
    samples: list[UploadFile] = File(default=[]),
) -> dict:
    if not _train_lock.acquire(blocking=False):
        raise HTTPException(status_code=409,
                            detail="A training job is already running.")

    safe_name = engine.safe_model_name(model_name)
    sample_paths = [_save_upload(s, "sample_") for s in samples or []]

    job = Job()
    JOBS[job.id] = job

    def run_and_release() -> None:
        try:
            _run_job(job, engine.train_voice_model, sample_paths, dataset_dir,
                     safe_name, sample_rate, int(epochs))
        finally:
            _train_lock.release()

    threading.Thread(target=run_and_release, daemon=True).start()
    return {"job_id": job.id}


# ---------------------------------------------------------------------------
# SSE event stream for a job
# ---------------------------------------------------------------------------
@app.get("/api/jobs/{job_id}/events")
def job_events(job_id: str) -> StreamingResponse:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")

    def event_stream():
        # Replay a first heartbeat immediately so the client knows it connected.
        yield "event: open\ndata: {}\n\n"
        while True:
            try:
                event = job.q.get(timeout=15)
            except queue.Empty:
                yield ": keep-alive\n\n"  # comment line keeps the socket warm
                continue
            if event.get("type") == "_eof":
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Serve finished covers
# ---------------------------------------------------------------------------
@app.get("/api/outputs/{name}")
def get_output(name: str) -> FileResponse:
    # Prevent path traversal — only serve plain filenames from OUTPUT_DIR.
    safe = Path(name).name
    path = engine.OUTPUT_DIR / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output not found.")
    return FileResponse(str(path), media_type="audio/mpeg", filename=safe)


@app.post("/api/shutdown")
def shutdown() -> dict:
    # Deferred so the HTTP response flushes before the process exits.
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"status": "shutting down"}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8760)
    args = parser.parse_args()
    # Announce the bound port on stdout so the Electron main process can read it.
    print(f"ACS_SERVER_READY port={args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
