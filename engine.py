"""
AI Cover Studio — core engine (UI-agnostic).

All the heavy-lifting pipeline logic lives here with **no Gradio dependency** so
it can be driven by the FastAPI desktop server (server.py) or any other front
end. Progress and live logs are reported through plain callbacks:

    progress_cb(fraction: float, step: str, note: str = "")   # 0.0 .. 1.0
    log_cb(line: str)                                          # one log line

Both callbacks are optional; pass None to ignore.

Pipeline (unchanged from the original Gradio app):
  1. Separate the song into stems with HTDemucs (audio-separator).
  2. Convert isolated vocals with an RVC model (rvc-python, RMVPE pitch).
  3. Polish the cloned vocals with Pedalboard.
  4. Overlay vocals on the instrumental with pydub, export an MP3.

Training runs the open-source Applio trainer as subprocesses.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log = logging.getLogger("ai-cover-studio")
if not log.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

# Callback type aliases
ProgressCb = Optional[Callable[[float, str, str], None]]
LogCb = Optional[Callable[[str], None]]


def _noop_progress(frac: float, step: str, note: str = "") -> None:  # pragma: no cover
    pass


def _noop_log(line: str) -> None:  # pragma: no cover
    pass


# ---------------------------------------------------------------------------
# Paths & constants
#
# When frozen inside the packaged desktop app, read-only assets (Applio,
# separator weights) live next to the executable, but user-writable data
# (voice_models, outputs, datasets) must go to a per-user data directory.
# ACS_DATA_DIR / ACS_RESOURCE_DIR are set by the Electron main process; they
# fall back to the source-tree layout for plain `python` development.
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
RESOURCE_DIR = Path(os.environ.get("ACS_RESOURCE_DIR", BASE_DIR)).resolve()
DATA_DIR = Path(os.environ.get("ACS_DATA_DIR", BASE_DIR)).resolve()

MODELS_DIR = DATA_DIR / "voice_models"       # trained/downloaded RVC .pth/.index
OUTPUT_DIR = DATA_DIR / "outputs"            # final covers land here
DATASETS_DIR = DATA_DIR / "training_datasets"  # uploaded voice samples
SEPARATOR_MODEL_DIR = DATA_DIR / ".separator_models"  # cached HTDemucs weights

for d in (MODELS_DIR, OUTPUT_DIR, DATASETS_DIR, SEPARATOR_MODEL_DIR):
    d.mkdir(parents=True, exist_ok=True)

SAMPLE_RATE_CHOICES = ["32000", "40000", "48000"]
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".aiff", ".aif"}


# ---------------------------------------------------------------------------
# Hardware detection
# ---------------------------------------------------------------------------
def detect_device() -> str:
    """Return 'cuda:0' when an NVIDIA GPU is usable, otherwise 'cpu'."""
    try:
        import torch

        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            log.info("CUDA GPU detected: %s", name)
            return "cuda:0"
    except Exception as exc:  # torch missing or broken CUDA runtime
        log.warning("CUDA probe failed (%s); falling back to CPU.", exc)
    log.info("No CUDA GPU available — running on CPU (slower but works).")
    return "cpu"


DEVICE = detect_device()


def hardware_summary() -> dict:
    """Describe the compute device + a training-speed expectation for the UI."""
    if DEVICE.startswith("cuda"):
        try:
            import torch
            name = torch.cuda.get_device_name(0)
        except Exception:
            name = "NVIDIA GPU"
        return {"device": DEVICE, "label": name, "tier": "gpu",
                "training_warning": ""}
    if sys.platform == "darwin":
        # Apple Silicon has partial MPS acceleration; Intel Macs are CPU-only.
        import platform
        arch = platform.machine()
        if arch == "arm64":
            return {"device": DEVICE, "label": "Apple Silicon (CPU/MPS)",
                    "tier": "mps",
                    "training_warning": "Training uses your CPU and can take a "
                    "while — expect roughly 1–3 hours for a small dataset."}
        return {"device": DEVICE, "label": "Intel Mac (CPU only)", "tier": "cpu",
                "training_warning": "No GPU detected. Training on CPU can take "
                "several hours — leave the app running."}
    return {"device": DEVICE, "label": "CPU only", "tier": "cpu",
            "training_warning": "No NVIDIA GPU detected. Training on CPU can "
            "take several hours — an NVIDIA GPU is strongly recommended."}


def _allow_legacy_torch_load() -> None:
    """
    torch >= 2.6 defaults torch.load to weights_only=True, which rejects the
    fairseq/RVC checkpoints this app loads. They are local files the user chose
    to install, so restore the legacy behavior unless a caller opts in.
    """
    import torch

    if getattr(torch.load, "_acs_patched", False):
        return
    orig_load = torch.load

    def load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return orig_load(*args, **kwargs)

    load._acs_patched = True
    torch.load = load


# HTDemucs checkpoint. The fine-tuned bag (htdemucs_ft) runs 4 models and is
# ~4x slower — only worth it on a GPU.
DEMUCS_MODEL = "htdemucs_ft.yaml" if DEVICE.startswith("cuda") else "htdemucs.yaml"


# ---------------------------------------------------------------------------
# Voice-model discovery
# ---------------------------------------------------------------------------
def list_voice_models() -> list[str]:
    """Names of every .pth model found in the voice_models directory."""
    return sorted(p.stem for p in MODELS_DIR.glob("*.pth"))


def resolve_model_paths(model_name: str) -> tuple[Path, Optional[Path]]:
    """Return (.pth path, matching .index path or None) for a model name."""
    pth = MODELS_DIR / f"{model_name}.pth"
    if not pth.exists():
        raise FileNotFoundError(
            f"Model '{model_name}' not found in {MODELS_DIR}. "
            "Add the .pth file there and press Refresh."
        )
    index = next(iter(MODELS_DIR.glob(f"{model_name}*.index")), None)
    if index is None:
        # Many downloaded models ship an index named e.g. "added_IVF1040_…"
        # that shares no prefix with the .pth. If exactly one index file isn't
        # claimed by another model's name, pair it up.
        others = [m for m in list_voice_models() if m != model_name]
        orphans = [p for p in MODELS_DIR.glob("*.index")
                   if not any(p.name.startswith(m) for m in others)]
        if len(orphans) == 1:
            index = orphans[0]
            log.info("Pairing orphan index '%s' with model '%s'.",
                     index.name, model_name)
    return pth, index


def import_model_files(paths: list[str]) -> dict:
    """Copy user-picked .pth/.index files into voice_models/. Returns a summary."""
    copied, skipped = [], []
    for raw in paths or []:
        src = Path(raw)
        if src.suffix.lower() in {".pth", ".index"} and src.exists():
            shutil.copyfile(src, MODELS_DIR / src.name)
            copied.append(src.name)
        else:
            skipped.append(src.name)
    log.info("Imported %d model file(s), skipped %d.", len(copied), len(skipped))
    return {"copied": copied, "skipped": skipped, "models": list_voice_models()}


def import_voice_bundle(pth_path: str, index_path: str = "", name: str = "") -> dict:
    """Install one RVC model and its optional index under a predictable name."""
    pth = Path(pth_path)
    if not pth.is_file() or pth.suffix.lower() != ".pth":
        raise ValueError("Choose a valid RVC .pth model file.")

    safe_name = safe_model_name(name or pth.stem)
    if not safe_name:
        raise ValueError("Enter a valid voice name.")

    index = Path(index_path) if index_path else None
    if index and (not index.is_file() or index.suffix.lower() != ".index"):
        raise ValueError("Choose a valid .index file, or remove it.")

    pth_dest = MODELS_DIR / f"{safe_name}.pth"
    index_dest = MODELS_DIR / f"{safe_name}.index"
    if pth_dest.exists() or (index and index_dest.exists()):
        raise FileExistsError(f"A voice named '{safe_name}' already exists.")

    shutil.copyfile(pth, pth_dest)
    try:
        if index:
            shutil.copyfile(index, index_dest)
    except Exception:
        pth_dest.unlink(missing_ok=True)
        raise

    copied = [pth_dest.name] + ([index_dest.name] if index else [])
    log.info("Imported voice '%s' (%d file(s)).", safe_name, len(copied))
    return {"name": safe_name, "copied": copied, "has_index": bool(index),
            "models": list_voice_models()}


# ---------------------------------------------------------------------------
# Step 1 — stem separation (HTDemucs via audio-separator)
# ---------------------------------------------------------------------------
def separate_track(song_path: str, work_dir: Path) -> tuple[Path, Path]:
    """Split the song into vocals.wav and instrumental.wav."""
    from audio_separator.separator import Separator
    from pydub import AudioSegment

    log.info("Loading separator model '%s' …", DEMUCS_MODEL)
    separator = Separator(
        log_level=logging.INFO,
        model_file_dir=str(SEPARATOR_MODEL_DIR),
        output_dir=str(work_dir),
        output_format="WAV",
    )
    separator.load_model(model_filename=DEMUCS_MODEL)

    log.info("Separating stems (this is the slowest step) …")
    outputs = separator.separate(song_path)

    stem_paths = [
        Path(p) if Path(p).is_absolute() else work_dir / p for p in outputs
    ]
    log.info("Separator produced: %s", [p.name for p in stem_paths])

    vocal_stems = [p for p in stem_paths if "(vocals)" in p.name.lower()]
    other_stems = [p for p in stem_paths if p not in vocal_stems]
    if not vocal_stems or not other_stems:
        raise RuntimeError(
            f"Unexpected separator output: {[p.name for p in stem_paths]}"
        )

    vocals_path = work_dir / "vocals.wav"
    shutil.copyfile(vocal_stems[0], vocals_path)

    log.info("Summing %d non-vocal stems into instrumental …", len(other_stems))
    instrumental = AudioSegment.from_file(other_stems[0])
    for stem in other_stems[1:]:
        instrumental = instrumental.overlay(AudioSegment.from_file(stem))
    instrumental_path = work_dir / "instrumental.wav"
    instrumental.export(instrumental_path, format="wav")

    return vocals_path, instrumental_path


# ---------------------------------------------------------------------------
# Step 2 — RVC voice conversion (RMVPE pitch extraction)
# ---------------------------------------------------------------------------
def convert_vocals(
    vocals_path: Path,
    model_name: str,
    pitch_shift: int,
    index_rate: float,
    work_dir: Path,
) -> Path:
    """Run the isolated vocals through the selected RVC model."""
    from rvc_python.infer import RVCInference

    _allow_legacy_torch_load()
    pth_path, index_path = resolve_model_paths(model_name)
    log.info(
        "Loading RVC model '%s' on %s (index: %s)",
        pth_path.name, DEVICE, index_path.name if index_path else "none",
    )

    # rvc-python force-selects MPS whenever torch reports it, ignoring the
    # device argument — and its RMVPE code segfaults on MPS with torch >= 2.6.
    # Hide MPS while the engine captures its device config, then restore.
    import torch
    orig_mps_available = torch.backends.mps.is_available
    torch.backends.mps.is_available = lambda: False
    try:
        rvc = RVCInference(device=DEVICE)
        try:
            rvc.load_model(str(pth_path), index_path=str(index_path or ""))
        except TypeError:
            rvc.load_model(str(pth_path))
    finally:
        torch.backends.mps.is_available = orig_mps_available

    rvc.set_params(
        f0method="rmvpe",
        f0up_key=pitch_shift,
        index_rate=index_rate,
        protect=0.33,
        rms_mix_rate=0.25,
    )

    cloned_path = work_dir / "cloned_vocals.wav"
    log.info("Converting vocals with RMVPE pitch extraction …")
    rvc.infer_file(str(vocals_path), str(cloned_path))

    if not cloned_path.exists():
        raise RuntimeError("RVC inference finished but produced no output file.")
    return cloned_path


# ---------------------------------------------------------------------------
# Step 3 — vocal polish with Pedalboard
# ---------------------------------------------------------------------------
def apply_vocal_effects(cloned_path: Path, work_dir: Path) -> Path:
    """Subtle compression + reverb + slap delay so the vocal sits in the mix."""
    from pedalboard import Compressor, Delay, HighpassFilter, Pedalboard, Reverb
    from pedalboard.io import AudioFile

    board = Pedalboard([
        HighpassFilter(cutoff_frequency_hz=90),
        Compressor(threshold_db=-16, ratio=2.5, attack_ms=8, release_ms=120),
        Reverb(room_size=0.18, damping=0.55,
               wet_level=0.12, dry_level=0.88, width=0.9),
        Delay(delay_seconds=0.22, feedback=0.12, mix=0.07),
    ])

    fx_path = work_dir / "cloned_vocals_fx.wav"
    log.info("Applying reverb/delay polish to cloned vocals …")
    with AudioFile(str(cloned_path)) as f:
        audio = f.read(f.frames)
        sample_rate = f.samplerate
    processed = board(audio, sample_rate)
    with AudioFile(str(fx_path), "w", sample_rate, processed.shape[0]) as f:
        f.write(processed)
    return fx_path


# ---------------------------------------------------------------------------
# Step 4 — final mix with pydub
# ---------------------------------------------------------------------------
def mix_and_export(
    vocals_fx_path: Path,
    instrumental_path: Path,
    vocal_gain_db: float,
) -> Path:
    """Overlay the polished vocals on the instrumental, export a 320k MP3."""
    from pydub import AudioSegment

    log.info("Mixing final cover …")
    vocals = AudioSegment.from_file(vocals_fx_path).apply_gain(vocal_gain_db)
    instrumental = AudioSegment.from_file(instrumental_path).apply_gain(-1.0)
    final = instrumental.overlay(vocals)

    out_path = OUTPUT_DIR / f"final_cover_{time.strftime('%Y%m%d_%H%M%S')}.mp3"
    final.export(out_path, format="mp3", bitrate="320k")
    log.info("Saved final cover -> %s", out_path)
    return out_path


# ---------------------------------------------------------------------------
# Full inference pipeline
# ---------------------------------------------------------------------------
def generate_cover(
    model_name: str,
    song_path: str,
    pitch_shift: int = 0,
    index_rate: float = 0.75,
    vocal_gain_db: float = 0.0,
    progress_cb: ProgressCb = None,
    log_cb: LogCb = None,
) -> Path:
    """
    Run the full cover pipeline. Reports progress via callbacks and returns the
    final MP3 path. Raises on failure (caller maps to an error response).
    """
    progress = progress_cb or _noop_progress
    emit = log_cb or _noop_log

    if not model_name:
        raise ValueError("Select a voice model first.")
    if not song_path or not Path(song_path).exists():
        raise ValueError("Upload a song (.mp3 or .wav) first.")

    # Bridge the module logger into log_cb for the duration of the job.
    handler = _CallbackLogHandler(emit)
    logging.getLogger().addHandler(handler)
    work_dir = Path(tempfile.mkdtemp(prefix="cover_", dir=OUTPUT_DIR))
    log.info("=== New cover job: model=%s song=%s ===", model_name, song_path)

    try:
        progress(0.05, "Step 1/4 — separating vocals & instrumental (HTDemucs)",
                 "First run downloads the separation model (~85 MB).")
        vocals, instrumental = separate_track(song_path, work_dir)

        progress(0.45, "Step 2/4 — cloning vocals with RVC (RMVPE)",
                 "First run downloads the RMVPE pitch model (~180 MB).")
        cloned = convert_vocals(vocals, model_name, int(pitch_shift),
                                float(index_rate), work_dir)

        progress(0.80, "Step 3/4 — polishing vocals (reverb/delay)", "")
        polished = apply_vocal_effects(cloned, work_dir)

        progress(0.92, "Step 4/4 — mixing & exporting MP3", "")
        final_path = mix_and_export(polished, instrumental, float(vocal_gain_db))

        progress(1.0, "Done!", "")
        return final_path
    except Exception:
        log.error("Pipeline failure:\n%s", traceback.format_exc())
        raise
    finally:
        logging.getLogger().removeHandler(handler)


class _CallbackLogHandler(logging.Handler):
    """Forwards log records to a log_cb, skipping noisy HTTP client loggers."""

    def __init__(self, log_cb: Callable[[str], None]):
        super().__init__(level=logging.INFO)
        self.log_cb = log_cb

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if not record.name.startswith(("httpx", "httpcore", "urllib3")):
                self.log_cb(record.getMessage())
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Training dataset staging
# ---------------------------------------------------------------------------
def stage_uploaded_samples(file_paths: list[str], safe_name: str) -> tuple[Path, int, int]:
    """Copy uploaded audio files into training_datasets/<name>/."""
    dest = DATASETS_DIR / safe_name
    dest.mkdir(parents=True, exist_ok=True)
    copied = skipped = 0
    for raw in file_paths or []:
        src = Path(raw)
        if src.suffix.lower() in AUDIO_EXTS and src.exists():
            shutil.copyfile(src, dest / src.name)
            copied += 1
        else:
            skipped += 1
    log.info("Staged %d sample(s) into %s (%d non-audio skipped)",
             copied, dest, skipped)
    return dest, copied, skipped


def safe_model_name(model_name: str) -> str:
    model_name = (model_name or "").strip() or "my_voice"
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in model_name)


# ---------------------------------------------------------------------------
# One-click local training (Applio backend, run as subprocesses)
# ---------------------------------------------------------------------------
# Applio must live somewhere writable: it clones a repo, builds its own venv,
# and writes training logs. In a packaged app RESOURCE_DIR is read-only, so
# training lives under the writable DATA_DIR. The Electron main process seeds
# the bundled Applio *source* here on first run; if it is still missing (e.g.
# a slim install) train_voice_model git-clones it.
APPLIO_DIR = Path(os.environ.get("ACS_APPLIO_DIR", DATA_DIR / "Applio")).resolve()
APPLIO_REPO = "https://github.com/IAHispano/Applio.git"
APPLIO_VENV = APPLIO_DIR / ".venv"
APPLIO_PY = (APPLIO_VENV / ("Scripts" if sys.platform == "win32" else "bin")
             / ("python.exe" if sys.platform == "win32" else "python"))
APPLIO_DEPS_OK = APPLIO_VENV / ".deps_ok"


def _applio_base_python() -> str:
    """Interpreter for Applio's own venv (needs Python 3.11+ for numpy>=2.4)."""
    for ver in ("3.12", "3.11", "3.13"):
        cands = [shutil.which(f"python{ver}")]
        if sys.platform == "darwin":
            cands.append(f"/opt/homebrew/opt/python@{ver}/bin/python{ver}")
        for cand in cands:
            if cand and Path(cand).exists():
                return cand
    return sys.executable


