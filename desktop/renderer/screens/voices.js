/**
 * Voices — the library of trained and imported models (§8).
 *
 * DELIBERATELY THIN. Prompt 3 rebuilds this: 60px rows, inline preview audio,
 * the "…" menu, rename/export/delete, and the sort control. What is here shows
 * the real models with correct copy and exercises the shell.
 */

import { el, cls } from "../lib/dom.js";
import { Badge, Button, EmptyState, Spinner } from "../components/primitives/index.js";
import { getState, set, subscribe } from "../app/store.js";
import { navigate } from "../app/router.js";
import { loadVoices } from "../app/api.js";
import { initials } from "../app/profile.js";
import * as fmt from "../app/format.js";

const INDEX_TIP =
  "A pitch index improves accuracy on fast or slurred phrases. You can build one from the … menu.";

function Row(voice, selected) {
  const tile = el("span", { class: "avatar" }, initials(voice.name));

  const row = el("div", {
    class: cls("row", selected && "row--on"),
    role: "option",
    tabindex: "0",
    "aria-selected": selected ? "true" : "false",
    dataset: { id: voice.name },
  },
    tile,
    el("div", { class: "row__main" },
      el("div", { class: "row__title t-body-em" }, voice.name),
      el("div", { class: "row__meta t-caption" },
        `Trained ${fmt.date(voice.modified)} · ${fmt.bytes(voice.size)}`),
    ),
    // §10: never "no index" / "has index" — say what it means for the user.
    voice.has_index
      ? Badge({ label: "Pitch index ready", tone: "ok", icon: "check", title: INDEX_TIP })
      : Badge({ label: "No pitch index", tone: "neutral", title: INDEX_TIP }),
    // The "…" menu (preview, rebuild index, rename, export, delete) is Prompt 3.
  );

  const select = () => set({ selection: [voice.name] });
  row.addEventListener("click", select);
  row.addEventListener("focus", select);
  return row;
}

export function VoicesView() {
  const list = el("div", { class: "list", role: "listbox", "aria-label": "Voices" });
  const root = el("div", {}, list);

  function paint() {
    const { voices, loading, error, query, selection } = getState();
    list.innerHTML = "";

    if (loading.voices) {
      list.appendChild(el("div", { style: { padding: "40px", textAlign: "center" } }, Spinner({ size: 20 })));
      return;
    }
    if (error.voices) {
      list.appendChild(EmptyState({
        icon: "alert",
        title: "Couldn't read your voices",
        body: error.voices,
        action: Button({ label: "Try again", variant: "primary", onClick: loadVoices }),
      }));
      return;
    }

    const items = voices
      .filter((v) => !query || v.name.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.modified - a.modified);

    if (!items.length) {
      list.appendChild(voices.length
        ? EmptyState({ icon: "search", title: "No matches", body: `Nothing matches “${query}”.` })
        : EmptyState({
            icon: "voices",
            title: "No voices yet",
            body: "Train one from 10–30 minutes of your own clean vocals, or import an RVC .pth file you already have.",
            action: Button({ label: "Train a Voice", variant: "primary", onClick: () => navigate("train") }),
          }));
      return;
    }

    items.forEach((v) => list.appendChild(Row(v, selection.includes(v.name))));

    // The honest version of the stat cards deleted from Home (Prompt 3).
    const total = items.reduce((n, v) => n + (v.size || 0), 0);
    list.appendChild(el("div", { class: "list__footer t-caption" },
      `${fmt.plural(items.length, "voice")} · ${fmt.bytes(total)} · stored on this Mac`));
  }

  paint();
  const off = subscribe(["voices", "loading", "error", "query", "selection"], paint);

  root.toolbar = {
    title: "Voices",
    // Import… returns in Prompt 3 alongside the rest of the voice actions.
    actions: [
      Button({ label: "Train a Voice", variant: "primary", icon: "plus",
        onClick: () => navigate("train") }),
    ],
  };
  root.destroy = () => off();
  return root;
}
