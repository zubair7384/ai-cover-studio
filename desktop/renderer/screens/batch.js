/**
 * Batch — many songs, one voice, one queue.
 *
 * The shape is New cover's, minus everything that only makes sense for a single
 * track. There is no trim here and no A/B: an in-and-out point chosen for one
 * song would be wrong for the other nine, and there is nothing to compare
 * against while ten renders are still going.
 *
 * What replaces them is the queue itself. The list is the view: every song
 * shows its own state, a failure is reported against the song that failed and
 * the queue carries on, and the whole thing survives navigating away because it
 * lives in the job store like every other long run.
 */

import { el, cls, on } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import {
  Badge, Button, IconButton, Popover, Select, Slider, Toggle,
} from "../components/primitives/index.js";
import { Pipeline, COVER_STAGES } from "../components/meter/index.js";
import { MeterBar } from "../components/meter/meter-bar.js";
import { getState, set, subscribe } from "../app/store.js";
import { exitFlow, setFlowDirtyCheck } from "../app/router.js";
import { api, mediaUrl } from "../app/api.js";
import {
  startBatch, cancelJob, getJob, runningJobOfKind, COVER_STAGE_IDS,
} from "../app/jobs.js";
import { toast } from "../app/toast.js";
import { initials } from "../app/profile.js";
import * as fmt from "../app/format.js";

const DEFAULTS = {
  pitchShift: 0,
  voiceCharacter: 0.75,
  outputFormat: "mp3",
  vocalGain: 0,
  harmonyPreset: "none",
  harmonyGainDb: -9,
  doubleTrack: false,
};

const FORMATS = [
  { value: "mp3", label: "MP3 320" },
  { value: "wav", label: "WAV 24-bit" },
  { value: "flac", label: "FLAC" },
];

const HARMONIES = [
  { value: "none", label: "None" },
  { value: "third-up", label: "A third above" },
  { value: "third-down", label: "A third below" },
  { value: "thirds", label: "Thirds, both sides" },
  { value: "fifth-up", label: "A fifth above" },
  { value: "octave-down", label: "An octave below" },
  { value: "choir", label: "Choir (four parts)" },
];

const AUDIO_RE = /\.(mp3|wav|flac|m4a|ogg|aiff?|aac)$/i;
const MAX_SONGS = 50;

