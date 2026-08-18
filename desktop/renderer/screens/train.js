/**
 * Train a voice — a full-view push (§8), to Prompt 5.
 *
 * Three things the old build got wrong are fixed structurally:
 *
 *   - two dismissible banners ate the top third of the screen. There are no
 *     banners: the dataset guidance is a popover next to its own heading, and
 *     the CPU warning is one inline line directly above Start.
 *   - a bare 0–1000 epoch slider fronted a 1–3 hour commitment. Quality is now
 *     three preset cards carrying real time estimates, with the raw slider
 *     demoted to a collapsed disclosure.
 *   - a large empty log box sat there before training began. The training panel
 *     does not mount at all until a run starts.
 */

import { el, cls, on } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import {
  Button, IconButton, Popover, Select, Sheet, Slider, TextField, Toggle,
} from "../components/primitives/index.js";
import { MeterBar, MeterSegments } from "../components/meter/index.js";
import { getState, set, subscribe, persist, readPersisted } from "../app/store.js";
import { exitFlow, setFlowDirtyCheck } from "../app/router.js";
import { origin } from "../app/api.js";
import { startTraining, cancelJob, getJob, runningJobOfKind } from "../app/jobs.js";
import * as fmt from "../app/format.js";

/** The healthy range, in seconds. */
const TARGET_MIN = 10 * 60;
const TARGET_MAX = 30 * 60;
/** The bar's full scale, so the target band sits meaningfully inside it. */
const SCALE_MAX = 45 * 60;

const SAMPLE_RATES = [
  { value: "32000", label: "32 kHz" },
  { value: "40000", label: "40 kHz" },
  { value: "48000", label: "48 kHz" },
];

/**
 * Wall-clock estimate.
 *
 * This used to be a single hardcoded constant of 1.1 seconds per epoch per
 * minute of audio, which predicted about four seconds an epoch. A measured epoch
 * on an MPS Mac with 3½ minutes of audio took roughly eighty. The card therefore
 * promised half an hour for a run that would have taken most of a day — the kind
 * of wrong number that makes someone start a job they would have refused.
 *
 * So the figure is now measured rather than asserted: every completed run writes
 * back what it actually cost, and later estimates use that. The default below is
 * only what the first run on a new machine has to go on, and it is presented as
 * a range until there is a real measurement to replace it.
 */
const DEFAULT_SEC_PER_EPOCH_PER_MIN = 20;   // one measured MPS run, unloaded ≈ 23
const CALIBRATION_KEY = "trainPace";

/** Seconds per epoch per minute of audio, as last measured on this machine. */
function pace() {
  const saved = Number(readPersisted(CALIBRATION_KEY, 0));
  return saved > 0 ? saved : DEFAULT_SEC_PER_EPOCH_PER_MIN;
}

const isCalibrated = () => Number(readPersisted(CALIBRATION_KEY, 0)) > 0;

/**
 * Record what a finished run cost, so the next estimate is this machine's own
 * number. Ignores anything implausible — a cancelled run reported as done, or a
 * clock jump — rather than poisoning every future estimate with it.
 */
function recordPace({ elapsedSec, epochs: ran, audioSeconds }) {
  const minutes = audioSeconds / 60;
  if (!(elapsedSec > 0) || !(ran > 0) || !(minutes > 0)) return;
  const measured = elapsedSec / (ran * minutes);
  if (measured < 0.5 || measured > 600) return;
  persist(CALIBRATION_KEY, Number(measured.toFixed(2)));
}

/**
 * Quality presets.
 *
 * All three train at 32 kHz and none goes past 150 epochs. The old cards asked
 * for 300 and 500 epochs at 40 kHz, which on the CPU/MPS hardware this app runs
 * on is a multi-day run — a setting nobody ever saw the end of is not a quality
 * option. Cost is linear in both epochs and sample rate, so this is the pair of
 * levers that turns training from "in principle" into "tonight".
 */
const PRESETS = [
  { id: "low", label: "Low", epochs: 50, rate: "32000",
    blurb: "A first listen, quick enough to tell whether the recordings are usable." },
  { id: "standard", label: "Standard", epochs: 100, rate: "32000",
    blurb: "The setting most voices want." },
  { id: "max", label: "Max", epochs: 150, rate: "32000",
    blurb: "As far as it is worth pushing on this hardware." },
];

