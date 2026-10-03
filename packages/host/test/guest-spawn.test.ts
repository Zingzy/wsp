// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command a turn's own agent runs, against the host that launched it:
// on a fork, the line its daemon carries up the link this host holds, with the
// token its launch left in the environment; on this computer, the node wsp
// dialling the pair its launch carries. The road a thread takes to open a
// thread beside it, on another machine or on a branch, and where each nests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsOffRefusal, HERE_PLACE_ID, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LOOPBACK, MCP_SERVER_NAME, SCOPED_MCP_ARG, TURN_TOKEN_ENV, type ThreadView, type WorkspaceView } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { guestKinds } from "../src/guest-tools.js";
import { guestDoor, type GuestDoor, type GuestLink } from "../src/guest.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, withDaemonRoads } from "./stub-backend.js";
import { branchDaemons } from "../../runtime/test/stub-backend.js";
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
      backend: withDaemonRoads(stubBackend()),
      daemonChannel: branchDaemons().open,
      store,
      adapters: { claude: ctx => ({ ...held.adapter(ctx), mcpServers: true as const }) },
      local: localWiring(join(dir, "user")),
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

  it("a turn on a spawn on fork gets its token with no address advertised, and runs a child on its machine that nests under it", async () => {
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

    // The switch is read at the act: turned off while the turn runs, the next line out of it is refused.
    await rt.workspaces.agents(one.id, { spawn: false });
    expect((await guest(one.id, launch, "run", "one", "--detach", "reply ok")).err).toContain(agentsOffRefusal("one", "thread_new"));
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
      backend: withDaemonRoads(stubBackend()),
      daemonChannel: branchDaemons().open,
      store: memoryStore(),
      adapters: { claude: held.adapter },
      local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, undefined, copyingFake()),
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