// What each song's row says it is doing. Matches the server's item states.
const STATUS = {
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "error" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export function BatchFlow() {
  /* ---- state ----------------------------------------------------------- */

  const params = { ...DEFAULTS };
  let songs = [];           // [{ path, name }]
  let voiceId = null;
  let jobId = null;

  const voices = () => getState().voices;
  const currentVoice = () => voices().find((v) => v.name === voiceId) || null;
  const job = () => (jobId ? getJob(jobId) : null);
  const running = () => job()?.status === "running";

  setFlowDirtyCheck(() => songs.length > 0 && !jobId);

  /* ---- 1. SONGS -------------------------------------------------------- */

  const songSection = el("section", { class: "flow__section" });

  function addSongs(paths) {
    const known = new Set(songs.map((s) => s.path));
    const fresh = paths
      .filter((p) => p && AUDIO_RE.test(p) && !known.has(p))
      .map((p) => ({ path: p, name: p.split("/").pop() }));

    const room = MAX_SONGS - songs.length;
    if (fresh.length > room) {
      toast({ message: `A batch takes up to ${MAX_SONGS} songs, so ${fresh.length - room} were left out.` });
    }
    songs = [...songs, ...fresh.slice(0, Math.max(0, room))];
    paintSongs();
    paintStart();
  }

  async function chooseSongs() {
    const paths = await window.vocalis.pickAudioFiles("Choose songs");
    if (paths?.length) addSongs(paths);
  }

  async function chooseFolder() {
    const folder = await window.vocalis.pickFolder();
    if (!folder) return;
    // The engine already knows how to read a folder of audio — it does it for
    // training sets — so a folder of songs does not need a second scanner.
    try {
      const { clips } = await api.scanFolder(folder);
      const paths = (clips || []).map((c) => c.path).filter(Boolean);
      if (!paths.length) return toast({ message: "No audio files in that folder." });
      addSongs(paths);
    } catch (err) {
      toast({ message: err.message });
    }
  }

  function removeSong(path) {
    songs = songs.filter((s) => s.path !== path);
    paintSongs();
    paintStart();
  }

  /** Per-song state from the running job, keyed by path. */
  function statusFor(path) {
    return (job()?.items || []).find((i) => i.path === path) || null;
  }

  function paintSongs() {
    songSection.innerHTML = "";

    if (!songs.length) {
      songSection.appendChild(el("div", {
        class: "dropzone", tabindex: "0", role: "button",
        "aria-label": "Drop songs here, or choose files",
        onclick: chooseSongs,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.code === "Space") { e.preventDefault(); chooseSongs(); }
        },
      },
        el("div", { class: "dropzone__icon" }, makeIcon("headphones", 20)),
        el("div", { class: "t-body-em" }, "Drop songs here, or choose files"),
        el("div", { class: "t-caption dropzone__hint" },
          `Up to ${MAX_SONGS} at a time. They run one after another.`),
      ));
      songSection.appendChild(el("div", { class: "batch__pickers" },
        Button({ label: "Choose files…", variant: "secondary", size: "sm",
          onClick: chooseSongs }),
        Button({ label: "Add a folder…", variant: "tertiary", size: "sm",
          onClick: chooseFolder }),
      ));
      return;
    }

    const list = el("ol", { class: "queue", "aria-label": "Songs in this batch" });
    songs.forEach((s, i) => {
      const state = statusFor(s.path);
      const status = STATUS[state?.status || "queued"];
      const row = el("li", {
        class: cls("queue__row", state?.status && `queue__row--${state.status}`),
      },
        el("span", { class: "queue__index t-meter tabular" }, String(i + 1)),
        el("div", { class: "queue__main" },
          el("div", { class: "t-body-em queue__name", title: s.name }, s.name),
          state?.error
            ? el("div", { class: "t-caption queue__error" }, state.error)
            : null,
        ),
        // Only once a run exists: before that, every row would read "Waiting"
        // for no reason.
        jobId ? Badge({ label: status.label, tone: status.tone }) : null,
        // A finished song is playable from here — the whole point of leaving a
        // batch running is coming back to results.
        state?.coverId
          ? Button({ label: "Play", variant: "tertiary", size: "sm",
              onClick: () => set({
                nowPlaying: {
                  id: state.coverId,
                  title: s.name,
                  voice: voiceId,
                  src: mediaUrl(state.coverId),
                },
              }) })
          : null,
        running() || state?.status === "done"
          ? null
          : IconButton({ icon: "close", label: `Remove ${s.name}`, size: "sm",
              onClick: () => removeSong(s.path) }),
      );
      list.appendChild(row);
    });

    songSection.appendChild(list);

    if (!running()) {
      songSection.appendChild(el("div", { class: "batch__pickers" },
        Button({ label: "Add more…", variant: "tertiary", size: "sm",
          onClick: chooseSongs }),
        Button({ label: "Add a folder…", variant: "tertiary", size: "sm",
          onClick: chooseFolder }),
        Button({ label: "Clear", variant: "tertiary", size: "sm",
          onClick: () => { songs = []; paintSongs(); paintStart(); } }),
      ));
    }
  }

  /* ---- 2. VOICE -------------------------------------------------------- */

  const voiceSection = el("section", { class: "flow__section" });

  function openVoicePicker(anchor) {
    const list = el("div", { class: "voicepick" });
    voices().forEach((v) => {
      list.appendChild(el("button", {
        type: "button",
        class: cls("voicepick__row", v.name === voiceId && "voicepick__row--on"),
        onclick: () => { voiceId = v.name; paintVoice(); paintStart(); pop.close(); },
      },
        el("span", { class: "voice-tile voice-tile--sm" }, initials(v.name)),
        el("span", { class: "voicepick__name" }, v.name),
        v.has_index ? Badge({ label: "Index", tone: "ok", icon: "check" }) : null,
      ));
    });
    if (!voices().length) {
      list.appendChild(el("div", { class: "voicepick__empty t-caption" }, "No voices yet."));
    }
    const pop = Popover(anchor, list);
  }

  function paintVoice() {
    voiceSection.innerHTML = "";
    const v = currentVoice();
    voiceSection.appendChild(el("button", {
      type: "button",
      class: "voicerow",
      "aria-haspopup": "dialog",
      disabled: running() || undefined,
      onclick: (e) => openVoicePicker(e.currentTarget),
    },
      el("span", { class: "voice-tile" }, v ? initials(v.name) : "?"),
      el("span", { class: "voicerow__name t-body-em" }, v ? v.name : "Choose a voice"),
      el("span", { class: "voicerow__chevron" }, makeIcon("chevron-down", 14)),
    ));
  }

  /* ---- 3. PROGRESS ----------------------------------------------------- */

  const runSection = el("section", { class: "flow__section" });
  let pipeline = null;
  let meter = null;

  function paintRun() {
    const j = job();
    if (!j) {
      runSection.innerHTML = "";
      runSection.hidden = true;
      pipeline = meter = null;
      return;
    }
    runSection.hidden = false;

    if (j.status !== "running") {
      pipeline = meter = null;
      return paintOutcome(j);
    }

    if (!pipeline) {
      runSection.innerHTML = "";
      pipeline = Pipeline({ stages: COVER_STAGES, ariaLabel: "Current song progress" });
      meter = MeterBar({ value: 0, readout: "", readoutSize: "lg",
                         ariaLabel: "Queue progress" });
      runSection.appendChild(el("div", { class: "runpanel" },
        el("div", { class: "t-body-em runpanel__note" }, ""),
        pipeline,
        meter,
        el("div", { class: "runpanel__actions" },
          Button({ label: "Stop after this song", variant: "tertiary", size: "sm",
            tooltip: "The song under way finishes its current stage, then the queue stops.",
            onClick: () => cancelJob(j.id) }),
        ),
      ));
    }

    COVER_STAGE_IDS.forEach((id) => {
      const st = j.stages[id];
      if (!st) return pipeline.setStage(id, "pending");
      pipeline.setStage(id, st.state, {
        duration: st.durationSec ? fmt.duration(st.durationSec) : undefined,
      });
    });

    meter.setValue(j.progress);
    meter.setReadout(
      `${j.completed ?? 0} of ${j.total ?? songs.length} done  ·  `
      + `${fmt.duration(j.elapsedSec)} elapsed`
      + (j.etaSec ? `  ·  about ${fmt.duration(j.etaSec)} left` : "")
    );
    const note = runSection.querySelector(".runpanel__note");
    if (note) note.textContent = j.note || "";
  }

  function paintOutcome(j) {
    const done = (j.items || []).filter((i) => i.status === "done").length;
    const failed = (j.items || []).filter((i) => i.status === "failed");
    const skipped = (j.items || []).filter((i) => i.status === "skipped").length;

    runSection.innerHTML = "";
    runSection.appendChild(el("div", {
      class: cls("runpanel", failed.length && "runpanel--failed"),
    },
      el("div", { class: "t-body-em" },
        j.status === "cancelled"
          ? `Stopped after ${done} of ${j.total} songs`
          : `${done} cover${done === 1 ? "" : "s"} generated`),
      el("div", { class: "t-caption measure" },
        [failed.length ? `${failed.length} failed` : null,
         skipped ? `${skipped} skipped` : null,
         "They're in your Covers library."].filter(Boolean).join(" · ")),
      el("div", { class: "runpanel__actions" },
        Button({ label: "Go to Covers", variant: "secondary",
          onClick: () => exitFlow(() => set({ route: "covers" })) }),
        Button({ label: "Start another batch", variant: "tertiary",
          onClick: () => {
            jobId = null;
            songs = [];
            paintSongs(); paintVoice(); paintRun(); paintStart();
          } }),
      ),
    ));
  }

  /* ---- Inspector ------------------------------------------------------- */
  // The same settings as a single cover, applied to every song in the queue.
  // Pitch has no suggestion button here on purpose: the right shift depends on
  // the song, and one number chosen from ten different keys would be wrong for
  // most of them.

  const pitch = Slider({
    label: "Pitch shift",
    min: -12, max: 12, step: 1, value: params.pitchShift,
    format: (v) => `${v > 0 ? "+" : ""}${v} st`,
    ticks: [{ label: "−12" }, { label: "0" }, { label: "+12" }],
    help: "Applied to every song in the queue. For a per-song shift, use New cover.",
    onInput: (v) => { params.pitchShift = v; },
  });

  const character = Slider({
    label: "Voice character",
    min: 0, max: 1, step: 0.01, value: params.voiceCharacter,
    format: (v) => Number(v).toFixed(2),
    help: "Higher stays closer to your voice; lower keeps more of the original singer.",
    onInput: (v) => { params.voiceCharacter = v; },
  });

  const format = Select({
    label: "Output format", options: FORMATS, value: params.outputFormat,
    onChange: (v) => { params.outputFormat = v; },
  });

  const harmony = Select({
    label: "Harmony", options: HARMONIES, value: params.harmonyPreset,
    onChange: (v) => { params.harmonyPreset = v; paintCost(); },
  });

  const harmonyGain = Slider({
    label: "Harmony level",
    min: -24, max: -3, step: 1, value: params.harmonyGainDb,
    format: (v) => `${v} dB`,
    onInput: (v) => { params.harmonyGainDb = v; },
  });

  const doubler = Toggle({
    label: "Double the lead",
    checked: params.doubleTrack,
    onChange: (on) => { params.doubleTrack = on; paintCost(); },
  });

  const gain = Slider({
    label: "Vocal gain",
    min: -6, max: 6, step: 0.5, value: params.vocalGain,
    format: (v) => `${v > 0 ? "+" : ""}${v} dB`,
    onInput: (v) => { params.vocalGain = v; },
  });

  const costNote = el("div", { class: "field__help" }, "");

  const COST = {
    none: 0, "third-up": 1, "third-down": 1, thirds: 2,
    "fifth-up": 1, "octave-down": 1, choir: 4,
  };

  function paintCost() {
    const extra = (COST[params.harmonyPreset] || 0) + (params.doubleTrack ? 1 : 0);
    harmonyGain.hidden = params.harmonyPreset === "none";
    costNote.textContent = extra
      ? `${extra + 1} vocal takes per song. A long queue gets a lot longer.`
      : "";
  }
  paintCost();

  const inspector = el("aside", { class: "inspector", "aria-label": "Parameters" },
    el("div", { class: "inspector__body" },
      pitch, character, format,
      el("details", { class: "inspector__advanced" },
        el("summary", { class: "t-body-em" }, "Harmony & doubling"),
        harmony, harmonyGain, doubler, costNote,
      ),
      el("details", { class: "inspector__advanced" },
        el("summary", { class: "t-body-em" }, "Advanced"),
        gain,
      ),
    ),
  );

  /* ---- toolbar --------------------------------------------------------- */

  const startBtn = Button({
    label: "Start batch", variant: "primary",
    onClick: () => start(),
  });

  function missing() {
    if (!songs.length) return "Add some songs first.";
    if (!voiceId) return "Choose a voice first.";
    if (running()) return "This batch is already running.";
    return null;
  }

  function paintStart() {
    const why = missing();
    startBtn.disabled = Boolean(why);
    startBtn.title = why || "";
    const label = songs.length
      ? `Start ${songs.length} song${songs.length === 1 ? "" : "s"}`
      : "Start batch";
    const text = startBtn.querySelector(".btn__label");
    if (text) text.textContent = label;
  }

  async function start() {
    if (missing()) return;
    try {
      jobId = await startBatch({ songs, voiceId, params });
      paintSongs();
      paintVoice();
      paintRun();
      paintStart();
    } catch (err) {
      toast({ message: err.message });
    }
  }

  /* ---- assembly -------------------------------------------------------- */

  const main = el("div", { class: "flow__main" },
    el("h2", { class: "flow__heading t-head" }, "Songs"),
    songSection,
    el("h2", { class: "flow__heading t-head" }, "Voice"),
    voiceSection,
    runSection,
  );

  const root = el("div", { class: "flow__split" }, main, inspector);

  const paintInspector = () => {
    root.dataset.inspector = getState().inspectorVisible ? "shown" : "hidden";
  };
  paintInspector();

  const offDrag = [
    on(root, "dragover", (e) => { e.preventDefault(); root.classList.add("flow--dragging"); }),
    on(root, "dragleave", (e) => {
      if (e.relatedTarget && root.contains(e.relatedTarget)) return;
      root.classList.remove("flow--dragging");
    }),
    on(root, "drop", (e) => {
      e.preventDefault();
      root.classList.remove("flow--dragging");
      if (running()) return;
      const paths = [...(e.dataTransfer?.files || [])]
        .map((f) => window.vocalis.pathForFile(f))
        .filter(Boolean);
      if (paths.length) addSongs(paths);
    }),
  ];

  if (!voiceId && voices().length) {
    voiceId = [...voices()].sort((a, b) => b.modified - a.modified)[0].name;
  }

  // Same for a batch, and here the queue itself comes back too: the job carries
  // every song with its state, which is exactly what this view draws.
  const runningBatch = runningJobOfKind("batch");
  if (runningBatch) {
    jobId = runningBatch.id;
    voiceId = runningBatch.voiceId || voiceId;
    songs = (runningBatch.items || []).map((i) => ({ path: i.path, name: i.name }));
  }

  paintSongs();
  paintVoice();
  paintRun();
  paintStart();

  const offs = [
    subscribe(["inspectorVisible"], paintInspector),
    // The queue rows show per-song state, so they repaint with the job too.
    subscribe(["jobs"], () => { paintRun(); paintSongs(); }),
    subscribe(["voices"], () => { paintVoice(); paintStart(); }),
  ];

  root.toolbar = { title: "Batch", search: false, actions: [startBtn] };

  root.destroy = () => {
    offs.forEach((f) => f());
    offDrag.forEach((f) => f());
    setFlowDirtyCheck(null);
  };

  return root;
}
