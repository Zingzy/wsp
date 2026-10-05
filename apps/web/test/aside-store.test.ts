// SPDX-License-Identifier: AGPL-3.0-only
// The side question's tab comes and goes without moving the panel: closing it
// shows the tab that showed before the question, and shuts the panel again
// where the question opened it.
import { beforeEach, describe, expect, it } from "vitest";
import { useAsideStore } from "../src/components/chat/asideStore.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";

const WS = "ws_1";
const panel = () => selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
const tabs = () => panel().surfaces.map(s => s.id);

beforeEach(() => {
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useAsideStore.setState({ byWorkspace: {} });
});

describe("the side question's tab", () => {
  it("closes onto the tab that showed before it, not onto its neighbour", () => {
    const store = useRightPanelStore.getState();
    store.open(WS, "machine");
    store.open(WS, "agents");
    store.activateSurface(WS, "machine");
    useAsideStore.getState().ask(WS, "which folder?");
    expect(tabs()).toEqual(["machine", "agents", "aside"]);
    expect(panel().activeSurfaceId).toBe("aside");
    // A second question over the first keeps the tab the first one came from.
    useAsideStore.getState().ask(WS, "and the branch?");
    useAsideStore.getState().close(WS);
    expect(tabs()).toEqual(["machine", "agents"]);
    expect(panel().activeSurfaceId).toBe("machine");
    expect(panel().isOpen).toBe(true);
  });

  it("falls back to its neighbour when the tab it came from was closed meanwhile", () => {
    const store = useRightPanelStore.getState();
    store.open(WS, "machine");
    store.open(WS, "agents");
    store.activateSurface(WS, "machine");
    useAsideStore.getState().ask(WS, "which folder?");
    store.closeSurface(WS, "machine");
    useAsideStore.getState().close(WS);
    expect(tabs()).toEqual(["agents"]);
    expect(panel().activeSurfaceId).toBe("agents");
  });

  it("shuts the panel again when the question opened it", () => {
    useRightPanelStore.getState().open(WS, "machine");
    useRightPanelStore.getState().close(WS);
    useAsideStore.getState().ask(WS, "which folder?");
    expect(panel().isOpen).toBe(true);
    useAsideStore.getState().close(WS);
    expect(panel().isOpen).toBe(false);
    expect(panel().activeSurfaceId).toBe("machine");
  });
});
