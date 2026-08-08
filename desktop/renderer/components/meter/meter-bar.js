/**
 * MeterBar — determinate and indeterminate. §6.
 *
 * "Every Meter carries a mono readout: elapsed, remaining, or n/total."
 * The readout is therefore part of the component, not something callers bolt on.
 */

import { el, cls } from "../../lib/dom.js";
import { Readout } from "../primitives/display.js";

/**
 * @param {object} o
 * @param {number} [o.value=0]        0..1
 * @param {string} [o.readout]        mono text, e.g. "epoch 118 / 300"
 * @param {"lg"|"sm"} [o.readoutSize="sm"]
 * @param {boolean} [o.indeterminate]
 * @param {"accent"|"ok"|"error"} [o.tone="accent"]
 * @param {string} o.ariaLabel        required for screen readers
 */
export function MeterBar({
  value = 0,
  readout,
  readoutSize = "sm",
  indeterminate = false,
  tone = "accent",
  ariaLabel = "Progress",
} = {}) {
  const fill = el("div", { class: "meter-bar__fill" });

  const bar = el("div", {
    class: cls(
      "meter-bar",
      tone !== "accent" && `meter-bar--${tone}`,
      indeterminate && "meter-bar--indeterminate"
    ),
    role: "progressbar",
    "aria-label": ariaLabel,
    ...(indeterminate ? {} : {
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(value * 100)),
    }),
  }, fill);

  const readoutNode = readout != null
    ? Readout({ text: readout, size: readoutSize })
    : null;
  if (readoutNode) readoutNode.classList.add("meter__readout");

  const node = el("div", { class: "meter" }, bar, readoutNode);

  const clampUnit = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  if (!indeterminate) fill.style.width = `${clampUnit(value) * 100}%`;

  /** @param {number} v 0..1 */
  node.setValue = (v) => {
    const u = clampUnit(v);
    fill.style.width = `${u * 100}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(u * 100)));
  };
  node.setReadout = (text) => { if (readoutNode) readoutNode.textContent = text; };
  node.setTone = (t) => {
    bar.classList.remove("meter-bar--ok", "meter-bar--error");
    if (t !== "accent") bar.classList.add(`meter-bar--${t}`);
  };
  node.setIndeterminate = (on) => {
    bar.classList.toggle("meter-bar--indeterminate", !!on);
    if (on) fill.style.width = "";
  };

  return node;
}

/**
 * Circular MeterBar — the 14px ring in the sidebar Activity section (Prompt 1).
 * @param {number} [o.size=14]
 */
export function MeterRing({ value = 0, size = 14, stroke = 2, ariaLabel = "Progress" } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "meter-ring");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "progressbar");
  svg.setAttribute("aria-label", ariaLabel);

  const mk = (className) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("class", className);
    c.setAttribute("cx", String(size / 2));
    c.setAttribute("cy", String(size / 2));
    c.setAttribute("r", String(r));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", String(stroke));
    return c;
  };

  const track = mk("meter-ring__track");
  const fill = mk("meter-ring__fill");
  fill.setAttribute("stroke-dasharray", String(circumference));
  fill.setAttribute("stroke-linecap", "round");
  // Start the arc at 12 o'clock.
  fill.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);

  svg.append(track, fill);

  const apply = (v) => {
    const u = Math.max(0, Math.min(1, Number(v) || 0));
    fill.setAttribute("stroke-dashoffset", String(circumference * (1 - u)));
    svg.setAttribute("aria-valuenow", String(Math.round(u * 100)));
  };
  apply(value);

  svg.setValue = apply;
  return svg;
}
