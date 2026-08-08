/**
 * Shell assembly — sidebar | content(toolbar / scroll / player), plus the
 * full-view flow layer that pushes over the library.
 */

import { el } from "../lib/dom.js";
import { Sidebar } from "./sidebar.js";
import { Toolbar, bindScrollHairline } from "./toolbar.js";
import { PlayerBar } from "./player-bar.js";
import { getState, subscribe, setSidebarVisible } from "./store.js";
import { titleFor } from "./router.js";
import { CoversView } from "../screens/covers.js";
import { VoicesView } from "../screens/voices.js";
import { NewCoverFlow, TrainFlow } from "../screens/flows.js";

const VIEWS = { covers: CoversView, voices: VoicesView };
const FLOW_VIEWS = { "new-cover": NewCoverFlow, train: TrainFlow };

export function Shell() {
  const sidebar = Sidebar();
  const toolbar = Toolbar();
  const scroll = el("main", { class: "scroll", id: "scroll" });
  const player = PlayerBar();

  const content = el("div", { class: "content" }, toolbar, scroll, player);
  const root = el("div", { id: "shell" }, sidebar, content);

  // Flow layer lives inside .content so it pushes over the library but leaves
  // the sidebar reachable (§8).
  let flowToolbar = null;
  let flowScroll = null;
  let flowNode = null;
  let flowLayer = null;

  let current = null;

  /* ---- library view ----------------------------------------------------- */

  function mountView() {
    const route = getState().route;
    current?.destroy?.();
    scroll.innerHTML = "";
    const view = (VIEWS[route] || VIEWS.covers)();
    current = view;
    scroll.appendChild(view);
    toolbar.configure(view.toolbar || { title: titleFor(route) });
    scroll.scrollTop = 0;
  }

  /* ---- flow layer ------------------------------------------------------- */

  function mountFlow() {
    const flow = getState().flow;

    if (!flow) {
      flowNode?.destroy?.();
      flowLayer?.remove();
      flowLayer = flowNode = flowToolbar = flowScroll = null;
      return;
    }
    if (flowLayer) flowLayer.remove();

    flowToolbar = Toolbar();
    flowScroll = el("main", { class: "scroll" });
    flowLayer = el("div", { class: "flow" }, flowToolbar, flowScroll);

    flowNode = (FLOW_VIEWS[flow] || NewCoverFlow)();
    flowScroll.appendChild(flowNode);
    flowToolbar.configure(flowNode.toolbar || { title: titleFor(flow), search: false });
    bindScrollHairline(flowToolbar, flowScroll);

    content.appendChild(flowLayer);
  }

  /* ---- chrome ----------------------------------------------------------- */

  function paintChrome() {
    const { sidebarWidth, sidebarVisible } = getState();
    root.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    root.dataset.sidebar = sidebarVisible ? "shown" : "hidden";
  }

  bindScrollHairline(toolbar, scroll);
  paintChrome();
  mountView();

  const offs = [
    subscribe(["route"], mountView),
    subscribe(["flow"], mountFlow),
    subscribe(["sidebarWidth", "sidebarVisible"], paintChrome),
  ];

  /* ---- exposed to boot.js for menu/shortcut wiring ---------------------- */

  root.focusSearch = () => (flowToolbar || toolbar).focusSearch();
  root.clearSearch = () => (flowToolbar || toolbar).clearSearch();
  root.togglePlayback = () => player.toggle();
  root.toggleSidebar = () => setSidebarVisible(!getState().sidebarVisible);

  root.destroy = () => {
    offs.forEach((f) => f());
    current?.destroy?.();
    flowNode?.destroy?.();
    sidebar.destroy?.();
    toolbar.destroy?.();
    player.destroy?.();
  };

  return root;
}
