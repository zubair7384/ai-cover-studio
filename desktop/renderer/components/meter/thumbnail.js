/**
 * WaveThumb — the 40×40 rounded-8 tile at the head of a cover row (Prompt 2).
 *
 * Distinct from Waveform: that one is a flexible, scrubbable control. This is a
 * fixed-size static tile. Using Waveform here is what produced a stretched
 * hairline — it flexes to fill its row and, with no peaks, draws a flat idle
 * line edge to edge.
 *
 * Until peaks are available the tile is a solid --gr-750 block. Never a dotted
 * or hairline placeholder: an empty tile should read as "not loaded yet", not
 * as a broken rule.
 */

import { el } from "../../lib/dom.js";

export function WaveThumb({ size = 40, peaks = null, ariaLabel = "" } = {}) {
  const canvas = el("canvas", { width: size, height: size, "aria-hidden": "true" });
  const root = el("div", {
    class: "wave-thumb",
    style: { width: `${size}px`, height: `${size}px` },
    role: ariaLabel ? "img" : undefined,
    "aria-label": ariaLabel || undefined,
  }, canvas);

  const ctx = canvas.getContext("2d");
  let data = peaks;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    if (!data?.length) return;   // CSS shows the solid --gr-750 ground

    const cs = getComputedStyle(root);
    ctx.fillStyle = cs.getPropertyValue("--wave-unplayed").trim();

    // 2px bars, 1px gaps — denser than the 3/2 list language so a 40px tile
    // still reads as a waveform rather than four blocks.
    const barW = 2;
    const gap = 1;
    const step = barW + gap;
    const pad = 4;
    const usable = size - pad * 2;
    const bars = Math.max(1, Math.floor((usable + gap) / step));
    const mid = size / 2;

    for (let i = 0; i < bars; i++) {
      const from = Math.floor((i / bars) * data.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * data.length));
      let peak = 0;
      for (let j = from; j < to && j < data.length; j++) if (data[j] > peak) peak = data[j];

      const h = Math.max(2, peak * (usable - 4));
      ctx.beginPath();
      ctx.roundRect(pad + i * step, mid - h / 2, barW, h, 1);
      ctx.fill();
    }
  }

  root.setPeaks = (next) => { data = next; draw(); };

  // Colours come from computed style, so a theme flip needs a repaint.
  const themeObserver = new MutationObserver(draw);
  themeObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme"],
  });
  root.destroy = () => themeObserver.disconnect();

  requestAnimationFrame(draw);
  return root;
}
