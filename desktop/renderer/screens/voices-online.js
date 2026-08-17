/**
 * Voices → Online — RVC models published on the Hugging Face Hub.
 *
 * The sibling of the local library, deliberately built from the same card so
 * the two tabs read as one place with two shelves. What differs is what a card
 * can honestly say: an online voice has no preview clip to play (the Hub stores
 * weights, not audio), so the card leads with what it costs to bring home and
 * who published it.
 *
 * Downloading is a job, not a fetch. A voice is 50–500 MB, so the card turns
 * into its own progress bar rather than handing the work to a modal — you can
 * start three downloads and keep browsing.
 */

import { el, cls } from "../lib/dom.js";
import { icon as makeIcon } from "../lib/icons.js";
import {
  Badge, Button, EmptyState, IconButton, Menu, Select, Sheet, Toggle,
  LoadingRows, ErrorPanel,
} from "../components/primitives/index.js";
import { MeterBar } from "../components/meter/index.js";
import { getState, set, subscribe, toggleFavoriteVoice } from "../app/store.js";
import { navigate } from "../app/router.js";
import { api } from "../app/api.js";
import { Avatar } from "../app/avatar.js";
import { cancelJob, downloadFor, runningDownloads, startDownload } from "../app/jobs.js";
import * as fmt from "../app/format.js";

const SORTS = [
  { value: "popular", label: "Popular" },
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
];

const GENDERS = [
  { value: "", label: "Any voice" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
];

const PAGE_SIZE = 30;

/** A pitch index above this is worth mentioning before someone commits to it. */
const BIG_INDEX = 250 * 1024 * 1024;

/**
 * Downloads are not owned by this screen.
 *
 * They live in the job registry with covers and training runs, which is what
 * makes them survive navigating away, keeps them cancellable, and puts them in
 * the sidebar's Activity list. This screen only draws them.
 */

/* ---- helpers ------------------------------------------------------------ */

const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * What this voice costs to bring home, said in the order that matters: the
 * total first, because that is what downloads, then the split when the index
 * is the reason the total is large.
 */
function sizeLine(voice) {
  if (!voice.size) return "Size unknown";
  const total = fmt.bytes(voice.size);
  if (voice.indexSize && voice.indexSize > (voice.pthSize || 0)) {
    return `${total} · ${fmt.bytes(voice.indexSize)} of it pitch index`;
  }
  return total;
}

/* ---- actions ------------------------------------------------------------ */

function useInCover(name) {
  set({ coverDraft: { voiceId: name } });
  navigate("new-cover");
}

function showDetails(voice) {
  const rows = [
    ["Published by", voice.author],
    ["Repository", voice.repoId],
    ["Category", voice.category ? titleCase(voice.category) : "Not stated"],
    ["Voice", voice.gender ? titleCase(voice.gender) : "Not stated"],
    ["Language", voice.language ? titleCase(voice.language) : "Not stated"],
    ["Model", voice.pthSize ? fmt.bytes(voice.pthSize) : "Unknown"],
    ["Pitch index", voice.indexSize ? fmt.bytes(voice.indexSize) : "None"],
    ["Updated", voice.modified ? fmt.date(Date.parse(voice.modified) / 1000) : "Unknown"],
  ];

  const body = el("div", { class: "hf-details" },
    ...rows.map(([label, value]) => el("div", { class: "hf-details__row" },
      el("span", { class: "t-caption" }, label),
      el("span", { class: "t-body" }, String(value || "Unknown")),
    )),
    // The app cannot vouch for a stranger's upload, so it says who to ask.
    el("p", { class: "t-caption hf-details__note" },
      "Uploaded to Hugging Face by ", voice.author,
      ". Vocalis does not host or verify it — open the page to read the "
      + "licence and check what the voice was trained on."),
  );

  // Commons images are freely licensed but not unattributed. The credit is
  // looked up from cache after the sheet is already on screen, so a portrait
  // that has not been fetched yet simply adds no line rather than delaying one.
  if (voice.hasPortrait) {
    api.hfPortraitCredit(voice.portraitName || voice.name).then(({ page, title }) => {
      if (!page) return;
      const credit = el("p", { class: "t-caption hf-details__note" },
        `Portrait of ${title} from Wikimedia Commons, via `);
      const link = el("a", { href: "#" }, "Wikipedia");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        window.vocalis.openExternal(page);
      });
      credit.append(link, ".");
      body.appendChild(credit);
    }).catch(() => {});
  }

  const sheet = Sheet({
    title: voice.name,
    body,
    actions: [
      Button({ label: "Close", variant: "secondary", onClick: () => sheet.close() }),
      Button({ label: "Open on Hugging Face", variant: "primary",
        onClick: () => { sheet.close(); window.vocalis.openExternal(voice.pageUrl); } }),
    ],
  });
}

