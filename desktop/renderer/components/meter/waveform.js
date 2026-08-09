/**
 * Waveform — §6: "segmented bars, --gr-500 unplayed / --am-500 played, 1px
 * amber playhead." Click and drag to scrub, ←/→ to nudge.
 *
 * Canvas-based because a 3-minute track at 3px bars is ~200 nodes that would
 * otherwise be laid out on every progress tick. Colours are resolved from
 * computed style at paint time, so a theme flip repaints correctly without the
 * component knowing anything about themes.
 */

import { el, on } from "../../lib/dom.js";
import { Readout } from "../primitives/display.js";

/**
 * @param {object} o
 * @param {number[]} [o.peaks=[]]    0..1 amplitudes, any length (resampled)
 * @param {number} [o.progress=0]    0..1
 * @param {number} [o.height=36]
 * @param {number} [o.barWidth=3]    §6 segmented language
 * @param {number} [o.gap=2]
 * @param {string} [o.readout]       mono, e.g. "0:42 / 3:17"
 * @param {Function} [o.onSeek]      (fraction) => void, called live while dragging
 * @param {Function} [o.onSeekEnd]   (fraction) => void, called on release
 * @param {boolean} [o.disabled]     render only, no scrubbing
 * @param {{start:number, end:number}} [o.selection]  trim range, 0..1 each. Bars
 *   outside it dim and two amber handles appear. Omit for a plain scrubber.
 * @param {Function} [o.onSelect]    (start, end) => void, live while dragging
 * @param {Function} [o.onSelectEnd] (start, end) => void, on release
 * @param {Function} [o.formatValue] (fraction) => string, for the handles'
 *   aria-valuetext — a screen reader should hear "1:12", not "34%".
 * @param {string} o.ariaLabel
 */