def _stream(cmd: list, cwd: Path, log_cb: Callable[[str], None], desc: str) -> None:
    """Run a command, forwarding stdout lines to log_cb; raise on failure."""
    cmd = [str(c) for c in cmd]
    log.info("[train] %s: %s", desc, " ".join(cmd))
    proc = subprocess.Popen(
        cmd, cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            log_cb(line)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"'{desc}' failed (exit code {proc.returncode}).")


def resolve_training_dataset(file_paths, dataset_dir, safe_name) -> tuple[Optional[Path], Optional[str]]:
    """Return (dataset Path, error message or None) from uploads or a folder."""
    if file_paths:
        dest, copied, _ = stage_uploaded_samples(file_paths, safe_name)
        if not copied:
            return None, ("None of the uploaded files look like audio "
                          "(.mp3/.wav/.flac …). Add voice clips and try again.")
        return dest, None
    dataset_dir = (dataset_dir or "").strip()
    if not dataset_dir:
        return None, ("Add voice samples (or type an existing folder path) "
                      "before pressing Train.")
    ds = Path(dataset_dir).expanduser()
    if not ds.is_dir():
        return None, f"Folder not found: {ds}"
    if not any(p.suffix.lower() in AUDIO_EXTS for p in ds.iterdir()):
        return None, f"No audio files found in {ds}"
    return ds, None


