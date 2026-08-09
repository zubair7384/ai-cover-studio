/**
 * New cover — a full-view push over the library (§8), to Prompt 4.
 *
 * Two bugs from the old build are structural here, not cosmetic:
 *
 *   - the sticky "Generate cover" bar used to sit over scrolling parameter text
 *     and clip it. Every parameter now lives in the Inspector, so nothing
 *     sticky overlaps anything scrolling.
 *   - a giant empty "Final mixed cover" panel used to occupy ~45% of the screen
 *     before a run started. The RESULT section renders NOTHING until a run
 *     begins.
 *
 * The three sections are three states of one object: song, voice, result.
 */

import { el, cls, on } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import {
  Badge, Button, IconButton, Popover, Select, Slider, Segmented,
} from "../components/primitives/index.js";
import { Waveform, Pipeline, COVER_STAGES } from "../components/meter/index.js";
import { MeterBar } from "../components/meter/meter-bar.js";
import { getState, set, subscribe } from "../app/store.js";
import { exitFlow, setFlowDirtyCheck } from "../app/router.js";
import { api, mediaUrl } from "../app/api.js";
import { startCover, cancelJob, getJob, COVER_STAGE_IDS } from "../app/jobs.js";
import { initials } from "../app/profile.js";
import * as fmt from "../app/format.js";

const DEFAULTS = {
  pitchShift: 0,
  voiceCharacter: 0.75,
  indexStrength: 0.75,
  outputFormat: "mp3",
  vocalGain: 0,
};

const FORMATS = [
  { value: "mp3", label: "MP3 320" },
  { value: "wav", label: "WAV 24-bit" },
  { value: "flac", label: "FLAC" },
];

const AUDIO_RE = /\.(mp3|wav|flac|m4a|ogg|aiff?|aac)$/i;

