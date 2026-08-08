/**
 * Formatting helpers.
 *
 * Everything here feeds a `.tabular` readout, so the shapes are fixed-width by
 * construction — "0:42 / 3:17" never reflows as the seconds tick (§4).
 */

/** 42 -> "0:42", 197 -> "3:17", 3730 -> "1:02:10" */
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "0:42 / 3:17" */
export const position = (current, total) => `${duration(current)} / ${duration(total)}`;

/** 64500000 -> "64.5 MB". Decimal units, matching Finder. */
export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1000) return `${v} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let i = -1;
  let x = v;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

/** Unix seconds -> "17 Jul 2026" */
export function date(unixSeconds) {
  const d = new Date((Number(unixSeconds) || 0) * 1000);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Sticky list headers: Today / Yesterday / This Week / July 2026 (Prompt 2). */
export function dateGroup(unixSeconds, now = new Date()) {
  const d = new Date((Number(unixSeconds) || 0) * 1000);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This Week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Derive a human title from a source filename (§10: never show a raw generated
 * filename as a title). Prompt 2 replaces this with real stored metadata.
 */
export function titleFromFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  if (/^final_cover_\d{8}_\d{6}$/.test(base)) return null;  // no real title available
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "final_cover_20260717_024930.mp3" -> unix seconds, or null. */
export function timestampFromFilename(filename) {
  const m = String(filename || "").match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000);
}

/** "3 covers" / "1 cover" */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
