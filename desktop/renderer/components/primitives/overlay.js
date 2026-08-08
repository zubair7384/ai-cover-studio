/**
 * Layered surfaces — Tooltip, Popover, Sheet, ContextMenu. §6 levels 3 and 4.
 *
 * All of these are keyboard-complete: Escape closes, Tab is trapped inside
 * modal surfaces, and focus returns to whatever opened them (§11).
 */

import { el, cls, append, on, trapFocus, focusFirst, $$ } from "../../lib/dom.js";
import { icon as makeIcon } from "../../lib/icons.js";

/** Every overlay mounts here so stacking order is predictable. */
function layer() {
  let root = document.getElementById("overlay-root");
  if (!root) {
    root = el("div", { id: "overlay-root" });
    document.body.appendChild(root);
  }
  return root;
}

/** Clamp a rect into the viewport with an 8px margin. */
function clamp(x, y, w, hgt) {
  const m = 8;
  return {
    x: Math.max(m, Math.min(x, window.innerWidth - w - m)),
    y: Math.max(m, Math.min(y, window.innerHeight - hgt - m)),
  };
}

/* ---- Tooltip ------------------------------------------------------------ */

const TOOLTIP_DELAY = 450;

/**
 * Attach a tooltip to a node. Shows on hover and on keyboard focus, so it is
 * reachable without a mouse (§11). Returns a disposer.
 */
export function attachTooltip(node, text) {
  if (!text) return () => {};
  let tip = null;
  let timer = 0;

  const show = () => {
    if (tip) return;
    tip = el("div", { class: "tooltip", role: "tooltip" }, text);
    layer().appendChild(tip);
    const a = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    // Prefer below; flip above when there is no room.
    let y = a.bottom + 6;
    if (y + t.height > window.innerHeight - 8) y = a.top - t.height - 6;
    const p = clamp(a.left + a.width / 2 - t.width / 2, y, t.width, t.height);
    tip.style.left = `${p.x}px`;
    tip.style.top = `${p.y}px`;
    requestAnimationFrame(() => tip?.classList.add("tooltip--visible"));
  };

  const hide = () => {
    clearTimeout(timer);
    tip?.remove();
    tip = null;
  };

  const queue = () => { clearTimeout(timer); timer = setTimeout(show, TOOLTIP_DELAY); };

  const offs = [
    on(node, "pointerenter", queue),
    on(node, "pointerleave", hide),
    on(node, "focusin", show),
    on(node, "focusout", hide),
    on(node, "keydown", (e) => { if (e.key === "Escape") hide(); }),
  ];

  return () => { hide(); offs.forEach((f) => f()); };
}

/* ---- Popover — level 3 -------------------------------------------------- */

/**
 * Open a popover anchored to an element.
 * @param {HTMLElement} anchor
 * @param {Node|Node[]} content
 * @returns {{close: Function, node: HTMLElement}}
 */
export function Popover(anchor, content, { placement = "bottom-start", modal = false } = {}) {
  const node = el("div", { class: "popover", role: "dialog" });
  append(node, [content]);
  layer().appendChild(node);

  const a = anchor.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  let x = placement.endsWith("end") ? a.right - r.width : a.left;
  let y = a.bottom + 6;
  if (y + r.height > window.innerHeight - 8) y = a.top - r.height - 6;
  const p = clamp(x, y, r.width, r.height);
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;

  requestAnimationFrame(() => node.classList.add("popover--open"));

  const prevFocus = document.activeElement;
  const offs = [];

  const close = () => {
    offs.forEach((f) => f());
    node.remove();
    if (prevFocus instanceof HTMLElement) prevFocus.focus();
  };

  offs.push(on(document, "keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  }, true));

  // Defer the outside-click listener so the opening click does not close it.
  setTimeout(() => {
    offs.push(on(document, "pointerdown", (e) => {
      if (!node.contains(e.target) && !anchor.contains(e.target)) close();
    }, true));
  }, 0);

  if (modal) offs.push(trapFocus(node));
  focusFirst(node);

  return { node, close };
}

/* ---- Menu / ContextMenu ------------------------------------------------- */

/**
 * @typedef {{label:string, icon?:string, shortcut?:string, destructive?:boolean,
 *            disabled?:boolean, separator?:boolean, onSelect?:Function}} MenuItem
 */

function buildMenu(items, close) {
  const menu = el("div", { class: "menu", role: "menu" });
  items.forEach((it) => {
    if (it.separator) {
      menu.appendChild(el("div", { class: "separator separator--h", role: "separator" }));
      return;
    }
    const item = el("button", {
      type: "button",
      role: "menuitem",
      class: cls("menu__item", it.destructive && "menu__item--destructive"),
      disabled: it.disabled || undefined,
    });
    if (it.icon) item.appendChild(makeIcon(it.icon, 14));
    item.appendChild(el("span", {}, it.label));
    if (it.shortcut) {
      item.appendChild(el("span", { class: "menu__shortcut t-caption" }, it.shortcut));
    }
    item.addEventListener("click", () => { close(); it.onSelect?.(); });
    menu.appendChild(item);
  });

  // ↑/↓ traversal between menu items.
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const opts = $$('[role="menuitem"]:not([disabled])', menu);
    const i = opts.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? opts[(i + 1) % opts.length]
      : opts[(i - 1 + opts.length) % opts.length];
    next?.focus();
  });

  return menu;
}

