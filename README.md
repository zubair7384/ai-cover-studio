# AI Cover Studio

Fully local AI song-cover generator built with Gradio.

## What it does

0. Optionally fetches the song from a pasted link (yt-dlp), caching it in `downloads/`.
1. Separates an uploaded song into stems with HTDemucs via `audio-separator`.
2. Converts isolated vocals with an RVC voice model.
3. Applies light vocal polish with Pedalboard.
4. Mixes the converted vocals back over the instrumental and exports an MP3.

Steps 1–3 are the expensive ones, so the intermediate audio is kept and recorded
in the manifest. Two things follow: a re-run of the same song at a different
pitch skips step 1, and the balance, speed and format of a finished cover can be
changed by redoing step 4 alone — no model run, about a second.

## Setup

Python 3.10 or 3.11 is recommended. `ffmpeg` must be installed on your system.

```bash
pip install -r requirements.txt
python app.py
```

Place trained RVC `.pth` files, plus optional `.index` files, in `voice_models/`.

Link fetching depends on `yt-dlp`, whose extractors break whenever a site changes.
If a link that plays in a browser won't fetch, update it first: `pip install -U yt-dlp`.
Downloading from a site you don't have the rights to is your call, not the tool's.

Generated outputs, model files, datasets, downloaded separator weights, local virtualenvs, and the Applio trainer checkout are intentionally ignored by git.
