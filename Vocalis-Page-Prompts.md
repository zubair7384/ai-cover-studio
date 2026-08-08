# Vocalis — Build Prompts

Run these in order in Claude Code. Each is self-contained; paste one at a time and let it
finish before moving on. **Prompt 0 is mandatory first** — everything else depends on it.

Keep `Vocalis-Design-System.md` in the repo root and refer to it in every prompt.

---

## Prompt 0 — Foundation (tokens, base, shell primitives)

```
Read Vocalis-Design-System.md in the repo root. It is the authority for this project;
follow it exactly and do not improvise colours, radii, or type sizes.

Build the styling foundation for this Electron + React app:

1. src/styles/tokens.css — every value from sections 3–7 of the design system as CSS
   custom properties on :root (dark mode is the default), plus a [data-theme="light"]
   block overriding the neutrals and text colours. Include the elevation, radius,
   spacing, control-height, duration and easing tokens.

2. src/styles/base.css — modern reset; html/body set to --font-ui at 13px/18px with
   -webkit-font-smoothing: antialiased; ::selection in --am-tint; overlay scrollbars
   styled to --gr-600 with a transparent track; a :focus-visible rule applying the amber
   focus ring globally; utilities .drag-region { -webkit-app-region: drag } and
   .no-drag; a .tabular utility applying --font-mono + font-variant-numeric: tabular-nums;
   and @media blocks for prefers-reduced-motion and prefers-reduced-transparency.

3. src/components/primitives/ — Button (primary/secondary/tertiary/destructive, sizes
   sm/md/lg, loading state, icon slot), IconButton, TextField, Select, Slider, Toggle,
   Checkbox, Badge, Tooltip, Popover, Sheet, ContextMenu, Separator, EmptyState,
   Spinner. All keyboard-accessible, all using tokens only. No hardcoded hex anywhere
   outside tokens.css.

4. src/components/meter/ — the signature component family from section 6:
   MeterBar (determinate + indeterminate), MeterSegments, Waveform (canvas-based,
   segmented bars, amber played / graphite unplayed, 1px playhead, click and drag to
   scrub, keyboard ←/→ nudge), and Pipeline (ordered stages with pending/running/done/
   failed states, hairline connector that fills amber, mono duration per completed stage).
   Every meter accepts a mono readout string.

5. Update the Electron BrowserWindow config to exactly the object in section 5, and add
   an IPC channel for setProgressBar.

Also build a /styleguide route rendering every primitive and meter in every state, in
both themes, so I can review the system in one screen. Verify contrast ratios as you go.
Do not build any app pages yet.
```

---

## Prompt 1 — App shell (window chrome, sidebar, toolbar, player bar)

```
Read Vocalis-Design-System.md, sections 5, 6, 8 and 9. Build the app shell.

Window chrome: hidden-inset title bar, traffic lights at x:18 y:20, the top 52px of both
sidebar and content is a drag region with interactive controls marked .no-drag.

Sidebar (220px, resizable 180–320, width persisted to disk, toggle with ⌃⌘S):
- Uses the macOS 'sidebar' vibrancy material. Falls back to solid --gr-850 under
  prefers-reduced-transparency.
- Wordmark row at top: 16px waveform glyph in --am-500 + "Vocalis" in head weight +
  a small "v3" badge in --gr-750. No gradient.
- Section header "Library" in the label token — Title Case, 11px semibold, NOT all-caps
  and not letterspaced.
- Rows: Covers (⌘1), Voices (⌘2). 28px tall, 6px radius, 16px icon + 13px label,
  hover --gr-800, selected --am-tint with the label in body-em and the icon in --am-500.
- An "Activity" section that only mounts while a job is running: one row per job showing
  a 14px circular MeterBar, the job name, and the percentage in mono. Clicking it opens
  that job's view.
- Bottom: account row with a flat --gr-700 circular avatar (initial in --gr-200 — remove
  the pink/purple gradient), name in body-em, email in caption, and a small gear
  IconButton that opens the Settings window.

Content toolbar (52px): view title on the left in title-1; on the right, a search field
(28px, --gr-750, magnifier icon, ⌘F focuses it, Esc clears) and the view's primary
actions. A 1px bottom hairline that fades in only once the content area is scrolled.

Player bar (48px, docked to the bottom of the content area, mounts only when a cover is
loaded): play/pause IconButton, title + voice stacked, a flexible Waveform scrubber, an
"Original / Cover" segmented A/B toggle that crossfades between the two audio sources at
the same playhead position, mono time readout "0:42 / 3:17", volume popover, and an
Export IconButton. Space toggles playback globally unless a text field has focus.

Routing: default route is /covers. New Cover and Train a Voice push a full-view flow over
the library with a Cancel action in the toolbar and Esc to exit (with a confirm sheet if
work would be lost). Delete the Home route entirely.

Build the full menu bar and keyboard shortcuts listed in section 9.
```

