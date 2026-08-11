/**
 * AI Cover Studio — Electron main process.
 *
 * Responsibilities:
 *   1. Locate a Python interpreter (bundled runtime when packaged, the repo
 *      .venv during development) and spawn server.py as a local sidecar.
 *   2. Wait until the sidecar prints "ACS_SERVER_READY port=NNNN", then load
 *      the renderer and hand it the port.
 *   3. Bridge a few native-only capabilities over IPC (file pickers, reveal in
 *      folder, save-as) — everything else the renderer does via HTTP.
 *   4. Cleanly stop the sidecar on quit.
 */

const {
  app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net: enet, Menu,
  nativeImage, Notification, powerSaveBlocker,
} = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

const IS_DEV = !app.isPackaged || process.env.ACS_DEV === "1";

// ---------------------------------------------------------------------------
// app:// scheme
// ---------------------------------------------------------------------------
// The renderer is served from a custom scheme rather than file://, because
// file:// has an opaque origin and blocks ES modules — and the renderer is
// built as ES modules (one file per screen plus a shared store). This must run
// before `app.whenReady()`.
const RENDERER_ROOT = path.join(__dirname, "renderer");

// User-chosen data directory, persisted outside DATA_DIR itself (or moving it
// would orphan the pointer).
function prefsFile() { return path.join(app.getPath("userData"), "prefs.json"); }

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch { return {}; }
}

function writePrefs(next) {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...next }, null, 2));
  } catch (err) {
    console.error("[prefs] write failed:", err);
  }
}
const APP_ORIGIN = "app://vocalis";

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);

    // Resolve inside the renderer directory and refuse anything that escapes
    // it — a custom scheme is still a file server.
    const full = path.normalize(path.join(RENDERER_ROOT, rel));
    if (full !== RENDERER_ROOT && !full.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fs.existsSync(full)) {
      return new Response("Not found", { status: 404 });
    }
    // net.fetch handles MIME types and streaming for us.
    return enet.fetch(pathToFileURL(full).toString());
  });
}

let pyProc = null;
let serverPort = 0;
let mainWindow = null;
let splash = null;

// ---------------------------------------------------------------------------
// Path resolution — dev tree vs packaged bundle
// ---------------------------------------------------------------------------
function resolvePaths() {
  if (IS_DEV) {
    const repo = path.resolve(__dirname, "..");
    const venvPy = process.platform === "win32"
      ? path.join(repo, ".venv", "Scripts", "python.exe")
      : path.join(repo, ".venv", "bin", "python");
    return {
      python: fs.existsSync(venvPy) ? venvPy : "python3",
      serverScript: path.join(repo, "server.py"),
      resourceDir: repo,
      // dev writes back into the repo tree (git-ignored) unless moved
      dataDir: readPrefs().dataDir || repo,
    };
  }
  // Packaged: assets live under <resources>/backend, user data in userData.
  const backend = path.join(process.resourcesPath, "backend");
  const runtimePy = process.platform === "win32"
    ? path.join(backend, "runtime", "python.exe")
    : path.join(backend, "runtime", "bin", "python3");
  const dataDir = readPrefs().dataDir || app.getPath("userData");
  seedDataDir(dataDir);
  return {
    python: runtimePy,
    serverScript: path.join(backend, "server.py"),
    resourceDir: backend,
    dataDir,
  };
}

