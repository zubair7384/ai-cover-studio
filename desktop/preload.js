/**
 * Preload — the only bridge between the sandboxed renderer and Node/Electron.
 * Exposes a minimal, explicit API. Everything else the renderer does via HTTP
 * to the local sidecar (window.vocalis.getConfig() -> port).
 *
 * Grows across Prompts 1, 4 and 5 as the native surface from §9 lands
 * (menu bar, notifications, drag-out, powerSaveBlocker, context menus).
 */
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getConfig: () => ipcRenderer.invoke("vocalis:getConfig"),

  // File pickers
  pickModelFiles: () => ipcRenderer.invoke("vocalis:pickModelFiles"),
  pickVoiceModel: () => ipcRenderer.invoke("vocalis:pickVoiceModel"),
  pickVoiceIndex: () => ipcRenderer.invoke("vocalis:pickVoiceIndex"),
  pickFolder: () => ipcRenderer.invoke("vocalis:pickFolder"),
  saveCover: (name) => ipcRenderer.invoke("vocalis:saveCover", name),
  savePath: (opts) => ipcRenderer.invoke("vocalis:savePath", opts),

  // Files
  downloadTo: (url, dest) => ipcRenderer.invoke("vocalis:downloadTo", url, dest),
  revealPath: (p) => ipcRenderer.invoke("vocalis:revealPath", p),

  // Dock progress bar (§9). value is 0..1; pass -1 or null to clear.
  setProgressBar: (value, options) =>
    ipcRenderer.invoke("vocalis:setProgressBar", value, options),

  // "system" | "light" | "dark" — keeps the macOS sidebar material in step
  // with the theme chosen inside the app.
  setAppearance: (source) => ipcRenderer.invoke("vocalis:setAppearance", source),

  // Settings lives in its own window, macOS-style (§8).
  openSettings: () => ipcRenderer.invoke("vocalis:openSettings"),

  /**
   * Menu-bar and accelerator commands from the main process. The renderer owns
   * routing and selection, so menu items post a verb here rather than acting.
   * @param {(command: string) => void} handler
   */
  onCommand: (handler) => {
    const listener = (_evt, command) => handler(command);
    ipcRenderer.on("vocalis:command", listener);
    return () => ipcRenderer.off("vocalis:command", listener);
  },
};

contextBridge.exposeInMainWorld("vocalis", api);

// Legacy alias. The current renderer/app.js calls window.acs at 15 sites and
// stays untouched until its screens are rebuilt in Prompts 1-6; drop this once
// the last of them is gone.
contextBridge.exposeInMainWorld("acs", api);