---

## Prompt 2 — Covers (library, launch view)

```
Read Vocalis-Design-System.md. Rebuild the Covers view. The current version is a table of
raw filenames with an empty Voice column — that is the core problem to solve.

Data model first: every cover must persist { id, title, sourceFileName, voiceId, voiceName,
createdAt, durationSec, sizeBytes, pitchShift, voiceCharacter, sourcePath, outputPath }.
Write a one-time migration that backfills existing covers by parsing timestamps out of
final_cover_YYYYMMDD_HHMMSS.mp3 filenames and marking voice as "Unknown". Never show a
raw generated filename as a title.

Layout — a list, not a table:
- Rows 56px: a 40×40 rounded-8 tile holding a static mini-waveform thumbnail in --gr-500;
  then the title in body-em (derived from the source song name, e.g. "Tu Hai Tu"), and a
  caption line "zub · 3:17 · 17 Jul 2026". Right side, revealed on hover or selection:
  Play, Export, and a "…" menu.
- Rows group under sticky date headers: Today / Yesterday / This Week / July 2026.
- Selecting a row loads it into the player bar. ↩ or double-click opens the detail sheet.
- Multi-select with ⇧ and ⌘; when 2+ are selected the toolbar swaps to
  "3 selected · Export… · Delete", and the row area shows a selection count.
- Full drag-out to Finder for one or many rows.
- Right-click menu: Play, Show in Finder, Get Info, Export…, Rename, Delete.
- Space triggers Quick Look on the selected row.

Toolbar: search (filters title, voice and source filename live), a sort Select
(Newest / Oldest / Song / Voice), and a primary "New Cover" button.

Detail sheet (⌘I or Get Info): large waveform with A/B, the full parameter set used
(pitch shift, voice character, model, sample rate) in mono, file size and path with a
"Show in Finder" link, and a "Make another with these settings" button that opens New
Cover pre-filled. This is the payoff for storing the metadata.

Empty state: waveform icon, "No covers yet", "Pick a song and a voice, and Vocalis does
the rest.", primary button "New Cover".

Deleting shows a confirm sheet naming the cover, with a "Also move the file to Trash"
checkbox, defaulted on.
```

---

## Prompt 3 — Voices (library)

```
Read Vocalis-Design-System.md. Rebuild the Voices view (currently "My Voices").

Replace the three gradient cards with a list matching Covers, at 60px row height:
- 40×40 rounded-8 tile: a flat --gr-750 fill with the voice's initial in --gr-200. No
  gradients.
- Title in body-em. Caption line: "Trained 10 Jul 2026 · 40 kHz · 64.5 MB".
- A Badge for pitch index state — replace the jargon: "Pitch index ready" in --ok-300, or
  "No pitch index" in --gr-400, each with a tooltip: "A pitch index improves accuracy on
  fast or slurred phrases. You can build one from the … menu."
- Hover/selection reveals: Preview (▶), "Use in a cover", and a "…" menu.

Preview is the most important addition: each model stores a short generated sample
(generate one after training, and offer "Create a preview" in the … menu for imported
models). Preview plays inline in the row with a compact Waveform — do not open the player
bar for it.

"…" menu: Use in a cover, Create/Rebuild pitch index, Rename, Show in Finder, Export
model…, Delete. Deletion warns if covers reference this model and lists how many.

Toolbar: search, a sort Select (Recent / Name / Size), an "Import…" secondary button, and
a primary "Train a Voice" button.

Empty state: "No voices yet", "Train one from 10–30 minutes of your own clean vocals, or
import an RVC .pth file you already have.", with both buttons.

Add a persistent, quiet footer line above the list: "3 voices · 229.9 MB · stored on this
Mac" in caption. That is the honest, useful version of the stat cards being deleted from
Home.
```

---

## Prompt 4 — New Cover (was Vocal Swapper)

