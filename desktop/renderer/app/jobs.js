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

/**
 * The engine reports free-text steps ("Step 2/4 — cloning vocals with RVC").
 * Map them onto the three stages the Pipeline shows, so the UI never has to
 * parse prose at render time.
 */
function stageFromStep(step = "") {
  const text = step.toLowerCase();
  if (text.includes("separat")) return "separate";
  if (text.includes("clon") || text.includes("convert")) return "convert";
  if (text.includes("mix") || text.includes("export")) return "mix";
  if (text.includes("polish")) return "convert";
  return null;
}

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

    if (msg.type === "progress") {
      const stageId = stageFromStep(msg.step);
      const stages = { ...job.stages };
      const elapsed = now() - job.startedAt;

      if (stageId) {
        // Close out any earlier stage the moment a later one starts.
        for (const prior of COVER_STAGE_IDS) {
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
      for (const sid of COVER_STAGE_IDS) {
        if (stages[sid] && stages[sid].state !== "done") {
          stages[sid] = { ...stages[sid], state: "done",
            durationSec: elapsed - (stages[sid].startedAt ?? 0) };
        }
      }
      finish({ status: "done", progress: 1, stages, elapsedSec: elapsed,
        etaSec: 0, result: msg.result || null });

      loadCovers();
      window.vocalis.notify({
        title: "Cover generated",
        body: job.name,
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
      window.vocalis.notify({ title: "Cover failed", body: job.name });
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
