/**
 * Voices — §8, to Prompt 3.
 *
 * A list matching Covers, replacing the three gradient cards. The row says what
 * a voice IS — sample rate, size, when it was trained — instead of leaking
 * system vocabulary like "no index".
 *
 * Preview plays INLINE in the row with a compact waveform. It deliberately does
 * not touch the global player bar: auditioning a voice is not the same act as
 * listening to a cover, and hijacking the player would evict whatever you were
 * listening to.
 */

import { el, cls } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import {
  Button, Checkbox, ContextMenu, EmptyState, IconButton, Menu, Segmented,
  Select, Sheet, Spinner, TextField, LoadingRows, ErrorPanel,
} from "../components/primitives/index.js";
import { Waveform } from "../components/meter/index.js";
import { getState, set, setVoicesTab, subscribe } from "../app/store.js";
import { OnlineVoices } from "./voices-online.js";
import { navigate } from "../app/router.js";
import { api, loadVoices, runJob } from "../app/api.js";
import { startPackInstall } from "../app/jobs.js";
import { toast } from "../app/toast.js";
import { Avatar } from "../app/avatar.js";
import * as fmt from "../app/format.js";

const SORTS = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "size", label: "Size" },
];

const INDEX_TIP =
  "A pitch index improves accuracy on fast or slurred phrases. You can build one from the … menu.";

/** One inline preview at a time — starting a second stops the first. */
let activePreview = null;

/* ---- actions ------------------------------------------------------------ */

function useInCover(voice) {
  set({ coverDraft: { voiceId: voice.name } });
  navigate("new-cover");
}

function promptRename(voice) {
  const field = TextField({
    label: "Name",
    value: voice.name,
    help: "No spaces or slashes.",
  });
  const commit = async () => {
    const next = field.input.value.trim();
    if (!next || next === voice.name) return sheet.close();
    if (/[\s/\\]/.test(next)) return field.setError("No spaces or slashes.");
    sheet.close();
    await api.renameVoice(voice.name, next).catch(() => {});
    await loadVoices();
  };
  const sheet = Sheet({
    title: "Rename voice",
    body: field,
    actions: [
      Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
      Button({ label: "Rename", variant: "primary", onClick: commit }),
    ],
  });
  field.input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
  field.input.select();
}

function confirmDelete(voice) {
  const used = voice.usedByCovers || 0;
  const keepCovers = Checkbox({
    label: "Keep the covers made with this voice",
    checked: true,
  });

  const body = el("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    el("div", {}, used
      // The warning names the real consequence rather than a generic caution.
      ? `${fmt.plural(used, "cover")} in your library ${used === 1 ? "was" : "were"} made with this voice. `
        + "Deleting the model does not delete them, but you will not be able to make more."
      : "The model file and its pitch index are removed from this Mac."),
  );
  if (used) body.appendChild(keepCovers);

  const sheet = Sheet({
    title: `Delete “${voice.name}”?`,
    body,
    actions: [
      Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
      Button({
        label: "Delete", variant: "destructive", fill: true,
        onClick: async () => {
          sheet.close();
          await api.deleteVoice(voice.name).catch(() => {});
          set({ selection: [] });
          await loadVoices();
        },
      }),
    ],
  });
}

const exportModel = (voice) =>
  window.vocalis.exportFiles([{ path: voice.pthPath, name: `${voice.name}.pth` }]);

/**
 * State where a voice sits, so New cover can suggest a pitch shift for it.
 *
 * Vocalis measures this itself for voices trained here, from the training
 * audio. A downloaded model has no audio attached, so there is nothing to
 * measure and nothing to suggest — until someone says. One dropdown, once.
 */
const RANGE_LABELS = {
  bass: "Bass — deep male",
  baritone: "Baritone — male",
  tenor: "Tenor — higher male",
  alto: "Alto — lower female",
  mezzo: "Mezzo — female",
  soprano: "Soprano — higher female",
};

