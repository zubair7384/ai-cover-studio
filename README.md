# AI Cover Studio

Fully local AI song-cover generator built with Gradio.

## What it does

1. Separates an uploaded song into stems with HTDemucs via `audio-separator`.
2. Converts isolated vocals with an RVC voice model.
3. Applies light vocal polish with Pedalboard.
4. Mixes the converted vocals back over the instrumental and exports an MP3.

## Setup

Python 3.10 or 3.11 is recommended. `ffmpeg` must be installed on your system.

```bash
pip install -r requirements.txt
python app.py
```

Place trained RVC `.pth` files, plus optional `.index` files, in `voice_models/`.

Generated outputs, model files, datasets, downloaded separator weights, local virtualenvs, and the Applio trainer checkout are intentionally ignored by git.
