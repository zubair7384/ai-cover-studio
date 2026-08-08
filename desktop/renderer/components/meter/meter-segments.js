/**
 * MeterSegments — §6: "3px-wide bars, 2px gaps, filled left-to-right. Used for
 * level and for discrete stage progress."
 *
 * Also carries the target-band treatment Prompt 5 needs: total recording
 * material measured against a healthy 10–30 minute range, with the band marked
 * on the track and the fill going graphite (not amber) when below range.
 */

import { el } from "../../lib/dom.js";
import { Readout } from "../primitives/display.js";

/**
 * @param {object} o
 * @param {number} [o.value=0]   0..1 — proportion filled
 * @param {number} [o.count=32]  number of segments
 * @param {string} [o.readout]   mono text, e.g. "14 min 20 s of 10–30 min"
 * @param {{from:number,to:number}} [o.band]  target band as 0..1 fractions
 * @param {boolean} [o.under]    below the healthy range — fill graphite not amber
 * @param {string} o.ariaLabel
 */
export function MeterSegments({
  value = 0,
  count = 32,
  readout,
  band,
  under = false,
  ariaLabel = "Level",
} = {}) {
  const track = el("div", {
    class: "meter-seg",
    role: "progressbar",
    "aria-label": ariaLabel,
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": String(Math.round(value * 100)),
  });

  const bars = [];
  for (let i = 0; i < count; i++) {
    const bar = el("div", { class: "meter-seg__bar" });
    bars.push(bar);
    track.appendChild(bar);
  }

  const readoutNode = readout != null ? Readout({ text: readout }) : null;
  if (readoutNode) readoutNode.classList.add("meter__readout");

  const node = el("div", { class: "meter" }, track, readoutNode);

  const paint = (v, isUnder, bandRange) => {
    const u = Math.max(0, Math.min(1, Number(v) || 0));
    const lit = Math.round(u * count);
    bars.forEach((bar, i) => {
      bar.classList.toggle("meter-seg__bar--on", i < lit && !isUnder);
      bar.classList.toggle("meter-seg__bar--under", i < lit && isUnder);
      const inBand = bandRange
        && i >= Math.floor(bandRange.from * count)
        && i < Math.ceil(bandRange.to * count);
      bar.classList.toggle("meter-seg__bar--band", !!inBand);
    });
    track.setAttribute("aria-valuenow", String(Math.round(u * 100)));
  };

  paint(value, under, band);

  node.setValue = (v, opts = {}) =>
    paint(v, opts.under ?? under, opts.band ?? band);
  node.setReadout = (text) => { if (readoutNode) readoutNode.textContent = text; };

  return node;
}

/**
 * Live level meter driven by an AnalyserNode. Returns the node with
 * `.start(analyser)` / `.stop()`; uses rAF so it stops cleanly off-screen.
 */
export function LevelMeter({ count = 24, ariaLabel = "Level" } = {}) {
  const node = MeterSegments({ value: 0, count, ariaLabel });
  let raf = 0;
  let buf = null;

  node.start = (analyser) => {
    buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      // Peak deviation from the 128 centre line, normalised.
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = Math.abs(buf[i] - 128);
        if (d > peak) peak = d;
      }
      node.setValue(Math.min(1, peak / 128));
      raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf);
    tick();
  };

  node.stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    node.setValue(0);
  };

  return node;
}
