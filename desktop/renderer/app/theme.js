/**
 * Theme. Sets `data-theme` on <html>, which is what tokens.css keys off, and
 * keeps the macOS sidebar material in step via nativeTheme.
 */

import { readPersisted, persist } from "./store.js";

const KEY = "theme";               // "system" | "light" | "dark"
const mql = window.matchMedia("(prefers-color-scheme: dark)");

export function preference() {
  return readPersisted(KEY, "system");
}

export function resolved(pref = preference()) {
  return pref === "system" ? (mql.matches ? "dark" : "light") : pref;
}

export function apply(pref = preference()) {
  document.documentElement.dataset.theme = resolved(pref);
  window.vocalis?.setAppearance?.(pref);
}

export function setTheme(pref) {
  persist(KEY, pref);
  apply(pref);
}

mql.addEventListener("change", () => {
  if (preference() === "system") apply("system");
});