/* ---- card --------------------------------------------------------------- */

function Card(voice, favorite, onChanged) {
  const job = downloadFor(voice.id);

  const star = IconButton({
    icon: favorite ? "star-on" : "star",
    label: favorite ? `Remove ${voice.name} from favourites` : `Add ${voice.name} to favourites`,
    size: "sm",
    tooltip: favorite ? "In favourites" : "Add to favourites",
    onClick: (e) => {
      e.stopPropagation();
      toggleFavoriteVoice(voice.id);
    },
  });
  if (favorite) star.dataset.on = "";

  // Progress is read from the job, not tracked here, so a card redrawn after
  // navigating away resumes mid-transfer instead of restarting at zero.
  const meter = MeterBar({ value: job?.progress || 0,
                           ariaLabel: `Downloading ${voice.name}` });
  const pct = (f) => `${Math.round((f || 0) * 100)}%`;
  const stage = el("span", { class: "hf-card__stage t-caption" },
    !job ? "" : job.note ? `${pct(job.progress)} · ${job.note}` : "Starting…");

  const cancel = Button({
    label: "Cancel", variant: "tertiary", size: "sm",
    onClick: (e) => { e.stopPropagation(); cancelJob(job.id); },
  });

  const progress = el("div", { class: "hf-card__progress" },
    meter,
    el("div", { class: "hf-card__progressrow" }, stage, cancel));
  progress.hidden = !job;

  const actions = el("div", { class: "hf-card__actions" });
  actions.hidden = !!job;

  async function download() {
    if (downloadFor(voice.id)) return;
    try {
      await startDownload(voice);
      onChanged();          // repaint so this card pins to the top
    } catch (err) {
      const sheet = Sheet({
        title: `Couldn't download ${voice.name}`,
        body: err.message,
        actions: [Button({ label: "OK", variant: "primary", onClick: () => sheet.close() })],
      });
    }
  }

  if (voice.installed) {
    actions.append(
      el("span", { class: "vcard__status vcard__status--ok t-caption" },
        makeIcon("check", 12), "On this Mac"),
      Button({ label: "Use in a cover", variant: "tertiary", size: "sm",
        onClick: (e) => { e.stopPropagation(); useInCover(voice.installName); } }),
    );
  } else {
    actions.append(
      Button({
        label: "Download", variant: "secondary", size: "sm", icon: "download",
        onClick: (e) => {
          e.stopPropagation();
          // A pitch index can be several times the size of the voice itself.
          // Saying so before the download starts is cheaper than saying so
          // after half a gigabyte has arrived.
          if (voice.indexSize > BIG_INDEX) {
            const sheet = Sheet({
              title: `Download ${voice.name}?`,
              body: `This voice is ${fmt.bytes(voice.size)}, mostly its pitch `
                  + `index (${fmt.bytes(voice.indexSize)}). The index improves `
                  + "accuracy on fast phrases, but it is a big file.",
              actions: [
                Button({ label: "Cancel", variant: "secondary",
                  onClick: () => sheet.close() }),
                Button({ label: "Download", variant: "primary",
                  onClick: () => { sheet.close(); download(); } }),
              ],
            });
            return;
          }
          download();
        },
      }),
    );
  }

  const badges = el("div", { class: "hf-card__badges" });
  if (voice.category) badges.appendChild(Badge({ label: titleCase(voice.category) }));
  if (voice.gender) badges.appendChild(Badge({ label: titleCase(voice.gender) }));
  if (!voice.hasIndex) {
    badges.appendChild(Badge({
      label: "No pitch index",
      title: "Converts fine; slurred or very fast phrases may drift.",
    }));
  }

  const menu = [
    job
      ? { label: "Cancel download", icon: "close", onSelect: () => cancelJob(job.id) }
      : { label: "Download", icon: "download", disabled: voice.installed,
          onSelect: download },
    { label: favorite ? "Remove from favourites" : "Add to favourites",
      icon: "star", onSelect: () => toggleFavoriteVoice(voice.id) },
    { separator: true },
    { label: "Details…", icon: "info", onSelect: () => showDetails(voice) },
    { label: "Open on Hugging Face", icon: "export",
      onSelect: () => window.vocalis.openExternal(voice.pageUrl) },
  ];

  const card = el("div", {
    class: cls("vcard", "hf-card", voice.installed && "hf-card--have",
               job && "hf-card--downloading"),
    dataset: { id: voice.id },
  },
    el("div", { class: "vcard__head" },
      Avatar(voice),
      el("span", { class: "vcard__name t-head", title: voice.name }, voice.name),
      star,
      IconButton({ icon: "more-horizontal", label: `More actions for ${voice.name}`,
        onClick: (e) => { e.stopPropagation(); Menu(e.currentTarget, menu); } }),
    ),
    badges,
    el("div", { class: "hf-card__slot" },
      el("div", { class: "hf-card__meta t-meter tabular" },
        `${sizeLine(voice)} · ${voice.author}`),
      actions,
      progress,
    ),
  );

  card.addEventListener("dblclick", () => showDetails(voice));
  return card;
}

