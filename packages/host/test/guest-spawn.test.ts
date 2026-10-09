// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command a turn's own agent runs, against the host that launched it:
// on a fork, the line its daemon carries up the link this host holds, with the
// token its launch left in the environment; on this computer, the node wsp
// dialling the pair its launch carries. The road a thread takes to open a
// thread beside it, on another machine or on a branch, and where each nests.
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsOffRefusal, notAThreadLine, NAME_A_THREAD_FIX, EXIT_CODES, folderForkFix, folderForkRefusal, spawnActRefusal, noWorkspaceRefusal, refusalLine, spawnFolderRefusal, spawnReachFix, spawnReachRefusal, spawnRepositoryRefusal, spawnRepositoryWorkspaceRefusal, SPAWN_FOLDER_FIX, SPAWN_REPOSITORY_FIX, SPAWN_REPOSITORY_WORKSPACE_FIX, HERE_PLACE_ID, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LOOPBACK, MCP_SERVER_NAME, SCOPED_MCP_ARG, TURN_TOKEN_ENV, type Caller, type ThreadView, type WorkspaceView } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { mcpServer } from "../src/mcp.js";
import { CLOUD_ON } from "../src/cloud.js";
import { guestKinds } from "../src/guest-tools.js";
import { guestDoor, type GuestDoor, type GuestLink } from "../src/guest.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, withDaemonRoads } from "./stub-backend.js";
import { branchDaemons, GUEST_BRANCH } from "../../runtime/test/stub-backend.js";
import { PAGE, captured, copyingFake, fakeDaemonStart, heldAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

describe("the wsp command on a thread's machine", () => {
  let dir: string;
  let statePath: string;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let held: ReturnType<typeof heldAgent>;
  let door: GuestDoor;
  let replies: { session: string; message: { stream?: string; text?: string; exit?: number } }[];
  let closes: { session: string; error?: string }[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-guest-spawn-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_guest_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    held = heldAgent(false);
    // A host on loopback that names no address and is linked to no relay: a fork's wsp rides the link this host
    // holds to its daemon, so nothing about where this host answers may stand between its turns and a token.
    rt = createRuntime({
      statePath,
      backend: withDaemonRoads(stubBackend()),
      daemonChannel: branchDaemons().open,
      store,
      adapters: { claude: ctx => ({ ...held.adapter(ctx), mcpServers: true as const }) },
      local: localWiring(join(dir, "user"), undefined, undefined, statePath),
      agents: { here: {}, wspMcp: { command: "wsp", args: ["mcp", SCOPED_MCP_ARG] } },
    });
    handle = await serve(captured(), { port: 0, statePath, webDir, runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    replies = [];
    closes = [];
    const port = handle.port;
    door = guestDoor({
      authorize: token => rt.devices.match(token).then(device => (device === undefined ? undefined : { kind: "device", device })),
      hostUrl: () => `http://${LOOPBACK}:${port}`,
      kinds: guestKinds(statePath),
    });
  });
  afterEach(async () => {
    door.closeAll();
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A line the turn's shell runs on its machine, as that machine's daemon carries it up to this host: the token and
   * the turn its launch left in the environment, and nothing of this computer's. */
  let sessions = 0;
  async function guest(on: string, launch: Readonly<Record<string, string>>, ...argv: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
    const session = `g${++sessions}`;
    const link: GuestLink = {
      workspaceId: on,
      name: on,
      request: async (op, params) => {
        if (params["session"] !== session) return {};
        if (op === "guest.reply") replies.push(params as (typeof replies)[number]);
        if (op === "guest.close") closes.push(params as (typeof closes)[number]);
        return {};
      },
    };
    const token = launch[HOST_TOKEN_ENV] ?? "";
    door.event(link, { type: "guest.opened", session, life: "life-1", kind: "cli", token, turnToken: launch[TURN_TOKEN_ENV]!, argv, cwd: "/root" });
    const mine = () => replies.filter(r => r.session === session).map(r => r.message);
    const done = () => mine().some(m => m.exit !== undefined) || closes.some(c => c.session === session);
    for (let tries = 0; tries < 2000 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 5));
    const text = (stream: string) => mine().filter(m => m.stream === stream).map(m => m.text).join("");
    const closed = closes.find(c => c.session === session)?.error;
    return { code: mine().find(m => m.exit !== undefined)?.exit, out: text("out"), err: text("err") + (closed ?? "") };
  }

  it.runIf(CLOUD_ON)("a turn on a spawn on fork gets its token with no address advertised, and runs a child on its machine that nests under it", async () => {
    const project = await rt.projects.add({ source: "https://github.com/dev/one.git", on: "default" });
    const one = await rt.workspaces.create({ project: project.id, name: "one", agents: { spawn: true } });
    const turn = await rt.sessions.start(one.id, { prompt: "start two children" });
    const threadId = turn.view().threadId!;
    const launch = held.envs[0]!;
    // The turn dials no address: its wsp is the daemon's, so none is handed to it and none is pinned.
    expect(launch[HOST_TOKEN_ENV]).toMatch(/.+/);
    expect(launch[HOST_URL_ENV]).toBeUndefined();
    expect(launch[HOST_KEY_ENV]).toBeUndefined();
    expect(held.starts[0]!.mcpServers?.[MCP_SERVER_NAME]).toEqual({ command: "wsp", args: ["mcp"] });

    const ran = await guest(one.id, launch, "run", "one", "--detach", "reply ok", "--json");
    expect(ran.err).toBe("");
    expect(ran.code).toBe(0);
    const child = (JSON.parse(ran.out.trim().split("\n").at(-1)!) as { threadId: string }).threadId;
    expect((await rt.sessions.list()).find(r => r.threadId === child)).toMatchObject({ workspaceId: one.id, parentThreadId: threadId, rootThreadId: threadId });

    held.release(1, "ok");
    held.release(0, "done");
    await turn.finished;
  });
});

describe("the wsp command a thread on this computer runs", () => {
  let dir: string;
  let statePath: string;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let held: ReturnType<typeof heldAgent>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mac-spawn-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    held = heldAgent(false);
    // The loopback address is the host's to fill once its socket binds, and the runtime reads it at each launch
    // through the same reach a real host hands it.
    const here: { url?: string } = {};
    rt = createRuntime({
      statePath,
      backend: withDaemonRoads(stubBackend()),
      daemonChannel: branchDaemons().open,
      store: memoryStore(),
      adapters: { claude: held.adapter },
      local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, statePath, copyingFake()),
      agents: { here, wspMcp: { command: "wsp", args: ["mcp"] } },
    });
    handle = await serve(captured(), { port: 0, statePath, webDir, runtime: rt, here });
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The line the thread's agent runs, carrying the launch pair and nothing else of the host's. */
  async function thread(env: Readonly<Record<string, string>>, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, { ...env, HOME: join(dir, "agent"), WSP_HOME: join(dir, "agent", ".wsp") }), io };
  }
  const json = <T>(io: Captured): T => JSON.parse(io.lines.at(-1)!) as T;

  it("a thread started here runs wsp run with the launch pair alone: a child beside it in its folder, one on a branch in a worktree, and both nest under it", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const project = await rt.projects.add({ source: repo, on: HERE_PLACE_ID, name: "mac" });
    await rt.workspaces.create({ project: project.id, name: "mac", agents: { spawn: true } });
    const byName = async (name: string): Promise<WorkspaceView> => (await rt.workspaces.list()).find(w => w.name === name)!;
    // The person's own thread in the same folder, which no thread of the lead's tree may see.
    const theirs = await rt.sessions.start((await byName("mac")).id, { prompt: "the person's own" });
    const lead = await rt.sessions.start((await byName("mac")).id, { prompt: "start two children" });
    const threadId = lead.view().threadId!;
    const launch = held.envs[1]!;
    expect(launch[HOST_URL_ENV]).toBe(`http://${LOOPBACK}:${handle!.port}`);
    const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]! };

    const ran = await thread(pair, "run", "--detach", "look around", "--json");
    expect(ran.io.errors).toEqual([]);
    expect(ran.code).toBe(0);
    const child = json<{ threadId: string }>(ran.io).threadId;
    const rows = await rt.sessions.list();
    expect(rows.find(r => r.threadId === child)).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId, workspaceId: (await byName("mac")).id, cwd: project.path });
    // The child runs at the access every thread on this computer runs at when nobody names one.
    expect(held.starts[2]!.permissionMode).toBe("bypassPermissions");
    const branched = await thread(pair, "run", "--branch", "kid", "--detach", "on a branch", "--json");
    expect(branched.io.errors).toEqual([]);
    const second = json<{ threadId: string }>(branched.io).threadId;
    expect((await rt.sessions.list()).find(r => r.threadId === second)).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId, cwd: expect.stringContaining("kid") });

    // The child's own listing is its tree: the lead and itself, never the person's thread beside them.
    const childPair = { [HOST_URL_ENV]: held.envs[2]![HOST_URL_ENV]!, [HOST_TOKEN_ENV]: held.envs[2]![HOST_TOKEN_ENV]! };
    const seen = json<{ threads: ThreadView[] }>((await thread(childPair, "threads", "--json")).io);
    expect(seen.threads.map(t => t.threadId).sort()).toEqual([threadId, child, second].sort());
    expect(seen.threads.map(t => t.threadId)).not.toContain(theirs.view().threadId);

    held.release(3, "branched");
    held.release(2, "looked");
    held.release(1, "done");
    held.release(0, "mine");
    await lead.finished;
    await theirs.finished;
  });
});

