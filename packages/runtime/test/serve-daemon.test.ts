// SPDX-License-Identifier: AGPL-3.0-only
// The daemon channel over the runtime's own socket: a real in-process daemon
// behind a stub machine whose route names it, driven through WsClient the way
// a page drives the host.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { LocalBackend } from "@wsp/engine";
import { relayedRefusal, rootsPathIn } from "@wsp/protocol";
import { DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { DAEMON_TOKEN_NONE } from "../src/daemon-token.js";
import { localExecStream } from "../src/local-exec.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { startRefusingDoor, type RefusingDoor } from "./refusing-door.js";
import { stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";
import { startTcpProxy, type TcpProxy } from "./tcp-proxy.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

const HOST_TOKEN = "secret";
const DAEMON_TOKEN = "cafef00d".repeat(3);
/** The same guest with its token file gone: the machine runs and there is no daemon on it to reach. */
const noDaemonGuest = (_m: unknown, cmd: string) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_NONE}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

let srv: RuntimeServer | undefined;
let rt: Runtime | undefined;
let daemon: DaemonHandle | undefined;
let proxy: TcpProxy | undefined;
let door: RefusingDoor | undefined;
let inboxDir: string | undefined;
let localRoot: string | undefined;

async function startTestDaemon(token = DAEMON_TOKEN): Promise<DaemonHandle> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-serve-daemon-"));
  return startDaemon({ port: 0, token, inboxDir, rootsPath: rootsPathIn(inboxDir), portsSource: async () => [], portsIntervalMs: 1000 });
}

/** A served runtime whose one workspace's machine reaches `url`; the reply is the workspace id. */
async function served(url: string, opts: { execImpl?: StubBackend["execImpl"] } = {}): Promise<{ backend: StubBackend; workspaceId: string }> {
  const backend = stubBackend();
  backend.execImpl = opts.execImpl ?? tokenGuest;
  rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN });
  srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
  const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
  backend.machines[0]!.previewUrl = async () => ({ url, token: "e", expiresAt: Date.now() + 3_600_000 });
  return { backend, workspaceId: ws.id };
}

const client = (): Promise<WsClient> => WsClient.connect(srv!.port, { token: HOST_TOKEN });

const framesOn = (c: WsClient, channel: string, type: string): Record<string, unknown>[] =>
  c.events.filter(e => e.type === type && e["channel"] === channel) as Record<string, unknown>[];

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await rt?.close();
  rt = undefined;
  await proxy?.close();
  proxy = undefined;
  await door?.close();
  door = undefined;
  await daemon?.close();
  daemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
  if (localRoot) rmSync(localRoot, { recursive: true, force: true });
  localRoot = undefined;
});

describe("daemon.open", () => {
  it("replies with a channel and pushes the daemon's hello to the socket that asked and to nobody else", async () => {
    daemon = await startTestDaemon();
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const mine = await client();
    const quiet = await client();
    const opened = await mine.request("daemon.open", { workspaceId });
    expect(opened.ok).toBe(true);
    const channel = String(opened["channel"]);
    expect(channel).not.toBe("");

    await until(() => framesOn(mine, channel, "daemon.event").length > 0);
    expect(framesOn(mine, channel, "daemon.event")[0]!["event"]).toMatchObject({ type: "daemon.hello" });
    expect(quiet.events).toEqual([]);
    mine.close();
    quiet.close();
  }, 15_000);

  it("carries the daemon's own refusal under an ok reply, and keeps a channel's events off another channel", async () => {
    daemon = await startTestDaemon();
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const c = await client();
    const first = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    const second = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    expect(second).not.toBe(first);

    const created = await c.request("daemon.send", { channel: first, frame: { op: "pty.create", cols: 80, rows: 24, shell: "/bin/sh" } });
    expect(created.ok).toBe(true);
    const ptyId = String((created["reply"] as Record<string, unknown>)["ptyId"]);
    await c.request("daemon.send", { channel: first, frame: { op: "pty.attach", ptyId } });
    await c.request("daemon.send", { channel: first, frame: { op: "pty.write", ptyId, data: "echo relay-mark-$((40 + 2))\r" } });
    await until(() => framesOn(c, first, "daemon.event").some(e => (e["event"] as Record<string, unknown>)["type"] === "pty.data" && String((e["event"] as Record<string, unknown>)["data"]).includes("relay-mark-42")), 10_000);
    // The second channel never attached, so the daemon pushed it nothing but its own hello.
    expect(framesOn(c, second, "daemon.event").map(e => (e["event"] as Record<string, unknown>)["type"])).toEqual(["daemon.hello"]);

    // The host carried the refusal rather than raising one of its own: ok at this level, the daemon's answer inside.
    const refused = await c.request("daemon.send", { channel: first, frame: { op: "fs.list", path: 7 } });
    expect(refused.ok).toBe(true);
    expect(refused["reply"]).toMatchObject({ ok: false, error: "path must be a string", code: "bad-request" });
    c.close();
  }, 20_000);

  it("a channel is never reachable from another socket, whatever id it guesses", async () => {
    daemon = await startTestDaemon();
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const owner = await client();
    const other = await client();
    const channel = String((await owner.request("daemon.open", { workspaceId }))["channel"]);

    const stolen = await other.request("daemon.send", { channel, frame: { op: "ping" } });
    expect(stolen).toMatchObject({ ok: false });
    expect(stolen["kind"]).toBeUndefined();
    expect(await owner.request("daemon.send", { channel, frame: { op: "ping" } })).toMatchObject({ ok: true, reply: { ok: true } });
    expect(await other.request("daemon.close", { channel })).toMatchObject({ ok: false });
    owner.close();
    other.close();
  }, 15_000);

  it("a socket that goes takes every channel it opened with it", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const { workspaceId } = await served(`ws://127.0.0.1:${proxy.port}`);
    const c = await client();
    await c.request("daemon.open", { workspaceId });
    await c.request("daemon.open", { workspaceId });
    expect(proxy.live()).toBe(2);
    c.close();
    await until(() => proxy!.live() === 0);
  }, 15_000);

  it("a daemon socket that ends under a channel says so once; a close the page asked for says nothing", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const { workspaceId } = await served(`ws://127.0.0.1:${proxy.port}`);
    const c = await client();
    const cut = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    const asked = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    expect(await c.request("daemon.close", { channel: asked })).toMatchObject({ ok: true });

    proxy.cutAll();
    await until(() => framesOn(c, cut, "daemon.closed").length > 0);
    expect(framesOn(c, cut, "daemon.closed")[0]).toMatchObject({ code: expect.any(Number), reason: expect.any(String) });
    // The page asked for that one, so nothing is pushed about it, then or later.
    expect(framesOn(c, asked, "daemon.closed")).toEqual([]);
    // A frame down a channel whose daemon socket ended is answered, not left hanging.
    expect(await c.request("daemon.send", { channel: cut, frame: { op: "ping" } })).toMatchObject({ ok: false });
    c.close();
  }, 15_000);
});

