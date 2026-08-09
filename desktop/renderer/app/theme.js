/**
 * Theme. Sets `data-theme` on <html>, which is what tokens.css keys off, and
 * keeps the macOS sidebar material in step via nativeTheme.
 */

import { readPersisted, persist } from "./store.js";
import { applyAccent, DEFAULT_ACCENT } from "./accent.js";

const KEY = "theme";               // "system" | "light" | "dark"
const mql = window.matchMedia("(prefers-color-scheme: dark)");

export function preference() {
  return readPersisted(KEY, "system");
}

export function resolved(pref = preference()) {
  return pref === "system" ? (mql.matches ? "dark" : "light") : pref;
}

export const accent = () => readPersisted("accent", DEFAULT_ACCENT);

export function apply(pref = preference()) {
  const theme = resolved(pref);
  document.documentElement.dataset.theme = theme;
  // Light mode steps the accent down to its 700 stop for anything drawn, so
  // the accent has to be re-applied whenever the theme resolves.
  applyAccent(accent(), theme);
  window.vocalis?.setAppearance?.(pref);
}

export function setAccent(id) {
  persist("accent", id);
  applyAccent(id, resolved());
  window.dispatchEvent(new CustomEvent("vocalis:accent", { detail: id }));
}

export const THEMES = ["system", "light", "dark"];

export function setTheme(pref) {
  persist(KEY, pref);
  apply(pref);
  // Both the sidebar switch and the Settings page show theme state; this keeps
  // them in step without either having to know the other exists.
  window.dispatchEvent(new CustomEvent("vocalis:theme", { detail: pref }));
}

/** Cycle System -> Light -> Dark -> System. */
export function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(preference()) + 1) % THEMES.length];
  setTheme(next);
  return next;
}

mql.addEventListener("change", () => {
  if (preference() === "system") apply("system");
});
