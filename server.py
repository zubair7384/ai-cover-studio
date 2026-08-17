"""
AI Cover Studio — local FastAPI server (Python sidecar for the Electron app).

Exposes the engine over HTTP on 127.0.0.1 so the Electron renderer (plain
HTML/JS) can drive it. Long-running jobs (convert, train) run in background
threads and stream progress + live logs to the UI over Server-Sent Events.

Endpoints
    GET  /api/health                 → readiness + hardware summary
    GET  /api/models                 → list installed voice models
    POST /api/models/import          → copy .pth/.index files (by local path)
    GET  /api/hf/voices              → browse RVC voices published on Hugging Face
    POST /api/hf/download            → install one of them → {job_id}
    POST /api/convert                → start a cover job  → {job_id}
    POST /api/batch                  → queue many songs through one voice → {job_id}
    POST /api/analyse                → key, vocal range, suggested pitch shift
    POST /api/karaoke                → export a cover's backing track → {job_id}
    POST /api/covers/stems/export    → write a cover's stems to a folder → {job_id}
    POST /api/projects/save|open     → .vocalis project documents
    GET  /api/packs                  → installed voice packs
    POST /api/packs/inspect|install|export|forget
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

import analysis
import engine
import covers_manifest
import hf_voices
import packs
import projects
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
    # Provenance follows the name, or a renamed voice loses its face.
    voices_manifest.rename_origin(old, new)
    # The measured range does not follow it: the profile is keyed by name and
    # re-measuring costs seconds, where a stale entry would silently mis-suggest
    # a pitch shift for whatever voice next takes the old name.
    analysis.forget_voice_profile(old)
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
    voices_manifest.forget_origin(name)
    analysis.forget_voice_profile(name)
    return {"deleted": name, "models": engine.list_voice_models()}


# ---------------------------------------------------------------------------
# Online voice catalog (Hugging Face)
#
# Browsing is a plain GET because it is cheap and cached; installing is a job
# because it moves tens or hundreds of megabytes and the user deserves a
# progress bar and a Cancel, exactly like a cover render.
# ---------------------------------------------------------------------------
@app.get("/api/hf/voices")
def hf_voices_list(query: str = "", category: str = "", gender: str = "",
                   sort: str = "popular", page: int = 1,
                   page_size: int = 30) -> dict:
    try:
        return hf_voices.catalog(query=query, category=category, gender=gender,
                                 sort=sort, page=page, page_size=page_size)
    except RuntimeError as exc:
        # Offline, or the Hub is rate limiting. Either way it is a temporary
        # condition the user can act on, not a 500.
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/hf/portrait")
def hf_portrait(name: str) -> FileResponse:
    """
    A celebrity voice's portrait, fetched from Wikimedia Commons once and then
    served from disk.

    The renderer never reaches Wikimedia itself — the app's CSP forbids remote
    images, and routing through here means a portrait is downloaded a single
    time and works offline afterwards. A 404 is an ordinary outcome: the card
    simply keeps the tile it already drew.
    """
    path = hf_voices.fetch_portrait(str(name or ""))
    if not path:
        raise HTTPException(status_code=404, detail="No portrait for that voice.")
    return FileResponse(str(path), media_type="image/jpeg")


@app.get("/api/hf/portrait-credit")
def hf_portrait_credit(name: str) -> dict:
    """Attribution for a portrait already fetched. Cache-only, never blocks."""
    return hf_voices.portrait_credit(str(name or ""))


@app.post("/api/hf/refresh")
def hf_voices_refresh() -> dict:
    """Read the catalog again from the Hub, keeping per-commit caches."""
    hf_voices.refresh_catalog()
    return hf_voices.catalog(page_size=1)


@app.post("/api/hf/download")
def hf_voices_download(payload: dict) -> dict:
    """Install one online voice into voice_models/. Returns a job id."""
    repo_id = str(payload.get("repo_id", "") or "")
    pth_path = str(payload.get("pth_path", "") or "")
    if not repo_id or not pth_path:
        raise HTTPException(status_code=400, detail="Choose a voice to download.")

    name = engine.safe_model_name(str(payload.get("name", "") or ""))
    if (engine.MODELS_DIR / f"{name}.pth").exists():
        raise HTTPException(status_code=409,
                            detail=f"A voice named '{name}' is already installed.")

    job = Job()
    JOBS[job.id] = job
    _start(job, hf_voices.install, repo_id, pth_path,
           str(payload.get("index_path", "") or ""), name,
           str(payload.get("category", "") or ""),
           str(payload.get("gender", "") or ""),
           str(payload.get("portrait_name", "") or ""))
    return {"job_id": job.id}


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
           trim_start=trim_start, trim_end=trim_end,
           **_harmony_kwargs(payload))
    return {"job_id": job.id}


def _harmony_kwargs(payload: dict) -> dict:
    """
    The extra-vocal settings, clamped, from either a convert or a batch payload.

    Shared rather than duplicated because a batch run has to produce byte-for-
    byte the same arrangement as the single run the user auditioned first.
    """
    gain = payload.get("harmony_gain_db")
    try:
        gain = float(gain) if gain is not None else engine.HARMONY_GAIN_DB
    except (TypeError, ValueError):
        gain = engine.HARMONY_GAIN_DB

    return {
        "harmony_preset": str(payload.get("harmony_preset", "none") or "none"),
        "harmony_intervals_custom": payload.get("harmony_intervals") or None,
        "harmony_gain_db": max(engine.HARMONY_MIN_GAIN_DB,
                               min(engine.HARMONY_MAX_GAIN_DB, gain)),
        "double_track": bool(payload.get("double_track")),
    }


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
# Text to speech
# ---------------------------------------------------------------------------
@app.get("/api/speech/voices")
def speech_voices() -> dict:
    """
    The base voices the OS synthesiser offers, plus the input limits, so the
    view can render its controls without hardcoding anything the engine owns.
    """
    return {
        "available": engine.speech_available(),
        "voices": engine.list_speech_voices(),
        "rateDefault": engine.SPEECH_RATE_DEFAULT,
        "rateMin": engine.SPEECH_RATE_RANGE[0],
        "rateMax": engine.SPEECH_RATE_RANGE[1],
        "maxChars": engine.SPEECH_MAX_CHARS,
    }


@app.post("/api/speech")
def speak(payload: dict) -> dict:
    """
    Speak text in a trained voice. A job like /api/convert, though a much
    shorter one: nothing to separate and nothing to mix.
    """
    model_name = str(payload.get("model_name", ""))
    text = str(payload.get("text", ""))

    if not engine.speech_available():
        raise HTTPException(
            status_code=501,
            detail="Speech needs macOS's built-in synthesiser, which isn't available here.")
    if not model_name:
        raise HTTPException(status_code=400, detail="Choose a voice first.")
    if not text.strip():
        raise HTTPException(status_code=400, detail="Type something for the voice to say.")
    if len(text) > engine.SPEECH_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"That's over the {engine.SPEECH_MAX_CHARS:,}-character limit for one "
                   "clip — split it into a few.")

    speed = float(payload.get("speed", 1.0) or 1.0)
    if not 0.25 <= speed <= 4.0:
        raise HTTPException(status_code=400, detail="That speed is out of range.")

    job = Job()
    JOBS[job.id] = job
    _start(job, engine.generate_speech, model_name, text,
           str(payload.get("speech_voice", "") or ""),
           int(payload.get("pitch_shift", 0) or 0),
           float(payload.get("index_rate", 0.75) or 0.75),
           int(payload.get("rate", engine.SPEECH_RATE_DEFAULT) or engine.SPEECH_RATE_DEFAULT),
           output_format=str(payload.get("output_format", "mp3") or "mp3"),
           speed=speed)
    return {"job_id": job.id}


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
# Batch — many songs, one voice, one queue
#
# The machine can only run one cover at a time: separation and conversion both
# want the whole GPU (or the whole CPU), so running two at once makes both
# slower and neither finish sooner. A batch is therefore a queue, not a fan-out.
#
# It is one job with one event stream rather than N jobs, because that is how it
# is used: start ten songs, close the laptop lid, come back to ten covers. A
# failure on song 4 must not stop songs 5 through 10 — each item's outcome is
# recorded and the queue moves on.
# ---------------------------------------------------------------------------
MAX_BATCH_ITEMS = 50


def _run_batch(job: Job, items: list[dict], model_name: str,
               settings: dict) -> None:
    """Work the queue, reporting per-item state as well as overall progress."""
    state = [{"index": i, "name": item.get("name") or Path(item["path"]).name,
              "path": item["path"], "status": "queued", "coverId": None,
              "outputPath": None, "error": None}
             for i, item in enumerate(items)]

    def publish(note: str = "") -> None:
        done = sum(1 for s in state if s["status"] in {"done", "failed", "skipped"})
        job.put({
            "type": "batch",
            "items": state,
            "completed": done,
            "total": len(state),
            "note": note,
        })

    try:
        publish("Queued.")
        for i, item in enumerate(state):
            if job.cancelled:
                for remaining in state[i:]:
                    if remaining["status"] == "queued":
                        remaining["status"] = "skipped"
                publish("Cancelled — the rest of the queue was skipped.")
                job.put({"type": "cancelled"})
                return

            item["status"] = "running"
            publish(f"{item['name']} — song {i + 1} of {len(state)}")

            def progress_cb(frac: float, step: str, note: str = "",
                            _index: int = i) -> None:
                if job.cancelled:
                    raise JobCancelled()
                # Overall progress is the queue's, not the song's: a bar that
                # restarted at every track would say nothing about the wait.
                overall = (_index + max(0.0, min(1.0, frac))) / len(state)
                job.put({"type": "progress", "fraction": round(overall, 4),
                         "step": step, "note": note, "item": _index})

            try:
                path = engine.generate_cover(
                    model_name, item["path"],
                    progress_cb=progress_cb,
                    log_cb=lambda line: job.put({"type": "log", "line": line}),
                    source_file_name=Path(item["path"]).name,
                    title=str(items[i].get("title") or ""),
                    **settings)
                item["status"] = "done"
                item["outputPath"] = str(path)
                item["coverId"] = Path(path).name
            except JobCancelled:
                # The song under way when Cancel was pressed is not a failure.
                item["status"] = "skipped"
                for remaining in state[i + 1:]:
                    remaining["status"] = "skipped"
                publish("Cancelled.")
                job.put({"type": "cancelled"})
                return
            except Exception as exc:  # noqa: BLE001 — reported per item
                engine.log.exception("Batch item %s failed", item["name"])
                item["status"] = "failed"
                item["error"] = str(exc)

            publish()

        done = [s for s in state if s["status"] == "done"]
        failed = [s for s in state if s["status"] == "failed"]
        job.result = {
            "completed": len(done),
            "failed": len(failed),
            "total": len(state),
            "items": state,
        }
        job.put({"type": "done", "result": job.result})
    except Exception as exc:  # noqa: BLE001 — the queue itself broke
        engine.log.exception("Batch %s failed", job.id)
        job.error = str(exc)
        job.put({"type": "error", "message": str(exc),
                 "detail": traceback.format_exc()})
    finally:
        job.done = True
        job.put({"type": "_eof"})


@app.post("/api/batch")
def batch(payload: dict) -> dict:
    """
    Queue several songs through one voice with one set of settings.

    Trimming is deliberately not offered here: a trim is a decision about one
    particular song, and the same in-and-out points applied to ten different
    tracks would be wrong nine times.
    """
    model_name = str(payload.get("model_name", ""))
    if not model_name:
        raise HTTPException(status_code=400, detail="Choose a voice first.")
    if model_name not in engine.list_voice_models():
        raise HTTPException(status_code=404, detail="That voice isn't installed.")

    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(status_code=400, detail="Add at least one song.")
    if len(raw_items) > MAX_BATCH_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"A batch takes up to {MAX_BATCH_ITEMS} songs at a time.")

    items = []
    for raw in raw_items:
        path = str((raw or {}).get("path") or "")
        if not path or not Path(path).is_file():
            raise HTTPException(
                status_code=400,
                detail=f"'{Path(path).name or 'A song in the list'}' is no longer there.")
        items.append({"path": path,
                      "name": str((raw or {}).get("name") or Path(path).name),
                      "title": str((raw or {}).get("title") or "")})

    settings = {
        "pitch_shift": int(payload.get("pitch_shift", 0) or 0),
        "index_rate": float(payload.get("index_rate", 0.75) or 0.75),
        "vocal_gain_db": float(payload.get("vocal_gain_db", 0.0) or 0.0),
        "output_format": str(payload.get("output_format", "mp3") or "mp3"),
        "speed": float(payload.get("speed", 1.0) or 1.0),
        **_harmony_kwargs(payload),
    }

    job = Job()
    JOBS[job.id] = job
    threading.Thread(target=_run_batch, args=(job, items, model_name, settings),
                     daemon=True).start()
    return {"job_id": job.id, "total": len(items)}


# ---------------------------------------------------------------------------
# Analysis — key, and the pitch shift that follows from it
# ---------------------------------------------------------------------------
@app.post("/api/analyse")
def analyse(payload: dict) -> dict:
    """
    Measure a song, and suggest a pitch shift for a voice if one was named.

    Synchronous rather than a job: it is a couple of seconds on a cached read
    and the view that asks for it is waiting on the answer to draw a control.
    """
    song_path = str(payload.get("song_path", ""))
    if not song_path or not Path(song_path).is_file():
        raise HTTPException(status_code=400, detail="That song file no longer exists.")

    trim_start = payload.get("trim_start")
    trim_end = payload.get("trim_end")
    model_name = str(payload.get("model_name", "") or "")

    try:
        if model_name:
            return analysis.suggest_pitch_shift(song_path, model_name,
                                                trim_start, trim_end)
        return {"song": analysis.analyse_song(song_path, trim_start, trim_end),
                "semitones": 0, "confidence": "none", "voice": {},
                "reason": "Choose a voice to get a suggested shift."}
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    except Exception as err:  # noqa: BLE001 — analysis must never take a run down
        engine.log.exception("Analysis failed")
        raise HTTPException(
            status_code=500,
            detail=f"Couldn't analyse that song: {err}")


@app.get("/api/voices/{name}/profile")
def voice_range(name: str) -> dict:
    """Where one voice sits, for the Voices list."""
    return analysis.voice_profile(Path(name).name)


@app.post("/api/voices/profile")
def set_voice_range(payload: dict) -> dict:
    """
    Record the range of a voice the app cannot measure.

    Most installed voices are downloaded `.pth` files with no audio attached,
    so there is nothing to analyse and the pitch suggestion has nothing to work
    from. One choice from a dropdown is enough to make it useful.
    """
    name = Path(str(payload.get("name", ""))).name
    if not name or name not in engine.list_voice_models():
        raise HTTPException(status_code=404, detail="That voice isn't installed.")

    if payload.get("clear"):
        analysis.forget_voice_profile(name)
        return analysis.voice_profile(name)

    try:
        return analysis.set_manual_profile(
            name,
            range_key=str(payload.get("range", "")),
            median_f0=payload.get("median_f0"))
    except (TypeError, ValueError) as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.get("/api/voices/ranges")
def voice_range_choices() -> dict:
    """The ranges the UI offers, named and in order."""
    return {"ranges": [{"key": k, "hz": hz, "note": analysis.hz_to_note(hz)}
                       for k, hz in analysis.MANUAL_RANGES.items()]}


# ---------------------------------------------------------------------------
# Karaoke and stem export
# ---------------------------------------------------------------------------
@app.get("/api/covers/{cover_id}/stem-list")
def cover_stem_list(cover_id: str) -> dict:
    """Which of a cover's separated parts survive on disk."""
    return {"stems": engine.available_stems(Path(cover_id).name)}


