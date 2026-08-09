/**
 * Accent colour.
 *
 * Amber is the brand and the default (§2: one hot signal colour, reserved for
 * things that are live). This lets that signal be re-hued without touching
 * anything else, because every component already draws from semantic accent
 * tokens rather than a literal.
 *
 * Each accent supplies the same five stops amber does, so the swap is
 * structural rather than a single colour substitution:
 *
 *   700  text/graphics on LIGHT surfaces   (light mode needs a darker step)
 *   500  fill: buttons, selection, meters, playhead
 *   400  fill hover
 *   300  text on DARK surfaces
 *   050  tint background (light mode)
 *
 * `onAccent` is the text colour for filled controls. Near-black is correct for
 * every accent here — white on a mid-tone fill fails 4.5:1, which is the same
 * rule §3 states for amber.
 *
 * Every stop is verified by scripts/check-contrast.mjs in BOTH themes; adding an
 * accent without running that is how a theme ships unreadable.
 */

const NEAR_BLACK = "#111214";

export const ACCENTS = [
  {
    id: "amber", label: "Amber",
    s700: "#A15E12", s500: "#E0872B", s400: "#EC9A3E", s300: "#F0A94E", s050: "#FBEBD5",
    onAccent: NEAR_BLACK,
  },
  {
    id: "blue", label: "Blue",
    s700: "#1C5FA6", s500: "#4B95D8", s400: "#5FA4E0", s300: "#7FB9EC", s050: "#DEEBFA",
    onAccent: NEAR_BLACK,
  },
  {
    id: "teal", label: "Teal",
    s700: "#0F6459", s500: "#2FA598", s400: "#43B5A8", s300: "#63CCBF", s050: "#D8F1ED",
    onAccent: NEAR_BLACK,
  },
  {
    id: "green", label: "Green",
    s700: "#2C6A34", s500: "#57A75F", s400: "#69B871", s300: "#85CC8C", s050: "#DEF1E0",
    onAccent: NEAR_BLACK,
  },
  {
    id: "violet", label: "Violet",
    s700: "#5A4AAE", s500: "#9385E4", s400: "#A395EB", s300: "#B7ABF2", s050: "#E9E4FC",
    onAccent: NEAR_BLACK,
  },
  {
    id: "rose", label: "Rose",
    s700: "#A33A5B", s500: "#E06E90", s400: "#E884A1", s300: "#F09DB5", s050: "#FBDFE7",
    onAccent: NEAR_BLACK,
  },
];

export const DEFAULT_ACCENT = "amber";

export const findAccent = (id) =>
  ACCENTS.find((a) => a.id === id) || ACCENTS.find((a) => a.id === DEFAULT_ACCENT);

/** rgba() string from a hex and an alpha — for tints, glows and the focus ring. */
export function alpha(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * Every token that carries the accent, for one accent.
 * Split by theme because light mode steps down to 700 for anything DRAWN —
 * a mid-tone fill does not clear 3:1 against a near-white ground.
 */
export function accentVars(accent) {
  return {
    shared: {
      "--accent": accent.s500,
      "--accent-hover": accent.s400,
      "--on-accent": accent.onAccent,
      "--focus-ring": `0 0 0 3px ${alpha(accent.s500, 0.35)}`,
      "--accent-glow": alpha(accent.s500, 0.45),
      "--accent-glow-0": alpha(accent.s500, 0),
    },
    dark: {
      "--accent-text": accent.s300,
      "--tint": alpha(accent.s500, 0.14),
      "--accent-border": "transparent",
      "--meter-fill": accent.s500,
      "--wave-played": accent.s500,
    },
    light: {
      "--accent-text": accent.s700,
      "--tint": accent.s050,
      "--accent-border": accent.s700,
      "--meter-fill": accent.s700,
      "--wave-played": accent.s700,
    },
  };
}

/**
 * Apply an accent by writing custom properties onto <html>. Inline properties
 * beat the stylesheet, so this overrides tokens.css without editing it — and
 * clearing them restores the built-in amber exactly.
 */
export function applyAccent(id, theme) {
  const accent = findAccent(id);
  const vars = accentVars(accent);
  const root = document.documentElement;

  const all = { ...vars.shared, ...(theme === "light" ? vars.light : vars.dark) };
  for (const [prop, value] of Object.entries(all)) root.style.setProperty(prop, value);
  root.dataset.accent = accent.id;
}
