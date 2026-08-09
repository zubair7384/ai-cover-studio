"""
Migration test — runs against a COPY of the real outputs directory.

Answers the question the manifest exists to answer: of the covers on this Mac,
how many carry real recovered metadata and how many were backfilled from their
filename alone?

Run it directly:

    .venv/bin/python tests/test_covers_migration.py

It never touches the live outputs directory or the live manifest: everything
happens inside a temporary DATA_DIR that is discarded afterwards.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

LEGACY_EXPORT = REPO / ".migration" / "legacy-localstorage.json"


def load_legacy_cover_meta() -> dict:
    """
    The renderer's retired localStorage `coverMeta`.

    It lives under the `file://` origin, which the app can no longer read since
    the renderer moved to `app://` — so it was extracted from Chromium's LevelDB
    into .migration/legacy-localstorage.json.
    """
    try:
        blob = json.loads(LEGACY_EXPORT.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    merged: dict = {}
    for origin_data in blob.values():
        merged.update(origin_data.get("coverMeta") or {})
    return merged


def main() -> int:
    live_outputs = REPO / "outputs"
    if not live_outputs.is_dir():
        print(f"No outputs directory at {live_outputs}")
        return 1

    # .resolve() because engine resolves DATA_DIR, and /var is a symlink
    # to /private/var on macOS.
    sandbox = Path(tempfile.mkdtemp(prefix="vocalis_migration_")).resolve()
    try:
        # Point the engine at a throwaway DATA_DIR *before* importing it, then
        # copy the real covers in. The live library is never written to.
        os.environ["ACS_DATA_DIR"] = str(sandbox)
        sandbox_outputs = sandbox / "outputs"
        sandbox_outputs.mkdir(parents=True)

        copied = 0
        for src in sorted(live_outputs.glob("final_cover_*.mp3")):
            shutil.copy2(src, sandbox_outputs / src.name)
            copied += 1

        import engine  # noqa: E402  — must follow the env var
        import covers_manifest  # noqa: E402

        assert engine.DATA_DIR == sandbox, f"sandbox not honoured: {engine.DATA_DIR}"

        legacy = load_legacy_cover_meta()

        print()
        print("  Cover metadata migration")
        print("  " + "-" * 56)
        print(f"  covers copied into sandbox      {copied}")
        print(f"  legacy localStorage records     {len(legacy)}")
        print()

        counts = covers_manifest.migrate(legacy)

        print(f"  recovered from localStorage     {counts['recovered']}")
        print(f"  backfilled from filenames       {counts['backfilled']}")
        print(f"  already present (skipped)       {counts['existing']}")
        print(f"  total records                   {counts['total']}")
        print()

        records = covers_manifest.reconcile()

        # Every cover on disk must end up with a record.
        assert counts["total"] == copied, (
            f"{copied} covers on disk but {counts['total']} records"
        )
        # Re-running must not downgrade a recovered record to a backfilled one.
        again = covers_manifest.migrate(legacy)
        assert again["recovered"] == 0 and again["backfilled"] == 0, (
            f"migration is not idempotent: {again}"
        )
        assert again["existing"] == copied
        # A voice name is never invented.
        for r in records:
            if r["origin"] == covers_manifest.ORIGIN_BACKFILLED:
                assert r["voiceName"] is None, f"invented a voice for {r['id']}"
            # And a raw generated filename is never a title.
            assert not r["title"].startswith("final_cover_"), r["title"]

        recovered = [r for r in records if r["origin"] == covers_manifest.ORIGIN_LOCALSTORAGE]
        if recovered:
            print("  Recovered records")
            print("  " + "-" * 56)
            for r in recovered:
                print(f"  {r['title']}")
                print(f"    voice        {r['voiceName']}")
                print(f"    source       {r['sourceFileName']}")
                print(f"    duration     {r['durationSec']}s")
                print(f"    pitch/char   {r['pitchShift']} / {r['voiceCharacter']}")
            print()

        sample = [r for r in records if r["origin"] == covers_manifest.ORIGIN_BACKFILLED][:3]
        if sample:
            print("  Backfilled sample (first 3)")
            print("  " + "-" * 56)
            for r in sample:
                print(f"  {r['title']:<28} voice={r['voiceName']}  "
                      f"{r['durationSec']}s  {r['sizeBytes']} bytes")
            print()

        print("  idempotent: yes · no invented voices · no filename titles")
        print("  PASS")
        print()
        return 0
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
