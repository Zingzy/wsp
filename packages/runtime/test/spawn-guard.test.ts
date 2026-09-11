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
  DEVICES_TICKET_REFUSAL,
  MCP_SERVER_NAME,
  PAIR_ISSUE_REFUSAL,
  RELAY_TICKET_REFUSAL,
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
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    const forked = await rt.workspaces.create({ golden: "snap_g", name: "builder" }, asThread(scope));
    expect(forked.parentThreadId).toBe("t_root");
    expect(forked.rootThreadId).toBe("t_root");
    // The tree carries the switch: a machine a thread forked runs threads that may fork in their turn.
    expect(forked.agents).toEqual(AGENTS_ON);
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
      expect((await client.request("pair.issue"))["error"]).toBe(PAIR_ISSUE_REFUSAL);
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
      expect((await client.request("devices.list"))["error"]).toBe(DEVICES_TICKET_REFUSAL);
      expect((await client.request("devices.revoke", { deviceId: mine.id }))["error"]).toBe(DEVICES_TICKET_REFUSAL);
      expect((await client.request("ticket.issue", { purpose: "connect" }))["error"]).toBe(RELAY_TICKET_REFUSAL);
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
      await new Promise(r => setTimeout(r, 50));
      const named = client.events.filter(e => e.type === "workspace.renamed").map(e => e["workspaceId"]);
      expect(named).toEqual([mine.id]);
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
