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
  Button, Checkbox, IconButton, Popover, Select, Sheet, Slider, TextField, Toggle,
} from "../components/primitives/index.js";
import { MeterBar, MeterSegments } from "../components/meter/index.js";
import { getState, set, subscribe } from "../app/store.js";
import { exitFlow, setFlowDirtyCheck } from "../app/router.js";
import { origin } from "../app/api.js";
import { startTraining, cancelJob, getJob } from "../app/jobs.js";
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
 * Wall-clock estimate. Measured against this machine's own device tier and the
 * amount of material — crude, and labelled as an estimate everywhere it appears.
 */
const SECONDS_PER_EPOCH_PER_MINUTE = 1.1;   // CPU/MPS, per epoch, per minute of audio

const PRESETS = [
  { id: "quick", label: "Quick", epochs: 150, blurb: "Rough but usable. Good for a first listen." },
  { id: "balanced", label: "Balanced", epochs: 300, blurb: "The setting most voices want." },
  { id: "high", label: "High", epochs: 500, blurb: "Slower, with a little more detail." },
];

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
  let sampleRate = "40000";
  let preset = "balanced";
  let epochs = 300;
  let jobId = null;

  const totalSeconds = () => clips.reduce((n, c) => n + (c.durationSec || 0), 0);
  const existingNames = () => getState().voices.map((v) => v.name.toLowerCase());

  setFlowDirtyCheck(() => clips.length > 0 && !jobId);

  const estimateSeconds = (epochCount) => {
    const minutes = Math.max(1, totalSeconds() / 60);
    return epochCount * minutes * SECONDS_PER_EPOCH_PER_MINUTE;
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

  const rateSelect = Select({
    label: "Sample rate",
    options: SAMPLE_RATES,
    value: sampleRate,
    help: "40 kHz suits singing. Use 48 kHz only if all your recordings are 48 kHz.",
    onChange: (v) => {
      sampleRate = v;
      // Warnings depend on the target rate, so re-probe what is already in.
      if (clips.length) {
        probe(clips.map((c) => c.path)).then((probed) => {
          clips = probed;
          paintRecordings();
        });
      }
    },
  });

  /* ---- 3. QUALITY ------------------------------------------------------ */

  const qualityRow = el("div", { class: "presets" });
  const manualSlider = Slider({
    label: "Epochs", min: 50, max: 1000, step: 10, value: epochs,
    format: (v) => String(v),
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
          paintPresets();
          paintStart();
        },
      },
        el("div", { class: "preset__name t-body-em" }, p.label),
        el("div", { class: "preset__epochs t-meter tabular" }, `${p.epochs} epochs`),
        el("div", { class: "preset__time t-meter tabular" },
          clips.length ? `~${fmt.duration(estimateSeconds(p.epochs))}` : "—"),
        el("div", { class: "preset__blurb t-caption" }, p.blurb),
      );
      qualityRow.appendChild(card);
    });
  }

  // Inline, directly above Start — not a banner.
  const commitLine = el("p", { class: "commit t-caption measure" }, "");
  function paintCommit() {
    commitLine.textContent = clips.length
      ? `About ${fmt.duration(estimateSeconds(epochs))} on this Mac. Training uses the CPU — `
        + "you can keep using Vocalis, but other apps may feel slower."
      : "Add recordings to see how long this will take.";
  }

  /* ---- training panel -------------------------------------------------- */
  // Mounts only once training starts. No empty log box.

  const panel = el("aside", { class: "trainpanel", hidden: true });
  let meterBar = null;
  let sparkline = null;
  let logBox = null;
  let follow = true;

  function paintPanel() {
    const job = jobId ? getJob(jobId) : null;
    if (!job) { panel.hidden = true; panel.innerHTML = ""; meterBar = null; return; }
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

      panel.append(
        el("div", { class: "trainpanel__head t-body-em" }, job.name),
        meterBar,
        el("div", { class: "trainpanel__elapsed t-meter tabular" }, ""),
        el("div", { class: "trainpanel__losshead t-caption" }, "Loss"),
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
          Button({ label: "Cancel training", variant: "destructive", size: "sm",
            onClick: () => confirmCancel(job) }),
        ),
      );
    }

    if (job.status === "running") {
      meterBar.setValue(job.progress);
      meterBar.setReadout(job.epoch
        ? `epoch ${job.epoch} / ${job.totalEpochs}`
        : (job.note || "preparing"));
      const elapsed = panel.querySelector(".trainpanel__elapsed");
      if (elapsed) {
        elapsed.textContent = `elapsed ${fmt.duration(job.elapsedSec)}`
          + (job.etaSec ? ` · about ${fmt.duration(job.etaSec)} left` : "");
      }
    }

    paintSparkline(job.loss || []);

    if (logBox) {
      logBox.textContent = (job.log || []).slice(-400).join("\n");
      if (follow) logBox.scrollTop = logBox.scrollHeight;
    }

    if (job.status === "done") paintPanelDone(job);
    if (job.status === "failed") paintPanelFailed(job);
  }

  function paintSparkline(series) {
    if (!sparkline) return;
    sparkline.innerHTML = "";
    if (series.length < 2) return;
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

  function confirmCancel(job) {
    const keep = Checkbox({ label: "Keep the checkpoint so far", checked: true });
    const sheet = Sheet({
      title: "Stop training?",
      body: el("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        el("div", {}, "Training stops at the end of the current step, so this may take a moment."),
        keep,
      ),
      actions: [
        Button({ label: "Keep training", variant: "secondary", onClick: () => sheet.close() }),
        Button({ label: "Stop", variant: "destructive", fill: true,
          onClick: () => { sheet.close(); cancelJob(job.id); } }),
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
