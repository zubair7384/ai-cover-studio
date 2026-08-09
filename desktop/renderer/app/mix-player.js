/**
 * Mix player — plays a finished cover, from its stems when they still exist.
 *
 * Why stems: the exported file has the vocal balance baked in, so hearing a
 * different balance from it would mean re-exporting on every drag. Playing the
 * converted vocals against the instrumental makes balance a live control, and
 * saving becomes a re-export of what is already being heard.
 *
 * Two <audio> elements rather than a Web Audio graph, deliberately: element
 * playbackRate preserves pitch, and an AudioBufferSourceNode's does not — "2x"
 * has to mean faster, not higher.
 */

/**
 * @param {object} o
 * @param {string} o.fileSrc                    the exported cover
 * @param {{vocals:string, instrumental:string}} [o.stemSrcs]  enables balance
 * @param {Function} [o.onDegrade]  called if the stems turn out to be missing
 *   and playback falls back to the exported file
 */
export function MixPlayer({ fileSrc, stemSrcs = null, onDegrade }) {
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f());

  // `degraded` means "playing the exported file": either there were never any
  // stems, or they turned out to be gone and we fell back mid-load.
  let degraded = !stemSrcs;
  const clock = new Audio(degraded ? fileSrc : stemSrcs.vocals);
  const backing = degraded ? null : new Audio(stemSrcs.instrumental);
  const live = () => (degraded ? [clock] : [clock, backing].filter(Boolean));

  [clock, backing].filter(Boolean).forEach((element) => {
    element.preservesPitch = true;
    element.preload = "auto";
  });

  // A cover generated before Vocalis kept its stems 404s here. Falling back is
  // the only honest option: the file on disk is still playable, it just has its
  // balance baked in.
  clock.addEventListener("error", () => {
    if (degraded) return;
    degraded = true;
    const at = clock.currentTime;
    backing?.pause();
    clock.volume = 1;
    clock.src = fileSrc;
    clock.currentTime = at;
    onDegrade?.();
  });

  // Two elements started together still drift by tens of milliseconds over a
  // few minutes, which is audible as flam on a vocal. The vocal is the clock;
  // the instrumental gets nudged back onto it.
  const MAX_DRIFT = 0.08;

  clock.addEventListener("timeupdate", () => {
    if (backing && Math.abs(backing.currentTime - clock.currentTime) > MAX_DRIFT) {
      backing.currentTime = clock.currentTime;
    }
    emit();
  });
  clock.addEventListener("ended", () => { backing?.pause(); emit(); });
  clock.addEventListener("play", emit);
  clock.addEventListener("pause", emit);

  return {
    /** False when the cover's stems are gone, so balance cannot be changed. */
    get adjustable() { return !degraded; },

    get paused() { return clock.paused; },
    get currentTime() { return clock.currentTime; },
    get duration() { return clock.duration || 0; },

    async play() {
      if (!degraded && backing) backing.currentTime = clock.currentTime;
      await Promise.all(live().map((element) => element.play().catch(() => {})));
      emit();
    },
    pause() { live().forEach((element) => element.pause()); emit(); },
    toggle() { return clock.paused ? this.play() : this.pause(); },

    seek(seconds) {
      live().forEach((element) => { element.currentTime = seconds; });
      emit();
    },
    setRate(rate) {
      live().forEach((element) => { element.playbackRate = Number(rate) || 1; });
    },

    /**
     * Vocal gain in dB, applied as a ratio between the two sides — element
     * volume cannot exceed 1, so a boost becomes a cut on the other side.
     */
    setBalance(db) {
      if (degraded) return;
      const value = Number(db) || 0;
      clock.volume = Math.min(1, 10 ** (value / 20));
      backing.volume = Math.min(1, 10 ** (-value / 20));
    },

    /** @returns {Function} unsubscribe */
    onTime(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    destroy() {
      [clock, backing].filter(Boolean).forEach((element) => {
        element.pause();
        element.removeAttribute("src");
      });
      listeners.clear();
    },
  };
}
