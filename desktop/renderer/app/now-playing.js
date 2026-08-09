/**
 * What the player bar is holding.
 *
 * The bar is permanent chrome (§8), so it should almost never be empty: on a
 * cold start it picks up the newest cover in the library, and a cover that has
 * just been generated takes it over. Selecting never starts playback — it only
 * loads the track, so launching the app is silent.
 */

import { getState, set, subscribe } from "./store.js";
import { mediaUrl } from "./api.js";

/** Set the player's track. Accepts a Covers row item. */
export function play(item) {
  set({ nowPlaying: { id: item.id, title: item.title, voice: item.voice, src: item.src } });
}

/** A library record → the shape the player bar reads. */
const fromRecord = (rec) => ({
  id: rec.id,
  title: rec.title,
  voice: rec.voiceName,
  src: mediaUrl(rec.id),
});

// A record whose file is gone plays as silence, so it is never auto-picked.
const playable = (covers) => covers.filter((c) => !c.missing);

const newest = (covers) =>
  covers.reduce((best, c) => ((c.createdAt ?? 0) > (best.createdAt ?? 0) ? c : best));

/**
 * Keep a track loaded as the library changes.
 * @returns {() => void} unsubscribe
 */
export function watchLibrary() {
  /** ids from the previous snapshot; null until the first load lands. */
  let known = null;

  const apply = () => {
    const { covers, nowPlaying } = getState();
    const usable = playable(covers);
    // Covers arriving since the last snapshot — one of them is the cover the
    // user just generated, since jobs.js reloads the library on "done".
    const fresh = known ? usable.filter((c) => !known.has(c.id)) : [];
    const firstLoad = known === null;
    known = new Set(usable.map((c) => c.id));

    if (!usable.length) {
      if (nowPlaying) set({ nowPlaying: null });
      return;
    }
    if (!firstLoad && fresh.length) {
      play(fromRecord(newest(fresh)));
      return;
    }
    // Nothing loaded yet, or what was loaded has been deleted underneath us.
    if (!nowPlaying || !known.has(nowPlaying.id)) play(fromRecord(newest(usable)));
  };

  apply();
  return subscribe(["covers"], apply);
}
