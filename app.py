"""
AI Cover Studio — fully local AI song-cover generator.

Pipeline:
  1. Separate the uploaded song into stems with HTDemucs (via audio-separator).
  2. Convert the isolated vocals with an RVC voice model (rvc-python, RMVPE pitch).
  3. Polish the cloned vocals with Pedalboard (compression, reverb, delay).
  4. Overlay vocals onto the instrumental with pydub and export final_cover.mp3.

Install (Python 3.10/3.11 recommended, ffmpeg required on PATH):

    pip install torch torchaudio
    pip install gradio rvc-python "audio-separator[cpu]" pedalboard pydub
    # NVIDIA GPU instead:  pip install "audio-separator[gpu]"
    # macOS:               brew install ffmpeg
    # Debian/Ubuntu:       sudo apt install ffmpeg

Run:

    python app.py

Place your trained RVC voice models (.pth, plus optional .index) inside the
./voice_models directory next to this file. First launch downloads the
HTDemucs weights and the RMVPE pitch model automatically (~1 GB, one time).

Everything runs on your own machine; no paid APIs are called.
Only convert voices you have the rights/consent to use.
"""

import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import deque
from pathlib import Path

import gradio as gr

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("ai-cover-studio")

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "voice_models"      # your trained RVC .pth/.index files
OUTPUT_DIR = BASE_DIR / "outputs"           # final covers land here
SEPARATOR_MODEL_DIR = BASE_DIR / ".separator_models"  # cached HTDemucs weights
DATASETS_DIR = BASE_DIR / "training_datasets"  # drag-and-dropped voice samples

for d in (MODELS_DIR, OUTPUT_DIR, SEPARATOR_MODEL_DIR, DATASETS_DIR):
    d.mkdir(parents=True, exist_ok=True)

SAMPLE_RATE_CHOICES = ["32000", "40000", "48000"]


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


