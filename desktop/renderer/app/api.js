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
  migrateCovers: (coverMeta) => post("/api/outputs/migrate", { coverMeta }),
  renameCover: (id, title) => post("/api/outputs/title", { id, title }),
  relocateCover: (id, path) => post("/api/outputs/relocate", { id, path }),
  /** trashFile:false forgets the record but leaves the file where it is. */
  deleteCover: (id, trashFile = true) => post("/api/outputs/delete", { id, trashFile }),

  storage: () => json("/api/storage"),
  deleteAllCovers: (trashFiles = true) => post("/api/outputs/delete-all", { trashFiles }),
  clearDownloads: () => post("/api/downloads/clear"),

  /** Resolve a pasted link to a local audio file. Returns a job id. */
  fetchUrl: (url) => post("/api/fetch-url", { url }),

  /** A cover's intermediate audio — "vocalsFx" or "instrumental". */
  stemUrl: (id, which) =>
    `${base}/api/covers/${encodeURIComponent(id)}/stems/${which}`,
  /** Re-mix a cover at a new balance/speed/format. No model run. */
  remix: ({ id, vocalGainDb = 0, speed = 1, outputFormat = "mp3" }) =>
    post("/api/remix", { id, vocal_gain_db: vocalGainDb, speed,
                         output_format: outputFormat }),

  voices: () => json("/api/models/meta"),
  previewUrl: (name) => `${base}/api/models/preview/${encodeURIComponent(name)}`,
  createPreview: (modelName, referencePath) =>
    post("/api/models/preview", { model_name: modelName, reference_path: referencePath }),
  importModels: (paths) => post("/api/models/import", { paths }),
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

/**
 * Drive a backend job to completion over its SSE stream.
 *
 * @param {string} jobId
 * @param {{onProgress?: Function, onLog?: Function}} [handlers]
 * @returns {Promise<object>} the job result, or rejects with the failure message
 */
export function runJob(jobId, { onProgress, onLog } = {}) {
  return new Promise((resolve, reject) => {
    const source = api.jobEvents(jobId);

    source.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === "progress") onProgress?.(msg.fraction, msg.step, msg.note);
      else if (msg.type === "log") onLog?.(msg.line);
      else if (msg.type === "done") { source.close(); resolve(msg.result || {}); }
      else if (msg.type === "error") { source.close(); reject(new Error(msg.message)); }
      // A cancelled job closes its stream with no result. Without this the
      // stream simply ends and the caller is told it lost the engine.
      else if (msg.type === "cancelled") {
        source.close();
        reject(Object.assign(new Error("Cancelled."), { cancelled: true }));
      }
    };

    // A dropped stream must not leave the caller hanging forever.
    source.onerror = () => {
      source.close();
      reject(new Error("Lost contact with the local engine."));
    };
  });
}
