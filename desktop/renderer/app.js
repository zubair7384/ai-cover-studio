/* AI Cover Studio — renderer logic. Talks to the local Python sidecar. */

const $ = (id) => document.getElementById(id);
let API = "";           // http://127.0.0.1:<port>
let lastCoverName = ""; // filename of the most recent finished cover
let lastCoverPath = ""; // absolute disk path of that cover

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const cfg = await window.acs.getConfig();
  API = `http://127.0.0.1:${cfg.port}`;
  wireTabs();
  wireTheme();
  wireInputs();
  wireDropzones();
  wireButtons();
  await loadHealth();
  await refreshModels();
}

async function loadHealth() {
  try {
    const res = await fetch(`${API}/api/health`);
    const data = await res.json();
    const hw = data.hardware || {};
    $("hw-badge").textContent = hw.tier === "gpu" ? `⚡ ${hw.label}` : hw.label;
    // sample rate dropdown
    const sr = $("train-sr");
    sr.innerHTML = "";
    (data.sample_rates || ["40000"]).forEach((v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = `${v} Hz`;
      if (v === "40000") o.selected = true;
      sr.appendChild(o);
    });
    // training hardware warning
    if (hw.training_warning) {
      const w = $("train-warning");
      w.textContent = "⚠️ " + hw.training_warning;
      w.classList.remove("hidden");
    }
    $("train-note").textContent =
      "First training run needs Python 3.11+ installed and internet once to " +
      "fetch the Applio trainer + base models (~2 GB); afterwards it runs offline. " +
      (hw.tier === "gpu" ? "Training is fast on your GPU."
        : "Training on CPU can take a long time — leave the app open.");
  } catch (err) {
    $("hw-badge").textContent = "engine offline";
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Models dropdown
// ---------------------------------------------------------------------------
async function refreshModels() {
  const res = await fetch(`${API}/api/models`);
  const { models } = await res.json();
  const sel = $("model-select");
  const prev = sel.value;
  sel.innerHTML = "";
  if (!models.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "No models yet — import a .pth";
    sel.appendChild(o);
    $("model-hint").textContent = "Import a trained .pth model, or train one in the Training tab.";
  } else {
    models.forEach((m) => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
    if (models.includes(prev)) sel.value = prev;
    $("model-hint").textContent = `${models.length} voice model${models.length > 1 ? "s" : ""} available.`;
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

function wireTheme() {
  $("theme-btn").addEventListener("click", () => document.body.classList.toggle("dark"));
}

function wireInputs() {
  const bind = (id, valId, fmt = (v) => v) => {
    const el = $(id);
    el.addEventListener("input", () => { $(valId).textContent = fmt(el.value); });
  };
  bind("pitch", "pitch-val");
  bind("index-rate", "index-val");
  bind("vocal-gain", "gain-val");
  bind("epochs", "epochs-val");
}

function wireDropzones() {
  setupDrop("song-drop", "song-input", "song-name", false);
  setupDrop("samples-drop", "samples-input", "samples-name", true);
}

function setupDrop(dropId, inputId, nameId, multiple) {
  const drop = $(dropId), input = $(inputId), name = $(nameId);
  const show = (files) => {
    if (!files || !files.length) { name.textContent = ""; return; }
    name.textContent = multiple
      ? `${files.length} file${files.length > 1 ? "s" : ""} selected`
      : files[0].name;
  };
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => show(input.files));
  ["dragover", "dragenter"].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (ev) => {
    input.files = ev.dataTransfer.files;
    show(input.files);
  });
}

function wireButtons() {
  $("refresh-btn").addEventListener("click", refreshModels);
  $("import-btn").addEventListener("click", importModels);
  $("generate-btn").addEventListener("click", generateCover);
  $("train-btn").addEventListener("click", trainVoice);
  $("folder-btn").addEventListener("click", async () => {
    const dir = await window.acs.pickFolder();
    if (dir) $("dataset-dir").value = dir;
  });
  $("save-btn").addEventListener("click", saveCover);
  $("reveal-btn").addEventListener("click", () => {
    if (lastCoverPath) window.acs.revealPath(lastCoverPath);
  });
}

async function importModels() {
  const paths = await window.acs.pickModelFiles();
  if (!paths.length) return;
  const res = await fetch(`${API}/api/models/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  const data = await res.json();
  await refreshModels();
  $("model-hint").textContent =
    `Imported ${data.copied.length} file(s).` + (data.skipped.length ? ` Skipped ${data.skipped.length}.` : "");
}

// ---------------------------------------------------------------------------
// SSE job runner — shared by convert + train
// ---------------------------------------------------------------------------
function runJob(jobId, { stepEl, elapsedEl, progressEl, logEl }, onDone, onError) {
  const start = Date.now();
  const lines = [];
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    elapsedEl.textContent = `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }, 1000);

  const es = new EventSource(`${API}/api/jobs/${jobId}/events`);
  const finish = () => { clearInterval(timer); es.close(); };

  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "progress") {
      stepEl.textContent = msg.step + (msg.note ? "  —  " + msg.note : "");
      progressEl.style.width = `${Math.round(msg.fraction * 100)}%`;
    } else if (msg.type === "log") {
      lines.push(msg.line);
      if (lines.length > 400) lines.shift();
      logEl.textContent = lines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    } else if (msg.type === "done") {
      finish(); onDone(msg.result);
    } else if (msg.type === "error") {
      finish(); onError(msg.message);
    }
  };
  es.onerror = () => { /* keep-alive gaps are normal; only fatal if closed */ };
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------
async function generateCover() {
  const model = $("model-select").value;
  const file = $("song-input").files[0];
  const result = $("cover-result");
  if (!model) { result.textContent = "Select a voice model first."; result.className = "result-empty error"; return; }
  if (!file) { result.textContent = "Upload a song first."; result.className = "result-empty error"; return; }

  const fd = new FormData();
  fd.append("model_name", model);
  fd.append("pitch_shift", $("pitch").value);
  fd.append("index_rate", $("index-rate").value);
  fd.append("vocal_gain_db", $("vocal-gain").value);
  fd.append("song", file);

  setBusy("generate-btn", true, "Generating…");
  $("cover-actions").classList.add("hidden");
  result.textContent = "Working…"; result.className = "result-empty";
  $("swap-log").textContent = "";

  try {
    const res = await fetch(`${API}/api/convert`, { method: "POST", body: fd });
    const { job_id } = await res.json();
    runJob(job_id, {
      stepEl: $("swap-step"), elapsedEl: $("swap-elapsed"),
      progressEl: $("swap-progress"), logEl: $("swap-log"),
    }, (r) => {
      lastCoverPath = r.path;
      lastCoverName = r.path.split(/[\\/]/).pop();
      result.className = "";
      result.innerHTML = "";
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = `${API}/api/outputs/${encodeURIComponent(lastCoverName)}`;
      result.appendChild(audio);
      $("cover-actions").classList.remove("hidden");
      $("swap-step").textContent = "✅ Done.";
      setBusy("generate-btn", false, "Generate Cover");
    }, (msg) => {
      result.textContent = "❌ " + msg; result.className = "result-empty error";
      $("swap-step").textContent = "Failed.";
      setBusy("generate-btn", false, "Generate Cover");
    });
  } catch (err) {
    result.textContent = "❌ " + err; result.className = "result-empty error";
    setBusy("generate-btn", false, "Generate Cover");
  }
}

async function saveCover() {
  if (!lastCoverName) return;
  const dest = await window.acs.saveCover(lastCoverName);
  if (!dest) return;
  await window.acs.downloadTo(`${API}/api/outputs/${encodeURIComponent(lastCoverName)}`, dest);
  window.acs.revealPath(dest);
}

// ---------------------------------------------------------------------------
// Train
// ---------------------------------------------------------------------------
async function trainVoice() {
  const files = $("samples-input").files;
  const dir = $("dataset-dir").value.trim();
  if (!files.length && !dir) {
    $("train-step").textContent = "Add voice samples or a folder path first.";
    return;
  }
  const fd = new FormData();
  fd.append("model_name", $("train-name").value || "my_voice");
  fd.append("sample_rate", $("train-sr").value);
  fd.append("epochs", $("epochs").value);
  fd.append("dataset_dir", dir);
  for (const f of files) fd.append("samples", f);

  setBusy("train-btn", true, "Training…");
  $("train-log").textContent = "";
  $("train-step").textContent = "Starting…";

  try {
    const res = await fetch(`${API}/api/train`, { method: "POST", body: fd });
    if (res.status === 409) {
      $("train-step").textContent = "A training job is already running.";
      setBusy("train-btn", false, "Train Voice Model");
      return;
    }
    const { job_id } = await res.json();
    runJob(job_id, {
      stepEl: $("train-step"), elapsedEl: $("train-elapsed"),
      progressEl: $("train-progress"), logEl: $("train-log"),
    }, async (r) => {
      $("train-step").textContent = `✅ Trained "${r.model_name}" — switch to Vocal Swapper.`;
      await refreshModels();
      setBusy("train-btn", false, "Train Voice Model");
    }, (msg) => {
      $("train-step").textContent = "❌ " + msg;
      setBusy("train-btn", false, "Train Voice Model");
    });
  } catch (err) {
    $("train-step").textContent = "❌ " + err;
    setBusy("train-btn", false, "Train Voice Model");
  }
}

function setBusy(btnId, busy, label) {
  const b = $(btnId);
  b.disabled = busy;
  b.textContent = label;
}

boot();
