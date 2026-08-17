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

## Built on top of that

Everything here reuses the pipeline above rather than adding another one.

**Batch.** Many songs, one voice, one queue, run in sequence because separation
and conversion each want the whole machine. A song that fails is reported
against itself and the queue carries on. `POST /api/batch`, one job, one event
stream.

**Suggested pitch.** `analysis.py` measures where a song's lead vocal sits and
where the chosen voice sits, and offers the interval between them. The song is
measured from its separated vocal when an earlier run left one behind, and from
a high-passed estimate off the mix otherwise. The voice is measured from its
training audio when it was trained here; a downloaded model has no audio
attached, so its range can be stated by hand from the voice's ⋯ menu. The song's
key is estimated too, with its runner-up, because a chroma-template key detector
is confidently wrong often enough to say so. Tempo is deliberately absent.

**Harmony and doubling.** Extra conversion passes at an interval, mixed under
the lead; a double is the same pitch nudged 18 ms late. The takes are recorded
in the manifest with their gain and delay, so a remix rebuilds the arrangement
without running the model again.

**Karaoke and stem export.** Separation already produced every stem, so both are
an encode away. The karaoke track becomes its own library item; a stem export
writes WAVs into a folder for a DAW.

**Projects.** A `.vocalis` file is a cover's decisions as a document — a few
hundred bytes, no audio, pointing at the song and naming the voice. Opening one
reports anything it refers to that is not on this machine instead of silently
substituting.

**Voice packs.** A `.vocalispack` is a zip of several voices with their indexes,
previews, portraits, declared ranges and licence. Installs are all-or-nothing
and roll back on failure; nothing in the archive is trusted before extraction.
Packs can be built from installed voices as well as installed.

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