```
Read Vocalis-Design-System.md. Rebuild the cover-generation flow as a full-view push over
the library, not a sidebar page. Fix these specific bugs from the old build: the sticky
CTA overlapping and clipping the parameter text, and the giant empty "Final mixed cover"
panel that occupies half the screen before anything runs.

Toolbar: "Cancel" on the left, title "New Cover", "Generate" primary button on the right,
disabled with a tooltip explaining which input is missing.

Main column — the flow reads top to bottom as three states of one object:

1. SONG. Before a file: a 160px drop zone, hairline dashed --gr-600 border, headphone
   icon, "Drop a song here, or choose a file", caption "MP3, WAV, FLAC or M4A". Amber
   border and --am-tint fill on drag-over. Accept drops anywhere in the view, not only
   the zone. After a file: the zone collapses to a 72px row — waveform, title, duration,
   sample rate, and a "Replace" tertiary button.

2. VOICE. A 44px row acting as a picker button: avatar tile, voice name, pitch-index
   badge, chevron. Opens a popover listing the voices with inline preview buttons, and a
   footer link "Train a new voice". Auto-select the most recently used voice — the old
   build shipped an empty "Select a voice model" dropdown while stating "3 voice models
   available", which is a dead end.

3. RESULT. Renders nothing at all until a run starts — no empty panel. On start it becomes
   the Pipeline component (Separating vocals → Converting → Mixing) with a live MeterBar,
   elapsed and estimated-remaining in mono, per-stage durations as each completes, and a
   Cancel button. On completion it becomes the result player: full Waveform, the A/B
   Original/Cover toggle, Play, "Save to…", and "Adjust and run again" which keeps the
   parameters and returns to the top.

Inspector (right, 280px, ⌥⌘I to toggle, open by default) holds ALL parameters — this is
what fixes the CTA overlap, because nothing sticky sits over scrolling text any more:
- Pitch shift: slider −12…+12, mono value badge "0 st", tick marks at −12/0/+12, and
  helper text "+12 to sing a man's part in a woman's voice; −12 for the reverse."
- Voice character (renamed from "Timbre strength"): 0…1, default 0.75, "Higher stays
  closer to your voice; lower keeps more of the original singer."
- Pitch index strength, disabled with an explanation when the model has no index.
- Output format Select (MP3 320 / WAV 24-bit / FLAC).
- A "Reset to defaults" tertiary button at the bottom.
- Collapsed disclosure "Advanced" for anything else.

Background behaviour: the run continues if I navigate away; it appears in the sidebar
Activity section, drives the Dock progress bar, and fires a native notification when done
that opens the finished cover. On failure, show the failing stage in red with a plain
explanation and a "Try again" button — never a raw stack trace in the UI (put that behind
a "Copy details" button).
```

---

## Prompt 5 — Train a Voice (was Voice Cloning)

```
Read Vocalis-Design-System.md. Rebuild voice training as a full-view push. The old build
stacked two dismissible banners across the top, offered a bare 0–1000 epoch slider for a
1–3 hour commitment, and showed a large empty log box before training started. Fix all
three.

Toolbar: "Cancel", title "Train a Voice", primary "Start training" on the right.

Main column:

1. RECORDINGS. Drop zone, same pattern as New Cover, accepting files or a folder. Once
   files are added it becomes a compact list — filename, duration, sample rate, remove
   button — with a header row above it carrying the key feedback: a MeterSegments bar
   showing total material against the healthy 10–30 minute range, with the target band
   marked on the track, and a mono readout "14 min 20 s of 10–30 min". The bar is amber
   inside the range, --gr-500 below it, and shows a caption "More than 30 min rarely
   helps" above it. Flag any clip that looks unusable (very short, wrong sample rate,
   probable background music) with an inline warning icon and a one-line reason.
   Replace the "Dataset tips" banner with a small "What makes a good recording?" popover
   trigger next to the section header.

2. MODEL. Name TextField (validated: no spaces or slashes, must be unique, live inline
   error) and a Sample rate Select with the caption "40 kHz suits singing. Use 48 kHz only
   if all your recordings are 48 kHz."

3. QUALITY. Replace the raw epoch slider with three preset cards in a row —
   Quick (150 epochs) / Balanced (300) / High (500) — each showing its estimated wall-clock
   time on this machine in mono and a one-line description of the tradeoff. Selected card
   gets the amber border and --am-tint. Below them, a collapsed "Set epochs manually"
   disclosure containing the slider. Directly above the Start button, inline (not a
   banner): "About 55 min on this Mac. Training uses the CPU — you can keep using Vocalis,
   but other apps may feel slower."

Right panel — replace the empty log box with a live training panel that only mounts once
training starts:
- Large MeterBar with mono "epoch 118 / 300" and "elapsed 21:04 · about 34 min left".
- A small loss sparkline in --am-500 on --gr-950, so progress is legible without reading
  the log.
- The log itself inside a collapsed disclosure "Show log", monospaced 11px on --gr-950,
  with a "Follow" toggle and "Copy" button.
- Pause and Cancel buttons; cancelling asks whether to keep the checkpoint.

Background behaviour: training survives navigation, appears in sidebar Activity, drives
the Dock progress bar, prevents sleep via powerSaveBlocker, and posts a native
notification on completion whose action opens the new voice in the Voices view. On
completion the panel offers "Create a preview clip" and "Use in a cover".
```

---

## Prompt 6 — Settings (separate window)

