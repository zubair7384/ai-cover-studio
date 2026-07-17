/* ============================================================================
   Vocalis — renderer. Talks to the local Python sidecar over HTTP.
   Visual + structural redesign; backend contract is unchanged.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let API = "";
const BRAND = { name: "Vocalis", tagline: "Any song. Your voice. Fully local.", version: "v2" };

// ---------------------------------------------------------------------------
// Icons (Lucide-style, 1.5px stroke via CSS)
// ---------------------------------------------------------------------------
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  swap: '<path d="M2 10v4M6 6v12M10 4v16M14 7v10M18 5v14M22 10v4"/>',
  clone: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1 2 2 6 2s6-1 6-2v-5"/>',
  voices: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  library: '<path d="M21 15V6M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 12H3M16 6H3M12 18H3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 6 4.5Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  headphones: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 16a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3M3 16a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3"/>',
  sparkles: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
};
function icon(name, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const fmt = {
  bytes(n) {
    if (!n && n !== 0) return "—";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  dur(sec) {
    if (!sec && sec !== 0) return "—";
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  },
  clock(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  },
  date(ms) {
    try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
    catch { return "—"; }
  },
};

// ---------------------------------------------------------------------------
// Local store (offline; localStorage)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("vocalis." + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, val) { localStorage.setItem("vocalis." + key, JSON.stringify(val)); },
};

const state = {
  user: null,               // {email, name, avatar}
  guest: false,
  health: null,
  models: [],               // [{name,size,modified,has_index}]
  covers: [],               // [{name,size,modified}]
  route: "dashboard",
  settings: store.get("settings", { theme: "system", defaultSampleRate: "40000", defaultEpochs: 300, exportDir: "" }),
  modelMeta: store.get("modelMeta", {}),  // name -> {sampleRate, epochs, dateTrained, testPhrase}
  coverMeta: store.get("coverMeta", {}),  // filename -> {song, voice, pitch, index, gain, duration, date}
};

// working state for the two flows (persist across navigation)
const swapWork = { model: "", songFile: null, songUrl: "", songDur: 0, pitch: 0, index: 0.75, gain: 0 };
const trainWork = { name: "", files: [], datasetDir: "", sampleRate: "40000", epochs: 300 };

// ---------------------------------------------------------------------------
// Crypto — local password hashing (PBKDF2)
// ---------------------------------------------------------------------------
async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return { hash, salt: btoa(String.fromCharCode(...salt)) };
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------
const api = {
  async health() { return (await fetch(`${API}/api/health`)).json(); },
};

async function loadModels() {
  try {
    const r = await fetch(`${API}/api/models/meta`);
    state.models = (await r.json()).models || [];
  } catch { state.models = []; }
}
async function loadCovers() {
  try {
    const r = await fetch(`${API}/api/outputs`);
    state.covers = (await r.json()).covers || [];
  } catch { state.covers = []; }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast({ kind = "info", title, msg = "", action } = {}) {
  const el = h(`<div class="toast ${kind}">
    <span class="t-icon">${icon(kind === "ok" ? "checkCircle" : kind === "err" ? "alert" : "info")}</span>
    <div class="t-body"><div class="t-title"></div>${msg ? `<div class="t-msg"></div>` : ""}</div>
  </div>`);
  $(".t-title", el).textContent = title;
  if (msg) $(".t-msg", el).textContent = msg;
  if (action) {
    const b = h(`<button class="t-action"></button>`);
    b.textContent = action.label;
    b.onclick = () => { action.fn(); dismiss(); };
    $(".t-body", el).appendChild(b);
  }
  $("#toasts").appendChild(el);
  let killed = false;
  const dismiss = () => {
    if (killed) return; killed = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  setTimeout(dismiss, action ? 8000 : 4500);
  return dismiss;
}

// ---------------------------------------------------------------------------
// Modal / confirm / menu
// ---------------------------------------------------------------------------
function closeModal() {
  const root = $("#modal-root");
  root.classList.remove("open");
  root.innerHTML = "";
  document.removeEventListener("keydown", modalEsc);
}
function modalEsc(e) { if (e.key === "Escape") closeModal(); }
function openModal(node) {
  const root = $("#modal-root");
  root.innerHTML = "";
  const scrim = h(`<div class="modal-scrim"></div>`);
  scrim.onclick = closeModal;
  root.appendChild(scrim);
  root.appendChild(node);
  root.classList.add("open");
  document.addEventListener("keydown", modalEsc);
  const focusable = $("input, button", node);
  if (focusable) setTimeout(() => focusable.focus(), 50);
}
function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false, onConfirm }) {
  const m = h(`<div class="modal" role="dialog" aria-modal="true">
    <h3></h3><p></p>
    <div class="modal-actions">
      <button class="btn ghost" data-cancel>Cancel</button>
      <button class="btn ${danger ? "danger" : ""}" data-ok></button>
    </div>
  </div>`);
  $("h3", m).textContent = title;
  $("p", m).textContent = message;
  const ok = $("[data-ok]", m); ok.textContent = confirmLabel;
  if (danger) ok.style.borderColor = "var(--err)", ok.style.color = "var(--err)";
  $("[data-cancel]", m).onclick = closeModal;
  ok.onclick = async () => { closeModal(); await onConfirm(); };
  openModal(m);
}
function openMenu(anchor, items) {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const menu = h(`<div class="menu"></div>`);
  items.forEach((it) => {
    if (it.sep) { menu.appendChild(h(`<div class="sep"></div>`)); return; }
    const b = h(`<button class="${it.danger ? "danger" : ""}">${icon(it.icon)}<span></span></button>`);
    $("span", b).textContent = it.label;
    b.onclick = () => { menu.remove(); it.fn(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.right - mw, top = r.bottom + 6;
  if (top + mh > innerHeight - 10) top = r.top - mh - 6;
  left = Math.max(10, left);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) {
      menu.remove(); document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const mql = window.matchMedia("(prefers-color-scheme: dark)");
function resolvedTheme() {
  const t = state.settings.theme;
  return t === "system" ? (mql.matches ? "dark" : "light") : t;
}
function applyTheme() { document.documentElement.dataset.theme = resolvedTheme(); }
function setTheme(t) {
  state.settings.theme = t; store.set("settings", state.settings); applyTheme();
}
mql.addEventListener("change", () => { if (state.settings.theme === "system") applyTheme(); });

// ---------------------------------------------------------------------------
// Waveform player
// ---------------------------------------------------------------------------
let _audioCtx = null;
function audioCtx() { return (_audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()); }
const _peakCache = new Map();

class Player {
  constructor({ cover, original = null, mini = false, onDuration } = {}) {
    this.urls = { cover, original };
    this.side = "cover";
    this.mini = mini;
    this.onDuration = onDuration;
    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.audio.src = cover;
    this.peaks = null;
    this.raf = 0;
    this.el = this.build();
    this.audio.addEventListener("loadedmetadata", () => { this.renderTime(); this.onDuration?.(this.audio.duration); });
    this.audio.addEventListener("ended", () => { this.playing = false; this.syncBtn(); });
    this.audio.addEventListener("timeupdate", () => this.drawProgress());
    this.loadPeaks(cover);
  }
  build() {
    const abHtml = this.urls.original
      ? `<div class="ab-toggle"><button class="on" data-side="cover">Cover</button><button data-side="original">Original</button></div>`
      : "";
    const el = h(`<div class="player ${this.mini ? "mini" : ""}">
      <div class="wave-wrap"><canvas></canvas></div>
      <div class="player-controls">
        <button class="play-btn" title="Play / pause">${icon("play")}</button>
        <span class="time">0:00 / 0:00</span>
        ${abHtml}
      </div>
    </div>`);
    this.canvas = $("canvas", el);
    this.playBtn = $(".play-btn", el);
    this.timeEl = $(".time", el);
    this.playBtn.onclick = () => this.toggle();
    this.canvas.onclick = (e) => this.seek(e);
    $$(".ab-toggle button", el).forEach((b) => {
      b.onclick = () => this.switchSide(b.dataset.side, el);
    });
    requestAnimationFrame(() => this.resize());
    return el;
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 300;
    const hgt = this.mini ? 34 : 64;
    this.canvas.width = w * dpr; this.canvas.height = hgt * dpr;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.scale(dpr, dpr);
    this.cw = w; this.ch = hgt;
    this.drawProgress();
  }
  async loadPeaks(url) {
    if (_peakCache.has(url)) { this.peaks = _peakCache.get(url); this.drawProgress(); return; }
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const audioBuf = await audioCtx().decodeAudioData(buf);
      const data = audioBuf.getChannelData(0);
      const bars = 160;
      const block = Math.floor(data.length / bars) || 1;
      const peaks = [];
      for (let i = 0; i < bars; i++) {
        let max = 0;
        for (let j = 0; j < block; j++) { const v = Math.abs(data[i * block + j] || 0); if (v > max) max = v; }
        peaks.push(max);
      }
      const norm = Math.max(...peaks) || 1;
      this.peaks = peaks.map((p) => p / norm);
      _peakCache.set(url, this.peaks);
      this.drawProgress();
    } catch { this.peaks = null; this.drawProgress(); }
  }
  drawProgress() {
    if (!this.ctx) return;
    const { ctx, cw, ch } = this;
    ctx.clearRect(0, 0, cw, ch);
    const prog = this.audio.duration ? this.audio.currentTime / this.audio.duration : 0;
    const grad = ctx.createLinearGradient(0, 0, cw, 0);
    grad.addColorStop(0, "#7C6CFF"); grad.addColorStop(1, "#4D9FFF");
    const faint = getComputedStyle(document.documentElement).getPropertyValue("--fill-softer") || "rgba(150,150,160,0.2)";
    const peaks = this.peaks || Array(160).fill(0.15);
    const n = peaks.length;
    const gap = this.mini ? 1.5 : 2;
    const bw = (cw - gap * n) / n;
    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const bh = Math.max(2, peaks[i] * ch * 0.9);
      const y = (ch - bh) / 2;
      ctx.fillStyle = (i / n) <= prog ? grad : faint;
      const r = Math.min(bw / 2, 2);
      roundRect(ctx, x, y, bw, bh, r); ctx.fill();
    }
    this.renderTime();
    if (this.playing) this.raf = requestAnimationFrame(() => this.drawProgress());
  }
  renderTime() {
    const c = fmt.dur(this.audio.currentTime || 0);
    const d = fmt.dur(this.audio.duration || 0);
    if (this.timeEl) this.timeEl.textContent = `${c} / ${d}`;
  }
  toggle() {
    if (this.audio.paused) { audioCtx().resume?.(); this.audio.play(); this.playing = true; this.drawProgress(); }
    else { this.audio.pause(); this.playing = false; }
    this.syncBtn();
  }
  syncBtn() { this.playBtn.innerHTML = icon(this.audio.paused ? "play" : "pause"); }
  seek(e) {
    const r = this.canvas.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    if (this.audio.duration) this.audio.currentTime = pct * this.audio.duration;
    this.drawProgress();
  }
  switchSide(side, el) {
    if (side === this.side) return;
    this.side = side;
    $$(".ab-toggle button", el).forEach((b) => b.classList.toggle("on", b.dataset.side === side));
    const t = this.audio.currentTime, wasPlaying = !this.audio.paused;
    this.audio.src = this.urls[side];
    this.audio.currentTime = t || 0;
    this.loadPeaks(this.urls[side]);
    if (wasPlaying) this.audio.play();
  }
  destroy() { try { this.audio.pause(); } catch {} cancelAnimationFrame(this.raf); }
}
function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
let activePlayers = [];
function trackPlayer(p) { activePlayers.push(p); return p; }
function clearPlayers() { activePlayers.forEach((p) => p.destroy()); activePlayers = []; }

// ---------------------------------------------------------------------------
// SSE job runtime (persists across navigation)
// ---------------------------------------------------------------------------
function newJob() {
  return { status: "idle", step: "", note: "", progress: 0, log: [], startedAt: 0,
    elapsed: 0, timer: null, es: null, result: null, error: null };
}
const jobs = { swap: newJob(), train: newJob() };

function runJob(kind, jobId, { onDone, onError } = {}) {
  const j = jobs[kind];
  j.status = "running"; j.log = []; j.progress = 0; j.step = "Starting…"; j.note = "";
  j.result = null; j.error = null; j.startedAt = Date.now();
  clearInterval(j.timer);
  j.timer = setInterval(() => {
    j.elapsed = (Date.now() - j.startedAt) / 1000;
    if (state.route === kind) updateJobMeta(kind);
  }, 1000);

  const es = new EventSource(`${API}/api/jobs/${jobId}/events`);
  j.es = es;
  const finish = () => { clearInterval(j.timer); es.close(); j.es = null; };
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "progress") {
      j.step = msg.step; j.note = msg.note || ""; j.progress = msg.fraction || 0;
      if (state.route === kind) updateJobProgress(kind);
    } else if (msg.type === "log") {
      j.log.push(msg.line); if (j.log.length > 500) j.log.shift();
      if (state.route === kind) appendLog(kind, msg.line);
    } else if (msg.type === "done") {
      finish(); j.status = "done"; j.result = msg.result; onDone?.(msg.result);
    } else if (msg.type === "error") {
      finish(); j.status = "error"; j.error = msg.message; onError?.(msg.message);
    }
  };
  es.onerror = () => { /* keep-alive gaps are normal */ };
}

