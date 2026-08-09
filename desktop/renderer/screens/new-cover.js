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
import { api, mediaUrl, runJob, loadCovers } from "../app/api.js";
import { startCover, cancelJob, getJob, COVER_STAGE_IDS } from "../app/jobs.js";
import { MixPlayer } from "../app/mix-player.js";
import { toast } from "../app/toast.js";
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

// Tempo, not pitch — the engine's atempo chain and the browser's playbackRate
// agree on what these mean, so preview and saved file match.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((v) => ({
  value: String(v), label: `${v}×`,
}));

const AUDIO_RE = /\.(mp3|wav|flac|m4a|ogg|aiff?|aac)$/i;
const URL_RE = /^https?:\/\/\S+$/i;

export function NewCoverFlow() {
  /* ---- state ----------------------------------------------------------- */

  const draft = getState().coverDraft || {};
  const params = { ...DEFAULTS, ...draft };

  let song = null;          // { path, name, durationSec, sampleRate, sourceUrl }
  let voiceId = draft.voiceId || null;
  let jobId = null;
  let fetchJobId = null;    // a link fetch in flight
  let fetchError = null;
  let trim = null;          // { start, end } in seconds; null = the whole song
  let trimOpen = false;
  let sourcePeaks = null;   // { peaks, duration } for the chosen song
  let sourceBlobUrl = null; // decoded once, for trim preview playback

  const voices = () => getState().voices;
  const currentVoice = () => voices().find((v) => v.name === voiceId) || null;

  // Warn before discarding a flow that has real work in it.
  setFlowDirtyCheck(() => (Boolean(song) || Boolean(fetchJobId)) && !jobId);

  /* ---- 1. SONG --------------------------------------------------------- */

  const songSection = el("section", { class: "flow__section" });

  async function chooseSong() {
    const path = await window.vocalis.pickAudio("Choose a song");
    if (path) setSong({ path, name: path.split("/").pop() });
  }

  function setSong(next) {
    song = next;
    // Every song starts untrimmed, and the old song's shape must not linger
    // behind the new one's name.
    trim = null;
    trimOpen = false;
    sourcePeaks = null;
    if (sourceBlobUrl) { URL.revokeObjectURL(sourceBlobUrl); sourceBlobUrl = null; }
    paintSong();
    paintGenerate();
    if (song) loadSourcePeaks(song.path);
  }

  /**
   * Decode the chosen song for the trim view. The file lives outside the app://
   * origin, so its bytes come over IPC rather than through fetch.
   */
  async function loadSourcePeaks(path) {
    const { getPeaks } = await import("../app/peaks.js");
    try {
      const data = await getPeaks({
        id: path, size: 0, when: 0,
        read: () => window.vocalis.readAudio(path),
      });
      if (!song || song.path !== path) return;   // a later song won the race
      sourcePeaks = data;
      if (!song.durationSec) song.durationSec = data.duration;
      paintSong();
    } catch {
      // No peaks means no trim view; the flow still works on the whole song.
    }
  }

  const songDuration = () =>
    sourcePeaks?.duration || song?.durationSec || 0;

  /** The trim as the engine wants it, or null when the whole song is in play. */
  function effectiveTrim() {
    const total = songDuration();
    if (!trim || !total) return null;
    const start = Math.max(0, trim.start);
    const end = Math.min(total, trim.end);
    if (end - start < 1) return null;
    // Within a quarter-second of the full track is not a trim, it is noise.
    if (start < 0.25 && end > total - 0.25) return null;
    return { start, end };
  }

  /* Link input.
   *
   * The fetch is a job on the server, but it is deliberately NOT registered in
   * the Activity list: it is a step of filling in the Song field, not a run to
   * navigate away from. Its nodes are built once and mutated in place, so
   * progress ticks can't steal focus out of the input.
   */
  const linkInput = el("input", {
    type: "url",
    class: "input linkrow__input",
    placeholder: "https://www.youtube.com/watch?v=…",
    "aria-label": "Song link",
    spellcheck: "false",
    oninput: () => { fetchError = null; paintLink(); },
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); fetchLink(); } },
  });

  const linkBtn = Button({ label: "Fetch", onClick: () => fetchLink() });
  const linkCancel = Button({
    label: "Cancel", variant: "tertiary",
    onClick: () => { if (fetchJobId) cancelJob(fetchJobId); },
  });
  const linkMeter = MeterBar({ value: 0, ariaLabel: "Download progress" });
  const linkStatus = el("div", { class: "t-caption linkrow__status" }, "");

  const linkRow = el("div", { class: "linkrow" },
    el("div", { class: "linkrow__field" }, linkInput, linkBtn, linkCancel),
    linkMeter,
    linkStatus,
  );

  function paintLink(progress = 0, note = "") {
    const busy = Boolean(fetchJobId);
    linkInput.disabled = busy;
    linkBtn.disabled = busy || !linkInput.value.trim();
    linkBtn.hidden = busy;
    linkCancel.hidden = !busy;
    linkMeter.hidden = !busy;
    linkMeter.setValue(progress);
    linkStatus.textContent = fetchError || (busy ? note : "");
    linkStatus.classList.toggle("linkrow__status--error", Boolean(fetchError));
  }

  async function fetchLink(url = linkInput.value.trim()) {
    if (!url || fetchJobId) return;
    linkInput.value = url;
    fetchError = null;
    try {
      const { job_id } = await api.fetchUrl(url);
      fetchJobId = job_id;
      paintLink(0, "Reading the link…");
      paintGenerate();

      const result = await runJob(job_id, {
        onProgress: (frac, step, note) =>
          paintLink(frac, note ? `${step} · ${note}` : step),
      });

      fetchJobId = null;
      linkInput.value = "";
      // A file chosen while the download ran is the later, more explicit
      // choice, so it wins. The download stays in the cache either way.
      if (song) return paintGenerate();
      setSong({
        path: result.path,
        name: result.title || String(result.path).split("/").pop(),
        durationSec: result.durationSec || null,
        sourceUrl: result.webpageUrl || url,
      });
    } catch (err) {
      fetchJobId = null;
      fetchError = err.cancelled ? "Fetch cancelled." : err.message;
      paintLink();
      paintGenerate();
    }
  }

  function sourceHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "link"; }
  }

  function paintSong() {
    // The trim panel owns a decoded <audio> and a canvas observer, so it has to
    // be told before its nodes are thrown away.
    songSection.querySelector(".trimpanel")?.destroy?.();
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
      songSection.appendChild(linkRow);
      paintLink();
      return;
    }

    // Collapsed to a 72px row once a file is in.
    const wave = Waveform({
      peaks: sourcePeaks?.peaks || [], progress: 0, height: 28,
      disabled: true, ariaLabel: "",
    });
    wave.style.maxWidth = "180px";

    const cut = effectiveTrim();

    songSection.appendChild(el("div", { class: "songrow" },
      wave,
      el("div", { class: "songrow__main" },
        // Video titles run far longer than filenames, and the row is a fixed
        // 72px — so it truncates, with the full title on hover.
        el("div", { class: "t-body-em songrow__title", title: song.name }, song.name),
        el("div", { class: "t-caption songrow__meta" },
          [song.durationSec ? fmt.duration(song.durationSec) : null,
           song.sampleRate ? `${Math.round(song.sampleRate / 1000)} kHz` : null,
           song.sourceUrl ? sourceHost(song.sourceUrl) : null,
           cut ? `trimmed to ${fmt.duration(cut.end - cut.start)}` : null]
            .filter(Boolean).join(" · ") || "Ready"),
      ),
      // Only offered once the shape is known — a trim view with no waveform
      // would be a slider over nothing.
      sourcePeaks
        ? Button({
            label: trimOpen ? "Close trim" : (cut ? "Edit trim" : "Trim"),
            variant: "tertiary", size: "sm",
            onClick: () => { trimOpen = !trimOpen; paintSong(); },
          })
        : null,
      Button({ label: "Replace", variant: "tertiary", size: "sm", onClick: chooseSong }),
      Button({
        label: "Use a link", variant: "tertiary", size: "sm",
        onClick: () => { setSong(null); linkInput.focus(); },
      }),
    ));

    if (trimOpen && sourcePeaks) songSection.appendChild(buildTrimPanel());
  }

  /* Trim panel.
   *
   * Sits under the song row rather than in the Inspector: it is an edit to the
   * input, not a parameter of the run, and it needs the full content width to
   * be draggable with any precision.
   */
  function buildTrimPanel() {
    const total = songDuration();
    const range = trim || { start: 0, end: total };
    const asTime = (fraction) => fmt.duration(fraction * total);

    let preview = null;
    let stopAt = null;

    const readout = el("div", { class: "t-meter tabular trimpanel__readout" }, "");
    const resetBtn = Button({
      label: "Whole song", variant: "tertiary", size: "sm",
      disabled: !effectiveTrim(),
      onClick: () => {
        trim = null;
        preview?.pause();
        paintSong();
        paintGenerate();
      },
    });
    const paintReadout = () => {
      readout.textContent =
        `${fmt.duration(range.start)} – ${fmt.duration(range.end)}`
        + `  ·  ${fmt.duration(range.end - range.start)} selected`;
    };

    const wave = Waveform({
      peaks: sourcePeaks.peaks,
      height: 56,
      ariaLabel: "Scrub the song",
      selection: { start: range.start / total, end: range.end / total },
      formatValue: asTime,
      onSelect: (start, end) => {
        range.start = start * total;
        range.end = end * total;
        paintReadout();
      },
      onSelectEnd: () => {
        trim = { start: range.start, end: range.end };
        paintGenerate();
        resetBtn.disabled = !effectiveTrim();
        // The collapsed row's summary is now stale, but repainting the whole
        // section would tear down this panel mid-interaction.
        const meta = songSection.querySelector(".songrow__meta");
        const cut = effectiveTrim();
        if (meta && cut) {
          meta.textContent = meta.textContent.replace(/ · trimmed to .*$/, "")
            + ` · trimmed to ${fmt.duration(cut.end - cut.start)}`;
        }
      },
      onSeek: (fraction) => { if (preview) preview.currentTime = fraction * total; },
    });

    const playBtn = IconButton({
      icon: "play", label: "Play the selection",
      onClick: async () => {
        if (preview && !preview.paused) { preview.pause(); return; }
        if (!preview) {
          const url = await sourceAudioUrl();
          if (!url) return;                 // unreadable file — nothing to play
          preview = new Audio(url);
          preview.addEventListener("timeupdate", () => {
            wave.setProgress(preview.currentTime / total);
            if (stopAt != null && preview.currentTime >= stopAt) preview.pause();
          });
          // Including "pause" fired by the stopAt guard above, so the button
          // resets itself when the selection runs out.
          ["play", "pause", "ended"].forEach((type) =>
            preview.addEventListener(type, () => {
              const playing = !preview.paused;
              playBtn.setIcon(playing ? "pause" : "play",
                playing ? "Pause the selection" : "Play the selection");
            }));
        }
        // Always from the head of the selection: the point is to audition the
        // part that will actually be converted.
        preview.currentTime = range.start;
        stopAt = range.end;
        preview.play().catch(() => {});
      },
    });

    paintReadout();

    const panel = el("div", { class: "trimpanel" },
      wave,
      el("div", { class: "trimpanel__foot" },
        playBtn,
        readout,
        resetBtn,
        Button({
          label: "Done", variant: "secondary", size: "sm",
          onClick: () => { trimOpen = false; preview?.pause(); paintSong(); },
        }),
      ),
    );

    panel.destroy = () => { preview?.pause(); wave.destroy?.(); };
    return panel;
  }

  /** One decode of the source file, shared by trim preview and A/B compare. */
  async function sourceAudioUrl() {
    if (sourceBlobUrl) return sourceBlobUrl;
    const bytes = await window.vocalis.readAudio(song?.path);
    if (!bytes) return null;
    sourceBlobUrl = URL.createObjectURL(new Blob([bytes]));
    return sourceBlobUrl;
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
  let resultPlayer = null;

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

    // Played from its stems, which is what makes balance and speed audible
    // without a re-export. Falls back to the exported file for a cover whose
    // working files are gone.
    const player = MixPlayer({
      fileSrc: src,
      stemSrcs: {
        vocals: api.stemUrl(name, "vocalsFx"),
        instrumental: api.stemUrl(name, "instrumental"),
      },
      // Only reachable for a cover whose working files were cleaned up.
      onDegrade: () => degradeMix?.(),
    });
    resultPlayer = player;

    resultWave = Waveform({
      peaks: [], progress: 0, height: 56, readout: "0:00",
      ariaLabel: "Scrub the finished cover",
      onSeek: (f) => { if (player.duration) player.seek(f * player.duration); },
    });
    // Bound to this panel's own waveform, not the outer `resultWave`: "Adjust
    // and run again" nulls that while this player is still ticking, and the
    // handler then threw on every frame of playback.
    const wave = resultWave;
    player.onTime(() => {
      if (!player.duration) return;
      wave.setProgress(player.currentTime / player.duration);
      wave.setReadout(fmt.position(player.currentTime, player.duration));
    });

    import("../app/peaks.js").then(({ getPeaks }) =>
      getPeaks({ id: name, size: 0, when: 0, src })
        .then(({ peaks }) => wave.setPeaks(peaks))
        .catch(() => {}));

    const playBtn = IconButton({
      icon: "play", label: "Play the finished cover",
      onClick: () => {
        if (side === "cover") return player.toggle();
        if (original?.paused) original.play().catch(() => {}); else original?.pause();
      },
    });

    // The button reflects what is actually playing rather than what was last
    // clicked, so it stays right when a track ends on its own.
    const paintPlay = () => {
      const playing = side === "cover" ? !player.paused : Boolean(original && !original.paused);
      const what = side === "cover" ? "the finished cover" : "the original";
      playBtn.setIcon(playing ? "pause" : "play",
        playing ? `Pause ${what}` : `Play ${what}`);
    };
    player.onTime(paintPlay);

    // A/B against the original, at the same playhead. The source track lives
    // outside the app:// origin, so its bytes come over IPC as a blob. When the
    // run was trimmed, the cover's 0:00 is the trim's start, so the original
    // has to be offset by it or the two sides play different bars.
    const offset = effectiveTrim()?.start || 0;
    let original = null;
    let side = "cover";
    const ab = Segmented({
      ariaLabel: "Compare original and cover",
      options: [{ value: "original", label: "Original" }, { value: "cover", label: "Cover" }],
      value: "cover",
      onChange: async (next) => {
        if (next === side) return;
        if (next === "original" && !original) {
          const url = await sourceAudioUrl();
          if (!url) return;     // unreadable source — stay on the cover
          original = new Audio(url);
          original.preservesPitch = true;
          ["play", "pause", "ended"].forEach((type) =>
            original.addEventListener(type, paintPlay));
        }
        const wasPlaying = side === "cover" ? !player.paused : !original.paused;
        const at = side === "cover" ? player.currentTime : original.currentTime;

        if (next === "cover") {
          original.pause();
          player.seek(Math.max(0, at - offset));
          if (wasPlaying) player.play();
        } else {
          player.pause();
          original.currentTime = at + offset;
          original.playbackRate = mix.speed;
          if (wasPlaying) original.play().catch(() => {});
        }
        side = next;
        paintPlay();
      },
    });

    /* ---- live mix controls --------------------------------------------- */
    // Balance and speed are mix decisions, so they take effect on the playing
    // audio immediately. The three voice settings in the Inspector are inputs
    // to the model — there is no audio to adjust until it has run — so those
    // still need "Adjust and run again", which now reuses the separated stems.

    const mix = { gain: params.vocalGain ?? 0, speed: 1 };
    let degradeMix = null;

    // Built enabled and disabled afterwards on purpose: Button wraps itself in a
    // span when it is given a tooltip AND starts disabled, and setting
    // `.disabled` on that wrapper would never reach the real button.
    const saveBtn = Button({
      label: "Save this mix", variant: "secondary",
      tooltip: "Saves a copy at the balance and speed you are hearing.",
    });
    saveBtn.classList.add("runpanel__save");
    saveBtn.disabled = true;

    const markDirty = () => {
      saveBtn.disabled = !player.adjustable
        || (Math.abs(mix.gain - (params.vocalGain ?? 0)) < 0.01 && mix.speed === 1);
      saveBtn.querySelector(".btn__label").textContent = "Save this mix";
    };

    const balance = Slider({
      label: "Vocal balance",
      min: -6, max: 6, step: 0.5, value: mix.gain,
      format: (v) => `${v > 0 ? "+" : ""}${v} dB`,
      disabled: !player.adjustable,
      help: player.adjustable
        ? "Heard as you drag it."
        : "This cover's working files are gone, so its balance is fixed.",
      onInput: (v) => { mix.gain = v; player.setBalance(v); markDirty(); },
    });

    const speed = Select({
      label: "Speed",
      options: SPEEDS,
      value: "1",
      onChange: (v) => {
        mix.speed = Number(v);
        player.setRate(mix.speed);
        if (original) original.playbackRate = mix.speed;
        markDirty();
      },
    });

    degradeMix = () => {
      balance.input.disabled = true;
      const help = balance.querySelector(".field__help");
      if (help) {
        help.textContent = "This cover's working files are gone, so its balance is fixed.";
      }
      markDirty();
    };

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.querySelector(".btn__label").textContent = "Saving…";
      try {
        const { cover } = await api.remix({
          id: name,
          vocalGainDb: mix.gain,
          speed: mix.speed,
          outputFormat: params.outputFormat || "mp3",
        });
        loadCovers();
        saveBtn.querySelector(".btn__label").textContent = "Saved to Covers";
        toast({ message: `Saved as ${cover?.title || "a new cover"}` });
      } catch (err) {
        markDirty();
        toast({ message: err.message });
      }
    });

    player.setBalance(mix.gain);

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
          tooltip: "For pitch and voice settings. Separation is reused, so it's quicker than the first run.",
          onClick: () => {
            player.destroy();
            original?.pause();
            resultPlayer = null;
            jobId = null;
            resultWave = null;
            paintResult();
            paintGenerate();
          } }),
      ),
      el("div", { class: "runpanel__mix" },
        balance,
        speed,
        saveBtn,
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
    if (fetchJobId) return "Still fetching that link.";
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
        trim: effectiveTrim(),
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
      if (file) {
        if (!AUDIO_RE.test(file.name)) return;
        const path = window.vocalis.pathForFile(file);
        if (path) setSong({ path, name: file.name });
        return;
      }

      // Dragging a song out of a browser hands over text, not a file.
      const text = (e.dataTransfer?.getData("text/uri-list")
        || e.dataTransfer?.getData("text/plain") || "").trim();
      if (!song && !fetchJobId && URL_RE.test(text)) fetchLink(text);
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
    // A half-finished download has nowhere to be delivered once the view is
    // gone, so it stops with the view rather than running on unattended.
    if (fetchJobId) cancelJob(fetchJobId);
    offs.forEach((f) => f());
    offDrag.forEach((f) => f());
    songSection.querySelector(".trimpanel")?.destroy?.();
    if (sourceBlobUrl) URL.revokeObjectURL(sourceBlobUrl);
    resultPlayer?.destroy();
    resultWave?.destroy?.();
    setFlowDirtyCheck(null);
  };

  // Consume the draft so a later visit starts clean.
  if (getState().coverDraft) set({ coverDraft: null });

  return root;
}
