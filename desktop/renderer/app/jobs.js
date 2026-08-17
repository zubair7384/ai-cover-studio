/**
 * Job registry — long runs that outlive the view that started them.
 *
 * A cover takes minutes and a training run takes hours, so neither can live
 * inside a screen component: navigate away and the component is destroyed. Jobs
 * therefore live here, in the store, and the views subscribe. That is what
 * makes "the run continues if I navigate away" true rather than aspirational
 * (§Prompt 4), and it is what feeds the sidebar Activity section.
 *
 * A job also owns its side effects for the whole of its life: the Dock progress
 * bar, sleep prevention, and the completion notification.
 */

import { getState, set } from "./store.js";
import { api, origin, loadCovers, loadVoices } from "./api.js";

export const COVER_STAGE_IDS = ["separate", "convert", "mix"];
export const SPEECH_STAGE_IDS = ["speak", "convert", "export"];

/**
 * The engine reports free-text steps ("Step 2/4 — cloning vocals with RVC").
 * Each pipeline maps them onto the stages its Pipeline meter shows, so the UI
 * never has to parse prose at render time.
 *
 * Keyed by job.kind, which is why a speech job can share watch() with a cover
 * one instead of duplicating the whole SSE reader.
 */
const PIPELINES = {
  cover: {
    stageIds: COVER_STAGE_IDS,
    stageFromStep(text) {
      if (text.includes("separat")) return "separate";
      if (text.includes("clon") || text.includes("convert")) return "convert";
      if (text.includes("mix") || text.includes("export")) return "mix";
      if (text.includes("polish")) return "convert";
      return null;
    },
    doneTitle: "Cover generated",
    failTitle: "Cover failed",
  },
  speech: {
    stageIds: SPEECH_STAGE_IDS,
    // "speak" is tested before "convert" because step 2's wording ("converting
    // to your voice") would otherwise swallow step 1 ("speaking the text").
    stageFromStep(text) {
      if (text.includes("speak")) return "speak";
      if (text.includes("convert") || text.includes("clon")) return "convert";
      if (text.includes("export")) return "export";
      return null;
    },
    doneTitle: "Clip ready",
    failTitle: "Speech failed",
  },
  // A download has no pipeline: it is one long transfer, not a sequence of
  // stages. It is here for the same reason a cover is — it takes minutes, so
  // it must outlive the screen that started it and be cancellable from
  // anywhere.
  download: {
    stageIds: [],
    stageFromStep: () => null,
    doneTitle: "Voice ready",
    failTitle: "Download failed",
    refresh: loadVoices,
  },
  // A batch is a queue of cover runs, so it borrows the cover pipeline for the
  // song currently under way and tracks the rest of the queue in `items`.
  batch: {
    stageIds: COVER_STAGE_IDS,
    stageFromStep: (text) => PIPELINES.cover.stageFromStep(text),
    doneTitle: "Batch finished",
    failTitle: "Batch failed",
  },
  pack: {
    stageIds: [],
    stageFromStep: () => null,
    doneTitle: "Voice pack installed",
    failTitle: "Pack install failed",
    refresh: loadVoices,
  },
};

const pipelineFor = (kind) => PIPELINES[kind] || PIPELINES.cover;

const patch = (id, changes) => {
  const jobs = getState().jobs.map((j) => (j.id === id ? { ...j, ...changes } : j));
  set({ jobs });
  return jobs.find((j) => j.id === id) || null;
};

const now = () => Date.now() / 1000;

/** Dock progress reflects whichever job is furthest from done. */
function syncSideEffects() {
  const running = getState().jobs.filter((j) => j.status === "running");
  if (!running.length) {
    window.vocalis.setProgressBar(-1);
    window.vocalis.preventSleep(false);
    return;
  }
  const slowest = running.reduce((a, b) => (a.progress <= b.progress ? a : b));
  window.vocalis.setProgressBar(slowest.progress);
  window.vocalis.preventSleep(true);
}

/**
 * Start a cover run.
 * @returns {Promise<string>} the job id
 */