@app.post("/api/karaoke")
def karaoke(payload: dict) -> dict:
    """Export a cover's backing track as its own item in the library."""
    cover_id = Path(str(payload.get("id", ""))).name
    if not cover_id:
        raise HTTPException(status_code=400, detail="Which cover?")

    job = Job()
    JOBS[job.id] = job
    _start(job, engine.export_karaoke, cover_id,
           str(payload.get("output_format", "mp3") or "mp3"))
    return {"job_id": job.id}


@app.post("/api/covers/stems/export")
def export_cover_stems(payload: dict) -> dict:
    """Write a cover's separated parts into a folder the user picked."""
    cover_id = Path(str(payload.get("id", ""))).name
    dest = str(payload.get("dest_dir", ""))
    if not cover_id:
        raise HTTPException(status_code=400, detail="Which cover?")
    if not dest:
        raise HTTPException(status_code=400, detail="Choose a folder first.")

    job = Job()
    JOBS[job.id] = job
    _start(job, engine.export_stems, cover_id, dest,
           payload.get("keys") or None,
           str(payload.get("output_format", "wav") or "wav"))
    return {"job_id": job.id}


# ---------------------------------------------------------------------------
# Project documents
# ---------------------------------------------------------------------------
@app.post("/api/projects/save")
def save_project(payload: dict) -> dict:
    """Write the current New cover state to a .vocalis file."""
    path = str(payload.get("path", ""))
    if not path:
        raise HTTPException(status_code=400, detail="Choose where to save it.")

    try:
        if payload.get("cover_id"):
            document = projects.from_cover(Path(str(payload["cover_id"])).name)
        else:
            document = projects.build(
                title=str(payload.get("title", "")),
                song_path=str(payload.get("song_path", "")),
                song_name=str(payload.get("song_name", "")),
                source_url=str(payload.get("source_url", "")),
                voice_id=str(payload.get("voice_id", "")),
                params=payload.get("params") or {},
                trim=payload.get("trim") or None,
                notes=str(payload.get("notes", "")),
            )
        return projects.save(path, document)
    except projects.ProjectError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.post("/api/projects/open")
