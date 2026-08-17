"""
Voice packs — several voices, their previews, their portraits and their terms,
in one file you can hand to someone.

Installing a voice today means finding a `.pth`, finding its matching `.index`,
importing both, generating a preview, and knowing what you are allowed to do
with the result. A pack carries all of that with the audio, so installing a set
of voices is one action and the licence travels with them instead of being
remembered.

The file is a zip with a manifest at the root:

    pack.json
    voices/<voice>.pth
    voices/<voice>.index          (optional)
    previews/<voice>.mp3          (optional)
    portraits/<voice>.img         (optional)

Nothing here trusts the archive. Member paths are checked before extraction,
sizes are capped, and a pack that half-installs is rolled back — a downloaded
zip is untrusted input no matter how friendly its manifest reads.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
import zipfile
from pathlib import Path
from typing import Optional

import engine

log = logging.getLogger("ai_cover_studio.packs")

FORMAT = "vocalis.pack"
FORMAT_VERSION = 1
EXTENSION = ".vocalispack"
MANIFEST_NAME = "pack.json"

INSTALLED_PATH = engine.DATA_DIR / "packs.json"

# An RVC model is tens of megabytes and an index a few hundred at the very most.
# A member claiming to be far larger is a decompression bomb, not a voice.
MAX_MEMBER_BYTES = 1_500 * 1024 * 1024
MAX_TOTAL_BYTES = 4_000 * 1024 * 1024
MAX_VOICES_PER_PACK = 64

# What a pack is allowed to say about use. Free text would be unenforceable and
# unreadable; these three map onto the only distinctions that matter downstream.
LICENCES = {
    "personal": "Personal, non-commercial use",
    "commercial": "Commercial use permitted",
    "unspecified": "No terms stated",
}


class PackError(ValueError):
    """A pack that cannot be installed, with a sentence fit to show a user."""


# ---------------------------------------------------------------------------
# The installed-packs register
# ---------------------------------------------------------------------------
def _load_register() -> dict:
    try:
        raw = json.loads(INSTALLED_PATH.read_text("utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_register(data: dict) -> None:
    try:
        tmp = INSTALLED_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        tmp.replace(INSTALLED_PATH)
    except OSError:
        log.warning("Couldn't record the installed pack.")


def list_installed() -> list[dict]:
    """Installed packs, newest first, each with the voices still present."""
    register = _load_register()
    here = set(engine.list_voice_models())
    out = []
    for pack_id, entry in register.items():
        voices = entry.get("voices") or []
        out.append({
            "id": pack_id,
            "name": entry.get("name") or pack_id,
            "author": entry.get("author") or "",
            "description": entry.get("description") or "",
            "licence": entry.get("licence") or "unspecified",
            "licenceLabel": LICENCES.get(entry.get("licence") or "unspecified",
                                         LICENCES["unspecified"]),
            "installedAt": entry.get("installedAt"),
            "voices": voices,
            # A voice can be deleted from the Voices list without the pack
            # knowing, so presence is checked rather than assumed.
            "voicesPresent": [v for v in voices if v in here],
        })
    out.sort(key=lambda p: p.get("installedAt") or 0, reverse=True)
    return out


def pack_for_voice(voice_name: str) -> Optional[dict]:
    """The pack a voice came from, for the licence line on its detail sheet."""
    for pack in list_installed():
        if voice_name in (pack.get("voices") or []):
            return pack
    return None


# ---------------------------------------------------------------------------
# Reading a pack
# ---------------------------------------------------------------------------
def _safe_member(name: str) -> bool:
    """Reject absolute paths, parent traversal and anything not in the layout."""
    if not name or name.endswith("/"):
        return False
    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        return False
    return path.parts[0] in {"voices", "previews", "portraits"}


def _read_manifest(archive: zipfile.ZipFile) -> dict:
    try:
        raw = json.loads(archive.read(MANIFEST_NAME).decode("utf-8"))
    except KeyError:
        raise PackError("That file isn't a Vocalis voice pack — no pack.json inside.")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise PackError("This pack's manifest is corrupt.")

    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise PackError("That file isn't a Vocalis voice pack.")
    if int(raw.get("version") or 0) > FORMAT_VERSION:
        raise PackError("This pack needs a newer version of Vocalis.")

    voices = raw.get("voices")
    if not isinstance(voices, list) or not voices:
        raise PackError("This pack contains no voices.")
    if len(voices) > MAX_VOICES_PER_PACK:
        raise PackError("This pack claims more voices than Vocalis will install at once.")
    return raw


def inspect(path: str) -> dict:
    """
    Everything the install sheet needs to describe a pack before it commits:
    what is in it, what it costs in disk, and which names already exist here.
    """
    source = Path(path).expanduser()
    if not source.is_file():
        raise PackError("That pack file is gone.")

    try:
        with zipfile.ZipFile(source) as archive:
            manifest = _read_manifest(archive)
            sizes = {i.filename: i.file_size for i in archive.infolist()}
    except zipfile.BadZipFile:
        raise PackError("That file isn't a Vocalis voice pack.")

    total = sum(sizes.values())
    if total > MAX_TOTAL_BYTES:
        raise PackError("This pack is larger than Vocalis will install.")

    existing = set(engine.list_voice_models())
    voices = []
    for entry in manifest["voices"]:
        if not isinstance(entry, dict):
            continue
        name = engine.safe_model_name(str(entry.get("name") or ""))
        model = str(entry.get("file") or "")
        if not name or not _safe_member(model) or model not in sizes:
            continue
        voices.append({
            "name": name,
            "gender": str(entry.get("gender") or ""),
            "category": str(entry.get("category") or ""),
            "notes": str(entry.get("notes") or ""),
            "medianF0": entry.get("medianF0") or None,
            "hasIndex": bool(entry.get("index")) and str(entry["index"]) in sizes,
            "hasPreview": bool(entry.get("preview")) and str(entry["preview"]) in sizes,
            "sizeBytes": sizes.get(model, 0)
                         + sizes.get(str(entry.get("index") or ""), 0),
            "conflict": name in existing,
        })

    if not voices:
        raise PackError("None of this pack's voices could be read.")

    licence = str(manifest.get("licence") or "unspecified")
    return {
        "path": str(source),
        "id": str(manifest.get("id") or source.stem),
        "name": str(manifest.get("name") or source.stem),
        "author": str(manifest.get("author") or ""),
        "description": str(manifest.get("description") or ""),
        "licence": licence if licence in LICENCES else "unspecified",
        "licenceLabel": LICENCES.get(licence, LICENCES["unspecified"]),
        "sizeBytes": total,
        "voices": voices,
        "conflicts": [v["name"] for v in voices if v["conflict"]],
    }


# ---------------------------------------------------------------------------
# Installing
# ---------------------------------------------------------------------------
def _extract(archive: zipfile.ZipFile, member: str, dest: Path) -> None:
    info = archive.getinfo(member)
    if info.file_size > MAX_MEMBER_BYTES:
        raise PackError(f"'{member}' is implausibly large for a voice file.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(info) as src, dest.open("wb") as out:
        shutil.copyfileobj(src, out, length=1024 * 1024)


def install(path: str, *, overwrite: bool = False,
            progress_cb=None, log_cb=None) -> dict:
    """
    Install every voice in a pack.

    Installs are all-or-nothing: a pack that fails halfway leaves nothing of
    itself behind, because a half-installed pack is worse than no pack — the
    Voices list would show models with no index and no preview and no way to
    tell which.
    """
    progress = progress_cb or (lambda *a, **k: None)
    details = inspect(path)

    if details["conflicts"] and not overwrite:
        names = ", ".join(details["conflicts"])
        raise PackError(
            f"You already have a voice named {names}. Rename it, or install "
            "this pack over the top.")

    import voices_manifest

    written: list[Path] = []
    installed_names: list[str] = []

    try:
        with zipfile.ZipFile(Path(path).expanduser()) as archive:
            manifest = _read_manifest(archive)
            wanted = {v["name"]: v for v in details["voices"]}

            for i, entry in enumerate(manifest["voices"]):
                name = engine.safe_model_name(str((entry or {}).get("name") or ""))
                if name not in wanted:
                    continue
                progress((i + 1) / (len(manifest["voices"]) + 1),
                         f"Installing {name}", "")

                pth_dest = engine.MODELS_DIR / f"{name}.pth"
                _extract(archive, str(entry["file"]), pth_dest)
                written.append(pth_dest)

                index_member = str(entry.get("index") or "")
                if index_member and _safe_member(index_member):
                    index_dest = engine.MODELS_DIR / f"{name}.index"
                    _extract(archive, index_member, index_dest)
                    written.append(index_dest)

                preview_member = str(entry.get("preview") or "")
                if preview_member and _safe_member(preview_member):
                    preview_dest = voices_manifest.preview_path(name)
                    _extract(archive, preview_member, preview_dest)
                    written.append(preview_dest)

                portrait_member = str(entry.get("portrait") or "")
                if portrait_member and _safe_member(portrait_member):
                    import hf_voices
                    hf_voices.PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
                    portrait_dest = hf_voices.PORTRAIT_DIR / f"{name}.img"
                    _extract(archive, portrait_member, portrait_dest)
                    written.append(portrait_dest)

                voices_manifest.record_origin(
                    name,
                    packId=details["id"],
                    packName=details["name"],
                    licence=details["licence"],
                    sourceUrl=str(entry.get("sourceUrl") or ""),
                    category=str(entry.get("category") or ""),
                    gender=str(entry.get("gender") or ""),
                    portraitName=name if portrait_member else "",
                )

                # A pack author who measured the voice saves the app from
                # guessing its range from a gender tag.
                if entry.get("medianF0"):
                    try:
                        import analysis
                        analysis.record_pack_profile(name, float(entry["medianF0"]))
                    except (TypeError, ValueError, ImportError):
                        pass

                installed_names.append(name)
    except PackError:
        _roll_back(written)
        raise
    except (zipfile.BadZipFile, OSError) as err:
        _roll_back(written)
        raise PackError(f"Couldn't install this pack: {err}")

    register = _load_register()
    register[details["id"]] = {
        "name": details["name"],
        "author": details["author"],
        "description": details["description"],
        "licence": details["licence"],
        "installedAt": time.time(),
        "voices": installed_names,
        "sourcePath": str(Path(path).expanduser()),
    }
    _save_register(register)

    progress(1.0, "Done!", "")
    log.info("Installed pack '%s' (%d voices).", details["name"], len(installed_names))
    return {
        "id": details["id"],
        "name": details["name"],
        "licence": details["licence"],
        "licenceLabel": details["licenceLabel"],
        "installed": installed_names,
        "count": len(installed_names),
    }


def _roll_back(written: list[Path]) -> None:
    for path in written:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def forget(pack_id: str) -> dict:
    """
    Drop a pack from the register. The voices stay — deleting a voice is
    something the user does per voice in the Voices list, and a pack quietly
    taking four models away with it would be a nasty surprise.
    """
    register = _load_register()
    entry = register.pop(str(pack_id), None)
    if entry is None:
        raise PackError("That pack isn't installed.")
    _save_register(register)
    return {"id": pack_id, "name": entry.get("name") or pack_id}


# ---------------------------------------------------------------------------
# Making one
# ---------------------------------------------------------------------------
def export(names: list[str], dest_path: str, *, name: str = "",
           author: str = "", description: str = "",
           licence: str = "unspecified", progress_cb=None, log_cb=None) -> dict:
    """
    Build a pack out of installed voices.

    Here because the format needs a writer as well as a reader — a format only
    this app's authors can produce is a distribution channel, not a document
    format, and the person best placed to pack up a trained voice is whoever
    trained it.
    """
    import voices_manifest

    progress = progress_cb or (lambda *a, **k: None)
    wanted = [n for n in (names or []) if n in set(engine.list_voice_models())]
    if not wanted:
        raise PackError("Choose at least one installed voice.")

    target = Path(dest_path).expanduser()
    if target.suffix.lower() != EXTENSION:
        target = target.with_suffix(EXTENSION)

    pack_id = engine.safe_model_name(name or target.stem) or "pack"
    origins = voices_manifest.load_origins()

    entries = []
    try:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for i, voice in enumerate(wanted):
                progress((i + 1) / (len(wanted) + 1), f"Adding {voice}", "")
                pth, index = engine.resolve_model_paths(voice)

                entry = {"name": voice, "file": f"voices/{voice}.pth"}
                archive.write(pth, entry["file"])

                if index and Path(index).is_file():
                    entry["index"] = f"voices/{voice}.index"
                    archive.write(index, entry["index"])

                preview = voices_manifest.preview_path(voice)
                if preview.is_file():
                    entry["preview"] = f"previews/{voice}.mp3"
                    archive.write(preview, entry["preview"])

                origin = origins.get(voice) or {}
                entry["gender"] = origin.get("gender", "")
                entry["category"] = origin.get("category", "")
                entry["sourceUrl"] = origin.get("sourceUrl", "")

                # Measured range travels with the voice, so the machine that
                # installs it can suggest a pitch shift without measuring again.
                try:
                    import analysis
                    profile = analysis.voice_profile(voice)
                    if profile.get("source") in {"training-set", "pack"}:
                        entry["medianF0"] = profile["medianF0"]
                except Exception:
                    pass

                entries.append(entry)

            manifest = {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "id": pack_id,
                "name": name or target.stem,
                "author": author,
                "description": description,
                "licence": licence if licence in LICENCES else "unspecified",
                "createdAt": time.time(),
                "voices": entries,
            }
            archive.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))
    except OSError as err:
        target.unlink(missing_ok=True)
        raise PackError(f"Couldn't write the pack: {err.strerror or err}")

    progress(1.0, "Done!", "")
    size = target.stat().st_size
    log.info("Exported pack '%s' (%d voices, %.1f MB).",
             manifest["name"], len(entries), size / 1e6)
    return {"path": str(target), "count": len(entries), "sizeBytes": size}