// ============================================================================
// NAVIGATION / SHELL
// ============================================================================
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "swap", label: "Vocal Swapper", icon: "swap" },
  { id: "train", label: "Voice Cloning", icon: "clone" },
  { id: "voices", label: "My Voices", icon: "voices" },
  { id: "library", label: "Library", icon: "library" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function renderSidebar() {
  const sb = $("#sidebar");
  sb.innerHTML = "";
  sb.appendChild(h(`<div class="brand">
    <div class="glyph"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="wordmark">${BRAND.name}</div>
    <div class="ver">${BRAND.version}</div>
  </div>`));

  const nav = h(`<nav id="nav"><div id="nav-lozenge"></div></nav>`);
  NAV.forEach((item) => {
    const b = h(`<button class="nav-item" data-route="${item.id}">
      ${icon(item.icon)}<span class="label">${item.label}</span></button>`);
    b.onclick = () => go(item.id);
    nav.appendChild(b);
  });
  sb.appendChild(nav);

  // footer
  const hw = state.health?.hardware;
  const footer = h(`<div id="sidebar-footer">
    <div class="compute-badge ${state.health ? "" : "offline"}">
      <span class="dot"></span><span>${hw ? hw.label : "engine offline"}</span>
    </div>
    <div class="footer-row">
      <button class="user-chip" id="user-chip">
        <span class="avatar" id="side-avatar"></span>
        <span class="who"><span class="nm" id="side-name"></span><span class="sub" id="side-sub"></span></span>
      </button>
      <button class="icon-btn" id="theme-btn" title="Toggle theme"></button>
    </div>
    <button class="icon-btn collapse-btn" id="collapse-btn" title="Collapse sidebar">${icon("panelLeft")}</button>
  </div>`);
  sb.appendChild(footer);

  // avatar + identity
  const who = state.guest ? { name: "Guest", sub: "Local only" } : { name: state.user.name, sub: state.user.email };
  $("#side-name", footer).textContent = who.name;
  $("#side-sub", footer).textContent = who.sub;
  setAvatar($("#side-avatar", footer), state.guest ? null : state.user);

  $("#theme-btn", footer).innerHTML = icon(resolvedTheme() === "dark" ? "sun" : "moon");
  $("#theme-btn", footer).onclick = () => {
    setTheme(resolvedTheme() === "dark" ? "light" : "dark");
    $("#theme-btn", footer).innerHTML = icon(resolvedTheme() === "dark" ? "sun" : "moon");
    renderSidebar();
  };
  $("#collapse-btn", footer).onclick = () => {
    $("#app").classList.toggle("rail");
    setTimeout(moveLozenge, 60);
  };
  $("#user-chip", footer).onclick = (e) => userMenu(e.currentTarget);

  markActiveNav();
}
function setAvatar(node, user) {
  if (user?.avatar) { node.innerHTML = `<img src="${user.avatar}" alt="" style="width:100%;height:100%;object-fit:cover"/>`; }
  else { node.textContent = (user?.name || "Guest").trim().charAt(0).toUpperCase() || "G"; }
}
function userMenu(anchor) {
  const items = state.guest
    ? [{ label: "Sign in", icon: "user", fn: () => showAuth() }]
    : [
        { label: "Profile", icon: "user", fn: () => go("settings") },
        { sep: true },
        { label: "Sign out", icon: "logout", danger: true, fn: signOut },
      ];
  openMenu(anchor, items);
}
function markActiveNav() {
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.route === state.route));
  moveLozenge();
}
function moveLozenge() {
  const active = $(`.nav-item[data-route="${state.route}"]`);
  const loz = $("#nav-lozenge");
  if (!active || !loz) return;
  loz.style.opacity = "1";
  loz.style.transform = `translateY(${active.offsetTop}px)`;
}

