/**
 * Shared view states — loading, error, first launch. §Prompt 7.
 *
 * Every view uses these rather than rolling its own, so a library that is
 * loading, empty, broken or brand new looks like the same app throughout.
 */

import { el } from "../../lib/dom.js";
import { icon as makeIcon } from "../../lib/icons.js";
import { Button } from "./button.js";
import { Skeleton } from "./display.js";

/**
 * Skeleton rows while a library loads. Matches the real row height so the list
 * does not jump when the data lands.
 * @param {{rows?: number, height?: number}} [o]
 */
export function LoadingRows({ rows = 6, height = 56 } = {}) {
  const list = el("div", { class: "loadingrows", "aria-busy": "true",
    "aria-label": "Loading" });
  for (let i = 0; i < rows; i++) {
    list.appendChild(el("div", { class: "loadingrow" },
      Skeleton({ height: 40, width: "40px", radius: "var(--r-card)" }),
      el("div", { class: "loadingrow__text" },
        Skeleton({ height: 12, width: `${45 + ((i * 13) % 30)}%`, radius: "var(--r-chip)" }),
        Skeleton({ height: 10, width: `${30 + ((i * 7) % 25)}%`, radius: "var(--r-chip)" }),
      ),
    ));
  }
  return list;
}

/**
 * Inline error panel: what happened, the likely cause, one recovery action, and
 * details behind a button. Never apologises, never shows a stack trace.
 *
 * @param {object} o
 * @param {string} o.title    what happened
 * @param {string} o.body     the likely cause, in plain words
 * @param {string} [o.actionLabel]
 * @param {Function} [o.onAction]
 * @param {string} [o.details]  copied, never rendered
 */
export function ErrorPanel({ title, body, actionLabel, onAction, details } = {}) {
  return el("div", { class: "errorpanel", role: "alert" },
    el("div", { class: "errorpanel__head" },
      makeIcon("alert", 16),
      el("span", { class: "t-body-em" }, title),
    ),
    body ? el("p", { class: "t-body measure errorpanel__body" }, body) : null,
    el("div", { class: "errorpanel__actions" },
      actionLabel ? Button({ label: actionLabel, variant: "primary", size: "sm",
        onClick: onAction }) : null,
      details ? Button({ label: "Copy details", variant: "tertiary", size: "sm",
        onClick: () => navigator.clipboard.writeText(details) }) : null,
    ),
  );
}

/**
 * First launch — only when there are no voices and no covers.
 * A centred panel in the content area, not a modal. Two equal-weight paths and
 * one quiet alternative. No carousel, no progress dots.
 */
export function FirstRun({ onTrain, onImport, onSample }) {
  const path = (title, blurb, label, variant, onClick) =>
    el("div", { class: "firstrun__card" },
      el("div", { class: "t-body-em" }, title),
      el("p", { class: "t-caption firstrun__blurb" }, blurb),
      Button({ label, variant, onClick }),
    );

  return el("div", { class: "firstrun" },
    el("h1", { class: "t-title-1" }, "Sing anything in a voice you own."),
    el("p", { class: "t-body firstrun__lede measure" },
      "Vocalis runs entirely on this Mac — nothing is uploaded."),

    el("div", { class: "firstrun__paths" },
      path("Train a voice",
        "From your own recordings. Takes about an hour.",
        "Train a voice", "primary", onTrain),
      path("Import a voice",
        "An RVC .pth file you already have. Instant.",
        "Import…", "secondary", onImport),
    ),

    Button({
      label: "Just exploring? Try a cover with the sample voice.",
      variant: "tertiary",
      onClick: onSample,
    }),
  );
}
