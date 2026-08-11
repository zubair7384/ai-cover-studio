/**
 * ReadingView — the script with a live playhead running through it.
 *
 * This is the Waveform idea applied to text (§6): graphite for what hasn't been
 * said, amber for exactly where the voice is now, and full-strength text for
 * what has been. Amber stays the one live signal on the screen.
 *
 * Smoothness comes from three things, in order of how much they matter:
 *
 *   1. It is driven by requestAnimationFrame against `audio.currentTime`, not
 *      by the `timeupdate` event. timeupdate fires about four times a second,
 *      which is visibly steppy.
 *   2. The current word fills left to right rather than switching on. The fill
 *      is a gradient hard-stop moved by a CSS variable, so it interpolates at
 *      display rate without animating a property the compositor has to lay out.
 *   3. Class changes touch only the words that actually changed state, so a
 *      long script doesn't restyle hundreds of spans every frame.
 *
 * Word timings are estimates within a line (see engine._word_timings), so the
 * fill is deliberately soft-edged: a hard 1px edge would advertise a precision
 * the data doesn't have.
 */

import { el } from "../../lib/dom.js";

const reduceMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * @param {object}   o
 * @param {string}   o.text      the exact string the timings index into
 * @param {Array<{start:number,end:number,charStart:number,charEnd:number}>} o.timings
 * @param {Function} [o.onSeek]  (seconds) => void, from clicking a word
 */
export function ReadingView({ text = "", timings = [], onSeek } = {}) {
  const body = el("div", { class: "reading__body" });
  const node = el("div", {
    class: "reading",
    role: "group",
    "aria-label": "Script, following the audio",
  }, body);

  /* ---- build ----------------------------------------------------------- */
  // Everything between two words (spaces, newlines, punctuation the tokeniser
  // dropped) is emitted as plain text, so the script keeps its own shape.

  const words = [];
  let cursor = 0;

  timings.forEach((t, i) => {
    if (t.charStart > cursor) {
      body.appendChild(document.createTextNode(text.slice(cursor, t.charStart)));
    }
    const span = el("span", {
      class: "reading__w",
      dataset: { i: String(i) },
    }, text.slice(t.charStart, t.charEnd));
    body.appendChild(span);
    words.push({ span, start: t.start, end: t.end });
    cursor = t.charEnd;
  });
  if (cursor < text.length) {
    body.appendChild(document.createTextNode(text.slice(cursor)));
  }

  // No timings (an older clip, or a failed measure) — still show the script,
  // just without a playhead. Better than an empty panel.
  if (!words.length) {
    body.textContent = text;
    node.dataset.static = "true";
  }

  /* ---- state ----------------------------------------------------------- */

  let live = -1;          // index of the word currently being spoken
  let highWater = -1;     // furthest word marked read, so rewinding can undo it

  /** Words are in order, so a seek is the only case needing a real search. */
  function indexAt(seconds) {
    let lo = 0;
    let hi = words.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= seconds) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  }

  function setClasses(next) {
    if (next === live) return;

    // Mark everything up to `next` as read, and un-mark anything past it after
    // a rewind. Only the changed range is touched.
    if (next > highWater) {
      for (let i = Math.max(0, highWater); i <= next; i += 1) {
        words[i].span.classList.add("reading__w--read");
      }
      highWater = next;
    } else if (next < highWater) {
      for (let i = next + 1; i <= highWater; i += 1) {
        words[i].span.classList.remove("reading__w--read");
        words[i].span.style.removeProperty("--p");
      }
      highWater = next;
    }

    if (live >= 0 && words[live]) {
      words[live].span.classList.remove("reading__w--live");
      words[live].span.style.removeProperty("--p");
    }
    live = next;
    if (live >= 0 && words[live]) {
      words[live].span.classList.add("reading__w--live");
      keepVisible(words[live].span);
    }
  }

  /* ---- scrolling ------------------------------------------------------- */
  // Only when the live word has actually left the box, and to a third from the
  // top rather than the very edge, so the eye has somewhere to go next.

  function keepVisible(span) {
    const box = node.getBoundingClientRect();
    const word = span.getBoundingClientRect();
    const pad = 24;
    if (word.top >= box.top + pad && word.bottom <= box.bottom - pad) return;

    const target = node.scrollTop + (word.top - box.top) - node.clientHeight / 3;
    node.scrollTo({
      top: Math.max(0, target),
      behavior: reduceMotion() ? "auto" : "smooth",
    });
  }

  /* ---- api ------------------------------------------------------------- */

  /**
   * @param {number} seconds  playhead position
   *
   * Between two words — a comma, a line break — the previous word is held at
   * full fill rather than dropped back. The alternative flickers the accent off
   * and on again several times a line.
   */
  node.setTime = (seconds) => {
    if (!words.length) return;
    const i = indexAt(seconds);
    if (i < 0) {                        // before the first word
      setClasses(-1);
      return;
    }
    setClasses(i);
    const { start, end, span } = words[i];
    const span_sec = end - start;
    const p = span_sec > 0 ? (seconds - start) / span_sec : 1;
    span.style.setProperty("--p", `${Math.max(0, Math.min(1, p)) * 100}%`);
  };

  /** Dim the whole thing while nothing is playing, so it reads as inert. */
  node.setPlaying = (playing) => {
    node.dataset.playing = playing ? "true" : "false";
  };

  node.reset = () => {
    words.forEach(({ span }) => {
      span.classList.remove("reading__w--read", "reading__w--live");
      span.style.removeProperty("--p");
    });
    live = highWater = -1;
    node.scrollTo({ top: 0, behavior: "auto" });
  };

  if (onSeek && words.length) {
    body.addEventListener("click", (e) => {
      const span = e.target.closest?.(".reading__w");
      if (!span) return;
      const i = Number(span.dataset.i);
      if (Number.isFinite(i) && words[i]) onSeek(words[i].start);
    });
    body.classList.add("reading__body--seekable");
  }

  return node;
}