const screens = {}; // route -> render fn (assigned below)
function go(route) {
  state.route = route;
  clearPlayers();
  markActiveNav();
  const mount = $("#screen");
  mount.innerHTML = "";
  const node = screens[route]();
  node.classList.add("screen-enter");
  mount.appendChild(node);
  $("#content").scrollTop = 0;
}

// ============================================================================
// AUTH
// ============================================================================
function showApp() {
  $("#auth").classList.add("hidden");
  $("#auth").innerHTML = "";
  $("#app").classList.remove("hidden");
  renderSidebar();
  go("dashboard");
}
function signOut() {
  store.set("session", null);
  state.user = null; state.guest = false;
  showAuth();
}
function showAuth() {
  $("#app").classList.add("hidden");
  const auth = $("#auth");
  auth.classList.remove("hidden");
  let mode = "signin"; // or "register"

  function render() {
    auth.innerHTML = "";
    const card = h(`<div class="auth-card glass">
      <div class="auth-brand">
        <div class="glyph"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="auth-word">${BRAND.name}</div>
        <div class="auth-tag">${BRAND.tagline}</div>
      </div>
      <form id="auth-form" novalidate>
        ${mode === "register" ? field("name", "Name", "text", "Your name") : ""}
        ${field("email", "Email", "email", "you@example.com")}
        ${field("password", "Password", "password", "••••••••")}
        <button class="btn-primary full mt-8" type="submit">${mode === "signin" ? "Sign in" : "Create account"}</button>
      </form>
      <div class="auth-toggle">
        ${mode === "signin" ? "No account yet?" : "Already have an account?"}
        <a id="auth-switch">${mode === "signin" ? "Create account" : "Sign in"}</a>
      </div>
      <div class="auth-divider">or</div>
      <button class="btn ghost full" id="guest-btn" style="width:100%;justify-content:center">Continue without account</button>
    </div>`);
    auth.appendChild(card);
    $("#auth-switch", card).onclick = () => { mode = mode === "signin" ? "register" : "signin"; render(); };
    $("#guest-btn", card).onclick = () => {
      state.guest = true; state.user = null; store.set("session", "__guest__"); showApp();
    };
    $("#auth-form", card).onsubmit = (e) => { e.preventDefault(); submit(card); };
  }
  function field(id, label, type, ph) {
    return `<div class="auth-field">
      <label for="af-${id}">${label}</label>
      <input class="input" id="af-${id}" type="${type}" placeholder="${ph}" autocomplete="off"/>
      <div class="auth-err" id="err-${id}"></div>
    </div>`;
  }
  async function submit(card) {
    $$(".auth-err", card).forEach((e) => (e.textContent = ""));
    const val = (id) => $(`#af-${id}`, card)?.value.trim() || "";
    const setErr = (id, m) => { const e = $(`#err-${id}`, card); if (e) e.textContent = m; };
    const email = val("email"), pw = $("#af-password", card).value, name = val("name");
    let bad = false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr("email", "Enter a valid email."); bad = true; }
    if (pw.length < 6) { setErr("password", "At least 6 characters."); bad = true; }
    if (mode === "register" && !name) { setErr("name", "Name is required."); bad = true; }
    if (bad) return;

    try {
      const users = store.get("users", []);
      if (mode === "register") {
        if (users.some((u) => u.email === email)) { setErr("email", "That email is already registered."); return; }
        const { hash, salt } = await hashPassword(pw);
        const user = { email, name, avatar: null, salt, hash };
        users.push(user); store.set("users", users);
        finishAuth(user);
        toast({ kind: "ok", title: `Welcome, ${name}` });
      } else {
        const user = users.find((u) => u.email === email);
        if (!user) { setErr("email", "No account with that email."); return; }
        const { hash } = await hashPassword(pw, user.salt);
        if (hash !== user.hash) { setErr("password", "Incorrect password."); return; }
        finishAuth(user);
        toast({ kind: "ok", title: `Welcome back, ${user.name}` });
      }
    } catch (err) {
      setErr("password", "Sign-in failed on this device. Try “Continue without account”.");
      console.error(err);
    }
  }
  function finishAuth(user) {
    state.user = { email: user.email, name: user.name, avatar: user.avatar || null };
    state.guest = false;
    store.set("session", user.email);
    showApp();
  }
  render();
}

// ============================================================================
// SCREEN: Dashboard
// ============================================================================
screens.dashboard = () => {
  const wrap = h(`<div></div>`);
  const name = state.guest ? "there" : (state.user?.name?.split(" ")[0] || "there");
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  wrap.appendChild(h(`<div class="page-head">
    <h1 class="page-title">${greet}, ${escapeHtml(name)}</h1>
    <p class="page-sub">${BRAND.tagline}</p>
  </div>`));

  const trainingHours = Object.values(state.modelMeta).reduce((s, m) => s + (m.trainSeconds || 0), 0) / 3600;
  const stats = [
    { icon: "voices", val: state.models.length, label: "Voice models" },
    { icon: "music", val: state.covers.length, label: "Covers generated" },
    { icon: "clock", val: trainingHours < 0.1 && trainingHours > 0 ? "<0.1" : trainingHours.toFixed(1), label: "Training hours" },
  ];
  const grid = h(`<div class="stat-grid"></div>`);
  stats.forEach((s) => grid.appendChild(h(`<div class="stat-card glass">
    <div class="s-icon">${icon(s.icon)}</div>
    <div class="s-val">${s.val}</div><div class="s-label">${s.label}</div>
  </div>`)));
  wrap.appendChild(grid);

  wrap.appendChild(h(`<p class="section-label">Quick actions</p>`));
  const quick = h(`<div class="quick-grid"></div>`);
  const qc = (ic, title, sub, route) => {
    const c = h(`<button class="quick-card glass"><div class="q-icon">${icon(ic)}</div>
      <div><div class="q-title">${title}</div><div class="q-sub">${sub}</div></div></button>`);
    c.onclick = () => go(route); return c;
  };
  quick.appendChild(qc("headphones", "New Cover", "Swap vocals on a song", "swap"));
  quick.appendChild(qc("sparkles", "Train a Voice", "Clone a voice from samples", "train"));
  wrap.appendChild(quick);

  wrap.appendChild(h(`<p class="section-label">Recent covers</p>`));
  if (!state.covers.length) {
    wrap.appendChild(emptyState("music", "No covers yet",
      "Drop a song in Vocal Swapper to make your first one.", "New Cover", () => go("swap")));
  } else {
    const list = h(`<div class="col"></div>`);
    state.covers.slice(0, 4).forEach((c) => {
      const meta = state.coverMeta[c.name] || {};
      const card = h(`<div class="card glass">
        <div class="status-head">
          <div><div class="card-title">${escapeHtml(meta.song || "Cover")}</div>
          <div class="card-hint" style="margin:2px 0 0">${escapeHtml(meta.voice || "—")} · ${fmt.date(c.modified * 1000)}</div></div>
        </div></div>`);
      const p = trackPlayer(new Player({ cover: `${API}/api/outputs/${encodeURIComponent(c.name)}`, mini: true }));
      card.appendChild(p.el);
      list.appendChild(card);
    });
    wrap.appendChild(list);
  }
  return wrap;
};

