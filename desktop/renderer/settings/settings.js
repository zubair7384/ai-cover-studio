/**
 * Settings — its own window, macOS-style (§8, Prompt 6).
 *
 * Four tabs in a segmented toolbar. The window is non-resizable at 620 wide and
 * resizes its height to the active tab, with the title bar showing that tab's
 * name — the behaviour a Mac preferences window has.
 *
 * Everything saves as you change it. There is no "Save profile" button; a brief
 * "Saved" caption confirms instead.
 */

import { el } from "../lib/dom.js";
import {
  Button, Checkbox, Segmented, Select, Sheet, TextField,
} from "../components/primitives/index.js";
import { MeterBar } from "../components/meter/index.js";
import { getState, readPersisted, persist } from "../app/store.js";
import { api } from "../app/api.js";
import { preference as themePreference, setTheme, accent as currentAccent, setAccent } from "../app/theme.js";
import { ACCENTS } from "../app/accent.js";
import { initials } from "../app/profile.js";
import * as fmt from "../app/format.js";

export const TABS = [
  { id: "general", label: "General" },
  { id: "audio", label: "Audio" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "About" },
];

/** Settings the main window also reads; every write is broadcast to it. */
function saveSetting(key, value) {
  persist(key, value);
  window.vocalis.broadcastSettings({ key, value });
}

/** Brief confirmation in place of a Save button. */
function flashSaved(node) {
  node.textContent = "Saved";
  node.classList.add("saved--on");
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.classList.remove("saved--on");
    node.textContent = "";
  }, 1600);
}

const group = (title, ...children) =>
  el("section", { class: "sgroup" },
    el("h2", { class: "sgroup__title t-label" }, title),
    el("div", { class: "sgroup__body" }, ...children.filter(Boolean)),
  );

const rowField = (label, control, help) =>
  el("div", { class: "srow" },
    el("div", { class: "srow__label t-body" }, label),
    el("div", { class: "srow__control" }, control,
      help ? el("div", { class: "field__help" }, help) : null),
  );

/* ---- General ------------------------------------------------------------ */

export function GeneralTab() {
  const profile = readPersisted("profile", { name: "You", avatar: null }) || {};
  const saved = el("span", { class: "saved t-caption" }, "");

  const avatar = el("span", { class: "avatar avatar--lg" });
  const paintAvatar = () => {
    avatar.innerHTML = "";
    if (profile.avatar) avatar.appendChild(el("img", { src: profile.avatar, alt: "" }));
    else avatar.textContent = initials(profile.name);
  };
  paintAvatar();

  const nameField = TextField({
    label: "Name",
    value: profile.name || "",
    // Saved on blur, not on every keystroke — otherwise "Saved" flickers.
    onChange: (value) => {
      profile.name = value.trim() || "You";
      saveSetting("profile", profile);
      paintAvatar();
      flashSaved(saved);
    },
  });

  const filePicker = el("input", { type: "file", accept: "image/*", hidden: true });
  filePicker.addEventListener("change", () => {
    const file = filePicker.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      profile.avatar = reader.result;
      saveSetting("profile", profile);
      paintAvatar();
      flashSaved(saved);
    };
    reader.readAsDataURL(file);
  });

  const theme = Segmented({
    ariaLabel: "Theme",
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    value: themePreference(),
    onChange: (v) => {
      setTheme(v);
      window.vocalis.broadcastSettings({ key: "theme", value: v });
    },
  });

  return el("div", { class: "stab" },
    group("Profile",
      el("div", { class: "profile" },
        avatar,
        el("div", { class: "profile__fields" },
          nameField,
          el("div", { class: "profile__actions" },
            Button({ label: "Choose photo…", variant: "secondary", size: "sm",
              onClick: () => filePicker.click() }),
            Button({ label: "Remove photo", variant: "tertiary", size: "sm",
              disabled: !profile.avatar,
              onClick: () => {
                profile.avatar = null;
                saveSetting("profile", profile);
                paintAvatar();
                flashSaved(saved);
              } }),
            saved,
          ),
        ),
      ),
      filePicker,
    ),
    group("Appearance",
      rowField("Theme", theme),
      el("div", { class: "accentrow" },
        el("div", { class: "srow__label t-body" }, "Accent colour"),
        AccentPicker(),
      ),
      el("div", { class: "field__help" },
        "Every accent is checked for contrast in both light and dark."),
    ),
    group("Notifications",
      Checkbox({
        label: "Notify me when a cover or training finishes",
        checked: readPersisted("notify", true),
        onChange: (on) => saveSetting("notify", on),
      }),
    ),
  );
}