/** Bounds for the manual slider, kept in step with the presets above. */
const EPOCH_MIN = 50;
const EPOCH_MAX = 150;

const GOOD_RECORDING_TIPS = [
  "One voice only — no backing track, no other singers.",
  "A quiet room. Room tone is fine; traffic and fans are not.",
  "Sing the way you want the model to sing: same range, same style.",
  "Several shorter takes beat one long one.",
  "10–30 minutes total. More than 30 rarely helps.",
];

export function TrainFlow() {
  /* ---- state ----------------------------------------------------------- */

  let clips = [];              // [{ path, name, durationSec, sampleRate, warning }]
  let sampleRate = "32000";
  let preset = "standard";
  let epochs = 100;
  let jobId = null;

  const totalSeconds = () => clips.reduce((n, c) => n + (c.durationSec || 0), 0);
  const existingNames = () => getState().voices.map((v) => v.name.toLowerCase());

  setFlowDirtyCheck(() => clips.length > 0 && !jobId);

  const estimateSeconds = (epochCount) => {
    const minutes = Math.max(1, totalSeconds() / 60);
    return epochCount * minutes * pace();
  };

  /**
   * The estimate as text. Before this machine has been measured the figure is a
   * guess, and a guess printed to the second ("~31:24") reads as a promise — so
   * an uncalibrated estimate is rounded and hedged instead.
   */
  const estimateText = (epochCount) => {
    const seconds = estimateSeconds(epochCount);
    if (isCalibrated()) return `~${fmt.duration(seconds)}`;
    if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
    return `~${(seconds / 3600).toFixed(seconds < 36000 ? 1 : 0)} hr`;
  };

  /* ---- 1. RECORDINGS --------------------------------------------------- */

  const recordingsSection = el("section", { class: "flow__section" });

  async function probe(paths) {
    const res = await fetch(`${origin()}/api/audio/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, target_sample_rate: Number(sampleRate) }),
    }).then((r) => r.json()).catch(() => ({ clips: [] }));
    return res.clips || [];
  }

  async function addPaths(paths) {
    const fresh = paths.filter((p) => !clips.some((c) => c.path === p));
    if (!fresh.length) return;
    const probed = await probe(fresh);
    clips = [...clips, ...probed];
    paintRecordings();
    paintStart();
  }

  async function addFolder(folderPath) {
    const res = await fetch(`${origin()}/api/audio/scan-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath, target_sample_rate: Number(sampleRate) }),
    }).then((r) => r.json()).catch(() => ({ clips: [] }));
    const fresh = (res.clips || []).filter((c) => !clips.some((x) => x.path === c.path));
    clips = [...clips, ...fresh];
    paintRecordings();
    paintStart();
  }

  const removeClip = (path) => {
    clips = clips.filter((c) => c.path !== path);
    paintRecordings();
    paintStart();
  };

  function tipsPopover(anchor) {
    const body = el("div", { style: { maxWidth: "280px" } },
      el("div", { class: "t-body-em", style: { marginBottom: "8px" } },
        "What makes a good recording?"),
      el("ul", { class: "tips" }, ...GOOD_RECORDING_TIPS.map((t) =>
        el("li", { class: "t-caption" }, t))),
    );
    Popover(anchor, body);
  }

  function paintRecordings() {
    recordingsSection.innerHTML = "";

    if (!clips.length) {
      recordingsSection.appendChild(el("div", {
        class: "dropzone", tabindex: "0", role: "button",
        "aria-label": "Drop recordings here, or choose files",
        onclick: chooseFiles,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.code === "Space") { e.preventDefault(); chooseFiles(); }
        },
      },
        el("div", { class: "dropzone__icon" }, makeIcon("mic", 20)),
        el("div", { class: "t-body-em" }, "Drop your recordings here, or choose files"),
        el("div", { class: "t-caption dropzone__hint" }, "A folder works too"),
      ));
      return;
    }

    const total = totalSeconds();
    const under = total < TARGET_MIN;

    // The single most useful piece of feedback on this screen: how much
    // material there is, against the range that actually works.
    const meter = MeterSegments({
      value: Math.min(1, total / SCALE_MAX),
      count: 45,
      under,
      band: { from: TARGET_MIN / SCALE_MAX, to: TARGET_MAX / SCALE_MAX },
      readout: `${fmt.duration(total)} of 10–30 min`,
      ariaLabel: "Recording material against the healthy range",
    });

    const header = el("div", { class: "material" },
      el("div", { class: "t-caption material__hint" }, "More than 30 min rarely helps"),
      meter,
    );

    const list = el("div", { class: "cliplist" });
    clips.forEach((c) => {
      list.appendChild(el("div", { class: cls("clip", c.warning && "clip--warn") },
        el("div", { class: "clip__main" },
          el("div", { class: "clip__name t-body" }, c.name),
          c.warning
            ? el("div", { class: "clip__warn t-caption" }, makeIcon("alert", 11),
                el("span", {}, c.warning))
            : null,
        ),
        el("span", { class: "clip__meta t-caption tabular" },
          [c.durationSec ? fmt.duration(c.durationSec) : "—",
           c.sampleRate ? `${Math.round(c.sampleRate / 1000)} kHz` : null]
            .filter(Boolean).join("  ")),
        IconButton({ icon: "close", label: `Remove ${c.name}`, size: "sm",
          onClick: () => removeClip(c.path) }),
      ));
    });

    recordingsSection.append(header, list, el("div", { class: "cliplist__actions" },
      Button({ label: "Add more", variant: "tertiary", size: "sm", onClick: chooseFiles }),
      Button({ label: "Clear all", variant: "tertiary", size: "sm",
        onClick: () => { clips = []; paintRecordings(); paintStart(); } }),
    ));
  }

  async function chooseFiles() {
    const paths = await window.vocalis.pickAudioFiles?.();
    if (paths?.length) addPaths(paths);
  }

  /* ---- 2. MODEL -------------------------------------------------------- */

  const nameField = TextField({
    label: "Voice name",
    placeholder: "my_voice",
    help: "No spaces or slashes.",
    onInput: () => { validateName(); paintStart(); },
  });

  function validateName() {
    const value = nameField.input.value.trim();
    if (!value) return nameField.setError(null);
    if (/[\s/\\]/.test(value)) return nameField.setError("No spaces or slashes.");
    if (existingNames().includes(value.toLowerCase())) {
      return nameField.setError("You already have a voice with that name.");
    }
    nameField.setError(null);
  }

  const nameValid = () => {
    const v = nameField.input.value.trim();
    return Boolean(v) && !/[\s/\\]/.test(v) && !existingNames().includes(v.toLowerCase());
  };

  /**
   * Change the training rate.
   *
   * A preset carries a rate as well as an epoch count, so this has to be
   * callable from the cards too — and when it is, the Select has to be told,
   * or the form would show 40 kHz while training at 32.
   */
  function setSampleRate(value, { syncSelect = false } = {}) {
    if (value === sampleRate) return;
    sampleRate = value;
    if (syncSelect) rateSelect.input.value = value;
    // Warnings depend on the target rate, so re-probe what is already in.
    if (clips.length) {
      probe(clips.map((c) => c.path)).then((probed) => {
        clips = probed;
        paintRecordings();
      });
    }
  }

  const rateSelect = Select({
    label: "Sample rate",
    options: SAMPLE_RATES,
    value: sampleRate,
    help: "32 kHz trains fastest and is plenty for singing. Higher rates cost "
        + "proportionally more time.",
    onChange: (v) => {
      setSampleRate(v);
      // Each card names a rate as well as an epoch count, so a hand-picked rate
      // that disagrees with the selected card has to release it rather than
      // leave the card asserting a setting that is no longer in force.
      const active = PRESETS.find((p) => p.id === preset);
      if (active && active.rate !== v) { preset = null; paintPresets(); }
    },
  });

  /* ---- 3. QUALITY ------------------------------------------------------ */

  const qualityRow = el("div", { class: "presets" });
  const manualSlider = Slider({
    label: "Epochs", min: EPOCH_MIN, max: EPOCH_MAX, step: 10, value: epochs,
    format: (v) => String(v),
    // The ceiling used to be 1000, which on this hardware is weeks of work
    // reachable by dragging one handle.
    help: `${EPOCH_MIN}–${EPOCH_MAX}. Past ${EPOCH_MAX} the wait grows faster `
        + "than the voice improves.",
    onInput: (v) => { epochs = v; preset = null; paintPresets(); paintStart(); },
  });
  const manual = el("details", { class: "quality__manual" },
    el("summary", { class: "t-body-em" }, "Set epochs manually"),
    manualSlider,
  );

  function paintPresets() {
    qualityRow.innerHTML = "";
    PRESETS.forEach((p) => {
      const card = el("button", {
        type: "button",
        class: cls("preset", preset === p.id && "preset--on"),
        "aria-pressed": preset === p.id ? "true" : "false",
        onclick: () => {
          preset = p.id;
          epochs = p.epochs;
          manualSlider.setValue(p.epochs);
          setSampleRate(p.rate, { syncSelect: true });
          paintPresets();
          paintStart();
        },
      },
        el("div", { class: "preset__name t-body-em" }, p.label),
        el("div", { class: "preset__epochs t-meter tabular" },
          `${p.epochs} epochs · ${Math.round(Number(p.rate) / 1000)} kHz`),
        el("div", { class: "preset__time t-meter tabular" },
          clips.length ? estimateText(p.epochs) : "—"),
        el("div", { class: "preset__blurb t-caption" }, p.blurb),
      );
      qualityRow.appendChild(card);
    });
  }

  // Inline, directly above Start — not a banner.
  const commitLine = el("p", { class: "commit t-caption measure" }, "");
  function paintCommit() {
    if (!clips.length) {
      commitLine.textContent = "Add recordings to see how long this will take.";
      return;
    }
    // The hedge is the honest part on a machine that has never finished a run:
    // the number comes from someone else's hardware until this one has timed
    // itself, and a training run is too long a commitment to overstate.
    commitLine.textContent = isCalibrated()
      ? `About ${fmt.duration(estimateSeconds(epochs))} on this Mac, based on `
        + "your last run. Training uses the CPU — you can keep using Vocalis, "
        + "but other apps may feel slower."
      : `Roughly ${estimateText(epochs)} on this Mac — a first guess, which `
        + "Vocalis replaces with a measurement after one run. Training uses the "
        + "CPU, so other apps may feel slower.";
  }

  /* ---- training panel -------------------------------------------------- */
  // Mounts only once training starts. No empty log box.

  const panel = el("aside", { class: "trainpanel", hidden: true });
  let meterBar = null;
  let sparkline = null;
  let lossHead = null;
  let logBox = null;
  let cancelBtn = null;
  let follow = true;

  function paintPanel() {
    const job = jobId ? getJob(jobId) : null;
    if (!job) {
      panel.hidden = true;
      panel.innerHTML = "";
      meterBar = null;
      cancelBtn = null;
      return;
    }
    panel.hidden = false;

    if (!meterBar) {
      panel.innerHTML = "";
      meterBar = MeterBar({ value: 0, readout: "", readoutSize: "lg",
        ariaLabel: "Training progress" });

      sparkline = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sparkline.setAttribute("class", "sparkline");
      sparkline.setAttribute("width", "100%");
      sparkline.setAttribute("height", "40");
      sparkline.setAttribute("preserveAspectRatio", "none");

      logBox = el("pre", { class: "logbox tabular" });

      const followToggle = Toggle({
        label: "Follow", checked: true,
        onChange: (on) => { follow = on; },
      });

      // The Loss chart and its label are held back until there is a curve to
      // draw. A titled 40px void is the empty black box the redesign set out to
      // remove (§1, U11) — and loss only starts arriving once training proper
      // begins, so a run that fails in preprocessing would otherwise show a
      // heading over nothing for as long as it stays on screen.
      lossHead = el("div", { class: "trainpanel__losshead t-caption" }, "Loss");
      lossHead.hidden = true;
      sparkline.style.display = "none";

      panel.append(
        el("div", { class: "trainpanel__head t-body-em" }, job.name),
        meterBar,
        el("div", { class: "trainpanel__elapsed t-meter tabular" }, ""),
        lossHead,
        sparkline,
        el("details", { class: "trainpanel__log" },
          el("summary", { class: "t-body-em" }, "Show log"),
          el("div", { class: "logbox__bar" },
            followToggle,
            Button({ label: "Copy", variant: "tertiary", size: "sm",
              onClick: () => navigator.clipboard.writeText(
                (getJob(jobId)?.log || []).join("\\n")) }),
          ),
          logBox,
        ),
        el("div", { class: "trainpanel__actions" },
          (cancelBtn = Button({ label: "Cancel training", variant: "destructive",
            size: "sm", onClick: () => confirmCancel(job) })),
        ),
      );
    }

    if (job.status === "running") {
      meterBar.setValue(job.progress);
      // Stopping takes a few seconds: the trainer is signalled and then given
      // time to put its workers down. Without saying so, the panel carried on
      // reporting the step it was told to abandon, and the button read as broken.
      meterBar.setReadout(job.cancelling
        ? "stopping…"
        : (job.epoch
          ? `epoch ${job.epoch} / ${job.totalEpochs}`
          : (job.note || "preparing")));
      const elapsed = panel.querySelector(".trainpanel__elapsed");
      if (elapsed) {
        elapsed.textContent = `elapsed ${fmt.duration(job.elapsedSec)}`
          + (job.etaSec && !job.cancelling
            ? ` · about ${fmt.duration(job.etaSec)} left` : "");
      }
      if (job.cancelling) markCancelling();
    }

    paintSparkline(job.loss || []);

    if (logBox) {
      logBox.textContent = (job.log || []).slice(-400).join("\n");
      if (follow) logBox.scrollTop = logBox.scrollHeight;
    }

    if (job.status === "done") paintPanelDone(job);
    if (job.status === "failed") paintPanelFailed(job);
    if (job.status === "cancelled") paintPanelCancelled(job);
  }

  /** The Cancel button, once pressed, says what it is doing and stops taking clicks. */
  function markCancelling() {
    if (!cancelBtn || cancelBtn.disabled) return;
    cancelBtn.disabled = true;
    const label = cancelBtn.querySelector(".btn__label");
    if (label) label.textContent = "Stopping…";
  }

  function paintSparkline(series) {
    if (!sparkline) return;
    sparkline.innerHTML = "";

    // Two points is the minimum that makes a line. Below that the chart and its
    // label stay out of the layout entirely rather than reserving space for a
    // curve that may never arrive.
    const drawable = series.length >= 2;
    if (lossHead) lossHead.hidden = !drawable;
    sparkline.style.display = drawable ? "" : "none";
    if (!drawable) return;
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const points = series.map((v, i) => {
      const x = (i / (series.length - 1)) * 100;
      const y = 38 - ((v - min) / span) * 36;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("class", "sparkline__line");
    line.setAttribute("points", points);
    line.setAttribute("vector-effect", "non-scaling-stroke");
    sparkline.setAttribute("viewBox", "0 0 100 40");
    sparkline.appendChild(line);
  }

  function paintPanelDone(job) {
    const actions = panel.querySelector(".trainpanel__actions");
    if (!actions || actions.dataset.done) return;
    actions.dataset.done = "1";

    // What this run actually cost, so the next estimate is this machine's own
    // figure rather than a constant baked in by whoever shipped the app.
    recordPace({
      elapsedSec: job.elapsedSec,
      epochs: job.epoch || job.totalEpochs,
      audioSeconds: totalSeconds(),
    });
    actions.innerHTML = "";
    actions.append(
      Button({ label: "Use in a cover", variant: "primary",
        onClick: () => {
          set({ coverDraft: { voiceId: job.name } });
          exitFlow(() => set({ flow: "new-cover" }));
        } }),
      Button({ label: "Create a preview clip", variant: "secondary",
        onClick: () => exitFlow(() => set({ route: "voices" })) }),
    );
  }

  function paintPanelFailed(job) {
    const actions = panel.querySelector(".trainpanel__actions");
    if (!actions || actions.dataset.failed) return;
    actions.dataset.failed = "1";
    actions.innerHTML = "";
    actions.append(
      el("div", { class: "t-body measure", style: { color: "var(--err-text)" } }, job.error),
      Button({ label: "Copy details", variant: "tertiary", size: "sm",
        disabled: !job.errorDetail,
        onClick: () => navigator.clipboard.writeText(job.errorDetail || "") }),
    );
  }

  /**
   * A stopped run is not a failure, so it gets its own ending rather than the
   * red one — and the panel has to stop claiming to be mid-step, which is what
   * made Cancel look like it had done nothing.
   */
  function paintPanelCancelled(job) {
    const actions = panel.querySelector(".trainpanel__actions");
    if (!actions || actions.dataset.cancelled) return;
    actions.dataset.cancelled = "1";
    if (meterBar) meterBar.setReadout("stopped");
    actions.innerHTML = "";
    actions.append(
      el("div", { class: "t-caption measure", style: { color: "var(--text-secondary)" } },
        "Stopped. Any checkpoint already written is kept, so training this voice "
        + "again resumes from it rather than starting over."),
      Button({ label: "Close", variant: "secondary", size: "sm",
        onClick: () => { jobId = null; paintPanel(); paintStart(); } }),
    );
  }

  function confirmCancel(job) {
    const sheet = Sheet({
      title: "Stop training?",
      body: el("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        el("div", {}, "Vocalis signals the trainer and waits for it to put its "
          + "workers down, so this takes a few seconds."),
        el("div", { class: "t-caption", style: { color: "var(--text-secondary)" } },
          "Any checkpoint already written is kept. Training this voice again "
          + "resumes from it."),
      ),
      actions: [
        Button({ label: "Keep training", variant: "secondary", onClick: () => sheet.close() }),
        Button({ label: "Stop", variant: "destructive", fill: true,
          onClick: () => {
            sheet.close();
            markCancelling();
            cancelJob(job.id);
          } }),
      ],
    });
  }

  /* ---- start ----------------------------------------------------------- */

  const startBtn = Button({
    label: "Start training", variant: "primary",
    onClick: () => startRun(),
  });

  function missing() {
    if (!clips.length) return "Add some recordings first.";
    if (!nameValid()) return "Give the voice a valid, unused name.";
    if (totalSeconds() < 60) return "That is not enough material to train on.";
    return null;
  }

  function paintStart() {
    const why = missing();
    const running = jobId && getJob(jobId)?.status === "running";
    startBtn.disabled = Boolean(why) || Boolean(running);
    startBtn.title = why || (running ? "Training is already running." : "");
    paintCommit();
    paintPresets();
  }

  async function startRun() {
    if (missing()) return;
    try {
      jobId = await startTraining({
        name: nameField.input.value.trim(),
        sampleRate,
        epochs,
        paths: clips.map((c) => c.path),
      });
      meterBar = null;
      paintPanel();
      paintStart();
    } catch (err) {
      const sheet = Sheet({
        title: "Couldn't start training",
        body: err.message,
        actions: [Button({ label: "OK", variant: "primary", onClick: () => sheet.close() })],
      });
    }
  }

  /* ---- assembly -------------------------------------------------------- */

  const tipsBtn = IconButton({
    icon: "info", label: "What makes a good recording?", size: "sm",
    onClick: (e) => tipsPopover(e.currentTarget),
  });

  const main = el("div", { class: "flow__main" },
    el("div", { class: "flow__headingrow" },
      el("h2", { class: "flow__heading t-head" }, "Recordings"), tipsBtn),
    recordingsSection,

    el("h2", { class: "flow__heading t-head" }, "Model"),
    el("section", { class: "flow__section flow__grid2" }, nameField, rateSelect),

    el("h2", { class: "flow__heading t-head" }, "Quality"),
    el("section", { class: "flow__section" }, qualityRow, manual),

    commitLine,
  );

  const root = el("div", { class: "flow__split" }, main, panel);

  const offDrag = [
    on(root, "dragover", (e) => { e.preventDefault(); root.classList.add("flow--dragging"); }),
    on(root, "dragleave", (e) => {
      if (e.relatedTarget && root.contains(e.relatedTarget)) return;
      root.classList.remove("flow--dragging");
    }),
    on(root, "drop", async (e) => {
      e.preventDefault();
      root.classList.remove("flow--dragging");
      const files = [...(e.dataTransfer?.files || [])];
      const paths = files.map((f) => window.vocalis.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      // A folder drop arrives as a single entry; scan it rather than rejecting.
      if (files.length === 1 && !/\.[a-z0-9]+$/i.test(files[0].name)) {
        return addFolder(paths[0]);
      }
      addPaths(paths);
    }),
  ];

  // A run started here and then navigated away from is still going, in the
  // store and in the sidecar. Adopt it so this view reports on it again rather
  // than showing a fresh form over the top of live work.
  const alreadyRunning = runningJobOfKind("train");
  if (alreadyRunning) {
    jobId = alreadyRunning.id;
    meterBar = null;
  }

  paintRecordings();
  paintPresets();
  paintStart();
  paintPanel();

  const offs = [
    subscribe(["jobs"], paintPanel),
    subscribe(["voices"], () => { validateName(); paintStart(); }),
  ];

  root.toolbar = {
    title: "Train a voice",
    search: false,
    actions: [startBtn],
    // No Cancel in the header — see new-cover.js. Esc leaves the flow.
  };

  root.destroy = () => {
    offs.forEach((f) => f());
    offDrag.forEach((f) => f());
    setFlowDirtyCheck(null);
  };

  return root;
}
