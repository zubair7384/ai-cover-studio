"""
Cover manifest — the durable record of what each generated cover actually is.

Before this, `/api/outputs` globbed the filesystem and returned
`{name, size, modified}`. Nothing recorded which voice sang a cover or which
song it came from, so a library could only ever show filenames. A partial
`coverMeta` lived in the renderer's localStorage, which was lossy, invisible to
the backend, and (after the renderer moved from file:// to app://) unreadable by
the app itself.

This module owns a single JSON manifest beside the outputs directory:

    <DATA_DIR>/covers.json    {"version": 1, "records": {<id>: {...}}}

Writes are atomic (temp file + os.replace) so a crash mid-write cannot leave a
truncated manifest behind.

Record shape
------------
    id              str    output filename, the stable key
    title           str    human title; never a raw generated filename
    sourceFileName  str|None   original song filename, e.g. "tu-hai-tu.mp3"
    sourcePath      str|None
    outputPath      str
    voiceId         str|None   model name as stored on disk
    voiceName       str|None   display name; None means genuinely unknown
    createdAt       float  unix seconds
    durationSec     float|None
    sizeBytes       int
    pitchShift      int|None
    voiceCharacter  float|None  (was "index_rate")
    sampleRate      int|None
    outputFormat    str    "mp3"
    origin          str    "generated" | "localstorage" | "backfilled"
    missing         bool   file absent from disk (never dropped — §Prompt 7
                           offers "Locate…" / "Remove from library")
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import engine

MANIFEST_VERSION = 1
MANIFEST_PATH = engine.DATA_DIR / "covers.json"

# final_cover_20260717_024930.mp3
_TIMESTAMP_RE = re.compile(r"(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})")

# Every filename either pipeline produces, in every format it can export as
# (engine.OUTPUT_FORMATS). Both prefixes have to be here: anything this scan
# misses gets flagged `missing` by reconcile() even though the file is right
# there, which shows up in the UI as "Locate…" on a perfectly good clip.
_OUTPUT_PREFIXES = ("final_cover", "speech")
_OUTPUT_EXTS = ("mp3", "wav", "flac")
COVER_GLOBS = tuple(f"{prefix}_*.{ext}"
                    for prefix in _OUTPUT_PREFIXES
                    for ext in _OUTPUT_EXTS)


def _cover_files():
    """Every generated clip on disk, whatever format it was exported as."""
    seen = {}
    for pattern in COVER_GLOBS:
        for p in engine.OUTPUT_DIR.glob(pattern):
            seen[p.name] = p
    return seen


# What produced the audio. Both kinds live in one manifest because they share
# every downstream mechanism (player, export, rename, delete, Show in Finder);
# the views filter on this field so spoken clips never clutter the covers list.
KIND_COVER = "cover"
KIND_SPEECH = "speech"

ORIGIN_GENERATED = "generated"
ORIGIN_LOCALSTORAGE = "localstorage"
ORIGIN_BACKFILLED = "backfilled"


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------
def load() -> dict[str, dict]:
    """Read the manifest. A missing or corrupt file yields an empty manifest
    rather than raising — a broken cache must not take the library down."""
    try:
        raw = json.loads(MANIFEST_PATH.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    records = raw.get("records")
    return records if isinstance(records, dict) else {}


def save(records: dict[str, dict]) -> None:
    """Atomic write: a crash mid-write leaves the previous manifest intact."""
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": MANIFEST_VERSION, "records": records}
    fd, tmp = tempfile.mkstemp(prefix=".covers_", suffix=".json",
                               dir=str(MANIFEST_PATH.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, MANIFEST_PATH)   # atomic on POSIX and Windows
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def timestamp_from_name(name: str) -> Optional[float]:
    """Parse final_cover_YYYYMMDD_HHMMSS.mp3 -> unix seconds."""
    m = _TIMESTAMP_RE.search(name)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(g) for g in m.groups())
    try:
        return time.mktime((y, mo, d, h, mi, s, 0, 0, -1))
    except (ValueError, OverflowError):
        return None


def clean_title(filename: str) -> str:
    """"tu-hai-tu_test.mp3" -> "Tu Hai Tu Test"."""
    base = Path(filename).stem
    base = re.sub(r"[_-]+", " ", base)
    base = re.sub(r"\s+", " ", base).strip()
    return base.title() if base else ""


def _fallback_title(created_at: float) -> str:
    """Several covers routinely share a date, so the fallback carries the time."""
    return "Cover — " + time.strftime("%-d %b, %H:%M", time.localtime(created_at))


def title_for(source_file_name: Optional[str], created_at: float) -> str:
    """Never surface a raw generated filename as a title (§10)."""
    if source_file_name:
        cleaned = clean_title(source_file_name)
        if cleaned:
            return cleaned
    return _fallback_title(created_at)


def probe_duration(path: Path) -> Optional[float]:
    """Container-level duration read. Never fatal — duration is nice to have."""
    try:
        import av  # PyAV reads the header without decoding the stream
        with av.open(str(path)) as container:
            if container.duration:
                return round(container.duration / 1_000_000, 3)
    except Exception:
        pass
    try:
        import soundfile as sf
        info = sf.info(str(path))
        return round(info.frames / float(info.samplerate), 3)
    except Exception:
        return None


def _stat(path: Path) -> tuple[int, float]:
    try:
        st = path.stat()
        return st.st_size, st.st_mtime
    except OSError:
        return 0, time.time()


def blank_record(name: str, *, origin: str) -> dict:
    """A record for a file we know nothing about beyond what the disk says."""
    path = engine.OUTPUT_DIR / name
    size, mtime = _stat(path)
    created = timestamp_from_name(name) or mtime
    is_speech = name.startswith("speech_")
    return {
        "id": name,
        "title": ("Spoken clip — " + time.strftime("%-d %b, %H:%M", time.localtime(created)))
                 if is_speech else title_for(None, created),
        "sourceFileName": None,
        "sourcePath": None,
        "outputPath": str(path),
        "voiceId": None,
        "voiceName": None,          # never invented
        "createdAt": created,
        "durationSec": probe_duration(path) if path.exists() else None,
        "sizeBytes": size,
        "pitchShift": None,
        "voiceCharacter": None,
        "sampleRate": None,
        "outputFormat": path.suffix.lstrip(".").lower() or "mp3",
        "origin": origin,
        "missing": not path.exists(),
        # Recovered from disk, so the filename prefix is the only evidence of
        # which pipeline made it.
        "kind": KIND_SPEECH if is_speech else KIND_COVER,
        "text": None,
        "speechVoice": None,
        "speechRate": None,
        "timings": None,
    }


# ---------------------------------------------------------------------------
# Generation-time write
# ---------------------------------------------------------------------------
def record_generation(
    output_path: Path,
    *,
    voice_id: str,
    source_path: Optional[str] = None,
    source_file_name: Optional[str] = None,
    pitch_shift: Optional[int] = None,
    voice_character: Optional[float] = None,
    sample_rate: Optional[int] = None,
    stems: Optional[dict] = None,
    stem_signature: Optional[str] = None,
    trim_start: Optional[float] = None,
    trim_end: Optional[float] = None,
    vocal_gain_db: Optional[float] = None,
    speed: Optional[float] = None,
    kind: str = KIND_COVER,
    title: Optional[str] = None,
    text: Optional[str] = None,
    speech_voice: Optional[str] = None,
    speech_rate: Optional[int] = None,
    timings: Optional[list] = None,
) -> dict:
    """
    Called by the engine the moment a cover lands, with the parameters actually
    used — not the defaults. This is the only path that produces a complete
    record; everything else is recovery.
    """
    output_path = Path(output_path)
    size, mtime = _stat(output_path)
    created = timestamp_from_name(output_path.name) or mtime

    record = {
        "id": output_path.name,
        "title": (title or "").strip() or title_for(source_file_name, created),
        "sourceFileName": source_file_name,
        "sourcePath": source_path,
        "outputPath": str(output_path),
        "voiceId": voice_id,
        "voiceName": voice_id,
        "createdAt": created,
        "durationSec": probe_duration(output_path),
        "sizeBytes": size,
        "pitchShift": pitch_shift,
        "voiceCharacter": voice_character,
        "sampleRate": sample_rate,
        "outputFormat": output_path.suffix.lstrip(".").lower() or "mp3",
        "origin": ORIGIN_GENERATED,
        "missing": False,
        # The intermediate audio this cover was mixed from. Keeping it lets the
        # balance, speed and format be changed later without re-running the
        # model, and lets a re-run at a different pitch skip separation.
        "stems": stems or None,
        "stemSignature": stem_signature,
        "trimStart": trim_start,
        "trimEnd": trim_end,
        "vocalGainDb": vocal_gain_db,
        "speed": speed,
        # Speech-only. The script is kept so "say it again with these settings"
        # can pre-fill, which is the same payoff storing cover parameters gives.
        "kind": kind,
        "text": text,
        "speechVoice": speech_voice,
        "speechRate": speech_rate,
        # Per-word spans into `text`, for the reading view's live highlight.
        "timings": timings or None,
    }

    records = load()
    records[record["id"]] = record
    save(records)
    return record


def get(cover_id: str) -> Optional[dict]:
    """One record by id, or None."""
    return load().get(str(cover_id))


def find_stems(signature: str) -> Optional[tuple]:
    """
    The separated stems of any earlier cover made from the same audio, newest
    first, provided the files are still on disk.

    Returns (vocals, instrumental) as Paths — the separator's output, not the
    converted vocals, since that is what a fresh run needs as input.
    """
    if not signature:
        return None
    candidates = [r for r in load().values() if r.get("stemSignature") == signature]
    candidates.sort(key=lambda r: r.get("createdAt") or 0, reverse=True)
    for record in candidates:
        stems = record.get("stems") or {}
        vocals = Path(stems.get("vocals") or "")
        instrumental = Path(stems.get("instrumental") or "")
        if vocals.is_file() and instrumental.is_file():
            return vocals, instrumental
    return None


# ---------------------------------------------------------------------------
# One-time migration
# ---------------------------------------------------------------------------
def migrate(legacy_cover_meta: Optional[dict] = None) -> dict:
    """
    Build the manifest for a library that predates it.

    Two sources, in order of quality:
      1. `legacy_cover_meta` — the renderer's old localStorage `coverMeta`,
         handed over by the desktop app. Real voice and song names.
      2. Filename backfill — createdAt from final_cover_YYYYMMDD_HHMMSS, size
         and duration from the file. voiceName stays None; it is never invented.

    Idempotent: existing records are left alone, so re-running cannot downgrade
    a good record to a backfilled one.

    @returns counts: {"recovered", "backfilled", "existing", "total"}
    """
    legacy_cover_meta = legacy_cover_meta or {}
    records = load()

    recovered = backfilled = existing = 0

    for path in sorted(engine.OUTPUT_DIR.glob("final_cover_*.mp3")):
        name = path.name
        if name in records:
            existing += 1
            continue

        legacy = legacy_cover_meta.get(name) or {}
        if legacy:
            size, mtime = _stat(path)
            created = (
                float(legacy["date"]) / 1000.0 if legacy.get("date")
                else (timestamp_from_name(name) or mtime)
            )
            source_name = legacy.get("song") or None
            records[name] = {
                "id": name,
                "title": title_for(source_name, created),
                "sourceFileName": source_name,
                "sourcePath": None,
                "outputPath": str(path),
                "voiceId": legacy.get("voice") or None,
                "voiceName": legacy.get("voice") or None,
                "createdAt": created,
                "durationSec": legacy.get("duration") or probe_duration(path),
                "sizeBytes": size,
                "pitchShift": legacy.get("pitch"),
                "voiceCharacter": legacy.get("index"),
                "sampleRate": None,
                "outputFormat": "mp3",
                "origin": ORIGIN_LOCALSTORAGE,
                "missing": False,
            }
            recovered += 1
        else:
            records[name] = blank_record(name, origin=ORIGIN_BACKFILLED)
            backfilled += 1

    save(records)
    return {
        "recovered": recovered,
        "backfilled": backfilled,
        "existing": existing,
        "total": len(records),
    }


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------
def reconcile() -> list[dict]:
    """
    Bring the manifest in line with the disk on every scan:

      - a file with no record gets a stub record
      - a record whose file has gone gets `missing: True` rather than being
        dropped, so the UI can offer "Locate…" / "Remove from library"
      - size and duration are refreshed for files that changed

    @returns records sorted newest first
    """
    records = load()
    dirty = False

    on_disk = _cover_files()

    for name, path in on_disk.items():
        rec = records.get(name)
        if rec is None:
            records[name] = blank_record(name, origin=ORIGIN_BACKFILLED)
            dirty = True
            continue

        size, _ = _stat(path)
        if rec.get("missing"):
            rec["missing"] = False
            dirty = True
        if rec.get("sizeBytes") != size:
            rec["sizeBytes"] = size
            rec["durationSec"] = probe_duration(path)
            dirty = True
        if not rec.get("outputPath"):
            rec["outputPath"] = str(path)
            dirty = True

    for name, rec in records.items():
        if name not in on_disk and not rec.get("missing"):
            rec["missing"] = True
            dirty = True

    if dirty:
        save(records)

    return sorted(records.values(), key=lambda r: r.get("createdAt") or 0, reverse=True)


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------
def update_title(cover_id: str, title: str) -> dict:
    records = load()
    rec = records.get(cover_id)
    if rec is None:
        raise KeyError(cover_id)
    clean = (title or "").strip()
    if not clean:
        raise ValueError("A title cannot be empty.")
    rec["title"] = clean
    save(records)
    return rec


def relocate(cover_id: str, new_path: str) -> dict:
    """
    Point a record at a file that was moved outside the app ("Locate…").
    Refuses a path that is not a readable file, so a mistake cannot orphan the
    record further.
    """
    records = load()
    rec = records.get(cover_id)
    if rec is None:
        raise KeyError(cover_id)

    path = Path(new_path)
    if not path.is_file():
        raise ValueError("That is not a file Vocalis can read.")

    size, mtime = _stat(path)
    rec["outputPath"] = str(path)
    rec["sizeBytes"] = size
    rec["durationSec"] = probe_duration(path)
    rec["outputFormat"] = path.suffix.lstrip(".").lower() or rec.get("outputFormat") or "mp3"
    rec["missing"] = False
    save(records)
    return rec


def delete(cover_id: str, *, trash_file: bool = True) -> dict:
    """
    Remove a cover from the library, optionally sending the file to Trash.

    `trash_file=False` keeps the file on disk and only forgets the record —
    which is what "Remove from library" means for a file that has gone missing.
    """
    records = load()
    rec = records.get(cover_id)
    path = Path(rec["outputPath"]) if rec and rec.get("outputPath") \
        else engine.OUTPUT_DIR / Path(cover_id).name

    trashed = False
    if trash_file and path.exists():
        try:
            from send2trash import send2trash  # optional dependency
            send2trash(str(path))
            trashed = True
        except Exception:
            path.unlink(missing_ok=True)
            trashed = True

    if rec is not None:
        records.pop(cover_id, None)
        save(records)

    return {"deleted": cover_id, "fileRemoved": trashed}