def _allow_legacy_torch_load() -> None:
    """
    torch >= 2.6 defaults torch.load to weights_only=True, which rejects the
    fairseq/RVC checkpoints (hubert_base.pt, rmvpe.pt, voice .pth) this app
    loads. They are local files the user chose to install, so restore the
    legacy behavior unless a caller explicitly opts in to weights_only.
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


_allow_legacy_torch_load()

# HTDemucs checkpoint as packaged by audio-separator. The fine-tuned bag
# (htdemucs_ft) runs 4 models and is ~4x slower — only worth it on a GPU;
# on CPU the single-model htdemucs is close in quality and far faster.
DEMUCS_MODEL = "htdemucs_ft.yaml" if DEVICE.startswith("cuda") else "htdemucs.yaml"


# ---------------------------------------------------------------------------
# Voice-model discovery
# ---------------------------------------------------------------------------
def list_voice_models() -> list[str]:
    """Names of every .pth model found in ./voice_models."""
    return sorted(p.stem for p in MODELS_DIR.glob("*.pth"))


def resolve_model_paths(model_name: str) -> tuple[Path, Path | None]:
    """Return (.pth path, matching .index path or None) for a model name."""
    pth = MODELS_DIR / f"{model_name}.pth"
    if not pth.exists():
        raise FileNotFoundError(
            f"Model '{model_name}' not found in {MODELS_DIR}. "
            "Drop the .pth file there and press Refresh."
        )
    index = next(iter(MODELS_DIR.glob(f"{model_name}*.index")), None)
    return pth, index


# ---------------------------------------------------------------------------
# Step 1 — stem separation (HTDemucs via audio-separator)
# ---------------------------------------------------------------------------
def separate_track(song_path: str, work_dir: Path) -> tuple[Path, Path]:
    """
    Split the song into vocals.wav and instrumental.wav.

    HTDemucs emits four stems (Vocals / Drums / Bass / Other); the three
    non-vocal stems are summed back together to form the instrumental.
    """
    from audio_separator.separator import Separator
    from pydub import AudioSegment

    log.info("Loading separator model '%s' …", DEMUCS_MODEL)
    separator = Separator(
        log_level=logging.INFO,   # surfaced in the UI's live status panel
        model_file_dir=str(SEPARATOR_MODEL_DIR),
        output_dir=str(work_dir),
        output_format="WAV",
    )
    separator.load_model(model_filename=DEMUCS_MODEL)

    log.info("Separating stems (this is the slowest step) …")
    outputs = separator.separate(song_path)

    # audio-separator may return bare filenames or absolute paths.
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

    pth_path, index_path = resolve_model_paths(model_name)
    log.info(
        "Loading RVC model '%s' on %s (index: %s)",
        pth_path.name, DEVICE, index_path.name if index_path else "none",
    )

    # rvc-python force-selects MPS whenever torch reports it, ignoring the
    # device argument — and its RMVPE code segfaults on MPS with torch >= 2.6.
    # Hide MPS while the engine captures its device config, then restore so
    # other libraries (e.g. audio-separator) can still use the Apple GPU.
    import torch
    orig_mps_available = torch.backends.mps.is_available
    torch.backends.mps.is_available = lambda: False
    try:
        rvc = RVCInference(device=DEVICE)

        # Older/newer rvc-python releases differ on whether load_model accepts
        # an explicit index path, so try the richer signature first.
        try:
            rvc.load_model(str(pth_path), index_path=str(index_path or ""))
        except TypeError:
            rvc.load_model(str(pth_path))
    finally:
        torch.backends.mps.is_available = orig_mps_available

    rvc.set_params(
        f0method="rmvpe",          # RMVPE pitch extraction, as requested
        f0up_key=pitch_shift,      # semitones (e.g. +12 male song -> female voice)
        index_rate=index_rate,     # how strongly the .index shapes the timbre
        protect=0.33,              # guards breaths/consonants from artifacts
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
        HighpassFilter(cutoff_frequency_hz=90),                # clear rumble
        Compressor(threshold_db=-16, ratio=2.5,
                   attack_ms=8, release_ms=120),               # even dynamics
        Reverb(room_size=0.18, damping=0.55,
               wet_level=0.12, dry_level=0.88, width=0.9),     # gentle space
        Delay(delay_seconds=0.22, feedback=0.12, mix=0.07),    # subtle slap
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
    """Overlay the polished vocals on the instrumental, export 320k MP3."""
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
# Full pipeline (wired to the "Generate Cover" button)
# ---------------------------------------------------------------------------
class _TailLogHandler(logging.Handler):
    """Feeds log records from the whole process into a deque for the UI."""

    def __init__(self, tail: deque):
        super().__init__(level=logging.INFO)
        self.tail = tail

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if not record.name.startswith(("httpx", "httpcore", "urllib3")):
                self.tail.append(record.getMessage())
        except Exception:
            pass


def _run_live(fn, args, make_panel):
    """
    Run fn(*args) in a worker thread; yield UI updates ~1/s while it works.
    Returns fn's result (via `yield from`), re-raises its exception.
    """
    holder: dict = {}

    def target():
        try:
            holder["value"] = fn(*args)
        except BaseException as exc:  # surfaced in the caller
            holder["error"] = exc

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    while thread.is_alive():
        yield make_panel()
        thread.join(timeout=1.0)
    if "error" in holder:
        raise holder["error"]
    return holder["value"]


def _cache_size_mb() -> float:
    return sum(f.stat().st_size for f in SEPARATOR_MODEL_DIR.rglob("*")
               if f.is_file()) / 1e6


def generate_cover(
    model_name: str,
    song_path: str,
    pitch_shift: int,
    index_rate: float,
    vocal_gain_db: float,
    progress: gr.Progress = gr.Progress(),
):
    if not model_name:
        raise gr.Error("Select a voice model first (drop a .pth into ./voice_models and press Refresh).")
    if not song_path:
        raise gr.Error("Upload a song (.mp3 or .wav) first.")

    work_dir = Path(tempfile.mkdtemp(prefix="cover_", dir=OUTPUT_DIR))
    log.info("=== New cover job: model=%s song=%s ===", model_name, song_path)

    tail: deque = deque(maxlen=12)
    handler = _TailLogHandler(tail)
    logging.getLogger().addHandler(handler)
    start = time.monotonic()
    current = {"step": "", "note": ""}

    def panel():
        elapsed = int(time.monotonic() - start)
        body = "\n".join(tail) or "(working …)"
        cache = (f" · model cache **{_cache_size_mb():.0f} MB** downloaded"
                 if current.get("show_cache") else "")
        return gr.update(), (
            f"### ⏳ {current['step']}\n"
            f"Elapsed **{elapsed // 60}m {elapsed % 60:02d}s** · device **{DEVICE}**"
            f"{cache}{current['note']}\n\n```text\n{body}\n```"
        )

    def begin(frac, step, note="", show_cache=False):
        current.update(step=step, note=note, show_cache=show_cache)
        progress(frac, desc=step)
        log.info("--- %s ---", step)

    try:
        try:
            first_run = not any(SEPARATOR_MODEL_DIR.rglob("*.th"))
            begin(0.05, "Step 1/4 — separating vocals & instrumental (HTDemucs)",
                  note=("\n*First run downloads the separation model (~85 MB).*"
                        if first_run else ""),
                  show_cache=first_run)
            vocals, instrumental = yield from _run_live(
                separate_track, (song_path, work_dir), panel)
        except Exception:
            log.error("Stem separation failed:\n%s", traceback.format_exc())
            raise gr.Error("Stem separation failed — see terminal log for details.")

        try:
            begin(0.45, "Step 2/4 — cloning vocals with RVC (RMVPE)",
                  "\n*First run downloads the RMVPE pitch model (~180 MB).*")
            cloned = yield from _run_live(
                convert_vocals,
                (vocals, model_name, int(pitch_shift), float(index_rate), work_dir),
                panel)
        except Exception:
            log.error("Voice conversion failed:\n%s", traceback.format_exc())
            raise gr.Error("RVC voice conversion failed — see terminal log for details.")

        try:
            begin(0.8, "Step 3/4 — polishing vocals (reverb/delay)")
            polished = yield from _run_live(
                apply_vocal_effects, (cloned, work_dir), panel)
        except Exception:
            log.error("Effects processing failed:\n%s", traceback.format_exc())
            raise gr.Error("Pedalboard effects failed — see terminal log for details.")

        try:
            begin(0.92, "Step 4/4 — mixing & exporting MP3")
            final_path = yield from _run_live(
                mix_and_export, (polished, instrumental, float(vocal_gain_db)),
                panel)
        except Exception:
            log.error("Final mix failed:\n%s", traceback.format_exc())
            raise gr.Error("Final mixdown failed — is ffmpeg installed and on PATH?")

        progress(1.0, desc="Done!")
        total = int(time.monotonic() - start)
        yield str(final_path), (
            f"✅ Cover finished in **{total // 60}m {total % 60:02d}s** on "
            f"**{DEVICE}** — saved to `{final_path}`\n\n"
            f"Intermediate stems kept in `{work_dir}` for inspection."
        )

    except gr.Error:
        raise
    except Exception:
        log.error("Unexpected pipeline failure:\n%s", traceback.format_exc())
        raise gr.Error("Unexpected error — see terminal log for the full traceback.")
    finally:
        logging.getLogger().removeHandler(handler)


# ---------------------------------------------------------------------------
# Tab 2 — training guidance generator
# ---------------------------------------------------------------------------
TRAINING_INTRO = """
### How RVC voice-clone training works locally

