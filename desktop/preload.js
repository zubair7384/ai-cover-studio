/**
 * Preload — the only bridge between the sandboxed renderer and Node/Electron.
 * Exposes a minimal, explicit API. Everything else the renderer does via HTTP
 * to the local sidecar (window.vocalis.getConfig() -> port).
 *
 * Grows across Prompts 1, 4 and 5 as the native surface from §9 lands
 * (menu bar, notifications, drag-out, powerSaveBlocker, context menus).
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const api = {
  getConfig: () => ipcRenderer.invoke("vocalis:getConfig"),

  // File pickers
  pickModelFiles: () => ipcRenderer.invoke("vocalis:pickModelFiles"),
  pickVoiceModel: () => ipcRenderer.invoke("vocalis:pickVoiceModel"),
  pickVoiceIndex: () => ipcRenderer.invoke("vocalis:pickVoiceIndex"),
  pickFolder: () => ipcRenderer.invoke("vocalis:pickFolder"),
  pickAudio: (title) => ipcRenderer.invoke("vocalis:pickAudio", title),
  /** Open dialog for the app's own documents — .vocalis and .vocalispack. */
  pickFile: (opts) => ipcRenderer.invoke("vocalis:pickFile", opts),
  pickAudioFiles: (title) => ipcRenderer.invoke("vocalis:pickAudioFiles", title),
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

  // Waveform peaks, cached to disk so a library render never re-decodes audio.
  peaksGet: (key) => ipcRenderer.invoke("vocalis:peaksGet", key),
  peaksPut: (key, value) => ipcRenderer.invoke("vocalis:peaksPut", key, value),

  // Long runs (§9).
  notify: (options) => ipcRenderer.invoke("vocalis:notify", options),
  preventSleep: (prevent) => ipcRenderer.invoke("vocalis:preventSleep", prevent),

  /**
   * Real filesystem path for a dropped File. `File.path` was removed in
   * Electron 32; webUtils.getPathForFile is the supported replacement.
   */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ""; }
  },

  // Local audio bytes, for the Original/Cover A/B.
  readAudio: (filePath) => ipcRenderer.invoke("vocalis:readAudio", filePath),

  // Finder integration (§9).
  startDrag: (filePaths) => ipcRenderer.send("vocalis:startDrag", filePaths),
  quickLook: (filePath) => ipcRenderer.invoke("vocalis:quickLook", filePath),
  exportFiles: (items) => ipcRenderer.invoke("vocalis:exportFiles", items),

  // Pre-redesign cover metadata, stranded under the old file:// origin.
  legacyCoverMeta: () => ipcRenderer.invoke("vocalis:legacyCoverMeta"),

  // Settings window (§8, Prompt 6).
  settingsChrome: (opts) => ipcRenderer.invoke("vocalis:settingsChrome", opts),
  diagnostics: () => ipcRenderer.invoke("vocalis:diagnostics"),
  chooseDataDir: () => ipcRenderer.invoke("vocalis:chooseDataDir"),
  relaunch: () => ipcRenderer.invoke("vocalis:relaunch"),
  broadcastSettings: (payload) => ipcRenderer.send("vocalis:settingsChanged", payload),
  onSettingsChanged: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("vocalis:settingsChanged", listener);
    return () => ipcRenderer.off("vocalis:settingsChanged", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("vocalis:openExternal", url),

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
