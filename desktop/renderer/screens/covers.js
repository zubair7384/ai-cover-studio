/**
 * Covers — the launch view (§8), to Prompt 2.
 *
 * A list, not a table. Every row is a real cover with a real title, a real
 * voice where one was recorded, and a waveform drawn from the audio itself.
 * The old build showed `final_cover_20260717_024930.mp3` against an empty Voice
 * column; nothing here falls back to that, and nothing is invented — a record
 * with no recorded voice says "Unknown voice".
 */

import { el, cls, on } from "../lib/dom.js";
import {
  Button, EmptyState, IconButton, Select, Checkbox, Sheet, TextField,
  ContextMenu, Menu, LoadingRows, ErrorPanel, FirstRun,
} from "../components/primitives/index.js";
import { WaveThumb } from "../components/meter/thumbnail.js";
import { icon as makeIcon } from "../lib/icons.js";
import { getState, set, subscribe } from "../app/store.js";
import { play } from "../app/now-playing.js";
import { navigate } from "../app/router.js";
import { mediaUrl, loadCovers, runJob, api } from "../app/api.js";
import { getPeaks, peekPeaks } from "../app/peaks.js";
import { toast } from "../app/toast.js";
import { openCoverDetail } from "./cover-detail.js";
import * as fmt from "../app/format.js";

const SORTS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "song", label: "Song" },
  { value: "voice", label: "Voice" },
];

/**
 * Covers and spoken clips are two places over one list.
 *
 * They share the manifest, the row, the player, export, rename, delete and
 * drag-out — so sharing the view is the honest expression of that. What differs
 * is only naming and the primary action, which is what this table holds.
 */
const KINDS = {
  cover: {
    kind: "cover",
    // Karaoke tracks are exported from covers and live with them.
    kinds: ["cover", "karaoke"],
    title: "Covers",
    noun: "cover",
    icon: "waveform",
    emptyTitle: "No covers yet",
    emptyBody: "Pick a song and a voice, and Vocalis does the rest.",
    actionLabel: "New cover",
    actionIcon: "plus",
    flow: "new-cover",
  },
  speech: {
    kind: "speech",
    kinds: ["speech"],
    title: "Spoken",
    noun: "clip",
    icon: "speech",
    emptyTitle: "No spoken clips yet",
    emptyBody: "Type a script, pick a voice, and Vocalis reads it in your own.",
    actionLabel: "Speak",
    actionIcon: "speech",
    flow: "speak",
  },
};

function toItem(rec) {
  return {
    id: rec.id,
    title: rec.title,
    sourceFileName: rec.sourceFileName,
    voice: rec.voiceName,
    voiceId: rec.voiceId,
    when: rec.createdAt,
    size: rec.sizeBytes,
    durationSec: rec.durationSec,
    pitchShift: rec.pitchShift,
    voiceCharacter: rec.voiceCharacter,
    sampleRate: rec.sampleRate,
    outputFormat: rec.outputFormat,
    outputPath: rec.outputPath,
    missing: Boolean(rec.missing),
    src: mediaUrl(rec.id),
    // Older records predate the field, and everything before Speak was a cover.
    kind: rec.kind || "cover",
    text: rec.text || null,
  };
}

/** Search filters title, voice and source filename, live. */
const matches = (item, q) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [item.title, item.voice, item.sourceFileName, item.id]
    .filter(Boolean).some((f) => f.toLowerCase().includes(needle));
};

function sortItems(items, mode) {
  const by = {
    newest: (a, b) => b.when - a.when,
    oldest: (a, b) => a.when - b.when,
    song: (a, b) => a.title.localeCompare(b.title),
    // Unknown voices sort last rather than first.
    voice: (a, b) => (a.voice || "￿").localeCompare(b.voice || "￿"),
  };
  return [...items].sort(by[mode] || by.newest);
}

/* ---- destructive + rename flows ----------------------------------------- */

