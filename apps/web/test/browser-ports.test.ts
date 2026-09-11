// SPDX-License-Identifier: AGPL-3.0-only
// The port directory is fed by each workspace's own daemon link, not the
// runtime stream: two in-process daemons stand in for two workspaces so a
// port on one must never show up on the other.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import type { ListeningPort } from "@wsp/daemon";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBrowser, resetBrowsers } from "../src/browser/model.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { getTerminals } from "../src/terminal/link.js";
import { wireTerminals } from "../src/terminal/wiring.js";

const TOKEN = "ports-token";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const listening = (port: number, pid: number | null = null): ListeningPort => ({ port, pid, inode: port, uid: 0, loopback: false });

function fakeApi(workspaces: WorkspaceView[], daemonPort: (workspaceId: string) => number) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, firstLifeSnapshots: true, templates: false, kept: false, sizes: [] }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    listSessions: async () => [],
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async id => ({ url: `ws://127.0.0.1:${daemonPort(id)}`, expiresAt: Date.now() + 3_600_000, daemonToken: TOKEN }),
    getGolden: async () => undefined,
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: ProtocolEvent) => {
    for (const fn of [...listeners]) fn(e);
  };
  return { api, emit };
}

interface Guest {
  daemon: DaemonHandle;
  ports: ListeningPort[];
  inboxDir: string;
}

async function guest(ports: ListeningPort[]): Promise<Guest> {
  const g: Guest = { daemon: undefined as unknown as DaemonHandle, ports, inboxDir: mkdtempSync(join(tmpdir(), "wsp-ports-inbox-")) };
  g.daemon = await startDaemon({ port: 0, token: TOKEN, inboxDir: g.inboxDir, portsSource: async () => g.ports, portsIntervalMs: 50 });
  return g;
}

const guests = new Map<string, Guest>();
let unwire: (() => void) | undefined;

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
});
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  for (const g of guests.values()) {
    await g.daemon.close();
    rmSync(g.inboxDir, { recursive: true, force: true });
  }
  guests.clear();
  resetBrowsers();
});

const portsOf = (id: string) => getBrowser(id).ports().map(p => p.port);

describe("port directory over the daemon link", () => {
  it("seeds from the ports.watch reply, follows port.open and port.close, and keeps workspaces apart", async () => {
    guests.set("ws_a", await guest([listening(3000, 42)]));
    guests.set("ws_b", await guest([listening(8080)]));
    const { api } = fakeApi([view("ws_a"), view("ws_b")], id => guests.get(id)!.daemon.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    // A tab opened after the server started: the reply carries what is already listening.
    await until(() => portsOf("ws_a").includes(3000));
    expect(getBrowser("ws_a").ports()).toEqual([expect.objectContaining({ port: 3000, pid: 42 })]);
    await until(() => portsOf("ws_b").includes(8080));
    expect(portsOf("ws_b")).toEqual([8080]);

    // The daemon's watcher pushes a new listener without a redial.
    guests.get("ws_a")!.ports = [listening(3000, 42), listening(5173, 7)];
    await until(() => portsOf("ws_a").includes(5173));
    expect(portsOf("ws_a")).toEqual([3000, 5173]);
    expect(portsOf("ws_b")).toEqual([8080]);

    guests.get("ws_a")!.ports = [listening(5173, 7)];
    await until(() => !portsOf("ws_a").includes(3000));
    expect(portsOf("ws_a")).toEqual([5173]);
    expect(portsOf("ws_b")).toEqual([8080]);
  }, 15_000);

  it("a listener killed and started again is listed again, even when the daemon cannot name its pid", async () => {
    guests.set("ws_a", await guest([listening(8412, 100)]));
    const { api } = fakeApi([view("ws_a")], id => guests.get(id)!.daemon.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => portsOf("ws_a").includes(8412));

    guests.get("ws_a")!.ports = [];
    await until(() => !portsOf("ws_a").includes(8412));

    guests.get("ws_a")!.ports = [listening(8412)];
    await until(() => portsOf("ws_a").includes(8412), 2000);
    expect(getBrowser("ws_a").ports()).toEqual([{ port: 8412, pid: null, process: null }]);
  }, 15_000);

  it("a redial re-subscribes: ports that changed while the socket was down are reconciled", async () => {
    guests.set("ws_a", await guest([listening(3000)]));
    const { api, emit } = fakeApi([view("ws_a")], id => guests.get(id)!.daemon.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => portsOf("ws_a").includes(3000));

    emit({ type: "workspace.napped", workspaceId: "ws_a" });
    await until(() => getTerminals("ws_a")!.status() === "connecting");
    guests.get("ws_a")!.ports = [listening(4000)];
    await new Promise(r => setTimeout(r, 120));

    emit({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m_ws_a", resurrected: false });
    await until(() => portsOf("ws_a").includes(4000) && !portsOf("ws_a").includes(3000));
    expect(portsOf("ws_a")).toEqual([4000]);
  }, 15_000);
});