`rvc-python` is an **inference** engine — training a new voice happens in the
open-source **RVC WebUI** (or the friendlier fork **Applio**), which downloads
the required pretrained base models (~2 GB) on first run. Once trained, you
copy the resulting `.pth` + `.index` into this app's `voice_models/` folder
and it appears in Tab 1.

**Dataset tips:** 10–30 minutes of clean, dry vocals (no reverb, no music),
sliced into short WAV clips, one speaker only. Use consented voices only.
"""


AUDIO_EXTS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".aiff", ".aif"}


def stage_uploaded_samples(files: list, safe_name: str) -> tuple[Path, int, int]:
    """Copy drag-and-dropped audio files into ./training_datasets/<name>/."""
    dest = DATASETS_DIR / safe_name
    dest.mkdir(parents=True, exist_ok=True)
    copied = skipped = 0
    for f in files or []:
        src = Path(getattr(f, "name", f))  # gr.File yields paths or file objects
        if src.suffix.lower() in AUDIO_EXTS:
            shutil.copyfile(src, dest / src.name)
            copied += 1
        else:
            skipped += 1
    log.info("Staged %d sample(s) into %s (%d non-audio skipped)",
             copied, dest, skipped)
    return dest, copied, skipped


def build_training_plan(sample_files: list, dataset_dir: str, model_name: str,
                        sample_rate: str, epochs: int) -> str:
    """Produce copy-pasteable local training commands for the user's samples."""
    model_name = (model_name or "").strip() or "my_voice"
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in model_name)

    upload_note = ""
    if sample_files:
        dest, copied, skipped = stage_uploaded_samples(sample_files, safe_name)
        if not copied:
            return ("⚠️ None of the uploaded files look like audio "
                    f"(supported: {', '.join(sorted(AUDIO_EXTS))}). "
                    "Drop .mp3/.wav voice clips and try again.")
        dataset_dir = str(dest)
        upload_note = (
            f"\n> 📥 **{copied} sample(s)** saved to `{dest}` — the commands "
            "below already point at that folder."
            + (f" ({skipped} non-audio file(s) ignored.)" if skipped else "")
            + "\n"
        )
    else:
        dataset_dir = (dataset_dir or "").strip() or "~/voice_dataset"

    return f"""{TRAINING_INTRO}
{upload_note}
---
### Your generated training plan for **{safe_name}**

**1. Install a trainer (one time):**
```bash
git clone https://github.com/IAHispano/Applio.git && cd Applio
pip install -r requirements.txt
```

**2. Train on your local sample folder** (`{dataset_dir}`):
```bash
# Preprocess your dataset
python core.py preprocess --model_name "{safe_name}" \\
    --dataset_path "{dataset_dir}" --sample_rate {sample_rate}

# Extract features (RMVPE pitch, same method used for inference here)
python core.py extract --model_name "{safe_name}" \\
    --f0_method rmvpe --sample_rate {sample_rate}

# Train ({epochs} epochs) and build the retrieval index
python core.py train --model_name "{safe_name}" \\
    --sample_rate {sample_rate} --total_epoch {epochs}
python core.py index --model_name "{safe_name}"
```

**3. Link the result to this app:**
```bash
cp Applio/logs/{safe_name}/{safe_name}.pth  "{MODELS_DIR}/"
cp Applio/logs/{safe_name}/*.index          "{MODELS_DIR}/"
```

**4. Quick CLI test with rvc-python (no UI needed):**
```bash
python -m rvc_python cli -i test_vocal.wav -o cloned.wav \\
    -mp "{MODELS_DIR}/{safe_name}.pth" --method rmvpe --device {DEVICE}
```

Then switch to **Tab 1**, press **🔄 Refresh**, and generate a cover.
"""


