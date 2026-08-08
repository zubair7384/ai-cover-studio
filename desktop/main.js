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
} = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
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
let settingsWindow = null;

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
      dataDir: repo, // dev writes back into the repo tree (git-ignored)
    };
  }
  // Packaged: assets live under <resources>/backend, user data in userData.
  const backend = path.join(process.resourcesPath, "backend");
  const runtimePy = process.platform === "win32"
    ? path.join(backend, "runtime", "python.exe")
    : path.join(backend, "runtime", "bin", "python3");
  const dataDir = app.getPath("userData");
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
      trafficLightPosition: { x: 18, y: 20 },
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
      .executeJavaScript(`import("${APP_ORIGIN}/dev/styleguide-entry.js")`)
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

// ---------------------------------------------------------------------------
// Settings window (§8: Mac apps put settings in a separate ⌘, window)
// ---------------------------------------------------------------------------
// Prompt 6 fills in the four tabs; this gives ⌘, and the sidebar gear a real
// destination now. Non-resizable width 620, per the design system.
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 620, height: 420,
    resizable: false, minimizable: false, maximizable: false,
    title: "Settings",
    backgroundColor: "#181A1C",
    parent: mainWindow || undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadURL(`${APP_ORIGIN}/settings.html`);
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

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
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
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
        { label: "New Cover", accelerator: "CmdOrCtrl+N", click: () => send("new-cover") },
        { label: "Train a Voice", accelerator: "CmdOrCtrl+Shift+T", click: () => send("train") },
        { label: "Import Voice…", click: () => send("import-voice") },
        { type: "separator" },
        { label: "Export Cover", accelerator: "CmdOrCtrl+E", click: () => send("export") },
        ...(isMac ? [] : [
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
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
        { label: "Voices", accelerator: "CmdOrCtrl+2", click: () => send("voices") },
        { type: "separator" },
        { label: "Show/Hide Inspector", accelerator: "Alt+Command+I", click: () => send("toggle-inspector") },
        { label: "Show/Hide Sidebar", accelerator: "Control+Command+S", click: () => send("toggle-sidebar") },
        { type: "separator" },
        { label: "Rescan Library", accelerator: "CmdOrCtrl+R", click: () => send("rescan") },
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

ipcMain.handle("vocalis:openSettings", () => openSettings());

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
