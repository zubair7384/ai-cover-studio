# Building & distributing AI Cover Studio (desktop)

This turns the Python/ML app into an installable **Electron desktop app** for
Windows and macOS. Users install it, upload a song, pick or train a voice, and
generate covers — all on their own machine. No Python, ffmpeg, or terminal
required on their side.

## How it's put together

```
Electron app (this desktop/ folder)
 ├─ main.js         spawns a bundled Python "sidecar" and opens the window
 ├─ preload.js      safe bridge for native file dialogs
 ├─ renderer/       the UI (HTML/CSS/JS) — talks to the sidecar over HTTP
 └─ runtime/        a self-contained Python + all ML deps (built by you)

Python sidecar (repo root)
 ├─ server.py       FastAPI server on 127.0.0.1, streams progress via SSE
 └─ engine.py       the actual pipeline (separate → clone → polish → mix) + training
```

The renderer never touches Python directly; it calls `http://127.0.0.1:<port>`
which the Electron main process starts and stops with the app.

## One-time: build the Python runtime

The installer bundles a **standalone Python** with PyTorch, RVC, HTDemucs, etc.
baked in. Build it on the OS you're targeting (you cannot cross-build this):

**macOS** (produces `desktop/runtime/`, ~2–3 GB):
```bash
cd desktop
bash scripts/prepare-runtime.sh
```

**Windows** (PowerShell):
```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File scripts\prepare-runtime.ps1
```

If the download 404s, the standalone-Python release tag has rotated — grab a
current one from
<https://github.com/astral-sh/python-build-standalone/releases> and pass it:
`PBS_TAG=YYYYMMDD PY_VERSION=3.10.x bash scripts/prepare-runtime.sh`.

## Build the installers

```bash
cd desktop
npm install
npm run dist:mac     # → ../dist_installers/*.dmg   (run on a Mac)
npm run dist:win     # → ../dist_installers/*.exe   (run on Windows)
```

`electron-builder` bundles (see `build.extraResources` in `package.json`):
`engine.py`, `server.py`, `runtime/`, the `Applio` trainer source (minus its
venv/logs/git), and the cached HTDemucs weights in `.separator_models`.

Expect a **large** output — bundling the ML runtime + weights offline is
6–10 GB per installer. That's the cost of the "works with zero setup, fully
offline" choice.

## What's fully offline vs. not

| Feature | First run | After first run |
|---|---|---|
| **Convert / cover generation** | ✅ fully offline (weights bundled) | ✅ offline |
| **Import a `.pth` model** | ✅ offline | ✅ offline |
| **Train a new voice** | ⚠️ see below | ✅ offline |

**Training caveat (important):** the trainer is [Applio](https://github.com/IAHispano/Applio),
which insists on its own Python 3.11+ environment (the RVC inference stack needs
3.10 — they can't share one). The app bundles Applio's *source* offline, but the
**first** training run still:
1. builds Applio's virtualenv (needs a system **Python 3.11+** on the machine), and
2. downloads Applio's ~2 GB pretrained base models (needs **internet once**).

After that first successful train, training is offline. Making training *fully*
offline + zero-dependency means bundling a second Python runtime and pre-built
Applio deps (~5 GB more, per platform) — a worthwhile phase-2 but not in v1.
The UI already warns users about this and about slow CPU-only training.

## Code signing (so users don't see scary warnings)

Unsigned apps still run, but the OS warns ("unidentified developer" /
SmartScreen). To ship cleanly:

- **macOS** — join the Apple Developer Program ($99/yr), then set
  `CSC_LINK`/`CSC_KEY_PASSWORD` and notarization creds (`APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) before `npm run dist:mac`.
  `hardenedRuntime` is already enabled in `package.json`.
- **Windows** — buy a code-signing certificate (~$100–400/yr) and point
  `electron-builder` at it via `CSC_LINK`/`CSC_KEY_PASSWORD`.

## GPU builds

Defaults ship CPU inference (`audio-separator[cpu]`). For an NVIDIA build, edit
`requirements-desktop.txt` to `audio-separator[gpu]`, install a CUDA PyTorch
wheel into `runtime/`, then rebuild. The app auto-detects CUDA at runtime and
shows a ⚡ badge; otherwise it runs on CPU (and, on Apple Silicon, MPS where safe).

## Icons

Drop `icon.icns` (mac) and `icon.ico` (win) into `desktop/build/`.
electron-builder picks them up automatically.

## Development (no packaging)

```bash
cd desktop
npm install
npm run dev          # spawns ../.venv Python + opens the window
```
Requires the repo's `.venv` with `requirements-desktop.txt` installed.
