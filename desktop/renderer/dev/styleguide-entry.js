/**
 * Dev-only styleguide surface.
 *
 * This module is NOT referenced by index.html. main.js dynamically imports it
 * after load, and only when `app.isPackaged === false`. `renderer/dev/**` and
 * `renderer/styleguide/**` are excluded from electron-builder's file list, so
 * neither ships in a packaged build.
 *
 * Reachable two ways, both dev-only:
 *   - the route  #/styleguide
 *   - Cmd+Ctrl+G, forwarded from main.js (toggles)
 *
 * It deliberately does not touch the sidebar or the menu bar.
 */

import { renderStyleguide } from "../styleguide/styleguide.js";

const ROUTE = "#/styleguide";
const HOST_ID = "styleguide-host";

/** The app shell's mount point, hidden while the styleguide is up. */
const APP_NODES = ["#root"];

function ensureStylesheet() {
  if (document.querySelector('link[data-styleguide]')) return;
  for (const href of [
    "/components/primitives/primitives.css",
    "/components/meter/meter.css",
    "/styleguide/styleguide.css",
  ]) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.styleguide = "";
    document.head.appendChild(link);
  }
}

function mount() {
  if (document.getElementById(HOST_ID)) return;
  ensureStylesheet();

  APP_NODES.forEach((sel) => {
    const n = document.querySelector(sel);
    if (n) n.dataset.styleguideHidden = n.style.display || "";
    if (n) n.style.display = "none";
  });

  const host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: "fixed", inset: "0", zIndex: "2000",
    background: "var(--bg-content)", overflow: "hidden",
  });
  host.appendChild(renderStyleguide());
  document.body.appendChild(host);

  console.info("[vocalis] styleguide mounted — Cmd+Ctrl+G or Esc to leave");
}

function unmount() {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  host.remove();

  APP_NODES.forEach((sel) => {
    const n = document.querySelector(sel);
    if (n && "styleguideHidden" in n.dataset) {
      n.style.display = n.dataset.styleguideHidden;
      delete n.dataset.styleguideHidden;
    }
  });
}

function sync() {
  if (location.hash === ROUTE) mount();
  else unmount();
}

export function toggle() {
  location.hash = location.hash === ROUTE ? "" : ROUTE;
  // Setting an empty hash does not always fire hashchange; sync directly.
  sync();
}

window.addEventListener("hashchange", sync);

// Esc leaves the styleguide, matching every other full-view surface in the app.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && location.hash === ROUTE) toggle();
});

// main.js calls this over `before-input-event`; exposing it on window is the
// simplest bridge from an injected module back to the main process.
window.__vocalisToggleStyleguide = toggle;

sync();