// ============================================================================
// SCREEN: Vocal Swapper
// ============================================================================
screens.swap = () => {
  const wrap = h(`<div></div>`);
  wrap.appendChild(pageHead("Vocal Swapper", "Swap the vocals of any song with a voice you own."));

  const grid = h(`<div class="grid-2"></div>`);
  const left = h(`<div class="col"></div>`);
  const right = h(`<div class="col"></div>`);

  // --- model picker ---
  const modelCard = h(`<div class="card glass">
    <label class="field-label">Voice model</label>
    <div class="row"><div class="grow" id="model-picker"></div>
      <button class="icon-btn" id="refresh-models" title="Rescan voice models">${icon("refresh")}</button></div>
    <div class="row mt-8"><button class="btn small" id="import-model">${icon("upload")} Import .pth / .index…</button></div>
    <p class="card-hint" id="model-hint"></p>
  </div>`);
  left.appendChild(modelCard);

  // --- song dropzone ---
  const songCard = h(`<div class="card glass">
    <label class="field-label">Full song</label>
    <div class="dropzone" id="song-drop">
      <div class="dz-icon">${icon("headphones")}</div>
      <div class="dz-text">Drop a song or <span class="link">browse</span></div>
      <input type="file" accept="audio/*" hidden id="song-input"/>
    </div>
    <div id="song-loaded" class="mt-16"></div>
  </div>`);
  left.appendChild(songCard);

  // --- params ---
  const paramCard = h(`<div class="card glass"><label class="field-label">Parameters</label></div>`);
  paramCard.appendChild(slider({
    id: "pitch", label: "Pitch shift", min: -12, max: 12, step: 1, value: swapWork.pitch,
    fmt: (v) => `${v > 0 ? "+" : ""}${v} st`,
    help: "Semitones. +12 to sing a male song with a female voice; −12 for the reverse.",
    onInput: (v) => (swapWork.pitch = +v),
  }));
  paramCard.appendChild(slider({
    id: "index", label: "Timbre strength", min: 0, max: 1, step: 0.05, value: swapWork.index,
    fmt: (v) => (+v).toFixed(2),
    help: "How strongly to match the model's timbre. Higher = closer to the voice, lower = cleaner.",
    onInput: (v) => (swapWork.index = +v),
  }));
  paramCard.appendChild(slider({
    id: "gain", label: "Vocal level", min: -10, max: 10, step: 0.5, value: swapWork.gain,
    fmt: (v) => `${v > 0 ? "+" : ""}${v} dB`,
    help: "Balance of the swapped vocal against the instrumental.",
    onInput: (v) => (swapWork.gain = +v),
  }));
  left.appendChild(paramCard);

  // --- status + result ---
  const statusCard = h(`<div class="card glass" id="swap-status"></div>`);
  right.appendChild(statusCard);
  const resultCard = h(`<div class="card glass"><label class="field-label">Final mixed cover</label>
    <div id="swap-result"></div></div>`);
  right.appendChild(resultCard);

  grid.appendChild(left); grid.appendChild(right);
  wrap.appendChild(grid);

  // --- sticky generate ---
  const sticky = h(`<div class="sticky-action">
    <div class="tip-wrap"><button class="btn-primary full" id="generate-btn">${icon("sparkles")} Generate Cover</button></div>
  </div>`);
  wrap.appendChild(sticky);

  // wiring (deferred so nodes exist)
  queueMicrotask(() => {
    renderModelPicker($("#model-picker", modelCard));
    $("#refresh-models", modelCard).onclick = async () => {
      await loadModels(); renderModelPicker($("#model-picker", modelCard)); renderModelHint();
      toast({ kind: "info", title: "Voice models refreshed", msg: `${state.models.length} available.` });
    };
    $("#import-model", modelCard).onclick = importModels;
    renderModelHint();

    setupSongDrop($("#song-drop", songCard), $("#song-input", songCard), $("#song-loaded", songCard));
    if (swapWork.songFile) renderSongLoaded($("#song-loaded", songCard));

    renderSwapStatus();
    renderSwapResult();
    $("#generate-btn").onclick = generateCover;
    updateGenerateEnabled();
  });

  return wrap;

  function renderModelHint() {
    const el = $("#model-hint", modelCard);
    el.textContent = state.models.length
      ? `${state.models.length} voice model${state.models.length > 1 ? "s" : ""} available.`
      : "No models yet — import a .pth or train one in Voice Cloning.";
  }
};

function renderModelPicker(host) {
  host.innerHTML = "";
  const current = state.models.find((m) => m.name === swapWork.model);
  const btn = h(`<button class="input" style="display:flex;align-items:center;gap:8px;text-align:left;cursor:pointer">
    <span class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${current ? escapeHtml(current.name) : (state.models.length ? "Select a voice model" : "No models available")}</span>
    ${current ? srChip(current) : ""}
    ${icon("chevron", "", "")}
  </button>`);
  btn.querySelector("svg").style.transform = "rotate(90deg)";
  btn.querySelector("svg").style.flex = "0 0 auto";
  btn.onclick = () => {
    if (!state.models.length) return;
    openMenu(btn, state.models.map((m) => ({
      label: m.name, icon: m.name === swapWork.model ? "check" : "disc",
      fn: () => { swapWork.model = m.name; renderModelPicker(host); updateGenerateEnabled(); },
    })));
  };
  host.appendChild(btn);
}
function srChip(m) {
  const sr = state.modelMeta[m.name]?.sampleRate;
  return sr ? `<span class="chip accent">${(+sr / 1000)}k</span>` : `<span class="chip">${m.has_index ? "index" : "no index"}</span>`;
}

function slider({ id, label, min, max, step, value, fmt: f, help, onInput }) {
  const field = h(`<div class="slider-field">
    <div class="slider-top"><label for="sl-${id}">${label}</label><span class="val" id="val-${id}"></span></div>
    <div class="range-wrap">
      <span class="value-bubble" id="bub-${id}"></span>
      <input type="range" id="sl-${id}" min="${min}" max="${max}" step="${step}" value="${value}"/>
    </div>
    ${help ? `<p class="slider-help">${help}</p>` : ""}
  </div>`);
  const input = $(`#sl-${id}`, field);
  const val = $(`#val-${id}`, field);
  const bub = $(`#bub-${id}`, field);
  const wrap = $(".range-wrap", field);
  const paint = () => {
    const pct = ((input.value - min) / (max - min)) * 100;
    input.style.setProperty("--pct", pct + "%");
    val.textContent = f(input.value);
    bub.textContent = f(input.value);
    bub.style.left = `calc(${pct}% + ${8 - pct * 0.16}px)`;
  };
  input.addEventListener("input", () => { paint(); onInput(input.value); });
  input.addEventListener("pointerdown", () => wrap.classList.add("dragging"));
  const up = () => wrap.classList.remove("dragging");
  input.addEventListener("pointerup", up);
  input.addEventListener("blur", up);
  paint();
  return field;
}

