"""
Project documents — a cover you can reopen.

Until now a cover was a one-way trip: settings went in, an MP3 came out, and
the only record of how it was made lived in the library manifest. Reproducing a
cover on another machine, or six months later after the source file moved, meant
remembering numbers.

A `.vocalis` file is that record as a document. It is small, plain JSON, and
deliberately holds no audio: it points at the song and names the voice. Opening
one fills in the New cover view; anything it refers to that is no longer here is
reported rather than silently dropped, so the view can say "this project wants a
voice you don't have" instead of running with the wrong one.

The format is versioned from the first release, because the one certain thing
about a document format is that it changes.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

import engine

FORMAT = "vocalis.project"
FORMAT_VERSION = 1
EXTENSION = ".vocalis"

# Every parameter of a run, with the default applied when a document omits it.
# One table rather than a scatter of `.get(..., default)` calls: it is what makes
# an older document open cleanly against a newer app.
PARAM_DEFAULTS = {
    "pitchShift": 0,
    "voiceCharacter": 0.75,
    "indexStrength": 0.75,
    "vocalGain": 0.0,
    "outputFormat": "mp3",
    "speed": 1.0,
    "harmonyPreset": "none",
    "harmonyIntervals": [],
    "harmonyGainDb": engine.HARMONY_GAIN_DB,
    "doubleTrack": False,
}


class ProjectError(ValueError):
    """A document that cannot be read, with a sentence fit to show a user."""


def _coerce(params: dict) -> dict:
    """Apply defaults and clamp anything a hand-edited document got wrong."""
    out = dict(PARAM_DEFAULTS)
    for key, default in PARAM_DEFAULTS.items():
        if key not in params:
            continue
        value = params[key]
        try:
            if isinstance(default, bool):
                out[key] = bool(value)
            elif isinstance(default, int) and not isinstance(default, bool):
                out[key] = int(value)
            elif isinstance(default, float):
                out[key] = float(value)
            elif isinstance(default, list):
                out[key] = [int(v) for v in value][:engine.MAX_VOCAL_LAYERS]
            else:
                out[key] = str(value)
        except (TypeError, ValueError):
            out[key] = default

    out["pitchShift"] = max(-12, min(12, out["pitchShift"]))
    out["voiceCharacter"] = max(0.0, min(1.0, out["voiceCharacter"]))
    out["indexStrength"] = max(0.0, min(1.0, out["indexStrength"]))
    out["vocalGain"] = max(-6.0, min(6.0, out["vocalGain"]))
    out["harmonyGainDb"] = max(engine.HARMONY_MIN_GAIN_DB,
                               min(engine.HARMONY_MAX_GAIN_DB, out["harmonyGainDb"]))
    if out["outputFormat"] not in engine.OUTPUT_FORMATS:
        out["outputFormat"] = "mp3"
    if out["harmonyPreset"] not in engine.HARMONY_PRESETS:
        out["harmonyPreset"] = "none"
    return out


def build(*, title: str, song_path: str, song_name: str = "",
          source_url: str = "", voice_id: str = "",
          params: Optional[dict] = None, trim: Optional[dict] = None,
          notes: str = "") -> dict:
    """The document body for the current state of a New cover view."""
    song = Path(song_path) if song_path else None
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "savedAt": time.time(),
        "app": {"name": "Vocalis"},
        "title": (title or "").strip() or (song.stem if song else "Untitled"),
        "notes": notes or "",
        "song": {
            "path": str(song) if song else "",
            "name": song_name or (song.name if song else ""),
            # A link is worth keeping beside the path: a fetched song lives in a
            # cache that Settings can empty, and the link can refill it.
            "sourceUrl": source_url or "",
        },
        "voice": {"id": voice_id or ""},
        "trim": ({"start": float(trim["start"]), "end": float(trim["end"])}
                 if trim and trim.get("end") else None),
        "params": _coerce(params or {}),
    }


def save(path: str, document: dict) -> dict:
    """Write a project to disk, adding the extension if the user left it off."""
    target = Path(path).expanduser()
    if target.suffix.lower() != EXTENSION:
        target = target.with_suffix(EXTENSION)

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        tmp = target.with_suffix(target.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(document, f, indent=2)
        tmp.replace(target)
    except OSError as err:
        raise ProjectError(f"Couldn't save the project: {err.strerror or err}")

    return {"path": str(target), "title": document.get("title", "")}


def open_project(path: str) -> dict:
    """
    Read a project and report what of it is still available.

    Never raises for a missing song or an uninstalled voice — those are the
    normal condition of a document that travelled, and the view needs to show
    them rather than refuse to open.
    """
    source = Path(path).expanduser()
    try:
        raw = json.loads(source.read_text("utf-8"))
    except FileNotFoundError:
        raise ProjectError("That project file is gone.")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ProjectError("That file isn't a Vocalis project.")
    except OSError as err:
        raise ProjectError(f"Couldn't open the project: {err.strerror or err}")

    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise ProjectError("That file isn't a Vocalis project.")
    if int(raw.get("version") or 0) > FORMAT_VERSION:
        raise ProjectError(
            "That project was saved by a newer version of Vocalis. Update the "
            "app and try again.")

    song = raw.get("song") or {}
    voice = raw.get("voice") or {}
    song_path = str(song.get("path") or "")
    voice_id = str(voice.get("id") or "")

    song_here = bool(song_path) and Path(song_path).is_file()
    voice_here = bool(voice_id) and voice_id in engine.list_voice_models()

    missing = []
    if song_path and not song_here:
        missing.append("song")
    if voice_id and not voice_here:
        missing.append("voice")

    return {
        "path": str(source),
        "title": raw.get("title") or source.stem,
        "notes": raw.get("notes") or "",
        "savedAt": raw.get("savedAt"),
        "song": {
            "path": song_path,
            "name": song.get("name") or Path(song_path).name,
            "sourceUrl": song.get("sourceUrl") or "",
            "available": song_here,
        },
        "voice": {"id": voice_id, "available": voice_here},
        "trim": raw.get("trim") or None,
        "params": _coerce(raw.get("params") or {}),
        "missing": missing,
    }


def from_cover(cover_id: str) -> dict:
    """
    Rebuild a project document from a cover already in the library.

    "Save as project" on a finished cover has to work — the settings are all in
    the manifest, and asking the user to retype them into New cover first would
    be a strange thing to do.
    """
    import covers_manifest

    record = covers_manifest.get(cover_id)
    if not record:
        raise ProjectError("That cover is no longer in your library.")

    layers = record.get("layers") or []
    intervals = [int(layer.get("semitones") or 0) for layer in layers
                 if layer.get("semitones")]
    doubled = any(not layer.get("semitones") for layer in layers)
    harmony_gain = next((float(layer.get("gainDb")) for layer in layers
                         if layer.get("semitones")), engine.HARMONY_GAIN_DB)

    trim = None
    if record.get("trimEnd"):
        trim = {"start": float(record.get("trimStart") or 0.0),
                "end": float(record["trimEnd"])}

    return build(
        title=record.get("title") or "",
        song_path=record.get("sourcePath") or "",
        song_name=record.get("sourceFileName") or "",
        voice_id=record.get("voiceId") or "",
        trim=trim,
        params={
            "pitchShift": record.get("pitchShift") or 0,
            "voiceCharacter": record.get("voiceCharacter") or 0.75,
            "vocalGain": record.get("vocalGainDb") or 0.0,
            "outputFormat": record.get("outputFormat") or "mp3",
            "speed": record.get("speed") or 1.0,
            "harmonyIntervals": intervals,
            "harmonyGainDb": harmony_gain,
            "doubleTrack": doubled,
        },
    )