# ---------------------------------------------------------------------------
# One-click local training (Applio backend, run as subprocesses)
# ---------------------------------------------------------------------------
APPLIO_DIR = BASE_DIR / "Applio"
APPLIO_REPO = "https://github.com/IAHispano/Applio.git"
APPLIO_VENV = APPLIO_DIR / ".venv"
APPLIO_PY = APPLIO_VENV / "bin" / "python"
APPLIO_DEPS_OK = APPLIO_VENV / ".deps_ok"   # marker: requirements fully installed

_train_lock = threading.Lock()  # one training job at a time


def _applio_base_python() -> str:
    """
    Interpreter for Applio's own venv. Applio pins numpy>=2.4 which needs
    Python 3.11+, while this app itself must stay on 3.10 for fairseq.
    """
    for ver in ("3.12", "3.11", "3.13"):
        for cand in (shutil.which(f"python{ver}"),
                     f"/opt/homebrew/opt/python@{ver}/bin/python{ver}"):
            if cand and Path(cand).exists():
                return cand
    return sys.executable  # last resort; install may fail on numpy


def _stream(cmd: list, cwd: Path, tail: deque, desc: str):
    """Run a command, feeding stdout lines into `tail`; yield periodically."""
    cmd = [str(c) for c in cmd]
    log.info("[train] %s: %s", desc, " ".join(cmd))
    proc = subprocess.Popen(
        cmd, cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    last_update = 0.0
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            tail.append(line)
        if time.monotonic() - last_update > 0.4:  # throttle UI updates
            last_update = time.monotonic()
            yield
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"'{desc}' failed (exit code {proc.returncode}).")
    yield


