/**
 * Content toolbar — 52px, drag region, view title left, actions right (§6).
 * The bottom hairline fades in only once the content area has scrolled.
 */

import { el, on } from "../lib/dom.js";
import { TextField } from "../components/primitives/index.js";
import { set, getState, subscribe } from "./store.js";

export function Toolbar() {
  const title = el("h1", { class: "toolbar__title t-title-1" }, "");
  const actions = el("div", { class: "toolbar__actions" });

  const search = TextField({
    search: true,
    placeholder: "Search",
    ariaLabel: "Search",
    onInput: (value) => set({ query: value }),
  });
  search.classList.add("toolbar__search");

  // Flows put Cancel to the LEFT of the title; library views leave it empty.
  const leading = el("div", { class: "toolbar__leading" });

  const root = el("header", { class: "toolbar drag-region" },
    leading,
    title,
    el("div", { class: "toolbar__spacer" }),
    search,
    actions,
  );

  /**
   * Views call this to declare their toolbar.
   * @param {{title: string, actions?: Node[], search?: boolean}} config
   */
  root.configure = ({ title: text, actions: nodes = [], search: showSearch = true,
                     leading: lead = null }) => {
    title.textContent = text;
    search.hidden = !showSearch;
    leading.innerHTML = "";
    if (lead) leading.appendChild(lead);
    actions.innerHTML = "";
    nodes.forEach((n) => actions.appendChild(n));
  };

  root.focusSearch = () => {
    if (search.hidden) return;
    search.input.focus();
    search.input.select();
  };

  root.clearSearch = () => {
    search.input.value = "";
    set({ query: "" });
  };

  // Keep the field in step if something else resets the query (e.g. navigation).
  const off = subscribe(["query"], () => {
    if (search.input.value !== getState().query) search.input.value = getState().query;
  });

  root.destroy = () => off();
  return root;
}

/** Wire a scroll container to the toolbar's hairline. */
export function bindScrollHairline(toolbar, scroller) {
  const update = () => {
    if (scroller.scrollTop > 0) toolbar.dataset.scrolled = "";
    else delete toolbar.dataset.scrolled;
  };
  update();
  return on(scroller, "scroll", update, { passive: true });
}
