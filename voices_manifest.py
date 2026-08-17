"""
Voice metadata — what a model actually is, beyond its filename.

The old `/api/models/meta` reported size, mtime and `has_index`, which is why
the UI could only say "no index" / "has index" and nothing about the voice
itself. RVC `.pth` files carry a useful header (sample rate, architecture
version, and for Applio-trained models the epoch count and creation date), so
this module reads it once and caches the result.

Reading the header means `torch.load` on a ~55 MB file, so results are cached in
a JSON sidecar keyed by (size, mtime) and only re-read when the file changes.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import engine

CACHE_PATH = engine.DATA_DIR / "voices-cache.json"
ORIGINS_PATH = engine.DATA_DIR / "voice-origins.json"
PREVIEW_SUFFIX = ".preview.mp3"


# ---------------------------------------------------------------------------
# Provenance
#
# A `.pth` on disk says nothing about where it came from, so a voice downloaded
# from the catalog used to arrive in the library stripped of everything the
# catalog knew about it — including its face. This records that at install time.
#
# Guessing instead was the tempting shortcut and the wrong one: it would mean
# looking up "zub" on Wikipedia, and a voice the user trained from their own
# singing is nobody's business but theirs.
# ---------------------------------------------------------------------------
def load_origins() -> dict:
    try:
        return json.loads(ORIGINS_PATH.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_origins(data: dict) -> None:
    ORIGINS_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".origins_", suffix=".json",
                               dir=str(ORIGINS_PATH.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, ORIGINS_PATH)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def record_origin(name: str, **fields) -> None:
    """Remember where an installed voice came from."""
    data = load_origins()
    data[name] = {k: v for k, v in fields.items() if v not in (None, "")}
    try:
        _save_origins(data)
    except OSError:
        pass


def rename_origin(old: str, new: str) -> None:
    data = load_origins()
    if old in data:
        data[new] = data.pop(old)
        try:
            _save_origins(data)
        except OSError:
            pass


def forget_origin(name: str) -> None:
    data = load_origins()
    if data.pop(name, None) is not None:
        try:
            _save_origins(data)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Header cache
# ---------------------------------------------------------------------------
def _load_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".voices_", suffix=".json",
                               dir=str(CACHE_PATH.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2)
        os.replace(tmp, CACHE_PATH)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _normalise_sr(raw: Any) -> Optional[int]:
    """RVC writes either 40000 or the string "40k" depending on the trainer."""
    if isinstance(raw, (int, float)):
        return int(raw)
    if isinstance(raw, str):
        text = raw.strip().lower()
        if text.endswith("k"):
            try:
                return int(float(text[:-1]) * 1000)
            except ValueError:
                return None
        try:
            return int(text)
        except ValueError:
            return None
    return None


def probe(pth: Path) -> dict:
    """
    Read the model header. Never raises — an unreadable model still lists, it
    just has less to say about itself.
    """
    try:
        st = pth.stat()
    except OSError:
        return {}

    key = pth.name
    stamp = f"{st.st_size}:{int(st.st_mtime)}"
    cache = _load_cache()
    hit = cache.get(key)
    if hit and hit.get("_stamp") == stamp:
        return hit

    info: dict = {"_stamp": stamp}
    try:
        import torch
        engine._allow_legacy_torch_load()
        data = torch.load(str(pth), map_location="cpu", weights_only=False)
        if isinstance(data, dict):
            info["sampleRate"] = _normalise_sr(data.get("sr"))
            info["architecture"] = data.get("version") or None
            epochs = data.get("epoch")
            info["epochs"] = int(epochs) if isinstance(epochs, (int, float)) else None
            info["author"] = data.get("author") or None
            created = data.get("creation_date")
            info["createdAt"] = created if isinstance(created, str) else None
            length = data.get("dataset_length")
            info["datasetLength"] = length if isinstance(length, (int, float)) else None
    except Exception:
        # A model we cannot parse is still a usable model.
        pass

    cache[key] = info
    try:
        _save_cache(cache)
    except OSError:
        pass
    return info


# ---------------------------------------------------------------------------
# Previews
# ---------------------------------------------------------------------------
def preview_path(name: str) -> Path:
    return engine.MODELS_DIR / f"{name}{PREVIEW_SUFFIX}"


def has_preview(name: str) -> bool:
    return preview_path(name).exists()


def generate_preview(model_name: str, source_audio: str,
                     pitch_shift: int = 0, index_rate: float = 0.75,
                     seconds: float = 8.0,
                     progress_cb=None, log_cb=None) -> Path:
    """
    Render a short sample of a voice by running a reference vocal through the
    RVC step alone — no source separation, no mixing.

    The clip is trimmed BEFORE conversion, so a preview costs a few seconds
    rather than the minutes a full track would.
    """
    from pydub import AudioSegment

    src = Path(source_audio)
    if not src.exists():
        raise FileNotFoundError("That reference clip no longer exists.")

    progress = progress_cb or (lambda *a, **k: None)
    work_dir = Path(tempfile.mkdtemp(prefix="preview_", dir=engine.OUTPUT_DIR))
    try:
        progress(0.15, "Trimming the reference clip", "")
        clip = AudioSegment.from_file(src)[: int(seconds * 1000)]
        trimmed = work_dir / "reference.wav"
        clip.export(trimmed, format="wav")

        progress(0.35, "Converting with your voice", "")
        converted = engine.convert_vocals(
            trimmed, model_name, int(pitch_shift), float(index_rate), work_dir
        )

        progress(0.9, "Saving the preview", "")
        out = preview_path(model_name)
        AudioSegment.from_file(converted).export(out, format="mp3", bitrate="192k")
        progress(1.0, "Preview ready", "")
        return out
    finally:
        import shutil
        shutil.rmtree(work_dir, ignore_errors=True)


def delete_preview(name: str) -> None:
    preview_path(name).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------
def _index_files_for(stem: str) -> list[Path]:
    return [p for p in engine.MODELS_DIR.glob("*.index") if p.stem.startswith(stem)]


def usage_counts() -> dict[str, int]:
    """How many covers reference each voice — needed before a destructive delete."""
    try:
        import covers_manifest
        counts: dict[str, int] = {}
        for rec in covers_manifest.load().values():
            voice = rec.get("voiceId") or rec.get("voiceName")
            if voice:
                counts[voice] = counts.get(voice, 0) + 1
        return counts
    except Exception:
        return {}


def list_voices() -> list[dict]:
    """Full records for every installed model."""
    counts = usage_counts()
    origins = load_origins()
    out = []

    for name in engine.list_voice_models():
        pth = engine.MODELS_DIR / f"{name}.pth"
        try:
            st = pth.stat()
        except OSError:
            continue

        idx = _index_files_for(name)
        idx_size = sum(p.stat().st_size for p in idx if p.exists())
        info = probe(pth)

        origin = origins.get(name) or {}

        out.append({
            "name": name,
            "size": st.st_size + idx_size,
            "modified": st.st_mtime,
            "has_index": bool(idx),
            "sampleRate": info.get("sampleRate"),
            "architecture": info.get("architecture"),
            "epochs": info.get("epochs"),
            "author": info.get("author"),
            "trainedAt": info.get("createdAt"),
            "hasPreview": has_preview(name),
            "pthPath": str(pth),
            "usedByCovers": counts.get(name, 0),
            # Where it came from, when it came from the catalog. A voice trained
            # here has none of this, which is exactly the point.
            "sourceUrl": origin.get("sourceUrl", ""),
            "repoId": origin.get("repoId", ""),
            "category": origin.get("category", ""),
            "gender": origin.get("gender", ""),
            "hasPortrait": bool(origin.get("portraitName")),
            "portraitName": origin.get("portraitName", ""),
        })

    return out
