# Vocalis — Design System & UX Direction v3

A local-first Mac app for cloning your own voice and swapping it into songs.
This document is the single source of truth. Every page prompt references it.

---

## 1. What's wrong today (audit of the current build)

Read this first — it explains why the redesign is shaped the way it is.

### Visual
| # | Issue | Why it hurts |
|---|---|---|
| V1 | Purple→pink gradients on hero, cards, buttons, avatar | Reads as a 2022 SaaS landing page, not a Mac tool. Gradients also fight the desktop wallpaper showing through. |
| V2 | The **whole window** is translucent over the wallpaper | macOS convention is: sidebar is vibrant, content is opaque. Full-window blur makes text sit on unpredictable backgrounds and destroys contrast. |
| V3 | Corner radii of 16–20px on cards and buttons | macOS controls sit at 5–8px. Big radii read "web app". |
| V4 | ALL-CAPS letterspaced section labels (`CREATE`, `LIBRARY`, `APP`) | macOS sidebar headers are Title Case, 11pt semibold. |
| V5 | Marketing hero inside the app ("Any song. Your voice.") | You already downloaded it. A hero here costs a full screen of workspace. |
| V6 | 3 different card treatments on one screen (Home) | No elevation logic. |
| V7 | Type has no scale — 60px, 34px, 17px, 13px used arbitrarily | Nothing establishes hierarchy consistently. |

### UX / functional
| # | Issue | Why it hurts |
|---|---|---|
| U1 | **Layout bug:** "Train a voiceClone one from your own recordings" — label and description have no gap | Visible on Home, both cards. |
| U2 | **Layout bug:** sticky "Generate cover" bar overlaps the parameter text, clipping "How strongly to match the model's timbre…" | Content is unreadable behind the CTA. |
| U3 | "Final mixed cover" empty panel occupies 45% of the Vocal Swapper screen doing nothing | Empty space where the work should be. |
| U4 | Pipeline chips (Separating vocals / Converting / Mixing) are dead grey until a run starts | The single most important thing in this app is *how long is this going to take* — and it's invisible. |
| U5 | Covers list is a table of `final_cover_20260717_024930.mp3` with `—` in the Voice column | Filenames are not identity. 20 of 22 covers have no recorded voice/source metadata. Nobody can find anything. |
| U6 | No search, no sort, no multi-select, no drag-to-Finder anywhere | Every library view fails at the one thing libraries do. |
| U7 | No audio preview on voice models | You can't tell `zub` from `arijit` without generating a whole cover. |
| U8 | `no index` / `has index` badges with no explanation | System vocabulary leaking into the UI. |
| U9 | Two dismissible banners eat the top third of Voice Cloning | Persistent warnings should be inline at the decision point, not stacked at the top. |
| U10 | Epochs = a bare slider 0–1000 with "~55 min (rough)" | The user has no model for the quality/time tradeoff. This is a 1–3 hour commitment. |
| U11 | Training log is a large empty black box before training starts | Same problem as U3. |
| U12 | Settings is a sidebar page | Mac apps put settings in a separate ⌘, window. |
| U13 | Home, and the sidebar "App" section holding one item | Dead weight in the IA. |
| U14 | No keyboard shortcuts, no menu bar, no Dock progress, no notifications | For a 3-hour training job, background reporting isn't optional. |

---

## 2. Design direction: **Anodized**

**Concept:** the app is a piece of studio hardware, not a website. A cool anodized-aluminum
chassis, quiet and neutral, with one hot signal colour — amber — reserved exclusively for
things that are *live*: levels, playheads, progress, the current selection, the primary action.

This is grounded in the subject: VU meters, record lamps, tape saturation, the amber
backlight on a rackmount unit. It also solves the app's real problem — long jobs — by giving
progress a consistent, unmistakable visual language.

**Explicitly rejected:** purple/pink gradients (your call), and also glassmorphism, neon
gradients on text, and cream+terracotta — all of which are era-tells rather than choices.

