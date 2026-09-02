// SPDX-License-Identifier: AGPL-3.0-only
// Listening ports from the daemon link into the browser pane's server list.
import { describe, expect, it } from "vitest";
import { applyPortEvent, applyPortsSnapshot, toPreviewableServers, type KnownPort } from "../src/adapt/index.js";

describe("applyPortsSnapshot / applyPortEvent", () => {
  it("seeds from the ports.watch reply, sorted, first pid wins on a duplicate", () => {
    expect(applyPortsSnapshot({ ports: [{ port: 5173, pid: 40 }, { port: 3000 }, { port: 5173, pid: 41 }] })).toEqual([
      { port: 3000, pid: null },
      { port: 5173, pid: 40 },
    ]);
  });

  it.each<[string, KnownPort[], Parameters<typeof applyPortEvent>[1], KnownPort[]]>([
    ["daemon port.open adds", [], { type: "port.open", port: 3000, pid: 7 }, [{ port: 3000, pid: 7 }]],
    ["runtime port.open adds too", [], { type: "port.open", workspaceId: "ws", port: 3000 }, [{ port: 3000, pid: null }]],
    ["re-open keeps the first pid", [{ port: 3000, pid: 7 }], { type: "port.open", port: 3000, pid: 9 }, [{ port: 3000, pid: 7 }]],
    ["close removes", [{ port: 3000, pid: 7 }, { port: 5173, pid: null }], { type: "port.close", port: 3000 }, [{ port: 5173, pid: null }]],
    ["close of an unknown port changes nothing", [{ port: 3000, pid: 7 }], { type: "port.close", workspaceId: "ws", port: 81 }, [{ port: 3000, pid: 7 }]],
    ["open keeps the list sorted", [{ port: 5173, pid: null }], { type: "port.open", port: 80 }, [{ port: 80, pid: null }, { port: 5173, pid: null }]],
  ])("%s", (_name, before, event, after) => {
    expect(applyPortEvent(before, event)).toEqual(after);
    expect(applyPortEvent(before, event)).not.toBe(before);
  });
});

describe("toPreviewableServers", () => {
  it("uses the minted preview route when it exists and the loopback url otherwise; requestedUrl is always loopback", () => {
    const servers = toPreviewableServers({
      ports: [{ port: 3000, pid: 7 }, { port: 5173, pid: null }],
      reachUrl: port => (port === 3000 ? "https://m1-3000.preview.example/?pt_token=e" : undefined),
    });
    expect(servers).toEqual([
      { host: "localhost", port: 3000, url: "https://m1-3000.preview.example/?pt_token=e", processName: null, pid: 7, terminal: null, source: "scanner", requestedUrl: "http://localhost:3000" },
      { host: "localhost", port: 5173, url: "http://localhost:5173", processName: null, pid: null, terminal: null, source: "scanner", requestedUrl: "http://localhost:5173" },
    ]);
  });
});
