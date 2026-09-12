// SPDX-License-Identifier: AGPL-3.0-only
// The port directory is fed by each workspace's own daemon channel, not the
// runtime stream: one host relays for two workspaces on two in-process
// daemons, so a port on one must never show up on the other.
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
import { caps } from "./caps.js";
import { HARNESS_DAEMON_TOKEN, startRelayHarness, type RelayHarness } from "./relay-harness.js";

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

function fakeApi(workspaces: WorkspaceView[], relay: () => RelayHarness) {
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
    capabilities: async () => (caps()),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    listSessions: async () => [],
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: {
      open: workspaceId => relay().api.daemon.open(workspaceId),
      send: (channel, frame) => relay().api.daemon.send(channel, frame),
      close: channel => relay().api.daemon.close(channel),
      onFrame: (channel, fn) => relay().api.daemon.onFrame(channel, fn),
    },
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
  ports: ListeningPort[];
}

/** The first guest is the harness's own daemon; every one after it is a daemon of its own on the same host. */
const guests = new Map<string, Guest>();
let relay: RelayHarness | undefined;
let extra: { daemon: DaemonHandle; inboxDir: string }[] = [];
let unwire: (() => void) | undefined;

/** The harness's own workspace, on a daemon whose listening set this test owns. */
async function firstGuest(ports: ListeningPort[]): Promise<string> {
  const g: Guest = { ports };
  relay = await startRelayHarness({ ports: async () => g.ports });
  guests.set(relay.workspaceId, g);
  return relay.workspaceId;
}

/** One more workspace on the same host, with a daemon of its own. */
async function nextGuest(ports: ListeningPort[]): Promise<string> {
  const g: Guest = { ports };
  const inboxDir = mkdtempSync(join(tmpdir(), "wsp-ports-inbox-"));
  const daemon = await startDaemon({ port: 0, token: HARNESS_DAEMON_TOKEN, inboxDir, portsSource: async () => g.ports, portsIntervalMs: 50 });
  extra.push({ daemon, inboxDir });
  const id = await relay!.addWorkspace("second", `ws://127.0.0.1:${daemon.port}`);
  guests.set(id, g);
  return id;
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false, conn: "live" });
});
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  await relay?.close();
  relay = undefined;
  for (const e of extra) {
    await e.daemon.close();
    rmSync(e.inboxDir, { recursive: true, force: true });
  }
  extra = [];
  guests.clear();
  resetBrowsers();
});

const portsOf = (id: string) => getBrowser(id).ports().map(p => p.port);

describe("port directory over the daemon link", () => {
  it("seeds from the ports.watch reply, follows port.open and port.close, and keeps workspaces apart", async () => {
    const a = await firstGuest([listening(3000, 42)]);
    const b = await nextGuest([listening(8080)]);
    const { api } = fakeApi([view(a), view(b)], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    // A tab opened after the server started: the reply carries what is already listening.
    await until(() => portsOf(a).includes(3000));
    expect(getBrowser(a).ports()).toEqual([expect.objectContaining({ port: 3000, pid: 42 })]);
    await until(() => portsOf(b).includes(8080));
    expect(portsOf(b)).toEqual([8080]);

    // The daemon's watcher pushes a new listener without a redial.
    guests.get(a)!.ports = [listening(3000, 42), listening(5173, 7)];
    await until(() => portsOf(a).includes(5173));
    expect(portsOf(a)).toEqual([3000, 5173]);
    expect(portsOf(b)).toEqual([8080]);

    guests.get(a)!.ports = [listening(5173, 7)];
    await until(() => !portsOf(a).includes(3000));
    expect(portsOf(a)).toEqual([5173]);
    expect(portsOf(b)).toEqual([8080]);
  }, 20_000);

  it("a listener killed and started again is listed again, even when the daemon cannot name its pid", async () => {
    const a = await firstGuest([listening(8412, 100)]);
    const { api } = fakeApi([view(a)], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => portsOf(a).includes(8412));

    guests.get(a)!.ports = [];
    await until(() => !portsOf(a).includes(8412));

    guests.get(a)!.ports = [listening(8412)];
    await until(() => portsOf(a).includes(8412), 2000);
    expect(getBrowser(a).ports()).toEqual([{ port: 8412, pid: null, process: null }]);
  }, 20_000);

  it("a redial re-subscribes: ports that changed while the channel was down are reconciled", async () => {
    const a = await firstGuest([listening(3000)]);
    const { api, emit } = fakeApi([view(a)], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => portsOf(a).includes(3000));

    emit({ type: "workspace.napped", workspaceId: a });
    await until(() => getTerminals(a)!.status() === "connecting");
    guests.get(a)!.ports = [listening(4000)];
    await new Promise(r => setTimeout(r, 120));

    emit({ type: "workspace.woken", workspaceId: a, machineId: `m_${a}`, resurrected: false });
    await until(() => portsOf(a).includes(4000) && !portsOf(a).includes(3000));
    expect(portsOf(a)).toEqual([4000]);
  }, 20_000);
});
