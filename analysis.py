"""
Musical analysis of a song and of a voice model — what feeds "auto pitch".

The problem this solves: picking a pitch shift is currently a guess followed by
a re-run. The user has no way to know that a song sits at C♯3 and that the voice
they picked lives around A3, so they try +5, listen, try +7, listen again. Each
guess used to cost a full pipeline run.

Two measurements make the guess unnecessary:

  * where the song's lead vocal sits, in Hz
  * where the chosen voice naturally sits, in Hz

The shift is then the interval between them, rounded to a semitone. Everything
here is an estimate and says so — the UI offers the number, it does not impose
it.

The key is an extra rather than the point: it costs about a second once the
audio is already decoded, and it is what a musician reads first. It is a
template estimate, so it ships with its runner-up and is labelled as a guess.
Tempo is deliberately absent — beat tracking was confidently wrong on ordinary
pop material here, and a wrong BPM is worse than no BPM.
"""

from __future__ import annotations

import json
import logging
import math
import time
import traceback
from pathlib import Path
from typing import Optional

import engine

log = logging.getLogger("ai_cover_studio.analysis")

CACHE_PATH = engine.DATA_DIR / "analysis-cache.json"
VOICE_PROFILE_PATH = engine.DATA_DIR / "voice-profiles.json"

# Analysis reads the middle of a track rather than all of it: intros are
# unrepresentative and a full decode of a ten-minute upload buys nothing.
ANALYSIS_SECONDS = 180.0
ANALYSIS_SR = 22050

# The band a sung fundamental can plausibly occupy. Wider than any one singer,
# narrow enough to exclude a bass line at the bottom and hiss at the top.
F0_MIN_HZ = 65.0
F0_MAX_HZ = 1000.0
# Mix estimates are high-passed first, so their floor sits above most bass
# fundamentals; a stem measurement has no such problem and uses the full band.
MIX_F0_MIN_HZ = 130.0
MIX_F0_MAX_HZ = 900.0
MIX_HIGHPASS_HZ = 150.0

NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]

# Krumhansl-Schmuckler key profiles. Correlating a track's average chroma
# against all 24 rotations is the standard cheap key estimate — right most of
# the time, and wrong in a specific, predictable way (it confuses a key with its
# subdominant or relative), which is why the runner-up is returned too.
_MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Fallback centres for a voice whose range we have never measured, taken from
# the median singing fundamental of adult voices. Coarse on purpose: it is the
# difference between "+12, obviously" and "no idea", not a claim about a singer.
GENDER_CENTRE_HZ = {"male": 130.0, "female": 220.0}

# Below this, two voices are close enough that shifting would do more harm than
# good — a semitone of transposition costs more than it fixes.
DEADBAND_SEMITONES = 1