def _resolve_training_dataset(sample_files, dataset_dir, safe_name):
    """Return (dataset Path, error message or None) from uploads or a folder."""
    if sample_files:
        dest, copied, _ = stage_uploaded_samples(sample_files, safe_name)
        if not copied:
            return None, ("⚠️ None of the uploaded files look like audio "
                          "(.mp3/.wav/.flac …). Drop voice clips and try again.")
        return dest, None
    dataset_dir = (dataset_dir or "").strip()
    if not dataset_dir:
        return None, ("⚠️ Drop voice samples above (or type an existing "
                      "folder path) before pressing Train.")
    ds = Path(dataset_dir).expanduser()
    if not ds.is_dir():
        return None, f"⚠️ Folder not found: `{ds}`."
    if not any(p.suffix.lower() in AUDIO_EXTS for p in ds.iterdir()):
        return None, f"⚠️ No audio files found in `{ds}`."
    return ds, None


def train_voice_model(sample_files, dataset_dir, model_name, sample_rate, epochs,
                      progress: gr.Progress = gr.Progress()):
    """
    Generator wired to the Train button: runs the full Applio pipeline
    (install → preprocess → extract → train → index) in subprocesses,
    streaming a status panel, then installs the result into voice_models/.
    """
    model_name = (model_name or "").strip() or "my_voice"
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in model_name)
    epochs = int(epochs)

    dataset, err = _resolve_training_dataset(sample_files, dataset_dir, safe_name)
    if err:
        yield err
        return

    if not _train_lock.acquire(blocking=False):
        yield "⚠️ A training job is already running — wait for it to finish."
        return

    tail: deque = deque(maxlen=18)

    def panel(step: str) -> str:
        body = "\n".join(tail) or "(waiting for output …)"
        return (
            f"### 🏋️ Training **{safe_name}** — {step}\n"
            f"Dataset: `{dataset}` · {epochs} epochs · {sample_rate} Hz · "
            f"device **{DEVICE}**\n\n"
            "```text\n" + body + "\n```"
        )

    try:
        # -- one-time Applio install --------------------------------------
        if not (APPLIO_DIR / "core.py").exists():
            if shutil.which("git") is None:
                yield "❌ git is required to install the Applio trainer (`brew install git`)."
                return
            progress(0.02, desc="Downloading Applio trainer (one time)…")
            yield panel("downloading Applio trainer (one time)…")
            yield from _stream(
                ["git", "clone", "--depth", "1", APPLIO_REPO, APPLIO_DIR],
                BASE_DIR, tail, "clone Applio",
            )
        if not APPLIO_DEPS_OK.exists():
            # A leftover venv without the marker is broken/incomplete
            # (e.g. built with the wrong Python) — rebuild from scratch.
            if APPLIO_VENV.exists():
                log.info("Removing incomplete Applio venv %s", APPLIO_VENV)
                shutil.rmtree(APPLIO_VENV)
            base_py = _applio_base_python()
            progress(0.06, desc="Creating Applio virtualenv…")
            yield panel(f"creating Applio virtualenv ({Path(base_py).name})…")
            yield from _stream(
                [base_py, "-m", "venv", APPLIO_VENV],
                APPLIO_DIR, tail, "create Applio venv",
            )
            if sys.platform == "darwin":
                # Applio's macOS pins conflict: antlr4==4.13.2 needs the
                # omegaconf 2.4 pre-release, which pip won't pick by itself.
                yield panel("pre-installing omegaconf pre-release (macOS pin workaround)…")
                yield from _stream(
                    [APPLIO_PY, "-m", "pip", "install", "--pre",
                     "omegaconf>=2.4.0.dev0", "antlr4-python3-runtime==4.13.2"],
                    APPLIO_DIR, tail, "pre-install omegaconf",
                )
            progress(0.10, desc="Installing Applio requirements (one time)…")
            yield panel("installing Applio requirements (one time, several minutes)…")
            yield from _stream(
                [APPLIO_PY, "-m", "pip", "install", "-r", "requirements.txt"],
                APPLIO_DIR, tail, "install Applio requirements",
            )
            APPLIO_DEPS_OK.touch()

        # -- the actual pipeline ------------------------------------------
        steps = [
            (0.30, "1/4 preprocessing dataset",
             [APPLIO_PY, "core.py", "preprocess", "--model_name", safe_name,
              "--dataset_path", dataset, "--sample_rate", sample_rate,
              "--cut_preprocess", "Automatic"]),
            (0.45, "2/4 extracting features (RMVPE)",
             [APPLIO_PY, "core.py", "extract", "--model_name", safe_name,
              "--f0_method", "rmvpe", "--sample_rate", sample_rate,
              "--include_mutes", "2",
              # Applio crashes on int('None') when --cpu_cores is omitted
              "--cpu_cores", str(os.cpu_count() or 4)]),
            (0.55, f"3/4 training ({epochs} epochs — the long part)",
             [APPLIO_PY, "core.py", "train", "--model_name", safe_name,
              "--sample_rate", sample_rate, "--total_epoch", epochs,
              "--save_every_epoch", "25", "--save_only_latest", "True",
              "--save_every_weights", "True"]),
            (0.92, "4/4 building retrieval index",
             [APPLIO_PY, "core.py", "index", "--model_name", safe_name]),
        ]
        for frac, step_desc, cmd in steps:
            progress(frac, desc=step_desc)
            yield panel(step_desc)
            yield from _stream(cmd, APPLIO_DIR, tail, step_desc)

        # -- install the trained files into voice_models/ ------------------
        progress(0.97, desc="Installing trained model…")
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
        progress(1.0, desc="Done!")
        yield (
            f"## ✅ Voice **{safe_name}** has been trained!\n\n"
            f"- Weights installed: `{MODELS_DIR / (safe_name + '.pth')}`\n"
            f"- Index files copied: {len(indexes)}\n\n"
            "Switch to **🎵 AI Vocal Swapper**, press **🔄 Refresh model list**, "
            "and generate a cover with your new voice."
        )

    except Exception as exc:
        log.error("Training failed:\n%s", traceback.format_exc())
        yield panel("❌ failed") + (
            f"\n\n**❌ Training failed:** {exc}\n"
            "Full traceback is in the terminal log."
        )
    finally:
        _train_lock.release()


