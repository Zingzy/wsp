// SPDX-License-Identifier: AGPL-3.0-only
// makeApi against a scripted socket: every wrapper sends the op serveRuntime
// dispatches and unwraps the field its reply carries. The same socket plays a
// runtime that dies and comes back for the reconnect tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectedError, makeApi, ProtocolClient, type ConnStatus, type ProtocolClientOptions } from "../src/protocol/client.js";

type Frame = Record<string, unknown>;

class ScriptedSocket {
  static instances: ScriptedSocket[] = [];
  static reply: (frame: Frame) => Frame | undefined = () => undefined;
  static authOk = true;
  /** false plays a runtime that is down: every new socket closes before it opens. */
  static serverUp = true;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ScriptedSocket.instances.push(this);
    queueMicrotask(() => (ScriptedSocket.serverUp ? this.onopen?.() : this.drop(1006)));
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    if (frame["op"] === "auth") {
      const reply = ScriptedSocket.authOk ? { id: frame["id"], ok: true } : { id: frame["id"], ok: false, error: "unauthorized" };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
      if (!ScriptedSocket.authOk) queueMicrotask(() => this.drop(4401));
      return;
    }
    const reply = ScriptedSocket.reply(frame);
    if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }
  /** The server side going away, as a wsp restart looks from the tab. */
  drop(code: number): void {
    this.onclose?.({ code });
  }
  close(): void {
    this.drop(1000);
  }
  frames(op: string): Frame[] {
    return this.sent.filter(f => f["op"] === op);
  }
}

async function connect() {
  ScriptedSocket.instances.length = 0;
  const client = new ProtocolClient({
    url: "ws://test",
    token: "tok",
    WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket,
  });
  await client.connect();
  const sock = ScriptedSocket.instances[0]!;
  return { api: makeApi(client), sock, lastSent: () => sock.sent[sock.sent.length - 1]! };
}

describe("makeApi wrappers", () => {
  it("startSession sends sessions.start with the scope and unwraps the session view", async () => {
    const { api, lastSent } = await connect();
    const session = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, session });
    const got = await api.startSession({ workspaceId: "ws_1", prompt: "fix it", resume: "claude-sid" });
    expect(lastSent()).toMatchObject({ op: "sessions.start", workspaceId: "ws_1", prompt: "fix it", resume: "claude-sid" });
    expect(got).toEqual(session);
  });

  it("upgrade sends workspaces.upgrade with the size and unwraps the workspace", async () => {
    const { api, lastSent } = await connect();
    const workspace = { id: "ws_1", name: "x", machineId: "m2", phase: "running", golden: "g", createdAt: "t" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, workspace });
    const got = await api.upgrade("ws_1", { cpu: 4, memMb: 8192 });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.upgrade", workspaceId: "ws_1", cpu: 4, memMb: 8192 });
    expect(got).toEqual(workspace);
  });

  it("capabilities sends capabilities.get and unwraps the flags", async () => {
    const { api, lastSent } = await connect();
    const capabilities = { liveCloneForks: true, ramPreservingPause: true, resize: false, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, capabilities });
    expect(await api.capabilities()).toEqual(capabilities);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "capabilities.get" });
  });

  it("listSessions without a workspace asks for every session", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, sessions: [] });
    await api.listSessions();
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "sessions.list" });
    await api.listSessions("ws_1");
    expect(lastSent()).toMatchObject({ op: "sessions.list", workspaceId: "ws_1" });
  });

  it("daemonReach sends workspaces.daemonReach and unwraps the reach view", async () => {
    const { api, lastSent } = await connect();
    const reach = { url: "https://m1-7070.preview.example/?pt_token=e", expiresAt: 1, daemonToken: "d" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, reach });
    expect(await api.daemonReach("ws_1")).toEqual(reach);
    expect(lastSent()).toMatchObject({ op: "workspaces.daemonReach", workspaceId: "ws_1" });
  });

  it("portReach sends workspaces.portReach with the port and unwraps the reach view", async () => {
    const { api, lastSent } = await connect();
    const reach = { url: "https://m1-3000.preview.example/?pt_token=e", expiresAt: 1 };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, reach });
    expect(await api.portReach("ws_1", 3000)).toEqual(reach);
    expect(lastSent()).toMatchObject({ op: "workspaces.portReach", workspaceId: "ws_1", port: 3000 });
  });

  it("listSnapshots and rollbackSnapshot send the snapshots ops and unwrap their replies", async () => {
    const { api, lastSent } = await connect();
    const lineage = { name: "default", head: 2, versions: [] };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, lineage });
    expect(await api.listSnapshots()).toEqual(lineage);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "snapshots.list" });
    await api.listSnapshots("other");
    expect(lastSent()).toMatchObject({ op: "snapshots.list", name: "other" });

    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, lineage: { ...lineage, head: 1 }, existingWorkspaces: "untouched" });
    expect(await api.rollbackSnapshot(1)).toEqual({ lineage: { ...lineage, head: 1 }, existingWorkspaces: "untouched" });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "snapshots.rollback", version: 1 });
  });

  it("a rejected op surfaces the runtime's error message", async () => {
    const { api } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: false, error: "workspace is napping" });
    await expect(api.startSession({ workspaceId: "ws_1", prompt: "x" })).rejects.toThrow("workspace is napping");
  });
});

