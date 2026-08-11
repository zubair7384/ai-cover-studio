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
import { preference as themePreference, cycleTheme } from "./theme.js";

/** Library rows — the two places (§8). */
const PLACES = [
  { id: "covers", label: "Covers", icon: "waveform", shortcut: "⌘1" },
  { id: "spoken", label: "Spoken", icon: "speech", shortcut: "⌘2" },
  { id: "voices", label: "Voices", icon: "voices", shortcut: "⌘3" },
];

/**
 * The two full-view flows.
 *
 * §8 says actions belong in the toolbar and only places belong here — that rule
 * is what removed the old "Create" section. In practice the flows were
 * undiscoverable: Train a voice existed only as a button on Voices, so you had
 * to already be in the right view to find it. Listed here at the product
 * owner's request, as a deliberate departure.
 */
const FLOW_ROWS = [
  { id: "new-cover", label: "New cover", icon: "plus", shortcut: "⌘N" },
  { id: "speak", label: "Speak", icon: "speech", shortcut: "⌘⇧S" },
  { id: "train", label: "Train a voice", icon: "mic", shortcut: "⌘⇧T" },
];

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
    onclick: () => navigate({ train: "train", speech: "speak" }[job.kind] || "new-cover",
                            { flow: true }),
  },
    el("span", { class: "nav-row__ring" }, ring),
    el("span", { class: "nav-row__label" }, job.name),
    pct,
  );
}

export function Sidebar() {
  // The typeface is the mark now, so there is no glyph beside it and no version
  // badge after it — the version lives in Settings, where it can be read.
  const top = el("div", { class: "sidebar__top" },
    el("div", { class: "wordmark" },
      el("span", { class: "wordmark__name" }, "VOCALIS"),
    ),
  );

  const library = el("nav", { class: "sidebar__section", role: "tablist", "aria-label": "Library" },
    el("div", { class: "sidebar__section-title t-label" }, "Library"),
  );
  const create = el("nav", { class: "sidebar__section", "aria-label": "Create" },
    el("div", { class: "sidebar__section-title t-label" }, "Create"),
  );
  const activity = el("div", { class: "sidebar__section", hidden: true },
    el("div", { class: "sidebar__section-title t-label" }, "Activity"),
  );

  const scroll = el("div", { class: "sidebar__scroll" }, library, create, activity);

  /* ---- account row ------------------------------------------------------ */

  const avatar = el("span", { class: "avatar" });
  const name = el("div", { class: "account__name t-body-em" });

  const settingsRow = navRow(
    { id: "settings", label: "Settings", icon: "gear", shortcut: "⌘," },
    false,
  );
  const footerNav = el("nav", { class: "sidebar__footer-nav", "aria-label": "App" },
    settingsRow);

  const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };
  const THEME_LABEL = { system: "Match the system", light: "Light", dark: "Dark" };

  const themeBtn = IconButton({
    icon: THEME_ICON[themePreference()],
    label: `Appearance: ${THEME_LABEL[themePreference()]}`,
    tooltip: `Appearance: ${THEME_LABEL[themePreference()]}`,
    onClick: () => paintTheme(cycleTheme()),
  });

  function paintTheme(pref = themePreference()) {
    themeBtn.replaceChildren(makeIcon(THEME_ICON[pref], 16));
    const label = `Appearance: ${THEME_LABEL[pref]}`;
    themeBtn.setAttribute("aria-label", label);
    themeBtn.setAttribute("title", label);
  }
  paintTheme();

  const account = el("div", { class: "account" }, avatar, name, themeBtn);

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

  const root = el("aside", { class: "sidebar vibrant" },
    top, scroll, footerNav, account, grip);

  /* ---- painting --------------------------------------------------------- */

  function paintPlaces() {
    const { route, flow } = getState();

    [...library.querySelectorAll(".nav-row")].forEach((n) => n.remove());
    // Selected only when we are actually there. An earlier build kept the place
    // under an open flow marked in a quieter fill so the sidebar showed where
    // Cancel would land; in practice two lit rows read as an ambiguous
    // selection, so the flow row is now the only thing marked.
    PLACES.forEach((p) => library.appendChild(navRow(p, !flow && route === p.id, false)));

    [...create.querySelectorAll(".nav-row")].forEach((n) => n.remove());
    FLOW_ROWS.forEach((f) => create.appendChild(navRow(f, flow === f.id)));

    settingsRow.classList.toggle("nav-row--on", flow === "settings");
    settingsRow.setAttribute("aria-selected", flow === "settings" ? "true" : "false");
  }

  function paintActivity() {
    // §8: "Activity — section appears only when a job is running". Finished and
    // failed jobs stay in the store for their view to report, but they must not
    // sit in the sidebar at 100% forever.
    const running = getState().jobs.filter((j) => j.status === "running");
    [...activity.querySelectorAll(".nav-row")].forEach((n) => n.remove());
    activity.hidden = running.length === 0;
    running.forEach((j) => activity.appendChild(activityRow(j)));
  }

  paintPlaces();
  paintActivity();
  paintAccount();

  const onTheme = () => paintTheme();
  window.addEventListener("vocalis:theme", onTheme);

  const offs = [
    () => window.removeEventListener("vocalis:theme", onTheme),
    subscribe(["route", "flow"], paintPlaces),
    subscribe(["jobs"], paintActivity),
    subscribe(["profile"], paintAccount),
  ];

  root.destroy = () => offs.forEach((f) => f());
  return root;
}
