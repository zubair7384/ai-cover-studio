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
import traceback
import uuid
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

import engine
import covers_manifest
import voices_manifest

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
class JobCancelled(Exception):
    """Raised out of the progress callback to unwind a running pipeline."""


class Job:
    __slots__ = ("id", "q", "done", "result", "error", "cancelled")

    def __init__(self) -> None:
        self.id = uuid.uuid4().hex
        self.q: "queue.Queue[dict]" = queue.Queue()
        self.done = False
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.cancelled = False

    def put(self, event: dict) -> None:
        self.q.put(event)


JOBS: dict[str, Job] = {}
_train_lock = threading.Lock()  # one training job at a time


def _run_job(job: Job, fn, *args, **kwargs) -> None:
    """Execute fn in this thread, translating callbacks into SSE events."""
    def progress_cb(frac: float, step: str, note: str = "") -> None:
        # Python threads cannot be killed, so cancellation is cooperative: the
        # pipeline reports progress between stages, and we unwind at the next
        # boundary. The UI says so rather than implying an instant stop.
        if job.cancelled:
            raise JobCancelled()
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
    except JobCancelled:
        engine.log.info("Job %s cancelled", job.id)
        job.put({"type": "cancelled"})
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI
        engine.log.exception("Job %s failed", job.id)
        job.error = str(exc)
        # `detail` carries the traceback for a "Copy details" button; the UI
        # never renders a stack trace inline (§Prompt 4).
        job.put({"type": "error", "message": str(exc),
                 "detail": traceback.format_exc()})
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
    """
    Installed models with everything the library needs: sample rate and
    architecture read from the .pth header, whether a preview clip exists, and
    how many covers reference the voice (so a delete can warn first).
    """
    return {"models": voices_manifest.list_voices()}


@app.get("/api/models/preview/{name}")
def model_preview(name: str) -> FileResponse:
    """Serve a voice's preview clip."""
    safe = Path(name).stem
    path = voices_manifest.preview_path(safe)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No preview clip for that voice yet.")
    return FileResponse(path, media_type="audio/mpeg")


@app.post("/api/models/preview")
def create_model_preview(payload: dict) -> dict:
    """
    Render a short sample of a voice from a reference vocal clip. Runs the RVC
    step only — no separation, no mixing — so it takes seconds, not minutes.

    The reference is passed as a local path rather than an upload: the renderer,
    the server and the file all live on the same machine, so a round trip
    through multipart would only copy bytes for no reason.
    """
    safe = Path(str(payload.get("model_name", ""))).stem
    ref_path = str(payload.get("reference_path", ""))
    if not safe:
        raise HTTPException(status_code=400, detail="Which voice?")
    if not ref_path or not Path(ref_path).exists():
        raise HTTPException(status_code=400, detail="That reference clip no longer exists.")

    job = Job()
    JOBS[job.id] = job
    _start(job, voices_manifest.generate_preview, safe, ref_path,
           int(payload.get("pitch_shift", 0) or 0),
           float(payload.get("index_rate", 0.75) or 0.75))
    return {"job_id": job.id}


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
    # Take the preview clip with it, or a re-imported model of the same name
    # would inherit the old voice's sample.
    voices_manifest.delete_preview(name)
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
    """
    Full cover records, reconciled against the disk on every scan.

    Files with no record gain a stub; records whose file has gone are flagged
    `missing` rather than dropped, so the UI can offer "Locate…" and
    "Remove from library".
    """
    return {"covers": covers_manifest.reconcile()}


@app.post("/api/outputs/migrate")
def migrate_outputs(payload: dict | None = None) -> dict:
    """
    One-time backfill. The desktop app hands over the renderer's retired
    localStorage `coverMeta` (which the app can no longer read itself, because
    the renderer origin changed) and everything else is backfilled from
    filenames. Idempotent — existing records are never downgraded.
    """
    legacy = (payload or {}).get("coverMeta") or {}
    if not isinstance(legacy, dict):
        raise HTTPException(status_code=400, detail="coverMeta must be an object.")
    return covers_manifest.migrate(legacy)