describe("daemon.open refusals name what shut the door", () => {
  it("a machine with no daemon yet is refused plainly, with no kind for the page to hold", async () => {
    const { workspaceId } = await served("ws://127.0.0.1:1", { execImpl: noDaemonGuest });
    const c = await client();
    const refused = await c.request("daemon.open", { workspaceId });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/no daemon/) });
    expect(refused["kind"]).toBeUndefined();
    c.close();
  });

  it("a daemon that refuses this host's token comes back kind reauth", async () => {
    daemon = await startTestDaemon("another-token");
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const c = await client();
    const refused = await c.request("daemon.open", { workspaceId });
    expect(refused).toMatchObject({ ok: false, kind: "reauth" });
    expect(String(refused["error"])).toContain("4401");
    c.close();
  }, 15_000);

  it("a door that answers the upgrade with a status comes back kind refused, carrying the status and its sentence", async () => {
    door = await startRefusingDoor();
    const { workspaceId } = await served(`http://127.0.0.1:${door.port}/`);
    const c = await client();
    const refused = await c.request("daemon.open", { workspaceId });
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(String(refused["error"])).toContain("403");
    expect(String(refused["error"])).toContain("cross-origin websocket denied");
    c.close();
  });

  it("an unknown workspace is refused before anything is dialled", async () => {
    const { workspaceId } = await served("ws://127.0.0.1:1");
    expect(workspaceId).not.toBe("");
    const c = await client();
    expect(await c.request("daemon.open", { workspaceId: "ws_nobody" })).toMatchObject({ ok: false, error: expect.stringMatching(/no such workspace/) });
    c.close();
  });
});

describe("who may open a channel", () => {
  it("a relayed socket opens a channel only for a workspace it may drive", async () => {
    daemon = await startTestDaemon();
    localRoot = mkdtempSync(join(tmpdir(), "wsp-serve-local-"));
    const road = { url: `ws://127.0.0.1:${daemon.port}`, expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN };
    const local: LocalWiring = {
      backend: new LocalBackend({ root: localRoot }),
      execStream: o => localExecStream({ root: localRoot!, ...o }),
      home: () => join(localRoot!, ".claude"),
      homeDir: localRoot,
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      daemonRoad: async () => road,
    };
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, local });
    srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
    const ws = await rt.workspaces.createLocal("this computer");

    const here = await client();
    expect(await here.request("daemon.open", { workspaceId: ws.id })).toMatchObject({ ok: true, channel: expect.any(String) });

    // A machine's road into this host drives no workspace of this computer's own, and the channel is one more verb.
    const ticket = String((await here.request("ticket.issue", { purpose: "relay" }))["ticket"]);
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("daemon.open", { workspaceId: ws.id })).toMatchObject({ ok: false, error: relayedRefusal("this computer") });

    here.close();
    relayed.close();
  }, 15_000);
});