async function setVocalRange(voice) {
  let ranges = [];
  let current = {};
  try {
    [{ ranges }, current] = await Promise.all([
      api.voiceRanges(), api.voiceProfile(voice.name),
    ]);
  } catch (err) {
    return toast({ message: err.message });
  }

  // A measured voice is not offered the dropdown: overriding a measurement off
  // real audio with a category would be a downgrade.
  if (current.source === "training-set") {
    const sheet = Sheet({
      title: `${voice.name} sits around ${current.note}`,
      body: "Measured from the recordings you trained it on, so there's nothing "
            + "to set by hand.",
      actions: [Button({ label: "OK", variant: "primary", onClick: () => sheet.close() })],
    });
    return;
  }

  const select = Select({
    label: "Range",
    options: [
      { value: "", label: "Not set" },
      ...ranges.map((r) => ({ value: r.key,
                              label: `${RANGE_LABELS[r.key] || r.key} (${r.note})` })),
    ],
    value: current.source === "manual"
      ? (ranges.find((r) => Math.abs(r.hz - current.medianF0) < 0.5)?.key || "")
      : "",
    help: current.source === "gender"
      ? `Currently guessed from its catalog listing (around ${current.note}).`
      : "Used to suggest a pitch shift when you pick a song.",
  });

  const sheet = Sheet({
    title: `Vocal range of “${voice.name}”`,
    body: select,
    actions: [
      Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
      Button({
        label: "Save", variant: "primary",
        onClick: async () => {
          const value = select.input.value;
          sheet.close();
          try {
            const saved = await api.setVoiceProfile({
              name: voice.name, range: value, clear: !value });
            toast({ message: saved.medianF0
              ? `${voice.name} sits around ${saved.note}.`
              : `Cleared the range for ${voice.name}.` });
          } catch (err) {
            toast({ message: err.message });
          }
        },
      }),
    ],
  });
}

/**
 * Render a preview clip by running a reference vocal through the RVC step.
 * The user supplies the reference, because nothing in the app ships one and
 * inventing audio would be worse than asking.
 */
async function createPreview(voice, onBusy) {
  const reference = await window.vocalis.pickAudio(
    `Choose a short vocal clip to hear in ${voice.name}'s voice`);
  if (!reference) return;

  onBusy(true);
  try {
    const { job_id } = await api.createPreview(voice.name, reference);
    await runJob(job_id);
    await loadVoices();
  } catch (err) {
    const sheet = Sheet({
      title: "Couldn't make a preview",
      body: err.message,
      actions: [Button({ label: "OK", variant: "primary", onClick: () => sheet.close() })],
    });
  } finally {
    onBusy(false);
  }
}

/* ---- row ---------------------------------------------------------------- */

function menuItems(voice, setBusy) {
  return [
    { label: "Use in a cover", icon: "plus", onSelect: () => useInCover(voice) },
    {
      label: voice.hasPreview ? "Rebuild preview clip" : "Create a preview clip",
      icon: "play",
      onSelect: () => createPreview(voice, setBusy),
    },
    {
      label: voice.has_index ? "Rebuild pitch index" : "Create pitch index",
      // Index building runs through Applio's training pipeline, which arrives
      // with Train a voice. Shown so the capability is discoverable, disabled
      // so it is not a lie.
      disabled: true,
      onSelect: () => {},
    },
    { separator: true },
    { label: "Set vocal range…", icon: "waveform",
      onSelect: () => setVocalRange(voice) },
    { label: "Rename", onSelect: () => promptRename(voice) },
    { label: "Show in Finder", icon: "folder",
      onSelect: () => window.vocalis.revealPath(voice.pthPath) },
    { label: "Export model…", icon: "export", onSelect: () => exportModel(voice) },
    { separator: true },
    { label: "Delete", icon: "trash", destructive: true, onSelect: () => confirmDelete(voice) },
  ];
}

