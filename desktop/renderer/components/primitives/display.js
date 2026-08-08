/**
 * Display atoms — Badge, Separator, Spinner, EmptyState. §6.
 *
 * These import nothing from button.js or overlay.js, which keeps the module
 * graph acyclic (button.js depends on this file).
 */

import { el, cls, append } from "../../lib/dom.js";
import { icon as makeIcon } from "../../lib/icons.js";

/**
 * Badge / chip. 4px radius.
 * Status is never colour alone (§3) — pass `icon` for ok/error tones.
 * @param {"neutral"|"ok"|"error"|"accent"} [o.tone="neutral"]
 */
export function Badge({ label, tone = "neutral", icon, title } = {}) {
  const node = el("span", {
    class: cls("badge", `badge--${tone}`),
    title: title || undefined,
  });
  if (icon) node.appendChild(makeIcon(icon, 11));
  node.appendChild(document.createTextNode(label));
  return node;
}

/** Hairline rule. `inset` matches the 12px list-row inset from §6. */
export function Separator({ orientation = "horizontal", inset = false } = {}) {
  return el("div", {
    class: cls(
      "separator",
      orientation === "vertical" ? "separator--v" : "separator--h",
      inset && "separator--inset"
    ),
    role: "separator",
    "aria-orientation": orientation,
  });
}

/** Indeterminate spinner. Becomes a static ring under reduced motion. */
export function Spinner({ size = 16, label } = {}) {
  return el("span", {
    class: "spinner",
    style: { width: `${size}px`, height: `${size}px` },
    role: "status",
    "aria-label": label || "Loading",
  });
}

/**
 * Empty state — §6 allows at most three elements: icon, headline, one caption
 * line, plus a single primary action. `action` should be a Button node.
 */
export function EmptyState({ icon = "waveform", title, body, action } = {}) {
  const node = el("div", { class: "empty" },
    el("div", { class: "empty__icon" }, makeIcon(icon, 20)),
    el("div", { class: "empty__title t-title-2" }, title),
    body ? el("div", { class: "empty__body t-caption" }, body) : null,
  );
  if (action) node.appendChild(action);
  return node;
}

/**
 * Mono readout. Every changing number in the app goes through this so it is
 * always tabular and never jitters (§4).
 * @param {"sm"|"lg"} [size="sm"]
 */
export function Readout({ text, size = "sm", tone, ...rest } = {}) {
  return el("span", {
    class: cls("tabular", size === "lg" ? "t-meter-lg" : "t-meter", tone && `readout--${tone}`),
    ...rest,
  }, text);
}

/** Skeleton row for loading states (used in Prompt 7). */
export function Skeleton({ height = 32, width = "100%", radius = "var(--r-card)" } = {}) {
  return el("div", {
    class: "skeleton",
    style: { height: `${height}px`, width, borderRadius: radius },
    "aria-hidden": "true",
  });
}

/** Convenience: a labelled row of children with a section header. */
export function Section({ title, children = [], actions } = {}) {
  const head = el("div", { class: "section__head" },
    el("div", { class: "t-head" }, title),
  );
  if (actions) head.appendChild(el("div", { class: "section__actions" }, actions));
  const node = el("section", { class: "section" }, head);
  append(node, [children]);
  return node;
}
