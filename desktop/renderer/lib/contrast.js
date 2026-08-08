/**
 * WCAG 2.1 contrast maths.
 *
 * §11 sets the floor: text ≥ 4.5:1, UI and graphics ≥ 3:1. The styleguide
 * renders these live, and scripts/check-contrast.mjs runs the same functions
 * headlessly so a regression fails outside the browser too.
 */

/** "#RGB" | "#RRGGBB" | "rgb(a)()" -> {r,g,b,a} with 0-255 channels. */
export function parseColor(input) {
  const s = String(input).trim();

  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    if (hex.length !== 6) throw new Error(`parseColor: bad hex "${input}"`);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/i);
  if (!m) throw new Error(`parseColor: unrecognised colour "${input}"`);
  let a = m[4] == null ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

/** Composite a possibly-translucent colour over an opaque background. */
export function flatten(fg, bg) {
  const f = typeof fg === "string" ? parseColor(fg) : fg;
  const b = typeof bg === "string" ? parseColor(bg) : bg;
  if (f.a >= 1) return { ...f, a: 1 };
  return {
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
    a: 1,
  };
}

/** Relative luminance, WCAG 2.1 §relative luminance. */
export function luminance(color) {
  const c = typeof color === "string" ? parseColor(color) : color;
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * Contrast ratio between two colours. `fg` may be translucent, in which case it
 * is composited over `bg` first — otherwise the number is meaningless.
 * @returns {number} 1..21
 */
export function contrast(fg, bg) {
  const b = typeof bg === "string" ? parseColor(bg) : bg;
  const f = flatten(fg, b);
  const l1 = luminance(f);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Round to 2dp for display. */
export const ratio = (fg, bg) => Math.round(contrast(fg, bg) * 100) / 100;

/**
 * @param {number} r      contrast ratio
 * @param {"text"|"large"|"ui"} kind
 */
export function passes(r, kind = "text") {
  if (kind === "ui") return r >= 3;
  if (kind === "large") return r >= 3;
  return r >= 4.5;
}

export const REQUIRED = { text: 4.5, large: 3, ui: 3 };
