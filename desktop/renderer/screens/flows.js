/**
 * Full-view flows — New Cover and Train a Voice.
 *
 * PLACEHOLDERS. Prompt 4 builds New Cover (drop zone, voice picker, Pipeline,
 * inspector) and Prompt 5 builds Train a Voice (recordings meter, quality
 * presets, live training panel). This file exists so the shell's push/Cancel/Esc
 * behaviour is real and testable now, and so the routes are not dead ends.
 *
 * They are honest about their state rather than pretending to work.
 */

import { el } from "../lib/dom.js";
import { Button, EmptyState } from "../components/primitives/index.js";
import { exitFlow } from "../app/router.js";

function placeholder({ title, icon, body }) {
  const root = el("div", {},
    EmptyState({ icon, title, body }),
  );
  root.toolbar = {
    title,
    search: false,
    actions: [Button({ label: "Cancel", variant: "secondary", onClick: () => exitFlow() })],
  };
  return root;
}

export const NewCoverFlow = () => placeholder({
  title: "New Cover",
  icon: "headphones",
  body: "The cover-generation flow is rebuilt in the next pass. Press Esc or Cancel to go back.",
});

export const TrainFlow = () => placeholder({
  title: "Train a Voice",
  icon: "mic",
  body: "The training flow is rebuilt in a later pass. Press Esc or Cancel to go back.",
});
