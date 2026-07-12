#!/usr/bin/env bash
#
# prepare-runtime.sh — build the relocatable Python runtime that ships inside
# the macOS (and Linux) AI Cover Studio app. Run this ON A MAC before
# `npm run dist:mac`.
#
# It downloads a standalone CPython from astral-sh/python-build-standalone,
# extracts it to desktop/runtime/, then pip-installs requirements-desktop.txt
# into it. main.js launches desktop/runtime/bin/python3 at runtime.
#
# Usage:   bash scripts/prepare-runtime.sh
# Override the interpreter build with env vars if the defaults 404 (check the
# releases page https://github.com/astral-sh/python-build-standalone/releases):
#   PBS_TAG=20250612 PY_VERSION=3.10.18 bash scripts/prepare-runtime.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # desktop/
REPO="$(cd "$HERE/.." && pwd)"                     # repo root
RUNTIME="$HERE/runtime"

# --- pick the standalone build ------------------------------------------------
PBS_TAG="${PBS_TAG:-20250612}"                     # release tag; bump if 404
PY_VERSION="${PY_VERSION:-3.10.18}"                # 3.10/3.11 for the RVC stack

case "$(uname -m)" in
  arm64|aarch64) ARCH="aarch64" ;;
  x86_64)        ARCH="x86_64" ;;
  *) echo "Unsupported arch $(uname -m)"; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) PLATFORM="apple-darwin" ;;
  Linux)  PLATFORM="unknown-linux-gnu" ;;
  *) echo "Run this on macOS or Linux."; exit 1 ;;
esac

FILE="cpython-${PY_VERSION}+${PBS_TAG}-${ARCH}-${PLATFORM}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${FILE}"

echo "==> Downloading standalone Python:"
echo "    $URL"
rm -rf "$RUNTIME" "$HERE/.rt_tmp"
mkdir -p "$HERE/.rt_tmp"
curl -fL "$URL" -o "$HERE/.rt_tmp/python.tar.gz"
tar -xzf "$HERE/.rt_tmp/python.tar.gz" -C "$HERE/.rt_tmp"
# The archive extracts to a top-level "python/" dir; relocate to runtime/.
mv "$HERE/.rt_tmp/python" "$RUNTIME"
rm -rf "$HERE/.rt_tmp"

PY="$RUNTIME/bin/python3"
echo "==> Bundled interpreter: $($PY --version)"

echo "==> Installing desktop requirements into the runtime (this is large)…"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r "$REPO/requirements-desktop.txt"

echo "==> Verifying bundled imports…"
"$PY" -c "import torch, torchaudio, audio_separator, rvc_python, pedalboard, pydub, fastapi, uvicorn, multipart; print('all imports OK')"

echo "==> Trimming caches to shrink the bundle…"
find "$RUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME" -type d -name "tests" -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> Runtime ready at: $RUNTIME"
du -sh "$RUNTIME" 2>/dev/null || true
echo "    Next: (from desktop/)  npm run dist:mac"