export async function startCover({ songPath, songName, voiceId, params, trim }) {
  const { job_id } = await fetch(`${origin()}/api/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_name: voiceId,
      song_path: songPath,
      pitch_shift: params.pitchShift,
      index_rate: params.voiceCharacter,
      vocal_gain_db: params.vocalGain ?? 0,
      output_format: params.outputFormat || "mp3",
      ...harmonyPayload(params),
      // Omitted entirely for a whole-song run, so the engine can tell "no trim"
      // from "a trim that happens to start at zero".
      ...(trim ? { trim_start: trim.start, trim_end: trim.end } : {}),
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "The local engine refused the job.");
    }
    return res.json();
  });

  const job = {
    id: job_id,
    kind: "cover",
    name: songName || "New cover",
    voiceId,
    status: "running",          // running | done | failed | cancelled
    progress: 0,
    stage: null,
    stages: {},                 // id -> { state, startedAt, durationSec }
    startedAt: now(),
    elapsedSec: 0,
    etaSec: null,
    note: "",
    error: null,
    errorDetail: null,
    result: null,
  };
  set({ jobs: [...getState().jobs, job] });
  syncSideEffects();

  watch(job_id);
  return job_id;
}

/**
 * Queue several songs through one voice.
 *
 * One job rather than one per song, because the server runs them in a queue and
 * the thing the user is waiting on is the queue, not any single track. The
 * sidebar therefore shows one row that counts up, not ten rows fighting for
 * space.
 *
 * @returns {Promise<string>} the job id
 */
export async function startBatch({ songs, voiceId, params }) {
  const { job_id, total } = await fetch(`${origin()}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_name: voiceId,
      items: songs.map((s) => ({ path: s.path, name: s.name, title: s.title || "" })),
      pitch_shift: params.pitchShift,
      index_rate: params.voiceCharacter,
      vocal_gain_db: params.vocalGain ?? 0,
      output_format: params.outputFormat || "mp3",
      ...harmonyPayload(params),
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "The local engine refused the batch.");
    }
    return res.json();
  });

  const job = {
    id: job_id,
    kind: "batch",
    name: `${total} song${total === 1 ? "" : "s"}`,
    voiceId,
    status: "running",
    progress: 0,
    stage: null,
    stages: {},
    startedAt: now(),
    elapsedSec: 0,
    etaSec: null,
    note: "",
    error: null,
    errorDetail: null,
    result: null,
    // Per-song state, replaced wholesale by every `batch` event.
    items: songs.map((s, i) => ({ index: i, name: s.name, status: "queued" })),
    completed: 0,
    total,
  };
  set({ jobs: [...getState().jobs, job] });
  syncSideEffects();

  watch(job_id);
  return job_id;
}

/** Extra-vocal settings, in the shape both /api/convert and /api/batch take. */
export function harmonyPayload(params) {
  return {
    harmony_preset: params.harmonyPreset || "none",
    harmony_intervals: params.harmonyIntervals || null,
    harmony_gain_db: params.harmonyGainDb,
    double_track: Boolean(params.doubleTrack),
  };
}

/**
 * Install a voice pack. A job because a pack is several models and can be
 * hundreds of megabytes, and because it changes the voice library when it
 * lands.
 * @returns {Promise<string>} the job id
 */
