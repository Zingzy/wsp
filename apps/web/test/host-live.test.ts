// SPDX-License-Identifier: AGPL-3.0-only
// The readings of the folders on this computer ride the host's socket, and
// only while a pane draws them: 125 folders each watched from the moment the
// page opened sent 62 frames a second that nothing drew.
import type { WorkspaceSysEvent, WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { wireHostLive } from "../src/machine/hostLive.js";
import { getLive, resetLive, watchLive } from "../src/machine/live.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const folder = (id: string): WorkspaceView => ({
  id,
  name: id,
  kind: "local",
  machineId: `m_${id}`,
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "here" },
  phase: "running",
  golden: "",
  createdAt: "2026-09-01T00:00:00Z",
});

function fakeApi() {
  const asks: string[] = [];
  let feed: ((e: WorkspaceSysEvent) => void) | null = null;
  const api = {
    daemon: noDaemonApi,
    subscribe: () => () => {},
    watchSys: async (id: string) => void asks.push(`+${id}`),
    unwatchSys: async (id: string) => void asks.push(`-${id}`),
    onSysSample: (fn: (e: WorkspaceSysEvent) => void) => {
      feed = fn;
      return () => (feed = null);
    },
  } as unknown as Api;
  return { api, asks, feed: (e: WorkspaceSysEvent) => feed?.(e) };
}

let unwire: (() => void) | undefined;
beforeEach(() => {
  resetLive();
  useStore.setState({ api: null, conn: "live", workspaces: [folder("ws_a"), folder("ws_b"), folder("ws_c")] });
});
afterEach(() => {
  unwire?.();
  unwire = undefined;
});

describe("the host's readings of the folders on this computer", () => {
  it("are asked for only while a pane holds them, and stopped when the last one lets go", async () => {
    const { api, asks, feed } = fakeApi();
    useStore.setState({ api });
    unwire = wireHostLive(useStore);
    expect(asks).toEqual([]);

    const one = watchLive("ws_b");
    const two = watchLive("ws_b");
    expect(asks).toEqual(["+ws_b"]);
    feed({ type: "workspace.sys", workspaceId: "ws_b", sample: { type: "sys.sample", cpu: 1, load1: 0.1, mem: { used: 1, total: 2 }, disk: { used: 1, total: 2 }, at: 1 } });
    expect(getLive("ws_b").snapshot().samples).toHaveLength(1);

    one();
    expect(asks).toEqual(["+ws_b"]);
    two();
    expect(asks).toEqual(["+ws_b", "-ws_b"]);
    expect(getLive("ws_b").snapshot().reach).toBe("unreachable");
  });

  it("come back after the socket reconnects and after the host is replaced, for what a pane still holds", async () => {
    const first = fakeApi();
    useStore.setState({ api: first.api });
    unwire = wireHostLive(useStore);
    const release = watchLive("ws_a");
    expect(first.asks).toEqual(["+ws_a"]);

    // A subscription dies with its socket, so a socket that redials is asked again.
    useStore.setState({ conn: "reconnecting" });
    expect(getLive("ws_a").snapshot().reach).toBe("unreachable");
    useStore.setState({ conn: "live" });
    expect(first.asks).toEqual(["+ws_a", "+ws_a"]);

    // A host that restarted is a new transport: the readings are asked of it and read off it alone.
    const second = fakeApi();
    useStore.setState({ api: second.api });
    expect(second.asks).toEqual(["+ws_a"]);
    second.feed({ type: "workspace.sys", workspaceId: "ws_a", sample: { type: "sys.sample", cpu: 2, load1: 0.2, mem: { used: 1, total: 2 }, disk: { used: 1, total: 2 }, at: 2 } });
    first.feed({ type: "workspace.sys", workspaceId: "ws_a", sample: { type: "sys.sample", cpu: 9, load1: 0.9, mem: { used: 1, total: 2 }, disk: { used: 1, total: 2 }, at: 3 } });
    expect(getLive("ws_a").snapshot().samples.map(s => s.at)).toEqual([2]);
    release();
    expect(second.asks).toEqual(["+ws_a", "-ws_a"]);
  });
});