def open_project(payload: dict) -> dict:
    """Read a .vocalis file back, reporting anything it refers to that is gone."""
    path = str(payload.get("path", ""))
    if not path:
        raise HTTPException(status_code=400, detail="Which project?")
    try:
        return projects.open_project(path)
    except projects.ProjectError as err:
        raise HTTPException(status_code=400, detail=str(err))


# ---------------------------------------------------------------------------
# Voice packs
# ---------------------------------------------------------------------------
@app.get("/api/packs")
def installed_packs() -> dict:
    return {"packs": packs.list_installed()}


@app.post("/api/packs/inspect")
def inspect_pack(payload: dict) -> dict:
    """Describe a pack file without installing anything from it."""
    try:
        return packs.inspect(str(payload.get("path", "")))
    except packs.PackError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.post("/api/packs/install")
def install_pack(payload: dict) -> dict:
    """Install a pack. A job — several voices can be hundreds of megabytes."""
    path = str(payload.get("path", ""))
    if not path:
        raise HTTPException(status_code=400, detail="Choose a pack file.")

    job = Job()
    JOBS[job.id] = job
    _start(job, packs.install, path, overwrite=bool(payload.get("overwrite")))
    return {"job_id": job.id}


@app.post("/api/packs/export")
def export_pack(payload: dict) -> dict:
    """Build a pack out of installed voices."""
    dest = str(payload.get("path", ""))
    if not dest:
        raise HTTPException(status_code=400, detail="Choose where to save it.")

    job = Job()
    JOBS[job.id] = job
    _start(job, packs.export, payload.get("names") or [], dest,
           name=str(payload.get("name", "")),
           author=str(payload.get("author", "")),
           description=str(payload.get("description", "")),
           licence=str(payload.get("licence", "unspecified")))
    return {"job_id": job.id}


@app.post("/api/packs/forget")
def forget_pack(payload: dict) -> dict:
    try:
        return packs.forget(str(payload.get("id", "")))
    except packs.PackError as err:
        raise HTTPException(status_code=404, detail=str(err))


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
