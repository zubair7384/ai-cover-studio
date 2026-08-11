/**
 * Renderer entry point.
 *
 * Order matters: theme before first paint, profile migration before the sidebar
 * reads it, then the shell, then data.
 */

import { $ } from "../lib/dom.js";
import { apply as applyTheme } from "./theme.js";
import { setProfile } from "./store.js";
import { migrateFromAuth } from "./profile.js";
import { init as initApi, loadCovers, loadVoices, rescan } from "./api.js";
import { migrateCoverMetadata } from "./migrate.js";
import { Shell } from "./shell.js";
import { getState, set, setSidebarVisible, setInspectorVisible } from "./store.js";
import { navigate, handleEscape, exitFlow } from "./router.js";

applyTheme();
migrateFromAuth();

const root = $("#root");
const shell = Shell();
root.appendChild(shell);

/* ---- data --------------------------------------------------------------- */

initApi()
  // The migration must land before the first load, or the library renders once
  // with stub records and then jumps.
  .then(() => migrateCoverMetadata())
  .then(() => Promise.all([loadCovers(), loadVoices()]))
  .catch((err) => {
    // The sidecar is started before the window loads, so this only fires if it
    // died. Say what happened rather than leaving empty lists (§10).
    set({
      error: { covers: "The local engine isn't responding. Quit and reopen Vocalis.", voices: null },
      loading: { covers: false, voices: false },
    });
    console.error("[vocalis] sidecar unreachable:", err);
  });

/* ---- keyboard shortcuts (§9) -------------------------------------------- */

const isTextTarget = (t) =>
  t instanceof HTMLElement &&
  (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

window.addEventListener("keydown", (e) => {
  // Esc — cancel a flow, otherwise clear the search field.
  if (e.key === "Escape") {
    if (handleEscape()) e.preventDefault();
    return;
  }

  // Space — play/pause, unless a text field has focus.
  if (e.code === "Space" && !isTextTarget(e.target)) {
    e.preventDefault();
    shell.togglePlayback();
    return;
  }

  // ⌘F, ⌘1, ⌘2, ⌘R and ⌃⌘S are menu-bar accelerators (§9) and arrive via
  // onCommand below. Handling them here as well would fire each verb twice —
  // harmless for navigation, but it would double every rescan.
});

/* ---- menu bar commands from main.js ------------------------------------- */

window.vocalis.onCommand?.((command) => {
  switch (command) {
    case "covers":        navigate("covers"); break;
    case "spoken":        navigate("spoken"); break;
    case "voices":        navigate("voices"); break;
    case "settings":      navigate("settings"); break;
    case "new-cover":     navigate("new-cover"); break;
    case "speak":         navigate("speak"); break;
    case "train":         navigate("train"); break;
    case "toggle-sidebar": shell.toggleSidebar(); break;
    case "toggle-inspector":
      setInspectorVisible(!getState().inspectorVisible);
      break;
    case "search":        shell.focusSearch(); break;
    case "rescan":        rescan(); break;
    case "play-pause":    shell.togglePlayback(); break;
    case "cancel-flow":   exitFlow(); break;
    default: break;
  }
});

// Settings lives in another window with its own memory, so its writes are
// relayed here rather than being picked up by polling localStorage.
window.vocalis.onSettingsChanged?.(({ key, value }) => {
  if (key === "theme" || key === "accent") applyTheme();
  else if (key === "profile") setProfile(value);
});

// Handy during development; harmless in a packaged build.
window.__vocalis = { getState, navigate, setSidebarVisible };
