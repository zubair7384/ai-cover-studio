/**
 * Cover detail sheet — ⌘I, Get Info, ↩, or double-click (Prompt 2).
 *
 * This is the payoff for storing metadata: the full parameter set that produced
 * a cover, in mono, with a route back into New Cover pre-filled with the same
 * settings. A backfilled record has most of this missing, and says so plainly
 * rather than showing zeros that were never used.
 */

import { el } from "../lib/dom.js";
import { Button, Sheet, Readout } from "../components/primitives/index.js";
import { Waveform } from "../components/meter/index.js";
import { getPeaks } from "../app/peaks.js";
import { navigate } from "../app/router.js";
import { set } from "../app/store.js";
import * as fmt from "../app/format.js";

/** A label/value row; unknown values are stated, never faked as 0. */
function field(label, value, { mono = false } = {}) {
  const known = value !== null && value !== undefined && value !== "";
  const valueNode = known && mono
    ? Readout({ text: String(value) })
    : el("span", { class: known ? "t-body" : "t-body detail__unknown" },
        known ? String(value) : "Not recorded");

  return el("div", { class: "detail__field" },
    el("span", { class: "detail__label t-caption" }, label),
    valueNode,
  );
}

export function openCoverDetail(item) {
  const wave = Waveform({
    peaks: [], progress: 0, height: 64,
    readout: item.durationSec ? fmt.duration(item.durationSec) : "—",
    ariaLabel: `Waveform for ${item.title}`,
    disabled: true,
  });

  getPeaks(item)
    .then(({ peaks }) => wave.setPeaks(peaks))
    .catch(() => { /* solid track is the honest fallback */ });

  const params = el("div", { class: "detail__grid" },
    field("Voice", item.voice),
    field("Pitch shift", item.pitchShift === null || item.pitchShift === undefined
      ? null
      : `${item.pitchShift > 0 ? "+" : ""}${item.pitchShift} st`, { mono: true }),
    field("Voice character", item.voiceCharacter ?? null, { mono: true }),
    field("Sample rate", item.sampleRate ? `${item.sampleRate} Hz` : null, { mono: true }),
    field("Source song", item.sourceFileName),
    field("Format", (item.outputFormat || "mp3").toUpperCase()),
    field("Duration", item.durationSec ? fmt.duration(item.durationSec) : null, { mono: true }),
    field("Size", fmt.bytes(item.size), { mono: true }),
  );

  const pathRow = el("div", { class: "detail__path" },
    el("span", { class: "detail__label t-caption" }, "Where it lives"),
    el("code", { class: "detail__pathvalue t-caption" }, item.outputPath || "—"),
    Button({
      label: "Show in Finder",
      variant: "tertiary",
      size: "sm",
      disabled: !item.outputPath,
      onClick: () => window.vocalis.revealPath(item.outputPath),
    }),
  );

  const body = el("div", { class: "detail" }, wave, params, pathRow);

  // "Make another with these settings" only makes sense when there ARE
  // settings — a backfilled record has none to carry over.
  const canRepeat = Boolean(item.voice) && item.pitchShift !== null
    && item.pitchShift !== undefined;

  const sheet = Sheet({
    title: item.title,
    body,
    actions: [
      Button({ label: "Done", variant: "secondary", onClick: () => sheet.close() }),
      Button({
        label: "Make another with these settings",
        variant: "primary",
        disabled: !canRepeat,
        tooltip: canRepeat
          ? "Opens New cover with the same voice and parameters."
          : "This cover predates parameter recording, so there is nothing to reuse.",
        onClick: () => {
          set({
            coverDraft: {
              voiceId: item.voiceId || item.voice,
              pitchShift: item.pitchShift,
              voiceCharacter: item.voiceCharacter,
              outputFormat: item.outputFormat,
            },
          });
          sheet.close();
          navigate("new-cover");
        },
      }),
    ],
    onClose: () => wave.destroy?.(),
  });

  return sheet;
}