function Row(voice, selected) {
  const previewUrl = api.previewUrl(voice.name);
  let audio = null;
  let wave = null;

  const previewSlot = el("div", { class: "vcard__wave" });
  const elapsed = el("span", { class: "vcard__time t-meter tabular" }, "0:00");

  const stopPreview = () => {
    audio?.pause();
    audio = null;
    wave?.destroy?.();
    wave = null;
    previewSlot.innerHTML = "";
    elapsed.textContent = "0:00";
    delete row.dataset.previewing;
    previewBtn.setAttribute("aria-label", `Preview ${voice.name}`);
    if (activePreview === stopPreview) activePreview = null;
    paintPreviewIcon("play");
  };

  const paintPreviewIcon = (name) => previewBtn.replaceChildren(makeIcon(name, 14));

  const startPreview = () => {
    activePreview?.();          // only one row auditions at a time
    activePreview = stopPreview;

    wave = Waveform({
      peaks: [], progress: 0, height: 20, barWidth: 2, gap: 1,
      ariaLabel: `Scrub ${voice.name} preview`,
      onSeek: (f) => { if (audio?.duration) audio.currentTime = f * audio.duration; },
    });
    previewSlot.appendChild(wave);

    audio = new Audio(previewUrl);
    audio.addEventListener("timeupdate", () => {
      if (audio?.duration) wave?.setProgress(audio.currentTime / audio.duration);
      elapsed.textContent = fmt.duration(audio?.currentTime || 0);
    });
    audio.addEventListener("ended", stopPreview);
    audio.play().catch(stopPreview);
    row.dataset.previewing = "";
    paintPreviewIcon("pause");
    previewBtn.setAttribute("aria-label", `Stop previewing ${voice.name}`);
  };

  const previewBtn = IconButton({
    icon: "play",
    label: voice.hasPreview ? `Preview ${voice.name}` : `Create a preview for ${voice.name}`,
    size: "sm",
    tooltip: voice.hasPreview ? "Preview" : "No preview clip yet — creates one.",
    onClick: (e) => {
      e.stopPropagation();
      if (!voice.hasPreview) return createPreview(voice, setBusy);
      if (audio) stopPreview(); else startPreview();
    },
  });

  const busy = Spinner({ size: 14 });
  busy.style.display = "none";
  const setBusy = (on) => {
    busy.style.display = on ? "" : "none";
    previewBtn.style.display = on ? "none" : "";
  };

  const caption = [
    voice.trainedAt || voice.modified ? `Trained ${fmt.date(voice.modified)}` : null,
    voice.sampleRate ? `${Math.round(voice.sampleRate / 1000)} kHz` : null,
    fmt.bytes(voice.size),
    voice.epochs ? `${voice.epochs} epochs` : null,
  ].filter(Boolean).join(" · ");

  // Status reads as a sentence about the voice, not as a chip: the tone is
  // carried by the check and the colour, so a card with nothing to report is
  // one quiet line rather than a grey pill drawing the eye.
  const status = voice.has_index
    ? el("div", { class: "vcard__status vcard__status--ok t-caption", title: INDEX_TIP },
        makeIcon("check", 12), "Pitch index ready")
    : el("div", { class: "vcard__status t-caption", title: INDEX_TIP }, "No pitch index");

  const row = el("div", {
    class: cls("vcard", selected && "vcard--on"),
    role: "option",
    tabindex: "0",
    "aria-selected": selected ? "true" : "false",
    dataset: { id: voice.name },
  },
    el("div", { class: "vcard__head" },
      Avatar(voice),
      el("span", { class: "vcard__name t-head" }, voice.name),
      IconButton({ icon: "more-horizontal", label: `More actions for ${voice.name}`,
        onClick: (e) => { e.stopPropagation(); Menu(e.currentTarget, menuItems(voice, setBusy)); } }),
    ),
    status,
    // One fixed-height slot, three occupants. What a voice IS at rest; what you
    // can DO with it under the pointer; the transport while it is playing. They
    // swap in place so the card never changes height under the cursor.
    el("div", { class: "vcard__slot" },
      el("div", { class: "vcard__meta t-meter tabular" }, caption),
      el("div", { class: "vcard__live" },
        busy,
        previewBtn,
        Button({ label: "Use in a cover", variant: "tertiary", size: "sm",
          onClick: (e) => { e.stopPropagation(); useInCover(voice); } }),
        previewSlot,
        elapsed,
      ),
    ),
  );

  row.addEventListener("click", () => set({ selection: [voice.name] }));
  row.addEventListener("contextmenu", (e) => {
    set({ selection: [voice.name] });
    ContextMenu(e, menuItems(voice, setBusy));
  });

  row.destroy = stopPreview;
  return row;
}

