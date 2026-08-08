/**
 * Sidecar HTTP client.
 *
 * The Python server binds to a random localhost port chosen by main.js; the
 * preload bridge hands it over at boot. Everything except native capabilities
 * goes through here.
 */

import { set, getState } from "./store.js";

let base = "";

export async function init() {
  const cfg = await window.vocalis.getConfig();
  base = `http://127.0.0.1:${cfg.port}`;
  set({ appVersion: cfg.appVersion || "" });
  return cfg;
}

export const origin = () => base;
export const mediaUrl = (name) => `${base}/api/outputs/${encodeURIComponent(name)}`;
export const modelUrl = (name) => `${base}/api/models/file/${encodeURIComponent(name)}`;

async function json(path, options) {
  const res = await fetch(base + path, options);
  if (!res.ok) {
    // §10: errors state what happened, not a status code.
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || `The local engine returned ${res.status}.`);
  }
  return res.json();
}

const post = (path, body) => json(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

export const api = {
  health: () => json("/api/health"),

  covers: () => json("/api/outputs"),
  deleteCover: (name) => post("/api/outputs/delete", { name }),

  voices: () => json("/api/models/meta"),
  renameVoice: (from, to) => post("/api/models/rename", { from, to }),
  deleteVoice: (name) => post("/api/models/delete", { name }),

  /** Server-Sent Events for a running job. Returns an EventSource. */
  jobEvents: (jobId) => new EventSource(`${base}/api/jobs/${jobId}/events`),
};

/* ---- loaders ------------------------------------------------------------ */
// These own the loading/error slices so every view gets consistent states.

// `loading` and `error` are single objects, so every write has to carry the
// sibling key forward or the other view's state is silently wiped.
const patchFlag = (slice, key, value) =>
  set({ [slice]: { ...getState()[slice], [key]: value } });

export async function loadCovers() {
  patchFlag("loading", "covers", true);
  try {
    const { covers } = await api.covers();
    set({ covers: covers || [] });
    patchFlag("error", "covers", null);
  } catch (err) {
    set({ covers: [] });
    patchFlag("error", "covers", err.message);
  } finally {
    patchFlag("loading", "covers", false);
  }
}

export async function loadVoices() {
  patchFlag("loading", "voices", true);
  try {
    const { models } = await api.voices();
    set({ voices: models || [] });
    patchFlag("error", "voices", null);
  } catch (err) {
    set({ voices: [] });
    patchFlag("error", "voices", err.message);
  } finally {
    patchFlag("loading", "voices", false);
  }
}

/** ⌘R — rescan both libraries (§9). */
export function rescan() {
  return Promise.all([loadCovers(), loadVoices()]);
}