export function NewCoverFlow() {
  /* ---- state ----------------------------------------------------------- */

  const draft = getState().coverDraft || {};
  const params = { ...DEFAULTS, ...draft };

  let song = null;          // { path, name, durationSec, sampleRate }
  let voiceId = draft.voiceId || null;
  let jobId = null;

  const voices = () => getState().voices;
  const currentVoice = () => voices().find((v) => v.name === voiceId) || null;

  // Warn before discarding a flow that has real work in it.
  setFlowDirtyCheck(() => Boolean(song) && !jobId);

  /* ---- 1. SONG --------------------------------------------------------- */

  const songSection = el("section", { class: "flow__section" });

  async function chooseSong() {
    const path = await window.vocalis.pickAudio("Choose a song");
    if (path) setSong(path);
  }

  function setSong(path) {
    song = { path, name: path.split("/").pop() };
    paintSong();
    paintGenerate();
  }

  function paintSong() {
    songSection.innerHTML = "";

    if (!song) {
      const zone = el("div", {
        class: "dropzone", tabindex: "0", role: "button",
        "aria-label": "Drop a song here, or choose a file",
        onclick: chooseSong,
        onkeydown: (e) => { if (e.key === "Enter" || e.code === "Space") { e.preventDefault(); chooseSong(); } },
      },
        el("div", { class: "dropzone__icon" }, makeIcon("headphones", 20)),
        el("div", { class: "t-body-em" }, "Drop a song here, or choose a file"),
        el("div", { class: "t-caption dropzone__hint" }, "MP3, WAV, FLAC or M4A"),
      );
      songSection.appendChild(zone);
      return;
    }

    // Collapsed to a 72px row once a file is in.
    const wave = Waveform({
      peaks: [], progress: 0, height: 28, disabled: true, ariaLabel: "",
    });
    wave.style.maxWidth = "180px";

    songSection.appendChild(el("div", { class: "songrow" },
      wave,
      el("div", { class: "songrow__main" },
        el("div", { class: "t-body-em" }, song.name),
        el("div", { class: "t-caption songrow__meta" },
          [song.durationSec ? fmt.duration(song.durationSec) : null,
           song.sampleRate ? `${Math.round(song.sampleRate / 1000)} kHz` : null]
            .filter(Boolean).join(" · ") || "Ready"),
      ),
      Button({ label: "Replace", variant: "tertiary", size: "sm", onClick: chooseSong }),
    ));
  }

  /* ---- 2. VOICE -------------------------------------------------------- */

  const voiceSection = el("section", { class: "flow__section" });

  function openVoicePicker(anchor) {
    const list = el("div", { class: "voicepick" });

    voices().forEach((v) => {
      const row = el("button", {
        type: "button",
        class: cls("voicepick__row", v.name === voiceId && "voicepick__row--on"),
        onclick: () => { voiceId = v.name; paintVoice(); paintGenerate(); pop.close(); },
      },
        el("span", { class: "voice-tile voice-tile--sm" }, initials(v.name)),
        el("span", { class: "voicepick__name" }, v.name),
        v.has_index ? Badge({ label: "Index", tone: "ok", icon: "check" }) : null,
      );

      // Inline preview, so a voice can be auditioned without leaving the flow.
      if (v.hasPreview) {
        const audio = new Audio(api.previewUrl(v.name));
        row.appendChild(IconButton({
          icon: "play", label: `Preview ${v.name}`, size: "sm",
          onClick: (e) => {
            e.stopPropagation();
            if (audio.paused) audio.play().catch(() => {}); else audio.pause();
          },
        }));
      }
      list.appendChild(row);
    });

    if (!voices().length) {
      list.appendChild(el("div", { class: "voicepick__empty t-caption" },
        "No voices yet."));
    }

    list.appendChild(el("div", { class: "voicepick__footer" },
      Button({
        label: "Train a new voice", variant: "tertiary", size: "sm",
        onClick: () => { pop.close(); exitFlow(() => set({ flow: "train" })); },
      }),
    ));

    const pop = Popover(anchor, list);
  }

  function paintVoice() {
    voiceSection.innerHTML = "";
    const v = currentVoice();

    const picker = el("button", {
      type: "button",
      class: "voicerow",
      "aria-haspopup": "dialog",
      onclick: (e) => openVoicePicker(e.currentTarget),
    },
      el("span", { class: "voice-tile" }, v ? initials(v.name) : "?"),
      el("span", { class: "voicerow__name t-body-em" }, v ? v.name : "Choose a voice"),
      v
        ? (v.has_index
            ? Badge({ label: "Pitch index ready", tone: "ok", icon: "check" })
            : Badge({ label: "No pitch index", tone: "neutral" }))
        : null,
      el("span", { class: "voicerow__chevron" }, makeIcon("chevron-down", 14)),
    );
    voiceSection.appendChild(picker);
  }

  /* ---- 3. RESULT ------------------------------------------------------- */
  // Renders nothing at all until a run starts. No empty panel.

  const resultSection = el("section", { class: "flow__section" });
  let pipeline = null;
  let meter = null;
  let resultWave = null;

  function paintResult() {
    const job = jobId ? getJob(jobId) : null;

    if (!job) {
      resultSection.innerHTML = "";
      resultSection.hidden = true;
      pipeline = meter = null;
      return;
    }
    resultSection.hidden = false;

    if (job.status === "done" && job.result?.path) {
      return paintFinished(job);
    }
    if (job.status === "failed") return paintFailed(job);
    if (job.status === "cancelled") {
      resultSection.innerHTML = "";
      resultSection.appendChild(el("div", { class: "runpanel" },
        el("div", { class: "t-body-em" }, "Run cancelled"),
        el("div", { class: "t-caption" }, "Nothing was saved."),
        Button({ label: "Start again", variant: "primary", onClick: startRun }),
      ));
      return;
    }

    // Running.
    if (!pipeline) {
      resultSection.innerHTML = "";
      pipeline = Pipeline({ stages: COVER_STAGES, ariaLabel: "Cover progress" });
      meter = MeterBar({ value: 0, readout: "", readoutSize: "lg", ariaLabel: "Overall progress" });

      resultSection.appendChild(el("div", { class: "runpanel" },
        pipeline,
        meter,
        el("div", { class: "runpanel__foot" },
          el("div", { class: "t-caption runpanel__note" }, ""),
          Button({ label: "Cancel run", variant: "tertiary", size: "sm",
            onClick: () => cancelJob(job.id) }),
        ),
      ));
    }

    COVER_STAGE_IDS.forEach((id) => {
      const st = job.stages[id];
      if (!st) return pipeline.setStage(id, "pending");
      pipeline.setStage(id, st.state, {
        duration: st.durationSec ? fmt.duration(st.durationSec) : undefined,
      });
    });

    meter.setValue(job.progress);
    meter.setReadout(
      `${Math.round(job.progress * 100)}%  ·  ${fmt.duration(job.elapsedSec)} elapsed`
      + (job.etaSec ? `  ·  about ${fmt.duration(job.etaSec)} left` : "")
    );
    const note = resultSection.querySelector(".runpanel__note");
    if (note) note.textContent = job.note || "";
  }

  function paintFinished(job) {
    if (resultWave) return;    // already painted
    resultSection.innerHTML = "";

    const name = job.result.path.split("/").pop();
    const src = mediaUrl(name);
    const audio = new Audio(src);

    resultWave = Waveform({
      peaks: [], progress: 0, height: 56, readout: "0:00",
      ariaLabel: "Scrub the finished cover",
      onSeek: (f) => { if (audio.duration) audio.currentTime = f * audio.duration; },
    });
    audio.addEventListener("timeupdate", () => {
      if (!audio.duration) return;
      resultWave.setProgress(audio.currentTime / audio.duration);
      resultWave.setReadout(fmt.position(audio.currentTime, audio.duration));
    });

    import("../app/peaks.js").then(({ getPeaks }) =>
      getPeaks({ id: name, size: 0, when: 0, src })
        .then(({ peaks }) => resultWave.setPeaks(peaks))
        .catch(() => {}));

    const playBtn = IconButton({
      icon: "play", label: "Play the finished cover",
      onClick: () => {
        const active = side === "cover" ? audio : (original || audio);
        if (active.paused) active.play().catch(() => {}); else active.pause();
      },
    });

    // A/B against the original, at the same playhead. The source track lives
    // outside the app:// origin, so its bytes come over IPC as a blob.
    let original = null;
    let side = "cover";
    const ab = Segmented({
      ariaLabel: "Compare original and cover",
      options: [{ value: "original", label: "Original" }, { value: "cover", label: "Cover" }],
      value: "cover",
      onChange: async (next) => {
        if (next === side) return;
        if (next === "original" && !original) {
          const bytes = await window.vocalis.readAudio(song?.path);
          if (!bytes) return;   // unreadable source — stay on the cover
          original = new Audio(URL.createObjectURL(new Blob([bytes])));
        }
        const from = side === "cover" ? audio : original;
        const to = next === "cover" ? audio : original;
        to.currentTime = from.currentTime;
        if (!from.paused) { to.play().catch(() => {}); from.pause(); }
        side = next;
      },
    });

    resultSection.appendChild(el("div", { class: "runpanel" },
      el("div", { class: "t-body-em" }, "Cover generated"),
      resultWave,
      el("div", { class: "runpanel__actions" },
        playBtn,
        song ? ab : null,
        Button({ label: "Save to…", variant: "secondary", icon: "export",
          onClick: () => window.vocalis.exportFiles([
            { path: job.result.path, name: `${song?.name || "cover"}` },
          ]) }),
        Button({ label: "Adjust and run again", variant: "tertiary",
          onClick: () => {
            audio.pause();
            jobId = null;
            resultWave = null;
            paintResult();
            paintGenerate();
          } }),
      ),
    ));
  }

  function paintFailed(job) {
    resultSection.innerHTML = "";
    // Never a stack trace inline — it goes behind "Copy details".
    resultSection.appendChild(el("div", { class: "runpanel runpanel--failed" },
      el("div", { class: "runpanel__failhead" },
        makeIcon("alert", 16),
        el("span", { class: "t-body-em" }, "That run didn't finish"),
      ),
      el("div", { class: "t-body measure" }, job.error),
      el("div", { class: "runpanel__actions" },
        Button({ label: "Try again", variant: "primary", onClick: startRun }),
        Button({ label: "Copy details", variant: "tertiary",
          disabled: !job.errorDetail,
          onClick: () => navigator.clipboard.writeText(job.errorDetail || "") }),
      ),
    ));
  }

  /* ---- Inspector ------------------------------------------------------- */

  const pitch = Slider({
    label: "Pitch shift",
    min: -12, max: 12, step: 1, value: params.pitchShift,
    format: (v) => `${v > 0 ? "+" : ""}${v} st`,
    ticks: [{ label: "−12" }, { label: "0" }, { label: "+12" }],
    help: "+12 to sing a man's part in a woman's voice; −12 for the reverse.",
    onInput: (v) => { params.pitchShift = v; },
  });

  const character = Slider({
    label: "Voice character",
    min: 0, max: 1, step: 0.01, value: params.voiceCharacter,
    format: (v) => Number(v).toFixed(2),
    help: "Higher stays closer to your voice; lower keeps more of the original singer.",
    onInput: (v) => { params.voiceCharacter = v; },
  });

  const indexStrength = Slider({
    label: "Pitch index strength",
    min: 0, max: 1, step: 0.01, value: params.indexStrength,
    format: (v) => Number(v).toFixed(2),
    onInput: (v) => { params.indexStrength = v; },
  });

  const format = Select({
    label: "Output format", options: FORMATS, value: params.outputFormat,
    onChange: (v) => { params.outputFormat = v; },
  });

  const gain = Slider({
    label: "Vocal gain",
    min: -6, max: 6, step: 0.5, value: params.vocalGain,
    format: (v) => `${v > 0 ? "+" : ""}${v} dB`,
    help: "Lift or tuck the vocal against the instrumental.",
    onInput: (v) => { params.vocalGain = v; },
  });

  const advanced = el("details", { class: "inspector__advanced" },
    el("summary", { class: "t-body-em" }, "Advanced"),
    gain,
  );

  const inspector = el("aside", { class: "inspector", "aria-label": "Parameters" },
    el("div", { class: "inspector__body" },
      pitch, character, indexStrength, format, advanced,
      Button({
        label: "Reset to defaults", variant: "tertiary", size: "sm",
        onClick: () => {
          Object.assign(params, DEFAULTS);
          pitch.setValue(DEFAULTS.pitchShift);
          character.setValue(DEFAULTS.voiceCharacter);
          indexStrength.setValue(DEFAULTS.indexStrength);
          gain.setValue(DEFAULTS.vocalGain);
          format.input.value = DEFAULTS.outputFormat;
        },
      }),
    ),
  );

  function paintIndexAvailability() {
    const v = currentVoice();
    const enabled = Boolean(v?.has_index);
    indexStrength.input.disabled = !enabled;
    const help = indexStrength.querySelector(".field__help");
    if (help) {
      help.textContent = enabled
        ? "How strongly to lean on the pitch index."
        : "This voice has no pitch index, so there is nothing to lean on.";
    } else if (!enabled) {
      indexStrength.appendChild(el("div", { class: "field__help" },
        "This voice has no pitch index, so there is nothing to lean on."));
    }
  }

  /* ---- toolbar --------------------------------------------------------- */

  const generateBtn = Button({
    label: "Generate", variant: "primary",
    onClick: () => startRun(),
  });

  function missingInput() {
    if (!song) return "Choose a song first.";
    if (!voiceId) return "Choose a voice first.";
    return null;
  }

  function paintGenerate() {
    const missing = missingInput();
    const running = jobId && getJob(jobId)?.status === "running";
    generateBtn.disabled = Boolean(missing) || Boolean(running);
    generateBtn.title = missing || (running ? "A run is already going." : "");
    paintIndexAvailability();
  }

  async function startRun() {
    if (missingInput()) return;
    resultWave = null;
    pipeline = null;
    try {
      jobId = await startCover({
        songPath: song.path,
        songName: song.name,
        voiceId,
        params,
      });
      paintResult();
      paintGenerate();
    } catch (err) {
      jobId = null;
      resultSection.hidden = false;
      resultSection.innerHTML = "";
      resultSection.appendChild(el("div", { class: "runpanel runpanel--failed" },
        el("div", { class: "t-body-em" }, "Couldn't start the run"),
        el("div", { class: "t-body measure" }, err.message),
      ));
    }
  }

  /* ---- assembly -------------------------------------------------------- */

  const main = el("div", { class: "flow__main" },
    el("h2", { class: "flow__heading t-head" }, "Song"),
    songSection,
    el("h2", { class: "flow__heading t-head" }, "Voice"),
    voiceSection,
    resultSection,
  );

  const root = el("div", { class: "flow__split" }, main, inspector);

  // ⌥⌘I — open by default (§Prompt 4).
  const paintInspector = () => {
    root.dataset.inspector = getState().inspectorVisible ? "shown" : "hidden";
  };
  paintInspector();

  // Drops are accepted anywhere in the view, not only inside the zone.
  const offDrag = [
    on(root, "dragover", (e) => { e.preventDefault(); root.classList.add("flow--dragging"); }),
    on(root, "dragleave", (e) => {
      if (e.relatedTarget && root.contains(e.relatedTarget)) return;
      root.classList.remove("flow--dragging");
    }),
    on(root, "drop", (e) => {
      e.preventDefault();
      root.classList.remove("flow--dragging");
      const file = e.dataTransfer?.files?.[0];
      if (!file || !AUDIO_RE.test(file.name)) return;
      const path = window.vocalis.pathForFile(file);
      if (path) setSong(path);
    }),
  ];

  // Auto-select the most recently used voice — the old build shipped an empty
  // dropdown while claiming "3 voice models available", which was a dead end.
  if (!voiceId && voices().length) {
    voiceId = [...voices()].sort((a, b) => b.modified - a.modified)[0].name;
  }

  paintSong();
  paintVoice();
  paintResult();
  paintGenerate();

  const offs = [
    subscribe(["inspectorVisible"], paintInspector),
    subscribe(["jobs"], paintResult),
    subscribe(["voices"], () => { paintVoice(); paintGenerate(); }),
  ];

  root.toolbar = {
    title: "New cover",
    search: false,
    actions: [generateBtn],
    leading: Button({ label: "Cancel", variant: "secondary", onClick: () => exitFlow() }),
  };

  root.destroy = () => {
    offs.forEach((f) => f());
    offDrag.forEach((f) => f());
    resultWave?.destroy?.();
    setFlowDirtyCheck(null);
  };

  // Consume the draft so a later visit starts clean.
  if (getState().coverDraft) set({ coverDraft: null });

  return root;
}