describe("a lead thread on this computer starting children on a cloud computer", () => {
  let dir: string;
  let statePath: string;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let held: ReturnType<typeof heldAgent>;
  let mcp: Client | undefined;
  let restart: () => Runtime;
  let daemons: ReturnType<typeof branchDaemons>;
  /** The branch each machine's checkout reads as on, by machine id; the work branch where none is named. */
  let branchOf: Map<string, string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-lead-cloud-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_guest_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    held = heldAgent(true);
    const here: { url?: string } = {};
    const backend = withDaemonRoads(stubBackend());
    branchOf = new Map();
    const seed = "cafef00d".repeat(3);
    daemons = branchDaemons({ seed, branchOf: machine => branchOf.get(machine) ?? GUEST_BRANCH });
    restart = () => createRuntime({
      statePath,
      backend,
      daemonToken: seed,
      daemonChannel: daemons.open,
      store,
      adapters: { claude: held.adapter },
      local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, statePath, copyingFake()),
      agents: { here, wspMcp: { command: "wsp", args: ["mcp"] } },
    });
    rt = restart();
    handle = await serve(captured(), { port: 0, statePath, webDir, runtime: rt, here });
    vi.stubEnv("SOLARI_API_KEY", "");
  });
  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function thread(env: Readonly<Record<string, string>>, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, { ...env, HOME: join(dir, "agent"), WSP_HOME: join(dir, "agent", ".wsp") }), io };
  }
  const json = <T>(io: Captured): T => JSON.parse(io.lines.at(-1)!) as T;

  /** A lead on this computer's folder of dev/lab, the same repository on the cloud as lab-cloud, and another one there. */
  async function lead(origin = "git@github.com:dev/lab.git", cloudRemote = "https://github.com/dev/lab.git"): Promise<{ threadId: string; launch: Record<string, string>; cloud: string; finished: Promise<unknown> }> {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
    const mac = await rt.projects.add({ source: repo, on: HERE_PLACE_ID, name: "lab" });
    const cloud = await rt.projects.add({ source: cloudRemote, on: "default", name: "lab-cloud" });
    await rt.projects.add({ source: "https://github.com/dev/other.git", on: "default", name: "other-cloud" });
    const folder = await rt.workspaces.create({ project: mac.id, name: "lab", agents: { spawn: true } });
    const turn = await rt.sessions.start(folder.id, { prompt: "coordinate" });
    const launch = held.envs[0]!;
    return { threadId: turn.view().threadId!, launch: { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! }, cloud: cloud.id, finished: turn.finished };
  }

  it("wsp run on a cloud project of the lead's repository forks a machine for the child, lists it, and wakes the lead at its end", async () => {
    const { threadId, launch, cloud, finished } = await lead();
    // The projects a thread may start children on are its own repository's, on every computer, and no other.
    const projects = json<{ projects: { name: string }[] }>((await thread(launch, "projects", "--json")).io);
    expect(projects.projects.map(p => p.name)).toEqual(["lab", "lab-cloud"]);
    const ran = await thread(launch, "run", "lab-cloud", "--notify", "me", "--detach", "build it", "--json");
    expect(ran.code).toBe(0);
    // The fork's stages are the progress a person reads on stderr; the child's copy starts on the lead's branch.
    expect(ran.io.errors.at(-1)).toContain("starts on work as pushed");
    const child = json<{ threadId: string }>(ran.io).threadId;
    const row = (await rt.sessions.list()).find(r => r.threadId === child)!;
    expect(row).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
    expect((await rt.workspaces.list()).find(w => w.id === row.workspaceId)).toMatchObject({ project: { id: cloud }, kind: expect.not.stringMatching(/^local$/) });
    const listed = json<{ threads: ThreadView[] }>((await thread(launch, "threads", "--json")).io);
    expect(listed.threads.map(t => t.threadId)).toContain(child);
    held.release(1, "Built it.");
    await vi.waitFor(() => expect(held.steered).toEqual([`thread ${child.slice(0, 8)} finished (completed): Built it.`]));
    held.release(0, "read it");
    await finished;
  });

  it("the run tool on that project does the same from the lead's own tool server, and the child's finished line reaches the lead", async () => {
    const { threadId, launch, cloud, finished } = await lead();
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    await mcpServer(statePath, { env: { ...launch, HOME: join(dir, "agent"), WSP_HOME: join(dir, "agent", ".wsp") }, scoped: true }).connect(toServer);
    mcp = new Client({ name: "lead", version: "0.0.0" });
    await mcp.connect(toClient);
    const ran = await mcp.callTool({ name: "run", arguments: { project: "lab-cloud", message: "build it", notify: ["me"], detach: true } });
    expect(ran.isError).not.toBe(true);
    const child = (ran.structuredContent as { threadId: string }).threadId;
    const row = (await rt.sessions.list()).find(r => r.threadId === child)!;
    expect(row).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
    expect((await rt.workspaces.list()).find(w => w.id === row.workspaceId)?.project.id).toBe(cloud);
    held.release(1, "Built it.");
    const line = `thread ${child.slice(0, 8)} finished (completed): Built it.`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect((await rt.sessions.history(row.workspaceId)).find(e => e.type === "session.notify")).toMatchObject({ threadId: child, notify: threadId, text: line });
    // The exec tool takes a thread, and a word this thread's listing holds no thread by reads as none, as on the command line.
    const exec = await mcp.callTool({ name: "exec", arguments: { thread: "other-cloud", argv: ["true"] } });
    expect(exec.isError).toBe(true);
    expect(JSON.stringify(exec.content)).toContain("no thread other-cloud");
    held.release(0, "read it");
    await finished;
  });

  /** The lead's own tool server, over the lead's launch. */
  async function toolsOf(launch: Readonly<Record<string, string>>): Promise<Client> {
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    await mcpServer(statePath, { env: { ...launch, HOME: join(dir, "agent"), WSP_HOME: join(dir, "agent", ".wsp") }, scoped: true }).connect(toServer);
    mcp = new Client({ name: "lead", version: "0.0.0" });
    await mcp.connect(toClient);
    return mcp;
  }

  /** The lead and a child it ran on lab-cloud, the child's machine checked out on its own branch, kid. */
  async function leadWithChild() {
    const held = await lead();
    const ran = await thread(held.launch, "run", "lab-cloud", "--detach", "build it", "--json");
    expect(ran.code).toBe(0);
    const child = json<{ threadId: string }>(ran.io).threadId;
    const row = (await rt.sessions.list()).find(r => r.threadId === child)!;
    const source = (await rt.workspaces.list()).find(w => w.id === row.workspaceId)!;
    branchOf.set(source.machineId, "kid");
    return { ...held, source };
  }

  it.runIf(CLOUD_ON)("wsp fork and the fork tool fork its child's machine from the child's branch, under the lead, and a workspace outside its tree is refused in run's words", async () => {
    const { threadId, launch, cloud, finished, source } = await leadWithChild();
    const forked = await thread(launch, "fork", source.name, "--name", "lab-twin");
    expect(forked.code, forked.io.errors.join("\n")).toBe(0);
    const tool = await (await toolsOf(launch)).callTool({ name: "fork", arguments: { workspace: source.name, name: "lab-triplet" } });
    expect(tool.isError, JSON.stringify(tool.content)).not.toBe(true);
    const rows = await rt.workspaces.list();
    for (const name of ["lab-twin", "lab-triplet"]) {
      const made = rows.find(w => w.name === name)!;
      // A child of the machine it forks, so it starts where that machine's work is, and in the lead's tree.
      expect(made).toMatchObject({ project: { id: cloud }, rootThreadId: threadId, parentWorkspaceId: source.id, kind: "cloud" });
      expect(daemons.frames.filter(f => f.machine === made.machineId && f["op"] === "git.startOn").map(f => f["branch"])).toEqual(["kid"]);
    }
    const other = (await rt.projects.list()).find(p => p.name === "other-cloud")!;
    await rt.workspaces.create({ project: other.id, name: "theirs" });
    const run = await thread(launch, "run", "theirs", "--detach", "build it");
    expect(run.code).toBe(EXIT_CODES.usage);
    const fork = await thread(launch, "fork", "theirs");
    expect(fork.code).toBe(EXIT_CODES.usage);
    expect(fork.io.errors.join("\n")).toBe(run.io.errors.join("\n").replace(/^wsp run:/, "wsp fork:"));
    held.release(1, "Built it.");
    held.release(0, "read it");
    await finished;
  });

  it.runIf(CLOUD_ON)("a lead's fork picks no size and no agents switch, from the command line or the tool, refused naming this computer, and its own folder is no machine to fork", async () => {
    const { threadId, launch, finished, source } = await leadWithChild();
    const here = (await rt.projects.computers()).find(c => c.id === HERE_PLACE_ID)!.name;
    const before = (await rt.workspaces.list()).length;
    const lines: [string[], string][] = [
      [["--size", "2x4"], spawnActRefusal(threadId, "size", here)],
      // A size no provider offers is the same refusal, said before the offered sizes are read.
      [["--size", "96x768"], spawnActRefusal(threadId, "size", here)],
      [["--max-depth", "5"], spawnActRefusal(threadId, "agents", here)],
      [["--max-machines", "1"], spawnActRefusal(threadId, "agents", here)],
      [["--spawn", "off"], spawnActRefusal(threadId, "agents", here)],
    ];
    for (const [flags, said] of lines) {
      const refused = await thread(launch, "fork", source.name, ...flags);
      expect(refused.code, flags.join(" ")).toBe(EXIT_CODES.usage);
      expect(refused.io.errors.at(-1)).toBe(`wsp fork: ${said}`);
    }
    const tools = await toolsOf(launch);
    const inputs: [Record<string, unknown>, string][] = [
      [{ size: "2x4" }, spawnActRefusal(threadId, "size", here)],
      [{ size: "96x768" }, spawnActRefusal(threadId, "size", here)],
      [{ max_depth: 5 }, spawnActRefusal(threadId, "agents", here)],
      [{ max_machines: 1 }, spawnActRefusal(threadId, "agents", here)],
      [{ spawn: "off" }, spawnActRefusal(threadId, "agents", here)],
    ];
    for (const [input, said] of inputs) {
      const refused = await tools.callTool({ name: "fork", arguments: { workspace: source.name, ...input } });
      expect(refused, JSON.stringify(input)).toMatchObject({ isError: true, structuredContent: { error: said, class: "usage" } });
    }
    const folder = await thread(launch, "fork", "lab");
    expect(folder.code).toBe(EXIT_CODES.usage);
    expect(folder.io.errors.at(-1)).toBe(`wsp fork: ${refusalLine(folderForkRefusal("lab"), folderForkFix("lab"))}`);
    expect(await tools.callTool({ name: "fork", arguments: { workspace: "lab" } })).toMatchObject({ isError: true, structuredContent: { error: refusalLine(folderForkRefusal("lab"), folderForkFix("lab")), class: "usage" } });
    expect(await rt.workspaces.list()).toHaveLength(before);
    held.release(1, "Built it.");
    held.release(0, "read it");
    await finished;
  });

  it("a lead on a cloud machine reads the person's folder of its repository here as theirs: unlisted and refused by that rule", async () => {
    const { launch, finished } = await lead();
    const cloud = (await rt.projects.list()).find(p => p.name === "lab-cloud")!;
    const ws = await rt.workspaces.create({ project: cloud.id, name: "cloud-lead", agents: { spawn: true } });
    const turn = await rt.sessions.start(ws.id, { prompt: "coordinate from the cloud" });
    const threadId = turn.view().threadId!;
    const asLead: Caller = { origin: "relayed", by: { kind: "thread", threadId, workspaceId: ws.id, rootThreadId: threadId } };
    expect((await rt.projects.list(asLead)).map(p => p.name)).toEqual(["lab-cloud"]);
    const folder = refusalLine(spawnFolderRefusal(threadId, "lab"), SPAWN_FOLDER_FIX);
    await expect(rt.projects.resolve("lab", asLead)).rejects.toThrow(folder);
    await expect(rt.workspaces.resolve("lab", asLead)).rejects.toThrow(folder);
    // --branch on that folder is refused by the same rule, from the command line and from the lead's tool server.
    const cloudLaunch = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: held.envs[1]![HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: held.envs[1]![TURN_TOKEN_ENV]! };
    const branched = await thread(cloudLaunch, "run", "lab", "--branch", "kid", "--detach", "build it");
    expect(branched.code).toBe(EXIT_CODES.usage);
    expect(branched.io.errors.join("\n")).toBe(`wsp run: ${folder}`);
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    await mcpServer(statePath, { env: { ...cloudLaunch, HOME: join(dir, "agent"), WSP_HOME: join(dir, "agent", ".wsp") }, scoped: true }).connect(toServer);
    mcp = new Client({ name: "cloud-lead", version: "0.0.0" });
    await mcp.connect(toClient);
    const tool = await mcp.callTool({ name: "run", arguments: { project: "lab", branch: "kid", message: "build it", detach: true } });
    expect(tool).toMatchObject({ isError: true, structuredContent: { error: folder, class: "usage" } });
    held.release(1, "done");
    await turn.finished;
    held.release(0, "read it");
    await finished;
  });

  it.runIf(CLOUD_ON)("a name the thread may not use is refused by its rule and fix in the word it typed, never as no workspace", async () => {
    const { threadId, launch, cloud, finished } = await lead();
    const says = async (...argv: string[]): Promise<string> => (await thread(launch, ...argv)).io.errors.join("\n");
    const ran = await thread(launch, "run", "other-cloud", "--notify", "me", "--detach", "build it");
    expect(ran.code).toBe(EXIT_CODES.usage);
    expect(ran.io.errors.join("\n")).toBe(`wsp run: ${refusalLine(spawnRepositoryRefusal(threadId, "lab", "other-cloud"), SPAWN_REPOSITORY_FIX)}`);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["lab"]);
    // A machine the person made on the lead's own repository is outside the lead's tree: refused by that rule, with
    // the road to a child of its own. Named by its whole id, the sentence carries the id and never the name.
    const theirs = await rt.workspaces.create({ project: cloud, name: "theirs" });
    expect(await says("run", "theirs", "--detach", "build it")).toBe(`wsp run: ${refusalLine(spawnReachRefusal(threadId, "theirs"), spawnReachFix("lab-cloud", true))}`);
    const byId = await says("run", theirs.id, "--detach", "build it");
    expect(byId).toBe(`wsp run: ${refusalLine(spawnReachRefusal(threadId, theirs.id), spawnReachFix("lab-cloud", true))}`);
    expect(byId).not.toContain("theirs");
    // A machine on another repository's project is refused as a workspace of another repository, in the word typed
    // and never its project's name, for every verb that reads a name.
    const other = (await rt.projects.list()).find(p => p.name === "other-cloud")!;
    const nightly = await rt.workspaces.create({ project: other.id, name: "nightly" });
    const foreign = (word: string): string => refusalLine(spawnRepositoryWorkspaceRefusal(threadId, "lab", word), SPAWN_REPOSITORY_WORKSPACE_FIX);
    expect(await says("run", "nightly", "--detach", "build it")).toBe(`wsp run: ${foreign("nightly")}`);
    // Exec takes a thread: a word this thread's listing holds no thread by reads as none, whatever else it names, and
    // its own project's name says the line takes a thread.
    const execNightly = await thread(launch, "exec", "nightly", "--", "true");
    expect(execNightly.code).toBe(EXIT_CODES.usage);
    expect(execNightly.io.errors.join("\n")).toBe("wsp exec: no thread nightly");
    for (const word of [nightly.id, "other-cloud", "theirs"]) expect(await says("exec", word, "--", "true")).toBe(`wsp exec: no thread ${word}`);
    expect(await says("exec", "lab", "--", "true")).toBe(`wsp exec: ${refusalLine(notAThreadLine("lab", "project", "wsp exec"), NAME_A_THREAD_FIX)}`);
    expect((await thread(launch, "exec", threadId, "--", "true")).code).toBe(0);
    // A worktree the person made on the lead's own folder is outside the tree too, and the road there opens a thread
    // in the folder, which forks nothing.
    const mac = (await rt.projects.list()).find(p => p.name === "lab")!;
    await rt.workspaces.worktree({ project: mac.id, branch: "feat" });
    const tree = (await rt.workspaces.list()).find(w => w.worktree?.branch === "feat")!;
    expect(await says("run", tree.name, "--detach", "build it")).toBe(`wsp run: ${refusalLine(spawnReachRefusal(threadId, tree.name), spawnReachFix("lab", false))}`);
    expect(await says("run", "nothing-here", "--detach", "build it")).toBe(`wsp run: ${noWorkspaceRefusal("nothing-here")}`);
    // Another folder of the same repository on this computer is the person's: a thread started there would stand
    // outside the tree, so it is not listed, it is refused by that rule, and no worktree is made in it.
    const sibling = join(dir, "sibling");
    execFileSync("git", ["clone", "-q", join(dir, "repo"), sibling]);
    execFileSync("git", ["-C", sibling, "remote", "set-url", "origin", "git@github.com:dev/lab.git"]);
    await rt.projects.add({ source: sibling, on: HERE_PLACE_ID, name: "lab-two" });
    expect(json<{ projects: { name: string }[] }>((await thread(launch, "projects", "--json")).io).projects.map(p => p.name)).toEqual(["lab", "lab-cloud"]);
    expect(await says("run", "lab-two", "--detach", "build it")).toBe(`wsp run: ${refusalLine(spawnFolderRefusal(threadId, "lab-two"), SPAWN_FOLDER_FIX)}`);
    expect(await says("run", "lab-two", "--branch", "kid", "--detach", "build it")).toBe(`wsp run: ${refusalLine(spawnFolderRefusal(threadId, "lab-two"), SPAWN_FOLDER_FIX)}`);
    expect(await says("exec", "lab-two", "--", "true")).toBe("wsp exec: no thread lab-two");
    const worktree = await thread(launch, "worktree", "lab-two", "kid");
    expect(worktree.code).toBe(EXIT_CODES.usage);
    expect(worktree.io.errors.join("\n")).toBe(`wsp worktree: ${refusalLine(spawnFolderRefusal(threadId, "lab-two"), SPAWN_FOLDER_FIX)}`);
    held.release(0, "read it");
    await finished;
  });

  /** The projects the thread lists, and the project of the machine a child it runs on each one stands on. */
  async function listsAndRuns(launch: Record<string, string>, ...projects: string[]): Promise<{ listed: string[]; childProjects: (string | undefined)[] }> {
    const listed = json<{ projects: { name: string }[] }>((await thread(launch, "projects", "--json")).io).projects.map(p => p.name);
    const childProjects: (string | undefined)[] = [];
    for (const project of projects) {
      const ran = await thread(launch, "run", project, "--detach", "build it", "--json");
      expect(ran.io.errors.join("\n")).not.toContain("another repository");
      expect(ran.code).toBe(0);
      const row = (await rt.sessions.list()).find(r => r.threadId === json<{ threadId: string }>(ran.io).threadId)!;
      childProjects.push((await rt.workspaces.list()).find(w => w.id === row.workspaceId)?.project.name);
    }
    return { listed, childProjects };
  }
  const remotes = async (): Promise<Record<string, string | undefined>> => Object.fromEntries((await rt.projects.list()).map(p => [p.name, p.remote]));

  it("a lead whose folder's origin moved starts children on cloud projects recorded under the old name and the new, and no record changes", async () => {
    const { finished, launch } = await lead("git@github.com:old/lab.git");
    await rt.projects.add({ source: "https://github.com/Old/Lab", on: "default", name: "lab-old" });
    await rt.projects.add({ source: "https://github.com/old/lib.git", on: "default", name: "lib-cloud" });
    const before = await remotes();
    execFileSync("git", ["-C", join(dir, "repo"), "remote", "set-url", "origin", "git@github.com:dev/lab.git"]);
    expect(await listsAndRuns(launch, "lab-cloud", "lab-old")).toEqual({ listed: ["lab", "lab-cloud", "lab-old"], childProjects: ["lab-cloud", "lab-old"] });
    expect(await remotes()).toEqual(before);
    held.release(2, "Built it.");
    held.release(1, "Built it.");
    held.release(0, "read it");
    await finished;
  });

  it("a lead whose folder's origin points at a fork changes no other project's record", async () => {
    const { finished, launch } = await lead();
    await rt.projects.add({ source: "https://github.com/me/lab.git", on: "default", name: "lab-fork" });
    const before = await remotes();
    execFileSync("git", ["-C", join(dir, "repo"), "remote", "set-url", "origin", "git@github.com:me/lab.git"]);
    expect(await listsAndRuns(launch, "lab-cloud")).toEqual({ listed: ["lab", "lab-cloud", "lab-fork"], childProjects: ["lab-cloud"] });
    expect(await remotes()).toEqual(before);
    held.release(1, "Built it.");
    held.release(0, "read it");
    await finished;
  });

  it("a lead whose folder's origin moved still lists and reaches its child on the new name after a host restart, before it reads any project", async () => {
    const { threadId, finished, launch } = await lead("git@github.com:old/lab.git");
    execFileSync("git", ["-C", join(dir, "repo"), "remote", "set-url", "origin", "git@github.com:dev/lab.git"]);
    const ran = await thread(launch, "run", "lab-cloud", "--detach", "build it", "--json");
    expect(ran.code).toBe(0);
    const child = (await rt.sessions.list()).find(r => r.threadId === json<{ threadId: string }>(ran.io).threadId)!.workspaceId;
    const leadWorkspace = (await rt.sessions.list()).find(r => r.threadId === threadId)!.workspaceId;
    held.release(1, "Built it.");
    held.release(0, "read it");
    await finished;
    await handle?.close();
    handle = undefined;
    await rt.close();
    rt = restart();
    const asLead: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: leadWorkspace, rootThreadId: threadId } };
    expect((await rt.workspaces.list(asLead)).map(w => w.name).sort()).toEqual(["lab", (await rt.workspaces.get(child)).name].sort());
    expect((await rt.workspaces.get(child, asLead)).id).toBe(child);
    await rt.close();
  });
});
