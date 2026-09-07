// SPDX-License-Identifier: AGPL-3.0-only
// Production wiring: every running workspace in the store gets a
// WorkspaceTerminals in the registry, dialed through the api's daemonReach.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { fakeProcTree } from "../../../packages/daemon/test/fake-proc.js";
import { startOldDaemon, type OldDaemon } from "../../../packages/daemon/test/old-daemon.js";
import { DAEMON_VERSION, type WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { getDaemonRoot, getDaemonVersion } from "../src/files/wire.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { getProcs, resetProcs } from "../src/machine/procs.js";
import { getTerminals } from "../src/terminal/link.js";
import { wireTerminals } from "../src/terminal/wiring.js";

const TOKEN = "wiring-token";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

const view = (id: string, phase: "running" | "napping" = "running"): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

function fakeApi(workspaces: WorkspaceView[], daemonPort: () => number) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  let reaches = 0;
  const touches: string[] = [];
  const api: Api = {
    touch: async id => {
      touches.push(id);
    },
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, sizes: [] }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    listSessions: async () => [],
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => {
      reaches++;
      return { url: `ws://127.0.0.1:${daemonPort()}`, expiresAt: Date.now() + 3_600_000, daemonToken: TOKEN };
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
  return { api, emit, reaches: () => reaches, touches };
}

let daemon: DaemonHandle | undefined;
let oldDaemon: OldDaemon | undefined;
let inboxDir: string | undefined;
let procRoot: string | undefined;
let unwire: (() => void) | undefined;

beforeEach(async () => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
  resetLive();
  resetProcs();
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-wiring-inbox-"));
  daemon = await startDaemon({
    port: 0,
    token: TOKEN,
    inboxDir,
    portsSource: async () => [],
    portsIntervalMs: 1000,
    sysSource: async () => ({ cpu: { idle: 0, total: 0 }, load1: 0.1, mem: { used: 1, total: 2 }, disk: { used: 3, total: 4 } }),
    sysIntervalMs: 20,
    procRoot: (procRoot = fakeProcTree([{ pid: 1, comm: "init" }, { pid: 2, ppid: 1, comm: "node" }])),
    procIntervalMs: 20,
  });
});
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  await daemon?.close();
  daemon = undefined;
  await oldDaemon?.close();
  oldDaemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
  if (procRoot) rmSync(procRoot, { recursive: true, force: true });
  procRoot = undefined;
});

