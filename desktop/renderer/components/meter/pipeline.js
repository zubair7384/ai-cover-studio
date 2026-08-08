/**
 * Pipeline — §6. Replaces the dead grey chips from the old build.
 *
 * "Horizontal, three stages, each with: a state dot (pending hollow / running
 * amber pulsing / done green check / failed red), a label, and a mono duration
 * once complete. Stages connected by a hairline that fills amber as it
 * advances."
 *
 * §3: status is never colour alone — done carries a check glyph, failed carries
 * a cross, and every stage exposes its state as text to screen readers.
 */

import { el, cls } from "../../lib/dom.js";
import { icon as makeIcon } from "../../lib/icons.js";

const STATES = ["pending", "running", "done", "failed"];

const STATE_WORD = {
  pending: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
};

/**
 * @param {object} o
 * @param {Array<{id:string,label:string}>} o.stages
 * @param {string} [o.ariaLabel="Progress"]
 */
export function Pipeline({ stages = [], ariaLabel = "Progress" } = {}) {
  const node = el("div", {
    class: "pipeline",
    role: "list",
    "aria-label": ariaLabel,
  });

  /** @type {Map<string, {root:HTMLElement, dot:HTMLElement, duration:HTMLElement, status:HTMLElement}>} */
  const parts = new Map();
  const connectors = [];

  stages.forEach((stage, i) => {
    if (i > 0) {
      const c = el("div", { class: "pipeline__connector", "aria-hidden": "true" });
      connectors.push(c);
      node.appendChild(c);
    }

    const dot = el("span", { class: "pipeline__dot" });
    const duration = el("span", { class: "pipeline__duration t-meter tabular" }, "");
    // Screen readers get the state as a word, not just a colour.
    const status = el("span", { class: "sr-only" }, STATE_WORD.pending);

    const root = el("div", {
      class: "pipeline__stage pipeline__stage--pending",
      role: "listitem",
      dataset: { stage: stage.id },
    },
      dot,
      el("span", { class: "pipeline__label t-caption" }, stage.label),
      duration,
      status,
    );

    parts.set(stage.id, { root, dot, duration, status });
    node.appendChild(root);
  });

  /**
   * @param {string} id
   * @param {"pending"|"running"|"done"|"failed"} state
   * @param {{duration?: string}} [opts]  duration is a preformatted mono string
   */
  node.setStage = (id, state, opts = {}) => {
    if (!STATES.includes(state)) throw new Error(`Pipeline: bad state "${state}"`);
    const p = parts.get(id);
    if (!p) throw new Error(`Pipeline: unknown stage "${id}"`);

    p.root.className = cls("pipeline__stage", `pipeline__stage--${state}`);
    p.status.textContent = STATE_WORD[state];

    p.dot.innerHTML = "";
    if (state === "done") p.dot.appendChild(makeIcon("check", 9));
    if (state === "failed") p.dot.appendChild(makeIcon("close", 9));

    if (opts.duration != null) p.duration.textContent = opts.duration;
    if (state === "pending") p.duration.textContent = "";

    repaintConnectors();
  };

  node.setDuration = (id, text) => {
    const p = parts.get(id);
    if (p) p.duration.textContent = text ?? "";
  };

  node.getState = (id) => {
    const p = parts.get(id);
    if (!p) return null;
    return STATES.find((s) => p.root.classList.contains(`pipeline__stage--${s}`)) || "pending";
  };

  node.reset = () => {
    stages.forEach((s) => node.setStage(s.id, "pending"));
  };

  /** A connector is full once the stage on its left has completed. */
  function repaintConnectors() {
    connectors.forEach((c, i) => {
      const left = stages[i];
      const state = node.getState(left.id);
      c.style.setProperty("--fill", state === "done" ? "100%" : "0%");
    });
  }

  repaintConnectors();
  return node;
}

/** The three stages of a cover run (Prompt 4). */
export const COVER_STAGES = [
  { id: "separate", label: "Separating vocals" },
  { id: "convert", label: "Converting" },
  { id: "mix", label: "Mixing" },
];