function setupSongDrop(drop, input, loaded) {
  const pick = () => input.click();
  drop.addEventListener("click", pick);
  input.addEventListener("change", () => { if (input.files[0]) setSong(input.files[0]); });
  ["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) setSong(f); });

  function setSong(file) {
    if (swapWork.songUrl) URL.revokeObjectURL(swapWork.songUrl);
    swapWork.songFile = file;
    swapWork.songUrl = URL.createObjectURL(file);
    swapWork.songDur = 0;
    renderSongLoaded(loaded);
    updateGenerateEnabled();
  }
}
function renderSongLoaded(loaded) {
  loaded.innerHTML = "";
  if (!swapWork.songFile) return;
  const row = h(`<div class="file-row">${icon("music")}<span class="nm"></span>
    <span class="dur" id="song-dur">—</span>
    <button class="rm" title="Remove">${icon("x")}</button></div>`);
  $(".nm", row).textContent = swapWork.songFile.name;
  $(".rm", row).onclick = () => {
    if (swapWork.songUrl) URL.revokeObjectURL(swapWork.songUrl);
    swapWork.songFile = null; swapWork.songUrl = ""; loaded.innerHTML = ""; updateGenerateEnabled();
  };
  loaded.appendChild(row);
  const player = trackPlayer(new Player({ cover: swapWork.songUrl, mini: true,
    onDuration: (d) => { swapWork.songDur = d; $("#song-dur", row).textContent = fmt.dur(d); } }));
  loaded.appendChild(player.el);
}

function updateGenerateEnabled() {
  const btn = $("#generate-btn");
  if (!btn) return;
  const ready = swapWork.model && swapWork.songFile && jobs.swap.status !== "running";
  btn.disabled = !ready;
  const tip = btn.closest(".tip-wrap");
  if (!swapWork.model && !swapWork.songFile) tip.dataset.tip = "Pick a voice model and a song first";
  else if (!swapWork.model) tip.dataset.tip = "Pick a voice model first";
  else if (!swapWork.songFile) tip.dataset.tip = "Add a song first";
  else tip.removeAttribute("data-tip");
}

const SWAP_STAGES = ["Separating vocals", "Converting", "Mixing"];
function swapStageIndex(step) {
  const s = (step || "").toLowerCase();
  if (s.includes("mix")) return 2;
  if (s.includes("convert") || s.includes("clon")) return 1;
  if (s.includes("separat") || s.includes("stem")) return 0;
  return -1;
}
function renderSwapStatus() {
  const card = $("#swap-status");
  if (!card) return;
  const j = jobs.swap;
  const chipClass = j.status === "running" ? "busy" : j.status === "error" ? "err" : "ready";
  const chipText = j.status === "running" ? "Working" : j.status === "error" ? "Failed" : j.status === "done" ? "Complete" : "Ready";
  card.innerHTML = `
    <div class="status-head">
      <span class="status-step" id="swap-step">${escapeHtml(j.step || "Ready to generate.")}</span>
      <span class="status-chip ${chipClass}"><span class="dot"></span>${chipText}</span>
    </div>
    <div class="stages" id="swap-stages">${SWAP_STAGES.map((s) => `<div class="stage">${s}</div>`).join("")}</div>
    <div class="progress-track"><div class="progress-fill ${j.status === "running" ? "" : "idle"}" id="swap-fill"></div></div>
    <div class="status-head" style="margin:0"><span class="status-meta" id="swap-note"></span><span class="status-meta" id="swap-elapsed"></span></div>`;
  updateJobProgress("swap"); updateJobMeta("swap");
}
function renderSwapResult() {
  const host = $("#swap-result");
  if (!host) return;
  host.innerHTML = "";
  const j = jobs.swap;
  if (j.status === "done" && j.result?.path) {
    const name = j.result.path.split(/[\\/]/).pop();
    const p = trackPlayer(new Player({
      cover: `${API}/api/outputs/${encodeURIComponent(name)}`,
      original: swapWork.songUrl || null,
    }));
    host.appendChild(p.el);
    const actions = h(`<div class="row mt-16">
      <button class="btn small" id="export-cover">${icon("download")} Export Cover</button>
      <button class="btn small" id="reveal-cover">${icon("folder")} Reveal in Finder</button></div>`);
    $("#export-cover", actions).onclick = () => exportCover(name);
    $("#reveal-cover", actions).onclick = () => window.acs.revealPath(j.result.path);
    host.appendChild(actions);
  } else if (j.status === "error") {
    host.appendChild(h(`<div class="empty" style="padding:24px"><div class="e-text" style="color:var(--err)">${escapeHtml(j.error || "Generation failed.")}</div></div>`));
  } else {
    host.appendChild(h(`<div class="empty" style="padding:28px 20px">
      <div class="e-glyph">${icon("music")}</div>
      <div class="e-text">Your generated cover will appear here with a waveform player.</div></div>`));
  }
}

async function generateCover() {
  if (!swapWork.model || !swapWork.songFile) return;
  const fd = new FormData();
  fd.append("model_name", swapWork.model);
  fd.append("pitch_shift", String(swapWork.pitch));
  fd.append("index_rate", String(swapWork.index));
  fd.append("vocal_gain_db", String(swapWork.gain));
  fd.append("song", swapWork.songFile);

  $("#generate-btn").disabled = true;
  jobs.swap = newJob(); jobs.swap.status = "running"; jobs.swap.step = "Starting…";
  renderSwapStatus(); renderSwapResult();

  try {
    const res = await fetch(`${API}/api/convert`, { method: "POST", body: fd });
    const { job_id } = await res.json();
    runJob("swap", job_id, {
      onDone: async (r) => {
        const name = r.path.split(/[\\/]/).pop();
        state.coverMeta[name] = { song: swapWork.songFile?.name || "Cover", voice: swapWork.model,
          pitch: swapWork.pitch, index: swapWork.index, gain: swapWork.gain,
          duration: swapWork.songDur, date: Date.now() };
        store.set("coverMeta", state.coverMeta);
        await loadCovers();
        if (state.route === "swap") { renderSwapStatus(); renderSwapResult(); updateGenerateEnabled(); }
        toast({ kind: "ok", title: "Cover ready", msg: name, action: { label: "Reveal in Finder", fn: () => window.acs.revealPath(r.path) } });
      },
      onError: (msg) => {
        if (state.route === "swap") { renderSwapStatus(); renderSwapResult(); updateGenerateEnabled(); }
        toast({ kind: "err", title: "Generation failed", msg });
      },
    });
    if (state.route === "swap") renderSwapStatus();
  } catch (err) {
    jobs.swap.status = "error"; jobs.swap.error = String(err);
    renderSwapStatus(); renderSwapResult(); updateGenerateEnabled();
    toast({ kind: "err", title: "Could not start", msg: String(err) });
  }
}

async function exportCover(name) {
  const dest = await window.acs.saveCover(name);
  if (!dest) return;
  await window.acs.downloadTo(`${API}/api/outputs/${encodeURIComponent(name)}`, dest);
  window.acs.revealPath(dest);
  toast({ kind: "ok", title: "Cover exported" });
}

async function importModels() {
  const paths = await window.acs.pickModelFiles();
  if (!paths.length) return;
  const res = await fetch(`${API}/api/models/import`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }),
  });
  const data = await res.json();
  await loadModels();
  if (state.route === "swap") { renderModelPicker($("#model-picker")); }
  toast({ kind: "ok", title: "Model files imported",
    msg: `${data.copied.length} copied${data.skipped.length ? `, ${data.skipped.length} skipped` : ""}.` });
}

