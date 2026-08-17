"""
Project and pack documents, and the pitch-shift suggestion around them.

These are the parts of the app that have to survive travelling: a `.vocalis`
project opened on a machine that lacks the song, a `.vocalispack` built here and
installed there, a measured vocal range that has to outlive a rename. None of it
needs a model run, so all of it is testable in seconds.

Run it directly:

    .venv/bin/python tests/test_documents.py

Everything happens inside a temporary DATA_DIR that is discarded afterwards; the
live library, voices and caches are never touched.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'pass' if condition else 'FAIL'}  {label}"
          + (f"   {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def expect_error(label: str, fn, *args, **kwargs) -> None:
    """The error path is the point of most of these — a bad document has to be
    refused with a sentence, not an exception nobody can act on."""
    try:
        fn(*args, **kwargs)
    except Exception as err:                      # noqa: BLE001 — that is the test
        check(label, bool(str(err)), f"“{err}”")
        return
    check(label, False, "no error raised")


def main() -> int:
    sandbox = Path(tempfile.mkdtemp(prefix="vocalis_docs_")).resolve()
    try:
        os.environ["ACS_DATA_DIR"] = str(sandbox)
        (sandbox / "voice_models").mkdir(parents=True)
        (sandbox / "outputs").mkdir(parents=True)

        import engine            # noqa: E402  — must follow the env var
        import analysis          # noqa: E402
        import packs             # noqa: E402
        import projects          # noqa: E402
        import voices_manifest   # noqa: E402

        assert engine.DATA_DIR == sandbox, f"sandbox not honoured: {engine.DATA_DIR}"

        # A model file only has to exist to be packed and installed; nothing in
        # these paths loads it.
        (engine.MODELS_DIR / "tenorvoice.pth").write_bytes(b"not a real model" * 64)
        (engine.MODELS_DIR / "tenorvoice.index").write_bytes(b"index" * 64)
        song = sandbox / "song.wav"
        song.write_bytes(b"RIFF" + b"\0" * 128)

        print()
        print("  Projects")
        print("  " + "-" * 60)

        doc = projects.build(
            title="  ", song_path=str(song), song_name="song.wav",
            voice_id="tenorvoice",
            trim={"start": 10.0, "end": 40.0},
            params={"pitchShift": 99, "voiceCharacter": 5, "outputFormat": "aiff",
                    "harmonyPreset": "nonsense", "doubleTrack": 1,
                    "harmonyGainDb": -99},
        )
        check("blank title falls back to the song", doc["title"] == "song")
        check("out-of-range values are clamped, not rejected",
              doc["params"]["pitchShift"] == 12
              and doc["params"]["voiceCharacter"] == 1.0
              and doc["params"]["harmonyGainDb"] == engine.HARMONY_MIN_GAIN_DB,
              f"pitch={doc['params']['pitchShift']} "
              f"char={doc['params']['voiceCharacter']} "
              f"gain={doc['params']['harmonyGainDb']}")
        check("unknown enum values fall back to the default",
              doc["params"]["outputFormat"] == "mp3"
              and doc["params"]["harmonyPreset"] == "none")

        saved = projects.save(str(sandbox / "demo"), doc)
        check("extension is added when left off", saved["path"].endswith(".vocalis"))

        opened = projects.open_project(saved["path"])
        check("round trip keeps the trim",
              opened["trim"] == {"start": 10.0, "end": 40.0})
        check("song and voice both resolve here",
              opened["song"]["available"] and opened["voice"]["available"]
              and opened["missing"] == [])

        # The interesting case: a project that travelled.
        travelled = json.loads(Path(saved["path"]).read_text("utf-8"))
        travelled["song"]["path"] = "/nowhere/gone.wav"
        travelled["voice"]["id"] = "not_installed"
        elsewhere = sandbox / "travelled.vocalis"
        elsewhere.write_text(json.dumps(travelled), "utf-8")

        far = projects.open_project(str(elsewhere))
        check("a travelled project reports what is missing rather than failing",
              far["missing"] == ["song", "voice"]
              and not far["song"]["available"] and not far["voice"]["available"])

        (sandbox / "junk.vocalis").write_text("this is not json", "utf-8")
        expect_error("junk is refused with a sentence",
                     projects.open_project, str(sandbox / "junk.vocalis"))

        newer = dict(travelled, version=projects.FORMAT_VERSION + 1)
        (sandbox / "newer.vocalis").write_text(json.dumps(newer), "utf-8")
        expect_error("a newer format version says so",
                     projects.open_project, str(sandbox / "newer.vocalis"))

        expect_error("a missing file says so",
                     projects.open_project, str(sandbox / "absent.vocalis"))

        print()
        print("  Voice packs")
        print("  " + "-" * 60)

        pack_path = sandbox / "studio"
        built = packs.export(["tenorvoice"], str(pack_path), name="Studio Set",
                             author="Vocalis", licence="commercial")
        check("export writes a pack", Path(built["path"]).is_file()
              and built["count"] == 1)

        info = packs.inspect(built["path"])
        check("inspect reads the manifest back",
              info["name"] == "Studio Set"
              and info["licence"] == "commercial"
              and info["voices"][0]["hasIndex"])
        check("a voice already here is flagged as a conflict",
              info["conflicts"] == ["tenorvoice"])

        expect_error("installing over an existing voice needs saying so",
                     packs.install, built["path"])

        result = packs.install(built["path"], overwrite=True)
        check("install with overwrite lands the voice",
              result["installed"] == ["tenorvoice"])
        check("the pack is registered against its voices",
              (packs.pack_for_voice("tenorvoice") or {}).get("id") == info["id"])
        check("licence travels with the pack",
              packs.list_installed()[0]["licenceLabel"].startswith("Commercial"))
        check("origins record where the voice came from",
              (voices_manifest.load_origins().get("tenorvoice") or {})
              .get("packName") == "Studio Set")

        packs.forget(info["id"])
        check("forgetting a pack leaves its voices installed",
              not packs.list_installed()
              and "tenorvoice" in engine.list_voice_models())

        # A pack is untrusted input. A member that would escape the models
        # directory must never be written.
        hostile = sandbox / "hostile.vocalispack"
        with zipfile.ZipFile(hostile, "w") as archive:
            archive.writestr("pack.json", json.dumps({
                "format": packs.FORMAT, "version": 1, "id": "evil", "name": "Evil",
                "voices": [{"name": "escape", "file": "../../../../tmp/escape.pth"}],
            }))
            archive.writestr("../../../../tmp/escape.pth", "x" * 32)
        expect_error("a traversal path is refused before extraction",
                     packs.inspect, str(hostile))
        check("nothing escaped", not Path("/tmp/escape.pth").exists())

        (sandbox / "notazip.vocalispack").write_text("nope", "utf-8")
        expect_error("a non-zip is refused",
                     packs.inspect, str(sandbox / "notazip.vocalispack"))

        print()
        print("  Vocal range")
        print("  " + "-" * 60)

        check("hz to note", analysis.hz_to_note(440.0) == "A4",
              analysis.hz_to_note(440.0))
        check("an octave is twelve semitones",
              round(analysis.semitones_between(110.0, 220.0)) == 12)
        check("an unmeasurable voice says so",
              analysis.voice_profile("tenorvoice")["source"] == "unknown")

        stated = analysis.set_manual_profile("tenorvoice", range_key="tenor")
        check("a stated range is remembered",
              analysis.voice_profile("tenorvoice") == stated
              and stated["source"] == "manual" and stated["note"] == "E3")
        expect_error("an unknown range name is refused",
                     analysis.set_manual_profile, "tenorvoice", range_key="warbler")

        analysis.forget_voice_profile("tenorvoice")
        check("a forgotten range is gone",
              analysis.voice_profile("tenorvoice")["source"] == "unknown")

        print()
        if failures:
            print(f"  {len(failures)} FAILED: {', '.join(failures)}")
            print()
            return 1
        print("  PASS")
        print()
        return 0
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
