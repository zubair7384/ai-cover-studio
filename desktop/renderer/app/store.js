/**
 * A very small observable store.
 *
 * The old renderer kept everything in one mutable `state` object and re-rendered
 * whole screens by hand. This replaces that: modules subscribe to the slices
 * they care about and update only their own DOM.
 *
 * Deliberately tiny — no immutability, no reducers, no dependency tracking.
 * `set()` shallow-merges and notifies subscribers whose watched keys changed.
 */

const PREFIX = "vocalis.";

function persisted(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function persist(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* quota or private mode — non-fatal */ }
}

export function readPersisted(key, fallback) {
  return persisted(key, fallback);
}

/** @typedef {(state: object, changed: string[]) => void} Listener */

const state = {
  // navigation
  route: "covers",          // "covers" | "voices"
  flow: null,               // null | "new-cover" | "train"

  // data
  covers: [],               // [{ name, size, modified }]
  voices: [],               // [{ name, size, modified, has_index }]
  loading: { covers: true, voices: true },
  error: { covers: null, voices: null },

  // selection + search
  selection: [],            // ids of selected rows in the active view
  query: "",

  // playback — the player bar mounts only when this is set
  nowPlaying: null,         // { id, title, voice, src, originalSrc? }

  // long-running jobs (Prompt 4/5 populate this; the sidebar reads it)
  jobs: [],                 // [{ id, kind, name, progress, stage }]

  // chrome
  sidebarWidth: persisted("sidebarWidth", 220),
  sidebarVisible: persisted("sidebarVisible", true),
  profile: persisted("profile", null),   // { name, avatar }
  appVersion: "",
};

/** @type {Set<{keys: Set<string>|null, fn: Listener}>} */
const listeners = new Set();

export function getState() {
  return state;
}

/**
 * Merge a patch into state and notify anyone watching a changed key.
 * Values are compared by identity, so always pass a new array/object to signal
 * a change to a collection.
 */
export function set(patch) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] === v) continue;
    state[k] = v;
    changed.push(k);
  }
  if (!changed.length) return;

  for (const l of listeners) {
    if (!l.keys || changed.some((k) => l.keys.has(k))) l.fn(state, changed);
  }
}

/**
 * Subscribe to state changes.
 * @param {string[]|null} keys  keys to watch, or null for all changes
 * @param {Listener} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(keys, fn) {
  const entry = { keys: keys ? new Set(keys) : null, fn };
  listeners.add(entry);
  return () => listeners.delete(entry);
}

/* ---- persisted slices --------------------------------------------------- */
// Written straight through so window geometry survives a relaunch (§9).

export function setSidebarWidth(px) {
  const clamped = Math.max(180, Math.min(320, Math.round(px)));
  persist("sidebarWidth", clamped);
  set({ sidebarWidth: clamped });
}

export function setSidebarVisible(visible) {
  persist("sidebarVisible", !!visible);
  set({ sidebarVisible: !!visible });
}

export function setProfile(profile) {
  persist("profile", profile);
  set({ profile });
}
