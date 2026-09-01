// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { WorkspaceBrowser } from "../src/browser/model.js";

const WS = "ws_browser01";

describe("WorkspaceBrowser", () => {
  it("port.close drops the entry and a close for an unknown port changes nothing", () => {
    let notified = 0;
    const b = new WorkspaceBrowser(() => 0);
    b.onChange(() => notified++);
    b.feedEvent({ type: "port.open", workspaceId: WS, port: 80 });
    b.feedEvent({ type: "port.close", workspaceId: WS, port: 81 });
    expect(notified).toBe(1);
    b.feedEvent({ type: "port.close", workspaceId: WS, port: 80 });
    expect(b.ports()).toEqual([]);
    expect(notified).toBe(2);
  });

  it("tabs: open activates the new one, close falls to the right neighbour then the left, the last never closes", () => {
    const b = new WorkspaceBrowser(() => 0);
    b.openTab();
    b.openTab();
    const [t1, t2, t3] = b.tabs().map(t => t.id) as [string, string, string];
    expect(b.activeId()).toBe(t3);
    b.setActive(t2);
    b.closeTab(t2);
    expect(b.activeId()).toBe(t3);
    b.closeTab(t3);
    expect(b.activeId()).toBe(t1);
    b.closeTab(t1);
    expect(b.tabs()).toHaveLength(1);
    b.navigate(t1, 5173);
    expect(b.tabs()[0]).toEqual({ id: t1, port: 5173 });
  });

  it("records first-seen from the injected clock and ignores a re-open of a known port", () => {
    let now = 1000;
    const b = new WorkspaceBrowser(() => now);
    b.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1 });
    now = 2000;
    b.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 2 });
    expect(b.ports()).toEqual([{ port: 80, pid: 1, firstSeen: 1000 }]);
    expect(b.ports()).toBe(b.ports()); // stable snapshot for useSyncExternalStore
  });
});