```
Read Vocalis-Design-System.md. Move Settings out of the sidebar into its own Electron
window, macOS-style: opened by ⌘, and by the sidebar gear, non-resizable width 620,
height sized to the active tab, title bar showing the active tab name, and a native
segmented toolbar with four tabs.

General
- Profile: 48px flat avatar, Name TextField, "Choose photo…" / "Remove photo". Save
  automatically on blur — remove the explicit "Save profile" button and show a brief
  "Saved" caption instead.
- Appearance: Theme segmented control (System / Light / Dark).
- Checkbox "Use the system accent colour instead of amber."
- Checkbox "Notify me when a cover or training finishes."

Audio
- Default sample rate Select.
- Default output format Select.
- Default quality preset Select (Quick / Balanced / High).
- Default export folder: path field + "Choose…" + a "Ask every time" checkbox.

Storage
- Grouped rows with mono values on the right: Voice models 229.9 MB · Generated covers
  (22) 177.1 MB · Total. Each with a MeterBar showing its share of the total — the Meter
  language applied one more time.
- Storage location with a "Show in Finder" link and a "Change…" button that offers to move
  existing data.
- "Delete all generated covers" as a destructive tertiary button, which opens a confirm
  sheet stating the exact count and size freed and requiring a second click. It must not
  sit as a bare red button in the panel.
- Compute device shown as a read-only row: "Apple Silicon (CPU/MPS)".

About
- App icon at 64px, "Vocalis 3.0 (build 412)", the line "Everything runs on this Mac. Your
  audio and voice models never leave it." Links: Release notes, Report an issue,
  Acknowledgements (RVC/Applio licences), and a "Copy diagnostics" button.

Delete the compute-device pill from the main window's top-right corner — move that
information here. It currently occupies prime toolbar space with static text.
```

---

## Prompt 7 — States, onboarding and polish pass

```
Read Vocalis-Design-System.md. This pass covers everything between the screens.

First launch (only when there are no voices and no covers): a single centred panel in the
content area, not a modal. Headline "Sing anything in a voice you own." One line: "Vocalis
runs entirely on this Mac — nothing is uploaded." Then two paths as equal-weight cards:
"Train a voice from your recordings (about an hour)" and "Import an RVC .pth you already
have (instant)". A quiet tertiary link: "Just exploring? Try a cover with the sample
voice." Three steps maximum, no carousel, no progress dots.

Then implement, for every view:
- Loading: skeleton rows in --gr-850 with a 1.4s shimmer, honouring reduced-motion.
- Empty: as specified per view.
- Error: inline panel with what happened, the likely cause, one primary recovery action,
  and a "Copy details" tertiary button. Errors never apologise and never show stack traces.
- Offline/missing file: if an output file has been moved or deleted outside the app, mark
  the row with a --err-300 icon and offer "Locate…" and "Remove from library".

Toasts: bottom-centre above the player bar, 44px, --gr-800 with hairline, 4s, max one at a
time, with an Undo action for deletes. Verbs match their buttons ("Generate cover" →
"Cover generated"; "Delete" → "Cover deleted · Undo").

Final polish pass — verify against the design system and fix anything that drifted:
1. No gradient anywhere in the codebase. Grep for "gradient" and remove every hit.
2. No purple or pink hex values. Grep for them.
3. No hardcoded colours outside tokens.css.
4. Every changing number uses .tabular.
5. Every radius is 4/6/8/12.
6. Every icon-only button has an aria-label and a tooltip.
7. Full keyboard traversal of every view with a visible amber focus ring; no focus traps.
8. Contrast audit: every text/background pair ≥ 4.5:1, every control ≥ 3:1.
9. Both themes rendered on every view; screenshot each and compare.
10. Window at minimum size (900×620) has no clipped or overlapping content — check the
    New Cover inspector and the Train a Voice quality cards specifically.
11. prefers-reduced-motion and prefers-reduced-transparency both produce a usable app.
12. Amber appears in no more than three places per screen. Remove the weakest use.
```

---

## Suggested order and checkpoints

| Step | Prompt | Review before continuing |
|---|---|---|
| 1 | 0 — Foundation | Open `/styleguide`, check both themes and the Meter family |
| 2 | 1 — Shell | Sidebar vibrancy, opaque content, traffic lights, ⌘F/⌘1/⌘2 |
| 3 | 2 — Covers | Metadata migration ran; drag-to-Finder works |
| 4 | 3 — Voices | Preview audio plays inline |
| 5 | 4 — New Cover | Pipeline timing accurate; inspector no longer clips text |
| 6 | 5 — Train a Voice | Background training + Dock progress + notification |
| 7 | 6 — Settings | Separate window, ⌘, opens it |
| 8 | 7 — States & polish | Run the 12-point checklist |

If a prompt produces too much at once, split it at the numbered sections — they were
written to be independently buildable.
