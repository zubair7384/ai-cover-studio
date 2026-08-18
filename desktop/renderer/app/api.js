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

  /** Every audio file directly inside a folder. Used by batch and training. */
  scanFolder: (path) => post("/api/audio/scan-folder", { path }),

  /** A cover's intermediate audio — "vocalsFx" or "instrumental". */
  stemUrl: (id, which) =>
    `${base}/api/covers/${encodeURIComponent(id)}/stems/${which}`,
  /** Re-mix a cover at a new balance/speed/format. No model run. */
  remix: ({ id, vocalGainDb = 0, speed = 1, outputFormat = "mp3" }) =>
    post("/api/remix", { id, vocal_gain_db: vocalGainDb, speed,
                         output_format: outputFormat }),

  /** Which of a cover's separated parts are still on disk. */
  stemList: (id) => json(`/api/covers/${encodeURIComponent(id)}/stem-list`),
  /** Export the backing track on its own. Returns a job id. */
  karaoke: ({ id, outputFormat = "mp3" }) =>
    post("/api/karaoke", { id, output_format: outputFormat }),
  /** Write a cover's separated parts into a folder. Returns a job id. */
  exportStems: ({ id, destDir, keys = null, outputFormat = "wav" }) =>
    post("/api/covers/stems/export", { id, dest_dir: destDir, keys,
                                       output_format: outputFormat }),

  /**
   * Key, vocal range and a suggested pitch shift.
   *
   * Seconds on a first read and instant on a repeat, so it is a plain request
   * rather than a job — the control it fills in is waiting on the answer.
   */
  analyse: ({ songPath, voiceId = "", trim = null }) =>
    post("/api/analyse", {
      song_path: songPath,
      model_name: voiceId,
      ...(trim ? { trim_start: trim.start, trim_end: trim.end } : {}),
    }),
  /** Where one voice sits, for the Voices list. */
  voiceProfile: (name) => json(`/api/voices/${encodeURIComponent(name)}/profile`),
  voiceRanges: () => json("/api/voices/ranges"),
  /** State a voice's range by hand, or `{ clear: true }` to forget it. */
  setVoiceProfile: ({ name, range = "", clear = false }) =>
    post("/api/voices/profile", { name, range, clear }),

  /** Project documents. Karaoke, stem export and pack installs are jobs. */
  saveProject: (payload) => post("/api/projects/save", payload),
  openProject: (path) => post("/api/projects/open", { path }),

  packs: () => json("/api/packs"),
  inspectPack: (path) => post("/api/packs/inspect", { path }),
  forgetPack: (id) => post("/api/packs/forget", { id }),

  /** OS speech voices + the engine's input limits. */
  speechVoices: () => json("/api/speech/voices"),

  voices: () => json("/api/models/meta"),
  previewUrl: (name) => `${base}/api/models/preview/${encodeURIComponent(name)}`,
  createPreview: (modelName, referencePath) =>
    post("/api/models/preview", { model_name: modelName, reference_path: referencePath }),
  importModels: (paths) => post("/api/models/import", { paths }),
  renameVoice: (from, to) => post("/api/models/rename", { from, to }),
  deleteVoice: (name) => post("/api/models/delete", { name }),

  /** Browse RVC voices published on Hugging Face. No account, no key. */
  hfVoices: ({ query = "", category = "", gender = "", sort = "popular",
               page = 1, pageSize = 30 } = {}) =>
    json("/api/hf/voices?" + new URLSearchParams({
      query, category, gender, sort, page, page_size: pageSize,
    })),
  // Downloading is not here: it is a job, started through `startDownload` in
  // jobs.js alongside covers and training, so it outlives this screen and can
  // be cancelled from anywhere.
  hfRefresh: () => post("/api/hf/refresh"),
  /** A celebrity portrait, fetched from Wikimedia once and cached on disk. */
  hfPortraitUrl: (name) =>
    `${base}/api/hf/portrait?name=${encodeURIComponent(name)}`,
  /** Where that portrait came from. Cache-only, so it never blocks. */
  hfPortraitCredit: (name) =>
    json(`/api/hf/portrait-credit?name=${encodeURIComponent(name)}`),

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
      else if (msg.type === "error") {
        source.close();
        // `detail` is the traceback and, for a fetch, the downloader's own
        // words. Dropping it is why a failed fetch used to be undiagnosable
        // from inside the app.
        reject(Object.assign(new Error(msg.message), { detail: msg.detail || null }));
      }
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