// On first launch, copy bundled read-only assets into the writable data dir so
// the engine (which reads *and writes* there) finds them without re-downloading.
// Applio must be writable because training builds a venv and writes logs inside
// it — it cannot live in the read-only app bundle.
function seedDataDir(dataDir) {
  const seeds = [
    [".separator_models", "data_seed/.separator_models"],
    ["Applio", "backend/Applio"],
  ];
  for (const [name, rel] of seeds) {
    try {
      const seed = path.join(process.resourcesPath, rel);
      const dest = path.join(dataDir, name);
      if (fs.existsSync(seed) && !fs.existsSync(dest)) {
        fs.cpSync(seed, dest, { recursive: true });
      }
    } catch (err) {
      console.error(`Failed to seed ${name}:`, err);
    }
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle
// ---------------------------------------------------------------------------
async function startSidecar() {
  const paths = resolvePaths();
  serverPort = await findFreePort();

  if (!fs.existsSync(paths.python)) {
    throw new Error(
      `Python runtime not found at:\n${paths.python}\n\n` +
      (IS_DEV ? "Create the venv and install requirements first." : "The bundled runtime is missing from this install.")
    );
  }

  const env = {
    ...process.env,
    ACS_RESOURCE_DIR: paths.resourceDir,
    ACS_DATA_DIR: paths.dataDir,
    PYTHONUNBUFFERED: "1",
  };

  console.log(`[sidecar] ${paths.python} ${paths.serverScript} --port ${serverPort}`);
  pyProc = spawn(paths.python, [paths.serverScript, "--port", String(serverPort)], {
    cwd: paths.resourceDir,
    env,
  });

  return new Promise((resolve, reject) => {
    let ready = false;
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(`[py] ${text}`);
      if (!ready && text.includes("ACS_SERVER_READY")) {
        ready = true;
        // Give uvicorn a beat to bind before the first request.
        waitForHealth(serverPort).then(resolve).catch(reject);
      }
    };
    pyProc.stdout.on("data", onData);
    pyProc.stderr.on("data", (buf) => process.stderr.write(`[py] ${buf}`));
    pyProc.on("error", reject);
    pyProc.on("exit", (code) => {
      if (!ready) reject(new Error(`Python sidecar exited early (code ${code}).`));
    });
  });
}

function waitForHealth(port, attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry(n);
        }
      );
      req.on("error", () => retry(n));
      req.on("timeout", () => { req.destroy(); retry(n); });
    };
    const retry = (n) => {
      if (n <= 0) return reject(new Error("Sidecar health check timed out."));
      setTimeout(() => tryOnce(n - 1), 400);
    };
    tryOnce(attempts);
  });
}

function stopSidecar() {
  if (!pyProc) return;
  // Ask the server to exit cleanly; fall back to SIGKILL.
  try {
    const req = http.request(
      { host: "127.0.0.1", port: serverPort, path: "/api/shutdown", method: "POST", timeout: 1000 },
      () => {}
    );
    req.on("error", () => {});
    req.end();
  } catch (_) { /* ignore */ }
  const proc = pyProc;
  pyProc = null;
  setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, 1500);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplash() {
  const isMac = process.platform === "darwin";
  splash = new BrowserWindow({
    width: 420, height: 260, frame: false, resizable: false,
    center: true, show: true,
    // Opaque graphite, matching the main window. The old build blurred the
    // splash over the desktop; §5 keeps translucency to the sidebar alone.
    transparent: false,
    backgroundColor: "#181A1C",
    ...(isMac ? { roundedCorners: true } : {}),
  });
  splash.loadFile(path.join(__dirname, "renderer", "splash.html"));
}