export async function startPackInstall({ path, name, overwrite = false }) {
  const { job_id } = await fetch(`${origin()}/api/packs/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, overwrite }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "The local engine refused the pack.");
    }
    return res.json();
  });

  const job = {
    id: job_id,
    kind: "pack",
    name: name || "Voice pack",
    status: "running",
    progress: 0,
    stage: null,
    stages: {},
    startedAt: now(),
    elapsedSec: 0,
    etaSec: null,
    note: "",
    error: null,
    errorDetail: null,
    result: null,
  };
  set({ jobs: [...getState().jobs, job] });
  syncSideEffects();

  watch(job_id);
  return job_id;
}

/**
 * Start a speech run. Same job machinery as a cover, but seconds rather than
 * minutes, so the view can afford to stay on screen and wait.
 * @returns {Promise<string>} the job id
 */
export async function startSpeech({ text, voiceId, params }) {
  const { job_id } = await fetch(`${origin()}/api/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_name: voiceId,
      text,
      speech_voice: params.speechVoice || "",
      pitch_shift: params.pitchShift ?? 0,
      index_rate: params.voiceCharacter ?? 0.75,
      rate: params.rate ?? 175,
      output_format: params.outputFormat || "mp3",
      speed: params.speed ?? 1,
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "The local engine refused the job.");
    }
    return res.json();
  });

  const job = {
    id: job_id,
    kind: "speech",
    // The Activity row and the notification both read this, so it is the script
    // rather than a generic label.
    name: text.trim().split(/\s+/).slice(0, 6).join(" ") || "Spoken clip",
    voiceId,
    status: "running",
    progress: 0,
    stage: null,
    stages: {},
    startedAt: now(),
    elapsedSec: 0,
    etaSec: null,
    note: "",
    error: null,
    errorDetail: null,
    result: null,
  };
  set({ jobs: [...getState().jobs, job] });
  syncSideEffects();

  watch(job_id);
  return job_id;
}

/**
 * Start downloading a voice from the online catalog.
 *
 * The whole catalog record is kept on the job, not just the name: the Voices
 * list pins in-progress downloads above everything else, and it has to be able
 * to draw that card even when the voice is not in the current page, filter or
 * search results.
 *
 * @returns {Promise<string>} the job id
 */
