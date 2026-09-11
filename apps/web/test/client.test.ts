// SPDX-License-Identifier: AGPL-3.0-only
// makeApi against a scripted socket: every wrapper sends the op serveRuntime
// dispatches and unwraps the field its reply carries. The same socket plays a
// runtime that dies and comes back for the reconnect tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { DisconnectedError, makeApi, ProtocolClient, type ConnStatus, type ProtocolClientOptions } from "../src/protocol/client.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { caps } from "./caps.js";

/** Polls cond every 5 ms until it holds; the redial timer is a real setTimeout, so these tests wait on the wall clock. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 5));
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

  it("interruptSession sends sessions.interrupt with the runtime's session id and unwraps the outcome", async () => {
    const { api, lastSent } = await connect();
    const interrupt = api.interruptSession!;
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "not-running" });
    expect(await interrupt("s1")).toBe("not-running");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "sessions.interrupt", sessionId: "s1" });
    // An outcome outside the enum must not read as accepted.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "maybe" });
    await expect(interrupt("s1")).rejects.toThrow();
  });

  it("hostTerminalConfig sends host.terminalConfig with the scheme and unwraps the config the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const read = api.hostTerminalConfig!;
    const config = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: ["Berkeley Mono"], fontSize: 13, palette: Array<null>(16).fill(null), backgroundOpacity: 0.85 };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, config });
    expect(await read("light")).toEqual(config);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "host.terminalConfig", scheme: "light" });
    // A config the wire type does not vouch for is not applied: the pane would paint with a value it never checked.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, config: { ...config, backgroundOpacity: 2 } });
    await expect(read("dark")).rejects.toThrow();
  });

  it("preferences and setPreferences send the two preferences ops and unwrap the record the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const record = { theme: "light", sidebarMode: "spaces", sidebarWidth: 312, terminalSize: "app", terminalZoom: { ws_a: 2 }, access: { ws_a: "bypassPermissions" }, project: { ws_a: "spoo" }, target: { workspace: "ws_a", project: "spoo" }, labs: false };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, preferences: record });
    expect(await api.preferences!()).toEqual(record);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "preferences.get" });
    expect(await api.setPreferences!({ theme: "light", sidebarWidth: null })).toEqual(record);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "preferences.set", patch: { theme: "light", sidebarWidth: null } });
    // A record the wire type does not vouch for is not applied: the page would paint a theme it never checked.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, preferences: { ...record, theme: "sepia" } });
    await expect(api.preferences!()).rejects.toThrow();
  });

  it("setSessionAccess sends sessions.access with the runtime's session id and unwraps the outcome", async () => {
    const { api, lastSent } = await connect();
    const move = api.setSessionAccess!;
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "unsupported" });
    expect(await move("s1", "bypassPermissions")).toBe("unsupported");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "sessions.access", sessionId: "s1", permissionMode: "bypassPermissions" });
    // An outcome outside the enum must not read as set: the composer would say nothing and the turn would keep asking.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, outcome: "moved" });
    await expect(move("s1", "plan")).rejects.toThrow();
  });

  it("hostFolders sends host.folders with only the fields it was given and unwraps the level the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const browse = api.hostFolders!;
    const listing = { dir: "/Users/dev/code", roots: ["/Users/dev"], folders: [{ path: "/Users/dev/code/spoo", repo: true }], hidden: 2 };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, listing });
    expect(await browse()).toEqual(listing);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "host.folders" });
    expect(await browse("/Users/dev/code", true)).toEqual(listing);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "host.folders", dir: "/Users/dev/code", hidden: true });
    // A level the wire type does not vouch for is not walked: the picker would render a path it never checked.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, listing: { ...listing, folders: [{ path: "/Users/dev/code/spoo" }] } });
    await expect(browse()).rejects.toThrow();
  });

  it("planProject and importProject send the project ops and unwrap only what the wire type vouches for", async () => {
    const { api, lastSent } = await connect();
    const plan = { source: "/private/var/proj", repo: true, files: 3, bytes: 900, secrets: [{ path: ".env", bytes: 10, signals: ["name"] }], excluded: ["node_modules"], skipped: [], agents: [] };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, plan });
    expect(await api.planProject!("/var/proj")).toEqual(plan);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "project.plan", source: "/var/proj" });
    const imported = { dest: "/private/var/proj", files: 2, bytes: 800, parts: 1, cut: [".env"], rewritten: [], agents: [] };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, imported });
    expect(await api.importProject!({ workspaceId: "ws_1", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], agents: ["claude"], replace: true })).toEqual(imported);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "project.import", workspaceId: "ws_1", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], agents: ["claude"], replace: true });
    // A reply without the plan must not become a plan.
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    await expect(api.planProject!("/var/proj")).rejects.toThrow();
  });

  it("upgrade sends workspaces.upgrade with the size and unwraps the workspace", async () => {
    const { api, lastSent } = await connect();
    const workspace = { id: "ws_1", name: "x", machineId: "m2", phase: "running", golden: "g", createdAt: "t" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, workspace });
    const got = await api.upgrade("ws_1", { cpu: 4, memMb: 8192 });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.upgrade", workspaceId: "ws_1", cpu: 4, memMb: 8192 });
    expect(got).toEqual(workspace);
  });

  it("createWorkspace and createFromGoldenHead send a picked size as cpu and memMb, and nothing about size without one", async () => {
    const { api, lastSent } = await connect();
    const workspace = { id: "ws_1", name: "beta", machineId: "m1", phase: "running", golden: "snap_1", createdAt: "t" };
    const manifest = { head: 1, versions: [{ version: 1, snapshotId: "snap_1", baseTemplate: "default", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] };
    ScriptedSocket.reply = f => (f["op"] === "golden.get" ? { id: f["id"], ok: true, manifest } : { id: f["id"], ok: true, workspace });
    await api.createWorkspace("snap_1", "beta", { cpu: 2, memMb: 8192 });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.create", golden: "snap_1", name: "beta", cpu: 2, memMb: 8192 });
    await api.createFromGoldenHead("beta", { cpu: 2, memMb: 8192 });
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.create", golden: "snap_1", name: "beta", cpu: 2, memMb: 8192 });
    await api.createFromGoldenHead("beta");
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.create", golden: "snap_1", name: "beta" });
  });

  it("capabilities sends capabilities.get and unwraps the flags", async () => {
    const { api, lastSent } = await connect();
    const capabilities = caps({ resize: false, sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }] });
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

  it("snapshotWorkspace and listProjectGoldens send their ops and parse the replies; a reply without the list is refused", async () => {
    const { api, lastSent } = await connect();
    const golden = { snapshotId: "snap_p", projects: [{ name: "proj", dest: "/root/work/proj", importedAt: "2026-09-06T10:01:00.000Z" }], golden: "snap_g", version: 1, workspaceId: "ws_1", workspaceName: "task", createdAt: "2026-09-06T10:06:00.000Z" };
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, projectGolden: golden });
    expect(await api.snapshotWorkspace!("ws_1")).toEqual(golden);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "workspaces.snapshot", workspaceId: "ws_1" });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true, projectGoldens: [golden] });
    expect(await api.listProjectGoldens!()).toEqual([golden]);
    expect(lastSent()).toEqual({ id: expect.any(Number), op: "projectGoldens.list" });
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    await expect(api.listProjectGoldens!()).rejects.toThrow();
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

  it("a fork of a head that is not there refuses in the app's words, never with a command to run", async () => {
    const { api, lastSent } = await connect();
    ScriptedSocket.reply = f => ({ id: f["id"], ok: true });
    await expect(api.createFromGoldenHead("beta")).rejects.toThrow(CLOUD_SETUP_WORDS.create.none);
    await expect(api.createFromGoldenHead("beta")).rejects.not.toThrow(/wspx|golden build/);
    expect(lastSent()).toMatchObject({ op: "golden.get" });
  });
});

describe("ProtocolClient reconnect", () => {
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

describe("ProtocolClient event cursor", () => {
  function newClient(extra: Partial<ProtocolClientOptions> = {}) {
    ScriptedSocket.instances.length = 0;
    const gaps: number[] = [];
    const client = new ProtocolClient({
      url: "ws://test",
      token: "tok",
      WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket,
      backoffMs: () => 0,
      onGap: () => gaps.push(gaps.length + 1),
      ...extra,
    });
    return { client, gaps, socket: (n: number) => ScriptedSocket.instances[n]! };
  }
  /** The runtime's subscribe reply: head first, the same head after a redial unless a test overrides it. */
  const subscribeReply = (seq: number, gap = false, stream = "stream-a") => (f: Frame) =>
    f["op"] === "events.subscribe" ? { id: f["id"], ok: true, seq, stream, ...(gap ? { gap: true } : {}) } : undefined;
  const push = (sock: ScriptedSocket, e: Record<string, unknown>) => sock.onmessage?.({ data: JSON.stringify(e) });
  /** Lets the scripted socket deliver the subscribe reply, which a real socket puts on the wire before any event. */
  const replied = () => new Promise(r => setTimeout(r, 0));
  const redial = async (client: ProtocolClient, sock: ScriptedSocket) => {
    sock.drop(1006);
    await until(() => client.status === "live");
  };
  beforeEach(() => {
    ScriptedSocket.authOk = true;
    ScriptedSocket.serverUp = true;
    ScriptedSocket.reply = () => undefined;
  });

  it("the first subscribe carries no cursor; a re-subscribe carries the seq of the last event seen", async () => {
    ScriptedSocket.reply = subscribeReply(2);
    const { client, socket } = newClient();
    await client.connect();
    const seen: unknown[] = [];
    client.subscribe(e => seen.push(e));
    expect(socket(0).frames("events.subscribe")).toEqual([{ id: expect.any(Number), op: "events.subscribe" }]);
    await replied();

    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1", seq: 3 });
    push(socket(0), { type: "workspace.woken", workspaceId: "ws_1", machineId: "m2", resurrected: false, seq: 4 });
    expect(seen).toHaveLength(2);

    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")).toEqual([{ id: expect.any(Number), op: "events.subscribe", after: 4, stream: "stream-a" }]);
    // Replayed events move the cursor like live ones.
    push(socket(1), { type: "workspace.napped", workspaceId: "ws_1", seq: 5 });
    await redial(client, socket(1));
    expect(socket(2).frames("events.subscribe")[0]).toMatchObject({ after: 5 });
    client.close();
  });

  it("with no event seen yet the cursor starts at the reply's head, so a quiet tab still gets what a drop hid", async () => {
    ScriptedSocket.reply = subscribeReply(9);
    const { client, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    await until(() => socket(0).frames("events.subscribe").length === 1);
    await new Promise(r => setTimeout(r, 0));
    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")[0]).toMatchObject({ after: 9 });
    client.close();
  });

  it("a gap reply fires onGap once and moves the cursor to the runtime's head", async () => {
    ScriptedSocket.reply = subscribeReply(2);
    const { client, gaps, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1", seq: 3 });

    ScriptedSocket.reply = subscribeReply(40, true);
    await redial(client, socket(0));
    await until(() => gaps.length === 1);
    expect(socket(1).frames("events.subscribe")[0]).toMatchObject({ after: 3 });

    ScriptedSocket.reply = subscribeReply(40);
    await redial(client, socket(1));
    expect(socket(2).frames("events.subscribe")[0]).toMatchObject({ after: 40 });
    expect(gaps).toEqual([1]);
    client.close();
  });

  it("a reply from a different stream is a gap even without the marker: onGap fires and the cursor restarts at that head", async () => {
    ScriptedSocket.reply = subscribeReply(2);
    const { client, gaps, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    await replied();
    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1", seq: 3 });

    ScriptedSocket.reply = subscribeReply(1, false, "stream-b");
    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")[0]).toMatchObject({ after: 3, stream: "stream-a" });
    await until(() => gaps.length === 1);

    ScriptedSocket.reply = subscribeReply(1, false, "stream-b");
    await redial(client, socket(1));
    expect(socket(2).frames("events.subscribe")[0]).toMatchObject({ after: 1, stream: "stream-b" });
    expect(gaps).toEqual([1]);
    client.close();
  });

  it("a reply without a head and events without seq leave the cursor where it was", async () => {
    ScriptedSocket.reply = f => (f["op"] === "events.subscribe" ? { id: f["id"], ok: true } : undefined);
    const { client, gaps, socket } = newClient();
    await client.connect();
    client.subscribe(() => {});
    push(socket(0), { type: "workspace.napped", workspaceId: "ws_1" });
    await redial(client, socket(0));
    expect(socket(1).frames("events.subscribe")).toEqual([{ id: expect.any(Number), op: "events.subscribe" }]);
    expect(gaps).toEqual([]);
    client.close();
  });
});
