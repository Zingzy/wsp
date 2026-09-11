// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import {
  AGENTS_ON,
  GUEST_WSP_BIN,
  HOST_TOKEN_ENV,
  HOST_URL_ENV,
  MCP_SERVER_NAME,
  RUNTIME_OPS,
  THREAD_OPS,
  threadOpRefusal,
  workspaceIdOf,
  agentsKindRefusal,
  agentsOffRefusal,
  noMcpServersLine,
  spawnActRefusal,
  spawnCapRefusal,
  spawnDepthRefusal,
  spawnReachRefusal,
  threadWord,
  type Caller,
  type McpServerSpec,
  type ThreadScope,
  type TurnResult,
} from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

/** What each turn's launch was handed, so a test reads the environment and the servers the runtime built rather
 * than trusting the record. The turn holds until it is ended by hand, which is the window a scoped token stands in. */
function heldAdapter(opts: { takesMcpServers?: true } = {}): {
  factory: HarnessAdapterFactory;
  launches: { env: Readonly<Record<string, string>>; mcpServers?: Readonly<Record<string, McpServerSpec>> }[];
  end: (nth: number) => void;
} {
  const ends: (() => void)[] = [];
  const launches: { env: Readonly<Record<string, string>>; mcpServers?: Readonly<Record<string, McpServerSpec>> }[] = [];
  const factory: HarnessAdapterFactory = ctx => ({
    steers: false,
    ...(opts.takesMcpServers === true ? { mcpServers: true as const } : {}),
    start: ({ resume, mcpServers, onEvent }) => {
      const sessionId = resume ?? randomUUID();
      launches.push({ env: { ...ctx.env }, ...(mcpServers !== undefined ? { mcpServers } : {}) });
      const result: TurnResult = { status: "completed", text: "done" };
      let over = false;
      let mine!: () => void;
      const finished = new Promise<TurnResult>(resolve => {
        mine = () => {
          if (over) return;
          over = true;
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      ends.push(mine);
      onEvent({ type: "session.start", sessionId });
      // Its own turn, never the newest: a stop that cascades reaches each turn through its own handle.
      return { localId: sessionId, finished, interrupt: async () => mine() };
    },
  });
  return { factory, launches, end: nth => ends[nth]!() };
}

describe("agents spawning agents", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;

  const runtimeWith = (adapters: Record<string, HarnessAdapterFactory>, agents?: { url?: string; wspMcp?: McpServerSpec }): Runtime =>
    createRuntime({ backend: stubBackend(), store, adapters, local: localWiring, ...(agents !== undefined ? { agents } : {}) });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-spawn-"));
    store = memoryStore();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Waits for the host's own bookkeeping after a turn's reply: the revoke rides the exit rather than the reply,
   * so a reader that asks the instant the reply lands may ask before the token is gone. */
  const gone = async (rt: Runtime): Promise<void> => {
    for (let tries = 50; tries > 0 && (await rt.devices.list()).length > 0; tries--) await new Promise(r => setTimeout(r, 10));
  };

  /** A caller that is a thread on a machine, as the door builds one off a scoped device token. */
  const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

  it("a workspace with no switch lets its agents open nothing and fork nothing", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    await expect(rt.sessions.start(ws.id, { prompt: "hi" }, asThread(scope))).rejects.toThrow(agentsOffRefusal("b1", "thread_new"));
    await expect(rt.workspaces.create({ golden: "snap_g", name: "b2" }, asThread(scope))).rejects.toThrow(agentsOffRefusal("b1", "fork"));
    await rt.close();
  });

  it("with the switch on, a fork by a thread records the thread that asked and the root of its tree", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const forked = await rt.workspaces.create({ golden: "snap_g", name: "builder" }, asThread(scope));
    expect(forked.parentThreadId).toBe(rootThread);
    expect(forked.rootThreadId).toBe(rootThread);
    // The fork stores no switch of its own; what it may do is the tree's, read off the workspace its root runs on.
    expect(forked.agents).toEqual(AGENTS_ON);
    held.end(0);
    await rt.close();
  });

  it("the machine past the cap is refused with the sentence naming the root and the count", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 1 } });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    await rt.workspaces.create({ golden: "snap_g", name: "b1" }, asThread(scope));
    await rt.workspaces.create({ golden: "snap_g", name: "b2" }, asThread(scope));
    await expect(rt.workspaces.create({ golden: "snap_g", name: "b3" }, asThread(scope))).rejects.toThrow(spawnCapRefusal("t_root", 2, 2));
    // A machine deleted gives its place back, counted off the records rather than off a number kept somewhere.
    const b1 = (await rt.workspaces.list()).find(w => w.name === "b1")!;
    await rt.workspaces.delete(b1.id);
    const b3 = await rt.workspaces.create({ golden: "snap_g", name: "b3" }, asThread(scope));
    expect(b3.rootThreadId).toBe("t_root");
    await rt.close();
  });

  it("a thread the tree already spawned may not spawn again at one level", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    // The root opens a thread of its own: allowed, and the row records the tree.
    const child = await rt.sessions.start(ws.id, { prompt: "builder" }, asThread(rootScope));
    const childThread = child.view().threadId!;
    expect(child.view().parentThreadId).toBe(rootThread);
    expect(child.view().rootThreadId).toBe(rootThread);
    const childScope: ThreadScope = { kind: "thread", threadId: childThread, workspaceId: ws.id, rootThreadId: rootThread };
    await expect(rt.sessions.start(ws.id, { prompt: "grandchild" }, asThread(childScope))).rejects.toThrow(spawnDepthRefusal(childThread, 1, 1));
    await expect(rt.workspaces.create({ golden: "snap_g", name: "deep" }, asThread(childScope))).rejects.toThrow(spawnDepthRefusal(childThread, 1, 1));
    held.end(1);
    held.end(0);
    await rt.close();
  });

  it("a thread may send into a thread of its own tree however deep it sits", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    held.end(0);
    await opener.finished;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const again = await rt.sessions.start(ws.id, { prompt: "more", thread: rootThread }, asThread(rootScope));
    expect(again.view().threadId).toBe(rootThread);
    held.end(1);
    await again.finished;
    await rt.close();
  });

  it("the acts that are nobody's but the person's are refused by name", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    await expect(rt.workspaces.delete(ws.id, asThread(scope))).rejects.toThrow(spawnActRefusal("t_root", "delete"));
    await expect(rt.workspaces.nap(ws.id, asThread(scope))).rejects.toThrow(spawnActRefusal("t_root", "pause"));
    await expect(rt.workspaces.agents(ws.id, { spawn: false }, asThread(scope))).rejects.toThrow(spawnActRefusal("t_root", "agents"));
    await rt.close();
  });

  it("a thread reaches the workspace it runs on and the ones its root forked, and no other", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const mine = await rt.workspaces.create({ golden: "snap_g", name: "mine", agents: AGENTS_ON });
    const theirs = await rt.workspaces.create({ golden: "snap_g", name: "theirs", agents: AGENTS_ON });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: mine.id, rootThreadId: "t_root" };
    const forked = await rt.workspaces.create({ golden: "snap_g", name: "ours" }, asThread(scope));
    expect((await rt.workspaces.get(forked.id, asThread(scope))).name).toBe("ours");
    await expect(rt.sessions.start(theirs.id, { prompt: "hi" }, asThread(scope))).rejects.toThrow(spawnReachRefusal("t_root", "theirs"));
    await expect(rt.workspaces.get(theirs.id, asThread(scope))).rejects.toThrow(spawnReachRefusal("t_root", "theirs"));
    // The listing leaves out what it may not drive rather than naming it.
    expect((await rt.workspaces.list(asThread(scope))).map(w => w.name).sort()).toEqual(["mine", "ours"]);
    await rt.close();
  });

  it("a turn on a spawn enabled workspace carries a scoped device that is taken away at the exit", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const threadId = handle.view().threadId!;
    const listed = await rt.devices.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe(`thread ${threadWord(threadId)}`);
    expect(listed[0]!.scope).toEqual({ kind: "thread", threadId, workspaceId: ws.id, rootThreadId: threadId });
    const launch = held.launches[0]!;
    expect(launch.env[HOST_URL_ENV]).toBe("http://10.0.0.2:4700");
    expect(launch.env[HOST_TOKEN_ENV]).toMatch(/\S/);
    held.end(0);
    await handle.finished;
    await gone(rt);
    expect(await rt.devices.list()).toEqual([]);
    await rt.close();
  });

  it("a host that knows no address a machine can dial hands out no token at all", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(await rt.devices.list()).toEqual([]);
    expect(held.launches[0]!.env[HOST_TOKEN_ENV]).toBeUndefined();
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("a workspace with the switch off hands out no token either", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "quiet" });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(await rt.devices.list()).toEqual([]);
    expect(held.launches[0]!.env[HOST_URL_ENV]).toBeUndefined();
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("the wsp tools ride the launch on a harness that takes servers, at the path the daemon bundle put them", async () => {
    const held = heldAdapter({ takesMcpServers: true });
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(held.launches[0]!.mcpServers?.[MCP_SERVER_NAME]).toEqual({ command: "node", args: [GUEST_WSP_BIN, "mcp", "--host", "http://10.0.0.2:4700"] });
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("a harness that takes no server with a launch gets none and is refused only where a caller named its own", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ codex: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi", harness: "codex" });
    expect(held.launches[0]!.mcpServers).toBeUndefined();
    held.end(0);
    await handle.finished;
    await expect(rt.sessions.start(ws.id, { prompt: "hi", harness: "codex", mcpServers: { mine: { command: "x", args: [] } } })).rejects.toThrow(noMcpServersLine("codex"));
    // The turn that was refused left no device standing behind it.
    expect(await rt.devices.list()).toEqual([]);
    await rt.close();
  });

  it("a socket authed with a thread's token is stamped relayed and carries the scope, and may not pair a computer", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const local = await rt.workspaces.createLocal("mac");
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const threadId = handle.view().threadId!;
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const client = await WsClient.connect(srv.port, { token });
      // The relayed rule already holds for it: this computer's own workspace is neither listed nor driven.
      expect(((await client.request("workspaces.list"))["workspaces"] as { name: string }[]).map(w => w.name)).toEqual(["lead"]);
      expect((await client.request("workspaces.rename", { workspaceId: local.id, name: "mini" }))["ok"]).toBe(false);
      // Who may reach this host is never a machine's to hand out.
      // Refused at the door by name, before pair.issue's own refusal is reached: both say no, and this one first.
      expect((await client.request("pair.issue"))["error"]).toBe(threadOpRefusal("pair.issue", threadId));
      const forked = (await client.request("workspaces.create", { golden: "snap_g", name: "builder" }))["workspace"] as { rootThreadId?: string };
      expect(forked.rootThreadId).toBe(threadId);
      client.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("a token whose turn the host went down under is taken away when the host comes back", async () => {
    const held = heldAdapter();
    const first = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    await first.sessions.start(ws.id, { prompt: "hi" });
    expect(await first.devices.list()).toHaveLength(1);
    // The host goes down under the running turn, so nothing reached the exit that hands the token back.
    await first.close();
    const again = runtimeWith({ claude: heldAdapter().factory }, { url: "http://10.0.0.2:4700" });
    await again.workspaces.list();
    expect(await again.devices.list()).toEqual([]);
    await again.close();
  });

  it("a socket whose token is a thread's may not read or take away the devices paired with this host", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const mine = (await rt.devices.list())[0]!;
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const client = await WsClient.connect(srv.port, { token });
      const thread = (await rt.devices.list())[0]!.scope!.threadId;
      expect((await client.request("devices.list"))["error"]).toBe(threadOpRefusal("devices.list", thread));
      expect((await client.request("devices.revoke", { deviceId: mine.id }))["error"]).toBe(threadOpRefusal("devices.revoke", thread));
      expect((await client.request("ticket.issue", { purpose: "connect" }))["error"]).toBe(threadOpRefusal("ticket.issue", thread));
      expect(await rt.devices.list()).toHaveLength(1);
      client.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("the event stream a thread's socket subscribes to carries nothing about a workspace outside its tree", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const mine = await rt.workspaces.create({ golden: "snap_g", name: "mine", agents: AGENTS_ON });
    const theirs = await rt.workspaces.create({ golden: "snap_g", name: "theirs" });
    const handle = await rt.sessions.start(mine.id, { prompt: "hi" });
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const client = await WsClient.connect(srv.port, { token });
      await client.request("events.subscribe", {});
      await rt.workspaces.rename(theirs.id, "renamed");
      await rt.workspaces.rename(mine.id, "lead");
      // The person makes a workspace of their own: its create stages and the record itself name the workspace on
      // the event rather than beside it, which is why the reading is one function and not one field.
      const made = await rt.workspaces.create({ golden: "snap_g", name: "hers" });
      await rt.preferences.set({ theme: "dark" });
      await new Promise(r => setTimeout(r, 50));
      const about = new Set(client.events.map(e => workspaceIdOf(e)));
      expect([...about].sort()).toEqual([mine.id]);
      expect(client.events.map(e => e.type)).not.toContain("preferences.changed");
      expect(client.events.some(e => e["workspaceId"] === made.id || e["workspace"] !== undefined && (e["workspace"] as { id: string }).id === made.id)).toBe(false);
      client.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("every op this host answers is either one a thread may send or one its socket is refused", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const threadId = handle.view().threadId!;
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const client = await WsClient.connect(srv.port, { token });
      // Walked off the op table itself, so an op added later lands in one of these two buckets on purpose.
      const refused: string[] = [];
      const reached: string[] = [];
      for (const op of RUNTIME_OPS) {
        if (op === "auth" || op === "pair.redeem") continue;
        const reply = await client.request(op, {});
        (reply["error"] === threadOpRefusal(op, threadId) ? refused : reached).push(op);
      }
      // The door is shut and these are the openings: everything else answered the one sentence, whether or not the
      // op would have gone on to refuse it for a reason of its own.
      expect(reached.sort()).toEqual([...THREAD_OPS].filter(op => op !== "auth").sort());
      expect(refused).toContain("golden.get");
      expect(refused).toContain("golden.prepare");
      expect(refused).toContain("snapshots.list");
      expect(refused).toContain("snapshots.rollback");
      expect(refused).toContain("preferences.get");
      expect(refused).toContain("preferences.set");
      expect(refused).toContain("capabilities.get");
      expect(refused).toContain("init.keys");
      expect(refused).toContain("host.folders");
      expect(refused).toContain("project.import");
      expect(refused).toContain("workspaces.createLocal");
      expect(refused).toContain("workspaces.delete");
      expect(refused).toContain("workspaces.agents");
      // A thread never lifts a running turn's access mode and never answers a permission prompt, its own or a
      // sibling's: that guard is the person's on the agent, and an agent moving it is the guard moving itself.
      expect(refused).toContain("sessions.access");
      expect(refused).toContain("sessions.answer");
      // A client of the person's own reaches every one of them, so the gate is the token's and not the op's.
      const mine = await WsClient.connect(srv.port, { token: "secret" });
      expect((await mine.request("preferences.get", {}))["ok"]).toBe(true);
      expect(String((await mine.request("snapshots.list", {}))["error"])).not.toContain("not a thread's");
      mine.close();
      client.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("two forks asked for in one tick cannot both take the last place under the root", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 1, maxDepth: 1 } });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    // The record enters the live map only after the provider has answered, so a count read at the guard and nothing
    // held would let every fork in one tick past the same reading.
    const raced = await Promise.allSettled([
      rt.workspaces.create({ golden: "snap_g", name: "b1" }, asThread(scope)),
      rt.workspaces.create({ golden: "snap_g", name: "b2" }, asThread(scope)),
      rt.workspaces.create({ golden: "snap_g", name: "b3" }, asThread(scope)),
    ]);
    expect(raced.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const r of raced.filter(r => r.status === "rejected")) expect(String((r as PromiseRejectedResult).reason)).toContain(spawnCapRefusal("t_root", 1, 1));
    expect((await rt.workspaces.list()).filter(w => w.rootThreadId === "t_root")).toHaveLength(1);
    // A place a fork held is handed back when it lands, so the next one is refused by the record rather than by it.
    await expect(rt.workspaces.create({ golden: "snap_g", name: "b4" }, asThread(scope))).rejects.toThrow(spawnCapRefusal("t_root", 1, 1));
    await rt.close();
  });

  it("a fork still booting counts as the one machine it is, not as two", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 1 } });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    const booting = new Promise<void>(done => {
      const off = rt.events.on("*", e => {
        if (e.type === "workspace.creating" && (e as { name?: string }).name === "b1" && (e as { stage?: string }).stage === "machine-booting") {
          off();
          done();
        }
      });
    });
    // The record enters the live map the moment the provider answers, while the place the guard took is held until
    // the create returns: a second fork asked for in that window read the one machine as two.
    const first = rt.workspaces.create({ golden: "snap_g", name: "b1" }, asThread(scope));
    await booting;
    const second = await rt.workspaces.create({ golden: "snap_g", name: "b2" }, asThread(scope));
    expect(second.name).toBe("b2");
    await first;
    // Two stand, so the third is refused by the records themselves.
    await expect(rt.workspaces.create({ golden: "snap_g", name: "b3" }, asThread(scope))).rejects.toThrow(spawnCapRefusal("t_root", 2, 2));
    expect((await rt.workspaces.list()).filter(w => w.rootThreadId === "t_root")).toHaveLength(2);
    await rt.close();
  });

  it("turning the lead's switch off stops the tree it spawned, not only the threads on the lead", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const lead = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 2 } });
    const opener = await rt.sessions.start(lead.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: lead.id, rootThreadId: rootThread };
    const forked = await rt.workspaces.create({ golden: "snap_g", name: "builder" }, asThread(rootScope));
    // The fork carries the tree and no switch of its own, so what it may do is read off the lead every time.
    expect(forked.agents).toEqual({ spawn: true, maxMachines: 3, maxDepth: 2 });
    const onFork = await rt.sessions.start(forked.id, { prompt: "build" }, asThread(rootScope));
    const forkScope: ThreadScope = { kind: "thread", threadId: onFork.view().threadId!, workspaceId: forked.id, rootThreadId: rootThread };
    await rt.workspaces.agents(lead.id, { spawn: false });
    await expect(rt.workspaces.create({ golden: "snap_g", name: "deeper" }, asThread(forkScope))).rejects.toThrow(agentsOffRefusal("builder", "fork"));
    await expect(rt.sessions.start(forked.id, { prompt: "again" }, asThread(forkScope))).rejects.toThrow(agentsOffRefusal("builder", "thread_new"));
    // And the fork's own listing says so, so a person reading the card is not told the old answer.
    expect((await rt.workspaces.get(forked.id)).agents).toEqual({ spawn: false, maxMachines: 3, maxDepth: 2 });
    held.end(1);
    held.end(0);
    await rt.close();
  });

  it("a workspace whose agents could not drive this host is refused the switch, in the words both doors read", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const mac = await rt.workspaces.createLocal("mac");
    await expect(rt.workspaces.agents(mac.id, { spawn: true })).rejects.toThrow(agentsKindRefusal("local"));
    // Off is always allowed: a switch that does nothing may be said to do nothing.
    await rt.workspaces.agents(mac.id, { spawn: false });
    const cloud = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    expect((await rt.workspaces.agents(cloud.id, { spawn: true })).agents?.spawn).toBe(true);
    await rt.close();
  });

  it("a turn refused before it launches leaves no token standing", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    // A harness this host has no adapter for is refused where the launch environment is built, after the mint.
    await expect(rt.sessions.start(ws.id, { prompt: "hi", harness: "nope" })).rejects.toThrow(/no adapter/);
    expect(await rt.devices.list()).toEqual([]);
    // A notify naming no thread is refused before a token exists at all.
    await expect(rt.sessions.start(ws.id, { prompt: "hi", notify: ["nothing-here"] })).rejects.toThrow("no thread nothing-here to notify");
    expect(await rt.devices.list()).toEqual([]);
    await rt.close();
  });

  it("a thread cannot widen its own caps through the fork it asks for", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const tight = { spawn: true, maxMachines: 2, maxDepth: 1 };
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: tight });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    await expect(rt.workspaces.create({ golden: "snap_g", name: "wide", agents: { maxMachines: 50, maxDepth: 9 } }, asThread(scope))).rejects.toThrow(spawnActRefusal(rootThread, "agents"));
    // The refused fork took no place with it, and the fork that lands answers with the tree's own switch.
    const forked = await rt.workspaces.create({ golden: "snap_g", name: "builder" }, asThread(scope));
    expect(forked.agents).toEqual(tight);
    // So a thread on that machine is still one level deep and forks nothing.
    const child = await rt.sessions.start(forked.id, { prompt: "builder" }, asThread(scope));
    const childScope: ThreadScope = { kind: "thread", threadId: child.view().threadId!, workspaceId: forked.id, rootThreadId: rootThread };
    await expect(rt.workspaces.create({ golden: "snap_g", name: "deeper" }, asThread(childScope))).rejects.toThrow(spawnDepthRefusal(childScope.threadId, 1, 1));
    held.end(0);
    await rt.close();
  });

  it("the init job's own events reach no thread's socket either, since they are about this host", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const listeners = new Set<(e: Record<string, unknown>) => void>();
    const init = {
      get: async () => ({}) as never,
      keys: async () => ({}) as never,
      start: async () => ({}) as never,
      answer: async () => ({}) as never,
      step: async () => ({}) as never,
      draft: async () => ({}) as never,
      retry: async () => ({}) as never,
      build: async () => ({}) as never,
      signInCode: async () => ({}) as never,
      cancel: async () => ({}) as never,
      on: (fn: (e: Record<string, unknown>) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as Parameters<typeof serveRuntime>[1]["init"];
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices, init });
    try {
      const client = await WsClient.connect(srv.port, { token });
      await client.request("events.subscribe", {});
      const mine = await WsClient.connect(srv.port, { token: "secret" });
      await mine.request("events.subscribe", {});
      for (const fn of listeners) fn({ type: "init.job", job: { id: "j1" } });
      for (const fn of listeners) fn({ type: "job.needs-you", jobId: "j1", needsYou: { what: "a sign in", since: 0 } });
      await new Promise(r => setTimeout(r, 50));
      expect(client.events.map(e => e.type)).not.toContain("init.job");
      expect(client.events.map(e => e.type)).not.toContain("job.needs-you");
      // The person's own client is where the init job is read, and it still is.
      expect(mine.events.map(e => e.type)).toEqual(expect.arrayContaining(["init.job", "job.needs-you"]));
      mine.close();
      client.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("stopping a root ends every thread its agents spawned under it", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { url: "http://10.0.0.2:4700" });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 2 } });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const child = await rt.sessions.start(ws.id, { prompt: "builder" }, asThread(rootScope));
    const childThread = child.view().threadId!;
    const grandchild = await rt.sessions.start(ws.id, { prompt: "deeper" }, asThread({ kind: "thread", threadId: childThread, workspaceId: ws.id, rootThreadId: rootThread }));
    const stopped = await rt.sessions.interrupt(opener.id);
    expect(stopped.outcome).toBe("accepted");
    expect([...(stopped.under ?? [])].sort()).toEqual([childThread, grandchild.view().threadId!].sort());
    expect((await rt.sessions.list(ws.id)).every(v => v.status !== "running")).toBe(true);
    await rt.close();
  });
});
