/**
 * One-time cover-metadata migration, run at startup.
 *
 * Two sources are merged and handed to the backend, which owns the manifest:
 *
 *   1. This origin's own `vocalis.coverMeta`, if any.
 *   2. The pre-redesign `coverMeta` from the retired `file://` origin, which
 *      this renderer cannot read (localStorage is per-origin) and which the
 *      main process therefore supplies from an extracted copy.
 *
 * The backend migration is idempotent, so a repeat run cannot downgrade a
 * recovered record — the local flag is an optimisation, not a correctness
 * guarantee.
 */

import { readPersisted, persist } from "./store.js";
import { origin } from "./api.js";

const FLAG = "coverMetaMigrated";

export async function migrateCoverMetadata() {
  if (readPersisted(FLAG, false)) return null;

  const mine = readPersisted("coverMeta", {}) || {};
  const legacy = await window.vocalis.legacyCoverMeta?.().catch(() => ({})) || {};
  const coverMeta = { ...legacy, ...mine };   // this origin wins on conflict

  try {
    const res = await fetch(`${origin()}/api/outputs/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coverMeta }),
    });
    if (!res.ok) throw new Error(`migration returned ${res.status}`);

    const counts = await res.json();
    persist(FLAG, true);
    console.info(
      `[vocalis] cover metadata: ${counts.recovered} recovered, ` +
      `${counts.backfilled} backfilled, ${counts.total} total`
    );
    return counts;
  } catch (err) {
    // Leave the flag unset so the next launch retries. The library still works
    // — reconcile() stubs any record the migration would have created.
    console.warn("[vocalis] cover metadata migration deferred:", err);
    return null;
  }
}