// ============================================================================
// SCREEN: Voice Cloning (training)
// ============================================================================
screens.train = () => {
  const wrap = h(`<div></div>`);
  wrap.appendChild(pageHead("Voice Cloning", "Train an RVC / Applio voice model from clean vocal samples."));

  // dismissible banners
  if (!store.get("dismiss.tips", false)) wrap.appendChild(banner("info", "tips",
    `<b>Dataset tips:</b> 10–30 minutes of clean, dry vocals — no reverb, no background music, one speaker. Singing beats read speech for song covers. Use consented voices only.`));
  const hw = state.health?.hardware;
  if (hw?.training_warning && !store.get("dismiss.cpuwarn", false))
    wrap.appendChild(banner("warn", "cpuwarn", `<b>Heads up:</b> ${escapeHtml(hw.training_warning)}`));

  const grid = h(`<div class="grid-2"></div>`);
  const left = h(`<div class="col"></div>`);
  const right = h(`<div class="col"></div>`);

  const inputCard = h(`<div class="card glass">
    <label class="field-label">Voice samples</label>
    <div class="dropzone" id="samples-drop">
      <div class="dz-icon">${icon("sparkles")}</div>
      <div class="dz-text">Drop voice clips or <span class="link">browse</span></div>
      <input type="file" accept="audio/*" multiple hidden id="samples-input"/>
    </div>
    <div class="file-list" id="samples-list"></div>
    <div class="row mt-16"><input class="input" id="dataset-dir" placeholder="…or a folder path"/>
      <button class="icon-btn" id="folder-btn" title="Choose folder">${icon("folder")}</button></div>
  </div>`);
  left.appendChild(inputCard);

  const cfgCard = h(`<div class="card glass">
    <div class="row"><div class="grow"><label class="field-label">Model name</label>
      <input class="input" id="train-name" placeholder="my_voice"/></div>
      <div style="flex:0 0 130px"><label class="field-label">Sample rate</label>
      <select class="input" id="train-sr"></select></div></div>
  </div>`);
  left.appendChild(cfgCard);

  const epochCard = h(`<div class="card glass"></div>`);
  epochCard.appendChild(slider({
    id: "epochs", label: "Epochs", min: 50, max: 1000, step: 50, value: trainWork.epochs,
    fmt: (v) => `${v}`,
    help: "",
    onInput: (v) => { trainWork.epochs = +v; updateEta(); },
  }));
  epochCard.appendChild(h(`<p class="slider-help" id="eta-hint"></p>`));
  left.appendChild(epochCard);

  // console
  const consoleCard = h(`<div class="card glass" id="train-status"></div>`);
  right.appendChild(consoleCard);

  grid.appendChild(left); grid.appendChild(right);
  wrap.appendChild(grid);

  const sticky = h(`<div class="sticky-action">
    <div class="tip-wrap"><button class="btn-primary full" id="train-btn">${icon("sparkles")} Train Voice Model</button></div>
  </div>`);
  wrap.appendChild(sticky);
  wrap.appendChild(h(`<p class="card-hint" style="text-align:center;margin-top:12px">
    First training run needs Python 3.11+ and internet once to fetch the Applio trainer + base models (~2 GB); afterwards it runs offline.</p>`));

  queueMicrotask(() => {
    // sample rate options
    const sr = $("#train-sr", cfgCard);
    (state.health?.sample_rates || ["40000"]).forEach((v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = `${v} Hz`; sr.appendChild(o);
    });
    sr.value = trainWork.sampleRate || state.settings.defaultSampleRate || "40000";
    sr.onchange = () => (trainWork.sampleRate = sr.value);

    $("#train-name", cfgCard).value = trainWork.name;
    $("#train-name", cfgCard).oninput = (e) => (trainWork.name = e.target.value);

    $("#dataset-dir", inputCard).value = trainWork.datasetDir;
    $("#dataset-dir", inputCard).oninput = (e) => (trainWork.datasetDir = e.target.value);
    $("#folder-btn", inputCard).onclick = async () => {
      const dir = await window.acs.pickFolder();
      if (dir) { trainWork.datasetDir = dir; $("#dataset-dir", inputCard).value = dir; updateTrainEnabled(); }
    };
    setupSamplesDrop($("#samples-drop", inputCard), $("#samples-input", inputCard), $("#samples-list", inputCard));
    renderSamplesList($("#samples-list", inputCard));

    renderTrainStatus();
    $("#train-btn").onclick = trainVoice;
    updateEta(); updateTrainEnabled();
  });

  return wrap;

  function updateEta() {
    const hint = $("#eta-hint");
    if (!hint) return;
    const tier = state.health?.hardware?.tier;
    const perEpoch = tier === "gpu" ? 1.2 : 11; // rough seconds/epoch estimate for the hint
    const mins = Math.round((trainWork.epochs * perEpoch) / 60);
    hint.textContent = `Estimated training time: ~${mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} hr`} on ${state.health?.hardware?.label || "this device"} (rough).`;
  }
};

function setupSamplesDrop(drop, input, list) {
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => addFiles(input.files));
  ["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (ev) => addFiles(ev.dataTransfer.files));
  function addFiles(files) {
    for (const f of files) if (f.type.startsWith("audio") || /\.(wav|mp3|flac|m4a|ogg)$/i.test(f.name)) trainWork.files.push(f);
    renderSamplesList(list); updateTrainEnabled();
  }
}
function renderSamplesList(list) {
  list.innerHTML = "";
  trainWork.files.forEach((f, i) => {
    const row = h(`<div class="file-row">${icon("music")}<span class="nm"></span>
      <span class="dur">${fmt.bytes(f.size)}</span>
      <button class="rm" title="Remove">${icon("x")}</button></div>`);
    $(".nm", row).textContent = f.name;
    $(".rm", row).onclick = () => { trainWork.files.splice(i, 1); renderSamplesList(list); updateTrainEnabled(); };
    list.appendChild(row);
  });
}
function updateTrainEnabled() {
  const btn = $("#train-btn");
  if (!btn) return;
  const running = jobs.train.status === "running";
  const ready = (trainWork.files.length || trainWork.datasetDir.trim()) && !running;
  btn.disabled = !ready;
  const tip = btn.closest(".tip-wrap");
  if (running) { btn.innerHTML = `${icon("sparkles")} Training…`; tip.dataset.tip = "A training job is already running"; }
  else { btn.innerHTML = `${icon("sparkles")} Train Voice Model`;
    if (!ready) tip.dataset.tip = "Add voice samples or a folder path first"; else tip.removeAttribute("data-tip"); }
}

function renderTrainStatus() {
  const card = $("#train-status");
  if (!card) return;
  const j = jobs.train;
  const chipClass = j.status === "running" ? "busy" : j.status === "error" ? "err" : "ready";
  const chipText = j.status === "running" ? "Training" : j.status === "error" ? "Failed" : j.status === "done" ? "Complete" : "Idle";
  card.innerHTML = `
    <div class="status-head">
      <span class="status-step" id="train-step">${escapeHtml(j.step || "Ready to train.")}</span>
      <span class="status-chip ${chipClass}"><span class="dot"></span>${chipText}</span>
    </div>
    <div class="progress-track"><div class="progress-fill ${j.status === "running" ? "" : "idle"}" id="train-fill"></div></div>
    <div class="status-head"><span class="status-meta" id="train-note"></span><span class="status-meta" id="train-elapsed"></span></div>
    <div class="log-head">
      <span class="section-label" style="margin:0">Training log</span>
      <label class="follow-toggle on" id="follow-toggle"><span class="switch"></span>Follow</label>
    </div>
    <pre class="logbox" id="train-log"></pre>`;
  const logEl = $("#train-log", card);
  logEl.textContent = j.log.join("\n") || "Training progress will appear here.";
  let follow = true;
  $("#follow-toggle", card).onclick = () => { follow = !follow; $("#follow-toggle", card).classList.toggle("on", follow); if (follow) logEl.scrollTop = logEl.scrollHeight; };
  logEl.dataset.follow = "1";
  logEl.addEventListener("scroll", () => {}); // follow handled in appendLog
  updateJobProgress("train"); updateJobMeta("train");
  if (follow) logEl.scrollTop = logEl.scrollHeight;
}

async function trainVoice() {
  if (!trainWork.files.length && !trainWork.datasetDir.trim()) return;
  const fd = new FormData();
  fd.append("model_name", trainWork.name || "my_voice");
  fd.append("sample_rate", trainWork.sampleRate);
  fd.append("epochs", String(trainWork.epochs));
  fd.append("dataset_dir", trainWork.datasetDir.trim());
  for (const f of trainWork.files) fd.append("samples", f);

  jobs.train = newJob(); jobs.train.status = "running"; jobs.train.step = "Starting…";
  renderTrainStatus(); updateTrainEnabled();

  try {
    const res = await fetch(`${API}/api/train`, { method: "POST", body: fd });
    if (res.status === 409) {
      jobs.train.status = "error"; jobs.train.error = "A training job is already running.";
      renderTrainStatus(); updateTrainEnabled();
      toast({ kind: "err", title: "Already running", msg: "A training job is already running." });
      return;
    }
    const { job_id } = await res.json();
    const modelName = trainWork.name || "my_voice";
    const sr = trainWork.sampleRate, epochs = trainWork.epochs;
    runJob("train", job_id, {
      onDone: async (r) => {
        const name = r.model_name || modelName;
        state.modelMeta[name] = { ...(state.modelMeta[name] || {}), sampleRate: sr, epochs,
          dateTrained: Date.now(), trainSeconds: jobs.train.elapsed };
        store.set("modelMeta", state.modelMeta);
        await loadModels();
        if (state.route === "train") { renderTrainStatus(); updateTrainEnabled(); }
        toast({ kind: "ok", title: `Voice "${name}" trained`, action: { label: "Use in Vocal Swapper", fn: () => { swapWork.model = name; go("swap"); } } });
      },
      onError: (msg) => {
        if (state.route === "train") { renderTrainStatus(); updateTrainEnabled(); }
        toast({ kind: "err", title: "Training failed", msg });
      },
    });
    if (state.route === "train") renderTrainStatus();
  } catch (err) {
    jobs.train.status = "error"; jobs.train.error = String(err);
    renderTrainStatus(); updateTrainEnabled();
    toast({ kind: "err", title: "Could not start training", msg: String(err) });
  }
}

// ---- shared job DOM updaters ----
function updateJobProgress(kind) {
  const fill = $(`#${kind}-fill`);
  const step = $(`#${kind}-step`);
  const j = jobs[kind];
  if (fill) { fill.style.width = `${Math.round(j.progress * 100)}%`; fill.classList.toggle("idle", j.status !== "running"); }
  if (step) step.textContent = j.step || (j.status === "done" ? "Complete." : j.status === "error" ? "Failed." : "Ready.");
  if (kind === "swap") {
    const idx = swapStageIndex(j.step);
    $$("#swap-stages .stage").forEach((s, i) => {
      s.classList.toggle("active", i === idx && j.status === "running");
      s.classList.toggle("done", (j.status === "done") || (idx > i));
    });
  }
}
function updateJobMeta(kind) {
  const j = jobs[kind];
  const note = $(`#${kind}-note`); const el = $(`#${kind}-elapsed`);
  if (note) note.textContent = j.note || "";
  if (el) {
    let s = `${fmt.clock(j.elapsed)} elapsed`;
    if (j.status === "running" && j.progress > 0.02) {
      const eta = j.elapsed * (1 - j.progress) / j.progress;
      s += ` · ~${fmt.clock(eta)} left`;
    }
    el.textContent = s;
  }
}
function appendLog(kind, line) {
  const logEl = $(`#${kind}-log`);
  if (!logEl) return;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const follow = $(`#follow-toggle`)?.classList.contains("on");
  logEl.textContent = jobs[kind].log.join("\n");
  if (follow !== false && atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ============================================================================
// SCREEN: My Voices
// ============================================================================
screens.voices = () => {
  const wrap = h(`<div></div>`);
  const head = pageHead("My Voices", "Your trained and imported voice models.");
  const refresh = h(`<button class="btn small">${icon("refresh")} Refresh</button>`);
  refresh.onclick = async () => { await loadModels(); go("voices"); };
  head.querySelector(".page-head").appendChild(refresh);
  head.querySelector(".page-head").style.cssText = "display:flex;justify-content:space-between;align-items:flex-end;gap:16px";
  wrap.appendChild(head);

  if (!state.models.length) {
    wrap.appendChild(emptyState("voices", "No voice models yet",
      "Train a voice in Voice Cloning, or import a .pth in Vocal Swapper.", "Train a Voice", () => go("train")));
    return wrap;
  }
  const grid = h(`<div class="voice-grid"></div>`);
  state.models.forEach((m) => grid.appendChild(voiceCard(m)));
  wrap.appendChild(grid);
  return wrap;
};
function voiceCard(m) {
  const meta = state.modelMeta[m.name] || {};
  const card = h(`<div class="voice-card glass">
    <div class="vc-head">
      <span class="avatar" style="border-radius:12px;flex-basis:38px;width:38px;height:38px">${icon("disc")}</span>
      <div class="vc-name">${escapeHtml(m.name)}</div>
      <button class="icon-btn" style="width:30px;height:30px;flex-basis:30px" title="More">${icon("dots")}</button>
    </div>
    <div class="vc-meta">
      <span class="chip accent">${meta.sampleRate ? (+meta.sampleRate / 1000) + "k Hz" : (m.has_index ? "has index" : "no index")}</span>
      ${meta.epochs ? `<span class="chip">${meta.epochs} epochs</span>` : ""}
      <span class="chip">${fmt.bytes(m.size)}</span>
    </div>
    <div class="card-hint" style="margin:0">${meta.dateTrained ? "Trained " + fmt.date(meta.dateTrained) : "Added " + fmt.date(m.modified * 1000)}</div>
    <div class="vc-actions"></div>
  </div>`);
  const actions = $(".vc-actions", card);
  const useBtn = h(`<button class="btn small">${icon("headphones")} Use</button>`);
  useBtn.onclick = () => { swapWork.model = m.name; go("swap"); };
  actions.appendChild(useBtn);
  if (meta.testPhrase) {
    const p = trackPlayer(new Player({ cover: meta.testPhrase, mini: true }));
    card.insertBefore(p.el, actions);
  }
  $(".icon-btn", card).onclick = (e) => openMenu(e.currentTarget, [
    { label: "Rename", icon: "pencil", fn: () => renameModel(m) },
    { label: "Export .pth", icon: "download", fn: () => exportModel(m) },
    { sep: true },
    { label: "Delete", icon: "trash", danger: true, fn: () => deleteModel(m) },
  ]);
  return card;
}
function renameModel(m) {
  const modal = h(`<div class="modal"><h3>Rename voice model</h3>
    <p>Renames the model file and its paired index on disk.</p>
    <label class="field-label">New name</label>
    <input class="input" id="rn-input"/>
    <div class="auth-err" id="rn-err"></div>
    <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button>
    <button class="btn-primary" data-ok style="padding:9px 16px">Rename model</button></div></div>`);
  $("#rn-input", modal).value = m.name;
  $("[data-cancel]", modal).onclick = closeModal;
  $("[data-ok]", modal).onclick = async () => {
    const nv = $("#rn-input", modal).value.trim();
    if (!nv || nv === m.name) return closeModal();
    try {
      const res = await fetch(`${API}/api/models/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ old: m.name, new: nv }) });
      if (!res.ok) throw new Error((await res.json()).detail || "Rename failed");
      const data = await res.json();
      if (state.modelMeta[m.name]) { state.modelMeta[data.name] = state.modelMeta[m.name]; delete state.modelMeta[m.name]; store.set("modelMeta", state.modelMeta); }
      if (swapWork.model === m.name) swapWork.model = data.name;
      closeModal(); await loadModels(); go("voices");
      toast({ kind: "ok", title: "Model renamed", msg: `${m.name} → ${data.name}` });
    } catch (err) { $("#rn-err", modal).textContent = String(err.message || err); }
  };
  openModal(modal);
}
async function exportModel(m) {
  const dest = await window.acs.savePath({ title: "Export voice model", defaultName: `${m.name}.pth`, extensions: ["pth"] });
  if (!dest) return;
  await window.acs.downloadTo(`${API}/api/models/file/${encodeURIComponent(m.name)}`, dest);
  window.acs.revealPath(dest);
  toast({ kind: "ok", title: "Model exported", msg: `${m.name}.pth` });
}
function deleteModel(m) {
  confirmDialog({
    title: `Delete "${m.name}"?`, danger: true, confirmLabel: "Delete model",
    message: "This permanently removes the model's .pth and paired index files from disk. This cannot be undone.",
    onConfirm: async () => {
      try {
        const res = await fetch(`${API}/api/models/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: m.name }) });
        if (!res.ok) throw new Error((await res.json()).detail || "Delete failed");
        delete state.modelMeta[m.name]; store.set("modelMeta", state.modelMeta);
        if (swapWork.model === m.name) swapWork.model = "";
        await loadModels(); go("voices");
        toast({ kind: "ok", title: "Model deleted", msg: m.name });
      } catch (err) { toast({ kind: "err", title: "Could not delete", msg: String(err.message || err) }); }
    },
  });
}

