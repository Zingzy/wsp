// SPDX-License-Identifier: AGPL-3.0-only
// Listening ports from the daemon link into the browser pane's server list.
import { describe, expect, it } from "vitest";
import { applyPortEvent, applyPortsSnapshot, toPreviewableServers, type KnownPort } from "../src/adapt/index.js";

describe("applyPortsSnapshot / applyPortEvent", () => {
  it("seeds from the ports.watch reply, sorted, first pid wins on a duplicate", () => {
    expect(applyPortsSnapshot({ ports: [{ port: 5173, pid: 40, process: "node" }, { port: 3000 }, { port: 5173, pid: 41 }] })).toEqual([
      { port: 3000, pid: null, process: null },
      { port: 5173, pid: 40, process: "node" },
    ]);
  });

  const known = (port: number, pid: number | null, process: string | null = null): KnownPort => ({ port, pid, process });

  it.each<[string, KnownPort[], Parameters<typeof applyPortEvent>[1], KnownPort[]]>([
    ["daemon port.open adds with the process name", [], { type: "port.open", port: 3000, pid: 7, process: "node" }, [known(3000, 7, "node")]],
    ["runtime port.open adds too", [], { type: "port.open", workspaceId: "ws", port: 3000 }, [known(3000, null)]],
    ["re-open keeps the first pid", [known(3000, 7)], { type: "port.open", port: 3000, pid: 9 }, [known(3000, 7)]],
    ["close removes", [known(3000, 7), known(5173, null)], { type: "port.close", port: 3000 }, [known(5173, null)]],
    ["close of an unknown port changes nothing", [known(3000, 7)], { type: "port.close", workspaceId: "ws", port: 81 }, [known(3000, 7)]],
    ["open keeps the list sorted", [known(5173, null)], { type: "port.open", port: 80 }, [known(80, null), known(5173, null)]],
  ])("%s", (_name, before, event, after) => {
    expect(applyPortEvent(before, event)).toEqual(after);
    expect(applyPortEvent(before, event)).not.toBe(before);
  });
});

describe("toPreviewableServers", () => {
  it("uses the minted preview route when it exists and the loopback url otherwise; requestedUrl is always loopback", () => {
    const servers = toPreviewableServers({
      ports: [{ port: 3000, pid: 7, process: "node" }, { port: 5173, pid: null, process: null }],
      reachUrl: port => (port === 3000 ? "https://m1-3000.preview.example/?pt_token=e" : undefined),
    });
    expect(servers).toEqual([
      { host: "localhost", port: 3000, url: "https://m1-3000.preview.example/?pt_token=e", processName: "node", pid: 7, terminal: null, source: "scanner", requestedUrl: "http://localhost:3000" },
      { host: "localhost", port: 5173, url: "http://localhost:5173", processName: null, pid: null, terminal: null, source: "scanner", requestedUrl: "http://localhost:5173" },
    ]);
  });
});
