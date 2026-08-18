"""
Setup test — the three ways a training run used to go wrong before it began.

Run it directly:

    .venv/bin/python tests/test_train_setup.py

None of this starts Applio. Each check covers a failure that was silent in a
different way:

  1. Applio's CLI wrappers announce a dead step and then exit 0, so a failed
     step looked like a finished one and the pipeline carried on. Training was
     the expensive place to find out: the run failed at the very end with
     "Training finished but no weight file found", which names the symptom and
     hides the cause.
  2. Applio writes logs/<name>/config.json only when it is absent, so a second
     attempt at the same name kept the first attempt's sample rate while the new
     preprocessing wrote audio at the rate actually asked for. The trainer
     refuses that mismatch.
  3. Staging was additive, so every attempt at the same name left its
     conversions behind under a fresh "-2", "-3" name. Three recordings became
     eleven files and the trainer worked through all of them, which is four
     times the epoch time on repeated audio.

Everything happens under throwaway names; the real datasets and model logs are
left alone.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import engine     # noqa: E402

PROBE_RUN = "_test_setup_probe"          # under Applio/logs/
PROBE_VOICE = "_test_setup_voice"        # under training_datasets/

FAILURE_CHILD = (
    "print('Error: Pretrained model sample rate (40000 Hz) does not match "
    "dataset audio sample rate (32000 Hz).')\n"
    "print('Training failed for model Rameez. Please check the console logs "
    "for more details.')\n"
)


def check_silent_failure_is_a_failure() -> None:
    try:
        engine._stream([sys.executable, "-c", FAILURE_CHILD], engine.RESOURCE_DIR,
                       lambda _line: None, "3/4 training (50 epochs)")
    except RuntimeError as exc:
        assert "sample rate" in str(exc), f"lost the reason: {exc}"
        print("  pass  a step that exits 0 after failing is still a failure")
        print(f"        {exc}")
        return
    raise AssertionError("an exit-0 failure was reported as success")


def check_success_is_not_mistaken_for_failure() -> None:
    engine._stream([sys.executable, "-c", "print('Model X trained successfully.')"],
                   engine.RESOURCE_DIR, lambda _line: None, "3/4 training")
    print("  pass  a successful step is not caught by the failure markers")


def _make_run_dir(sample_rate: int) -> Path:
    run_dir = engine.APPLIO_DIR / "logs" / PROBE_RUN
    (run_dir / "sliced_audios").mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(
        json.dumps({"data": {"sample_rate": sample_rate}}), encoding="utf-8")
    return run_dir


def check_stale_attempt_is_cleared() -> None:
    run_dir = _make_run_dir(40000)
    said: list[str] = []

    engine._discard_mismatched_run(PROBE_RUN, "40000", said.append)
    assert run_dir.exists(), "a rerun at the same rate must keep its checkpoints"

    engine._discard_mismatched_run(PROBE_RUN, "32000", said.append)
    assert not run_dir.exists(), "a 40 kHz attempt survived a 32 kHz rerun"
    assert said and "32 kHz" in said[0], said

    # A name with no previous attempt must not be touched, and must not raise.
    engine._discard_mismatched_run("_test_setup_never_run", "32000", said.append)
    print("  pass  a stale attempt is cleared, a matching one is kept to resume from")


def _write_wav(path: Path, seconds: float = 0.4) -> None:
    frames = int(16000 * seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * frames)


def check_staging_replaces_rather_than_accumulates(tmp: Path) -> None:
    source = tmp / "take.wav"
    _write_wav(source)

    dest, copied, _ = engine.stage_uploaded_samples([str(source)], PROBE_VOICE)
    first = sorted(p.name for p in dest.iterdir() if p.is_file())
    dest, copied, _ = engine.stage_uploaded_samples([str(source)], PROBE_VOICE)
    second = sorted(p.name for p in dest.iterdir() if p.is_file())

    assert copied == 1, copied
    assert first == second == ["take.wav"], (first, second)

    # Restaging a shorter list must not leave the dropped clip behind: the list
    # passed in is the whole truth about the voice.
    other = tmp / "second-take.wav"
    _write_wav(other)
    engine.stage_uploaded_samples([str(source), str(other)], PROBE_VOICE)
    engine.stage_uploaded_samples([str(source)], PROBE_VOICE)
    left = sorted(p.name for p in dest.iterdir() if p.is_file())
    assert left == ["take.wav"], left
    print("  pass  restaging replaces the dataset instead of piling up copies")


def check_transcodes_are_not_duplicated(tmp: Path) -> None:
    """The path the duplicates actually came from: a converted m4a."""
    if shutil.which("ffmpeg") is None:
        print("  skip  no ffmpeg, so the conversion path is untested")
        return

    wav = tmp / "phone.wav"
    _write_wav(wav)
    m4a = tmp / "phone.m4a"
    made = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                           "-c:a", "aac", str(m4a)], capture_output=True)
    if made.returncode != 0 or not m4a.exists():
        print("  skip  ffmpeg could not write an m4a here")
        return

    dest, _, _ = engine.stage_uploaded_samples([str(m4a)], PROBE_VOICE)
    for _ in range(3):
        engine.stage_uploaded_samples([str(m4a)], PROBE_VOICE)
    names = sorted(p.name for p in dest.iterdir() if p.is_file())
    assert names == ["phone.wav"], f"conversions piled up: {names}"
    print("  pass  four attempts at the same recording leave one converted clip")


def check_staging_in_place_is_safe() -> None:
    """Pointing training at its own staging folder must not delete it."""
    dest = engine.DATASETS_DIR / PROBE_VOICE
    dest.mkdir(parents=True, exist_ok=True)
    inside = dest / "already-here.wav"
    _write_wav(inside)

    _, copied, _ = engine.stage_uploaded_samples([str(inside)], PROBE_VOICE)
    assert inside.exists(), "staging a folder onto itself deleted the source"
    assert copied == 1, copied
    print("  pass  staging a folder onto itself keeps the files it was given")


def main() -> int:
    tmp = Path(engine.DATA_DIR) / "_test_setup_sources"
    tmp.mkdir(parents=True, exist_ok=True)

    checks = (
        check_silent_failure_is_a_failure,
        check_success_is_not_mistaken_for_failure,
        check_stale_attempt_is_cleared,
        lambda: check_staging_replaces_rather_than_accumulates(tmp),
        lambda: check_transcodes_are_not_duplicated(tmp),
        check_staging_in_place_is_safe,
    )

    print("\nBefore a training run starts\n")
    failed = 0
    try:
        for check in checks:
            name = getattr(check, "__name__", "check")
            try:
                check()
            except AssertionError as exc:
                failed += 1
                print(f"  FAIL  {name}: {exc}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(engine.DATASETS_DIR / PROBE_VOICE, ignore_errors=True)
        shutil.rmtree(engine.APPLIO_DIR / "logs" / PROBE_RUN, ignore_errors=True)

    print("\n  FAIL" if failed else "\n  PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