**The signature element: the Meter.**
One component language covers waveform, level, training progress, pipeline stages, and
storage usage — segmented amber bars on graphite with SF Mono tabular readouts. Used on
every screen, it's what people will remember about this app.

**Restraint rule:** amber appears in at most 3 places per screen. Everything else is graphite,
hairlines, and type. If a screen looks colourful, delete something.

---

## 3. Colour

Cool graphite chassis (hue 220, low saturation) + warm amber signal. The temperature
contrast is what makes the amber read as "live" rather than decorative.

### Neutrals — Graphite
```
--gr-950  #111214   deepest wells, log background
--gr-900  #181A1C   window content background (dark)
--gr-850  #1F2124   raised surface / list rows
--gr-800  #26282B   card, panel
--gr-750  #2E3134   control fill (buttons, inputs)
--gr-700  #383B3F   control fill hover
--gr-600  #4B4F55   strong border, disabled text
--gr-500  #6C7178   waveform unplayed, meter track
--gr-400  #8E949C   tertiary text
--gr-300  #B3B9C0   secondary text (dark mode)
--gr-200  #D4D8DD   hairline (light mode)
--gr-150  #E4E7EA   grouped background (light mode)
--gr-100  #EEF0F2   raised surface (light mode)
--gr-050  #F7F8F9   window content background (light)
```

### Signal — Amber (the only accent)
```
--am-700  #A15E12   amber text/link on LIGHT backgrounds only
--am-500  #E0872B   primary fill, selection, playhead, meter fill
--am-400  #EC9A3E   fill hover
--am-300  #F0A94E   amber text on DARK backgrounds only
--am-050  #FBEBD5   tint background (light mode)
--am-tint rgba(224,135,43,0.14)   selected row background (dark mode)
```

**Critical rule:** filled amber controls use **near-black text** (`--gr-950`), never white.
`#111214` on `#E0872B` = 9.1:1. White on amber = 2.3:1 and fails. Black-on-amber also
reads as an instrument panel, which is the point.

### Status
```
--ok-500   #3FA97C   ready, complete       --ok-300  #6FCFA6  (text on dark)
--err-500  #DC4E3C   destructive, failed   --err-300 #F08272  (text on dark)
```
Never use colour alone for status — always pair with an icon or word.

### Text
```
dark mode:  primary #F2F4F6 · secondary #B3B9C0 · tertiary #8E949C · disabled #6C7178
light mode: primary #14161A · secondary #4B4F55 · tertiary #6C7178 · disabled #8E949C
```

### Optional native touch
Add a Settings toggle: **"Use system accent colour."** When on, read
`systemPreferences.getAccentColor()` and substitute it for `--am-500`
(keeping black text if the accent is light, white if dark). Off by default — amber is the brand.

---

## 4. Typography

A native Mac app loses its nativeness the second it loads a novelty display face. So the
personality comes from *how* the system faces are set, not from exotic families.

```
--font-ui:   -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace
```

**SF Mono is not just for logs.** Every number that changes — timecodes, elapsed time,
epoch counts, file sizes, dB, semitones, percentages — is set in mono with
`font-variant-numeric: tabular-nums`. This is the typographic half of the Meter idea and it
stops numbers from jittering as they update.

### Scale
| Token | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `title-1` | 22 / 28 | 600 | −0.015em | View title in content area |
| `title-2` | 17 / 22 | 600 | −0.01em | Sheet titles, empty-state headline |
| `head` | 15 / 20 | 600 | −0.005em | Section headers, card titles |
| `body` | 13 / 18 | 400 | 0 | Default. All controls, list rows |
| `body-em` | 13 / 18 | 600 | 0 | Field labels, selected sidebar row |
| `caption` | 11 / 15 | 400 | 0 | Helper text, metadata |
| `label` | 11 / 15 | 600 | +0.01em | Sidebar section headers — **Title Case, not caps** |
| `meter` | 11 / 14 | 500 | +0.02em | Mono readouts (`0:42 / 3:17`, `epoch 118/300`) |
| `meter-lg` | 15 / 20 | 500 | 0 | Mono, primary progress figure |

