// SPDX-License-Identifier: AGPL-3.0-only
// The MCP server over the host: an MCP client calls each tool against a host
// over the fake runtime, through the same socket client and verb logic the
// command line uses; a thread it opens is the local agent's.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ProjectGolden, ThreadView, WorkspaceView } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "../src/cli.js";
import { dialer, mcpServer, serveMcp } from "../src/mcp.js";
import { WSP_SKILL, instructionsOf } from "../src/skill.js";
import type { HostHandle } from "../src/server.js";
import type { HostClient } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { EXPORT_SESSION, EXPORT_SOURCE, PAGE, captured, execGuest, exportGuest, projectBundler, heldAgent, scriptedAgent, stuckAgent, doneOnlyAgent } from "./verbs-fixture.js";

interface Called {
  text: string;
  structured: Record<string, unknown> | undefined;
  isError: boolean;
}

/** The client side of a stdio pair over two streams: what an agent's process does to `wsp mcp`, in-process. */
function streamTransport(toServer: PassThrough, fromServer: PassThrough): Transport {
  const buffer = new ReadBuffer();
  const t: Transport = {
    start: async () => {
      fromServer.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (let msg = buffer.readMessage(); msg !== null; msg = buffer.readMessage()) t.onmessage?.(msg);
      });
    },
    send: async (msg: JSONRPCMessage) => {
      toServer.write(serializeMessage(msg));
    },
    close: async () => {
      toServer.end();
      t.onclose?.();
    },
  };
  return t;
}

