/**
 * Speak — a full-view push over the library (§8), same shape as New cover.
 *
 * An RVC model converts voice to voice; it cannot read text. So this view is
 * honest about being a two-stage chain: a base voice from the OS says the
 * words, then the trained model recolours them. That is why there are two voice
 * pickers and not one, and why the base picker sits first.
 *
 * Deliberately unlike New cover:
 *   - No separation and no mixing, so the Pipeline is three short stages and a
 *     run finishes in seconds. The view therefore stays put and waits instead
 *     of pushing the work into the background.
 *   - No A/B player. There is no original to compare against.
 *   - The consent line is inline, above the button, at the decision point —
 *     not a dismissible banner (the mistake §1/U9 calls out).
 */

import { el, on } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import {
  Button, EmptyState, IconButton, Popover, Select, Slider, Textarea,
} from "../components/primitives/index.js";
import { Pipeline, SPEECH_STAGES } from "../components/meter/index.js";
import { MeterBar } from "../components/meter/meter-bar.js";
import { Waveform } from "../components/meter/waveform.js";
import { ReadingView } from "../components/reading/reading.js";
import { getState, set, subscribe } from "../app/store.js";
import { exitFlow, setFlowDirtyCheck } from "../app/router.js";
import { api, mediaUrl } from "../app/api.js";
import { startSpeech, cancelJob, getJob, SPEECH_STAGE_IDS } from "../app/jobs.js";
import { play as playInBar } from "../app/now-playing.js";
import { getPeaks } from "../app/peaks.js";
import { toast } from "../app/toast.js";
import * as fmt from "../app/format.js";

/** Button is a plain <button>; these keep the label/disabled edits in one place. */
const setLabel = (btn, text) => {
  const slot = btn.querySelector(".btn__label");
  if (slot) slot.textContent = text;
};

const DEFAULTS = {
  speechVoice: "",
  rate: 175,
  pitchShift: 0,
  voiceCharacter: 0.75,
  outputFormat: "mp3",
  speed: 1,
};

const FORMATS = [
  { value: "mp3", label: "MP3 320" },
  { value: "wav", label: "WAV 24-bit" },
  { value: "flac", label: "FLAC" },
];

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => ({
  value: String(v), label: `${v}×`,
}));

/** A base voice the user is most likely to want, given the app's locale. */
function preferredVoice(voices) {
  if (!voices.length) return "";
  const ui = (navigator.language || "en-US").toLowerCase();
  const usable = voices.filter((v) => !v.novelty);
  const pool = usable.length ? usable : voices;
  return (pool.find((v) => v.locale.toLowerCase() === ui)
    || pool.find((v) => v.language === ui.split("-")[0])
    || pool.find((v) => v.locale.toLowerCase().startsWith("en"))
    || pool[0]).id;
}

/**
 * Group the OS voices by language for the picker. 180-odd voices in one flat
 * list is unusable, and the novelty ones go last because they convert into
 * noise and the name alone does not warn you.
 */
function voiceOptions(voices) {
  const label = (v) => `${v.name} · ${v.locale}`;
  const plain = voices.filter((v) => !v.novelty);
  const novelty = voices.filter((v) => v.novelty);

  const byLocale = new Map();
  plain.forEach((v) => {
    if (!byLocale.has(v.locale)) byLocale.set(v.locale, []);
    byLocale.get(v.locale).push(v);
  });

  const options = [];
  [...byLocale.keys()].sort().forEach((loc) => {
    byLocale.get(loc).forEach((v) => options.push({ value: v.id, label: label(v) }));
  });
  novelty.forEach((v) => options.push({ value: v.id, label: `${v.name} (novelty)` }));
  return options;
}