# ---------------------------------------------------------------------------
# Gradio UI
# ---------------------------------------------------------------------------
def build_app() -> gr.Blocks:
    with gr.Blocks(title="AI Cover Studio", theme=gr.themes.Soft()) as app:
        gr.Markdown(
            f"""
# 🎤 AI Cover Studio
Local AI song covers — HTDemucs separation → RVC voice clone (RMVPE) →
Pedalboard polish → pydub mixdown. Running on **{DEVICE.upper()}**.
*Use only songs and voices you have the rights and consent to use.*
"""
        )

        with gr.Tabs():
            # ------------------------- Tab 1: inference -------------------
            with gr.Tab("🎵 AI Vocal Swapper"):
                with gr.Row():
                    with gr.Column(scale=1):
                        model_dd = gr.Dropdown(
                            choices=list_voice_models(),
                            label="Voice model (.pth in ./voice_models)",
                            info=f"Folder: {MODELS_DIR}",
                        )
                        refresh_btn = gr.Button("🔄 Refresh model list", size="sm")
                        song_in = gr.Audio(
                            label="Full song (.mp3 / .wav)",
                            type="filepath",
                            sources=["upload"],
                        )
                        pitch = gr.Slider(
                            -12, 12, value=0, step=1,
                            label="Pitch shift (semitones)",
                            info="+12 when covering a male song with a female voice; -12 for the reverse.",
                        )
                        index_rate = gr.Slider(
                            0.0, 1.0, value=0.75, step=0.05,
                            label="Index rate (timbre strength)",
                        )
                        vocal_gain = gr.Slider(
                            -10, 10, value=0, step=0.5,
                            label="Vocal level in mix (dB)",
                        )
                        go_btn = gr.Button("🎧 Generate Cover", variant="primary")

                    with gr.Column(scale=1):
                        cover_out = gr.Audio(
                            label="Final mixed cover",
                            type="filepath",
                            interactive=False,
                        )
                        status_md = gr.Markdown("")

                refresh_btn.click(
                    lambda: gr.update(choices=list_voice_models()),
                    outputs=model_dd,
                )
                go_btn.click(
                    generate_cover,
                    inputs=[model_dd, song_in, pitch, index_rate, vocal_gain],
                    outputs=[cover_out, status_md],
                )

            # ------------------------- Tab 2: training --------------------
            with gr.Tab("🧬 Voice Clone Training (Guide)"):
                gr.Markdown(TRAINING_INTRO)
                with gr.Row():
                    with gr.Column():
                        sample_files = gr.File(
                            label="Drag & drop your voice samples (.mp3 / .wav / .flac …)",
                            file_count="multiple",
                            file_types=["audio"],
                        )
                        ds_dir = gr.Textbox(
                            label="…or path to an existing sample folder",
                            placeholder="/Users/you/voice_dataset",
                            info="Ignored when files are dropped above.",
                        )
                        tr_name = gr.Textbox(label="New model name",
                                             placeholder="my_voice")
                        tr_sr = gr.Dropdown(SAMPLE_RATE_CHOICES, value="40000",
                                            label="Training sample rate")
                        tr_epochs = gr.Slider(50, 1000, value=300, step=50,
                                              label="Epochs")
                        train_btn = gr.Button("🚀 Train voice model",
                                              variant="primary")
                        gr.Markdown(
                            "*First run downloads the Applio trainer (~2 GB). "
                            f"Training on **{DEVICE}** "
                            + ("is fast." if DEVICE.startswith("cuda")
                               else "can take a long time — a GPU is strongly recommended.")
                            + "*"
                        )
                        plan_btn = gr.Button("📋 Just show me the commands",
                                             size="sm")
                    with gr.Column():
                        plan_out = gr.Markdown("")

                train_btn.click(
                    train_voice_model,
                    inputs=[sample_files, ds_dir, tr_name, tr_sr, tr_epochs],
                    outputs=plan_out,
                )
                plan_btn.click(
                    build_training_plan,
                    inputs=[sample_files, ds_dir, tr_name, tr_sr, tr_epochs],
                    outputs=plan_out,
                )

    return app


if __name__ == "__main__":
    if shutil.which("ffmpeg") is None:
        log.warning(
            "ffmpeg not found on PATH — pydub export will fail. "
            "Install it first (macOS: `brew install ffmpeg`)."
        )
    log.info("Voice models found: %s", list_voice_models() or "none yet")
    build_app().launch(server_name="127.0.0.1", inbrowser=True)
