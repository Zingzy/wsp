// SPDX-License-Identifier: AGPL-3.0-only
// makeApi against a scripted socket: every wrapper sends the op serveRuntime
// dispatches and unwraps the field its reply carries.
import { describe, expect, it } from "vitest";
import { makeApi, ProtocolClient } from "../src/protocol/client.js";

type Frame = Record<string, unknown>;

class ScriptedSocket {
  static instances: ScriptedSocket[] = [];
  static reply: (frame: Frame) => Frame | undefined = () => undefined;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ScriptedSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    const reply = frame["op"] === "auth" ? { id: frame["id"], ok: true } : ScriptedSocket.reply(frame);
    if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }
  close(): void {
    this.onclose?.();
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
    const capabilities = { liveCloneForks: true, ramPreservingPause: true, resize: false, previewUrls: true, signedUrls: true };
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