describe("makeApi golden wrappers", () => {
  it("getGolden asks golden.get by name and unwraps the manifest, undefined on a fresh install", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    expect(await api.getGolden()).toBeUndefined();
    expect(lastSent()).toMatchObject({ op: "golden.get", name: "default" });
    const manifest = { head: 1, versions: [{ version: 1, snapshotId: "snap_1", baseTemplate: "default", kind: "desktop", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, manifest });
    expect(await api.getGolden()).toEqual(manifest);
  });

  it("prepareGolden sends golden.prepare and unwraps the builder view", async () => {
    const { api, lastSent } = await connect();
    const builder = { id: "m1", name: "default", kind: "desktop", createdAt: "t", screen: { streamUrl: "wss://s/m1" } };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, builder });
    expect(await api.prepareGolden()).toEqual(builder);
    expect(lastSent()).toMatchObject({ op: "golden.prepare", name: "default" });
  });

  it("builderReach sends golden.builderReach and unwraps the reach view", async () => {
    const { api, lastSent } = await connect();
    const reach = { url: "https://m1-7070.preview.example/?pt_token=e", expiresAt: 1, daemonToken: "d" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, reach });
    expect(await api.builderReach("m1")).toEqual(reach);
    expect(lastSent()).toMatchObject({ op: "golden.builderReach", builderId: "m1" });
  });

  it("sealGolden sends golden.seal with the builder id and returns manifest plus version", async () => {
    const { api, lastSent } = await connect();
    const version = { version: 1, snapshotId: "snap_1", baseTemplate: "default", kind: "desktop", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, manifest: { head: 1, versions: [version] }, version });
    const got = await api.sealGolden("m1");
    expect(lastSent()).toMatchObject({ op: "golden.seal", builderId: "m1" });
    expect(got.version).toEqual(version);
    expect(got.manifest.head).toBe(1);
  });
});

