"""
What a failed link fetch tells the user.

This exists because the fallback message used to blame a stale downloader for
every failure it did not recognise — including a full disk and a dead network —
and told people to update a yt-dlp that was already current. The advice is now
conditional, and these are the cases it has to get right.

Pure string handling, so it needs no network and no audio:

    .venv/bin/python tests/test_fetch_errors.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import engine  # noqa: E402

UPDATE_HINT = "pip install -U yt-dlp"

# (yt-dlp's message, must appear, must NOT appear)
CASES = [
    # Genuinely a moved target: the update advice belongs here.
    ("ERROR: [youtube] JGwWNGJdvx8: Failed to extract any player response; "
     "please report this issue on https://github.com/yt-dlp/yt-dlp/issues",
     ["player response", UPDATE_HINT], ["report this issue"]),
    ("ERROR: [youtube] dQw4w9WgXcQ: Unable to extract yt initial data",
     ["Unable to extract", UPDATE_HINT], ["dQw4w9WgXcQ"]),
    ("ERROR: [youtube] dQw4w9WgXcQ: Requested format is not available",
     [UPDATE_HINT], []),

    # Local or remote conditions a newer downloader cannot fix.
    ("ERROR: unable to open for writing: [Errno 28] No space left on device",
     ["disk space"], [UPDATE_HINT]),
    ("ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor "
     "servname provided, or not known>",
     ["No network"], [UPDATE_HINT]),
    ("ERROR: unable to download video data: HTTP Error 500: Internal Server Error",
     ["500"], [UPDATE_HINT]),
    ("ERROR: [generic] page: Unable to download webpage: HTTP Error 403: Forbidden",
     ["403"], [UPDATE_HINT]),
    ("ERROR: [youtube] x: Unable to download webpage: The read operation timed out",
     ["too long"], [UPDATE_HINT]),

    # Already-known causes keep their own wording and never gain the advice.
    ("ERROR: [youtube] x: Sign in to confirm you're not a bot",
     ["sign in"], [UPDATE_HINT]),
    ("ERROR: [youtube] x: Video unavailable",
     ["unavailable"], [UPDATE_HINT]),
    ("ERROR: [youtube] x: This video is private",
     ["private"], [UPDATE_HINT]),

    # No message at all is the one case with nothing to lead with.
    ("", ["Check the link"], []),
]


def main() -> int:
    failures = 0
    print()
    print("  Link-fetch error messages")
    print("  " + "-" * 68)

    for raw, expected, forbidden in CASES:
        out = engine._friendly_fetch_error(raw)
        missing = [e for e in expected if e.lower() not in out.lower()]
        present = [f for f in forbidden if f.lower() in out.lower()]
        ok = not missing and not present
        failures += 0 if ok else 1

        print(f"  {'pass' if ok else 'FAIL'}  {(raw[:52] or '(no message)')}")
        if not ok:
            print(f"        got: {out}")
            if missing:
                print(f"        missing: {missing}")
            if present:
                print(f"        should not say: {present}")

    # Every message is shown to a person, so none of them may be a bare
    # traceback line or end mid-sentence.
    for raw, _, _ in CASES:
        out = engine._friendly_fetch_error(raw)
        if "Traceback" in out or not out.endswith((".", "p")) or out.startswith("ERROR"):
            print(f"  FAIL  message is not fit to show: {out!r}")
            failures += 1

    print()
    if failures:
        print(f"  {failures} FAILED")
        print()
        return 1
    print("  PASS")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