@app.post("/api/outputs/title")
def set_output_title(payload: dict) -> dict:
    """Rename a cover in the library. The file on disk is untouched."""
    cover_id = Path(str(payload.get("id", ""))).name
    try:
        return covers_manifest.update_title(cover_id, str(payload.get("title", "")))
    except KeyError:
        raise HTTPException(status_code=404, detail="That cover is not in the library.")
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.post("/api/outputs/relocate")
def relocate_output(payload: dict) -> dict:
    """Re-point a record at a file that moved outside the app."""
    cover_id = Path(str(payload.get("id", ""))).name
    try:
        return covers_manifest.relocate(cover_id, str(payload.get("path", "")))
    except KeyError:
        raise HTTPException(status_code=404, detail="That cover is not in the library.")
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.post("/api/outputs/delete")
def delete_output(payload: dict) -> dict:
    """
    Remove a cover. `trashFile` decides whether the file goes to the Trash or
    only the library record is forgotten (the latter is "Remove from library"
    for a file that has already gone missing).
    """
    cover_id = Path(str(payload.get("id") or payload.get("name") or "")).name
    if not cover_id:
        raise HTTPException(status_code=400, detail="Which cover?")
    trash = payload.get("trashFile", True)
    return covers_manifest.delete(cover_id, trash_file=bool(trash))


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
def convert(payload: dict) -> dict:
    """
    Start a cover run. The song is referenced by local path rather than
    uploaded: renderer, server and file share a machine, so multipart would
    copy a 40 MB track for nothing.
    """
    model_name = str(payload.get("model_name", ""))
    song_path = str(payload.get("song_path", ""))
    if not model_name:
        raise HTTPException(status_code=400, detail="Choose a voice first.")
    if not song_path or not Path(song_path).exists():
        raise HTTPException(status_code=400, detail="That song file no longer exists.")

    # Absent keys mean the whole song; 0.0 is a legitimate start, so this cannot
    # collapse to `or None`.
    trim_start = payload.get("trim_start")
    trim_end = payload.get("trim_end")
    if trim_start is not None or trim_end is not None:
        try:
            trim_start = float(trim_start) if trim_start is not None else 0.0
            trim_end = float(trim_end) if trim_end is not None else 0.0
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="That trim isn't a valid time range.")
        if trim_end and trim_end - trim_start < 1.0:
            raise HTTPException(status_code=400,
                                detail="That selection is under a second — pick a longer part.")

    job = Job()
    JOBS[job.id] = job
    _start(job, engine.generate_cover, model_name, song_path,
           int(payload.get("pitch_shift", 0) or 0),
           float(payload.get("index_rate", 0.75) or 0.75),
           float(payload.get("vocal_gain_db", 0.0) or 0.0),
           source_file_name=Path(song_path).name,
           output_format=str(payload.get("output_format", "mp3") or "mp3"),
           trim_start=trim_start, trim_end=trim_end)
    return {"job_id": job.id}


# ---------------------------------------------------------------------------
# Remix — change the mix of an existing cover without re-running the model
# ---------------------------------------------------------------------------
_STEM_KEYS = {"vocals": "vocals", "instrumental": "instrumental",
              "vocalsFx": "vocalsFx"}


