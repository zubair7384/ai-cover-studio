/**
 * Toasts — bottom-centre, above the player bar. §Prompt 7.
 *
 * One at a time, 4 seconds, and the verb matches the button that caused it:
 * "Generate cover" → "Cover generated"; "Delete" → "Cover deleted · Undo".
 *
 * Undo is real, not cosmetic. A destructive action is *staged* rather than
 * performed: the row disappears immediately, and the actual delete only commits
 * when the toast expires. Undo cancels it before anything leaves disk, which is
 * the only way to offer undo for a Trash operation honestly.
 */

import { el, on } from "../lib/dom.js";
import { Button } from "../components/primitives/index.js";

const DURATION = 4000;

let host = null;
let current = null;   // { node, timer, commit }

function layer() {
  if (!host) {
    host = el("div", { id: "toast-host", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  return host;
}

/** Commit whatever is pending and clear the current toast. */
function settle(run = true) {
  if (!current) return;
  const { node, timer, commit } = current;
  clearTimeout(timer);
  current = null;
  node.classList.remove("toast--in");
  setTimeout(() => node.remove(), 200);
  if (run) commit?.();
}

/**
 * @param {object} o
 * @param {string} o.message
 * @param {string} [o.actionLabel]  e.g. "Undo"
 * @param {Function} [o.onAction]   runs INSTEAD of commit
 * @param {Function} [o.commit]     runs when the toast expires or is replaced
 */
export function toast({ message, actionLabel, onAction, commit } = {}) {
  // Max one at a time — an earlier pending action commits rather than vanishing.
  settle(true);

  const node = el("div", { class: "toast", role: "status" },
    el("span", { class: "toast__text t-body" }, message),
  );

  if (actionLabel) {
    node.appendChild(Button({
      label: actionLabel,
      variant: "tertiary",
      size: "sm",
      onClick: () => {
        const entry = current;
        settle(false);            // cancel the pending commit
        entry?.onAction?.();
      },
    }));
  }

  layer().appendChild(node);
  requestAnimationFrame(() => node.classList.add("toast--in"));

  const timer = setTimeout(() => settle(true), DURATION);
  current = { node, timer, commit, onAction };
  return { dismiss: () => settle(true) };
}

/** Flush any pending destructive action — call before the window closes. */
export const flushToasts = () => settle(true);
on(window, "beforeunload", flushToasts);