# ---------------------------------------------------------------------------
# Small on-disk caches
#
# Analysis is deterministic in the file it reads, so a result is worth keeping:
# the New cover view asks for one every time a song is chosen, including the
# same song twice in a row.
# ---------------------------------------------------------------------------
def _read_json(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_json(path: Path, data: dict) -> None:
    try:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        tmp.replace(path)
    except OSError:
        # A cache that cannot be written is a slower app, not a broken one.
        log.warning("Couldn't write %s", path.name)


def _signature(path: Path, trim_start=None, trim_end=None) -> str:
    """Identity of the audio actually analysed, including any trim."""
    try:
        st = path.stat()
        base = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        base = str(path)
    return (f"{base}|{round(float(trim_start or 0), 3)}"
            f"|{round(float(trim_end or 0), 3)}")


# ---------------------------------------------------------------------------
# Notes and intervals
# ---------------------------------------------------------------------------
def hz_to_note(hz: Optional[float]) -> str:
    """"A♯3" for 233 Hz. Empty string for anything unmeasurable."""
    if not hz or hz <= 0:
        return ""
    midi = 69 + 12 * math.log2(float(hz) / 440.0)
    rounded = int(round(midi))
    return f"{NOTE_NAMES[rounded % 12]}{rounded // 12 - 1}"


def semitones_between(from_hz: float, to_hz: float) -> float:
    """Signed interval in semitones. Positive means `to` is higher."""
    if not from_hz or not to_hz or from_hz <= 0 or to_hz <= 0:
        return 0.0
    return 12.0 * math.log2(float(to_hz) / float(from_hz))


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------
def _load_audio(path: Path, offset: float = 0.0, duration: Optional[float] = None):
    import librosa
    return librosa.load(str(path), sr=ANALYSIS_SR, mono=True,
                        offset=float(offset),
                        duration=duration if duration else None)


def _median_f0(samples, sr: int, *, highpass: bool) -> tuple[Optional[float], float]:
    """
    Median fundamental of the voiced frames, and the fraction of frames that
    were voiced at all.

    `highpass` is for a full mix, where the bass guitar would otherwise be
    measured instead of the singer. A separated vocal stem needs neither the
    filter nor the raised floor.
    """
    import numpy as np
    import librosa

    if highpass:
        from scipy.signal import butter, filtfilt
        b, a = butter(4, MIX_HIGHPASS_HZ / (sr / 2), btype="highpass")
        samples = filtfilt(b, a, samples).astype(np.float32)
        fmin, fmax = MIX_F0_MIN_HZ, MIX_F0_MAX_HZ
    else:
        fmin, fmax = F0_MIN_HZ, F0_MAX_HZ

    f0, voiced, _ = librosa.pyin(samples, fmin=fmin, fmax=fmax, sr=sr,
                                 frame_length=2048)
    mask = voiced & np.isfinite(f0)
    if not mask.any():
        return None, 0.0
    return float(np.median(f0[mask])), float(np.mean(voiced))


def _estimate_key(samples, sr: int) -> dict:
    """Best and runner-up key, by correlation against the K-S profiles."""
    import numpy as np
    import librosa

    chroma = librosa.feature.chroma_cqt(y=samples, sr=sr)
    # Normalising each frame before averaging stops the loudest bars of the
    # track from deciding the key on their own.
    chroma = chroma / (np.linalg.norm(chroma, ord=1, axis=0, keepdims=True) + 1e-9)
    profile = chroma.mean(axis=1)
    profile = profile / (profile.sum() or 1)

    scored = []
    for tonic in range(12):
        for mode, weights in (("major", _MAJOR_PROFILE), ("minor", _MINOR_PROFILE)):
            template = np.roll(np.array(weights) / sum(weights), tonic)
            r = float(np.corrcoef(profile, template)[0, 1])
            if math.isfinite(r):
                scored.append((r, NOTE_NAMES[tonic], mode))
    if not scored:
        return {"key": "", "alternateKey": "", "keyConfidence": 0.0}

    scored.sort(reverse=True, key=lambda s: s[0])
    best = scored[0]
    # The runner-up is only worth showing if it names a different tonic. The
    # parallel major of the winner scores well on almost every track and tells
    # nobody anything; the relative or subdominant key is the one this method
    # actually confuses, and the one a musician wants offered.
    alternate = next((s for s in scored[1:] if s[1] != best[1]), None)
    return {
        "key": f"{best[1]} {best[2]}",
        "alternateKey": f"{alternate[1]} {alternate[2]}" if alternate else "",
        "keyConfidence": round(max(0.0, best[0]), 3),
    }


# ---------------------------------------------------------------------------
# Song analysis
# ---------------------------------------------------------------------------
def analyse_song(song_path: str, trim_start=None, trim_end=None,
                 use_cache: bool = True) -> dict:
    """
    Key, tempo and lead-vocal pitch for one song.

    The vocal measurement prefers separated stems from an earlier run of the
    same audio — they are exact, and by the second run of a song they are always
    there. With no stems it falls back to a high-passed estimate off the mix,
    and labels itself accordingly so the UI can hedge.
    """
    path = Path(song_path)
    if not path.is_file():
        raise ValueError("That song file no longer exists.")

    signature = _signature(path, trim_start, trim_end)
    cache = _read_json(CACHE_PATH)
    if use_cache:
        hit = cache.get(signature)
        if hit:
            return hit

    start = float(trim_start or 0.0)
    span = None
    if trim_end:
        span = max(1.0, float(trim_end) - start)

    # The middle of a track is more representative than its opening, but only
    # when there is enough of it to skip into.
    samples, sr = _load_audio(path, offset=start,
                              duration=min(span, ANALYSIS_SECONDS) if span
                              else ANALYSIS_SECONDS)

    result = {"signature": signature, "analysedAt": time.time()}
    result.update(_estimate_key(samples, sr))

    stems = None
    try:
        import covers_manifest
        stems = covers_manifest.find_stems(
            engine._stem_signature(str(path), trim_start, trim_end))
    except Exception:
        log.warning("Couldn't look for stems to analyse:\n%s", traceback.format_exc())

    if stems:
        vocal_samples, vocal_sr = _load_audio(Path(stems[0]), duration=ANALYSIS_SECONDS)
        median, voiced = _median_f0(vocal_samples, vocal_sr, highpass=False)
        result["f0Source"] = "stems"
    else:
        median, voiced = _median_f0(samples, sr, highpass=True)
        result["f0Source"] = "mix"

    result["medianF0"] = round(median, 2) if median else None
    result["note"] = hz_to_note(median)
    result["voicedFraction"] = round(voiced, 3)

    cache[signature] = result
    _write_json(CACHE_PATH, cache)
    return result


# ---------------------------------------------------------------------------
# Voice analysis
# ---------------------------------------------------------------------------
def _dataset_audio(model_name: str) -> list[Path]:
    """Training clips for a locally trained voice, if they are still around."""
    safe = engine.safe_model_name(model_name)
    for candidate in (engine.DATASETS_DIR / safe, engine.DATASETS_DIR / model_name):
        if candidate.is_dir():
            clips = sorted(p for p in candidate.rglob("*")
                           if p.suffix.lower() in engine.AUDIO_EXTS)
            if clips:
                return clips
    return []


def voice_profile(model_name: str, use_cache: bool = True) -> dict:
    """
    Where a voice naturally sits.

    Measured from the training set when the voice was trained here, which is the
    only honest measurement available: a downloaded `.pth` carries no audio, and
    its preview is a recording of some other song's pitch, not the model's.
    Falling back to the catalog's gender tag is coarse but still worth far more
    than nothing — it is the difference between suggesting +12 and suggesting
    nothing at all.
    """
    name = str(model_name or "")
    if not name:
        return {"medianF0": None, "note": "", "source": "unknown"}

    profiles = _read_json(VOICE_PROFILE_PATH)
    clips = _dataset_audio(name)

    if clips:
        stamp = str(int(sum(c.stat().st_mtime for c in clips[:8])))
        hit = profiles.get(name)
        if use_cache and hit and hit.get("_stamp") == stamp:
            return hit

        import numpy as np
        medians = []
        budget = 45.0
        for clip in clips[:8]:
            if budget <= 0:
                break
            try:
                samples, sr = _load_audio(clip, duration=min(15.0, budget))
            except Exception:
                continue
            budget -= len(samples) / sr
            median, _ = _median_f0(samples, sr, highpass=False)
            if median:
                medians.append(median)

        if medians:
            value = float(np.median(medians))
            profile = {
                "medianF0": round(value, 2),
                "note": hz_to_note(value),
                "source": "training-set",
                "clipsMeasured": len(medians),
                "_stamp": stamp,
            }
            profiles[name] = profile
            _write_json(VOICE_PROFILE_PATH, profiles)
            return profile

    # Nothing to measure. A voice pack may still declare its own range, and a
    # catalog download at least knows whether it is a male or female voice.
    # A range the user stated, or one a pack declared, beats a gender tag. Both
    # rank below a measurement off the training set, which is why this is
    # reached only when there was nothing to measure.
    declared = profiles.get(name) or {}
    if declared.get("source") in {"pack", "manual"} and declared.get("medianF0"):
        return declared

    gender = ""
    try:
        import voices_manifest
        gender = (voices_manifest.load_origins().get(name) or {}).get("gender", "")
    except Exception:
        pass

    centre = GENDER_CENTRE_HZ.get(str(gender).lower())
    if centre:
        return {"medianF0": centre, "note": hz_to_note(centre),
                "source": "gender", "gender": gender}

    return {"medianF0": None, "note": "", "source": "unknown"}


def record_pack_profile(model_name: str, median_f0: float) -> None:
    """A voice pack can declare the range its author measured. Trust it."""
    _record_profile(model_name, median_f0, "pack")


# Rough centres a person can pick from without owning a tuner. Wide categories
# on purpose: the suggestion is rounded to a semitone and deadbanded, so the
# difference between "tenor" and "baritone" rarely changes the answer.
MANUAL_RANGES = {
    "bass": 110.0,        # A2
    "baritone": 130.8,    # C3
    "tenor": 164.8,       # E3
    "alto": 196.0,        # G3
    "mezzo": 220.0,       # A3
    "soprano": 261.6,     # C4
}


def set_manual_profile(model_name: str, *, range_key: str = "",
                       median_f0: Optional[float] = None) -> dict:
    """
    Record where a voice sits because the user said so.

    Most installed voices cannot be measured: a downloaded `.pth` carries no
    audio, and a catalog listing may not even say male or female. Without this
    the pitch suggestion answers "I don't know" for most libraries, which is
    honest but useless. One dropdown, once per voice, fixes that — and a stated
    range outranks a guess from a gender tag.
    """
    hz = float(median_f0) if median_f0 else MANUAL_RANGES.get(str(range_key).lower(), 0.0)
    if not hz or not (F0_MIN_HZ <= hz <= F0_MAX_HZ):
        raise ValueError("Pick a range for this voice.")
    return _record_profile(model_name, hz, "manual")


def _record_profile(model_name: str, median_f0: float, source: str) -> dict:
    if not model_name or not median_f0:
        return {}
    profiles = _read_json(VOICE_PROFILE_PATH)
    profile = {
        "medianF0": round(float(median_f0), 2),
        "note": hz_to_note(median_f0),
        "source": source,
    }
    profiles[model_name] = profile
    _write_json(VOICE_PROFILE_PATH, profiles)
    return profile


def forget_voice_profile(model_name: str) -> None:
    """Drop a measurement when its voice is deleted or renamed."""
    profiles = _read_json(VOICE_PROFILE_PATH)
    if profiles.pop(str(model_name), None) is not None:
        _write_json(VOICE_PROFILE_PATH, profiles)


# ---------------------------------------------------------------------------
# The suggestion itself
# ---------------------------------------------------------------------------
def suggest_pitch_shift(song_path: str, model_name: str,
                        trim_start=None, trim_end=None) -> dict:
    """
    Everything the New cover view needs to offer a pitch shift and explain it.

    Always returns a full record, including when it has nothing to suggest —
    `semitones` is then 0 and `reason` says why, which is more use than an
    error.
    """
    song = analyse_song(song_path, trim_start, trim_end)
    voice = voice_profile(model_name) if model_name else {"medianF0": None,
                                                          "source": "unknown"}

    source_hz = song.get("medianF0")
    target_hz = voice.get("medianF0")

    if not source_hz:
        return {
            "semitones": 0, "confidence": "none", "song": song, "voice": voice,
            "reason": "No clear lead vocal to measure in this song.",
        }
    if not target_hz:
        return {
            "semitones": 0, "confidence": "none", "song": song, "voice": voice,
            # Running a cover with it would not help: RVC follows the source
            # vocal's pitch, so its output says where the song sat, not where
            # the voice naturally sits. Only the training audio, a pack's own
            # measurement, or a catalog gender tag can answer that.
            "reason": ("Vocalis doesn't know this voice's natural range. Set it "
                       "from the voice's ⋯ menu, and the suggestion works from "
                       "then on."),
        }

    raw = semitones_between(source_hz, target_hz)
    shift = int(max(-12, min(12, round(raw))))
    if abs(shift) <= DEADBAND_SEMITONES:
        shift = 0

    # A measured stem against a measured training set is a real comparison. A
    # gender tag against a mix estimate is two guesses stacked, and the wording
    # in the UI depends on knowing which of those this is.
    if song.get("f0Source") == "stems" and voice.get("source") == "training-set":
        confidence = "high"
    elif voice.get("source") == "unknown":
        confidence = "low"
    elif song.get("f0Source") == "mix" and voice.get("source") == "gender":
        confidence = "low"
    else:
        confidence = "medium"

    where = {"stems": "its separated vocal",
             "mix": "the mix"}.get(song.get("f0Source"), "the song")
    how = {"training-set": "measured from its training set",
           "gender": "estimated from its catalog listing",
           "manual": "the range you set for it",
           "pack": "declared by its pack"}.get(voice.get("source"), "estimated")

    if shift == 0:
        reason = (f"The song sits near {song.get('note')} in {where}, and this "
                  f"voice sits near {voice.get('note')} ({how}). They already "
                  "line up, so no shift.")
    else:
        direction = "up" if shift > 0 else "down"
        reason = (f"The song sits near {song.get('note')} in {where}; this voice "
                  f"sits near {voice.get('note')} ({how}). Moving {direction} "
                  f"{abs(shift)} semitone{'s' if abs(shift) != 1 else ''} lands "
                  "it in that range.")

    return {
        "semitones": shift,
        "rawSemitones": round(raw, 2),
        "confidence": confidence,
        "reason": reason,
        "song": song,
        "voice": voice,
    }
