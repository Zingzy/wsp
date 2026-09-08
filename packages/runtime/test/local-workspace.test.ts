// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { alreadyRecorded, RELAY_TICKET_REFUSAL, relayedRecordRefusal, relayedRefusal, THIS_COMPUTER, type PortForward } from "@wsp/protocol";
import type { MachineExecOptions } from "../src/machine-exec.js";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type ProjectExportOptions, type ProjectImportOptions, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { serveRuntime, type ForwardsSource } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

/** A scripted adapter that runs one real command on the machine it was given through ctx.execStream and answers with
 * its output: on a local workspace ctx.execStream is the local child factory, so a reply landing proves the runtime
 * drove the local backend. */
const echoAdapter: HarnessAdapterFactory = ctx => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const finished = (async () => {
      const stream = ctx.execStream("printf pong", { env: { ...ctx.env } });
      let out = "";
      for await (const line of stream.lines) out += line;
      await stream.exited;
      onEvent({ type: "session.start", sessionId });
      onEvent({ type: "turn.delta", sessionId, kind: "text", text: out });
      const result = { status: "completed", text: out } as const;
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

describe("local workspace", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;
  /** Every options object the registry handed the local factory, in order. */
  let handed: (MachineExecOptions | undefined)[];
  /** Stands in for the loopback daemon the host starts: a plain GET to a WebSocket server is answered 426, which is
   * what the status probe reads as the daemon being up. */
  let probe: { port: number; close: () => Promise<void> };
  const runtime = (): Runtime =>
    createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });

  beforeAll(async () => {
    const server = createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    probe = { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(done => server.close(() => done())) };
  });
  afterAll(() => probe.close());

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localws-"));
    store = memoryStore();
    handed = [];
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => {
        handed.push(o);
        return localExecStream({ root, ...o });
      },
      home: () => join(root, ".claude"),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("wsp new --local makes the one local workspace, listed with kind local and no image", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("my-mac");
    expect(ws.kind).toBe("local");
    expect(ws.name).toBe("my-mac");
    expect(ws.golden).toBe("");
    expect(ws.phase).toBe("running");
    const listed = await rt.workspaces.list();
    expect(listed.map(w => ({ name: w.name, kind: w.kind }))).toEqual([{ name: "my-mac", kind: "local" }]);
  });

  it("there is one local workspace per host", async () => {
    const rt = runtime();
    await rt.workspaces.createLocal("mac");
    await expect(rt.workspaces.createLocal("mac2")).rejects.toThrow(alreadyRecorded(THIS_COMPUTER, "mac"));
  });

  it("a thread starts on the local workspace and its reply lands, run through the local exec stream", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const handle = await rt.sessions.start(ws.id, { prompt: "say pong" });
    const result = await handle.finished;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("pong");
  });

  it("the registry hands the local factory the same limits a cloud turn gets: the turn's own by default, none for the exec verb", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    await (await rt.sessions.start(ws.id, { prompt: "say pong" })).finished;
    const stream = await rt.workspaces.execStream(ws.id, ["true"]);
    for await (const _line of stream.lines) void _line;
    await stream.exited;
    // The adapter is built once per road that asks it something (catalog, title, the turn), each with the turn's own limits.
    expect(handed.length).toBeGreaterThan(1);
    expect(handed.slice(0, -1).every(o => o === undefined)).toBe(true);
    expect(handed.at(-1)).toEqual({ idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY });
  });

  it("exec runs on this computer and returns the exit code; files read and write under the folder", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    expect((await rt.workspaces.exec(ws.id, "exit 4")).exitCode).toBe(4);
    expect((await rt.workspaces.exec(ws.id, "printf saved > f.txt")).exitCode).toBe(0);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("saved");
    expect((await rt.workspaces.exec(ws.id, "cat f.txt")).stdout).toBe("saved");
  });

  it("every verb its machine cannot take refuses with the capability's sentence", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const cannot = /is this computer, not a machine wsp runs; it cannot/;
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow(cannot);
    // A computer is running while the host is: the wake every thread road sends first is a no-op, not a refusal.
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    await expect(rt.workspaces.upgrade(ws.id, { cpu: 4, memMb: 8192 })).rejects.toThrow(cannot);
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toThrow(cannot);
  });

  it("every verb refuses a request relayed from a machine with the one sentence", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const thread = await rt.sessions.start(ws.id, { prompt: "hi" });
    await thread.finished;
    const sessionId = thread.view().id;
    const bundler = {} as ProjectImportOptions["bundler"];
    const lander = {} as ProjectExportOptions["lander"];
    const verbs: [string, () => Promise<unknown>][] = [
      ["workspaces.get", () => rt.workspaces.get(ws.id, "relayed")],
      ["workspaces.nap", () => rt.workspaces.nap(ws.id, "relayed")],
      ["workspaces.wake", () => rt.workspaces.wake(ws.id, "relayed")],
      ["workspaces.upgrade", () => rt.workspaces.upgrade(ws.id, { cpu: 4 }, "relayed")],
      ["workspaces.updateImage", () => rt.workspaces.updateImage(ws.id, "relayed")],
      ["workspaces.rebuild", () => rt.workspaces.rebuild(ws.id, "relayed")],
      ["workspaces.rename", () => rt.workspaces.rename(ws.id, "mac2", "relayed")],
      ["workspaces.look", () => rt.workspaces.look(ws.id, { tint: "cyan" }, "relayed")],
      ["workspaces.snapshot", () => rt.workspaces.snapshot(ws.id, "relayed")],
      ["workspaces.updateDaemon", () => rt.workspaces.updateDaemon(ws.id, "relayed")],
      ["workspaces.delete", () => rt.workspaces.delete(ws.id, "relayed")],
      ["workspaces.forget", () => rt.workspaces.forget(ws.id, "relayed")],
      ["workspaces.touch", () => rt.workspaces.touch(ws.id, "relayed")],
      ["workspaces.exec", () => rt.workspaces.exec(ws.id, "true", undefined, "relayed")],
      ["workspaces.execStream", () => rt.workspaces.execStream(ws.id, ["true"], undefined, "relayed")],
      ["workspaces.daemonReach", () => rt.workspaces.daemonReach(ws.id, "relayed")],
      ["workspaces.portReach", () => rt.workspaces.portReach(ws.id, 3000, "relayed")],
      ["workspaces.portProbe", () => rt.workspaces.portProbe(ws.id, 3000, "relayed")],
      ["sessions.start", () => rt.sessions.start(ws.id, { prompt: "hi" }, "relayed")],
      ["sessions.history", () => rt.sessions.history(ws.id, "relayed")],
      ["sessions.list", () => rt.sessions.list(ws.id, "relayed")],
      ["sessions.interrupt", () => rt.sessions.interrupt(sessionId, "relayed")],
      ["sessions.steer", () => rt.sessions.steer(sessionId, { prompt: "hi" }, "relayed")],
      ["sessions.rename", () => rt.sessions.rename(sessionId, "a name", "relayed")],
      ["harnesses.list", () => rt.harnesses.list(ws.id, "relayed")],
      ["projects.import", () => rt.projects.import({ workspaceId: ws.id, source: "/s", dest: "/d", bundler }, "relayed")],
      ["projects.export", () => rt.projects.export({ workspaceId: ws.id, source: "/s", dest: "/d", lander }, "relayed")],
      ["status.history", () => rt.status.history(ws.id, "relayed")],
    ];
    // Every verb is asked, so a verb that stops refusing is named rather than hidden behind the first failure.
    const answered: string[] = [];
    for (const [name, call] of verbs) {
      const said = await call().then(() => "answered it", (e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (said !== relayedRefusal("mac")) answered.push(`${name}: ${said}`);
    }
    expect(answered).toEqual([]);
    // Recording one is refused by the rule about who records a machine, not by the kind: its own sentence, since a
    // relayed request may not make a workspace of any kind on this computer.
    await expect(rt.workspaces.createLocal("mac2", "relayed")).rejects.toThrow(relayedRecordRefusal("mac2"));
    // Nothing was driven: the workspace is still there under its own name, and a request from this computer runs.
    expect((await rt.workspaces.get(ws.id)).name).toBe("mac");
    expect((await rt.sessions.start(ws.id, { prompt: "hi" }, "here").then(h => h.finished)).status).toBe("completed");
  });

  it("a cloud workspace takes a relayed request, so the rule is the kind's and not the verb's", async () => {
    const rt = runtime();
    const cloud = await rt.workspaces.create({ golden: "snap_g", name: "b1" }, "relayed");
    expect((await rt.workspaces.get(cloud.id, "relayed")).name).toBe("b1");
    await rt.workspaces.touch(cloud.id, "relayed");
  });

  it("the lists served to a relayed request leave the local workspace and its threads out", async () => {
    const rt = runtime();
    const local = await rt.workspaces.createLocal("mac");
    const cloud = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await (await rt.sessions.start(local.id, { prompt: "hi" })).finished;
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["b1", "mac"]);
    expect((await rt.workspaces.list("relayed")).map(w => w.name)).toEqual(["b1"]);
    expect((await rt.status.list()).map(w => w.name).sort()).toEqual(["b1", "mac"]);
    expect((await rt.status.list(undefined, "relayed")).map(w => w.name)).toEqual(["b1"]);
    expect((await rt.sessions.list()).map(v => v.workspaceId)).toEqual([local.id]);
    expect(await rt.sessions.list(undefined, "relayed")).toEqual([]);
  });

  it("origin rides the wire on every verb, not only on a thread start", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    try {
      const c = await WsClient.connect(srv.port, { token: "secret" });
      const napped = await c.request("workspaces.nap", { workspaceId: ws.id, origin: "relayed" });
      expect(napped.ok).toBe(false);
      expect(napped["error"]).toBe(relayedRefusal("mac"));
      expect((await c.request("workspaces.list", { origin: "relayed" }))["workspaces"]).toEqual([]);
      // A client on this computer names no origin, and the workspace answers it.
      expect((await c.request("workspaces.list"))["workspaces"]).toHaveLength(1);
      expect((await c.request("workspaces.rename", { workspaceId: ws.id, name: "mini", origin: "relayed" }))["error"]).toBe(relayedRefusal("mac"));
      c.close();
    } finally {
      await srv.close();
    }
  });

  it("a machine's socket is stamped relayed by the host, whatever origin its client sends", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    try {
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const relay = await here.request("ticket.issue", { purpose: "relay" });
      const machine = await WsClient.connect(srv.port, { ticket: relay["ticket"] as string });
      // The client fills the field in with this computer's own word; the road it arrived on answers for it instead.
      expect((await machine.request("workspaces.get", { workspaceId: ws.id, origin: "here" }))["error"]).toBe(relayedRefusal("mac"));
      expect((await machine.request("workspaces.list", { origin: "here" }))["workspaces"]).toEqual([]);
      // Nor can it mint itself a ticket to come back as one of the person's own clients.
      expect((await machine.request("ticket.issue", { purpose: "connect" }))["error"]).toBe(RELAY_TICKET_REFUSAL);
      // The same ticket road with a connect purpose is a client of the person's own, and the workspace answers it.
      const connect = await here.request("ticket.issue", { purpose: "connect" });
      const mine = await WsClient.connect(srv.port, { ticket: connect["ticket"] as string });
      expect((await mine.request("workspaces.get", { workspaceId: ws.id }))["workspace"]).toMatchObject({ name: "mac" });
      here.close();
      machine.close();
      mine.close();
    } finally {
      await srv.close();
    }
  });

  it("the port forwards the host holds read the same rule: a relayed request neither lists nor stops one on this computer", async () => {
    const rt = runtime();
    const local = await rt.workspaces.createLocal("mac");
    const cloud = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    const row = (workspaceId: string, port: number, name: string): PortForward => ({ workspaceId, port, startedAt: "2026-09-08T00:00:00.000Z", name, kind: "url" });
    // The host forwards a builder's ports too, and no workspace record names a builder.
    const rows = [row(local.id, 8123, "mac"), row(cloud.id, 8124, "b1"), row("m_builder", 8125, "setup (builder)")];
    const stops: string[] = [];
    const forwards: ForwardsSource = {
      list: () => rows,
      stop: (workspaceId, port) => {
        stops.push(`${workspaceId}:${port}`);
        return true;
      },
      on: () => () => {},
    };
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", forwards });
    try {
      const c = await WsClient.connect(srv.port, { token: "secret" });
      const ports = async (params?: Record<string, unknown>): Promise<number[]> => ((await c.request("forwards.list", params))["forwards"] as PortForward[]).map(f => f.port);
      const stopped = async (workspaceId: string, port: number): Promise<string> => (await c.request("forwards.stop", { workspaceId, port, origin: "relayed" }))["error"] as string ?? "stopped it";
      // Both halves are read before anything is asserted, so a half that stops holding is named rather than hidden.
      const seen = {
        listedHere: await ports(),
        listedRelayed: await ports({ origin: "relayed" }),
        localStop: await stopped(local.id, 8123),
        cloudStop: await stopped(cloud.id, 8124),
        builderStop: await stopped("m_builder", 8125),
        asked: stops,
      };
      expect(seen).toEqual({
        listedHere: [8123, 8124, 8125],
        listedRelayed: [8124, 8125],
        localStop: relayedRefusal("mac"),
        cloudStop: "stopped it",
        builderStop: "stopped it",
        asked: [`${cloud.id}:8124`, "m_builder:8125"],
      });
      c.close();
    } finally {
      await srv.close();
    }
  });

  it("delete drops the record and nothing else; the computer is not stopped", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    await rt.workspaces.delete(ws.id);
    expect(await rt.workspaces.list()).toEqual([]);
    // The record survives a delete only in the store's absence of it; a fresh runtime lists none.
    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    expect(await rt2.workspaces.list()).toEqual([]);
  });

  it("the local workspace survives a runtime restart, hydrated straight off the local backend as running", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    const listed = await rt2.workspaces.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: ws.id, kind: "local", phase: "running" });
    // A thread still runs on it after the restart.
    const handle = await rt2.sessions.start(ws.id, { prompt: "again" });
    expect((await handle.finished).text).toBe("pong");
  });

  it("the local row's rate is zero: its rate follows the local backend's pricing, not the cloud one's", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const status = (await rt.status.list()).find(s => s.id === ws.id)!;
    expect(status.rateUsdPerHour).toBe(0);
    expect(status.kind).toBe("local");
  });

  it("the panes dial this computer's own daemon: workspaces.daemonReach hands out the road the host wired", async () => {
    const road = { url: "http://127.0.0.1:54321", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t0ken" };
    localWiring = { ...localWiring, daemonRoad: async () => road };
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    expect(await rt.workspaces.daemonReach(ws.id)).toEqual(road);
  });

  it("a host that wired no daemon for this computer says so rather than minting a preview route", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("wired no daemon for its local workspace");
  });

  it("the status probe reads the local road: reachable with one wired, unsupported without", async () => {
    const withRoad = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: { ...localWiring, daemonRoad: async () => ({ url: `http://127.0.0.1:${probe.port}`, expiresAt: Number.MAX_SAFE_INTEGER }) } });
    const dialled = await withRoad.workspaces.createLocal("mac");
    expect((await withRoad.status.list()).find(s => s.id === dialled.id)!.reach.state).toBe("reachable");
    await withRoad.close();
    const bare = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: echoAdapter }, local: localWiring });
    const alone = await bare.workspaces.createLocal("mac");
    expect((await bare.status.list()).find(s => s.id === alone.id)!.reach.state).toBe("unsupported");
    await bare.close();
  });

  it("closing the runtime frees what the local wiring holds open on this computer", async () => {
    let closed = 0;
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: { ...localWiring, close: async () => void closed++ } });
    await rt.workspaces.createLocal("mac");
    await rt.close();
    expect(closed).toBe(1);
  });

  it("this computer holds no machine slot: at the cap one cloud record still leaves a slot, and the refusal never names the local row", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: echoAdapter }, local: localWiring });
    await rt.workspaces.createLocal("zingzys-MacBook-Pro.local");
    await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await rt.workspaces.create({ golden: "snap_g", name: "b3" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("a machine slot is in use: b2. Pause it or wait for a nap.");
  });

  it("with no cloud record at all the refusal claims no holder, since this computer holds none", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: echoAdapter }, local: localWiring });
    await rt.workspaces.createLocal("zingzys-MacBook-Pro.local");
    backend.create = async () => {
      throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
    };
    const refused = await rt.workspaces.create({ golden: "snap_g", name: "b1" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("the provider is at its machine cap and no machine of this computer holds a slot; free one at the provider and try again");
  });

  it("createLocal is refused when no local backend is wired", async () => {
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter } });
    await expect(rt.workspaces.createLocal("mac")).rejects.toThrow("no local backend wired");
  });
});

