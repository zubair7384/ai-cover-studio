/**
 * Sidebar — §8. Places belong here; actions belong in the toolbar. That single
 * rule is what removes Home, the "Create" section and the "App" section.
 *
 * 220px, drag-resizable 180–320, width persisted, toggled with ⌃⌘S.
 */

import { el, cls, on } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import { IconButton, Readout } from "../components/primitives/index.js";
import { MeterRing } from "../components/meter/index.js";
import { getState, subscribe, setSidebarWidth } from "./store.js";
import { navigate } from "./router.js";
import { initials } from "./profile.js";

/** Library rows. Two places, nothing else (§8). */
const PLACES = [
  { id: "covers", label: "Covers", icon: "waveform", shortcut: "⌘1" },
  { id: "voices", label: "Voices", icon: "voices", shortcut: "⌘2" },
];

function wordmarkGlyph() {
  // Segmented bars in amber — the Meter language, used as the mark. No gradient.
  const g = el("span", { class: "wordmark__glyph", "aria-hidden": "true" });
  [40, 75, 100, 60, 85].forEach((h) => {
    g.appendChild(el("i", { style: { height: `${h}%` } }));
  });
  return g;
}

function navRow({ id, label, icon, shortcut }, active) {
  const row = el("button", {
    type: "button",
    class: cls("nav-row", active && "nav-row--on"),
    role: "tab",
    "aria-selected": active ? "true" : "false",
    dataset: { place: id },
    onclick: () => navigate(id),
  },
    el("span", { class: "nav-row__icon" }, makeIcon(icon, 16)),
    el("span", { class: "nav-row__label" }, label),
    el("span", { class: "nav-row__shortcut t-caption tabular" }, shortcut),
  );
  return row;
}

function activityRow(job) {
  const ring = MeterRing({ value: job.progress ?? 0, size: 14, ariaLabel: `${job.name} progress` });
  const pct = Readout({ text: `${Math.round((job.progress ?? 0) * 100)}%` });
  pct.classList.add("nav-row__pct");

  return el("button", {
    type: "button",
    class: "nav-row",
    dataset: { job: job.id },
    onclick: () => navigate(job.kind === "train" ? "train" : "new-cover", { flow: true }),
  },
    el("span", { class: "nav-row__ring" }, ring),
    el("span", { class: "nav-row__label" }, job.name),
    pct,
  );
}

export function Sidebar() {
  const version = () => {
    const v = getState().appVersion;
    return v ? `v${v.split(".")[0]}` : "";
  };

  const badge = el("span", { class: "wordmark__badge" }, version());

  const top = el("div", { class: "sidebar__top" },
    el("div", { class: "wordmark" },
      wordmarkGlyph(),
      el("span", { class: "wordmark__name t-head" }, "Vocalis"),
      badge,
    ),
  );

  const library = el("nav", { class: "sidebar__section", role: "tablist", "aria-label": "Library" },
    el("div", { class: "sidebar__section-title t-label" }, "Library"),
  );
  const activity = el("div", { class: "sidebar__section", hidden: true },
    el("div", { class: "sidebar__section-title t-label" }, "Activity"),
  );

  const scroll = el("div", { class: "sidebar__scroll" }, library, activity);

  /* ---- account row ------------------------------------------------------ */

  const avatar = el("span", { class: "avatar" });
  const name = el("div", { class: "account__name t-body-em" });

  const account = el("div", { class: "account" },
    avatar,
    name,
    IconButton({
      icon: "gear",
      label: "Settings",
      size: "sm",
      tooltip: "Settings ⌘,",
      onClick: () => window.vocalis.openSettings(),
    }),
  );

  function paintAccount() {
    const p = getState().profile || { name: "You", avatar: null };
    avatar.innerHTML = "";
    if (p.avatar) avatar.appendChild(el("img", { src: p.avatar, alt: "" }));
    else avatar.textContent = initials(p.name);
    // Email is deliberately absent — the sign-in wall is gone and a local
    // profile has no address to show.
    name.textContent = p.name || "You";
  }

  /* ---- resize grip ------------------------------------------------------ */

  const grip = el("div", {
    class: "sidebar__grip no-drag",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize sidebar",
    tabindex: "0",
  });

  on(grip, "pointerdown", (e) => {
    e.preventDefault();
    grip.dataset.dragging = "";
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => setSidebarWidth(ev.clientX);
    const up = (ev) => {
      delete grip.dataset.dragging;
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* released */ }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // Keyboard-resizable too, so the control is not mouse-only (§11).
  on(grip, "keydown", (e) => {
    const step = e.shiftKey ? 20 : 5;
    if (e.key === "ArrowLeft") setSidebarWidth(getState().sidebarWidth - step);
    else if (e.key === "ArrowRight") setSidebarWidth(getState().sidebarWidth + step);
    else return;
    e.preventDefault();
  });

  const root = el("aside", { class: "sidebar vibrant" }, top, scroll, account, grip);

  /* ---- painting --------------------------------------------------------- */

  function paintPlaces() {
    const { route, flow } = getState();
    [...library.querySelectorAll(".nav-row")].forEach((n) => n.remove());
    PLACES.forEach((p) => library.appendChild(navRow(p, !flow && route === p.id)));
  }

  function paintActivity() {
    const jobs = getState().jobs;
    [...activity.querySelectorAll(".nav-row")].forEach((n) => n.remove());
    // The section only exists while something is running (§8).
    activity.hidden = jobs.length === 0;
    jobs.forEach((j) => activity.appendChild(activityRow(j)));
  }

  paintPlaces();
  paintActivity();
  paintAccount();
  badge.textContent = version();

  const offs = [
    subscribe(["route", "flow"], paintPlaces),
    subscribe(["jobs"], paintActivity),
    subscribe(["profile"], paintAccount),
    subscribe(["appVersion"], () => { badge.textContent = version(); }),
  ];

  root.destroy = () => offs.forEach((f) => f());
  return root;
}
