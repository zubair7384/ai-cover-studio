/**
 * /styleguide — every primitive and meter, in every state, in both themes.
 *
 * The two theme panels are rendered side by side rather than behind a toggle,
 * so a token that only works in one theme is visible immediately rather than
 * one click away.
 */

import { el, append } from "../lib/dom.js";
import { icon as makeIcon, iconNames } from "../lib/icons.js";
import { ratio, passes } from "../lib/contrast.js";
import {
  Button, IconButton, Segmented,
  TextField, Select, Slider, Toggle, Checkbox,
  Badge, Separator, Spinner, EmptyState, Readout, Skeleton,
  attachTooltip, Popover, Menu, ContextMenu, Sheet,
} from "../components/primitives/index.js";
import {
  MeterBar, MeterRing, MeterSegments, Waveform, Pipeline, COVER_STAGES,
} from "../components/meter/index.js";

/* ---- layout helpers ----------------------------------------------------- */

const group = (title, ...children) =>
  el("section", { class: "sg__group" },
    el("h2", { class: "sg__group-title t-head" }, title),
    append(el("div", { class: "sg__group-body" }), children),
  );

const row = (label, ...children) =>
  el("div", { class: "sg__row" },
    el("div", { class: "sg__row-label t-caption" }, label),
    append(el("div", { class: "sg__row-items" }), children),
  );

const stack = (...children) => append(el("div", { class: "sg__stack" }), children);

/* ---- demo data ---------------------------------------------------------- */

/** A deterministic pseudo-waveform, so the styleguide looks identical each run. */
function demoPeaks(n = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.sin(t * Math.PI) ** 0.6;
    const detail =
      0.55 + 0.45 * Math.sin(i * 0.7) * Math.cos(i * 0.13) * Math.sin(i * 0.05 + 1);
    out.push(Math.max(0.05, env * Math.abs(detail)));
  }
  return out;
}

/* ---- the gallery -------------------------------------------------------- */