function confirmDelete(items) {
  const many = items.length > 1;
  const trash = Checkbox({ label: "Also move the file to Trash", checked: true });

  const sheet = Sheet({
    title: many ? `Delete ${items.length} covers?` : `Delete “${items[0].title}”?`,
    body: el("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      el("div", {}, many
        ? "They are removed from your library."
        : "It is removed from your library."),
      trash,
    ),
    actions: [
      Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
      Button({
        label: "Delete", variant: "destructive", fill: true,
        onClick: () => {
          const alsoTrash = trash.input.checked;
          sheet.close();
          stageDelete(items, alsoTrash);
        },
      }),
    ],
  });
}

/**
 * Hide the rows now; delete for real when the toast expires. Undo cancels the
 * commit before anything leaves disk — the only honest way to offer undo on a
 * Trash operation.
 */
function stageDelete(items, alsoTrash) {
  const ids = items.map((i) => i.id);
  set({ pendingDelete: [...getState().pendingDelete, ...ids], selection: [] });

  const unstage = () =>
    set({ pendingDelete: getState().pendingDelete.filter((id) => !ids.includes(id)) });

  toast({
    message: items.length > 1 ? `${items.length} covers deleted`
                              : `\u201C${items[0].title}\u201D deleted`,
    actionLabel: "Undo",
    onAction: unstage,
    commit: async () => {
      for (const id of ids) await api.deleteCover(id, alsoTrash).catch(() => {});
      unstage();
      await loadCovers();
    },
  });
}

/** Re-point a record at a file that moved outside the app. */
async function locateFile(item) {
  const path = await window.vocalis.pickAudio(`Where is \u201C${item.title}\u201D now?`);
  if (!path) return;
  await api.relocateCover(item.id, path).catch(() => {});
  await loadCovers();
  toast({ message: "Cover relocated" });
}

async function removeFromLibrary(item) {
  await api.deleteCover(item.id, false).catch(() => {});
  await loadCovers();
  toast({ message: "Removed from library" });
}

function promptRename(item) {
  const field = TextField({ label: "Title", value: item.title });
  const commit = async () => {
    const next = field.input.value.trim();
    sheet.close();
    if (!next || next === item.title) return;
    await api.renameCover(item.id, next).catch(() => {});
    await loadCovers();
    toast({ message: "Cover renamed" });
  };
  const sheet = Sheet({
    title: "Rename cover",
    body: field,
    actions: [
      Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
      Button({ label: "Rename", variant: "primary", onClick: commit }),
    ],
  });
  field.input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
  field.input.select();
}

const exportItems = (items) => window.vocalis.exportFiles(
  items.filter((i) => i.outputPath && !i.missing)
       .map((i) => ({ path: i.outputPath, name: `${i.title}.${i.outputFormat || "mp3"}` }))
);

/* ---- exports built from a cover's separated stems ------------------------ */
/*
 * Both of these are nearly free: the separator already produced this audio
 * during the cover run and the manifest remembers where it went. What they are
 * not is instant — an encode of a five-minute track takes a moment — so they go
 * through the job stream and report when they land.
 *
 * A cover whose working files were cleaned up cannot do either. Rather than
 * hiding the actions (which would leave the user wondering where they went),
 * they run and the engine explains what happened.
 */
async function exportKaraoke(item) {
  toast({ message: `Making a backing track from ${item.title}…` });
  try {
    const { job_id } = await api.karaoke({ id: item.id,
                                           outputFormat: item.outputFormat || "mp3" });
    const cover = await runJob(job_id);
    await loadCovers();
    toast({ message: `Saved “${cover.title}” to your library.` });
  } catch (err) {
    toast({ message: err.message });
  }
}

async function exportStems(item) {
  const folder = await window.vocalis.pickFolder();
  if (!folder) return;

  toast({ message: `Writing the stems of ${item.title}…` });
  try {
    const { job_id } = await api.exportStems({ id: item.id, destDir: folder });
    const result = await runJob(job_id);
    toast({
      message: `Wrote ${result.count} stem${result.count === 1 ? "" : "s"}.`,
      actionLabel: "Show in Finder",
      onAction: () => window.vocalis.revealPath(result.files[0]),
    });
  } catch (err) {
    toast({ message: err.message });
  }
}