Body copy max width 62ch. Never letterspace body text.

---

## 5. Materials, elevation, shape

**Window chrome (Electron `BrowserWindow`):**
```js
{
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 18, y: 20 },
  vibrancy: 'sidebar',            // sidebar material only
  visualEffectState: 'followWindow',
  backgroundColor: '#181A1C',
  minWidth: 900, minHeight: 620,
  width: 1180, height: 760
}
```

**Translucency is used in exactly one place: the sidebar.** The content area is opaque
`--gr-900`. This is the single biggest fix to how "Mac" the app feels. Honour
`prefers-reduced-transparency` by falling back to solid `--gr-850`.

**Elevation** is expressed by surface value + a 1px hairline, not by shadow:
```
level 0  content    --gr-900   no border
level 1  row/card   --gr-850   1px rgba(255,255,255,.06)
level 2  panel      --gr-800   1px rgba(255,255,255,.08)
level 3  popover    --gr-800   1px rgba(255,255,255,.12) + 0 8px 24px rgba(0,0,0,.45)
level 4  sheet      --gr-800   0 24px 64px rgba(0,0,0,.55)
```

**Radii:** `4` chips/badges · `6` controls, inputs, buttons · `8` cards, rows, panels ·
`12` sheets and popovers. Nothing above 12.

**Spacing:** 4pt grid. `4 8 12 16 20 24 32 40 48`. Window content padding 20.
Card padding 16. Row height 32 (list), 28 (sidebar), 24 (compact).

**Control heights:** 22 small · 28 default · 32 prominent. Sidebar width 220 (drag 180–320).
Inspector width 280 (drag 240–360).

---

## 6. Core components

**Button** — Primary: `--am-500` fill, `--gr-950` text, 6px radius, 28h, 12px pad.
Secondary: `--gr-750` fill, primary text, hairline border. Tertiary: text only, no fill.
Destructive: text `--err-300`, fill only inside confirmation sheets.
Focus ring: `0 0 0 3px rgba(224,135,43,.35)` on all interactive elements. Never `outline: none`.

**Meter** (signature). Three variants, one visual language:
- *Bar* — 4px track `--gr-500` at 20% opacity, amber fill, 2px radius, animated width.
- *Segmented* — 3px-wide bars, 2px gaps, filled left-to-right. Used for level and for
  discrete stage progress.
- *Waveform* — segmented bars, `--gr-500` unplayed / `--am-500` played, 1px amber playhead.
Every Meter carries a mono readout: elapsed, remaining, or `n/total`.

**Pipeline** — replaces the dead grey chips. Horizontal, three stages, each with: a state dot
(pending hollow / running amber pulsing / done green check / failed red), a label, and a mono
duration once complete. Stages connected by a hairline that fills amber as it advances.

**List row** — 32h, hairline separator inset 12px from left, hover `--gr-850`,
selected `--am-tint` with 2px amber left rail. Multi-select with ⇧/⌘.

**Empty state** — 20px icon in `--gr-500`, one `title-2` line stating what goes here, one
`caption` line, one primary button. Never more than 3 elements.

**Toolbar** — 52h, drag region, view title left (`title-1`), actions right, search field
inline. Hairline bottom border that only appears once content scrolls.

**Inspector** — right panel, 280w, `--gr-850`, collapsible with ⌥⌘I, holds all parameters.
Parameters live here, not stacked under the content.

---

## 7. Motion

Duration 120ms (hover/press) · 180ms (panel, sheet) · 240ms (view transition).
Easing `cubic-bezier(0.32, 0.72, 0, 1)` for entrances, `ease-out` for exits.
Meters animate width linearly — never eased, or progress reads as inaccurate.
The only looping animation in the app is the amber pulse on a running pipeline stage.
Wrap everything in `@media (prefers-reduced-motion: reduce)` → transitions to 1ms, pulse
becomes a static dot.