describe("the MCP server over the host", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let claude: ReturnType<typeof scriptedAgent>;
  let codex: ReturnType<typeof scriptedAgent>;
  let client: Client | undefined;
  let server: ReturnType<typeof mcpServer> | undefined;
  /** The host socket the server last dialled, so a test can wait for the host's close to reach it. */
  let socket: HostClient | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_mcp_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    await store.put("goldens", "default", SEALED_GOLDEN);
    claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`));
    codex = scriptedAgent(prompt => `codex: ${prompt}`);
    rt = createRuntime({ backend, store, adapters: { claude: claude.adapter, codex: codex.adapter } });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    // The host has its keys; the server never reads any.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<Client> {
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    const dial = dialer(statePath);
    server = mcpServer(statePath, { dial: Object.assign(async () => (socket = await dial()), { close: dial.close }) });
    await server.connect(toServer);
    client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(toClient);
    return client;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
    const c = client ?? (await connect());
    const result = await c.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return {
      text: content.map(part => part.text ?? "").join(""),
      structured: result.structuredContent as Record<string, unknown> | undefined,
      isError: result.isError === true,
    };
  }

  async function restartHost(adapters: Parameters<typeof createRuntime>[0]["adapters"]): Promise<void> {
    await handle?.close();
    handle = undefined;
    rt = createRuntime({ backend, store, adapters });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_mcp_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
  }

  it("offers the verbs as tools, each described, and none for import until it exists", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(["exec", "export", "forget", "fork", "new", "pause", "send", "snapshot", "thread_new", "threads", "workspaces"]);
    for (const t of tools) expect(t.description, t.name).toMatch(/\S/);
    expect(Object.keys((tools.find(t => t.name === "new")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["from", "name"]);
    expect(Object.keys((tools.find(t => t.name === "thread_new")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["access", "agent", "cwd", "effort", "model", "notify", "task", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "fork")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["access", "agent", "cwd", "effort", "model", "name", "notify", "task", "workspace"]);
    expect(Object.keys((tools.find(t => t.name === "send")!.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["access", "effort", "message", "model", "thread"]);
    expect(c.getServerVersion()?.name).toBe("wsp");
    expect(c.getInstructions()).toBe(instructionsOf(WSP_SKILL));
    expect(c.getInstructions()).toContain("thread_new");
    expect(c.getInstructions()).toContain("snapshot");
    for (const t of tools) expect(WSP_SKILL, t.name).toContain(`\`${t.name}\``);
  });

  it("snapshot takes a project golden of the workspace as wsp snapshot does, and new with from forks it by project name or snapshot id; a workspace without a project, and a name no golden carries, are tool errors in one line", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const bare = await call("snapshot", { workspace: "alpha" });
    expect(bare).toEqual({ text: "alpha has no project loaded; import one before snapshotting it", structured: undefined, isError: true });
    expect(await rt.golden.projects()).toEqual([]);

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const taken = await call("snapshot", { workspace: "alpha" });
    expect(taken.isError).toBe(false);
    const [golden] = await rt.golden.projects();
    expect(golden).toMatchObject({ project: { name: "proj", dest: "/root/work/proj" }, golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(taken.structured).toEqual({ projectGolden: golden });
    expect(ProjectGolden.parse((taken.structured as { projectGolden: unknown }).projectGolden)).toEqual(golden);
    expect(JSON.parse(taken.text)).toEqual(taken.structured);

    const byName = await call("new", { name: "task-a", from: "proj" });
    expect(byName.isError).toBe(false);
    const taskA = (await rt.workspaces.list()).find(w => w.name === "task-a")!;
    expect(taskA).toMatchObject({ golden: golden!.snapshotId, project: golden!.project });
    expect(byName.structured).toEqual({ workspace: expect.objectContaining({ id: taskA.id, name: "task-a", golden: golden!.snapshotId }) });
    const byId = await call("new", { name: "task-b", from: golden!.snapshotId });
    expect(byId.isError).toBe(false);
    expect((await rt.workspaces.list()).find(w => w.name === "task-b")).toMatchObject({ golden: golden!.snapshotId, project: golden!.project });

    const missing = await call("new", { name: "task-c", from: "nope" });
    expect(missing).toEqual({ text: "no project golden named nope; wsp snapshot <workspace> takes one", structured: undefined, isError: true });
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "task-a", "task-b"]);
  });

  it("new forks the golden's head into a workspace of that name; workspaces lists it as the app sees it", async () => {
    const made = await call("new", { name: "alpha" });
    expect(made.isError).toBe(false);
    const [ws] = await rt.workspaces.list();
    expect(ws).toMatchObject({ name: "alpha", phase: "running" });
    expect(made.structured).toEqual({ workspace: expect.objectContaining({ id: ws!.id, name: "alpha" }) });
    const listed = await call("workspaces");
    const { workspaces } = listed.structured as { workspaces: WorkspaceView[] };
    expect(workspaces.map(w => WorkspaceView.parse(w).id)).toEqual([ws!.id]);
    expect(JSON.parse(listed.text)).toEqual(listed.structured);
  });

  it("fork makes a sibling from the source's golden version, by name or id, and a task opens its first thread", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const plain = await call("fork", { workspace: "alpha" });
    expect(plain.isError).toBe(false);
    const forks = (await rt.workspaces.list()).filter(w => w.id !== alpha!.id);
    expect(forks.map(w => [w.name, w.golden])).toEqual([["alpha-fork", alpha!.golden]]);
    const sent = await call("fork", { workspace: alpha!.id, name: "worker", task: "build it" });
    expect(sent.isError).toBe(false);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [thread] = await rt.sessions.list(worker.id);
    expect(thread).toMatchObject({ harness: "claude", startedBy: "agent", prompt: "build it", status: "completed" });
    expect(sent.structured).toMatchObject({ workspace: expect.objectContaining({ name: "worker" }), turn: { threadId: thread!.threadId, workspaceId: worker.id, harness: "claude", text: "re: build it", outcome: "started" } });
  });

  it("fork with a task whose first turn fails names the minted workspace beside the reason, so a retry does not mint another", async () => {
    await call("new", { name: "alpha" });
    const failed = await call("fork", { workspace: "alpha", name: "worker", task: "die" });
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    expect(worker).toMatchObject({ phase: "running" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe(`created worker ${worker.id}; first turn failed: the harness died`);
    expect(failed.structured).toEqual({ workspace: expect.objectContaining({ id: worker.id, name: "worker" }), failure: "the harness died" });
    expect((await rt.sessions.list(worker.id))[0]).toMatchObject({ startedBy: "agent", status: "failed" });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha", "worker"]);
  });

  it("fork with a task under an agent the host has no adapter for still names the minted workspace beside the refusal", async () => {
    await call("new", { name: "alpha" });
    const refused = await call("fork", { workspace: "alpha", name: "worker", task: "hi", agent: "gpt9" });
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    expect(worker).toMatchObject({ phase: "running" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(`created worker ${worker.id}; first turn failed: no adapter registered for harness "gpt9"`);
    expect(refused.structured).toEqual({ workspace: expect.objectContaining({ id: worker.id, name: "worker" }), failure: 'no adapter registered for harness "gpt9"' });
    expect(await rt.sessions.list(worker.id)).toEqual([]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha", "worker"]);
  });

  it("pause naps the workspace; a workspace that is not there is a tool error in one line", async () => {
    await call("new", { name: "alpha" });
    const paused = await call("pause", { workspace: "alpha" });
    expect(paused.isError).toBe(false);
    expect(paused.structured).toEqual({ workspace: expect.objectContaining({ name: "alpha", phase: "napping" }) });
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    const missing = await call("pause", { workspace: "nope" });
    expect(missing).toEqual({ text: "no workspace nope", structured: undefined, isError: true });
  });

  it("forget drops a workspace whose machine is gone and says what went; one whose machine exists is a tool error with the reason", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const refused = await call("forget", { workspace: "alpha" });
    expect(refused).toEqual({ text: "alpha's machine m1 is still running; pause it or delete it at the provider first", structured: undefined, isError: true });
    expect(await rt.workspaces.list()).toHaveLength(1);

    backend.machines[0]!.killed = true;
    const forgot = await call("forget", { workspace: "alpha" });
    expect(forgot.isError).toBe(false);
    expect(forgot.structured).toEqual({ workspaceId: alpha!.id, name: "alpha", threads: 0 });
    expect(forgot.text).toBe(`forgot alpha ${alpha!.id}: its record and 0 threads are gone from this computer`);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(await store.get("workspaces", alpha!.id)).toBeUndefined();
  });

  it("thread_new opens a thread under the named agent, started by the local agent, and returns the reply as the result", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const made = await call("thread_new", { workspace: "alpha", agent: "codex", task: "write tests" });
    expect(made.isError).toBe(false);
    const [row] = await rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harness: "codex", startedBy: "agent", prompt: "write tests", status: "completed" });
    expect(codex.starts.map(s => s.prompt)).toEqual(["write tests"]);
    expect(claude.starts).toEqual([]);
    expect(made.text).toBe("codex: write tests");
    expect(made.structured).toEqual({ threadId: row!.threadId, workspaceId: alpha!.id, harness: "codex", text: "codex: write tests", outcome: "started" });
  });

  it("thread_new and fork take cwd, the folder the turn starts in; without it the workspace's project folder, else none", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    const picked = await call("thread_new", { workspace: "alpha", agent: "codex", task: "write tests", cwd: "/root/work/elsewhere" });
    expect(picked.isError).toBe(false);
    expect(codex.starts.map(s => s.cwd)).toEqual(["/root/work/elsewhere"]);

    const bare = await call("thread_new", { workspace: "alpha", task: "hello" });
    expect(bare.isError).toBe(false);
    expect(claude.starts.map(s => s.cwd)).toEqual([undefined]);

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const inProject = await call("thread_new", { workspace: "alpha", task: "hello again" });
    expect(inProject.isError).toBe(false);
    expect(claude.starts.map(s => s.cwd)).toEqual([undefined, "/root/work/proj"]);

    const forked = await call("fork", { workspace: "alpha", name: "worker", task: "build it", cwd: "/root/work/site" });
    expect(forked.isError).toBe(false);
    expect(claude.starts.at(-1)?.cwd).toBe("/root/work/site");
    const { threads } = (await call("threads", { workspace: "worker" })).structured as { threads: ThreadView[] };
    expect(threads.map(t => t.cwd)).toEqual(["/root/work/site"]);
  });

  it("thread_new, send and fork take model, effort and access, the composer's three picks; a new thread without a model runs the catalog's default and an unlisted value is refused with the list", async () => {
    await call("new", { name: "alpha" });
    const picked = await call("thread_new", { workspace: "alpha", task: "review it", model: "claude-sonnet-5", effort: "low", access: "plan" });
    expect(picked.isError).toBe(false);
    expect(claude.starts.map(s => [s.model, s.effort, s.permissionMode])).toEqual([["claude-sonnet-5", "low", "plan"]]);
    const bare = await call("thread_new", { workspace: "alpha", task: "hello" });
    expect(bare.isError).toBe(false);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-opus-5" });
    expect(claude.starts.at(-1)!.effort).toBeUndefined();
    const threadId = (bare.structured as { threadId: string }).threadId;
    const sent = await call("send", { thread: threadId, message: "now think", model: "claude-fable-5-1", effort: "max" });
    expect(sent.isError).toBe(false);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-fable-5-1", effort: "max" });
    expect(claude.starts.at(-1)!.resume).toBeDefined();
    const kept = await call("send", { thread: threadId, message: "go on" });
    expect(kept.isError).toBe(false);
    expect(claude.starts.at(-1)!.model).toBeUndefined();
    const forked = await call("fork", { workspace: "alpha", name: "worker", task: "build it", model: "claude-sonnet-5", access: "bypassPermissions" });
    expect(forked.isError).toBe(false);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", permissionMode: "bypassPermissions" });

    const before = claude.starts.length;
    const refused = await call("thread_new", { workspace: "alpha", task: "review it", model: "claude-haiku-4-5" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe('model "claude-haiku-4-5" is not one claude takes; one of: Fable 5.1 (claude-fable-5-1), Opus 5 (claude-opus-5), Sonnet 5 (claude-sonnet-5)');
    const mode = await call("send", { thread: threadId, message: "go", access: "yolo" });
    expect(mode.isError).toBe(true);
    expect(mode.text).toMatch(/^access mode "yolo" is not one claude takes; one of: Default \(default\), /);
    const minted = (await rt.workspaces.list()).map(w => w.name);
    const fork = await call("fork", { workspace: "alpha", name: "cheap", task: "review", model: "claude-haiku-4-5" });
    expect(fork.isError).toBe(true);
    expect(fork.text).toBe('model "claude-haiku-4-5" is not one claude takes; one of: Fable 5.1 (claude-fable-5-1), Opus 5 (claude-opus-5), Sonnet 5 (claude-sonnet-5)');
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(minted);
    expect(claude.starts).toHaveLength(before);
  });

  it("a cwd that is not absolute is refused by thread_new and fork before anything is created or started", async () => {
    await call("new", { name: "alpha" });
    const relative = await call("thread_new", { workspace: "alpha", task: "look here", cwd: "packages/host" });
    expect(relative.isError).toBe(true);
    expect(relative.text).toContain('cwd is a path on the machine, absolute: got "packages/host"');
    const forked = await call("fork", { workspace: "alpha", name: "worker", task: "build it", cwd: "packages/host" });
    expect(forked.isError).toBe(true);
    expect(forked.text).toContain('cwd is a path on the machine, absolute: got "packages/host"');
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await rt.sessions.list()).toEqual([]);
    expect(claude.starts).toEqual([]);
  });

  it("threads is the sidebar's data with the workspace's name on each row; the local agent's threads say so", async () => {
    await call("new", { name: "alpha" });
    await call("new", { name: "beta" });
    const [alpha, beta] = await rt.workspaces.list();
    await call("thread_new", { workspace: "alpha", task: "first task" });
    await (await rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const all = await call("threads");
    const { threads } = all.structured as { threads: (ThreadView & { workspaceName: string })[] };
    expect(threads.map(t => [t.workspaceName, t.harness, t.startedBy, t.title])).toEqual([
      ["alpha", "claude", "agent", "first task"],
      ["beta", "codex", "person", "from the app"],
    ]);
    for (const t of threads) {
      const { workspaceName: _name, ...view } = t;
      expect(ThreadView.parse(view)).toEqual(view);
    }
    const scoped = await call("threads", { workspace: "beta" });
    expect((scoped.structured as { threads: ThreadView[] }).threads.map(t => t.workspaceId)).toEqual([beta!.id]);
  });

  it("send resumes the thread's latest session under its own agent and returns the reply; the thread keeps who opened it", async () => {
    await call("new", { name: "alpha" });
    const [alpha] = await rt.workspaces.list();
    await call("thread_new", { workspace: "alpha", agent: "codex", task: "first" });
    await (await rt.sessions.start(alpha!.id, { prompt: "from the app" })).finished;
    const [byAgent, byPerson] = await rt.sessions.list();
    const reply = await call("send", { thread: byAgent!.threadId!, message: "second" });
    expect(reply.isError).toBe(false);
    expect(reply.text).toBe("codex: second");
    expect(reply.structured).toEqual({ threadId: byAgent!.threadId, workspaceId: alpha!.id, harness: "codex", text: "codex: second", outcome: "started" });
    expect(codex.starts.map(s => [s.prompt, s.resume])).toEqual([["first", undefined], ["second", byAgent!.claudeSessionId]]);
    const followUp = await call("send", { thread: byPerson!.threadId!.slice(0, 8), message: "and this" });
    expect(followUp.text).toBe("re: and this");
    // The server's starts carry their own request ids, like the command line's; the app's start through the runtime sent none.
    const requestIds = (await rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start").map(e => e.requestId);
    expect(requestIds.map(id => typeof id)).toEqual(["string", "undefined", "string", "string"]);
    expect(new Set(requestIds).size).toBe(4);
    const { threads } = (await call("threads")).structured as { threads: ThreadView[] };
    expect(threads.map(t => [t.harness, t.startedBy, t.title, t.turns])).toEqual([
      ["codex", "agent", "first", 1],
      ["claude", "person", "from the app", 1],
    ]);
    const missing = await call("send", { thread: "nope", message: "x" });
    expect(missing).toEqual({ text: "no thread nope", structured: undefined, isError: true });
  });

  it("send into a thread whose turn runs joins that turn when the agent steers and returns the running turn's reply; no second start", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const first = call("thread_new", { workspace: "alpha", task: "loop, then say done" });
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = call("send", { thread: row!.threadId!, message: "end with STEERED" });
    await vi.waitFor(() => expect(held.steered).toEqual(["end with STEERED"]));
    held.release(0, "done STEERED");
    expect((await first).text).toBe("done STEERED");
    const joined = await sent;
    expect(joined.isError).toBe(false);
    expect(joined.structured).toEqual({ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", text: "done STEERED", outcome: "steered" });
    expect(held.starts).toHaveLength(1);
    expect((await rt.sessions.history(row!.workspaceId)).map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
  });

  it("thread_new with notify tells that thread when the new one ends, through the same start the CLI makes: the running parent is steered the line and the child's transcript names the parent", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await call("new", { name: "alpha" });
    const parent = call("thread_new", { workspace: "alpha", task: "orchestrate" });
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    const kid = call("thread_new", { workspace: "alpha", task: "build it", notify: parentRow!.threadId!.slice(0, 8) });
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect((await kid).structured).toEqual({ threadId: kidRow.threadId, workspaceId: kidRow.workspaceId, harness: "claude", text: "all green", outcome: "started" });
    held.release(0, "read it");
    expect((await parent).text).toBe("read it");
    const history = await rt.sessions.history(kidRow.workspaceId);
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ threadId: parentRow!.threadId, prompt: line });
    expect(held.starts).toHaveLength(2);

    const missing = await call("thread_new", { workspace: "alpha", task: "x", notify: "nope" });
    expect(missing).toEqual({ text: "no thread nope", structured: undefined, isError: true });
  });

  it("fork with a task and notify me records the first turn's end in the new thread for the person", async () => {
    await call("new", { name: "alpha" });
    const sent = await call("fork", { workspace: "alpha", name: "worker", task: "build it", notify: "me" });
    expect(sent.isError).toBe(false);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [row] = await rt.sessions.list(worker.id);
    expect((await rt.sessions.history(worker.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: row!.threadId, notify: "me", text: `thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it` });
  });

  it("thread_new and send return the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await call("new", { name: "alpha" });
    const made = await call("thread_new", { workspace: "alpha", task: "first" });
    expect(made.isError).toBe(false);
    expect(made.text).toBe("re: first");
    const [row] = await rt.sessions.list();
    const sent = await call("send", { thread: row!.threadId!, message: "second" });
    expect(sent.isError).toBe(false);
    expect(sent.text).toBe("re: second");
    expect(agent.starts.map(s => s.prompt)).toEqual(["first", "second"]);
    expect((await rt.sessions.history(row!.workspaceId)).map(e => e.type)).not.toContain("session.end");
  });

  it("a failed turn is a tool error carrying the harness's reason", async () => {
    await call("new", { name: "alpha" });
    const failed = await call("thread_new", { workspace: "alpha", task: "die" });
    expect(failed).toEqual({ text: "the harness died", structured: undefined, isError: true });
    expect((await rt.sessions.list())[0]).toMatchObject({ startedBy: "agent", status: "failed" });
  });

  it("export brings the folder and the sessions keyed to it home and returns the done line with the result; an existing folder is a tool error naming it", async () => {
    exportGuest(backend);
    await call("new", { name: "alpha" });
    const dest = join(dir, "out", "proj");
    const exported = await call("export", { workspace: "alpha", folder: dest, from: EXPORT_SOURCE });
    expect(exported.isError).toBe(false);
    expect(exported.text).toBe(`2 files, 28 B, landed at ${dest}; 1 cache left behind; sessions: Claude Code (1 session) moved.`);
    expect(exported.structured).toEqual({ dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [{ agent: "claude", files: 1, bytes: EXPORT_SESSION(realpathSync(dest)).length, outcome: "moved", sessions: 1 }] });
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    const key = realpathSync(dest).replace(/[^A-Za-z0-9]/g, "-");
    expect(readFileSync(join(dir, "user", ".claude", "projects", key, "S1.jsonl"), "utf8")).toBe(EXPORT_SESSION(realpathSync(dest)));
    const again = await call("export", { workspace: "alpha", folder: dest, from: EXPORT_SOURCE });
    expect(again.isError).toBe(true);
    expect(again.text).toBe(`${dest} already exists on this computer with 2 files; export with replace to overwrite it`);
  });

  it("exec runs the command on the workspace's machine as argv and returns its output and exit code; a non-zero exit is a result, not an error", async () => {
    await call("new", { name: "alpha" });
    execGuest(backend, "one\ntwo\n", 3);
    const ran = await call("exec", { workspace: "alpha", argv: ["sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] });
    expect(ran.isError).toBe(false);
    expect(ran.text).toBe("one\ntwo");
    expect(ran.structured).toEqual({ exitCode: 3, output: ["one", "two"] });
    const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
    expect(Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8")).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");
  });

  it("the workspace going away under a running exec ends the tool with the reason as an error", async () => {
    await call("new", { name: "alpha" });
    execGuest(backend, "", undefined);
    const running = call("exec", { workspace: "alpha", argv: ["sleep", "600"] });
    await new Promise(r => setTimeout(r, 300));
    const [alpha] = await rt.workspaces.list();
    await rt.workspaces.delete(alpha!.id);
    expect(await running).toEqual({ text: "machine deleted while the agent was working", structured: undefined, isError: true });
  });

  it("a dead host is a tool error, not a hang: no host serving, then the host going away mid-turn, then a host that came back", async () => {
    await call("new", { name: "alpha" });
    await handle!.close();
    handle = undefined;
    await socket!.closed;
    const gone = await call("workspaces");
    expect(gone).toEqual({ text: `no wsp host is serving ${statePath}; run wsp up first`, structured: undefined, isError: true });

    await restartHost({ claude: stuckAgent() });
    const turn = call("thread_new", { workspace: "alpha", task: "hang" });
    await new Promise(r => setTimeout(r, 300));
    await handle!.close();
    handle = undefined;
    expect(await turn).toEqual({ text: "the host closed the connection", structured: undefined, isError: true });

    await restartHost({ claude: claude.adapter });
    const back = await call("threads");
    expect(back.isError).toBe(false);
    expect((back.structured as { threads: ThreadView[] }).threads).toHaveLength(1);
  });

  it("wsp mcp speaks the protocol over stdio and returns when its stdin ends, closing the host socket", async () => {
    await call("new", { name: "alpha" });
    await client!.close();
    client = undefined;
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const served = serveMcp(statePath, { input: toServer, output: fromServer });
    const stdio = new Client({ name: "test-agent", version: "0.0.0" });
    await stdio.connect(streamTransport(toServer, fromServer));
    const result = await stdio.callTool({ name: "workspaces", arguments: {} });
    expect((result.structuredContent as { workspaces: WorkspaceView[] }).workspaces.map(w => w.name)).toEqual(["alpha"]);
    await stdio.close();
    await expect(served).resolves.toBeUndefined();
  });
});

describe("the MCP server never talks to the provider", () => {
  it("imports the protocol, the verbs' client and the SDK only: no runtime, engine, backend or key loading", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";$/gm)].map(m => m[1]!);
    const workspacePackages = imports.filter(i => i.startsWith("@wsp/"));
    expect(workspacePackages).toEqual(["@wsp/protocol"]);
    expect(imports.filter(i => i.startsWith("./"))).toEqual(["./skill.js", "./version.js", "./verbs.js"]);
  });
});
