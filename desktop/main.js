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

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const IS_DEV = !app.isPackaged || process.env.ACS_DEV === "1";

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
  splash = new BrowserWindow({
    width: 440, height: 280, frame: false, resizable: false,
    center: true, backgroundColor: "#141417", show: true,
  });
  splash.loadFile(path.join(__dirname, "renderer", "splash.html"));
}

function createMainWindow() {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1200, height: 820, minWidth: 780, minHeight: 640,
    backgroundColor: "#141417", show: false, title: "Vocalis",
    // Hidden title bar for a first-party feel; traffic lights stay inset on mac.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 16, y: 20 } : undefined,
    titleBarOverlay: isMac ? undefined : { color: "#00000000", symbolColor: "#8a8a90", height: 44 },
    ...(isMac ? { vibrancy: "under-window", visualEffectState: "active" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (splash) { splash.destroy(); splash = null; }
    mainWindow.show();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function showFatalError(message) {
  if (splash) { splash.destroy(); splash = null; }
  dialog.showErrorBox("AI Cover Studio couldn't start", message);
  app.quit();
}

// ---------------------------------------------------------------------------
// IPC bridge (native-only features)
// ---------------------------------------------------------------------------
ipcMain.handle("acs:getConfig", () => ({ port: serverPort, isDev: IS_DEV }));

ipcMain.handle("acs:pickModelFiles", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Import voice model files",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "RVC model files", extensions: ["pth", "index"] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("acs:pickFolder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder of voice samples",
    properties: ["openDirectory"],
  });
  return res.canceled ? "" : res.filePaths[0];
});

ipcMain.handle("acs:saveCover", async (_evt, name) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Save cover", defaultPath: name || "cover.mp3",
    filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
  });
  return res.canceled ? "" : res.filePath;
});

// Generic save dialog — used to export a voice model (.pth) or other files.
ipcMain.handle("acs:savePath", async (_evt, opts) => {
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

ipcMain.handle("acs:downloadTo", async (_evt, url, destPath) => {
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    http.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
  return destPath;
});

ipcMain.handle("acs:revealPath", (_evt, p) => { shell.showItemInFolder(p); });

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
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
