/**
 * Covers — the launch view (§8).
 *
 * DELIBERATELY THIN. Prompt 2 rebuilds this properly: real stored metadata,
 * 56px rows with waveform thumbnails, sticky date headers, multi-select,
 * drag-to-Finder, the detail sheet and the delete confirm. What is here is
 * enough to give the shell something true to render and to exercise selection,
 * search and the player bar.
 *
 * It does NOT invent data: the sidecar only reports { name, size, modified },
 * so a cover with no derivable title falls back to its date rather than showing
 * a raw generated filename (§10).
 */

import { el, cls } from "../lib/dom.js";
import { Button, EmptyState, IconButton, Spinner } from "../components/primitives/index.js";
import { Waveform } from "../components/meter/index.js";
import { getState, set, subscribe } from "../app/store.js";
import { navigate } from "../app/router.js";
import { mediaUrl, loadCovers } from "../app/api.js";
import * as fmt from "../app/format.js";

/** Build the display model the shell needs from what the server actually has. */
function toItem(cover) {
  const derived = fmt.titleFromFilename(cover.name);
  const when = fmt.timestampFromFilename(cover.name) ?? cover.modified;
  return {
    id: cover.name,
    // Prompt 2 replaces this with a stored title + real voice name.
    title: derived || `Cover — ${fmt.date(when)}`,
    voice: null,
    when,
    size: cover.size,
    src: mediaUrl(cover.name),
  };
}

function matches(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.title.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
}

function Row(item, selected) {
  const thumb = Waveform({
    peaks: [], progress: 0, height: 20, barWidth: 2, gap: 1,
    disabled: true, ariaLabel: "",
  });
  thumb.style.width = "40px";
  thumb.style.flex = "none";

  const row = el("div", {
    class: cls("row", selected && "row--on"),
    role: "option",
    tabindex: "0",
    "aria-selected": selected ? "true" : "false",
    dataset: { id: item.id },
  },
    thumb,
    el("div", { class: "row__main" },
      el("div", { class: "row__title t-body-em" }, item.title),
      el("div", { class: "row__meta t-caption" },
        // "Unknown voice" is honest — Prompt 2's migration records the real one.
        `${item.voice || "Unknown voice"} · ${fmt.bytes(item.size)} · ${fmt.date(item.when)}`),
    ),
    el("div", { class: "row__trail" },
      IconButton({ icon: "play", label: `Play ${item.title}`, size: "sm",
        onClick: (e) => { e.stopPropagation(); play(item); } }),
      // Show in Finder needs an absolute path; the sidecar only reports a
      // filename today. Prompt 2's manifest adds outputPath and restores it.
    ),
  );

  const select = () => set({ selection: [item.id] });
  row.addEventListener("click", select);
  row.addEventListener("focus", select);
  row.addEventListener("dblclick", () => play(item));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") play(item);
  });

  return row;
}

function play(item) {
  set({ nowPlaying: { id: item.id, title: item.title, voice: item.voice, src: item.src } });
}

export function CoversView() {
  const list = el("div", { class: "list", role: "listbox", "aria-label": "Covers" });
  const root = el("div", {}, list);

  function paint() {
    const { covers, loading, error, query, selection } = getState();
    list.innerHTML = "";

    if (loading.covers) {
      list.appendChild(el("div", { style: { padding: "40px", textAlign: "center" } }, Spinner({ size: 20 })));
      return;
    }
    if (error.covers) {
      list.appendChild(EmptyState({
        icon: "alert",
        title: "Couldn't read your covers",
        body: error.covers,
        action: Button({ label: "Try again", variant: "primary", onClick: loadCovers }),
      }));
      return;
    }

    const items = covers.map(toItem)
      .filter((i) => matches(i, query))
      .sort((a, b) => b.when - a.when);

    if (!items.length) {
      list.appendChild(covers.length
        ? EmptyState({ icon: "search", title: "No matches", body: `Nothing matches “${query}”.` })
        : EmptyState({
            icon: "waveform",
            title: "No covers yet",
            body: "Pick a song and a voice, and Vocalis does the rest.",
            action: Button({ label: "New Cover", variant: "primary", onClick: () => navigate("new-cover") }),
          }));
      return;
    }

    items.forEach((i) => list.appendChild(Row(i, selection.includes(i.id))));
    list.appendChild(el("div", { class: "list__footer t-caption" },
      `${fmt.plural(items.length, "cover")} · stored on this Mac`));
  }

  paint();
  const off = subscribe(["covers", "loading", "error", "query", "selection"], paint);

  root.toolbar = {
    title: "Covers",
    actions: [Button({ label: "New Cover", variant: "primary", icon: "plus",
      onClick: () => navigate("new-cover") })],
  };
  root.destroy = () => off();
  return root;
}