// ============================================================================
// SCREEN: Library
// ============================================================================
screens.library = () => {
  const wrap = h(`<div></div>`);
  const head = pageHead("Library", "Every cover you've generated.");
  const refresh = h(`<button class="btn small">${icon("refresh")} Refresh</button>`);
  refresh.onclick = async () => { await loadCovers(); go("library"); };
  head.querySelector(".page-head").appendChild(refresh);
  head.querySelector(".page-head").style.cssText = "display:flex;justify-content:space-between;align-items:flex-end;gap:16px";
  wrap.appendChild(head);

  if (!state.covers.length) {
    wrap.appendChild(emptyState("music", "No covers yet",
      "Generate your first cover in Vocal Swapper and it'll show up here.", "New Cover", () => go("swap")));
    return wrap;
  }
  const table = h(`<div class="data-table glass">
    <div class="data-row head"><div>Song</div><div class="hide-sm">Voice</div><div class="hide-sm">Date</div><div style="text-align:right">Actions</div></div>
  </div>`);
  state.covers.forEach((c) => {
    const meta = state.coverMeta[c.name] || {};
    const row = h(`<div class="data-row">
      <div class="primary">${escapeHtml(meta.song || c.name)}</div>
      <div class="cell hide-sm">${escapeHtml(meta.voice || "—")}</div>
      <div class="cell hide-sm">${fmt.date(c.modified * 1000)}</div>
      <div class="actions">
        <button class="icon-btn" data-play title="Play" style="width:30px;height:30px;flex-basis:30px">${icon("play")}</button>
        <button class="icon-btn" data-export title="Export" style="width:30px;height:30px;flex-basis:30px">${icon("download")}</button>
        <button class="icon-btn" data-del title="Delete" style="width:30px;height:30px;flex-basis:30px">${icon("trash")}</button>
      </div></div>`);
    const url = `${API}/api/outputs/${encodeURIComponent(c.name)}`;
    let expanded = null;
    $("[data-play]", row).onclick = () => {
      if (expanded) { expanded.remove(); expanded = null; $("[data-play]", row).innerHTML = icon("play"); return; }
      const holder = h(`<div style="padding:0 18px 14px"></div>`);
      const p = trackPlayer(new Player({ cover: url }));
      holder.appendChild(p.el);
      row.after(holder); expanded = holder;
      $("[data-play]", row).innerHTML = icon("pause");
      p.toggle();
    };
    $("[data-export]", row).onclick = () => exportCover(c.name);
    $("[data-del]", row).onclick = () => confirmDialog({
      title: "Delete cover?", danger: true, confirmLabel: "Delete cover",
      message: `Permanently delete "${meta.song || c.name}"? This cannot be undone.`,
      onConfirm: async () => {
        try {
          const res = await fetch(`${API}/api/outputs/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: c.name }) });
          if (!res.ok) throw new Error("Delete failed");
          delete state.coverMeta[c.name]; store.set("coverMeta", state.coverMeta);
          await loadCovers(); go("library");
          toast({ kind: "ok", title: "Cover deleted" });
        } catch (err) { toast({ kind: "err", title: "Could not delete", msg: String(err.message || err) }); }
      },
    });
    table.appendChild(row);
  });
  wrap.appendChild(table);
  return wrap;
};

// ============================================================================
// SCREEN: Settings
// ============================================================================
screens.settings = () => {
  const wrap = h(`<div></div>`);
  wrap.appendChild(pageHead("Settings", "Profile, appearance, defaults, and storage."));

  // Profile
  if (!state.guest) {
    const prof = section("Profile");
    const card = h(`<div class="card glass">
      <div class="row" style="gap:16px;align-items:center">
        <span class="avatar" id="set-avatar" style="width:56px;height:56px;flex-basis:56px;font-size:1.2rem"></span>
        <div class="grow"><label class="field-label">Name</label><input class="input" id="set-name"/></div>
      </div>
      <div class="row mt-16">
        <button class="btn small" id="upload-avatar">${icon("upload")} Change photo</button>
        <button class="btn small ghost" id="clear-avatar">Remove photo</button>
        <button class="btn-primary" id="save-profile" style="margin-left:auto;padding:9px 16px">Save profile</button>
      </div>
      <input type="file" accept="image/*" hidden id="avatar-input"/>
    </div>`);
    prof.appendChild(card);
    wrap.appendChild(prof);
    queueMicrotask(() => {
      setAvatar($("#set-avatar", card), state.user);
      $("#set-name", card).value = state.user.name;
      $("#upload-avatar", card).onclick = () => $("#avatar-input", card).click();
      $("#avatar-input", card).onchange = (e) => {
        const f = e.target.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { state.user.avatar = rd.result; setAvatar($("#set-avatar", card), state.user); };
        rd.readAsDataURL(f);
      };
      $("#clear-avatar", card).onclick = () => { state.user.avatar = null; setAvatar($("#set-avatar", card), state.user); };
      $("#save-profile", card).onclick = () => {
        state.user.name = $("#set-name", card).value.trim() || state.user.name;
        const users = store.get("users", []);
        const u = users.find((x) => x.email === state.user.email);
        if (u) { u.name = state.user.name; u.avatar = state.user.avatar; store.set("users", users); }
        renderSidebar(); markActiveNav();
        toast({ kind: "ok", title: "Profile saved" });
      };
    });
  }

  // Appearance
  const appear = section("Appearance");
  const themeCard = h(`<div class="card glass"><label class="field-label">Theme</label>
    <div class="row" id="theme-seg" style="gap:8px"></div></div>`);
  [["system", "monitor", "System"], ["light", "sun", "Light"], ["dark", "moon", "Dark"]].forEach(([val, ic, lbl]) => {
    const b = h(`<button class="btn ${state.settings.theme === val ? "" : "ghost"}" style="flex:1;justify-content:center">${icon(ic)} ${lbl}</button>`);
    b.onclick = () => { setTheme(val); go("settings"); renderSidebar(); };
    $("#theme-seg", themeCard).appendChild(b);
  });
  appear.appendChild(themeCard);
  wrap.appendChild(appear);

  // Defaults
  const def = section("Defaults");
  const defCard = h(`<div class="card glass">
    <div class="row"><div class="grow"><label class="field-label">Default sample rate</label>
      <select class="input" id="def-sr"></select></div>
      <div class="grow"><label class="field-label">Default epochs: <span id="def-ep-val">${state.settings.defaultEpochs}</span></label>
      <input type="range" id="def-ep" min="50" max="1000" step="50" value="${state.settings.defaultEpochs}"/></div></div>
    <div class="row mt-16"><div class="grow"><label class="field-label">Default export folder</label>
      <input class="input" id="def-export" placeholder="Ask each time" value="${escapeHtml(state.settings.exportDir || "")}"/></div>
      <button class="icon-btn" id="def-folder" style="align-self:flex-end">${icon("folder")}</button></div>
  </div>`);
  def.appendChild(defCard);
  wrap.appendChild(def);
  queueMicrotask(() => {
    const sr = $("#def-sr", defCard);
    (state.health?.sample_rates || ["40000"]).forEach((v) => { const o = document.createElement("option"); o.value = v; o.textContent = `${v} Hz`; sr.appendChild(o); });
    sr.value = state.settings.defaultSampleRate;
    sr.onchange = () => { state.settings.defaultSampleRate = sr.value; store.set("settings", state.settings); trainWork.sampleRate = sr.value; };
    const ep = $("#def-ep", defCard);
    ep.oninput = () => { $("#def-ep-val", defCard).textContent = ep.value; state.settings.defaultEpochs = +ep.value; store.set("settings", state.settings); trainWork.epochs = +ep.value; };
    $("#def-folder", defCard).onclick = async () => { const d = await window.acs.pickFolder(); if (d) { state.settings.exportDir = d; $("#def-export", defCard).value = d; store.set("settings", state.settings); } };
    $("#def-export", defCard).oninput = (e) => { state.settings.exportDir = e.target.value; store.set("settings", state.settings); };
  });

  // Storage + compute
  const storageSec = section("Storage & compute");
  const modelBytes = state.models.reduce((s, m) => s + (m.size || 0), 0);
  const coverBytes = state.covers.reduce((s, c) => s + (c.size || 0), 0);
  const hw = state.health?.hardware;
  const storeCard = h(`<div class="card glass">
    <div class="row" style="justify-content:space-between"><span class="card-hint" style="margin:0">Compute device</span>
      <span class="chip accent">${icon("cpu")} ${hw ? escapeHtml(hw.label) : "offline"}</span></div>
    <div class="row mt-16" style="justify-content:space-between"><span class="card-hint" style="margin:0">Voice models</span><span>${fmt.bytes(modelBytes)}</span></div>
    <div class="row mt-8" style="justify-content:space-between"><span class="card-hint" style="margin:0">Generated covers (${state.covers.length})</span><span>${fmt.bytes(coverBytes)}</span></div>
    <div class="row mt-8" style="justify-content:space-between"><span class="card-hint" style="margin:0">Storage location</span><span class="cell" style="max-width:280px">${escapeHtml(state.health?.data_dir || "—")}</span></div>
    <div class="row mt-16"><button class="btn small danger" id="clear-cache" ${state.covers.length ? "" : "disabled"}>${icon("trash")} Clear generated covers</button></div>
  </div>`);
  storageSec.appendChild(storeCard);
  wrap.appendChild(storageSec);
  queueMicrotask(() => {
    const btn = $("#clear-cache", storeCard);
    if (btn) btn.onclick = () => confirmDialog({
      title: "Clear all generated covers?", danger: true, confirmLabel: "Delete all",
      message: `This permanently deletes all ${state.covers.length} generated covers from disk.`,
      onConfirm: async () => {
        for (const c of state.covers) {
          try { await fetch(`${API}/api/outputs/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: c.name }) }); } catch {}
        }
        state.coverMeta = {}; store.set("coverMeta", {});
        await loadCovers(); go("settings");
        toast({ kind: "ok", title: "Covers cleared" });
      },
    });
  });

  // About
  const about = section("About");
  about.appendChild(h(`<div class="card glass" style="text-align:center;padding:28px">
    <div class="glyph" style="height:30px;justify-content:center;margin-bottom:12px"><i></i><i></i><i></i><i></i><i></i></div>
    <div style="font-family:var(--font-display);font-size:1.4rem;font-weight:700;color:var(--text-strong)">${BRAND.name} <span style="color:var(--faint);font-weight:500;font-size:0.9rem">${BRAND.version}</span></div>
    <div class="card-hint" style="margin-top:4px">${BRAND.tagline}</div>
    <div class="card-hint" style="margin-top:10px">Fully local AI song covers — your audio never leaves this machine.</div>
  </div>`));
  wrap.appendChild(about);

  return wrap;
};

