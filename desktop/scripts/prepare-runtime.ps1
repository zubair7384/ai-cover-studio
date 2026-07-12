# prepare-runtime.ps1 — build the relocatable Python runtime that ships inside
# the Windows AI Cover Studio app. Run this ON WINDOWS before `npm run dist:win`.
#
# Downloads a standalone CPython from astral-sh/python-build-standalone, extracts
# it to desktop\runtime\, then pip-installs requirements-desktop.txt into it.
# main.js launches desktop\runtime\python.exe at runtime.
#
# Usage:   powershell -ExecutionPolicy Bypass -File scripts\prepare-runtime.ps1
# Override if the default URL 404s (see the releases page):
#   $env:PBS_TAG="20250612"; $env:PY_VERSION="3.10.18"; .\scripts\prepare-runtime.ps1
$ErrorActionPreference = "Stop"

$Here    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # desktop\
$Repo    = Split-Path -Parent $Here                                              # repo root
$Runtime = Join-Path $Here "runtime"

$PbsTag    = if ($env:PBS_TAG)    { $env:PBS_TAG }    else { "20250612" }
$PyVersion = if ($env:PY_VERSION) { $env:PY_VERSION } else { "3.10.18" }

$File = "cpython-$PyVersion+$PbsTag-x86_64-pc-windows-msvc-install_only.tar.gz"
$Url  = "https://github.com/astral-sh/python-build-standalone/releases/download/$PbsTag/$File"

Write-Host "==> Downloading standalone Python:`n    $Url"
if (Test-Path $Runtime) { Remove-Item -Recurse -Force $Runtime }
$Tmp = Join-Path $Here ".rt_tmp"
if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp }
New-Item -ItemType Directory -Path $Tmp | Out-Null

Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Tmp "python.tar.gz")
# tar ships with Windows 10+; extracts a top-level "python\" dir.
tar -xzf (Join-Path $Tmp "python.tar.gz") -C $Tmp
Move-Item (Join-Path $Tmp "python") $Runtime
Remove-Item -Recurse -Force $Tmp

$Py = Join-Path $Runtime "python.exe"
Write-Host "==> Bundled interpreter:"
& $Py --version

Write-Host "==> Installing desktop requirements into the runtime (this is large)…"
# rvc-python's transitive pins (numpy<=1.23.5, faiss-cpu==1.7.3, omegaconf==2.0.6)
# are mutually inconsistent with audio-separator/torch under a strict resolver, yet
# the *installed* set works fine at runtime — it's the same state a working dev
# machine converges to. Reproduce it exactly from the lockfile with --no-deps so no
# resolution happens. pip 24.0 is used because 24.1+ rejects omegaconf 2.0.6's
# non-standard 'PyYAML>=5.1.*' specifier ("no matching distribution").
# PowerShell's call operator does NOT throw on non-zero native exit codes, so
# every pip call is followed by an explicit $LASTEXITCODE check.
& $Py -m pip install "pip==24.0"
if ($LASTEXITCODE -ne 0) { throw "pip pin to 24.0 failed (exit $LASTEXITCODE)" }

# fairseq has no Windows wheel; it compiles from sdist and needs these at build time.
& $Py -m pip install setuptools wheel "cython<3" "numpy==2.2.6"
if ($LASTEXITCODE -ne 0) { throw "build-prereq install failed (exit $LASTEXITCODE)" }

& $Py -m pip install --no-deps --no-build-isolation -r (Join-Path $Repo "requirements-desktop.lock.txt")
if ($LASTEXITCODE -ne 0) { throw "locked requirements install failed (exit $LASTEXITCODE)" }

# Fail the build here (not three steps later) if any critical import is missing.
Write-Host "==> Verifying bundled imports…"
& $Py -c "import torch, torchaudio, audio_separator, rvc_python, fairseq, pedalboard, pydub, fastapi, uvicorn, multipart; print('all imports OK')"
if ($LASTEXITCODE -ne 0) { throw "bundled runtime is missing required modules" }

Write-Host "==> Trimming caches…"
Get-ChildItem -Path $Runtime -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "==> Runtime ready at: $Runtime"
Write-Host "    Next: (from desktop\)  npm run dist:win"