/* ---- view --------------------------------------------------------------- */

function LocalVoices() {
  const list = el("div", { class: "list", role: "listbox", "aria-label": "Voices" });
  const footer = el("div", { class: "list__lead t-caption" }, "");
  const root = el("div", { class: "column column--cards" }, footer, list);

  let rows = [];
  let sortMode = "recent";

  async function importVoice() {
    const files = await window.vocalis.pickModelFiles();
    if (!files?.length) return;
    await api.importModels(files).catch(() => {});
    await loadVoices();
  }

  /* Voice packs.
   *
   * A pack is several voices, their previews and their terms in one file, so
   * installing one is a decision rather than a file copy: the sheet says what
   * is inside, what it will overwrite and what the licence allows, and only
   * then offers to install.
   */
  async function installPack() {
    const path = await window.vocalis.pickFile({
      title: "Open voice pack",
      name: "Vocalis voice pack",
      extensions: ["vocalispack"],
    });
    if (!path) return;

    let pack;
    try {
      pack = await api.inspectPack(path);
    } catch (err) {
      return toast({ message: err.message });
    }

    const conflicts = pack.conflicts || [];
    const body = el("div", { class: "packsheet" },
      el("div", { class: "t-body" }, pack.description || ""),
      el("div", { class: "t-caption" },
        [pack.author ? `By ${pack.author}` : null,
         `${pack.voices.length} voice${pack.voices.length === 1 ? "" : "s"}`,
         fmt.bytes(pack.sizeBytes),
         pack.licenceLabel].filter(Boolean).join(" · ")),
      el("ul", { class: "packsheet__list" },
        ...pack.voices.map((v) => el("li", { class: "packsheet__row" },
          el("span", { class: "t-body-em" }, v.name),
          el("span", { class: "t-caption" },
            [v.gender, v.hasIndex ? "index" : null, v.hasPreview ? "preview" : null,
             v.conflict ? "already installed" : null].filter(Boolean).join(" · ")),
        ))),
      // Overwriting is never the default: a voice the user trained here and a
      // voice from a pack can share a name, and only one of them can be
      // retrained.
      conflicts.length
        ? el("div", { class: "packsheet__warn t-caption" },
            `Installing replaces ${conflicts.length} voice`
            + `${conflicts.length === 1 ? "" : "s"} you already have `
            + `(${conflicts.join(", ")}).`)
        : null,
    );

    const sheet = Sheet({
      title: pack.name,
      body,
      actions: [
        Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
        Button({
          label: conflicts.length ? "Install and replace" : "Install",
          variant: conflicts.length ? "destructive" : "primary",
          fill: true,
          onClick: async () => {
            sheet.close();
            try {
              await startPackInstall({ path, name: pack.name,
                                       overwrite: conflicts.length > 0 });
            } catch (err) {
              toast({ message: err.message });
            }
          },
        }),
      ],
    });
  }

  const sortSelect = Select({
    options: SORTS, value: sortMode, ariaLabel: "Sort voices",
    onChange: (v) => { sortMode = v; paint(); },
  });
  sortSelect.style.width = "112px";

  function sortVoices(items) {
    const by = {
      recent: (a, b) => b.modified - a.modified,
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => b.size - a.size,
    };
    return [...items].sort(by[sortMode] || by.recent);
  }

  function paint() {
    const { voices, loading, error, query, selection } = getState();
    rows.forEach((r) => r.destroy?.());
    rows = [];
    list.innerHTML = "";

    if (loading.voices) {
      footer.textContent = "";
      list.appendChild(LoadingRows({ rows: 4 }));
      return;
    }
    if (error.voices) {
      footer.textContent = "";
      list.appendChild(ErrorPanel({
        title: "Couldn't read your voices",
        body: error.voices,
        actionLabel: "Try again",
        onAction: loadVoices,
      }));
      return;
    }

    const items = sortVoices(
      voices.filter((v) => !query || v.name.toLowerCase().includes(query.toLowerCase())));

    if (!items.length) {
      footer.textContent = "";
      list.appendChild(voices.length
        ? EmptyState({ icon: "search", title: "No matches", body: `Nothing matches “${query}”.` })
        : el("div", { class: "empty" },
            el("div", { class: "empty__icon" }, makeIcon("voices", 20)),
            el("div", { class: "empty__title t-title-2" }, "No voices yet"),
            el("div", { class: "empty__body t-caption" },
              "Train one from 10–30 minutes of your own clean vocals, or import an RVC .pth file you already have."),
            el("div", { class: "empty__actions" },
              Button({ label: "Import…", variant: "secondary", icon: "import", onClick: importVoice }),
              Button({ label: "Train a voice", variant: "primary", icon: "plus",
                onClick: () => navigate("train") }),
            ),
          ));
      return;
    }

    // Quiet, persistent, above the list — the honest version of the stat cards.
    const total = items.reduce((n, v) => n + (v.size || 0), 0);
    footer.textContent =
      `${fmt.plural(items.length, "voice")} · ${fmt.bytes(total)} · stored on this Mac`;

    items.forEach((v) => {
      const row = Row(v, selection.includes(v.name));
      rows.push(row);
      list.appendChild(row);
    });
  }

  paint();
  const off = subscribe(["voices", "loading", "error", "query", "selection"], paint);

  root.toolbarActions = [
    sortSelect,
    Button({ label: "Install pack…", variant: "tertiary", icon: "import",
      onClick: installPack }),
    Button({ label: "Import…", variant: "secondary", icon: "import", onClick: importVoice }),
    Button({ label: "Train a voice", variant: "primary", icon: "plus",
      onClick: () => navigate("train") }),
  ];
  root.destroy = () => {
    off();
    rows.forEach((r) => r.destroy?.());
    activePreview?.();
  };
  return root;
}