/* ---- row ---------------------------------------------------------------- */

function menuItems(item, selected) {
  const targets = selected.length > 1 ? selected : [item];
  if (item.missing) {
    // A file that moved outside the app gets recovery actions, not the usual set.
    return [
      { label: "Locate\u2026", icon: "folder", onSelect: () => locateFile(item) },
      { label: "Remove from library", icon: "trash", destructive: true,
        onSelect: () => removeFromLibrary(item) },
    ];
  }
  return [
    { label: "Play", icon: "play", disabled: item.missing, onSelect: () => play(item) },
    { label: "Show in Finder", icon: "folder", disabled: !item.outputPath,
      onSelect: () => window.vocalis.revealPath(item.outputPath) },
    { label: "Get info", icon: "info", shortcut: "⌘I", onSelect: () => openCoverDetail(item) },
    { separator: true },
    { label: targets.length > 1 ? `Export ${targets.length}…` : "Export…", icon: "export",
      onSelect: () => exportItems(targets) },
    // Only for covers: a spoken clip was never separated, and a karaoke track
    // has no vocal to remove from itself.
    ...(item.kind === "cover" ? [
      { label: "Export karaoke track", icon: "waveform", disabled: targets.length > 1,
        onSelect: () => exportKaraoke(item) },
      { label: "Export stems…", icon: "export", disabled: targets.length > 1,
        onSelect: () => exportStems(item) },
    ] : []),
    { label: "Rename", disabled: targets.length > 1, onSelect: () => promptRename(item) },
    { separator: true },
    { label: targets.length > 1 ? `Delete ${targets.length}` : "Delete",
      icon: "trash", destructive: true, shortcut: "⌘⌫",
      onSelect: () => confirmDelete(targets) },
  ];
}

function Row(item, { selected, index, onSelect, selectionItems }) {
  const cached = peekPeaks(item);
  const thumb = WaveThumb({ size: 40, peaks: cached?.peaks || null });

  const caption = el("div", { class: "row__meta t-caption" }, "");
  const paintCaption = (dur) => {
    caption.textContent = [
      // No kind label here any more: each kind has its own page, so the view
      // title already says it and repeating it in every row is noise. The one
      // exception is a karaoke track, which shares the Covers page and has no
      // voice by definition — "Unknown voice" would read as a fault.
      item.kind === "karaoke" ? "Backing track" : (item.voice || "Unknown voice"),
      dur ? fmt.duration(dur) : null,
      fmt.bytes(item.size),
    ].filter(Boolean).join(" · ");
  };
  paintCaption(item.durationSec ?? cached?.duration);

  if (!cached && !item.missing) {
    getPeaks(item)
      .then(({ peaks, duration }) => {
        thumb.setPeaks(peaks);
        paintCaption(item.durationSec ?? duration);
      })
      .catch(() => { /* solid tile is the honest state */ });
  }

  const title = el("div", { class: "row__titleline" },
    el("span", { class: "row__title t-body-em" }, item.title),
  );
  // A file moved or deleted outside the app is flagged, not hidden.
  if (item.missing) {
    title.appendChild(el("span", {
      class: "row__missing",
      title: "This file has moved or been deleted.",
    }, makeIcon("alert", 12)));
  }

  const trail = item.missing
    ? el("div", { class: "row__trail row__trail--always" },
        Button({ label: "Locate\u2026", variant: "secondary", size: "sm",
          onClick: (e) => { e.stopPropagation(); locateFile(item); } }),
        Button({ label: "Remove", variant: "tertiary", size: "sm",
          onClick: (e) => { e.stopPropagation(); removeFromLibrary(item); } }),
      )
    : el("div", { class: "row__trail" },
    IconButton({ icon: "play", label: `Play ${item.title}`,
      disabled: item.missing,
      onClick: (e) => { e.stopPropagation(); play(item); } }),
    IconButton({ icon: "export", label: `Export ${item.title}`,
      disabled: item.missing,
      onClick: (e) => { e.stopPropagation(); exportItems([item]); } }),
    IconButton({ icon: "more-horizontal", label: `More actions for ${item.title}`,
      onClick: (e) => {
        e.stopPropagation();
        Menu(e.currentTarget, menuItems(item, selectionItems()));
      } }),
  );

  const row = el("div", {
    class: cls("row", "row--cover", selected && "row--on", item.missing && "row--missing"),
    role: "option",
    tabindex: "0",
    draggable: "true",
    "aria-selected": selected ? "true" : "false",
    dataset: { id: item.id, index: String(index) },
  },
    thumb,
    el("div", { class: "row__main" }, title, caption),
    trail,
  );

  row.addEventListener("click", (e) => onSelect(index, e));
  row.addEventListener("dblclick", () => openCoverDetail(item));
  row.addEventListener("contextmenu", (e) => {
    if (!selected) onSelect(index, {});
    ContextMenu(e, menuItems(item, selectionItems()));
  });

  // Drag one row, or the whole selection if this row is part of it.
  row.addEventListener("dragstart", (e) => {
    e.preventDefault();   // Electron takes over the drag from here
    const chosen = selectionItems();
    const targets = chosen.length > 1 && selected ? chosen : [item];
    window.vocalis.startDrag(targets.map((i) => i.outputPath).filter(Boolean));
  });

  row.destroy = () => thumb.destroy?.();
  return row;
}