/** Menu anchored to an element — the "…" button pattern. */
export function Menu(anchor, items) {
  const ref = { close: () => {} };
  const menu = buildMenu(items, () => ref.close());
  const pop = Popover(anchor, menu, { placement: "bottom-end" });
  ref.close = pop.close;
  return pop;
}

/**
 * Right-click menu positioned at the pointer. §9 requires one on every list row.
 */
export function ContextMenu(event, items) {
  event.preventDefault();
  const ref = { close: () => {} };
  const menu = buildMenu(items, () => ref.close());

  const node = el("div", { class: "popover", role: "menu" }, menu);
  layer().appendChild(node);
  const r = node.getBoundingClientRect();
  const p = clamp(event.clientX, event.clientY, r.width, r.height);
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;
  requestAnimationFrame(() => node.classList.add("popover--open"));

  const prevFocus = document.activeElement;
  const offs = [];
  const close = () => {
    offs.forEach((f) => f());
    node.remove();
    if (prevFocus instanceof HTMLElement) prevFocus.focus();
  };
  ref.close = close;

  offs.push(on(document, "keydown", (e) => { if (e.key === "Escape") close(); }, true));
  setTimeout(() => {
    offs.push(on(document, "pointerdown", (e) => {
      if (!node.contains(e.target)) close();
    }, true));
  }, 0);
  focusFirst(node);

  return { node, close };
}

/* ---- Sheet — level 4 ---------------------------------------------------- */

/**
 * Modal sheet. Focus is trapped, Escape closes, focus returns to the opener.
 * @param {object} o
 * @param {string} o.title
 * @param {Node|Node[]|string} o.body
 * @param {Node[]} [o.actions]   Button nodes, rendered right-aligned
 * @param {Function} [o.onClose]
 */
export function Sheet({ title, body, actions = [], onClose, dismissible = true } = {}) {
  const sheet = el("div", {
    class: "sheet",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
  });

  if (title) sheet.appendChild(el("div", { class: "sheet__title t-title-2" }, title));
  if (body) {
    const b = el("div", { class: "sheet__body t-body measure" });
    append(b, [body]);
    sheet.appendChild(b);
  }
  if (actions.length) {
    sheet.appendChild(append(el("div", { class: "sheet__actions" }), [actions]));
  }

  const scrim = el("div", { class: "scrim" }, sheet);
  layer().appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--open"));

  const prevFocus = document.activeElement;
  const offs = [trapFocus(sheet)];

  const close = () => {
    offs.forEach((f) => f());
    scrim.classList.remove("scrim--open");
    const done = () => {
      scrim.remove();
      if (prevFocus instanceof HTMLElement) prevFocus.focus();
      onClose?.();
    };
    // Match the exit transition, but do not strand the node if it never fires.
    scrim.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 250);
  };

  if (dismissible) {
    offs.push(on(document, "keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    }, true));
    offs.push(on(scrim, "pointerdown", (e) => { if (e.target === scrim) close(); }));
  }

  focusFirst(sheet);
  return { node: sheet, close };
}
