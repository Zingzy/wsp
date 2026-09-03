// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { WorkspacePorts } from "../src/browser/model.js";

const WS = "ws_browser01";

describe("WorkspacePorts", () => {
  it("port.open adds, port.close drops, and a close for an unknown port changes nothing", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.onChange(() => notified++);
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1, process: "nginx" });
    expect(d.ports()).toEqual([{ port: 80, pid: 1, process: "nginx" }]);
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 81 });
    expect(notified).toBe(1);
    d.feedEvent({ type: "port.close", workspaceId: WS, port: 80 });
    expect(d.ports()).toEqual([]);
    expect(notified).toBe(2);
  });

  it("a re-open of a known port keeps the first pid and does not notify", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.onChange(() => notified++);
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1 });
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 2 });
    expect(d.ports()).toEqual([{ port: 80, pid: 1, process: null }]);
    expect(notified).toBe(1);
  });
});

describe("WorkspacePorts.syncPorts", () => {
  it("adopts the daemon's snapshot: adds missing, drops absent, sorted by port, notifies once", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 80, pid: 1 });
    d.feedEvent({ type: "port.open", workspaceId: WS, port: 81 });
    d.onChange(() => notified++);
    d.syncPorts([{ port: 9000, pid: 5, process: "node" }, { port: 80, pid: 1 }]);
    expect(d.ports()).toEqual([
      { port: 80, pid: 1, process: null },
      { port: 9000, pid: 5, process: "node" },
    ]);
    expect(notified).toBe(1);
  });

  it("an identical snapshot changes nothing and does not notify", () => {
    let notified = 0;
    const d = new WorkspacePorts();
    d.syncPorts([{ port: 80, pid: 1 }]);
    const before = d.ports();
    d.onChange(() => notified++);
    d.syncPorts([{ port: 80, pid: 1 }]);
    expect(d.ports()).toBe(before);
    expect(notified).toBe(0);
  });

  it("ignores a malformed reply rather than clearing the directory", () => {
    const d = new WorkspacePorts();
    d.syncPorts([{ port: 80 }]);
    d.syncPorts(undefined);
    d.syncPorts("nope");
    d.syncPorts([{ port: "80" }]);
    d.syncPorts([null]);
    expect(d.ports()).toEqual([{ port: 80, pid: null, process: null }]);
  });
});