/* ---- view --------------------------------------------------------------- */

/** The library list, for one kind of output. */
function LibraryView(config) {
  const list = el("div", {
    class: "list", role: "listbox",
    "aria-multiselectable": "true", "aria-label": config.title,
  });
  const root = el("div", { class: "column" }, list);

  let rows = [];
  let visible = [];      // items currently rendered, in display order
  let anchor = null;     // index that ⇧-select ranges from
  let sortMode = "newest";

  const selectedItems = () => {
    const ids = new Set(getState().selection);
    return visible.filter((i) => ids.has(i.id));
  };

  /* ---- selection ------------------------------------------------------- */

  function onSelect(index, e = {}) {
    const item = visible[index];
    if (!item) return;
    const current = getState().selection;

    if (e.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      set({ selection: visible.slice(from, to + 1).map((i) => i.id) });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      anchor = index;
      set({
        selection: current.includes(item.id)
          ? current.filter((id) => id !== item.id)
          : [...current, item.id],
      });
      return;
    }

    anchor = index;
    set({ selection: [item.id] });
    // A plain click loads the row into the player bar.
    if (!item.missing) play(item);
  }

  /* ---- toolbar --------------------------------------------------------- */

  const sortSelect = Select({
    options: SORTS,
    value: sortMode,
    ariaLabel: "Sort covers",
    onChange: (v) => { sortMode = v; paint(); },
  });
  sortSelect.style.width = "128px";


  function toolbarConfig() {
    const chosen = selectedItems();
    if (chosen.length > 1) {
      // The toolbar swaps to bulk actions while a multi-selection is live.
      return {
        title: `${chosen.length} selected`,
        search: false,
        actions: [
          Button({ label: "Export…", variant: "secondary", icon: "export",
            onClick: () => exportItems(chosen) }),
          Button({ label: "Delete", variant: "destructive",
            onClick: () => confirmDelete(chosen) }),
          Button({ label: "Done", variant: "tertiary",
            onClick: () => set({ selection: [] }) }),
        ],
      };
    }
    return {
      title: config.title,
      actions: [
        sortSelect,
        Button({ label: config.actionLabel, variant: "primary", icon: config.actionIcon,
          onClick: () => navigate(config.flow) }),
      ],
    };
  }

  /* ---- paint ----------------------------------------------------------- */

  function paint() {
    const { covers: all, loading, error, query, selection } = getState();
    // One manifest holds every kind; this view only ever shows its own. Records
    // written before Speak existed carry no kind and are all covers, and a
    // karaoke track belongs with the cover it came out of rather than in a
    // third place of its own.
    const covers = all.filter((c) => config.kinds.includes(c.kind || "cover"));

    rows.forEach((r) => r.destroy?.());
    rows = [];
    list.innerHTML = "";

    if (loading.covers) {
      list.appendChild(LoadingRows({ rows: 6 }));
      return;
    }
    if (error.covers) {
      list.appendChild(ErrorPanel({
        title: "Couldn't read your library",
        body: error.covers,
        actionLabel: "Try again",
        onAction: loadCovers,
      }));
      return;
    }

    // First launch: nothing made, nothing trained. A panel, not a modal. Only
    // on Covers — it offers to train and to make a first cover, neither of
    // which belongs on the Spoken page.
    if (config.kind === "cover" && !all.length
        && !getState().voices.length && !getState().loading.voices) {
      list.appendChild(FirstRun({
        onTrain: () => navigate("train"),
        onImport: async () => {
          const files = await window.vocalis.pickModelFiles();
          if (files?.length) await api.importModels(files).catch(() => {});
        },
        onSample: () => navigate("new-cover"),
      }));
      root.setToolbar?.(toolbarConfig());
      return;
    }

    const hidden = new Set(getState().pendingDelete);
    visible = sortItems(
      covers.map(toItem)
        .filter((i) => !hidden.has(i.id) && matches(i, query)), sortMode);

    if (!visible.length) {
      list.appendChild(covers.length
        ? EmptyState({ icon: "search", title: "No matches", body: `Nothing matches “${query}”.` })
        : EmptyState({
            icon: config.icon,
            title: config.emptyTitle,
            body: config.emptyBody,
            action: Button({ label: config.actionLabel, variant: "primary",
              onClick: () => navigate(config.flow) }),
          }));
      root.setToolbar?.(toolbarConfig());
      return;
    }

    // Date headers only mean anything while sorted by time.
    const grouped = sortMode === "newest" || sortMode === "oldest";
    let currentGroup = null;

    visible.forEach((item, index) => {
      if (grouped) {
        const group = fmt.dateGroup(item.when);
        if (group !== currentGroup) {
          currentGroup = group;
          list.appendChild(el("div", { class: "group-header t-label" }, group));
        }
      }
      const row = Row(item, {
        selected: selection.includes(item.id),
        index,
        onSelect,
        selectionItems: selectedItems,
      });
      rows.push(row);
      list.appendChild(row);
    });

    const chosen = selection.length;
    list.appendChild(el("div", { class: "list__footer t-caption" },
      chosen > 1
        ? `${fmt.plural(chosen, config.noun)} selected of ${visible.length}`
        : `${fmt.plural(visible.length, config.noun)} · stored on this Mac`));

    root.setToolbar?.(toolbarConfig());
  }

  /* ---- keyboard (§9) --------------------------------------------------- */

  const offKeys = on(window, "keydown", (e) => {
    if (getState().route !== "covers" || getState().flow) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;

    const chosen = selectedItems();
    const cmd = e.metaKey || e.ctrlKey;

    if (cmd && e.key.toLowerCase() === "a" && visible.length) {
      e.preventDefault();
      set({ selection: visible.map((i) => i.id) });
      return;
    }
    if (!chosen.length) return;

    // Space -> Quick Look. Takes precedence over global play/pause while a row
    // is selected, which is what a Finder-shaped library should do.
    if (e.code === "Space" && chosen.length === 1 && chosen[0].outputPath) {
      e.preventDefault();
      e.stopPropagation();
      window.vocalis.quickLook(chosen[0].outputPath);
      return;
    }
    if (e.key === "Enter" || (cmd && e.key.toLowerCase() === "i")) {
      e.preventDefault();
      openCoverDetail(chosen[0]);
      return;
    }
    if (cmd && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      confirmDelete(chosen);
    }
  }, true);

  paint();
  const off = subscribe(
    ["covers", "voices", "loading", "error", "query", "selection", "pendingDelete"],
    paint);

  root.toolbar = toolbarConfig();
  root.destroy = () => {
    off();
    offKeys();
    rows.forEach((r) => r.destroy?.());
  };
  return root;
}

export const CoversView = () => LibraryView(KINDS.cover);
export const SpokenView = () => LibraryView(KINDS.speech);
