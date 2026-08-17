/**
 * Routing — §8.
 *
 * Two library places (/covers, /voices) plus two full-view flows that push over
 * the library with Cancel in the toolbar and Esc to exit. There is no Home
 * route; the app opens to the library the way Music, Photos and Notes do.
 */

import { set, getState } from "./store.js";
import { Sheet, Button } from "../components/primitives/index.js";

export const PLACES = ["covers", "spoken", "voices"];
export const FLOWS = ["new-cover", "batch", "speak", "train", "settings"];

// View names (places) stay capitalised; actions are sentence case (§10).
const TITLES = {
  covers: "Covers",
  spoken: "Spoken",
  voices: "Voices",
  "new-cover": "New cover",
  batch: "Batch",
  speak: "Speak",
  train: "Train a voice",
  settings: "Settings",
};

export const titleFor = (id) => TITLES[id] || "";

/** Set by the active flow when it has work that would be lost on cancel. */
let dirtyCheck = null;
export function setFlowDirtyCheck(fn) { dirtyCheck = fn; }

/**
 * @param {string} id     place id or flow id
 * @param {{flow?: boolean}} [opts]
 */
export function navigate(id, opts = {}) {
  if (FLOWS.includes(id) || opts.flow) {
    set({ flow: id });
    return;
  }
  if (!PLACES.includes(id)) return;
  // Leaving a flow by clicking a place goes through the same guard as Esc.
  if (getState().flow) {
    exitFlow(() => set({ route: id, selection: [], query: "" }));
    return;
  }
  set({ route: id, selection: [], query: "" });
}

/**
 * Leave the active flow, confirming first if work would be lost.
 * @param {Function} [then] runs once the flow has actually closed
 */
export function exitFlow(then) {
  const close = () => {
    dirtyCheck = null;
    set({ flow: null });
    then?.();
  };

  if (!dirtyCheck?.()) return close();

  const sheet = Sheet({
    title: "Discard this draft?",
    body: "You have unsaved work in this view. Leaving now discards it.",
    actions: [
      Button({ label: "Keep editing", variant: "secondary", onClick: () => sheet.close() }),
      Button({
        label: "Discard",
        variant: "destructive",
        fill: true,
        onClick: () => { sheet.close(); close(); },
      }),
    ],
  });
}

/** Esc — cancel a flow (§9). Returns true if it handled the key. */
export function handleEscape() {
  if (!getState().flow) return false;
  exitFlow();
  return true;
}