/**
 * Accent swatches. Amber is the default and the brand; the rest are alternate
 * hues of the same signal, each verified against the §11 floor in both themes
 * by scripts/check-contrast.mjs.
 */
function AccentPicker() {
  const row = el("div", { class: "swatches", role: "radiogroup", "aria-label": "Accent colour" });

  const paint = () => {
    const active = currentAccent();
    [...row.children].forEach((btn) => {
      const on = btn.dataset.accent === active;
      btn.classList.toggle("swatch--on", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
  };

  ACCENTS.forEach((a) => {
    const btn = el("button", {
      type: "button",
      role: "radio",
      class: "swatch",
      title: a.label,
      "aria-label": a.label,
      dataset: { accent: a.id },
      style: { "--swatch": a.s500 },
      onclick: () => {
        setAccent(a.id);
        saveSetting("accent", a.id);
        paint();
      },
    }, el("span", { class: "swatch__dot" }));
    row.appendChild(btn);
  });

  paint();
  return row;
}

/* ---- Audio -------------------------------------------------------------- */

export function AudioTab() {
  const exportDir = readPersisted("exportDir", "");
  const askEveryTime = readPersisted("askExportLocation", true);

  const pathField = TextField({
    value: exportDir,
    placeholder: "Ask every time",
    ariaLabel: "Default export folder",
    disabled: askEveryTime,
  });

  const chooseBtn = Button({
    label: "Choose…", variant: "secondary", size: "sm",
    disabled: askEveryTime,
    onClick: async () => {
      const dir = await window.vocalis.pickFolder();
      if (!dir) return;
      pathField.input.value = dir;
      saveSetting("exportDir", dir);
    },
  });

  return el("div", { class: "stab" },
    group("Defaults",
      rowField("Sample rate", Select({
        options: [
          { value: "32000", label: "32 kHz" },
          { value: "40000", label: "40 kHz" },
          { value: "48000", label: "48 kHz" },
        ],
        value: readPersisted("defaultSampleRate", "40000"),
        ariaLabel: "Default sample rate",
        onChange: (v) => saveSetting("defaultSampleRate", v),
      }), "40 kHz suits singing."),

      rowField("Output format", Select({
        options: [
          { value: "mp3", label: "MP3 320" },
          { value: "wav", label: "WAV 24-bit" },
          { value: "flac", label: "FLAC" },
        ],
        value: readPersisted("defaultOutputFormat", "mp3"),
        ariaLabel: "Default output format",
        onChange: (v) => saveSetting("defaultOutputFormat", v),
      })),

      rowField("Quality preset", Select({
        options: [
          { value: "quick", label: "Quick" },
          { value: "balanced", label: "Balanced" },
          { value: "high", label: "High" },
        ],
        value: readPersisted("defaultQuality", "balanced"),
        ariaLabel: "Default quality preset",
        onChange: (v) => saveSetting("defaultQuality", v),
      })),
    ),

    group("Exporting",
      el("div", { class: "exportrow" }, pathField, chooseBtn),
      Checkbox({
        label: "Ask every time",
        checked: askEveryTime,
        onChange: (on) => {
          saveSetting("askExportLocation", on);
          pathField.input.disabled = on;
          chooseBtn.disabled = on;
        },
      }),
    ),
  );
}

/* ---- Storage ------------------------------------------------------------ */

export function StorageTab(api) {
  const root = el("div", { class: "stab" });

  const shareRow = (label, bytes, total, extra) => {
    const bar = MeterBar({
      value: total ? bytes / total : 0,
      ariaLabel: `${label} share of total storage`,
    });
    return el("div", { class: "storagerow" },
      el("div", { class: "storagerow__head" },
        el("span", { class: "t-body" }, label + (extra ? ` (${extra})` : "")),
        el("span", { class: "t-meter tabular" }, fmt.bytes(bytes)),
      ),
      bar,
    );
  };

  function paint(data) {
    root.innerHTML = "";
    const { models, covers, datasets, total, dataDir, hardware } = data;
    // Older engines predate the fetch cache and omit the key entirely.
    const downloads = data.downloads || { bytes: 0, count: 0 };

    root.appendChild(group("On this Mac",
      shareRow("Voice models", models.bytes, total, `${models.count} files`),
      shareRow("Generated covers", covers.bytes, total, `${covers.count}`),
      shareRow("Training data", datasets.bytes, total),
      shareRow("Songs fetched from links", downloads.bytes, total, `${downloads.count}`),
      el("div", { class: "storagerow__total" },
        el("span", { class: "t-body-em" }, "Total"),
        el("span", { class: "t-meter tabular" }, fmt.bytes(total)),
      ),
    ));

    root.appendChild(group("Location",
      el("div", { class: "pathrow" },
        el("code", { class: "pathrow__value t-caption" }, dataDir),
      ),
      el("div", { class: "pathrow__actions" },
        Button({ label: "Show in Finder", variant: "tertiary", size: "sm",
          onClick: () => window.vocalis.revealPath(dataDir) }),
        Button({ label: "Change…", variant: "secondary", size: "sm",
          onClick: () => changeLocation(dataDir) }),
      ),
    ));

    root.appendChild(group("Compute device",
      el("div", { class: "srow" },
        el("div", { class: "srow__label t-body" }, hardware.label),
        el("div", { class: "t-caption srow__note" }, hardware.training_warning || ""),
      ),
    ));

    root.appendChild(group("Danger zone",
      // A re-fetchable cache is not dangerous to lose, so this one clears on a
      // single click while the covers below still need a confirm.
      Button({
        label: "Clear fetched songs",
        variant: "secondary",
        disabled: !downloads.count,
        tooltip: downloads.count
          ? "Songs downloaded from links. They are fetched again if you need them."
          : "Nothing has been fetched from a link yet.",
        onClick: async () => {
          await api.clearDownloads().catch(() => {});
          load();
        },
      }),
      // Tertiary, not a bare red button sitting in the panel.
      Button({
        label: "Delete all generated covers",
        variant: "destructive",
        disabled: !covers.count,
        onClick: () => confirmDeleteAll(covers),
      }),
    ));

    window.vocalis.settingsChrome?.({ title: "Storage", height: root.scrollHeight + 120 });
  }

  async function changeLocation(current) {
    const sheet = Sheet({
      title: "Move your Vocalis data?",
      body: el("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        el("div", {}, "Your voice models, covers and training data are copied to the new folder, and Vocalis restarts."),
        el("div", { class: "t-caption" },
          "The old folder is left exactly as it is — nothing is deleted, so you can "
          + "remove it yourself once you have checked everything arrived."),
      ),
      actions: [
        Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
        Button({ label: "Choose folder…", variant: "primary", onClick: async () => {
          sheet.close();
          const res = await window.vocalis.chooseDataDir();
          if (res?.canceled) return;
          if (res?.error || res?.reason) {
            const err = Sheet({
              title: "Couldn't move your data",
              body: res.error || res.reason,
              actions: [Button({ label: "OK", variant: "primary", onClick: () => err.close() })],
            });
            return;
          }
          if (res?.moved) window.vocalis.relaunch();
        } }),
      ],
    });
  }

  function confirmDeleteAll(covers) {
    const sheet = Sheet({
      title: `Delete all ${covers.count} covers?`,
      // The exact count and size freed, stated before the second click.
      body: `This removes ${fmt.plural(covers.count, "cover")} and frees `
        + `${fmt.bytes(covers.bytes)}. Your voice models are not touched.`,
      actions: [
        Button({ label: "Cancel", variant: "secondary", onClick: () => sheet.close() }),
        Button({ label: `Delete ${covers.count}`, variant: "destructive", fill: true,
          onClick: async () => {
            sheet.close();
            await api.deleteAllCovers().catch(() => {});
            load();
          } }),
      ],
    });
  }

  async function load() {
    try {
      paint(await api.storage());
    } catch {
      root.innerHTML = "";
      root.appendChild(el("div", { class: "t-body" },
        "Couldn't read your storage usage. The local engine may still be starting."));
    }
  }

  load();
  return root;
}

/* ---- About -------------------------------------------------------------- */

export function AboutTab(version) {
  const glyph = el("div", { class: "aboutmark" });
  [40, 75, 100, 60, 85].forEach((h) =>
    glyph.appendChild(el("i", { style: { height: `${h}%` } })));

  const link = (label, url) =>
    Button({ label, variant: "tertiary", size: "sm",
      onClick: () => window.vocalis.openExternal(url) });

  return el("div", { class: "stab stab--about" },
    glyph,
    el("div", { class: "t-title-2" }, `Vocalis ${version}`),
    el("p", { class: "t-body measure about__line" },
      "Everything runs on this Mac. Your audio and voice models never leave it."),
    el("div", { class: "about__links" },
      link("Release notes", "https://github.com/"),
      link("Report an issue", "https://github.com/"),
      link("Acknowledgements", "https://github.com/IAHispano/Applio"),
      Button({ label: "Copy diagnostics", variant: "secondary", size: "sm",
        onClick: async () => {
          const text = await window.vocalis.diagnostics();
          navigator.clipboard.writeText(text);
        } }),
    ),
    el("p", { class: "t-caption about__credit measure" },
      "Voice conversion by RVC and Applio. Source separation by HTDemucs."),
  );
}

/* ---- Shell -------------------------------------------------------------- */

export function renderSettings({ api, version }) {
  let active = "general";

  const body = el("div", { class: "settings__body" });
  const tabs = Segmented({
    ariaLabel: "Settings sections",
    options: TABS.map((t) => ({ value: t.id, label: t.label })),
    value: active,
    onChange: (id) => { active = id; paint(); },
  });

  function paint() {
    body.innerHTML = "";
    const view =
      active === "general" ? GeneralTab()
      : active === "audio" ? AudioTab()
      : active === "storage" ? StorageTab(api)
      : AboutTab(version);
    body.appendChild(view);

    const label = TABS.find((t) => t.id === active)?.label || "Settings";
    // Let layout settle before measuring, or the height is a frame stale.
    requestAnimationFrame(() => {
      window.vocalis.settingsChrome?.({
        title: label,
        height: body.scrollHeight + 120,
      });
    });
  }

  paint();

  return el("div", { class: "settings" },
    el("header", { class: "settings__toolbar drag-region" }, tabs),
    body,
  );
}


/* ---- In-app page -------------------------------------------------------- */

/**
 * Settings as a full-view push over the library, rather than a separate window.
 *
 * The design system (§8, U12) puts settings in their own ⌘, window, on the
 * grounds that Mac apps do. This is a deliberate departure at the product
 * owner's request: it keeps one window, and Settings reads as part of the app
 * rather than a detached panel.
 */
export function SettingsView() {
  let active = "general";

  const body = el("div", { class: "settings__body settings__body--page" });
  const tabs = Segmented({
    ariaLabel: "Settings sections",
    options: TABS.map((t) => ({ value: t.id, label: t.label })),
    value: active,
    onChange: (id) => { active = id; paint(); },
  });

  function paint() {
    body.innerHTML = "";
    body.appendChild(
      active === "general" ? GeneralTab()
      : active === "audio" ? AudioTab()
      : active === "storage" ? StorageTab(api)
      : AboutTab(getState().appVersion || "")
    );
  }

  paint();

  const root = el("div", { class: "column settings--page" }, body);
  root.toolbar = {
    title: "Settings",
    search: false,
    actions: [tabs],
    // No Done in the header — every setting applies as it is changed, so there
    // was nothing to confirm. Esc leaves, as it does from any flow.
  };
  return root;
}