def train_voice_model(
    file_paths: list[str],
    dataset_dir: str,
    model_name: str,
    sample_rate: str = "40000",
    epochs: int = 300,
    progress_cb: ProgressCb = None,
    log_cb: LogCb = None,
) -> dict:
    """
    Run the full Applio pipeline (install → preprocess → extract → train →
    index) in subprocesses, then install the result into voice_models/.
    Returns a summary dict. Raises on failure.
    """
    progress = progress_cb or _noop_progress
    emit = log_cb or _noop_log

    safe_name = safe_model_name(model_name)
    epochs = int(epochs)

    dataset, err = resolve_training_dataset(file_paths, dataset_dir, safe_name)
    if err:
        raise ValueError(err)

    # -- one-time Applio install ------------------------------------------
    if not (APPLIO_DIR / "core.py").exists():
        if shutil.which("git") is None:
            raise RuntimeError("git is required to install the Applio trainer.")
        progress(0.02, "Downloading Applio trainer (one time)…", "")
        _stream(["git", "clone", "--depth", "1", APPLIO_REPO, APPLIO_DIR],
                RESOURCE_DIR, emit, "clone Applio")

    if not APPLIO_DEPS_OK.exists():
        if APPLIO_VENV.exists():
            log.info("Removing incomplete Applio venv %s", APPLIO_VENV)
            shutil.rmtree(APPLIO_VENV)
        base_py = _applio_base_python()
        progress(0.06, "Creating Applio virtualenv…", "")
        _stream([base_py, "-m", "venv", APPLIO_VENV], APPLIO_DIR, emit,
                "create Applio venv")
        if sys.platform == "darwin":
            progress(0.08, "Pre-installing macOS pin workaround…", "")
            _stream([APPLIO_PY, "-m", "pip", "install", "--pre",
                     "omegaconf>=2.4.0.dev0", "antlr4-python3-runtime==4.13.2"],
                    APPLIO_DIR, emit, "pre-install omegaconf")
        progress(0.10, "Installing Applio requirements (one time, several minutes)…", "")
        _stream([APPLIO_PY, "-m", "pip", "install", "-r", "requirements.txt"],
                APPLIO_DIR, emit, "install Applio requirements")
        APPLIO_DEPS_OK.touch()

    # Applio's CLI assumes its predictor/pretrained models exist but never
    # fetches them itself.
    if not (APPLIO_DIR / "rvc" / "models" / "predictors" / "rmvpe.pt").exists():
        progress(0.20, "Downloading Applio base models (one time)…", "")
        _stream([APPLIO_PY, "core.py", "prerequisites", "--models", "True",
                 "--pretraineds_hifigan", "True", "--exe", "False"],
                APPLIO_DIR, emit, "download Applio base models")

    # Applio's weight export reads assets/config.json but only its web UI
    # creates that file.
    assets_cfg = APPLIO_DIR / "assets" / "config.json"
    if not assets_cfg.exists():
        assets_cfg.parent.mkdir(parents=True, exist_ok=True)
        assets_cfg.write_text('{"model_author": null}')

    # -- the actual pipeline ----------------------------------------------
    steps = [
        (0.30, "1/4 preprocessing dataset",
         [APPLIO_PY, "core.py", "preprocess", "--model_name", safe_name,
          "--dataset_path", dataset, "--sample_rate", sample_rate,
          "--cut_preprocess", "Automatic"]),
        (0.45, "2/4 extracting features (RMVPE)",
         [APPLIO_PY, "core.py", "extract", "--model_name", safe_name,
          "--f0_method", "rmvpe", "--sample_rate", sample_rate,
          "--include_mutes", "2", "--cpu_cores", str(os.cpu_count() or 4)]),
        (0.55, f"3/4 training ({epochs} epochs — the long part)",
         [APPLIO_PY, "core.py", "train", "--model_name", safe_name,
          "--sample_rate", sample_rate, "--total_epoch", epochs,
          "--save_every_epoch", "25", "--save_only_latest", "True",
          "--save_every_weights", "True"]),
        (0.92, "4/4 building retrieval index",
         [APPLIO_PY, "core.py", "index", "--model_name", safe_name]),
    ]
    for frac, step_desc, cmd in steps:
        progress(frac, step_desc, "")
        _stream(cmd, APPLIO_DIR, emit, step_desc)

    # -- install the trained files into voice_models/ ---------------------
    progress(0.97, "Installing trained model…", "")
    logs_dir = APPLIO_DIR / "logs" / safe_name
    weights = [p for p in logs_dir.rglob("*.pth")
               if not p.name.startswith(("G_", "D_"))]
    if not weights:
        raise RuntimeError(f"Training finished but no weight file found in {logs_dir}.")
    newest = max(weights, key=lambda p: p.stat().st_mtime)
    shutil.copyfile(newest, MODELS_DIR / f"{safe_name}.pth")
    indexes = sorted(logs_dir.rglob("*.index"))
    for idx in indexes:
        shutil.copyfile(idx, MODELS_DIR / f"{safe_name}_{idx.name}")

    log.info("Training done — installed %s into %s", newest.name, MODELS_DIR)
    progress(1.0, "Done!", "")
    return {
        "model_name": safe_name,
        "pth": str(MODELS_DIR / f"{safe_name}.pth"),
        "indexes": len(indexes),
        "models": list_voice_models(),
    }