export function SpeakFlow() {
  /* ---- state ----------------------------------------------------------- */

  const params = { ...DEFAULTS };
  let text = "";
  let voiceId = "";
  let speechVoices = [];
  let limits = { maxChars: 5000, rateMin: 100, rateMax: 300, rateDefault: 175 };
  let unsupported = false;
  let jobId = null;
  let pipeline = null;
  let meter = null;
  let resultWave = null;
  let reading = null;
  let frame = 0;          // rAF handle for the reading playhead

  const trainedVoices = () => getState().voices || [];

  /* ---- script ---------------------------------------------------------- */

  const script = Textarea({
    label: "What should it say?",
    placeholder: "Type or paste the line you want spoken.",
    rows: 5,
    counter: limits.maxChars,
    onInput: (v) => { text = v; paintSpeak(); },
  });

  /* ---- voices ---------------------------------------------------------- */

  const baseVoice = Select({
    label: "Base voice",
    options: [],
    help: "Reads the text. Its accent shapes the delivery; your trained voice "
        + "supplies the tone.",
    onChange: (v) => { params.speechVoice = v; },
  });

  const trainedVoice = Select({
    label: "Your voice",
    options: [],
    help: "The trained model the speech is converted into.",
    onChange: (v) => { voiceId = v; paintSpeak(); },
  });

  // Swapped between the two pickers and a "no voices yet" empty state, so this
  // has to be a stable container rather than a node replaced in place.
  const voiceArea = el("div", { class: "flow__section" });

  /* ---- parameters (inspector) ------------------------------------------ */

  const rate = Slider({
    label: "Speaking rate",
    min: limits.rateMin, max: limits.rateMax, step: 5, value: params.rate,
    format: (v) => `${v} wpm`,
    help: "How fast the base voice reads. Applied before conversion.",
    onInput: (v) => { params.rate = v; },
  });

  const pitch = Slider({
    label: "Pitch shift",
    min: -12, max: 12, step: 1, value: params.pitchShift,
    format: (v) => `${v > 0 ? "+" : ""}${v} st`,
    ticks: [{ label: "−12" }, { label: "0" }, { label: "+12" }],
    help: "Semitones. Use it to move the result into your own range.",
    onInput: (v) => { params.pitchShift = v; },
  });

  const character = Slider({
    label: "Voice character",
    min: 0, max: 1, step: 0.05, value: params.voiceCharacter,
    format: (v) => v.toFixed(2),
    help: "Higher stays closer to your voice; lower keeps more of the base voice.",
    onInput: (v) => { params.voiceCharacter = v; },
  });

  const format = Select({
    label: "Export format",
    options: FORMATS, value: params.outputFormat,
    onChange: (v) => { params.outputFormat = v; },
  });

  const speed = Select({
    label: "Playback speed",
    options: SPEEDS, value: String(params.speed),
    help: "Re-times the finished clip without changing its pitch.",
    onChange: (v) => { params.speed = Number(v); },
  });

  const inspector = el("aside", { class: "inspector", "aria-label": "Parameters" },
    el("div", { class: "inspector__body" },
      rate, pitch, character, format, speed,
      Button({
        label: "Reset to defaults", variant: "tertiary", size: "sm",
        onClick: () => {
          const keepVoice = params.speechVoice;
          Object.assign(params, DEFAULTS, { speechVoice: keepVoice });
          rate.setValue(DEFAULTS.rate);
          pitch.setValue(DEFAULTS.pitchShift);
          character.setValue(DEFAULTS.voiceCharacter);
          format.input.value = DEFAULTS.outputFormat;
          speed.input.value = String(DEFAULTS.speed);
        },
      }),
    ),
  );

  /* ---- consent, stated at the decision point --------------------------- */

  const consent = el("div", { class: "consent" },
    el("span", { class: "consent__icon" }, makeIcon("alert", 13)),
    el("div", { class: "t-caption" },
      "Use voices you own or have permission to use. Putting words in someone "
      + "else's voice is a different thing from singing in your own.",
    ),
  );

  /* ---- run ------------------------------------------------------------- */

  const speakBtn = Button({
    label: "Speak", variant: "primary", icon: "play",
    onClick: () => startRun(),
  });

  const resultSection = el("div", { class: "flow__section", hidden: true });

  function paintSpeak() {
    const ready = Boolean(text.trim()) && Boolean(voiceId) && !unsupported
      && text.length <= limits.maxChars;
    const running = jobId ? getJob(jobId)?.status === "running" : false;
    speakBtn.disabled = !ready || running;
  }

  async function startRun() {
    if (!text.trim() || !voiceId) return;
    try {
      resultWave = null;
      jobId = await startSpeech({ text, voiceId, params });
      paintResult();
      paintSpeak();
    } catch (err) {
      toast({ message: err.message });
    }
  }

  /* ---- reading view ---------------------------------------------------- */

  /**
   * Follow the audio at display rate. `timeupdate` fires roughly four times a
   * second, which is visibly steppy on a moving highlight, so the position is
   * read from the element every frame instead.
   */
  function followAudio(audio) {
    cancelAnimationFrame(frame);
    const tick = () => {
      reading?.setTime(audio.currentTime);
      if (!audio.paused && !audio.ended) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function showReading(spokenText, timings, audio) {
    reading = ReadingView({
      text: spokenText,
      timings,
      onSeek: (seconds) => {
        audio.currentTime = seconds;
        reading.setTime(seconds);
        if (audio.paused) audio.play().catch(() => {});
      },
    });

    scriptSection.innerHTML = "";
    scriptSection.appendChild(el("div", { class: "field__label" }, "Following along"));
    scriptSection.appendChild(reading);
    if (!timings.length) {
      scriptSection.appendChild(el("div", { class: "field__help" },
        "This clip has no word timings, so the script is shown as it was."));
    }

    audio.addEventListener("play", () => { reading?.setPlaying(true); followAudio(audio); });
    audio.addEventListener("seeked", () => reading?.setTime(audio.currentTime));
    audio.addEventListener("pause", () => {
      reading?.setPlaying(false);
      cancelAnimationFrame(frame);
      // One last read, so the fill lands exactly where the audio stopped.
      reading?.setTime(audio.currentTime);
    });
    audio.addEventListener("ended", () => {
      reading?.setPlaying(false);
      cancelAnimationFrame(frame);
    });
  }

  /** Back to editing — "Say another" and a failed run both land here. */
  function showEditor() {
    cancelAnimationFrame(frame);
    reading = null;
    scriptSection.innerHTML = "";
    scriptSection.appendChild(script);
    script.setValue(text);
    requestAnimationFrame(() => script.mounted?.());
  }

  function paintResult() {
    const job = jobId ? getJob(jobId) : null;
    if (!job) {
      resultSection.innerHTML = "";
      resultSection.hidden = true;
      pipeline = meter = null;
      return;
    }
    resultSection.hidden = false;

    if (job.status === "done" && job.result?.path) return paintFinished(job);
    if (job.status === "failed") {
      resultSection.innerHTML = "";
      pipeline = meter = null;
      resultSection.appendChild(el("div", { class: "runpanel" },
        el("div", { class: "t-body-em" }, "That didn't work"),
        el("div", { class: "t-caption" }, job.error || "The run failed."),
        Button({ label: "Try again", variant: "primary", onClick: startRun }),
      ));
      return;
    }
    if (job.status === "cancelled") {
      resultSection.innerHTML = "";
      pipeline = meter = null;
      resultSection.appendChild(el("div", { class: "runpanel" },
        el("div", { class: "t-body-em" }, "Run cancelled"),
        el("div", { class: "t-caption" }, "Nothing was saved."),
        Button({ label: "Start again", variant: "primary", onClick: startRun }),
      ));
      return;
    }

    if (!pipeline) {
      resultSection.innerHTML = "";
      resultWave = null;
      pipeline = Pipeline({ stages: SPEECH_STAGES, ariaLabel: "Speech progress" });
      meter = MeterBar({ value: 0, readout: "", readoutSize: "lg",
                         ariaLabel: "Overall progress" });
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

    SPEECH_STAGE_IDS.forEach((id) => {
      const st = job.stages[id];
      if (!st) return pipeline.setStage(id, "pending");
      pipeline.setStage(id, st.state, {
        duration: st.durationSec ? fmt.duration(st.durationSec) : undefined,
      });
    });

    meter.setValue(job.progress);
    meter.setReadout(`${Math.round(job.progress * 100)}%  ·  `
      + `${fmt.duration(job.elapsedSec)} elapsed`);
    const note = resultSection.querySelector(".runpanel__note");
    if (note) note.textContent = job.note || "";
  }

  function paintFinished(job) {
    if (resultWave) return;                       // already painted
    resultSection.innerHTML = "";
    pipeline = meter = null;

    const name = job.result.path.split("/").pop();
    const src = mediaUrl(name);
    const audio = new Audio(src);
    audio.preload = "metadata";

    // Swap the editable script for the reading view. The text and the timings
    // both come from the job result, so the offsets always match the string
    // that was actually spoken.
    showReading(job.result.text || text, job.result.timings || [], audio);

    resultWave = Waveform({
      peaks: [], height: 48, ariaLabel: "Spoken clip",
      onSeek: (frac) => {
        if (audio.duration) audio.currentTime = frac * audio.duration;
      },
    });
    // The filename carries a timestamp, so id alone is a stable cache key here.
    getPeaks({ id: name, size: 0, when: 0, src })
      .then(({ peaks }) => resultWave?.setPeaks(peaks))
      .catch(() => { /* the clip still plays without a drawn shape */ });

    const time = el("span", { class: "t-meter tabular" }, "0:00 / 0:00");
    const playBtn = Button({
      label: "Play", variant: "secondary", size: "sm", icon: "play",
      onClick: () => { audio.paused ? audio.play() : audio.pause(); },
    });

    audio.addEventListener("timeupdate", () => {
      if (!audio.duration) return;
      resultWave?.setProgress(audio.currentTime / audio.duration);
      time.textContent = fmt.position(audio.currentTime, audio.duration);
    });
    audio.addEventListener("loadedmetadata", () => {
      time.textContent = fmt.position(0, audio.duration || 0);
    });
    audio.addEventListener("ended", () => setLabel(playBtn, "Play"));
    audio.addEventListener("play", () => setLabel(playBtn, "Pause"));
    audio.addEventListener("pause", () => setLabel(playBtn, "Play"));

    resultSection.appendChild(el("div", { class: "runpanel" },
      el("div", { class: "t-body-em" }, "Ready"),
      resultWave,
      el("div", { class: "runpanel__foot" },
        el("div", { class: "runpanel__transport" }, playBtn, time),
        el("div", { class: "runpanel__transport" },
          Button({
            label: "Show in Spoken", variant: "tertiary", size: "sm",
            onClick: () => {
              audio.pause();
              playInBar({ id: name, title: job.name, voice: job.voiceId, src });
              exitFlow(() => set({ route: "spoken", selection: [name], query: "" }));
            },
          }),
          Button({
            label: "Say another", variant: "secondary", size: "sm",
            onClick: () => {
              audio.pause();
              jobId = null;
              resultWave = null;
              showEditor();
              paintResult();
              paintSpeak();
              script.input.focus();
            },
          }),
        ),
      ),
    ));

    resultSection.__audio = audio;
  }

  /* ---- assembly -------------------------------------------------------- */

  const scriptSection = el("div", { class: "flow__section" }, script);

  const guidance = IconButton({
    icon: "info", label: "Why two voices?", size: "sm",
    onClick: (e) => Popover(e.currentTarget, el("div", { style: { maxWidth: "280px" } },
      el("div", { class: "t-body-em", style: { marginBottom: "6px" } },
        "Why two voices?"),
      el("div", { class: "t-caption" },
        "A trained voice model changes how a voice sounds, it can't read. So one "
        + "of your Mac's own voices reads the text, and your model recolours it. "
        + "Both stages run here; nothing is sent anywhere."),
    )),
  });

  const main = el("div", { class: "flow__main" },
    el("div", { class: "flow__headingrow" },
      el("h2", { class: "flow__heading t-head" }, "Script"),
    ),
    scriptSection,
    el("div", { class: "flow__headingrow" },
      el("h2", { class: "flow__heading t-head" }, "Voices"),
      guidance,
    ),
    voiceArea,
    consent,
    resultSection,
  );

  const root = el("div", { class: "flow__split" }, main, inspector);

  const paintInspector = () => {
    root.dataset.inspector = getState().inspectorVisible ? "shown" : "hidden";
  };
  paintInspector();

  /* ---- load the OS voices --------------------------------------------- */

  function paintTrainedVoices() {
    const list = trainedVoices();
    voiceArea.innerHTML = "";

    if (!list.length) {
      voiceId = "";
      voiceArea.className = "flow__section";
      voiceArea.appendChild(EmptyState({
        icon: "mic",
        title: "No trained voices yet",
        body: "Speech converts into a voice of your own, so there has to be one first.",
        action: Button({
          label: "Train a voice", variant: "primary",
          onClick: () => set({ flow: "train" }),
        }),
      }));
      paintSpeak();
      return;
    }

    const sel = trainedVoice.input;
    sel.innerHTML = "";
    list.forEach((v) => sel.appendChild(el("option", { value: v.name }, v.name)));
    sel.disabled = false;
    if (!voiceId || !list.some((v) => v.name === voiceId)) {
      voiceId = [...list].sort((a, b) => b.modified - a.modified)[0].name;
    }
    sel.value = voiceId;

    voiceArea.className = "flow__section flow__grid2";
    voiceArea.appendChild(baseVoice);
    voiceArea.appendChild(trainedVoice);
    paintSpeak();
  }

  (async () => {
    try {
      const info = await api.speechVoices();
      limits = {
        maxChars: info.maxChars, rateMin: info.rateMin,
        rateMax: info.rateMax, rateDefault: info.rateDefault,
      };
      speechVoices = info.voices || [];
      unsupported = !info.available;

      if (unsupported) {
        baseVoice.input.disabled = true;
        baseVoice.setError("This Mac has no built-in speech voices available.");
        paintSpeak();
        return;
      }

      const sel = baseVoice.input;
      sel.innerHTML = "";
      voiceOptions(speechVoices).forEach((o) =>
        sel.appendChild(el("option", { value: o.value }, o.label)));
      params.speechVoice = preferredVoice(speechVoices);
      sel.value = params.speechVoice;

      rate.input.min = String(limits.rateMin);
      rate.input.max = String(limits.rateMax);
      rate.setValue(limits.rateDefault);
      params.rate = limits.rateDefault;
      paintSpeak();
    } catch (err) {
      baseVoice.setError(err.message);
      unsupported = true;
      paintSpeak();
    }
  })();

  paintTrainedVoices();
  paintSpeak();
  // Textarea can only size itself once it has layout.
  requestAnimationFrame(() => script.mounted?.());

  // ⌘↩ runs, matching "the primary action of the view" (§9).
  const offKeys = on(root, "keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !speakBtn.disabled) {
      e.preventDefault();
      startRun();
    }
  });

  const offs = [
    subscribe(["inspectorVisible"], paintInspector),
    subscribe(["jobs"], () => { paintResult(); paintSpeak(); }),
    subscribe(["voices"], paintTrainedVoices),
  ];

  // A typed script is unsaved work, so Esc asks before discarding it.
  setFlowDirtyCheck(() => Boolean(text.trim()) && !jobId);

  root.toolbar = {
    title: "Speak",
    search: false,
    actions: [speakBtn],
  };

  root.destroy = () => {
    offs.forEach((f) => f());
    offKeys();
    cancelAnimationFrame(frame);
    resultSection.__audio?.pause();
    resultWave?.destroy?.();
    setFlowDirtyCheck(null);
  };

  return root;
}