function gallery() {
  const frag = el("div", { class: "sg__gallery" });

  /* Colour ---------------------------------------------------------------- */
  const swatch = (name, token) =>
    el("div", { class: "sg__swatch" },
      el("div", { class: "sg__swatch-chip", style: { background: `var(${token})` } }),
      el("div", { class: "sg__swatch-name t-caption tabular" }, name),
    );

  frag.appendChild(group("Colour",
    row("Graphite", ...[
      "950", "900", "850", "800", "750", "700", "600", "500",
      "400", "300", "200", "150", "100", "050",
    ].map((s) => swatch(s, `--gr-${s}`))),
    row("Amber", ...["700", "500", "400", "300", "050"].map((s) => swatch(s, `--am-${s}`))),
    row("Status", swatch("ok-500", "--ok-500"), swatch("ok-300", "--ok-300"),
                  swatch("err-500", "--err-500"), swatch("err-300", "--err-300")),
    row("Surfaces", swatch("content", "--bg-content"), swatch("raised", "--bg-raised"),
                    swatch("panel", "--bg-panel"), swatch("control", "--bg-control"),
                    swatch("well", "--bg-well")),
  ));

  /* Type ------------------------------------------------------------------ */
  frag.appendChild(group("Typography",
    stack(
      el("div", { class: "t-title-1" }, "title-1 · 22/28 · View title"),
      el("div", { class: "t-title-2" }, "title-2 · 17/22 · Sheet title"),
      el("div", { class: "t-head" }, "head · 15/20 · Section header"),
      el("div", { class: "t-body" }, "body · 13/18 · Default text for controls and list rows"),
      el("div", { class: "t-body-em" }, "body-em · 13/18 · Field labels"),
      el("div", { class: "t-caption" }, "caption · 11/15 · Helper text and metadata"),
      el("div", { class: "t-label" }, "label · 11/15 · Sidebar Section Header (Title Case)"),
      el("div", { class: "t-meter tabular" }, "meter · 0:42 / 3:17 · epoch 118/300"),
      el("div", { class: "t-meter-lg tabular" }, "meter-lg · 41% · 21:04 elapsed"),
    ),
  ));

  /* Buttons --------------------------------------------------------------- */
  frag.appendChild(group("Button",
    row("Variants",
      Button({ label: "Primary", variant: "primary" }),
      Button({ label: "Secondary", variant: "secondary" }),
      Button({ label: "Tertiary", variant: "tertiary" }),
      Button({ label: "Delete", variant: "destructive" }),
      Button({ label: "Delete", variant: "destructive", fill: true }),
    ),
    row("Sizes",
      Button({ label: "Small", variant: "primary", size: "sm" }),
      Button({ label: "Default", variant: "primary", size: "md" }),
      Button({ label: "Prominent", variant: "primary", size: "lg" }),
    ),
    row("With icon",
      Button({ label: "New Cover", variant: "primary", icon: "plus" }),
      Button({ label: "Import", variant: "secondary", icon: "import" }),
      Button({ label: "Sort", variant: "tertiary", iconEnd: "chevron-down" }),
    ),
    row("States",
      Button({ label: "Loading", variant: "primary", loading: true }),
      Button({ label: "Disabled", variant: "primary", disabled: true }),
      Button({ label: "Disabled", variant: "secondary", disabled: true }),
      Button({
        label: "Generate",
        variant: "primary",
        disabled: true,
        tooltip: "Choose a song first.",
      }),
    ),
  ));

  /* IconButton ------------------------------------------------------------ */
  frag.appendChild(group("IconButton",
    row("Sizes",
      IconButton({ icon: "play", label: "Play", size: "sm" }),
      IconButton({ icon: "play", label: "Play", size: "md" }),
      IconButton({ icon: "play", label: "Play", size: "lg" }),
    ),
    row("States",
      IconButton({ icon: "export", label: "Export" }),
      IconButton({ icon: "more-horizontal", label: "More actions" }),
      IconButton({ icon: "gear", label: "Settings", active: true }),
      IconButton({ icon: "trash", label: "Delete", disabled: true }),
    ),
    row("Icon set", ...iconNames().map((n) =>
      el("span", { class: "sg__icon", title: n }, makeIcon(n, 16)))),
  ));

  /* Segmented ------------------------------------------------------------- */
  frag.appendChild(group("Segmented",
    row("A/B", Segmented({
      ariaLabel: "Compare original and cover",
      options: [{ value: "original", label: "Original" }, { value: "cover", label: "Cover" }],
      value: "cover",
    })),
    row("Theme", Segmented({
      ariaLabel: "Theme",
      options: [
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
      value: "system",
    })),
  ));

  /* Fields ---------------------------------------------------------------- */
  const invalid = TextField({
    label: "Voice name",
    value: "my voice",
    help: "No spaces or slashes.",
  });
  invalid.setError("Names cannot contain spaces.");

  frag.appendChild(group("Fields",
    row("TextField",
      stack(
        TextField({ label: "Name", value: "zub" }),
        TextField({ label: "With help", placeholder: "Untitled", help: "Shown under the field." }),
        invalid,
        TextField({ label: "Disabled", value: "Locked", disabled: true }),
        TextField({ search: true, placeholder: "Search", ariaLabel: "Search" }),
      ),
    ),
    row("Select",
      stack(
        Select({
          label: "Output format",
          options: ["MP3 320", "WAV 24-bit", "FLAC"],
          value: "MP3 320",
        }),
        Select({
          label: "Disabled",
          options: ["40 kHz"],
          value: "40 kHz",
          disabled: true,
        }),
      ),
    ),
    row("Slider",
      stack(
        Slider({
          label: "Pitch shift",
          min: -12, max: 12, value: 0,
          format: (v) => `${v > 0 ? "+" : ""}${v} st`,
          ticks: [{ label: "−12" }, { label: "0" }, { label: "+12" }],
          help: "+12 to sing a man's part in a woman's voice; −12 for the reverse.",
        }),
        Slider({
          label: "Voice character",
          min: 0, max: 1, step: 0.01, value: 0.75,
          format: (v) => Number(v).toFixed(2),
          help: "Higher stays closer to your voice; lower keeps more of the original singer.",
        }),
        Slider({ label: "Disabled", min: 0, max: 1, step: 0.01, value: 0.4, disabled: true }),
      ),
    ),
    row("Toggle",
      stack(
        Toggle({ label: "Notify me when a cover finishes", checked: true }),
        Toggle({ label: "Use the system accent colour instead of amber" }),
        Toggle({ label: "Disabled", disabled: true }),
      ),
    ),
    row("Checkbox",
      stack(
        Checkbox({ label: "Also move the file to Trash", checked: true }),
        Checkbox({ label: "Ask every time" }),
        Checkbox({ label: "Partially selected", indeterminate: true }),
        Checkbox({ label: "Disabled", disabled: true }),
      ),
    ),
  ));

  /* Display atoms --------------------------------------------------------- */
  frag.appendChild(group("Display",
    row("Badge",
      Badge({ label: "Pitch index ready", tone: "ok", icon: "check" }),
      Badge({ label: "No pitch index", tone: "neutral" }),
      Badge({ label: "Failed", tone: "error", icon: "alert" }),
      Badge({ label: "Training", tone: "accent" }),
    ),
    row("Readout",
      Readout({ text: "0:42 / 3:17" }),
      Readout({ text: "epoch 118 / 300" }),
      Readout({ text: "41%", size: "lg" }),
    ),
    row("Spinner", Spinner({ size: 14 }), Spinner({ size: 16 }), Spinner({ size: 24 })),
    row("Separator", el("div", { style: { width: "220px" } }, Separator())),
    row("Skeleton", stack(Skeleton({ height: 32 }), Skeleton({ height: 32, width: "70%" }))),
  ));

  frag.appendChild(group("EmptyState",
    EmptyState({
      icon: "waveform",
      title: "No covers yet",
      body: "Pick a song and a voice, and Vocalis does the rest.",
      action: Button({ label: "New Cover", variant: "primary" }),
    }),
  ));

  /* Overlays -------------------------------------------------------------- */
  const tipTarget = Button({ label: "Hover or focus me", variant: "secondary" });
  attachTooltip(tipTarget, "A pitch index improves accuracy on fast or slurred phrases.");

  const popTrigger = Button({ label: "Open popover", variant: "secondary" });
  popTrigger.addEventListener("click", () => Popover(popTrigger, stack(
    el("div", { class: "t-body-em" }, "Choose a voice"),
    el("div", { class: "t-caption" }, "Popovers sit at level 3 with a 12px radius."),
  )));

  const menuTrigger = Button({ label: "Open menu", variant: "secondary", iconEnd: "chevron-down" });
  menuTrigger.addEventListener("click", () => Menu(menuTrigger, [
    { label: "Play", icon: "play", shortcut: "Space" },
    { label: "Show in Finder", icon: "folder" },
    { label: "Export…", icon: "export", shortcut: "⌘E" },
    { separator: true },
    { label: "Delete", icon: "trash", destructive: true, shortcut: "⌘⌫" },
  ]));

  const ctxTarget = el("div", { class: "sg__ctx t-caption" }, "Right-click anywhere in this box");
  ctxTarget.addEventListener("contextmenu", (e) => ContextMenu(e, [
    { label: "Play", icon: "play" },
    { label: "Get Info", icon: "info" },
    { separator: true },
    { label: "Delete", icon: "trash", destructive: true },
  ]));

  const sheetTrigger = Button({ label: "Open sheet", variant: "secondary" });
  sheetTrigger.addEventListener("click", () => {
    const s = Sheet({
      title: "Delete “Tu Hai Tu — zub”?",
      body: stack(
        el("div", {}, "This removes the cover from your library."),
        Checkbox({ label: "Also move the file to Trash", checked: true }),
      ),
      actions: [
        Button({ label: "Cancel", variant: "secondary", onClick: () => s.close() }),
        Button({ label: "Delete", variant: "destructive", fill: true, onClick: () => s.close() }),
      ],
    });
  });

  frag.appendChild(group("Overlays",
    row("Tooltip", tipTarget),
    row("Popover", popTrigger),
    row("Menu", menuTrigger),
    row("ContextMenu", ctxTarget),
    row("Sheet", sheetTrigger),
  ));

  /* Meters ---------------------------------------------------------------- */
  const indeterminate = MeterBar({ indeterminate: true, readout: "starting…", ariaLabel: "Starting" });

  frag.appendChild(group("MeterBar",
    row("Determinate", stack(
      MeterBar({ value: 0, readout: "0%", ariaLabel: "Progress" }),
      MeterBar({ value: 0.41, readout: "epoch 118 / 300", ariaLabel: "Training" }),
      MeterBar({ value: 0.41, readout: "41%", readoutSize: "lg", ariaLabel: "Training" }),
      MeterBar({ value: 1, readout: "done", tone: "ok", ariaLabel: "Complete" }),
      MeterBar({ value: 0.62, readout: "failed", tone: "error", ariaLabel: "Failed" }),
    )),
    row("Indeterminate", indeterminate),
    row("Ring",
      MeterRing({ value: 0.41 }),
      MeterRing({ value: 0.41, size: 20 }),
      MeterRing({ value: 0.78, size: 28, stroke: 3 }),
    ),
  ));

  frag.appendChild(group("MeterSegments",
    row("Level", MeterSegments({ value: 0.72, count: 24, readout: "−6.2 dB", ariaLabel: "Level" })),
    row("In range", MeterSegments({
      value: 0.48, count: 40,
      band: { from: 0.33, to: 1 },
      readout: "14 min 20 s of 10–30 min",
      ariaLabel: "Recording material",
    })),
    row("Below range", MeterSegments({
      value: 0.14, count: 40, under: true,
      band: { from: 0.33, to: 1 },
      readout: "4 min 10 s of 10–30 min",
      ariaLabel: "Recording material",
    })),
  ));

  const peaks = demoPeaks();
  frag.appendChild(group("Waveform",
    row("Scrubbable", Waveform({
      peaks, progress: 0.34, readout: "0:42 / 3:17", ariaLabel: "Scrub cover",
    })),
    row("Tall", Waveform({
      peaks, progress: 0.62, height: 64, readout: "1:58 / 3:17", ariaLabel: "Scrub cover",
    })),
    row("Static", Waveform({
      peaks, progress: 0, height: 24, disabled: true, ariaLabel: "Waveform thumbnail",
    })),
  ));

  /* Pipeline — all four states ------------------------------------------- */
  const pending = Pipeline({ stages: COVER_STAGES });

  const running = Pipeline({ stages: COVER_STAGES });
  running.setStage("separate", "done", { duration: "0:38" });
  running.setStage("convert", "running");

  const done = Pipeline({ stages: COVER_STAGES });
  done.setStage("separate", "done", { duration: "0:38" });
  done.setStage("convert", "done", { duration: "1:52" });
  done.setStage("mix", "done", { duration: "0:11" });

  const failed = Pipeline({ stages: COVER_STAGES });
  failed.setStage("separate", "done", { duration: "0:38" });
  failed.setStage("convert", "failed");

  frag.appendChild(group("Pipeline",
    row("Pending", pending),
    row("Running", running),
    row("Complete", done),
    row("Failed", failed),
  ));

  return frag;
}

/* ---- contrast audit ----------------------------------------------------- */

/** Pairs checked against the §11 floor. Resolved from live computed style. */
const PAIRS = [
  ["Primary text", "--text-primary", "--bg-content", "text"],
  ["Secondary text", "--text-secondary", "--bg-content", "text"],
  ["Tertiary text", "--text-tertiary", "--bg-content", "text"],
  ["Text on raised", "--text-primary", "--bg-raised", "text"],
  ["Quiet text on raised", "--text-secondary", "--bg-raised", "text"],
  ["Text on panel", "--text-primary", "--bg-panel", "text"],
  ["Text on control", "--text-primary", "--bg-control", "text"],
  ["Tertiary on popover", "--text-tertiary", "--bg-popover", "text"],
  ["On-accent (filled button)", "--on-accent", "--accent", "text"],
  ["Accent text", "--accent-text", "--bg-content", "text"],
  ["OK text", "--ok-text", "--bg-content", "text"],
  ["Error text", "--err-text", "--bg-content", "text"],
  ["On-error (filled)", "--on-error", "--err-500", "text"],
  ["Meter fill", "--meter-fill", "--bg-content", "ui"],
  ["Meter fill on raised", "--meter-fill", "--bg-raised", "ui"],
  ["Waveform played", "--wave-played", "--bg-content", "ui"],
  ["Waveform unplayed", "--wave-unplayed", "--bg-content", "ui"],
  ["OK dot", "--ok-graphic", "--bg-content", "ui"],
  ["Error dot", "--err-graphic", "--bg-content", "ui"],
  ["Toggle thumb on track", "--on-accent", "--accent", "ui"],
];

function contrastTable(scope) {
  const cs = getComputedStyle(scope);
  const read = (t) => cs.getPropertyValue(t).trim();

  const table = el("table", { class: "sg__table" },
    el("thead", {}, el("tr", {},
      el("th", {}, "Pair"),
      el("th", {}, "Ratio"),
      el("th", {}, "Min"),
      el("th", {}, "Result"),
    )),
  );

  const body = el("tbody");
  let failures = 0;

  PAIRS.forEach(([label, fgTok, bgTok, kind]) => {
    const fg = read(fgTok);
    const bg = read(bgTok);
    let r, ok;
    try {
      r = ratio(fg, bg);
      ok = passes(r, kind);
    } catch {
      r = NaN;
      ok = false;
    }
    if (!ok) failures++;
    const min = kind === "text" ? "4.5" : "3.0";
    body.appendChild(el("tr", { class: ok ? "" : "sg__fail" },
      el("td", {}, label),
      el("td", { class: "tabular" }, Number.isFinite(r) ? r.toFixed(2) : "—"),
      el("td", { class: "tabular" }, min),
      el("td", {}, ok ? "pass" : "FAIL"),
    ));
  });

  table.appendChild(body);
  const summary = el("div", {
    class: failures ? "sg__summary sg__fail" : "sg__summary",
  }, failures ? `${failures} pair(s) below the floor` : "All pairs meet the §11 floor");

  return el("div", {}, summary, table);
}

/* ---- page --------------------------------------------------------------- */

export function renderStyleguide() {
  const page = el("div", { class: "sg" });

  page.appendChild(el("header", { class: "sg__head drag-region" },
    el("div", {},
      el("div", { class: "t-title-1" }, "Vocalis — Styleguide"),
      el("div", { class: "t-caption" },
        "Every primitive and meter, in both themes. Anodized: graphite chassis, amber signal."),
    ),
  ));

  const panels = el("div", { class: "sg__panels" });

  [["dark", "Dark"], ["light", "Light"]].forEach(([theme, title]) => {
    const panel = el("div", { class: "sg__panel", dataset: { theme } },
      el("div", { class: "sg__panel-head t-label" }, title),
    );
    panel.appendChild(gallery());
    // The audit has to run after the panel is in the document, or computed
    // style resolves against the wrong theme.
    queueMicrotask(() => {
      panel.appendChild(group("Contrast audit", contrastTable(panel)));
    });
    panels.appendChild(panel);
  });

  page.appendChild(panels);
  return page;
}