@app.get("/api/covers/{cover_id}/stems/{which}")
def cover_stem(cover_id: str, which: str) -> FileResponse:
    """
    Serve one of a cover's stems, so the renderer can play them against each
    other and let the balance be heard while it is being dragged.
    """
    key = _STEM_KEYS.get(which)
    if not key:
        raise HTTPException(status_code=404, detail="No such stem.")

    record = covers_manifest.get(cover_id)
    path = Path(((record or {}).get("stems") or {}).get(key) or "")
    if not record or not path.is_file():
        raise HTTPException(status_code=404,
                            detail="This cover's working files are no longer on disk.")
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/remix")
def remix(payload: dict) -> dict:
    """
    Re-mix at a new balance/speed/format. Synchronous rather than a job: there
    is no model run here, so it finishes in about the time an export takes.
    """
    cover_id = str(payload.get("id", ""))
    if not cover_id:
        raise HTTPException(status_code=400, detail="Which cover?")

    speed = float(payload.get("speed", 1.0) or 1.0)
    if not 0.25 <= speed <= 4.0:
        raise HTTPException(status_code=400, detail="That speed is out of range.")

    try:
        record = engine.remix_cover(
            cover_id,
            vocal_gain_db=float(payload.get("vocal_gain_db", 0.0) or 0.0),
            speed=speed,
            output_format=str(payload.get("output_format", "mp3") or "mp3"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"cover": record}


# ---------------------------------------------------------------------------
# Fetch a song from a link
# ---------------------------------------------------------------------------
@app.post("/api/fetch-url")
def fetch_url(payload: dict) -> dict:
    """
    Resolve a pasted link to a local audio file. Runs as a job because a
    download is slow enough to need a progress bar and a cancel button.
    """
    url = str(payload.get("url", "")).strip()
    if not url:
        raise HTTPException(status_code=400, detail="Paste a link first.")

    job = Job()
    JOBS[job.id] = job
    _start(job, engine.fetch_remote_audio, url)
    return {"job_id": job.id}


@app.post("/api/downloads/clear")
def clear_downloads() -> dict:
    """Empty the fetched-audio cache (Settings → Storage)."""
    return engine.clear_downloads()


# ---------------------------------------------------------------------------
# Storage (Settings)
# ---------------------------------------------------------------------------
def _dir_size(path: Path, patterns: tuple[str, ...] = ("*",)) -> tuple[int, int]:
    """(bytes, file count) for files matching any pattern directly in `path`."""
    total = count = 0
    seen: set[Path] = set()
    for pattern in patterns:
        for f in path.glob(pattern):
            if f in seen or not f.is_file():
                continue
            seen.add(f)
            try:
                total += f.stat().st_size
                count += 1
            except OSError:
                pass
    return total, count


@app.get("/api/storage")
def storage() -> dict:
    """What Vocalis is using on this Mac, and where."""
    models_bytes, models_count = _dir_size(engine.MODELS_DIR, ("*.pth", "*.index"))
    covers_bytes, covers_count = _dir_size(engine.OUTPUT_DIR, covers_manifest.COVER_GLOBS)
    datasets_bytes, _ = _dir_size(engine.DATASETS_DIR, ("**/*",))
    downloads_bytes, downloads_count = _dir_size(engine.DOWNLOADS_DIR, ("*",))

    return {
        "models": {"bytes": models_bytes, "count": models_count},
        "covers": {"bytes": covers_bytes, "count": covers_count},
        "datasets": {"bytes": datasets_bytes},
        "downloads": {"bytes": downloads_bytes, "count": downloads_count},
        "total": models_bytes + covers_bytes + datasets_bytes + downloads_bytes,
        "dataDir": str(engine.DATA_DIR),
        "outputDir": str(engine.OUTPUT_DIR),
        "modelsDir": str(engine.MODELS_DIR),
        "hardware": engine.hardware_summary(),
    }


@app.post("/api/outputs/delete-all")
def delete_all_outputs(payload: dict | None = None) -> dict:
    """
    Delete every generated cover. The UI states the exact count and size first
    and requires a second click — this endpoint is the second click.
    """
    trash = bool((payload or {}).get("trashFiles", True))
    records = covers_manifest.load()
    removed = 0
    freed = 0
    for name in list(records.keys()):
        path = Path(records[name].get("outputPath") or (engine.OUTPUT_DIR / name))
        try:
            freed += path.stat().st_size
        except OSError:
            pass
        covers_manifest.delete(name, trash_file=trash)
        removed += 1
    return {"removed": removed, "freedBytes": freed}


# ---------------------------------------------------------------------------
# Audio probe — for the training recordings list
# ---------------------------------------------------------------------------
_MIN_USABLE_SEC = 3.0
_MAX_USABLE_SEC = 900.0


def _probe_one(path: Path, target_sr: int) -> dict:
    """Duration, sample rate and an honest usability warning for one clip."""
    info: dict = {
        "path": str(path), "name": path.name,
        "durationSec": None, "sampleRate": None, "channels": None,
        "warning": None,
    }
    if not path.exists():
        info["warning"] = "This file has moved or been deleted."
        return info

    try:
        import soundfile as sf
        meta = sf.info(str(path))
        info["durationSec"] = round(meta.frames / float(meta.samplerate), 2)
        info["sampleRate"] = int(meta.samplerate)
        info["channels"] = int(meta.channels)
    except Exception:
        try:
            import av
            with av.open(str(path)) as c:
                stream = next((st for st in c.streams if st.type == "audio"), None)
                if stream is not None:
                    info["sampleRate"] = int(stream.codec_context.sample_rate or 0) or None
                    info["channels"] = int(stream.codec_context.channels or 0) or None
                if c.duration:
                    info["durationSec"] = round(c.duration / 1_000_000, 2)
        except Exception:
            info["warning"] = "Couldn't read this file — it may not be audio."
            return info

    dur = info["durationSec"]
    sr = info["sampleRate"]

    # Stated plainly, with the reason — not a generic "invalid file".
    if dur is not None and dur < _MIN_USABLE_SEC:
        info["warning"] = f"Only {dur:.1f}s — too short to learn from."
    elif dur is not None and dur > _MAX_USABLE_SEC:
        info["warning"] = "Longer than 15 minutes — split it into shorter takes."
    elif sr and sr < target_sr:
        info["warning"] = f"{sr // 1000} kHz is below the {target_sr // 1000} kHz target."

    return info


@app.post("/api/audio/probe")
def probe_audio(payload: dict) -> dict:
    """Duration, sample rate and usability warnings for a set of local clips."""
    paths = payload.get("paths") or []
    target = int(payload.get("target_sample_rate", 40000) or 40000)
    return {"clips": [_probe_one(Path(str(p)), target) for p in paths]}


@app.post("/api/audio/scan-folder")
def scan_folder(payload: dict) -> dict:
    """Every audio file directly inside a folder — for folder drops."""
    folder = Path(str(payload.get("path", ""))).expanduser()
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail="That folder no longer exists.")
    target = int(payload.get("target_sample_rate", 40000) or 40000)
    files = sorted(p for p in folder.iterdir()
                   if p.suffix.lower() in engine.AUDIO_EXTS)
    return {"clips": [_probe_one(p, target) for p in files]}


# ---------------------------------------------------------------------------
# Train
# ---------------------------------------------------------------------------
@app.post("/api/train")
def train(payload: dict) -> dict:
    """
    Start a training run. Clips are referenced by local path — a training set is
    routinely hundreds of megabytes, and copying it through multipart before the
    engine copies it again into the dataset folder would be pure waste.
    """
    if not _train_lock.acquire(blocking=False):
        raise HTTPException(status_code=409,
                            detail="A training job is already running.")

    model_name = str(payload.get("model_name", "my_voice"))
    sample_rate = str(payload.get("sample_rate", "40000"))
    epochs = int(payload.get("epochs", 300) or 300)
    dataset_dir = str(payload.get("dataset_dir", ""))
    safe_name = engine.safe_model_name(model_name)
    sample_paths = [str(p) for p in (payload.get("paths") or [])]

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
@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    """
    Ask a running job to stop. It unwinds at the next stage boundary rather
    than instantly, because the work happens in a thread that cannot be killed.
    """
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="That job has already finished.")
    job.cancelled = True
    return {"cancelling": job_id}


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