/* ---- tabs --------------------------------------------------------------- */

/**
 * Voices is one place with two shelves: what is on this Mac, and what is a
 * download away. The tab sits in the toolbar rather than the sidebar because
 * both shelves hold the same kind of thing — swapping between them is a filter,
 * not a change of place.
 */
export function VoicesView() {
  const body = el("div", { class: "voices-tabs__body" });
  const root = el("div", { class: "voices-tabs" }, body);

  let active = null;
  let tab = getState().voicesTab === "online" ? "online" : "local";

  const tabs = Segmented({
    options: [
      { value: "local", label: "On this Mac" },
      { value: "online", label: "Online" },
    ],
    value: tab,
    ariaLabel: "Which voices to show",
    onChange: (v) => { tab = v; setVoicesTab(v); mount(); },
  });

  // The shell attaches `setToolbar` only after the view is constructed, so the
  // first tab's actions have to be remembered and handed over via `root.toolbar`.
  let pending = [];
  function setToolbar(actions) {
    pending = actions;
    root.setToolbar?.({ title: "Voices", actions: [tabs, ...actions] });
  }

  function mount() {
    active?.destroy?.();
    body.innerHTML = "";
    // The two shelves do not share a search term: "adele" means one thing in a
    // library of four voices and another in a catalog of thousands.
    set({ query: "", selection: [] });

    active = tab === "online"
      ? OnlineVoices({ onToolbar: setToolbar })
      : LocalVoices();

    body.appendChild(active);
    if (tab !== "online") setToolbar(active.toolbarActions || []);
  }

  mount();

  root.toolbar = { title: "Voices", actions: [tabs, ...pending] };
  root.destroy = () => active?.destroy?.();
  return root;
}