describe("a local turn and a host restart", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localcut-"));
    store = memoryStore();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, ...o }),
      home: () => join(root, ".claude"),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A turn that starts and never replies, the way a real one looks while the agent is still working. */
  const hangingAdapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: ({ onEvent }) => {
      const sessionId = "33333333-3333-4333-8333-333333333333";
      onEvent({ type: "session.start", sessionId, cwd: "/root" });
      return { localId: sessionId, finished: new Promise(() => {}), interrupt: async () => {} };
    },
  });

  it("a local turn dies with the host that started it, so a restart settles it as cut with one honest line and the next send resumes past it", async () => {
    const rt1 = createRuntime({ backend: stubBackend(), store, adapters: { claude: hangingAdapter }, local: localWiring });
    const ws = await rt1.workspaces.createLocal("mac");
    const handle = await rt1.sessions.start(ws.id, { prompt: "build it" });
    expect((await rt1.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    // A local turn's harness is a child of this host: nothing on a machine outlives it, so the local exec factory
    // offers no attach and the next host has no run to re-open.
    expect(localExecStream({ root }).attach).toBeUndefined();
    await rt1.close();

    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: hangingAdapter }, local: localWiring });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["failed"]);
    const history = await rt2.sessions.history(ws.id);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: null, reason: "host restarted while the agent was working" });
    expect((await rt2.sessions.list(ws.id))[0]!.endedAt).toBeDefined();
    await rt2.close();

    // The thread is not lost: the next send resumes it and says the transcript may be missing what the cut turn did.
    const rt3 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    const resumed = await rt3.sessions.start(ws.id, { prompt: "carry on", thread: handle.view().threadId });
    await resumed.finished;
    const starts = (await rt3.sessions.history(ws.id)).filter(e => e.type === "session.start");
    expect(starts.at(-1)).toMatchObject({ prompt: "carry on", afterCut: true });
    await rt3.close();
  });
});

describe("one registry for what a workspace's kind means", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  /** A comparison on the kind, or a switch arm for it, anywhere in source: every road reads a capability or asks the
   * kind's module in the runtime's registry table instead. */
  const RULE = /\bkind\s*[!=]==\s*"(local|cloud|ssh)"|case "(local|cloud|ssh)":/;
  const sourceFiles = (): string[] => {
    const out: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        let files: string[];
        try {
          files = readdirSync(join(ROOT, top, pkg.name, "src"), { recursive: true, encoding: "utf8" });
        } catch {
          continue;
        }
        for (const f of files) if (/\.tsx?$/.test(f)) out.push(join(top, pkg.name, "src", f));
      }
    }
    return out;
  };

  it("no source file compares a workspace's kind; the registry table is the one place it is read", () => {
    expect(sourceFiles().filter(rel => RULE.test(readFileSync(join(ROOT, rel), "utf8")))).toEqual([]);
  });
});