// ============================================================================
// Small shared view helpers
// ============================================================================
function pageHead(title, sub) {
  return h(`<div><div class="page-head"><div><h1 class="page-title">${title}</h1>
    <p class="page-sub">${sub}</p></div></div></div>`);
}
function section(label) {
  const s = h(`<div style="margin-bottom:28px"></div>`);
  s.appendChild(h(`<p class="section-label">${label}</p>`));
  return s;
}
function banner(kind, key, html) {
  const b = h(`<div class="banner ${kind}"><span class="b-icon">${icon(kind === "warn" ? "alert" : "info")}</span>
    <div>${html}</div><button class="b-close" title="Dismiss">${icon("x")}</button></div>`);
  $(".b-close", b).onclick = () => { store.set("dismiss." + key, true); b.remove(); };
  return b;
}
function emptyState(ic, title, text, actionLabel, actionFn) {
  const e = h(`<div class="empty glass" style="border-radius:var(--r-card)">
    <div class="e-glyph">${icon(ic)}</div>
    <div class="e-title">${title}</div>
    <div class="e-text">${text}</div>
    ${actionLabel ? `<button class="btn-primary" style="padding:10px 18px">${icon("plus")} ${actionLabel}</button>` : ""}
  </div>`);
  if (actionLabel) $(".btn-primary", e).onclick = actionFn;
  return e;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================================
// BOOT
// ============================================================================
async function boot() {
  applyTheme();
  const cfg = await window.acs.getConfig();
  API = `http://127.0.0.1:${cfg.port}`;

  try { state.health = await api.health(); } catch { state.health = null; }
  await loadModels();
  await loadCovers();

  // restore session
  const session = store.get("session", null);
  if (session === "__guest__") { state.guest = true; showApp(); }
  else if (session) {
    const user = store.get("users", []).find((u) => u.email === session);
    if (user) { state.user = { email: user.email, name: user.name, avatar: user.avatar || null }; showApp(); }
    else showAuth();
  } else showAuth();

  window.addEventListener("resize", () => { moveLozenge(); if (innerWidth < 800) $("#app").classList.add("rail"); });
  if (innerWidth < 800) $("#app").classList.add("rail");
}
boot();
