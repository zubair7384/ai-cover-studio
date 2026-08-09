/**
 * Shell assembly — sidebar | content(toolbar / scroll / player), plus the
 * full-view flow layer that pushes over the library.
 */

import { el } from "../lib/dom.js";
import { ErrorPanel } from "../components/primitives/index.js";
import { Sidebar } from "./sidebar.js";
import { Toolbar, bindScrollHairline } from "./toolbar.js";
import { PlayerBar } from "./player-bar.js";
import { watchLibrary } from "./now-playing.js";
import { getState, subscribe, setSidebarVisible } from "./store.js";
import { titleFor } from "./router.js";
import { CoversView } from "../screens/covers.js";
import { VoicesView } from "../screens/voices.js";
import { NewCoverFlow } from "../screens/new-cover.js";
import { TrainFlow } from "../screens/train.js";
import { SettingsView } from "../settings/settings.js";

const VIEWS = { covers: CoversView, voices: VoicesView };
const FLOW_VIEWS = { "new-cover": NewCoverFlow, train: TrainFlow, settings: SettingsView };

export function Shell() {
  const sidebar = Sidebar();
  const toolbar = Toolbar();
  const scroll = el("main", { class: "scroll", id: "scroll" });

  // Permanent chrome: the bar is part of the window's silhouette, so it is
  // mounted once and never removed. With nothing loaded it paints its own idle
  // state (see player-bar.js) rather than leaving a gap the layout has to
  // absorb. The flow layer stops above it, so it survives New cover / Train /
  // Settings too.
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
    let view;
    try {
      view = (VIEWS[route] || VIEWS.covers)();
    } catch (err) {
      // A view that throws used to leave an empty content area with the
      // previous view's toolbar still in place — which reads as "the app is
      // broken" with no clue why. Surface it instead.
      console.error(`[vocalis] ${route} view failed to mount:`, err);
      view = el("div", { class: "column" }, ErrorPanel({
        title: "This view didn't load",
        body: "Something went wrong building this screen. Reopening the app usually clears it.",
        actionLabel: "Try again",
        onAction: mountView,
        details: String(err?.stack || err),
      }));
      view.toolbar = { title: titleFor(route), search: false };
    }
    current = view;
    // A view owns its toolbar and may swap it as state changes — Covers turns
    // it into "3 selected · Export… · Delete" while a multi-selection is live.
    view.setToolbar = (config) => toolbar.configure(config);
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
    // Going straight from one flow to another (New cover → Train a voice) used
    // to drop the layer without tearing down the view inside it, leaving its
    // store subscriptions live.
    if (flowLayer) {
      flowNode?.destroy?.();
      flowLayer.remove();
    }

    flowToolbar = Toolbar();
    flowScroll = el("main", { class: "scroll" });
    flowLayer = el("div", { class: "flow" }, flowToolbar, flowScroll);

    flowNode = (FLOW_VIEWS[flow] || NewCoverFlow)();
    flowNode.setToolbar = (config) => flowToolbar.configure(config);
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
    watchLibrary(),
  ];

  /* ---- exposed to boot.js for menu/shortcut wiring ---------------------- */

  root.focusSearch = () => (flowToolbar || toolbar).focusSearch();
  root.clearSearch = () => (flowToolbar || toolbar).clearSearch();
  root.togglePlayback = () => player?.toggle();
  root.toggleSidebar = () => setSidebarVisible(!getState().sidebarVisible);

  root.destroy = () => {
    offs.forEach((f) => f());
    current?.destroy?.();
    flowNode?.destroy?.();
    sidebar.destroy?.();
    toolbar.destroy?.();
    player?.destroy?.();
  };

  return root;
}