describe("ProtocolClient reconnect", () => {
  const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise(r => setTimeout(r, 5));
    }
  };
  function newClient(extra: Partial<ProtocolClientOptions> = {}) {
    ScriptedSocket.instances.length = 0;
    const statuses: ConnStatus[] = [];
    const client = new ProtocolClient({
      url: "ws://test",
      token: "tok",
      WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket,
      onStatus: s => statuses.push(s),
      ...extra,
    });
    return { client, statuses, socket: (n: number) => ScriptedSocket.instances[n]! };
  }
  beforeEach(() => {
    ScriptedSocket.authOk = true;
    ScriptedSocket.serverUp = true;
    ScriptedSocket.reply = () => undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a dropped socket comes back: redial, same token, events.subscribe re-armed, events flow again", async () => {
    const { client, statuses, socket } = newClient({ backoffMs: () => 0 });
    await client.connect();
    const seen: unknown[] = [];
    client.subscribe(e => seen.push(e));
    expect(socket(0).frames("events.subscribe")).toHaveLength(1);

    socket(0).drop(1006);
    expect(client.status).toBe("reconnecting");
    await until(() => client.status === "live");

    expect(ScriptedSocket.instances).toHaveLength(2);
    expect(socket(1).sent[0]).toEqual({ id: 0, op: "auth", token: "tok" });
    expect(socket(1).frames("events.subscribe")).toHaveLength(1);
    expect(statuses).toEqual(["live", "reconnecting", "live"]);

    socket(1).onmessage?.({ data: JSON.stringify({ type: "workspace.napped", workspaceId: "ws_1" }) });
    expect(seen).toEqual([{ type: "workspace.napped", workspaceId: "ws_1" }]);
    client.close();
  });

  it("requests in flight at the drop reject with DisconnectedError; so do requests made while reconnecting", async () => {
    const { client, socket } = newClient({ backoffMs: () => 10_000 });
    await client.connect();
    const inFlight = client.request("workspaces.list");
    socket(0).drop(1006);
    await expect(inFlight).rejects.toBeInstanceOf(DisconnectedError);
    await expect(inFlight).rejects.toMatchObject({ reason: "lost" });
    const whileDown = client.request("workspaces.list");
    await expect(whileDown).rejects.toBeInstanceOf(DisconnectedError);
    await expect(whileDown).rejects.toMatchObject({ reason: "lost" });
    client.close();
  });

  it("redials on the default schedule, 250 ms doubling to a 5 s cap, and starts over after a live", async () => {
    vi.useFakeTimers();
    const { client } = newClient();
    await client.connect();
    ScriptedSocket.serverUp = false;
    client.subscribe(() => {});
    ScriptedSocket.instances[0]!.drop(1006);

    let dials = 1;
    for (const wait of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(ScriptedSocket.instances).toHaveLength(dials);
      await vi.advanceTimersByTimeAsync(1);
      expect(ScriptedSocket.instances).toHaveLength(dials + 1);
      dials++;
    }
    expect(client.status).toBe("reconnecting");

    ScriptedSocket.serverUp = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.status).toBe("live");

    ScriptedSocket.instances[ScriptedSocket.instances.length - 1]!.drop(1006);
    const before = ScriptedSocket.instances.length;
    await vi.advanceTimersByTimeAsync(249);
    expect(ScriptedSocket.instances).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(ScriptedSocket.instances).toHaveLength(before + 1);
    client.close();
  });

  it("a rejected token is terminal: closed, no redial, requests say unauthorized", async () => {
    vi.useFakeTimers();
    ScriptedSocket.authOk = false;
    const { client, statuses } = newClient();
    await expect(client.connect()).rejects.toMatchObject({ reason: "unauthorized" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ScriptedSocket.instances).toHaveLength(1);
    expect(client.status).toBe("closed");
    expect(statuses).toEqual(["closed"]);
    await expect(client.request("workspaces.list")).rejects.toMatchObject({ reason: "unauthorized" });
  });

  it("close() ends the redial loop and settles as closed", async () => {
    vi.useFakeTimers();
    const { client, statuses } = newClient();
    await client.connect();
    ScriptedSocket.instances[0]!.drop(1006);
    client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ScriptedSocket.instances).toHaveLength(1);
    expect(statuses).toEqual(["live", "reconnecting", "closed"]);
    await expect(client.request("workspaces.list")).rejects.toMatchObject({ reason: "closed" });
  });

  it("before the first live it keeps dialling as connecting, never reconnecting", async () => {
    vi.useFakeTimers();
    ScriptedSocket.serverUp = false;
    const { client, statuses } = newClient();
    const opened = client.connect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ScriptedSocket.instances.length).toBeGreaterThan(2);
    expect(client.status).toBe("connecting");
    expect(statuses).toEqual([]);
    ScriptedSocket.serverUp = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await opened;
    expect(statuses).toEqual(["live"]);
    client.close();
  });
});
