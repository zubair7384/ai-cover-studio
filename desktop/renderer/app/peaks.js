/**
 * Waveform peaks — three-tier cache.
 *
 *   memory  →  disk (via IPC)  →  decode the audio
 *
 * Decoding is the expensive tier: a few hundred milliseconds and several MB per
 * track. It happens at most once per file version, and at most CONCURRENCY at a
 * time so a 22-row library does not stall the UI thread with parallel decodes.
 */

const BUCKETS = 256;      // enough for a 40px thumbnail and the player scrubber
const CONCURRENCY = 3;

const memory = new Map();     // key -> { peaks, duration }
const inflight = new Map();   // key -> Promise

let ctx = null;
const audioContext = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

/* ---- a small concurrency-limited queue ---------------------------------- */

let active = 0;
const waiting = [];

function schedule(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && waiting.length) {
    const { task, resolve, reject } = waiting.shift();
    active++;
    task().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

/* ---- peak extraction ---------------------------------------------------- */

/** Bucket-max over one channel: peak-preserving, unlike averaging. */
function extract(buffer, buckets = BUCKETS) {
  const ch = buffer.getChannelData(0);
  const size = Math.floor(ch.length / buckets) || 1;
  const out = new Array(buckets);
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * size;
    for (let j = start; j < start + size && j < ch.length; j++) {
      const v = Math.abs(ch[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalise and round — keeps the cached JSON small.
  return max > 0 ? out.map((v) => Math.round((v / max) * 100) / 100) : out;
}

/**
 * A cache key that changes when the file does, so a regenerated cover
 * re-decodes instead of showing a stale shape.
 */
export const cacheKey = (item) => `${item.id}:${item.size}:${Math.round(item.when)}`;

/**
 * @param {{id:string, size:number, when:number, src?:string, read?:Function}} item
 *   `src` is fetched; `read` is an alternative byte source for files that live
 *   outside the app:// origin (a chosen song, say) and arrive over IPC.
 * @returns {Promise<{peaks:number[], duration:number}>}
 */
export function getPeaks(item) {
  const key = cacheKey(item);

  if (memory.has(key)) return Promise.resolve(memory.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const cached = await window.vocalis.peaksGet(key).catch(() => null);
    if (cached?.peaks?.length) {
      memory.set(key, cached);
      return cached;
    }

    const value = await schedule(async () => {
      const bytes = item.read
        ? await item.read()
        : await (await fetch(item.src)).arrayBuffer();
      const audio = await audioContext().decodeAudioData(bytes);
      return { peaks: extract(audio), duration: audio.duration };
    });

    memory.set(key, value);
    window.vocalis.peaksPut(key, value).catch(() => { /* cache write is best-effort */ });
    return value;
  })();

  inflight.set(key, job);
  job.finally(() => inflight.delete(key));
  return job;
}

/** Synchronous peek — lets a row render instantly when the data is already in. */
export const peekPeaks = (item) => memory.get(cacheKey(item)) || null;
