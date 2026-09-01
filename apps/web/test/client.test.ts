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

  it("a rejected op surfaces the runtime's error message", async () => {
    const { api } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: false, error: "workspace is napping" });
    await expect(api.startSession({ workspaceId: "ws_1", prompt: "x" })).rejects.toThrow("workspace is napping");
  });
});