/* ---- view --------------------------------------------------------------- */

export function OnlineVoices({ onToolbar } = {}) {
  const list = el("div", { class: "list", role: "list", "aria-label": "Online voices" });
  const lead = el("div", { class: "list__lead t-caption" }, "");
  const more = el("div", { class: "hf-more" });
  // Four filters plus a tab plus a search field will not fit a 52px toolbar —
  // the search box was the first casualty. Filters that belong to this shelf
  // live above the shelf, where there is room to label them.
  const filters = el("div", { class: "hf-filters" });
  const root = el("div", { class: "column column--cards" }, filters, lead, list, more);

  let state = {
    voices: [], total: 0, page: 1, hasMore: false,
    categories: [], loading: true, error: null, building: false,
  };
  let category = "";
  let gender = "";
  let sort = "popular";
  let favoritesOnly = false;
  let query = getState().query;
  let token = 0;              // guards against a slow page landing after a fast one
  let warmTimer = null;

  /* -- data -- */

  async function load({ append = false } = {}) {
    const mine = ++token;
    state.loading = !append;
    state.error = null;
    paint();

    try {
      const page = append ? state.page + 1 : 1;
      const res = await api.hfVoices({ query, category, gender, sort, page,
                                       pageSize: PAGE_SIZE });
      if (mine !== token) return;
      state = {
        ...state,
        voices: append ? [...state.voices, ...res.voices] : res.voices,
        total: res.total,
        page: res.page,
        hasMore: res.hasMore,
        categories: res.categories || [],
        building: res.building,
        error: res.error || null,
        loading: false,
      };
      // While the catalog is still being read, check back rather than leaving
      // the user on a half-built list with no sign it is still filling in.
      scheduleWarmCheck(res.building);
    } catch (err) {
      if (mine !== token) return;
      state = { ...state, loading: false, error: err.message };
    }
    paint();
  }

  function scheduleWarmCheck(building) {
    clearTimeout(warmTimer);
    if (building) warmTimer = setTimeout(() => load(), 4000);
  }

  const reload = () => load();

  /* -- controls -- */

  const sortSelect = Select({
    options: SORTS, value: sort, ariaLabel: "Sort online voices",
    onChange: (v) => { sort = v; reload(); },
  });
  sortSelect.style.width = "112px";

  const categorySelect = Select({
    options: [{ value: "", label: "All voices" }],
    value: "", ariaLabel: "Filter by category",
    onChange: (v) => { category = v; reload(); },
  });
  categorySelect.style.width = "132px";

  const genderSelect = Select({
    options: GENDERS, value: "", ariaLabel: "Filter by voice type",
    onChange: (v) => { gender = v; reload(); },
  });
  genderSelect.style.width = "116px";

  const favoritesToggle = Toggle({
    label: "Favourites",
    checked: false,
    onChange: (on) => { favoritesOnly = on; paint(); },
  });

  /**
   * Keep the category list in step with what the catalog actually contains.
   * Rewrites the inner <select> rather than the wrapper, which also owns the
   * chevron and the label.
   */
  function syncCategories() {
    const sel = categorySelect.input;
    const wanted = ["", ...state.categories];
    const current = [...sel.options].map((o) => o.value);
    if (String(current) === String(wanted)) return;
    sel.innerHTML = "";
    wanted.forEach((value) => {
      sel.appendChild(el("option", { value }, value ? titleCase(value) : "All voices"));
    });
    sel.value = category;
  }

  /* -- paint -- */

  function paint() {
    const { favoriteVoices } = getState();
    const favorites = new Set(favoriteVoices || []);
    list.innerHTML = "";
    more.innerHTML = "";
    syncCategories();

    // Anything downloading is drawn first, above everything, and outranks every
    // filter, sort and search term — including the loading and error states. A
    // transfer you started is the most important thing on this screen, and it
    // must not vanish because you changed the category or the catalog happened
    // to be refreshing. The records come off the job itself, so these render
    // even when the voice is nowhere in the current page of results.
    const active = runningDownloads();
    const pinnedIds = new Set(active.map((j) => j.voiceId));
    active.forEach((j) => list.appendChild(
      Card(j.voice, favorites.has(j.voiceId), reload)));

    if (state.loading) {
      lead.textContent = state.building
        ? "Reading the Hugging Face catalog for the first time…"
        : "";
      list.appendChild(LoadingRows({ rows: 4 }));
      return;
    }

    if (state.error && !state.voices.length) {
      lead.textContent = "";
      list.appendChild(ErrorPanel({
        title: "Couldn't reach Hugging Face",
        body: state.error,
        actionLabel: "Try again",
        onAction: reload,
      }));
      return;
    }

    const items = (favoritesOnly
      ? state.voices.filter((v) => favorites.has(v.id))
      : state.voices).filter((v) => !pinnedIds.has(v.id));

    if (!active.length && !items.length) {
      lead.textContent = "";
      if (favoritesOnly) {
        list.appendChild(EmptyState({
          icon: "star",
          title: "No favourites yet",
          body: "Star a voice and it will be waiting here next time.",
        }));
      } else if (state.building) {
        list.appendChild(EmptyState({
          icon: "cloud",
          title: "Reading the catalog",
          body: "This takes a minute the first time. It is cached afterwards, "
              + "so every visit after this one is instant.",
        }));
      } else {
        list.appendChild(EmptyState({
          icon: "search",
          title: "No matches",
          body: query
            ? `Nothing on Hugging Face matches “${query}”.`
            : "No voices match these filters.",
        }));
      }
      return;
    }

    const shown = favoritesOnly
      ? `${fmt.plural(items.length, "favourite")}`
      : `${fmt.plural(state.total, "voice")} on Hugging Face`;
    lead.textContent = state.building
      ? `${shown} · still reading the catalog…`
      : `${shown} · free to download`;

    items.forEach((v) => list.appendChild(Card(v, favorites.has(v.id), reload)));

    if (state.hasMore && !favoritesOnly) {
      more.appendChild(Button({
        label: "Show more", variant: "secondary",
        onClick: () => load({ append: true }),
      }));
    }
  }

  /* -- wiring -- */

  // Searching the Hub is a network call, so it waits for a pause in typing.
  let debounce = null;
  const off = subscribe(["query", "favoriteVoices", "voices", "jobs"], (s, changed) => {
    if (changed.includes("query")) {
      query = s.query;
      clearTimeout(debounce);
      debounce = setTimeout(reload, 350);
      return;
    }
    paint();
  });

  filters.append(categorySelect, genderSelect, sortSelect,
                 el("div", { class: "hf-filters__spacer" }), favoritesToggle);

  // Every control this shelf needs lives in its own filter row, so the toolbar
  // is handed nothing. It still has to be called: the shell keeps whatever the
  // last shelf put there until someone replaces it.
  onToolbar?.([]);

  load();

  root.destroy = () => {
    off();
    token++;
    clearTimeout(debounce);
    clearTimeout(warmTimer);
  };
  return root;
}
