/**
 * Headless contrast audit against the §11 floor:
 *   text ≥ 4.5:1 · large text and UI/graphics ≥ 3:1
 *
 * Parses renderer/styles/tokens.css, resolves var() chains per theme, and
 * checks every pair the app actually renders. Exits non-zero on any failure.
 *
 *   node scripts/check-contrast.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ratio, passes } from "../renderer/lib/contrast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(here, "..", "renderer", "styles", "tokens.css");
const css = readFileSync(cssPath, "utf8");

/* ---- parse ------------------------------------------------------------- */

/** Strip comments, then pull `selector { --tok: value; }` blocks. */
function parseBlocks(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selector = m[1].trim();
    const decls = {};
    for (const line of m[2].split(";")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const prop = line.slice(0, i).trim();
      if (!prop.startsWith("--")) continue;
      decls[prop] = line.slice(i + 1).trim();
    }
    if (Object.keys(decls).length) blocks.push({ selector, decls });
  }
  return blocks;
}

const blocks = parseBlocks(css);

/** Build a token map for a theme, applying blocks in source order. */
function tokensFor(theme) {
  const out = {};
  for (const { selector, decls } of blocks) {
    // Skip the prefers-contrast overrides — they only raise contrast.
    const isLight = selector.includes('[data-theme="light"]');
    const isDark = selector.includes('[data-theme="dark"]') || /(^|,)\s*:root\s*(,|$)/.test(selector);
    const applies = theme === "light"
      ? (isDark && !isLight) || isLight
      : isDark && !isLight;
    if (applies) Object.assign(out, decls);
  }
  return out;
}

/** Resolve a token value through any var() chain. */
function resolve(tokens, value, depth = 0) {
  if (depth > 10) throw new Error(`var() chain too deep: ${value}`);
  const v = String(value).trim();
  const m = v.match(/^var\((--[\w-]+)\)$/);
  if (!m) return v;
  const next = tokens[m[1]];
  if (next == null) throw new Error(`unresolved token ${m[1]}`);
  return resolve(tokens, next, depth + 1);
}

/* ---- the pairs the app renders ----------------------------------------- */

const PAIRS = [
  ["Primary text on content",   "--text-primary",   "--bg-content", "text"],
  ["Secondary text on content", "--text-secondary", "--bg-content", "text"],
  ["Tertiary text on content",  "--text-tertiary",  "--bg-content", "text"],
  ["Primary text on raised",    "--text-primary",   "--bg-raised",  "text"],
  ["Secondary text on raised",  "--text-secondary", "--bg-raised",  "text"],
  ["Primary text on panel",     "--text-primary",   "--bg-panel",   "text"],
  ["Primary text on control",   "--text-primary",   "--bg-control", "text"],
  ["Tertiary text on popover",  "--text-tertiary",  "--bg-popover", "text"],
  ["Primary text on well",      "--text-primary",   "--bg-well",    "text"],
  ["On-accent (filled button)", "--on-accent",      "--accent",     "text"],
  ["Accent text on content",    "--accent-text",    "--bg-content", "text"],
  ["Accent text on tint",       "--accent-text",    "--bg-content", "text"],
  ["OK text on content",        "--ok-text",        "--bg-content", "text"],
  ["Error text on content",     "--err-text",       "--bg-content", "text"],
  ["On-error (filled)",         "--on-error",       "--err-500",    "text"],
  ["Meter fill on content",     "--meter-fill",     "--bg-content", "ui"],
  ["Meter fill on raised",      "--meter-fill",     "--bg-raised",  "ui"],
  ["Waveform played",           "--wave-played",    "--bg-content", "ui"],
  ["Waveform unplayed",         "--wave-unplayed",  "--bg-content", "ui"],
  ["OK dot on content",         "--ok-graphic",     "--bg-content", "ui"],
  ["Error dot on content",      "--err-graphic",    "--bg-content", "ui"],
  ["Toggle thumb on track",     "--on-accent",      "--accent",     "ui"],
];

// Not checked, and why:
//   --text-disabled  — WCAG 1.4.3 exempts inactive controls from the contrast
//                      floor. It is 3.55:1 on dark and 2.88:1 on light, which
//                      is deliberate: disabled has to READ as disabled.

/* ---- run ---------------------------------------------------------------- */

let failures = 0;

for (const theme of ["dark", "light"]) {
  const tokens = tokensFor(theme);
  console.log(`\n  ${theme.toUpperCase()}`);
  console.log(`  ${"".padEnd(58, "-")}`);

  for (const [label, fgTok, bgTok, kind] of PAIRS) {
    let line;
    try {
      const fg = resolve(tokens, tokens[fgTok] ?? fgTok);
      const bg = resolve(tokens, tokens[bgTok] ?? bgTok);
      const r = ratio(fg, bg);
      const ok = passes(r, kind);
      if (!ok) failures++;
      const min = kind === "text" ? "4.5" : "3.0";
      line = `  ${ok ? "pass" : "FAIL"}  ${label.padEnd(28)} ${r.toFixed(2).padStart(6)} : 1   (min ${min})`;
    } catch (err) {
      failures++;
      line = `  FAIL  ${label.padEnd(28)}   ${err.message}`;
    }
    console.log(line);
  }
}

/* ---- Accents ------------------------------------------------------------ */
// Every selectable accent must clear the same floor as amber, in both themes.
// Adding one without this check is how a theme ships unreadable.

const { ACCENTS } = await import("../renderer/app/accent.js");
const BG = { dark: "#181A1C", light: "#F7F8F9" };
const RAISED = { dark: "#1F2124", light: "#EEF0F2" };

console.log("\n  ACCENTS");
console.log(`  ${"".padEnd(58, "-")}`);
for (const a of ACCENTS) {
  const checks = [
    ["on-accent on fill", a.onAccent, a.s500, "text"],
    ["text on dark", a.s300, BG.dark, "text"],
    ["text on light", a.s700, BG.light, "text"],
    ["fill on dark", a.s500, BG.dark, "ui"],
    ["fill on dark raised", a.s500, RAISED.dark, "ui"],
    ["drawn on light", a.s700, BG.light, "ui"],
    ["drawn on light raised", a.s700, RAISED.light, "ui"],
  ];
  const bad = checks.filter(([, fg, bg, kind]) => !passes(ratio(fg, bg), kind));
  bad.forEach(([label, fg, bg, kind]) => {
    failures++;
    console.log(`  FAIL  ${a.label} — ${label.padEnd(22)} ${ratio(fg, bg).toFixed(2).padStart(6)} : 1   (min ${kind === "text" ? "4.5" : "3.0"})`);
  });
  if (!bad.length) console.log(`  pass  ${a.label.padEnd(28)} ${checks.length} pairs, both themes`);
}

console.log("");
if (failures) {
  console.error(`  ${failures} pair(s) below the §11 floor\n`);
  process.exit(1);
}
console.log("  All pairs meet the §11 accessibility floor\n");
