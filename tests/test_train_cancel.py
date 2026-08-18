"""
Cancellation test — does "Cancel training" actually stop a trainer?

Run it directly:

    .venv/bin/python tests/test_train_cancel.py

It never starts Applio. The two things that made Cancel dead are both testable
with a stand-in child process:

  1. `_stream` read the child with `for line in proc.stdout`, which blocks until
     a newline arrives. Applio spends long stretches silent (preprocessing) or
     redrawing a tqdm bar with carriage returns and no newline at all, so the
     cancellation check — which lived inside that loop — never ran during exactly
     the stretches people want to escape from.
  2. A cancelled job has to end as `cancelled`, not as a failure.

Nothing here touches the live data directory, the model library or the network.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import engine     # noqa: E402
import server     # noqa: E402


class _Cancelled(Exception):
    """Stands in for server.JobCancelled, raised out of the heartbeat."""


# How long a cancellation may take before the button counts as broken. Two
# heartbeats plus the grace the trainer gets to exit, with room to spare on a
# loaded machine.
_CANCEL_BUDGET_SECONDS = 12.0

CHILD_SILENT = "import os, time; print('PID', os.getpid(), flush=True); time.sleep(120)"

CHILD_TQDM = (
    "import os, sys, time\n"
    "print('PID', os.getpid(), flush=True)\n"
    "while True:\n"
    "    sys.stdout.write('  50%| 3/6 [00:02<00:02]\\r'); sys.stdout.flush(); time.sleep(0.2)\n"
)


def _cancel_during(child_code: str) -> tuple[float, bool, int]:
    """
    Run a child through _stream and cancel from the heartbeat.

    Returns (seconds until _stream unwound, whether the child is gone, beats).
    """
    beats = {"n": 0}
    child_pid = {"v": 0}

    def heartbeat() -> None:
        beats["n"] += 1
        if beats["n"] >= 2:
            raise _Cancelled()

    def log_cb(line: str) -> None:
        if line.startswith("PID "):
            child_pid["v"] = int(line.split()[1])

    started = time.monotonic()
    try:
        engine._stream([sys.executable, "-u", "-c", child_code], engine.RESOURCE_DIR,
                       log_cb, "cancel probe", heartbeat=heartbeat)
        raise AssertionError("_stream returned instead of unwinding the cancellation")
    except _Cancelled:
        pass
    elapsed = time.monotonic() - started

    # The trainer forks workers, so the process group is signalled rather than
    # the one pid we know about. Give the group a moment to actually go.
    gone = True
    if child_pid["v"]:
        for _ in range(20):
            try:
                os.kill(child_pid["v"], 0)
            except OSError:
                break
            time.sleep(0.1)
        else:
            gone = False
    return elapsed, gone, beats["n"]


def check_cancel_while_silent() -> None:
    elapsed, gone, beats = _cancel_during(CHILD_SILENT)
    assert elapsed < _CANCEL_BUDGET_SECONDS, f"took {elapsed:.1f}s to notice"
    assert gone, "the child outlived the cancellation"
    print(f"  pass  a silent child is stopped in {elapsed:.1f}s ({beats} beats)")


def check_cancel_during_progress_bar() -> None:
    elapsed, gone, beats = _cancel_during(CHILD_TQDM)
    assert elapsed < _CANCEL_BUDGET_SECONDS, f"took {elapsed:.1f}s to notice"
    assert gone, "the child outlived the cancellation"
    print(f"  pass  a child printing only carriage returns is stopped in {elapsed:.1f}s")


def check_clean_run_still_works() -> None:
    """The heartbeat must not disturb a run nobody cancelled."""
    lines: list[str] = []
    engine._stream([sys.executable, "-u", "-c", "print('hello'); print('done')"],
                   engine.RESOURCE_DIR, lines.append, "clean run",
                   heartbeat=lambda: None)
    assert lines == ["hello", "done"], lines
    print("  pass  a clean run still completes, with its output intact")


def check_failure_still_explains_itself() -> None:
    """A real failure keeps carrying the trainer's own last words."""
    code = ("import sys; print('No audio files found in the dataset path'); sys.exit(2)")
    try:
        engine._stream([sys.executable, "-u", "-c", code], engine.RESOURCE_DIR,
                       lambda _l: None, "1/4 preprocessing dataset", heartbeat=lambda: None)
        raise AssertionError("a non-zero exit was reported as success")
    except RuntimeError as exc:
        assert "No audio files found" in str(exc), str(exc)
    print("  pass  a failed step still reports what the trainer said")


def check_job_ends_as_cancelled() -> None:
    """The endpoint's flag has to reach the UI as `cancelled`, not as an error."""
    def fake_train(*, progress_cb, log_cb):
        # Beat the way engine._stream's heartbeat does, forever.
        for i in range(2000):
            progress_cb(0.30, "1/4 preprocessing dataset", "")
            log_cb(f"line {i}")
            time.sleep(0.05)
        raise AssertionError("the fake trainer was never cancelled")

    job = server.Job()
    server.JOBS[job.id] = job
    threading.Thread(target=server._run_job, args=(job, fake_train), daemon=True).start()
    time.sleep(0.4)
    server.cancel_job(job.id)

    seen: list[str] = []
    deadline = time.monotonic() + _CANCEL_BUDGET_SECONDS
    while time.monotonic() < deadline:
        try:
            seen.append(job.q.get(timeout=0.5)["type"])
        except Exception:
            continue
        if seen[-1] == "_eof":
            break

    assert "cancelled" in seen, f"no cancelled event: {[s for s in seen if s != 'log']}"
    assert "error" not in seen, "a cancel was reported as a failure"
    assert "done" not in seen, "a cancel was reported as a finished run"
    del server.JOBS[job.id]
    print("  pass  a cancelled job ends as cancelled, not as a failure")


def main() -> int:
    print("\nCancelling a training run\n")
    checks = (
        check_cancel_while_silent,
        check_cancel_during_progress_bar,
        check_clean_run_still_works,
        check_failure_still_explains_itself,
        check_job_ends_as_cancelled,
    )
    failed = 0
    for check in checks:
        try:
            check()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {check.__name__}: {exc}")

    print("\n  FAIL" if failed else "\n  PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
