/**
 * A voice's face — shared by both shelves of the Voices library.
 *
 * Two layers, because only a minority of voices have a real picture. The base
 * is always a tile whose hue is derived from the name, so the thousands of
 * voices Wikipedia has never heard of still arrive with an identity of their
 * own instead of the same grey square. A portrait, when there is one, fades in
 * over the top; if the fetch fails, nothing moves and the tile simply stays.
 *
 * The online and local shelves both use this, which is the point: a voice you
 * downloaded should look the same in your library as it did in the catalog.
 */

import { el } from "../lib/dom.js";
import { initials } from "./profile.js";
import { api } from "./api.js";

/**
 * @param {{name: string, hasPortrait?: boolean, portraitName?: string}} voice
 * @param {{size?: "sm"}} [opts]
 */
export function Avatar(voice, { size } = {}) {
  // A hue from the name: same voice, same colour, every session, both shelves.
  let hash = 0;
  for (const ch of voice.name || "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;

  const tile = el("span", {
    class: `voice-tile voice-tile--tinted${size === "sm" ? " voice-tile--sm" : ""}`,
  }, initials(voice.name));
  tile.style.setProperty("--tile-h", String(hash % 360));

  if (!voice.hasPortrait) return tile;

  const img = el("img", {
    class: "voice-tile__photo",
    alt: "",                       // decorative: the name is already the label
    loading: "lazy",
    src: api.hfPortraitUrl(voice.portraitName || voice.name),
  });
  img.addEventListener("load", () => { tile.dataset.photo = ""; });
  img.addEventListener("error", () => img.remove());
  tile.appendChild(img);
  return tile;
}