export function Waveform({
  peaks = [],
  progress = 0,
  height = 36,
  barWidth = 3,
  gap = 2,
  readout,
  onSeek,
  onSeekEnd,
  disabled = false,
  selection = null,
  onSelect,
  onSelectEnd,
  formatValue,
  ariaLabel = "Waveform",
} = {}) {
  const canvas = el("canvas");

  // With a selection the box is a container for two handle sliders, so it stops
  // being a slider itself — one element cannot carry two values.
  const trimming = Boolean(selection);
  const box = el("div", {
    class: "waveform",
    style: { height: `${height}px` },
    role: trimming ? "group" : (disabled ? "img" : "slider"),
    tabindex: (disabled || trimming) ? undefined : "0",
    "aria-label": ariaLabel,
    ...((disabled || trimming) ? {} : {
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(progress * 100)),
    }),
  }, canvas);

  const readoutNode = readout != null ? Readout({ text: readout }) : null;
  if (readoutNode) readoutNode.classList.add("meter__readout");

  const node = el("div", { class: "meter" }, box, readoutNode);

  let data = normalise(peaks);
  let pos = clamp01(progress);
  let range = trimming
    ? { start: clamp01(selection.start), end: clamp01(selection.end) }
    : null;
  const ctx = canvas.getContext("2d");

  /* ---- painting -------------------------------------------------------- */

  // Resolved per paint from computed style, so a theme flip repaints correctly.
  // No literal fallbacks: tokens.css is a <link> in <head> and is always
  // present — a missing token should surface, not be silently papered over.
  function colours() {
    const cs = getComputedStyle(box);
    return {
      played: cs.getPropertyValue("--wave-played").trim(),
      unplayed: cs.getPropertyValue("--wave-unplayed").trim(),
      playhead: cs.getPropertyValue("--accent").trim(),
    };
  }

  function draw() {
    const rect = box.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const step = barWidth + gap;
    const bars = Math.max(1, Math.floor((rect.width + gap) / step));
    const mid = rect.height / 2;
    const c = colours();
    const playedBars = pos * bars;

    for (let i = 0; i < bars; i++) {
      const amp = sampleAt(data, i, bars);
      // Keep a visible floor so silence still reads as a line, not a gap.
      const barH = Math.max(2, amp * (rect.height - 2));
      const x = i * step;
      const y = mid - barH / 2;

      // Outside the trim range the audio is being discarded, so it recedes
      // rather than changing colour — one shape, two weights.
      if (range) {
        const at = (i + 0.5) / bars;
        ctx.globalAlpha = at >= range.start && at <= range.end ? 1 : 0.25;
      }
      ctx.fillStyle = i < playedBars ? c.played : c.unplayed;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barH, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 1px amber playhead
    if (pos > 0 && pos < 1) {
      ctx.fillStyle = c.playhead;
      ctx.fillRect(Math.round(pos * rect.width), 0, 1, rect.height);
    }
  }

  /* ---- interaction ------------------------------------------------------ */

  const fractionFromEvent = (e) => {
    const rect = box.getBoundingClientRect();
    return clamp01((e.clientX - rect.left) / rect.width);
  };

  const setPos = (p, notify) => {
    pos = clamp01(p);
    box.setAttribute("aria-valuenow", String(Math.round(pos * 100)));
    draw();
    if (notify) onSeek?.(pos);
  };

  const offs = [];

  /* ---- trim handles ------------------------------------------------------ */
  // Two real focusable elements rather than hit-testing the canvas: the trim
  // points have to be reachable by keyboard, and a canvas cannot be.

  const handles = {};

  if (trimming) {
    const MIN_SPAN = 0.01;   // never let the two handles cross or coincide

    const applyRange = (next, notify, done) => {
      range = {
        start: clamp01(Math.min(next.start, next.end - MIN_SPAN)),
        end: clamp01(Math.max(next.end, next.start + MIN_SPAN)),
      };
      placeHandles();
      draw();
      if (notify) onSelect?.(range.start, range.end);
      if (done) onSelectEnd?.(range.start, range.end);
    };

    const makeHandle = (which, label) => {
      const node = el("div", {
        class: `waveform__handle waveform__handle--${which}`,
        role: "slider",
        tabindex: "0",
        "aria-label": label,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
      }, el("span", { class: "waveform__grip" }));

      offs.push(on(node, "pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();       // don't scrub the track while trimming it
        node.setPointerCapture(e.pointerId);
        node.dataset.dragging = "true";
      }));

      offs.push(on(node, "pointermove", (e) => {
        if (!node.dataset.dragging) return;
        e.stopPropagation();
        applyRange({ ...range, [which]: fractionFromEvent(e) }, true, false);
      }));

      const end = (e) => {
        if (!node.dataset.dragging) return;
        delete node.dataset.dragging;
        try { node.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        onSelectEnd?.(range.start, range.end);
      };
      offs.push(on(node, "pointerup", end));
      offs.push(on(node, "pointercancel", end));

      offs.push(on(node, "keydown", (e) => {
        const step = e.shiftKey ? 0.05 : 0.005;
        let next = null;
        if (e.key === "ArrowRight") next = range[which] + step;
        else if (e.key === "ArrowLeft") next = range[which] - step;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = 1;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        applyRange({ ...range, [which]: next }, true, true);
      }));

      box.appendChild(node);
      return node;
    };

    handles.start = makeHandle("start", "Trim start");
    handles.end = makeHandle("end", "Trim end");
    node.setSelection = (start, end) => applyRange({ start, end }, false, false);
  }

  function placeHandles() {
    if (!range) return;
    for (const [which, node] of Object.entries(handles)) {
      const value = range[which];
      node.style.left = `${value * 100}%`;
      node.setAttribute("aria-valuenow", String(Math.round(value * 100)));
      if (formatValue) node.setAttribute("aria-valuetext", formatValue(value));
    }
  }

  if (!disabled) {
    let dragging = false;

    offs.push(on(box, "pointerdown", (e) => {
      dragging = true;
      box.setPointerCapture(e.pointerId);
      setPos(fractionFromEvent(e), true);
    }));

    offs.push(on(box, "pointermove", (e) => {
      if (dragging) setPos(fractionFromEvent(e), true);
    }));

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      onSeekEnd?.(pos);
    };
    offs.push(on(box, "pointerup", end));
    offs.push(on(box, "pointercancel", end));

    offs.push(on(box, "keydown", (e) => {
      const bigStep = e.shiftKey ? 0.05 : 0.01;
      let next = null;
      if (e.key === "ArrowRight") next = pos + bigStep;
      else if (e.key === "ArrowLeft") next = pos - bigStep;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 1;
      if (next === null) return;
      e.preventDefault();
      setPos(next, true);
      onSeekEnd?.(pos);
    }));
  }

  /* ---- lifecycle -------------------------------------------------------- */

  const ro = new ResizeObserver(() => draw());
  ro.observe(box);

  // Repaint when the theme flips, since colours are read from computed style.
  const themeObserver = new MutationObserver(() => draw());
  themeObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme"],
  });

  placeHandles();
  requestAnimationFrame(draw);

  node.setProgress = (p) => setPos(p, false);
  node.setPeaks = (p) => { data = normalise(p); draw(); };
  node.setReadout = (text) => { if (readoutNode) readoutNode.textContent = text; };
  node.redraw = draw;
  node.destroy = () => {
    ro.disconnect();
    themeObserver.disconnect();
    offs.forEach((f) => f());
  };

  return node;
}

/* ---- helpers ------------------------------------------------------------ */

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** Coerce to a plain array of 0..1 floats. */
function normalise(peaks) {
  if (!peaks || !peaks.length) return [];
  const arr = Array.from(peaks, (v) => Math.abs(Number(v) || 0));
  const max = Math.max(...arr);
  return max > 0 ? arr.map((v) => v / max) : arr;
}

/** Bucket-max resample: peak-preserving, unlike averaging. */
function sampleAt(data, i, bars) {
  if (!data.length) return 0.06;   // flat idle line
  const from = Math.floor((i / bars) * data.length);
  const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * data.length));
  let peak = 0;
  for (let j = from; j < to && j < data.length; j++) {
    if (data[j] > peak) peak = data[j];
  }
  return peak;
}

/**
 * Compute display peaks from an AudioBuffer. Bucket-max over one channel —
 * enough for a scrubber, and far cheaper than reading every sample per paint.
 */
export function peaksFromAudioBuffer(buffer, buckets = 400) {
  const ch = buffer.getChannelData(0);
  const size = Math.floor(ch.length / buckets) || 1;
  const out = new Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * size;
    for (let j = start; j < start + size && j < ch.length; j++) {
      const v = Math.abs(ch[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}
