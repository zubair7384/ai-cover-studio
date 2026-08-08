/**
 * Global player bar — §8. 48px, docked to the bottom of the content area,
 * mounts only when a cover is loaded.
 *
 * The A/B toggle crossfades between the original and the cover at the SAME
 * playhead position, so you hear the same bar of music either way. Two audio
 * elements are kept in sync and their volumes crossfaded; that is simpler and
 * far more robust than routing both through MediaElementSource nodes, which
 * permanently bind an element to an AudioContext.
 */

import { el, on } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import { IconButton, Slider, Popover, Segmented } from "../components/primitives/index.js";
import { Waveform, peaksFromAudioBuffer } from "../components/meter/index.js";
import { position } from "./format.js";
import { getState, subscribe, readPersisted, persist } from "./store.js";

const CROSSFADE_MS = 120;

let sharedCtx = null;
const audioContext = () => (sharedCtx ||= new (window.AudioContext || window.webkitAudioContext)());

/** Fetch and decode a source once to get display peaks. */
async function loadPeaks(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const audio = await audioContext().decodeAudioData(buf);
  return { peaks: peaksFromAudioBuffer(audio, 600), duration: audio.duration };
}

export function PlayerBar() {
  const root = el("div", { class: "player", hidden: true, role: "region", "aria-label": "Player" });

  /* ---- audio ------------------------------------------------------------ */

  const cover = new Audio();
  const original = new Audio();
  [cover, original].forEach((a) => { a.preload = "auto"; a.volume = 0; });

  let source = "cover";                          // which side is audible
  let volume = readPersisted("volume", 1);
  let duration = 0;
  let hasOriginal = false;

  const active = () => (source === "cover" ? cover : original);
  const inactive = () => (source === "cover" ? original : cover);

  function applyVolume() {
    active().volume = volume;
    inactive().volume = 0;
  }

  /** Crossfade to the other source, preserving playhead and play state. */
  function switchTo(next) {
    if (next === source || (next === "original" && !hasOriginal)) return;
    const from = active();
    const to = next === "cover" ? cover : original;

    to.currentTime = from.currentTime;    // same bar of music
    if (!from.paused) to.play().catch(() => {});

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / CROSSFADE_MS);
      to.volume = volume * t;
      from.volume = volume * (1 - t);
      if (t < 1) requestAnimationFrame(step);
      else { from.pause(); source = next; applyVolume(); }
    };
    requestAnimationFrame(step);
  }

  /* ---- controls --------------------------------------------------------- */

  const playBtn = IconButton({
    icon: "play",
    label: "Play",
    tooltip: "Play / pause (Space)",
    onClick: () => toggle(),
  });

  const title = el("div", { class: "player__title t-body-em" }, "");
  const voice = el("div", { class: "player__voice t-caption" }, "");

  const wave = Waveform({
    peaks: [],
    progress: 0,
    height: 28,
    readout: position(0, 0),
    ariaLabel: "Scrub",
    onSeek: (fraction) => {
      if (!duration) return;
      const t = fraction * duration;
      cover.currentTime = t;
      original.currentTime = t;
      wave.setReadout(position(t, duration));
    },
  });
  wave.classList.add("player__wave");

  const ab = Segmented({
    ariaLabel: "Compare original and cover",
    options: [{ value: "original", label: "Original" }, { value: "cover", label: "Cover" }],
    value: "cover",
    onChange: switchTo,
  });

  const volumeBtn = IconButton({
    icon: "waveform",
    label: "Volume",
    onClick: () => {
      const slider = Slider({
        label: "Volume",
        min: 0, max: 1, step: 0.01, value: volume,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => { volume = v; persist("volume", v); applyVolume(); },
      });
      Popover(volumeBtn, el("div", { style: { width: "180px", padding: "8px" } }, slider));
    },
  });

  const exportBtn = IconButton({
    icon: "export",
    label: "Export cover",
    tooltip: "Export cover ⌘E",
    onClick: () => exportCurrent(),
  });

  root.append(
    playBtn,
    el("div", { class: "player__meta" }, title, voice),
    wave,
    ab,
    volumeBtn,
    exportBtn,
  );

  /* ---- transport -------------------------------------------------------- */

  function toggle() {
    const a = active();
    if (a.paused) {
      applyVolume();
      a.play().catch(() => {});
    } else {
      a.pause();
      inactive().pause();
    }
  }
  root.toggle = toggle;

  // Swap the glyph and keep the accessible name truthful with it (§11).
  function paintPlaying(playing) {
    playBtn.replaceChildren(makeIcon(playing ? "pause" : "play", 16));
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  on(cover, "play", () => paintPlaying(true));
  on(cover, "pause", () => paintPlaying(false));
  on(original, "play", () => paintPlaying(true));
  on(original, "pause", () => paintPlaying(false));

  on(cover, "timeupdate", () => {
    if (source !== "cover" || !duration) return;
    wave.setProgress(cover.currentTime / duration);
    wave.setReadout(position(cover.currentTime, duration));
  });
  on(original, "timeupdate", () => {
    if (source !== "original" || !duration) return;
    wave.setProgress(original.currentTime / duration);
    wave.setReadout(position(original.currentTime, duration));
  });
  on(cover, "ended", () => { wave.setProgress(1); paintPlaying(false); });

  async function exportCurrent() {
    const item = getState().nowPlaying;
    if (!item) return;
    const dest = await window.vocalis.saveCover(`${item.title || "cover"}.mp3`);
    if (!dest) return;
    await window.vocalis.downloadTo(item.src, dest);
    await window.vocalis.revealPath(dest);
  }

  /* ---- load ------------------------------------------------------------- */

  async function load(item) {
    if (!item) {
      cover.pause(); original.pause();
      root.hidden = true;
      return;
    }

    root.hidden = false;
    title.textContent = item.title || "Untitled";
    voice.textContent = item.voice || "Unknown voice";

    source = "cover";
    hasOriginal = Boolean(item.originalSrc);
    // A/B needs two sides; without a stored source track the toggle is inert.
    ab.style.display = hasOriginal ? "" : "none";

    cover.src = item.src;
    if (hasOriginal) original.src = item.originalSrc;
    applyVolume();

    duration = 0;
    wave.setPeaks([]);
    wave.setProgress(0);
    wave.setReadout(position(0, 0));

    try {
      const { peaks, duration: dur } = await loadPeaks(item.src);
      // Guard against a newer selection having landed while we decoded.
      if (getState().nowPlaying?.id !== item.id) return;
      duration = dur;
      wave.setPeaks(peaks);
      wave.setReadout(position(0, dur));
    } catch {
      // Decode failure is not fatal — playback and scrubbing still work off
      // the element's own duration.
      duration = cover.duration || 0;
    }
  }

  const off = subscribe(["nowPlaying"], () => load(getState().nowPlaying));
  load(getState().nowPlaying);

  root.destroy = () => {
    off();
    cover.pause(); original.pause();
    wave.destroy?.();
  };

  return root;
}
