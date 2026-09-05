// SPDX-License-Identifier: AGPL-3.0-only
// Production wiring: every running workspace in the store gets a
// WorkspaceTerminals in the registry, dialed through the api's daemonReach.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { getDaemonRoot } from "../src/files/wire.js";
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
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
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
    builderReach: async () => { throw new Error("no wizard in this fixture"); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
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
let inboxDir: string | undefined;
let unwire: (() => void) | undefined;

beforeEach(async () => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-wiring-inbox-"));
  daemon = await startDaemon({ port: 0, token: TOKEN, inboxDir, portsSource: async () => [], portsIntervalMs: 1000 });
});
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  await daemon?.close();
  daemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
});

describe("wireTerminals", () => {
  it("links every running workspace, parks napping ones, and forgets deleted ones", async () => {
    const { api, emit } = fakeApi([view("ws_run"), view("ws_nap", "napping")], () => daemon!.port);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    await until(() => getTerminals("ws_run")?.status() === "live");
    expect(getDaemonRoot("ws_run")).toBe(process.env["HOME"] ?? homedir());
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

    emit({ type: "workspace.woken", workspaceId: "ws_run", machineId: "m_ws_run", resurrected: false });
    await until(() => getTerminals("ws_run")!.status() === "live");

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