export async function startDownload(voice) {
  const { job_id } = await fetch(`${origin()}/api/hf/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: voice.repoId,
      pth_path: voice.pthPath,
      index_path: voice.indexPath || "",
      name: voice.name,
      category: voice.category || "",
      gender: voice.gender || "",
      portrait_name: voice.hasPortrait ? (voice.portraitName || voice.name) : "",
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "The local engine refused the download.");
    }
    return res.json();
  });

  const job = {
    id: job_id,
    kind: "download",
    name: voice.name,
    voiceId: voice.id,
    voice,                      // the full record, so the card can be redrawn
    status: "running",
    progress: 0,
    stage: null,
    stages: {},
    startedAt: now(),
    elapsedSec: 0,
    etaSec: null,
    note: "",
    error: null,
    errorDetail: null,
    result: null,
  };
  set({ jobs: [...getState().jobs, job] });
  syncSideEffects();

  watch(job_id);
  return job_id;
}

/** Every download currently in flight, newest last. */
export const runningDownloads = () =>
  getState().jobs.filter((j) => j.kind === "download" && j.status === "running");

/** The in-flight download for a catalog voice, if any. */
export const downloadFor = (voiceId) =>
  getState().jobs.find((j) => j.kind === "download" && j.voiceId === voiceId
                              && j.status === "running") || null;

/** Attach to a job's SSE stream and keep the store in step. */
function watch(id) {
  const source = api.jobEvents(id);

  // Elapsed has to tick independently of progress events, or the readout
  // freezes during the long silent stretch of separation.
  const ticker = setInterval(() => {
    const job = getState().jobs.find((j) => j.id === id);
    if (!job || job.status !== "running") return;
    patch(id, { elapsedSec: now() - job.startedAt });
  }, 1000);

  const finish = (changes) => {
    clearInterval(ticker);
    source.close();
    patch(id, changes);
    syncSideEffects();
  };

  source.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    const job = getState().jobs.find((j) => j.id === id);
    if (!job) return;

    const cfg = pipelineFor(job.kind);

    // The queue's own state, which arrives between songs rather than with the
    // progress ticks. Kept separate so a failed song can be reported without
    // interrupting the run.
    if (msg.type === "batch") {
      patch(id, {
        items: msg.items || [],
        completed: msg.completed ?? 0,
        total: msg.total ?? job.total,
        note: msg.note || "",
        // Each song separates and converts afresh, so the pipeline meter has to
        // start over rather than showing the last song's finished stages.
        stages: {},
      });
      return;
    }

    if (msg.type === "progress") {
      const stageId = cfg.stageFromStep((msg.step || "").toLowerCase());
      const stages = { ...job.stages };
      const elapsed = now() - job.startedAt;

      if (stageId) {
        // Close out any earlier stage the moment a later one starts.
        for (const prior of cfg.stageIds) {
          if (prior === stageId) break;
          if (stages[prior]?.state === "running") {
            stages[prior] = {
              ...stages[prior],
              state: "done",
              durationSec: elapsed - (stages[prior].startedAt ?? 0),
            };
          }
        }
        if (!stages[stageId]) stages[stageId] = { state: "running", startedAt: elapsed };
      }

      // Linear extrapolation is crude but honest, and it stops being a guess
      // once a stage or two has completed.
      const eta = msg.fraction > 0.02
        ? Math.max(0, (elapsed / msg.fraction) - elapsed)
        : null;

      patch(id, {
        progress: msg.fraction,
        stage: stageId,
        stages,
        note: msg.note || "",
        elapsedSec: elapsed,
        etaSec: eta,
      });
      syncSideEffects();
      return;
    }

    if (msg.type === "done") {
      const elapsed = now() - job.startedAt;
      const stages = { ...job.stages };
      for (const sid of cfg.stageIds) {
        if (stages[sid] && stages[sid].state !== "done") {
          stages[sid] = { ...stages[sid], state: "done",
            durationSec: elapsed - (stages[sid].startedAt ?? 0) };
        }
      }
      finish({ status: "done", progress: 1, stages, elapsedSec: elapsed,
        etaSec: 0, result: msg.result || null });

      // A download refreshes the voice library; everything else, the covers.
      (cfg.refresh || loadCovers)();
      window.vocalis.notify({
        title: cfg.doneTitle,
        // A downloaded model that contradicts its own listing says so here,
        // rather than only inside a screen the user may have navigated away
        // from before it finished.
        body: msg.result?.warning || job.name,
      });
      return;
    }

    if (msg.type === "cancelled") {
      finish({ status: "cancelled", note: "" });
      return;
    }

    if (msg.type === "error") {
      const stages = { ...job.stages };
      if (job.stage) stages[job.stage] = { ...stages[job.stage], state: "failed" };
      finish({
        status: "failed",
        stages,
        error: msg.message || "The run failed.",
        errorDetail: msg.detail || null,
      });
      window.vocalis.notify({ title: cfg.failTitle, body: job.name });
    }
  };

  source.onerror = () => {
    const job = getState().jobs.find((j) => j.id === id);
    if (!job || job.status !== "running") { clearInterval(ticker); source.close(); return; }
    finish({ status: "failed", error: "Lost contact with the local engine." });
  };
}

/**
 * Ask a job to stop. It unwinds at the next stage boundary, so the UI says
 * "Cancelling…" rather than claiming an instant stop.
 */
export async function cancelJob(id) {
  patch(id, { note: "Cancelling — the current stage has to finish first." });
  await fetch(`${origin()}/api/jobs/${id}/cancel`, { method: "POST" }).catch(() => {});
}

/** Drop a finished job from the Activity list. */
export function dismissJob(id) {
  set({ jobs: getState().jobs.filter((j) => j.id !== id) });
  syncSideEffects();
}

export const getJob = (id) => getState().jobs.find((j) => j.id === id) || null;
export const latestCoverJob = () =>
  [...getState().jobs].reverse().find((j) => j.kind === "cover") || null;
export const latestSpeechJob = () =>
  [...getState().jobs].reverse().find((j) => j.kind === "speech") || null;


/* ---- Training ----------------------------------------------------------- */

// Applio prints its own progress; these pull the two numbers worth surfacing
// out of the stream. Both are best-effort — a log format change degrades the
// readout, it does not break the run.
const EPOCH_RE = /epoch\s*[:=]?\s*(\d+)\s*(?:\/|of)\s*(\d+)/i;
const LOSS_RE = /loss(?:_gen|_disc)?\s*[:=]\s*([0-9]*\.?[0-9]+)/i;

/**
 * Start a training run.
 * @returns {Promise<string>} job id
 */
export async function startTraining({ name, sampleRate, epochs, paths, datasetDir }) {
  const { job_id } = await fetch(`${origin()}/api/train`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_name: name,
      sample_rate: String(sampleRate),
      epochs,
      paths: paths || [],
      dataset_dir: datasetDir || "",
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "The local engine refused the job.");
    }
    return res.json();
  });

  const job = {
    id: job_id,
    kind: "train",
    name,
    status: "running",
    progress: 0,
    stage: null,
    stages: {},
    startedAt: now(),
    elapsedSec: 0,
    etaSec: null,
    note: "",
    error: null,
    errorDetail: null,
    result: null,
    // training-specific
    epoch: 0,
    totalEpochs: epochs,
    loss: [],          // sparkline series
    log: [],           // capped; the full stream would grow without bound
  };
  set({ jobs: [...getState().jobs, job] });
  syncSideEffects();
  watchTraining(job_id);
  return job_id;
}

const LOG_CAP = 2000;

function watchTraining(id) {
  const source = api.jobEvents(id);

  const ticker = setInterval(() => {
    const job = getState().jobs.find((j) => j.id === id);
    if (!job || job.status !== "running") return;
    patch(id, { elapsedSec: now() - job.startedAt });
  }, 1000);

  const finish = (changes) => {
    clearInterval(ticker);
    source.close();
    patch(id, changes);
    syncSideEffects();
  };

  source.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    const job = getState().jobs.find((j) => j.id === id);
    if (!job) return;

    if (msg.type === "log") {
      const line = msg.line || "";
      const log = job.log.length >= LOG_CAP
        ? [...job.log.slice(-LOG_CAP + 1), line]
        : [...job.log, line];

      const changes = { log };

      const epochMatch = line.match(EPOCH_RE);
      if (epochMatch) {
        const epoch = Number(epochMatch[1]);
        const total = Number(epochMatch[2]) || job.totalEpochs;
        const elapsed = now() - job.startedAt;
        changes.epoch = epoch;
        changes.totalEpochs = total;
        changes.progress = total ? Math.min(1, epoch / total) : job.progress;
        // Epoch pace is a far better predictor than wall-clock fraction.
        changes.etaSec = epoch > 0 ? Math.max(0, (elapsed / epoch) * (total - epoch)) : null;
        changes.elapsedSec = elapsed;
      }

      const lossMatch = line.match(LOSS_RE);
      if (lossMatch) {
        const value = Number(lossMatch[1]);
        if (Number.isFinite(value)) {
          changes.loss = [...job.loss, value].slice(-240);
        }
      }

      patch(id, changes);
      if (changes.progress !== undefined) syncSideEffects();
      return;
    }

    if (msg.type === "progress") {
      patch(id, {
        note: msg.step || "",
        // Applio's own fraction covers install/preprocess/extract too, so only
        // trust it before the first epoch line arrives.
        progress: job.epoch ? job.progress : msg.fraction,
        elapsedSec: now() - job.startedAt,
      });
      syncSideEffects();
      return;
    }

    if (msg.type === "done") {
      finish({ status: "done", progress: 1, etaSec: 0, result: msg.result || null });
      loadVoices();
      window.vocalis.notify({
        title: "Voice ready",
        body: `${job.name} finished training.`,
      });
      return;
    }

    if (msg.type === "cancelled") {
      finish({ status: "cancelled" });
      return;
    }

    if (msg.type === "error") {
      finish({
        status: "failed",
        error: msg.message || "Training failed.",
        errorDetail: msg.detail || null,
      });
      window.vocalis.notify({ title: "Training failed", body: job.name });
    }
  };

  source.onerror = () => {
    const job = getState().jobs.find((j) => j.id === id);
    if (!job || job.status !== "running") { clearInterval(ticker); source.close(); return; }
    finish({ status: "failed", error: "Lost contact with the local engine." });
  };
}
