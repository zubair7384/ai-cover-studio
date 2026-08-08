/**
 * DOM helpers.
 *
 * Every component in this codebase is a factory function that returns a real
 * DOM node — there is no virtual DOM and no build step. These helpers keep
 * that ergonomic and match the `h()` idiom the app already used.
 */

/** Build a node from an HTML string. Returns the first element child. */
export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
}

/**
 * Element factory.
 *   el("button", { class: "btn", onclick: fn, "aria-label": "Play" }, "Text")
 *
 * Keys starting with `on` bind listeners; `style` accepts an object;
 * `dataset` accepts an object; everything else becomes an attribute.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "style" && typeof v === "object") {
      Object.assign(node.style, v);
    } else if (k === "dataset" && typeof v === "object") {
      Object.assign(node.dataset, v);
    } else if (k === "class" || k === "className") {
      node.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

/** Append children of mixed type (node, string, array, null) to a parent. */
export function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Join class names, dropping falsy entries. */
export const cls = (...parts) => parts.flat(Infinity).filter(Boolean).join(" ");

/** Escape a string for safe interpolation into an HTML template. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Bind a listener and return a disposer. Components that attach anything to
 * document/window return one of these so callers can clean up.
 */
export function on(target, type, handler, opts) {
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
}

/** Unique id generator — for label/aria-describedby wiring. */
let _uid = 0;
export const uid = (prefix = "v") => `${prefix}-${++_uid}`;

/** True when the user has asked for reduced motion. */
export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Trap Tab focus inside a container (sheets, popovers). Returns a disposer.
 * Required by §11: full keyboard traversal, no focus escaping a modal.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapFocus(container) {
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = $$(FOCUSABLE, container).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return on(container, "keydown", onKey);
}

/** Focus the first focusable descendant, or the container itself. */
export function focusFirst(container) {
  const first = $$(FOCUSABLE, container).find((n) => n.offsetParent !== null);
  (first || container).focus();
}
