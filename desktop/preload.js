/**
 * Preload — the only bridge between the sandboxed renderer and Node/Electron.
 * Exposes a minimal, explicit API. Everything else the renderer does via HTTP
 * to the local sidecar (window.acs.port).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("acs", {
  getConfig: () => ipcRenderer.invoke("acs:getConfig"),
  pickModelFiles: () => ipcRenderer.invoke("acs:pickModelFiles"),
  pickVoiceModel: () => ipcRenderer.invoke("acs:pickVoiceModel"),
  pickVoiceIndex: () => ipcRenderer.invoke("acs:pickVoiceIndex"),
  pickFolder: () => ipcRenderer.invoke("acs:pickFolder"),
  saveCover: (name) => ipcRenderer.invoke("acs:saveCover", name),
  savePath: (opts) => ipcRenderer.invoke("acs:savePath", opts),
  downloadTo: (url, dest) => ipcRenderer.invoke("acs:downloadTo", url, dest),
  revealPath: (p) => ipcRenderer.invoke("acs:revealPath", p),
});