describe("wireTerminals", () => {
  it("links every running workspace, parks napping ones, and forgets deleted ones", async () => {
    const { api, emit } = fakeApi([view("ws_run"), view("ws_nap", "napping")], () => daemon!.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    await until(() => getTerminals("ws_run")?.status() === "live");
    expect(getDaemonRoot("ws_run")).toBe(process.env["HOME"] ?? homedir());
    // The live link asked for sys.watch: samples land in the workspace's live store, none for the napping one.
    await until(() => getLive("ws_run").snapshot().samples.length > 0);
    expect(getLive("ws_run").snapshot().reach).toBe("live");
    expect(getLive("ws_run").snapshot().samples[0]).toMatchObject({ type: "sys.sample", load1: 0.1, mem: { used: 1, total: 2 }, disk: { used: 3, total: 4 } });
    expect(getLive("ws_nap").snapshot()).toEqual({ samples: [], reach: "unreachable", unavailable: null });
    // Processes stream only while a pane holds a watch; the hold outlives the socket and asks again when it is back.
    expect(getProcs("ws_run").snapshot()).toEqual({ snapshot: null, reach: "live", unavailable: null });
    const release = getProcs("ws_run").watch();
    await until(() => getProcs("ws_run").snapshot().snapshot !== null);
    expect(getProcs("ws_run").snapshot().snapshot!.procs.map(p => p.pid)).toEqual([1, 2]);
    expect(getDaemonRoot("ws_nap")).toBeNull();
    const napping = getTerminals("ws_nap");
    expect(napping).not.toBeNull();
    expect(napping!.status()).toBe("connecting");

    const tab = await getTerminals("ws_run")!.open({ shell: "/bin/sh" });
    expect(daemon!.ptys.list().map(p => p.id)).toEqual([tab.ptyId]);

    // napped: the socket goes away, the model (and its tabs) stays for the wake
    emit({ type: "workspace.napped", workspaceId: "ws_run" });
    await until(() => getTerminals("ws_run")!.status() === "connecting");
    expect(getTerminals("ws_run")!.tabs()).toHaveLength(1);
    expect(getLive("ws_run").snapshot().reach).toBe("unreachable");
    expect(getLive("ws_run").snapshot().samples.length).toBeGreaterThan(0);
    expect(getProcs("ws_run").snapshot().reach).toBe("unreachable");

    emit({ type: "workspace.woken", workspaceId: "ws_run", machineId: "m_ws_run", resurrected: false });
    await until(() => getTerminals("ws_run")!.status() === "live");
    // The new socket was asked to watch again: a snapshot newer than the last one before the nap arrives.
    const beforeWake = getProcs("ws_run").snapshot().snapshot!.at;
    await until(() => getProcs("ws_run").snapshot().snapshot!.at > beforeWake);
    release();

    emit({ type: "workspace.deleted", workspaceId: "ws_run" });
    await until(() => getTerminals("ws_run") === null);
    expect(getDaemonRoot("ws_run")).toBeNull();
  }, 15_000);

  it("typing into a terminal touches the workspace once per throttle window, not per keystroke", async () => {
    const { api, touches } = fakeApi([view("ws_a")], () => daemon!.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30, touchMinMs: 200 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    const tab = await getTerminals("ws_a")!.open({ shell: "/bin/sh" });
    expect(touches).toEqual([]); // opening a terminal is not a person acting in it
    for (const ch of "echo hi") getTerminals("ws_a")!.write(tab.ptyId, ch);
    await until(() => touches.length === 1);
    await new Promise(r => setTimeout(r, 250));
    getTerminals("ws_a")!.write(tab.ptyId, "\n");
    await until(() => touches.length === 2);
    expect(touches).toEqual(["ws_a", "ws_a"]);
  }, 15_000);

  it("a workspace created after wiring gets its link too", async () => {
    const workspaces = [view("ws_a")];
    const { api, emit } = fakeApi(workspaces, () => daemon!.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    emit({ type: "workspace.created", workspace: view("ws_b") });
    await until(() => getTerminals("ws_b")?.status() === "live");
  }, 15_000);

  it("a daemon from before the version says so in its hello, its refusals read unavailable instead of pending, and a redeployed daemon fills the rows", async () => {
    oldDaemon = await startOldDaemon(TOKEN);
    let port = oldDaemon.port;
    const { api } = fakeApi([view("ws_a")], () => port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    expect(getDaemonRoot("ws_a")).toBe("/root");
    // A hello without a version is the first one; the app knows what it lacks from that alone.
    expect(getDaemonVersion("ws_a")).toBe(1);
    // The daemon answered sys.watch with an error and the app kept it: the rows read unavailable, never pending.
    await until(() => getLive("ws_a").snapshot().unavailable !== null);
    expect(getLive("ws_a").snapshot()).toEqual({ samples: [], reach: "live", unavailable: "unknown op: sys.watch" });
    const release = getProcs("ws_a").watch();
    await until(() => getProcs("ws_a").snapshot().unavailable !== null);
    expect(getProcs("ws_a").snapshot()).toEqual({ snapshot: null, reach: "live", unavailable: "unknown op: proc.watch" });
    expect(oldDaemon.ops.filter(op => op === "sys.watch" || op === "proc.watch")).toEqual(["sys.watch", "proc.watch"]);

    // The update: the old daemon goes down and the current one answers the next dial on the same reach.
    port = daemon!.port;
    await oldDaemon.close();
    oldDaemon = undefined;
    await until(() => getDaemonVersion("ws_a") === DAEMON_VERSION);
    await until(() => getLive("ws_a").snapshot().samples.length > 0);
    expect(getLive("ws_a").snapshot().unavailable).toBeNull();
    await until(() => getProcs("ws_a").snapshot().snapshot !== null);
    expect(getProcs("ws_a").snapshot().unavailable).toBeNull();
    release();
  }, 15_000);

  it("unwiring closes every link and empties the registry", async () => {
    const { api } = fakeApi([view("ws_a")], () => daemon!.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    unwire();
    unwire = undefined;
    expect(getTerminals("ws_a")).toBeNull();
  }, 15_000);
});