---

## 8. Information architecture

Home is deleted. The app opens to the library, as Music/Photos/Notes do.

```
Sidebar (vibrant, 220w)
  Library
    ▸ Covers          ⌘1     ← launch view
    ▸ Voices          ⌘2
  Activity                   ← section appears only when a job is running
    ▸ Training: zub  ◐ 41%

Toolbar actions (right side, per view)
  Covers:  [search]  [+ New Cover ⌘N]
  Voices:  [search]  [Import…]  [+ Train a Voice ⌘⇧T]

Full-view flows (push over library, with Cancel/Back in toolbar)
  New Cover
  Train a Voice

Separate window
  Settings  ⌘,   tabs: General · Audio · Storage · About
```

**Actions belong in the toolbar; places belong in the sidebar.** That single rule removes
Home, the "Create" section, and the "App" section.

**Global player bar** (48h, pinned to the bottom of the content area, only when audio is
loaded): play/pause, title, voice, waveform scrub, A/B toggle between original and cover,
time readout, export button.

---

## 9. Native behaviours (non-negotiable for "feels like a Mac app")

- **Menu bar:** File (New Cover ⌘N, Train a Voice ⌘⇧T, Import Voice…, Export Cover ⌘E),
  Edit, View (Show/Hide Inspector ⌥⌘I, Show/Hide Sidebar ⌃⌘S), Window, Help.
- **Shortcuts:** ⌘F search · Space play/pause selected · ↩ open · ⌘⌫ delete ·
  ⌘R rescan · ⌘, settings · Esc cancel a flow.
- **Drag out to Finder** from Covers and Voices. **Drag in** anywhere in a drop-target view.
- **Dock progress bar** during training and generation (`win.setProgressBar`).
- **Native notification** on job complete/fail, with the app in the background.
- **Right-click context menus** on every list row (Play, Reveal in Finder, Rename, Export, Delete).
- **Quick Look** (Space) on a selected cover.
- **Sleep prevention** during a run (`powerSaveBlocker`).
- **Standard traffic lights**, window state restored on relaunch, sidebar width persisted.

---

## 10. Voice & copy

Plain, active, sentence case. Name things by what the person controls.

| Don't | Do |
|---|---|
| `no index` / `has index` | `Pitch index: not built` / `Pitch index ready` (tooltip: "Improves pitch accuracy on fast phrases.") |
| `Timbre strength 0.75` | `Voice character` — "Higher stays closer to your voice; lower keeps more of the original singer." |
| `final_cover_20260717_024930.mp3` | `Tu Hai Tu — zub` with the filename as secondary metadata |
| `Heads up: Training uses your CPU…` (banner) | Inline at the Start button: `About 55 min on this Mac. You can keep using the app.` |
| `Generate cover` → toast `Success!` | `Generate cover` → `Cover generated` |
| `Ready.` | Say what's ready, or say nothing. |

Errors state what happened and the next action: *"Couldn't separate the vocals. This track is
16-bit 8 kHz — try a higher-quality source file."*

---

## 11. Accessibility floor

Text contrast ≥ 4.5:1, UI/graphics ≥ 3:1 (all tokens above are checked).
Full keyboard traversal with a visible amber focus ring. Every icon-only button gets an
`aria-label` and a tooltip. Status never conveyed by colour alone. Respect
`prefers-reduced-motion` and `prefers-reduced-transparency`. Support the system
"Increase contrast" setting by swapping hairlines to `--gr-600`.

---

## 12. Token file to generate first

Before touching any page, produce `src/styles/tokens.css` containing every value in
sections 3–7 as CSS custom properties, with a `[data-theme="light"]` override block, plus
`src/styles/base.css` with resets, focus-visible styling, scrollbar styling, and the
`.drag-region` / `.no-drag` utilities for the Electron title bar.
