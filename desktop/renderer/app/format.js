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

/** Unix seconds -> "17 Jul, 02:49" */
export function dateTime(unixSeconds) {
  const d = new Date((Number(unixSeconds) || 0) * 1000);
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${time}`;
}

/** Clean a source filename into a title: strip extension, separators, Title Case. */
export function cleanFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  if (!base) return "";
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Cover title (§10: never show a raw generated filename).
 *
 *   sourceFileName present -> that filename, cleaned up
 *   otherwise              -> "Cover — 17 Jul, 02:49"
 *
 * The time is included because several covers routinely share a date, and a
 * date alone would make them indistinguishable in the list.
 */
export function coverTitle({ sourceFileName, when }) {
  const derived = sourceFileName ? cleanFilename(sourceFileName) : "";
  return derived || `Cover — ${dateTime(when)}`;
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
