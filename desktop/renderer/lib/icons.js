/**
 * Icons — inline SVG on a 16px grid, 1.5px stroke, round caps/joins.
 *
 * All paths use `currentColor`, so an icon takes the colour of whatever it
 * sits inside. Sizing is done by the caller via the `size` argument.
 *
 * §11: every icon-only button needs an aria-label — the SVG itself is always
 * aria-hidden, because the label lives on the button.
 */

const PATHS = {
  // navigation / disclosure
  "chevron-down":  '<path d="M4 6.5 8 10.5l4-4"/>',
  "chevron-right": '<path d="M6.5 4 10.5 8l-4 4"/>',
  "chevron-left":  '<path d="M9.5 4 5.5 8l4 4"/>',
  "chevron-up":    '<path d="M4 9.5 8 5.5l4 4"/>',
  check:           '<path d="M3.5 8.5 6.5 11.5 12.5 5"/>',
  minus:           '<path d="M4 8h8"/>',
  plus:            '<path d="M8 3.5v9M3.5 8h9"/>',
  close:           '<path d="M4 4l8 8M12 4l-8 8"/>',
  "more-horizontal": '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',

  // transport
  play:  '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  stop:  '<rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>',

  // domain
  waveform:   '<path d="M2 8h1.5M5 5v6M8 2.5v11M11 5.5v5M14 8h0"/>',
  headphones: '<path d="M3 10V8a5 5 0 0 1 10 0v2"/><rect x="2" y="9.5" width="2.8" height="4" rx="1.2"/><rect x="11.2" y="9.5" width="2.8" height="4" rx="1.2"/>',
  mic:        '<rect x="6" y="2" width="4" height="7" rx="2"/><path d="M4 8a4 4 0 0 0 8 0M8 12v2"/>',
  voices:     '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5a4.5 4.5 0 0 1 9 0"/>',
  // A speech bubble holding three level bars: text going in, audio coming out.
  speech:     '<path d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6a1.7 1.7 0 0 1 1.7 1.7v5.1a1.7 1.7 0 0 1-1.7 1.7H7.4L4.4 13.5v-2.5h-.2A1.7 1.7 0 0 1 2.5 9.3z"/><path d="M5.7 5.9v2.1M8 5.2v3.5M10.3 6.4v1.1"/>',

  // status
  alert: '<path d="M8 2.8 14.2 13.2H1.8z"/><path d="M8 6.6v3M8 11.4h0"/>',
  info:  '<circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.6M8 5.2h0"/>',

  // actions
  search:  '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4 13.5 13.5"/>',
  folder:  '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4l1.4 1.8h5.2A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  export:  '<path d="M8 10.5V2.5M5 5.5 8 2.5l3 3"/><path d="M2.8 10v2.5A1.5 1.5 0 0 0 4.3 14h7.4a1.5 1.5 0 0 0 1.5-1.5V10"/>',
  import:  '<path d="M8 2.5v8M5 7.5 8 10.5l3-3"/><path d="M2.8 10v2.5A1.5 1.5 0 0 0 4.3 14h7.4a1.5 1.5 0 0 0 1.5-1.5V10"/>',
  trash:   '<path d="M2.8 4.5h10.4M6 4.5V3.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.3"/><path d="M4.2 4.5 4.8 13a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.5"/>',
  // A cog: toothed ring + hub. The previous glyph was a circle with eight
  // radial spokes, which at 14px is indistinguishable from a sun icon — it
  // read as a theme toggle rather than Settings.
  gear:    '<circle cx="8" cy="8" r="2.1"/><path d="M12.9 9.6a1.2 1.2 0 0 0 .24 1.32l.04.05a1.45 1.45 0 1 1-2.05 2.05l-.05-.04a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.73 1.1v.13a1.45 1.45 0 1 1-2.9 0v-.07a1.2 1.2 0 0 0-.79-1.1 1.2 1.2 0 0 0-1.32.24l-.05.04a1.45 1.45 0 1 1-2.05-2.05l.04-.05a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.1-.73H.99a1.45 1.45 0 1 1 0-2.9h.07a1.2 1.2 0 0 0 1.1-.79 1.2 1.2 0 0 0-.24-1.32l-.04-.05a1.45 1.45 0 1 1 2.05-2.05l.05.04a1.2 1.2 0 0 0 1.32.24h.06a1.2 1.2 0 0 0 .73-1.1V.99a1.45 1.45 0 1 1 2.9 0v.07a1.2 1.2 0 0 0 .73 1.1 1.2 1.2 0 0 0 1.32-.24l.05-.04a1.45 1.45 0 1 1 2.05 2.05l-.04.05a1.2 1.2 0 0 0-.24 1.32v.06a1.2 1.2 0 0 0 1.1.73h.13a1.45 1.45 0 1 1 0 2.9h-.07a1.2 1.2 0 0 0-1.1.73z" transform="translate(0.6 0.6) scale(0.92)"/>',

  // theme
  sun:     '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"/>',
  moon:    '<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.8 5.8 0 1 0 6.6 6.6z"/>',
  monitor: '<rect x="1.8" y="3" width="12.4" height="8" rx="1.3"/><path d="M6 13.5h4"/>',
};

/**
 * Return an <svg> node for `name`.
 * @param {string} name  key from PATHS
 * @param {number} size  px, defaults to 16
 */
export function icon(name, size = 16, className = "") {
  const d = PATHS[name];
  if (!d) throw new Error(`icon: unknown name "${name}"`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  svg.innerHTML = d;
  return svg;
}

export const iconNames = () => Object.keys(PATHS);
export const hasIcon = (name) => Object.hasOwn(PATHS, name);