function createMainWindow() {
  const isMac = process.platform === "darwin";

  // Design system §5, verbatim. The window is OPAQUE (#181A1C) — translucency
  // is used in exactly one place, the sidebar, which gets the 'sidebar'
  // material behind it while the content area paints solid --gr-900 in CSS.
  // Electron has no per-region vibrancy, so this is how that split is achieved.
  mainWindow = new BrowserWindow({
    width: 1180, height: 760,
    minWidth: 900, minHeight: 620,
    show: false, title: "Vocalis",
    backgroundColor: "#181A1C",
    ...(isMac ? {
      titleBarStyle: "hiddenInset",
      // y:18, not 20. The coordinate is the button FRAME, which carries about
      // 2px of inset above the ink — measured off a rendered frame, the buttons
      // landed at y:22..33.5 while the 52px title band centres on y:26, so they
      // sat ~2px below the wordmark beside them. 18 puts the ink on 20..31.5.
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
    } : {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#181A1C", symbolColor: "#B3B9C0", height: 52 },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Surface renderer failures in the terminal — an ES module that throws
  // otherwise leaves a silent blank window.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["log", "warn", "error"][level] || "log";
    console.log(`[renderer:${tag}] ${message}  (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[renderer] failed to load ${url} — ${desc} (${code})`);
  });
  if (IS_DEV) mainWindow.webContents.on("render-process-gone", (_e, d) =>
    console.error("[renderer] gone:", d));

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow.once("ready-to-show", () => {
    if (splash) { splash.destroy(); splash = null; }
    mainWindow.show();
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  attachStyleguide(mainWindow);
}

// ---------------------------------------------------------------------------
// Styleguide — DEV ONLY
// ---------------------------------------------------------------------------
// Not in the sidebar, not in the menu bar, and not in a packaged build: the
// module is injected only when unpackaged, and renderer/dev + renderer/styleguide
// are excluded from electron-builder's file list. Reachable at #/styleguide or
// with Cmd+Ctrl+G.
//
// before-input-event is used rather than globalShortcut so the accelerator only
// fires while this window has focus, instead of app-wide.
function attachStyleguide(win) {
  if (app.isPackaged) return;

  win.webContents.on("did-finish-load", () => {
    win.webContents
      // The trailing `.then(() => undefined)` keeps the module namespace object
      // out of the return value — executeJavaScript structured-clones whatever
      // the expression resolves to, and a Module is not cloneable.
      .executeJavaScript(`import("${APP_ORIGIN}/dev/styleguide-entry.js").then(() => undefined)`)
      .catch((err) => console.error("[styleguide] inject failed:", err));
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const combo = process.platform === "darwin"
      ? input.meta && input.control     // Cmd+Ctrl+G
      : input.control && input.alt;     // Ctrl+Alt+G elsewhere
    if (!combo || input.key.toLowerCase() !== "g") return;
    event.preventDefault();
    win.webContents.executeJavaScript("window.__vocalisToggleStyleguide?.()");
  });
}

// Settings is an in-app page, not a separate window (product decision — the
// design system asks for a window; see SettingsView). The chrome handler below
// is retained because it is harmless and the page calls it optionally.
ipcMain.handle("vocalis:settingsChrome", (evt, { title, height } = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win || win.isDestroyed()) return;
  if (title) win.setTitle(title);
  if (height) {
    const [w] = win.getSize();
    win.setSize(w, Math.round(Math.min(900, Math.max(280, height))), true);
  }
});

// Settings live in localStorage, which the two renderers share but do not
// observe across windows reliably — so changes are relayed explicitly.
ipcMain.on("vocalis:settingsChanged", (evt, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents !== evt.sender) {
      win.webContents.send("vocalis:settingsChanged", payload);
    }
  }
});

ipcMain.handle("vocalis:diagnostics", async () => {
  const paths = resolvePaths();
  return [
    `Vocalis ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    `Node ${process.versions.node}`,
    `${process.platform} ${process.arch} · ${os.release()}`,
    `Data directory: ${paths.dataDir}`,
    `Sidecar port: ${serverPort}`,
    `Packaged: ${app.isPackaged}`,
  ].join("\n");
});

/**
 * Move the data directory.
 *
 * Deliberately COPIES and switches without deleting the source. Moving ~700 MB
 * of irreplaceable voice models is the most destructive thing this app can do,
 * so the old folder is left intact for the user to remove once they are happy.
 */
ipcMain.handle("vocalis:chooseDataDir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where Vocalis keeps your data",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (res.canceled || !res.filePaths[0]) return { moved: false, canceled: true };

  const target = res.filePaths[0];
  const current = resolvePaths().dataDir;
  if (path.resolve(target) === path.resolve(current)) {
    return { moved: false, canceled: false, reason: "That is already the current location." };
  }

  try {
    for (const name of ["voice_models", "outputs", "training_datasets",
                        "covers.json", "voices-cache.json"]) {
      const from = path.join(current, name);
      if (fs.existsSync(from)) {
        await fs.promises.cp(from, path.join(target, name), { recursive: true });
      }
    }
  } catch (err) {
    return { moved: false, canceled: false, error: String(err.message || err) };
  }

  writePrefs({ dataDir: target });
  return { moved: true, target, previous: current };
});

// Only http/https escape the app — never a file: or custom-scheme URL.
ipcMain.handle("vocalis:openExternal", (_evt, url) => {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("vocalis:relaunch", () => {
  app.relaunch();
  app.exit(0);
});



// ---------------------------------------------------------------------------
// Menu bar (§9)
// ---------------------------------------------------------------------------
// Menu items do not act directly — they post a command to the renderer, which
// owns routing and selection. Keeps one source of truth for what each verb does.
function send(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("vocalis:command", command);
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New cover", accelerator: "CmdOrCtrl+N", click: () => send("new-cover") },
        { label: "Speak", accelerator: "CmdOrCtrl+Shift+S", click: () => send("speak") },
        { label: "Train a voice", accelerator: "CmdOrCtrl+Shift+T", click: () => send("train") },
        { label: "Import voice…", click: () => send("import-voice") },
        { type: "separator" },
        { label: "Export cover", accelerator: "CmdOrCtrl+E", click: () => send("export") },
        ...(isMac ? [] : [
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
          { role: "quit" },
        ]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        { label: "Find", accelerator: "CmdOrCtrl+F", click: () => send("search") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Covers", accelerator: "CmdOrCtrl+1", click: () => send("covers") },
        { label: "Spoken", accelerator: "CmdOrCtrl+2", click: () => send("spoken") },
        { label: "Voices", accelerator: "CmdOrCtrl+3", click: () => send("voices") },
        { type: "separator" },
        { label: "Show/hide inspector", accelerator: "Alt+Command+I", click: () => send("toggle-inspector") },
        { label: "Show/hide sidebar", accelerator: "Control+Command+S", click: () => send("toggle-sidebar") },
        { type: "separator" },
        { label: "Rescan library", accelerator: "CmdOrCtrl+R", click: () => send("rescan") },
        ...(IS_DEV ? [
          { type: "separator" },
          { role: "toggleDevTools" },
        ] : []),
      ],
    },
    { role: "window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
    {
      role: "help",
      submenu: [
        {
          label: "Vocalis Help",
          click: () => shell.openExternal("https://github.com/"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showFatalError(message) {
  if (splash) { splash.destroy(); splash = null; }
  dialog.showErrorBox("AI Cover Studio couldn't start", message);
  app.quit();
}

// ---------------------------------------------------------------------------
// IPC bridge (native-only features)
// ---------------------------------------------------------------------------
// package.json is the single source of truth for the version — the sidebar
// badge and the About pane both derive from this, so there is no hardcoded
// "v2" or "build 412" anywhere in the renderer.
ipcMain.handle("vocalis:getConfig", () => ({
  port: serverPort,
  isDev: IS_DEV,
  appVersion: app.getVersion(),
}));

ipcMain.handle("vocalis:pickModelFiles", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Import voice model files",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "RVC model files", extensions: ["pth", "index"] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("vocalis:pickVoiceModel", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose an RVC voice model",
    properties: ["openFile"],
    filters: [{ name: "RVC voice model", extensions: ["pth"] }],
  });
  return res.canceled ? "" : res.filePaths[0];
});

ipcMain.handle("vocalis:pickVoiceIndex", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose the matching RVC index",
    properties: ["openFile"],
    filters: [{ name: "RVC feature index", extensions: ["index"] }],
  });
  return res.canceled ? "" : res.filePaths[0];
});

ipcMain.handle("vocalis:pickAudioFiles", async (_evt, title) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || "Choose recordings",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "ogg", "aiff", "aif"] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("vocalis:pickAudio", async (_evt, title) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || "Choose an audio file",
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "ogg", "aiff", "aif"] }],
  });
  return res.canceled ? "" : res.filePaths[0];
});

ipcMain.handle("vocalis:pickFolder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder of voice samples",
    properties: ["openDirectory"],
  });
  return res.canceled ? "" : res.filePaths[0];
});

ipcMain.handle("vocalis:saveCover", async (_evt, name) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Save cover", defaultPath: name || "cover.mp3",
    filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
  });
  return res.canceled ? "" : res.filePath;
});

// Generic save dialog — used to export a voice model (.pth) or other files.
ipcMain.handle("vocalis:savePath", async (_evt, opts) => {
  const { title, defaultName, extensions } = opts || {};
  const res = await dialog.showSaveDialog(mainWindow, {
    title: title || "Export",
    defaultPath: defaultName || "file",
    filters: extensions && extensions.length
      ? [{ name: "File", extensions }]
      : undefined,
  });
  return res.canceled ? "" : res.filePath;
});

ipcMain.handle("vocalis:downloadTo", async (_evt, url, destPath) => {
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    http.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
  return destPath;
});

ipcMain.handle("vocalis:revealPath", (_evt, p) => { shell.showItemInFolder(p); });

// openSettings retired: Settings is a route in the main window now.

// The renderer moved from file:// to app:// during the redesign, and
// localStorage is per-origin — so the app can no longer read its own pre-redesign
// coverMeta. It was extracted from Chromium's LevelDB into this file; the
// renderer merges it with whatever the current origin has and posts both to the
// migration route exactly once.
// ---------------------------------------------------------------------------
// Long-run support (§9)
// ---------------------------------------------------------------------------

// A cover or a training run can take hours. Native notification on completion,
// and the display is kept awake for the duration.
ipcMain.handle("vocalis:notify", (_evt, { title, body, silent } = {}) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body, silent: Boolean(silent) });
  // Clicking the notification should bring you to the finished work.
  n.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send("vocalis:command", "show-result");
    }
  });
  n.show();
  return true;
});

let sleepBlockerId = null;
ipcMain.handle("vocalis:preventSleep", (_evt, prevent) => {
  if (prevent) {
    if (sleepBlockerId === null) {
      // display-sleep rather than app-suspension: the machine may dim, but the
      // run must not be suspended mid-pipeline.
      sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    }
  } else if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  return sleepBlockerId !== null;
});

// Read a local audio file for playback in the renderer. Needed for the
// Original/Cover A/B: the source track sits outside the app:// origin, and the
// CSP allows blob: but not file:. Capped so a mistaken path cannot pull an
// arbitrarily large file into the renderer.
const MAX_INLINE_AUDIO = 200 * 1024 * 1024;
ipcMain.handle("vocalis:readAudio", async (_evt, filePath) => {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_INLINE_AUDIO) return null;
    const buf = await fs.promises.readFile(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
});

// ---------------------------------------------------------------------------
// Finder integration (§9)
// ---------------------------------------------------------------------------

// startDrag refuses an empty icon, so keep one tiny transparent PNG around
// rather than building a nativeImage per drag.
let DRAG_ICON = null;
function dragIcon() {
  if (!DRAG_ICON) {
    DRAG_ICON = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4y2NgGAWjYBSMglEwCkbBKBgFo2AUAAAGgAABmm0aBwAAAABJRU5ErkJggg=="
    );
  }
  return DRAG_ICON;
}

// Drag one or many covers straight out to Finder.
ipcMain.on("vocalis:startDrag", (evt, filePaths) => {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
    .filter((p) => typeof p === "string" && fs.existsSync(p));
  if (!files.length) return;
  evt.sender.startDrag({ files, file: files[0], icon: dragIcon() });
});

// Quick Look (Space on a selected row). macOS only; qlmanage is the supported
// way to drive the panel from outside AppKit.
ipcMain.handle("vocalis:quickLook", (_evt, filePath) => {
  if (process.platform !== "darwin" || !filePath || !fs.existsSync(filePath)) return false;
  try {
    spawn("qlmanage", ["-p", filePath], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
});

/**
 * Export one or many covers. A single file gets a Save dialog so it can be
 * renamed; several get a folder picker, because naming each one in turn is a
 * worse experience than choosing a destination once.
 */
ipcMain.handle("vocalis:exportFiles", async (_evt, items) => {
  const list = (items || []).filter((i) => i?.path && fs.existsSync(i.path));
  if (!list.length) return { exported: 0, canceled: false };

  if (list.length === 1) {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Export cover",
      defaultPath: list[0].name,
      filters: [{ name: "Audio", extensions: [path.extname(list[0].name).slice(1) || "mp3"] }],
    });
    if (res.canceled || !res.filePath) return { exported: 0, canceled: true };
    await fs.promises.copyFile(list[0].path, res.filePath);
    return { exported: 1, canceled: false, destination: res.filePath };
  }

  const res = await dialog.showOpenDialog(mainWindow, {
    title: `Export ${list.length} covers`,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Export",
  });
  if (res.canceled || !res.filePaths[0]) return { exported: 0, canceled: true };

  const dir = res.filePaths[0];
  let exported = 0;
  for (const item of list) {
    // Never silently overwrite: disambiguate with a numeric suffix.
    let dest = path.join(dir, item.name);
    let n = 2;
    while (fs.existsSync(dest)) {
      const ext = path.extname(item.name);
      dest = path.join(dir, `${path.basename(item.name, ext)} ${n++}${ext}`);
    }
    await fs.promises.copyFile(item.path, dest);
    exported++;
  }
  return { exported, canceled: false, destination: dir };
});

ipcMain.handle("vocalis:legacyCoverMeta", () => {
  try {
    const file = path.join(path.resolve(__dirname, ".."), ".migration", "legacy-localstorage.json");
    const blob = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.values(blob).reduce(
      (acc, origin) => Object.assign(acc, origin.coverMeta || {}), {});
  } catch {
    return {};   // nothing to recover is a normal outcome, not an error
  }
});

// ---------------------------------------------------------------------------
// Waveform peak cache
// ---------------------------------------------------------------------------
// Decoding a 3-minute MP3 to draw a 40px thumbnail costs ~200ms and a few MB.
// Doing that for 22 rows on every render is untenable, so peaks are computed
// once and persisted. Keyed by name+size+mtime so a regenerated file re-decodes.
const PEAKS_FILE = () => path.join(app.getPath("userData"), "peaks-cache.json");
let peaksCache = null;

function readPeaksCache() {
  if (peaksCache) return peaksCache;
  try {
    peaksCache = JSON.parse(fs.readFileSync(PEAKS_FILE(), "utf8"));
  } catch {
    peaksCache = {};
  }
  return peaksCache;
}

let peaksWriteTimer = null;
function schedulePeaksWrite() {
  clearTimeout(peaksWriteTimer);
  // Coalesce the burst of writes that happens as a library first renders.
  peaksWriteTimer = setTimeout(() => {
    try {
      const tmp = PEAKS_FILE() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(peaksCache));
      fs.renameSync(tmp, PEAKS_FILE());   // atomic
    } catch (err) {
      console.error("[peaks] write failed:", err);
    }
  }, 400);
}

ipcMain.handle("vocalis:peaksGet", (_evt, key) => readPeaksCache()[key] ?? null);

ipcMain.handle("vocalis:peaksPut", (_evt, key, value) => {
  readPeaksCache()[key] = value;
  schedulePeaksWrite();
});

// Dock progress bar (§9) — driven by training and cover generation.
// value is 0..1; anything outside that range clears the indicator.
ipcMain.handle("vocalis:setProgressBar", (_evt, value, options) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const v = typeof value === "number" && value >= 0 && value <= 1 ? value : -1;
  mainWindow.setProgressBar(v, options && typeof options === "object" ? options : undefined);
});

// The window is transparent over AppKit vibrancy, so the blur behind the glass
// is drawn by macOS — not by us. Pointing nativeTheme at the theme chosen in the
// app keeps that blur the same brightness as the glass sitting on top of it.
ipcMain.handle("vocalis:setAppearance", (_evt, source) => {
  const allowed = ["system", "light", "dark"];
  nativeTheme.themeSource = allowed.includes(source) ? source : "system";
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  registerAppProtocol();
  buildMenu();
  createSplash();
  try {
    await startSidecar();
    createMainWindow();
  } catch (err) {
    console.error(err);
    showFatalError(String(err.message || err));
  }
});

app.on("window-all-closed", () => {
  stopSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopSidecar);
app.on("will-quit", stopSidecar);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) createMainWindow();
});
