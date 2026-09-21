// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend, type MachineBackend } from "@wsp/engine";
import { HERE_PLACE_ID,
  AGENTS_ON,
  HOST_KEY_ENV,
  HOST_TOKEN_ENV,
  HOST_URL_ENV,
  MCP_SERVER_NAME,
  NOTIFY_ME,
  RUNTIME_OPS,
  SCOPED_TOKEN_ROAD_REFUSAL,
  THREAD_OPS,
  threadOpRefusal,
  workspaceIdOf,
  agentsKindRefusal,
  agentsOffRefusal,
  noMcpServersLine,
  spawnActRefusal,
  spawnCapRefusal,
  spawnGoldenRefusal,
  spawnDepthRefusal,
  bareNoSuchProjectLine,
  noSuchProjectLine,
  ID_PREFIX_MIN,
  nameTakenRefusal,
  noWorkspaceRefusal,
  parentProjectRefusal,
  spawnProjectRefusal,
  spawnReachRefusal,
  threadWord,
  type Caller,
  type McpServerSpec,
  type ThreadScope,
  type TurnResult,
} from "@wsp/protocol";
import { copyKey, createRuntime, type HarnessAdapterFactory, type HostReach, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { keyFingerprint } from "@wsp/engine";
import { newPlaceKeyPair } from "../src/places.js";
import { stubBackend, createOn, projectOn, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient, createOverWire } from "./ws-client.js";

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

/** The one image this host holds, at head: what a thread's fork starts from, since a thread names none. */
const IMAGE = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_image-v1", kind: "desktop", baseTemplate: "base", setupSha: "abc", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }],
};

describe("agents spawning agents", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;

  /** The pair this host proves itself with, as every host a person starts holds one: the launch hands a turn its
   * fingerprint, and the wsp inside that turn refuses any host that proves another key. */
  const hostKey = newPlaceKeyPair();
  const runtimeWith = (adapters: Record<string, HarnessAdapterFactory>, agents?: { reach?: HostReach; wspMcp?: McpServerSpec }, backend: MachineBackend = stubBackend()): Runtime =>
    createRuntime({
      backend,
      store,
      adapters,
      local: localWiring,
      placeLinks: { hostKey, provider: () => undefined, here: () => ({ name: "this-mac" }), hostName: () => "this-mac" },
      ...(agents !== undefined ? { agents } : {}),
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "wsp-spawn-"));
    store = memoryStore();
    // The image this host holds, which every fork a thread asks for takes: a thread names none, so the head has to
    // be here for its create to have anything to start from.
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
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
    const ws = await createOn(rt, { golden: "snap_g", name: "b1" });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    await expect(rt.sessions.start(ws.id, { prompt: "hi" }, asThread(scope))).rejects.toThrow(agentsOffRefusal("b1", "thread_new"));
    await expect(createOn(rt, { name: "b2" }, asThread(scope))).rejects.toThrow(agentsOffRefusal("b1", "fork"));
    await rt.close();
  });

  it("with the switch on, a fork by a thread records the thread that asked and the root of its tree", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const forked = await createOn(rt, { name: "builder" }, asThread(scope));
    expect(forked.parentThreadId).toBe(rootThread);
    expect(forked.rootThreadId).toBe(rootThread);
    // The fork stores no switch of its own; what it may do is the tree's, read off the workspace its root runs on.
    expect(forked.agents).toEqual(AGENTS_ON);
    held.end(0);
    await rt.close();
  });

  it("a thread's fork is a child of its own workspace, holding its project and starting on the branch it is on", async () => {
    const held = heldAdapter();
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: "pricing-page\norigin/pricing-page\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } }, backend);
    const project = await projectOn(rt);
    const ws = await createOn(rt, { project: project.id, golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const child = await createOn(rt, { project: project.id, name: "helper" }, asThread(scope));
    expect(child.parentWorkspaceId).toBe(ws.id);
    expect(child.project.id).toBe(project.id);
    // The clone inside the child starts where its parent stands now, not where the project starts.
    expect(backend.machines[1]!.execLog.find(cmd => cmd.includes("git clone"))).toContain("--branch pricing-page");
    held.end(0);
    await rt.close();
  });

  it("a thread's fork takes the image its own workspace runs, and one it names is refused before any machine is asked for", async () => {
    const held = heldAdapter();
    const backend = stubBackend();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } }, backend);
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const standing = backend.machines.length;
    await expect(createOn(rt, { golden: "snap_image-v1", name: "mine" }, asThread(scope))).rejects.toThrow(spawnGoldenRefusal(rootThread));
    await expect(createOn(rt, { golden: "snap_someone-else", name: "theirs" }, asThread(scope))).rejects.toThrow(spawnGoldenRefusal(rootThread));
    expect(backend.machines).toHaveLength(standing);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
    // With none named it forks what this host holds at head, which is the image its own workspace's project runs.
    await createOn(rt, { name: "ours" }, asThread(scope));
    expect(backend.machines.at(-1)!.spec.fromSnapshot).toBe("snap_image-v1");
    held.end(0);
    await rt.close();
  });

  it("a thread's fork is a child of its own workspace whatever parent it names, and no other machine is read", async () => {
    const held = heldAdapter();
    const backend = stubBackend();
    // Each machine says which branch its checkout is on, so a read of the wrong one shows up in the child's base.
    backend.execImpl = (m, cmd) => (cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: `${m.id}-branch\norigin/${m.id}-branch\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } }, backend);
    const project = await projectOn(rt);
    const ws = await createOn(rt, { project: project.id, golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const theirs = await createOn(rt, { project: project.id, golden: "snap_g", name: "theirs" });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const foreign = backend.machines.find(m => m.id === theirs.machineId)!;
    const readsBefore = foreign.execLog.filter(cmd => cmd.includes("rev-parse")).length;
    const child = await createOn(rt, { project: project.id, name: "ours", parent: theirs.id }, asThread(scope));
    expect(child.parentWorkspaceId).toBe(ws.id);
    // The branch the child starts on is its own workspace's, and the workspace it named was never asked.
    expect(backend.machines.find(m => m.id === ws.machineId)!.execLog.some(cmd => cmd.includes("rev-parse"))).toBe(true);
    expect(foreign.execLog.filter(cmd => cmd.includes("rev-parse")).length).toBe(readsBefore);
    expect(backend.machines.at(-1)!.execLog.find(cmd => cmd.includes("git clone"))).toContain(`--branch ${ws.machineId}-branch`);
    held.end(0);
    await rt.close();
  });

  it("a person's create takes a parent of the project it is made for and refuses one of another", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const mine = await projectOn(rt);
    const other = await projectOn(rt);
    const parent = await createOn(rt, { project: mine.id, golden: "snap_g", name: "parent" });
    const elsewhere = await createOn(rt, { project: other.id, golden: "snap_g", name: "elsewhere" });
    await expect(rt.workspaces.create({ project: mine.id, golden: "snap_g", name: "child", parent: elsewhere.id })).rejects.toThrow(parentProjectRefusal("elsewhere", other.name, mine.name));
    const child = await rt.workspaces.create({ project: mine.id, golden: "snap_g", name: "child", parent: parent.id });
    expect(child.parentWorkspaceId).toBe(parent.id);
    await rt.close();
  });

  it("a thread works on its own project alone: another project's create and another project's workspace are both refused by it", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const mine = await projectOn(rt);
    const other = await projectOn(rt);
    const ws = await createOn(rt, { project: mine.id, golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const theirs = await createOn(rt, { project: other.id, golden: "snap_g", name: "docs", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    // A project word the thread's own workspace does not hold is absent to it, and so is every workspace of one:
    // both read as missing rather than naming the project or the workspace the thread may not have.
    await expect(createOn(rt, { project: other.id, name: "elsewhere" }, asThread(scope))).rejects.toThrow(bareNoSuchProjectLine(other.id));
    for (const reach of [
      () => rt.sessions.start(theirs.id, { prompt: "hi" }, asThread(scope)),
      () => rt.workspaces.get(theirs.id, asThread(scope)),
      () => rt.workspaces.bringBack({ workspaceId: theirs.id }, asThread(scope)),
    ]) {
      await expect(reach()).rejects.toThrow(noWorkspaceRefusal());
      await expect(reach()).rejects.not.toThrow(other.name);
    }
    // The person still reads which rule hid it, since what this host holds is theirs.
    expect(await rt.workspaces.originRefusal(theirs.id, asThread(scope))).toBe(spawnProjectRefusal(rootThread, mine.name, other.name));
    // Its own workspace is still its own, and the listing shows that one and no other project's.
    expect((await rt.workspaces.list(asThread(scope))).map(w => w.name)).toEqual(["lead"]);
    held.end(0);
    await rt.close();
  });

  it("a thread's landing resolves its own project alone, and the refusal names no other", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const mine = await projectOn(rt);
    const other = await projectOn(rt);
    const ws = await createOn(rt, { project: mine.id, golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    // Its own project answers as it does for the person.
    expect((await rt.workspaces.landing({ project: mine.id }, asThread(scope))).name).toBe((await rt.workspaces.landing({ project: mine.id })).name);
    for (const word of [other.id, other.name, "nothing-here"]) {
      const refusal = rt.workspaces.landing({ project: word }, asThread(scope));
      await expect(refusal).rejects.toThrow(bareNoSuchProjectLine(word));
      await expect(refusal).rejects.not.toThrow(other.name === word ? "this host holds" : other.name);
    }
    // A create naming another project reads the same sentence, and the person still reads every project by name.
    await expect(createOn(rt, { project: other.id, name: "elsewhere" }, asThread(scope))).rejects.toThrow(bareNoSuchProjectLine(other.id));
    await expect(rt.workspaces.landing({ project: "nothing-here" })).rejects.toThrow(noSuchProjectLine("nothing-here", [mine.name, other.name]));
    held.end(0);
    await rt.close();
  });

  it("a thread's landing over the wire reads its own project and no other", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const mine = await projectOn(rt);
    const other = await projectOn(rt);
    const ws = await createOn(rt, { project: mine.id, golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const client = await WsClient.connect(srv.port, { token: held.launches[0]!.env[HOST_TOKEN_ENV]! });
      expect((await client.request("workspaces.landing", { project: mine.id }))["ok"]).toBe(true);
      const refused = await client.request("workspaces.landing", { project: other.name });
      expect(refused["ok"]).toBe(false);
      expect(refused["error"]).toBe(bareNoSuchProjectLine(other.name));
      const mine2 = await WsClient.connect(srv.port, { token: "secret" });
      expect(String((await mine2.request("workspaces.landing", { project: "nothing-here" }))["error"])).toBe(noSuchProjectLine("nothing-here", [mine.name, other.name]));
      mine2.close();
      client.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("the machine past the cap is refused with the sentence naming the root and the count", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 1 } });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    await createOn(rt, { name: "b1" }, asThread(scope));
    await createOn(rt, { name: "b2" }, asThread(scope));
    await expect(createOn(rt, { name: "b3" }, asThread(scope))).rejects.toThrow(spawnCapRefusal("t_root", 2, 2));
    // A machine deleted gives its place back, counted off the records rather than off a number kept somewhere.
    const b1 = (await rt.workspaces.list()).find(w => w.name === "b1")!;
    await rt.workspaces.delete(b1.id);
    const b3 = await createOn(rt, { name: "b3" }, asThread(scope));
    expect(b3.rootThreadId).toBe("t_root");
    await rt.close();
  });

  it("a thread the tree already spawned may not spawn again at one level", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
    await expect(createOn(rt, { name: "deep" }, asThread(childScope))).rejects.toThrow(spawnDepthRefusal(childThread, 1, 1));
    held.end(1);
    held.end(0);
    await rt.close();
  });

  it("a thread may send into a thread of its own tree however deep it sits", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    await expect(rt.workspaces.delete(ws.id, asThread(scope))).rejects.toThrow(spawnActRefusal("t_root", "delete"));
    await expect(rt.workspaces.nap(ws.id, asThread(scope))).rejects.toThrow(spawnActRefusal("t_root", "pause"));
    await expect(rt.workspaces.agents(ws.id, { spawn: false }, asThread(scope))).rejects.toThrow(spawnActRefusal("t_root", "agents"));
    await rt.close();
  });

  it("a thread reaches the workspace it runs on and the ones its root forked, and no other", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const mine = await createOn(rt, { golden: "snap_g", name: "mine", agents: AGENTS_ON });
    // The other workspace holds the same project, so what hides it is the tree rule and nothing else.
    const theirs = await createOn(rt, { project: mine.project.id, golden: "snap_g", name: "theirs", agents: AGENTS_ON });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: mine.id, rootThreadId: "t_root" };
    const forked = await createOn(rt, { name: "ours" }, asThread(scope));
    expect((await rt.workspaces.get(forked.id, asThread(scope))).name).toBe("ours");
    // A workspace outside the tree reads as missing and nothing else: its name, its id and the ids a start of one
    // matches are what a thread would otherwise walk this host with.
    await expect(rt.sessions.start(theirs.id, { prompt: "hi" }, asThread(scope))).rejects.toThrow(noWorkspaceRefusal());
    await expect(rt.workspaces.get(theirs.id, asThread(scope))).rejects.toThrow(noWorkspaceRefusal());
    await expect(rt.workspaces.get(theirs.id, asThread(scope))).rejects.not.toThrow("theirs");
    // The listing leaves out what it may not drive rather than naming it, and the name is refused by the same rule:
    // one reading behind the list and behind every verb that takes a workspace, so neither can deny what the other shows.
    expect((await rt.workspaces.list(asThread(scope))).map(w => w.name).sort()).toEqual(["mine", "ours"]);
    expect((await rt.status.list(undefined, asThread(scope))).map(s => s.name).sort()).toEqual(["mine", "ours"]);
    expect((await rt.workspaces.resolve("mine", asThread(scope))).id).toBe(mine.id);
    for (const word of ["theirs", theirs.id, theirs.id.slice(0, 6), "nobody"]) {
      await expect(rt.workspaces.resolve(word, asThread(scope))).rejects.toThrow(noWorkspaceRefusal(word));
    }
    // Every id of this host starts ws_, so the start a thread would walk the whole host with answers off its own
    // listing: the shortest prefix that names one workspace there, whatever the ids outside the tree share with it.
    let n = ID_PREFIX_MIN;
    while (mine.id.startsWith(forked.id.slice(0, n))) n++;
    expect((await rt.workspaces.resolve(forked.id.slice(0, n), asThread(scope))).id).toBe(forked.id);
    // A name a workspace outside the tree holds is still taken, which is the thread's own word answered back.
    await expect(createOn(rt, { name: "theirs" }, asThread(scope))).rejects.toThrow(nameTakenRefusal("theirs"));
    // The very word the thread reads as absent is a workspace to the person, which is what makes it a rule and not
    // a missing record.
    expect((await rt.workspaces.resolve("theirs")).id).toBe(theirs.id);
    await rt.close();
  });

  it("an id this host does not hold reads a thread exactly as one outside its tree, on every verb that takes one", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const mine = await createOn(rt, { golden: "snap_g", name: "mine", agents: AGENTS_ON });
    const theirs = await createOn(rt, { project: mine.project.id, golden: "snap_g", name: "theirs" });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: mine.id, rootThreadId: "t_root" };
    const nobody = "ws_00000000";
    for (const id of [theirs.id, nobody]) {
      for (const reach of [
        () => rt.sessions.list(id, asThread(scope)),
        () => rt.sessions.history(id, asThread(scope)),
        () => rt.workspaces.get(id, asThread(scope)),
      ]) {
        await expect(reach()).rejects.toThrow(noWorkspaceRefusal());
        await expect(reach()).rejects.not.toThrow("theirs");
      }
    }
    // Its own workspace still answers, and the person reads an id nobody holds as the empty listing it always was.
    expect(await rt.sessions.list(mine.id, asThread(scope))).toEqual([]);
    expect(await rt.sessions.list(nobody)).toEqual([]);
    await rt.close();
  });

  it("a turn on a spawn enabled workspace carries a scoped device that is taken away at the exit", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const threadId = handle.view().threadId!;
    const listed = await rt.devices.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe(`thread ${threadWord(threadId)}`);
    expect(listed[0]!.scope).toEqual({ kind: "thread", threadId, workspaceId: ws.id, rootThreadId: threadId });
    const launch = held.launches[0]!;
    expect(launch.env[HOST_URL_ENV]).toBe("http://10.0.0.2:4700");
    expect(launch.env[HOST_TOKEN_ENV]).toMatch(/\S/);
    // The fingerprint of the key this host proves travels with them: the turn's own wsp holds the host to it
    // before the token crosses, so a relay carrying the bytes or naming another host at that address gets nothing.
    expect(launch.env[HOST_KEY_ENV]).toBe(keyFingerprint(hostKey.publicKey));
    held.end(0);
    await handle.finished;
    await gone(rt);
    expect(await rt.devices.list()).toEqual([]);
    await rt.close();
  });

  it("a fork whose machine knows none is told the address this host advertises", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://192.168.1.20:4700", port: 4700 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(held.launches[0]!.env[HOST_URL_ENV]).toBe("http://192.168.1.20:4700");
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("the address the person named stands above the one this host bound", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { advertise: "https://box.example", url: "http://192.168.1.20:4700", port: 4700 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(held.launches[0]!.env[HOST_URL_ENV]).toBe("https://box.example");
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("a turn on this computer is told no address and handed no token, whatever its record says", async () => {
    const held = heldAdapter();
    const first = runtimeWith({ claude: held.factory }, { reach: { url: "http://192.168.1.20:4700", port: 4700 } });
    const mac = await createOn(first, { on: HERE_PLACE_ID, name: "mac" });
    const stored = (await store.get("workspaces", mac.id)) as Record<string, unknown>;
    await first.close();
    // Both doors refuse the switch on this kind, so the record is written by hand: the address is the kind's
    // answer and not the door's, and a turn here runs beside the host rather than dialling in.
    await store.put("workspaces", mac.id, { ...stored, agents: AGENTS_ON });
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://192.168.1.20:4700", port: 4700 } });
    const handle = await rt.sessions.start(mac.id, { prompt: "hi" });
    expect(held.launches[0]!.env[HOST_URL_ENV]).toBeUndefined();
    expect(held.launches[0]!.env[HOST_TOKEN_ENV]).toBeUndefined();
    expect(held.launches[0]!.env[HOST_KEY_ENV]).toBeUndefined();
    expect(await rt.devices.list()).toEqual([]);
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("a host that knows no address a machine can dial hands out no token at all", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(await rt.devices.list()).toEqual([]);
    expect(held.launches[0]!.env[HOST_TOKEN_ENV]).toBeUndefined();
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("a workspace with the switch off hands out no token either", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "quiet" });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(await rt.devices.list()).toEqual([]);
    expect(held.launches[0]!.env[HOST_URL_ENV]).toBeUndefined();
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("the wsp tools ride the launch on a harness that takes servers, at the path the daemon bundle put them", async () => {
    const held = heldAdapter({ takesMcpServers: true });
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(held.launches[0]!.mcpServers?.[MCP_SERVER_NAME]).toEqual({ command: "wsp", args: ["mcp"] });
    // The line carries no host word, and the launch still carries the pair a turn reads its host and token off.
    expect(held.launches[0]!.mcpServers?.[MCP_SERVER_NAME]?.args).not.toContain("--host");
    expect(held.launches[0]!.env[HOST_URL_ENV]).toBe("http://10.0.0.2:4700");
    held.end(0);
    await handle.finished;
    await rt.close();
  });

  it("a harness that takes no server with a launch gets none and is refused only where a caller named its own", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ codex: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
      // A thread names a project it can already see; recording one is the person's own act, refused at the door.
      expect((await client.request("projects.add", { source: "https://github.com/wsp/x.git", on: "default" }))["ok"]).toBe(false);
      const forked = (await client.request("workspaces.create", { project: ws.project.id, name: "builder" }))["workspace"] as { rootThreadId?: string };
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
    const first = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(first, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    await first.sessions.start(ws.id, { prompt: "hi" });
    expect(await first.devices.list()).toHaveLength(1);
    // The host goes down under the running turn, so nothing reached the exit that hands the token back.
    await first.close();
    const again = runtimeWith({ claude: heldAdapter().factory }, { reach: { url: "http://10.0.0.2:4700" } });
    await again.workspaces.list();
    expect(await again.devices.list()).toEqual([]);
    await again.close();
  });

  it("a socket whose token is a thread's may not read or take away the devices paired with this host", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const mine = await createOn(rt, { golden: "snap_g", name: "mine", agents: AGENTS_ON });
    const theirs = await createOn(rt, { golden: "snap_g", name: "theirs" });
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
      const made = await createOn(rt, { golden: "snap_g", name: "hers" });
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

  it("a thread that forks sees every creating stage of its own fork and none of another thread's", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const mine = await createOn(rt, { golden: "snap_g", name: "mine", agents: AGENTS_ON });
    const theirs = await createOn(rt, { golden: "snap_g", name: "theirs", agents: AGENTS_ON });
    const onMine = await rt.sessions.start(mine.id, { prompt: "hi" });
    const onTheirs = await rt.sessions.start(theirs.id, { prompt: "hi" });
    const myScope: ThreadScope = { kind: "thread", threadId: onMine.view().threadId!, workspaceId: mine.id, rootThreadId: onMine.view().threadId! };
    const theirScope: ThreadScope = { kind: "thread", threadId: onTheirs.view().threadId!, workspaceId: theirs.id, rootThreadId: onTheirs.view().threadId! };
    // What the bus said, by workspace, so each socket is read against every stage the runtime actually reached
    // rather than against a list of stage names a backend change would quietly make wrong.
    const staged = new Map<string, string[]>();
    const offBus = rt.events.on("workspace.creating", e => {
      const stage = e as { workspaceId: string; stage: string };
      staged.set(stage.workspaceId, [...(staged.get(stage.workspaceId) ?? []), stage.stage]);
    });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const myClient = await WsClient.connect(srv.port, { token: held.launches[0]!.env[HOST_TOKEN_ENV]! });
      const theirClient = await WsClient.connect(srv.port, { token: held.launches[1]!.env[HOST_TOKEN_ENV]! });
      await myClient.request("events.subscribe", {});
      await theirClient.request("events.subscribe", {});
      const ours = await createOn(rt, { name: "ours" }, asThread(myScope));
      const others = await createOn(rt, { name: "others" }, asThread(theirScope));
      await new Promise(r => setTimeout(r, 50));
      const stagesOn = (client: WsClient, id: string): unknown[] =>
        client.events.filter(e => e.type === "workspace.creating" && e["workspaceId"] === id).map(e => e["stage"]);
      // Every stage from the first, which is emitted before the fork has a record for the filter to read.
      expect(staged.get(ours.id)![0]).toBe("fork-requested");
      expect(staged.get(ours.id)!.length).toBeGreaterThan(1);
      expect(stagesOn(myClient, ours.id)).toEqual(staged.get(ours.id));
      expect(stagesOn(theirClient, others.id)).toEqual(staged.get(others.id));
      // And nothing of the other tree's fork, at any stage, in either direction.
      expect(stagesOn(myClient, others.id)).toEqual([]);
      expect(stagesOn(theirClient, ours.id)).toEqual([]);
      myClient.close();
      theirClient.close();
    } finally {
      offBus();
      await srv.close();
      held.end(1);
      held.end(0);
      await onTheirs.finished;
      await onMine.finished;
      await rt.close();
    }
  });

  it("a thread's token opens the socket door on the host's own road alone, and a token with no scope on any road", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const code = await rt.devices.issue({ now: Date.now(), ttlMs: 60_000 });
    const paired = (await rt.devices.redeem(code.code, "a computer of the person's", Date.now()))!;
    // The road the host reads off each upgrade, as the host that serves the page builds it: the connector's own
    // headers say a request was forwarded here rather than typed on this computer.
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices, ownRoad: req => req.headers["cf-ray"] === undefined });
    const connector = { "cf-ray": "8e0f4a1b2c3d4e5f-BOM", "cf-connecting-ip": "203.0.113.7" };
    try {
      // The copy carried out of a machine and dialled from off this computer: refused at the auth frame, in one
      // sentence, and the socket closed with nothing of the thread bound to it.
      const carried = await WsClient.connectTo(`ws://127.0.0.1:${srv.port}/`, { headers: connector });
      const refused = await carried.request("auth", { token });
      expect(refused["ok"]).toBe(false);
      expect(refused["error"]).toBe(SCOPED_TOKEN_ROAD_REFUSAL);
      expect(await carried.closed()).toBe(4401);
      // The same token on the road this host serves its own workspaces' guests on drives that thread's tree.
      const own = await WsClient.connect(srv.port, { token });
      expect(((await own.request("workspaces.list"))["workspaces"] as { name: string }[]).map(w => w.name)).toEqual(["lead"]);
      own.close();
      // A device the person paired carries no scope, so neither road is shut to it.
      const theirs = await WsClient.connectTo(`ws://127.0.0.1:${srv.port}/`, { headers: connector });
      expect((await theirs.request("auth", { token: paired.deviceToken }))["ok"]).toBe(true);
      theirs.close();
    } finally {
      await srv.close();
      held.end(0);
      await handle.finished;
      await rt.close();
    }
  });

  it("every op this host answers is either one a thread may send or one its socket is refused", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
      // The one read a fork asks before the act: whether this host forks at all and at which sizes, so the refusal
      // for a host that mints nothing comes in one sentence before any stage is streamed.
      expect(reached).toContain("capabilities.get");
      // The manifest holds every version's snapshot id and every sign-in sealed into the image, and a thread forks
      // the image its own workspace runs whatever it names, so the read is shut to it by name.
      expect(refused).toContain("golden.get");
      expect(refused).toContain("golden.prepare");
      expect(refused).toContain("snapshots.list");
      expect(refused).toContain("snapshots.rollback");
      expect(refused).toContain("preferences.get");
      expect(refused).toContain("preferences.set");
      expect(refused).toContain("projectGoldens.list");
      expect(refused).toContain("init.keys");
      expect(refused).toContain("host.folders");
      expect(refused).toContain("project.import");
      expect(refused).toContain("projects.add");
      expect(refused).toContain("projects.remove");
      expect(refused).toContain("workspaces.delete");
      expect(refused).toContain("workspaces.agents");
      // A thread never lifts a running turn's access mode and never answers a permission prompt, its own or a
      // sibling's: that guard is the person's on the agent, and an agent moving it is the guard moving itself.
      expect(refused).toContain("sessions.access");
      expect(refused).toContain("sessions.answer");
      // Dropping a thread from the person's own lists is the person's, not one thread's act on another.
      expect(refused).toContain("sessions.forget");
      // The panes a person types into are the person's: a thread drives its workspace through the exec and session
      // ops, and the channel that carries a pty, a file read and a git status to a browser is shut to it by name.
      expect(refused).toContain("daemon.open");
      expect(refused).toContain("daemon.send");
      expect(refused).toContain("daemon.close");
      // A client of the person's own reaches every one of them, so the gate is the token's and not the op's.
      const mine = await WsClient.connect(srv.port, { token: "secret" });
      expect((await mine.request("preferences.get", {}))["ok"]).toBe(true);
      expect(String((await mine.request("snapshots.list", {}))["error"])).not.toContain("not a thread's");
      // The person's own socket still reads the image by name, head, versions and all.
      expect((await mine.request("golden.get", { name: "default" }))["manifest"]).toEqual(IMAGE);
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
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 1, maxDepth: 1 } });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    // The record enters the live map only after the provider has answered, so a count read at the guard and nothing
    // held would let every fork in one tick past the same reading.
    const raced = await Promise.allSettled([
      createOn(rt, { name: "b1" }, asThread(scope)),
      createOn(rt, { name: "b2" }, asThread(scope)),
      createOn(rt, { name: "b3" }, asThread(scope)),
    ]);
    expect(raced.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const r of raced.filter(r => r.status === "rejected")) expect(String((r as PromiseRejectedResult).reason)).toContain(spawnCapRefusal("t_root", 1, 1));
    expect((await rt.workspaces.list()).filter(w => w.rootThreadId === "t_root")).toHaveLength(1);
    // A place a fork held is handed back when it lands, so the next one is refused by the record rather than by it.
    await expect(createOn(rt, { name: "b4" }, asThread(scope))).rejects.toThrow(spawnCapRefusal("t_root", 1, 1));
    await rt.close();
  });

  it("a fork still booting counts as the one machine it is, not as two", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 1 } });
    const scope: ThreadScope = { kind: "thread", threadId: "t_root", workspaceId: ws.id, rootThreadId: "t_root" };
    // The first stage after the record enters the live map: the create names the machine before it names the
    // workspace on it, so a fork still booting is already one this guard counts.
    const booting = new Promise<void>(done => {
      const off = rt.events.on("*", e => {
        if (e.type === "workspace.creating" && (e as { name?: string }).name === "b1" && (e as { stage?: string }).stage === "hostname-set") {
          off();
          done();
        }
      });
    });
    // The record enters the live map the moment the provider answers, while the place the guard took is held until
    // the create returns: a second fork asked for in that window read the one machine as two.
    const first = createOn(rt, { name: "b1" }, asThread(scope));
    await booting;
    const second = await createOn(rt, { name: "b2" }, asThread(scope));
    expect(second.name).toBe("b2");
    await first;
    // Two stand, so the third is refused by the records themselves.
    await expect(createOn(rt, { name: "b3" }, asThread(scope))).rejects.toThrow(spawnCapRefusal("t_root", 2, 2));
    expect((await rt.workspaces.list()).filter(w => w.rootThreadId === "t_root")).toHaveLength(2);
    await rt.close();
  });

  it("turning the lead's switch off stops the tree it spawned, not only the threads on the lead", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const lead = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 2 } });
    const opener = await rt.sessions.start(lead.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: lead.id, rootThreadId: rootThread };
    const forked = await createOn(rt, { name: "builder" }, asThread(rootScope));
    // The fork carries the tree and no switch of its own, so what it may do is read off the lead every time.
    expect(forked.agents).toEqual({ spawn: true, maxMachines: 3, maxDepth: 2 });
    const onFork = await rt.sessions.start(forked.id, { prompt: "build" }, asThread(rootScope));
    const forkScope: ThreadScope = { kind: "thread", threadId: onFork.view().threadId!, workspaceId: forked.id, rootThreadId: rootThread };
    await rt.workspaces.agents(lead.id, { spawn: false });
    await expect(createOn(rt, { name: "deeper" }, asThread(forkScope))).rejects.toThrow(agentsOffRefusal("builder", "fork"));
    await expect(rt.sessions.start(forked.id, { prompt: "again" }, asThread(forkScope))).rejects.toThrow(agentsOffRefusal("builder", "thread_new"));
    // And the fork's own listing says so, so a person reading the card is not told the old answer.
    expect((await rt.workspaces.get(forked.id)).agents).toEqual({ spawn: false, maxMachines: 3, maxDepth: 2 });
    held.end(1);
    held.end(0);
    await rt.close();
  });

  it("a thread on a fork is handed a token too, and under a lead allowing two levels it forks once more", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const lead = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 2 } });
    const opener = await rt.sessions.start(lead.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: lead.id, rootThreadId: rootThread };
    const forked = await createOn(rt, { name: "builder" }, asThread(rootScope));
    // The fork stores no switch of its own, so a mint reading the record itself would hand this turn nothing.
    const onFork = await rt.sessions.start(forked.id, { prompt: "build" }, asThread(rootScope));
    const forkThread = onFork.view().threadId!;
    const launch = held.launches[1]!;
    expect(launch.env[HOST_URL_ENV]).toBe("http://10.0.0.2:4700");
    expect(launch.env[HOST_TOKEN_ENV]).toMatch(/\S/);
    const scoped = (await rt.devices.list()).find(d => d.scope?.threadId === forkThread);
    expect(scoped?.scope).toEqual({ kind: "thread", threadId: forkThread, workspaceId: forked.id, rootThreadId: rootThread });
    // And at one level deep under a lead that allows two, it forks once more.
    const forkScope: ThreadScope = { kind: "thread", threadId: forkThread, workspaceId: forked.id, rootThreadId: rootThread };
    const deeper = await createOn(rt, { name: "deeper" }, asThread(forkScope));
    expect(deeper.rootThreadId).toBe(rootThread);
    held.end(1);
    held.end(0);
    await rt.close();
  });

  it("a workspace whose agents could not drive this host is refused the switch, in the words both doors read", async () => {
    const rt = runtimeWith({ claude: heldAdapter().factory });
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await expect(rt.workspaces.agents(mac.id, { spawn: true })).rejects.toThrow(agentsKindRefusal("local"));
    // Off is always allowed: a switch that does nothing may be said to do nothing.
    await rt.workspaces.agents(mac.id, { spawn: false });
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    expect((await rt.workspaces.agents(cloud.id, { spawn: true })).agents?.spawn).toBe(true);
    await rt.close();
  });

  it("a turn refused before it launches leaves no token standing", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
    // A harness this host has no adapter for is refused where the launch environment is built, after the mint.
    await expect(rt.sessions.start(ws.id, { prompt: "hi", harness: "nope" })).rejects.toThrow(/no adapter/);
    expect(await rt.devices.list()).toEqual([]);
    // A notify naming no thread is refused before a token exists at all.
    await expect(rt.sessions.start(ws.id, { prompt: "hi", notify: ["nothing-here"] })).rejects.toThrow("no thread nothing-here to notify");
    expect(await rt.devices.list()).toEqual([]);
    await rt.close();
  });

  it("a thread's own token drives its thread and the tree under it, and reads nothing else on the workspace they share", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 3 } });
    // Three trees on one workspace: the person's own thread, the lead whose token every line below runs on, and a
    // second lead the person opened beside it, which is the shape a box with two jobs on one machine has.
    const mine = await rt.sessions.start(ws.id, { prompt: "the person's own" });
    const mineThread = mine.view().threadId!;
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const other = await rt.sessions.start(ws.id, { prompt: "second lead" });
    const otherThread = other.view().threadId!;
    const child = await rt.sessions.start(ws.id, { prompt: "child" }, asThread(scope));
    const childThread = child.view().threadId!;
    const grand = await rt.sessions.start(ws.id, { prompt: "grandchild" }, asThread({ kind: "thread", threadId: childThread, workspaceId: ws.id, rootThreadId: rootThread }));
    const grandThread = grand.view().threadId!;
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);

    const tree = [rootThread, childThread, grandThread].sort();
    expect((await rt.sessions.list(ws.id, asThread(scope))).map(v => v.threadId).sort()).toEqual(tree);
    expect((await rt.sessions.list(undefined, asThread(scope))).map(v => v.threadId).sort()).toEqual(tree);
    // The person reads every row, as they always did.
    expect((await rt.sessions.list(ws.id)).map(v => v.threadId).sort()).toEqual([mineThread, otherThread, ...tree].sort());
    // The transcript is read the same way: a thread is handed its own tree's rows and no other tree's.
    expect([...new Set((await rt.sessions.history(ws.id, asThread(scope))).map(e => e.threadId))].sort()).toEqual(tree);
    expect([...new Set((await rt.sessions.history(ws.id)).map(e => e.threadId))].sort()).toEqual([mineThread, otherThread, ...tree].sort());

    // Another tree's row is absent on every verb, which is what a thread reads for a session that is not there.
    for (const foreign of [mine, other]) {
      expect(await rt.sessions.interrupt(foreign.id, asThread(scope))).toEqual({ outcome: "not-found" });
      expect(await rt.sessions.steer(foreign.id, { prompt: "do this instead" }, asThread(scope))).toEqual({ outcome: "not-found" });
      expect(await rt.sessions.rename(foreign.id, "mine now", asThread(scope))).toEqual({ outcome: "not-found" });
    }
    // A session on a workspace outside the tree reads that same absence and never the workspace's own sentence,
    // since the thread rule is read before the workspace is: one answer for every session a thread cannot see.
    const elsewhere = await createOn(rt, { golden: "snap_g", name: "elsewhere" });
    const theirs = await rt.sessions.start(elsewhere.id, { prompt: "not yours" });
    expect(await rt.sessions.interrupt(theirs.id, asThread(scope))).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.steer(theirs.id, { prompt: "do this instead" }, asThread(scope))).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.rename(theirs.id, "mine now", asThread(scope))).toEqual({ outcome: "not-found" });

    // A send into either is refused whether it names the thread or names the harness session that thread resumes,
    // and the sentence says back what the caller gave: a session id probed this way never comes back as a thread id.
    await expect(rt.sessions.start(ws.id, { prompt: "hi", thread: mineThread }, asThread(scope))).rejects.toThrow(`no thread ${mineThread} on this workspace`);
    const sessionOfOther = other.view().claudeSessionId!;
    const refused = await rt.sessions.start(ws.id, { prompt: "hi", resume: sessionOfOther }, asThread(scope)).catch((e: unknown) => (e as Error).message);
    expect(refused).toBe(`no thread ${sessionOfOther} on this workspace`);
    expect(refused).not.toContain(otherThread);
    expect((await rt.sessions.list(ws.id)).filter(v => v.threadId === mineThread || v.threadId === otherThread).every(v => v.status !== "running")).toBe(true);

    // Its own tree it drives, by thread id and by the session id a resume carries alike.
    const carry = await rt.sessions.start(ws.id, { prompt: "carry on", thread: childThread }, asThread(scope));
    expect(carry.view().threadId).toBe(childThread);
    expect(await rt.sessions.steer(carry.id, { prompt: "and this" }, asThread(scope))).toEqual({ outcome: "unsupported" });
    expect(await rt.sessions.rename(carry.id, "builder", asThread(scope))).toEqual({ outcome: "unsupported" });
    expect((await rt.sessions.interrupt(carry.id, asThread(scope))).outcome).toBe("accepted");
    const back = await rt.sessions.start(ws.id, { prompt: "and you", resume: grand.view().claudeSessionId }, asThread(scope));
    expect(back.view().threadId).toBe(grandThread);
    expect((await rt.sessions.interrupt(back.id, asThread(scope))).outcome).toBe("accepted");
    // The person keeps every verb on every thread, the two the lead cannot see among them.
    expect(await rt.sessions.rename(mine.id, "mine")).toEqual({ outcome: "unsupported" });
    expect((await rt.sessions.start(ws.id, { prompt: "on you go", thread: otherThread })).view().threadId).toBe(otherThread);
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);
    await rt.close();
  });

  it("a thread's notify target is a thread of its own tree, and one outside it reads as no thread at all", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const lead = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 2 } });
    const opener = await rt.sessions.start(lead.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: lead.id, rootThreadId: rootThread };
    // The person's own thread on another workspace: another tree on the same host, which is what a guest that
    // knows an id would name today.
    const mine = await createOn(rt, { golden: "snap_g", name: "mine" });
    const own = await rt.sessions.start(mine.id, { prompt: "mine" });
    const ownThread = own.view().threadId!;

    const opened = async (): Promise<number> => (await rt.sessions.history(lead.id)).filter(e => e.type === "session.start").length;
    const before = await opened();
    await expect(rt.sessions.start(lead.id, { prompt: "out", notify: [ownThread] }, asThread(scope))).rejects.toThrow(`no thread ${ownThread} to notify`);
    expect(await opened()).toBe(before);
    // A caller whose own rows this host no longer holds still reads its root off the scope its token carries.
    const ghost: ThreadScope = { kind: "thread", threadId: "t_gone", workspaceId: lead.id, rootThreadId: rootThread };
    await expect(rt.sessions.start(lead.id, { prompt: "out", notify: [ownThread] }, asThread(ghost))).rejects.toThrow(`no thread ${ownThread} to notify`);
    // A person names any thread, as today.
    const anyone = await rt.sessions.start(lead.id, { prompt: "the person's own", notify: [ownThread] });
    expect(anyone.view().threadId).toBeDefined();

    const forked = await createOn(rt, { name: "builder" }, asThread(scope));
    const child = await rt.sessions.start(forked.id, { prompt: "child" }, asThread(scope));
    const childThread = child.view().threadId!;
    const childScope: ThreadScope = { kind: "thread", threadId: childThread, workspaceId: forked.id, rootThreadId: rootThread };
    const cousin = await rt.sessions.start(forked.id, { prompt: "cousin" }, asThread(childScope));
    const cousinThread = cousin.view().threadId!;
    // The lead, a thread the caller opened and a thread further down the same tree all pass, and the finished line
    // reaches each of them.
    const kid = await rt.sessions.start(forked.id, { prompt: "kid", notify: [rootThread, childThread, cousinThread] }, asThread(scope));
    const kidThread = kid.view().threadId!;
    held.end(held.launches.length - 1);
    await until(async () => (await rt.sessions.history(forked.id)).filter(e => e.type === "session.notify" && e.threadId === kidThread).length === 3);
    const told = (await rt.sessions.history(forked.id)).filter(e => e.type === "session.notify" && e.threadId === kidThread).map(e => (e as { notify: string }).notify);
    expect(told.sort()).toEqual([rootThread, childThread, cousinThread].sort());
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);
    await rt.close();
  });

  it("a notify target is a thread the caller drives: its own child passes, its parent, its sibling and the person's do not", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 3 } });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const rootScope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const child = await rt.sessions.start(ws.id, { prompt: "child" }, asThread(rootScope));
    const childThread = child.view().threadId!;
    const childScope: ThreadScope = { kind: "thread", threadId: childThread, workspaceId: ws.id, rootThreadId: rootThread };
    const sibling = await rt.sessions.start(ws.id, { prompt: "sibling" }, asThread(rootScope));
    const siblingThread = sibling.view().threadId!;
    const grand = await rt.sessions.start(ws.id, { prompt: "grandchild" }, asThread(childScope));
    const grandThread = grand.view().threadId!;
    const mine = await rt.sessions.start(ws.id, { prompt: "the person's own" });
    const mineThread = mine.view().threadId!;
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);

    const rows = async (): Promise<number> => (await rt.sessions.list(ws.id)).length;
    const before = await rows();
    // A target is a thread this caller drives: the lead that opened it, a thread beside it under the same root and
    // the person's own thread are none of them under it, so each reads as no thread to notify.
    for (const target of [rootThread, siblingThread, mineThread]) {
      await expect(rt.sessions.start(ws.id, { prompt: "out", notify: [target] }, asThread(childScope))).rejects.toThrow(`no thread ${target} to notify`);
    }
    expect(await rows()).toBe(before);
    // What it drives it may name: its own child, and a thread further down its own tree.
    const kid = await rt.sessions.start(ws.id, { prompt: "kid", notify: [grandThread] }, asThread(childScope));
    expect(kid.view().threadId).toBeDefined();
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);
    await rt.close();
  });

  it("the line a child's end delivers starts the target's turn under the thread that named it, and a refused line tells the person once", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 2 } });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [rootThread] }, asThread(scope));
    const kidThread = kid.view().threadId!;
    const stored = async (): Promise<{ threadId?: string; notifyBy?: ThreadScope }[]> => ((await store.get("sessions", ws.id)) as { sessions: { threadId?: string; notifyBy?: ThreadScope }[] } | undefined)?.sessions ?? [];
    await until(async () => (await stored()).some(r => r.threadId === kidThread && r.notifyBy !== undefined));
    // The row says who named the target, and the index keeps it, so the line goes the same way after a restart.
    expect((await stored()).find(r => r.threadId === kidThread)?.notifyBy).toEqual(scope);

    // The switch goes off after the registration: the door is read again when the line goes, so nothing starts on
    // the lead and the person is told once instead of the turn running as theirs.
    await rt.workspaces.agents(ws.id, { spawn: false });
    const before = (await rt.sessions.list(ws.id)).length;
    held.end(held.launches.length - 1);
    const told = async (): Promise<string[]> => (await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify" && e.threadId === kidThread).map(e => (e as { notify: string }).notify);
    await until(async () => (await told()).length === 2);
    expect((await told()).sort()).toEqual([NOTIFY_ME, rootThread].sort());
    expect((await rt.sessions.list(ws.id)).length).toBe(before);
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);
    await rt.close();
  });

  it("a line held for a napping workspace keeps the road that tells the person, and falls away to them on the wake", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 2 } });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    // The lead's own turn is over, so it has a session for its line to resume.
    held.end(0);
    await opener.finished;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [rootThread] }, asThread(scope));
    const kidThread = kid.view().threadId!;
    await rt.workspaces.agents(ws.id, { spawn: false });
    // The nap ends the kid's turn and the workspace takes no start while it sleeps, so the line waits for the wake.
    await rt.workspaces.nap(ws.id);
    const told = async (): Promise<string[]> => (await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify" && e.threadId === kidThread).map(e => (e as { notify: string }).notify);
    expect(await told()).toEqual([rootThread]);
    const before = (await rt.sessions.list(ws.id)).length;

    await rt.workspaces.wake(ws.id);
    // The door reads the switch when the line finally goes, hours later as far as this road knows, and the person
    // is told the report is there rather than the line going quiet.
    await until(async () => (await told()).length === 2);
    expect((await told()).sort()).toEqual([NOTIFY_ME, rootThread].sort());
    expect((await rt.sessions.list(ws.id)).length).toBe(before);
    for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);
    await rt.close();
  });

  it("a row an older host wrote names no thread beside its targets, and its line goes as the person's", async () => {
    const held = heldAdapter();
    // One backend for both hosts: the machine the first host forked is the one the second comes back to.
    const backend = stubBackend();
    const first = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } }, backend);
    const ws = await createOn(first, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 2 } });
    const opener = await first.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const kid = await first.sessions.start(ws.id, { prompt: "build it", notify: [rootThread] }, asThread(scope));
    const kidThread = kid.view().threadId!;
    const stored = async (): Promise<{ threadId?: string; notifyBy?: ThreadScope }[]> => ((await store.get("sessions", ws.id)) as { sessions: { threadId?: string; notifyBy?: ThreadScope }[] } | undefined)?.sessions ?? [];
    await until(async () => (await stored()).some(r => r.threadId === kidThread && r.notifyBy !== undefined));
    // The switch goes off and the host goes down under the running turn, so its line is the load's to send.
    await first.workspaces.agents(ws.id, { spawn: false });
    await first.close();
    // The document as a host from before this rule wrote it: the targets, and nothing about who named them.
    const doc = (await store.get("sessions", ws.id)) as { workspaceId: string; sessions: Record<string, unknown>[] };
    await store.put("sessions", ws.id, { ...doc, sessions: doc.sessions.map(({ notifyBy: _named, ...row }) => row) });

    const again = runtimeWith({ claude: heldAdapter().factory }, { reach: { url: "http://10.0.0.2:4700" } }, backend);
    await again.workspaces.list();
    await until(async () => (await again.sessions.history(ws.id)).some(e => e.type === "session.notify" && e.threadId === kidThread && (e as { notify: string }).notify === rootThread));
    // The turn the cut line asked for ran, switch or no switch, which is the road that stood when the row was
    // written: the lead's thread holds a second start and nothing fell away to the person.
    await until(async () => (await again.sessions.history(ws.id)).filter(e => e.type === "session.start" && e.threadId === rootThread).length === 2);
    expect((await again.sessions.history(ws.id)).filter(e => e.type === "session.notify" && (e as { notify: string }).notify === NOTIFY_ME)).toEqual([]);
    await again.close();
  });

  it("a thread cannot widen its own caps through the fork it asks for", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const tight = { spawn: true, maxMachines: 2, maxDepth: 1 };
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: tight });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    await expect(createOn(rt, { name: "wide", agents: { maxMachines: 50, maxDepth: 9 } }, asThread(scope))).rejects.toThrow(spawnActRefusal(rootThread, "agents"));
    // The refused fork took no place with it, and the fork that lands answers with the tree's own switch.
    const forked = await createOn(rt, { name: "builder" }, asThread(scope));
    expect(forked.agents).toEqual(tight);
    // So a thread on that machine is still one level deep and forks nothing.
    const child = await rt.sessions.start(forked.id, { prompt: "builder" }, asThread(scope));
    const childScope: ThreadScope = { kind: "thread", threadId: child.view().threadId!, workspaceId: forked.id, rootThreadId: rootThread };
    await expect(createOn(rt, { name: "deeper" }, asThread(childScope))).rejects.toThrow(spawnDepthRefusal(childScope.threadId, 1, 1));
    held.end(0);
    await rt.close();
  });

  it("a thread's socket is pushed its own tree's session events and none of a sibling tree's", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 2, maxDepth: 2 } });
    const opener = await rt.sessions.start(ws.id, { prompt: "lead" });
    const rootThread = opener.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const token = held.launches[0]!.env[HOST_TOKEN_ENV]!;
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const client = await WsClient.connect(srv.port, { token });
      await client.request("events.subscribe", {});
      const mine = await WsClient.connect(srv.port, { token: "secret" });
      await mine.request("events.subscribe", {});
      // One workspace, two trees: a thread the lead opens under itself, and a second lead the person opens beside it.
      const child = await rt.sessions.start(ws.id, { prompt: "child" }, asThread(scope));
      const childThread = child.view().threadId!;
      const other = await rt.sessions.start(ws.id, { prompt: "second lead" });
      const otherThread = other.view().threadId!;
      for (let nth = held.launches.length - 1; nth >= 1; nth--) held.end(nth);
      const threadsOn = (c: WsClient): Set<string> => new Set(c.events.map(e => e["threadId"]).filter((id): id is string => typeof id === "string"));
      // The person's own socket reads every tree's rows, so the run is over when both ends have landed there. The
      // lead's own turn is the one holding the token and it started before either socket subscribed, so neither
      // list holds its rows; what the two lists differ by is the sibling tree.
      await until(async () => mine.events.some(e => e.type === "session.end" && e["threadId"] === otherThread) && mine.events.some(e => e.type === "session.end" && e["threadId"] === childThread));
      expect([...threadsOn(mine)].sort()).toEqual([childThread, otherThread].sort());
      expect([...threadsOn(client)]).toEqual([childThread]);
      mine.close();
      client.close();
    } finally {
      await srv.close();
      for (let nth = held.launches.length - 1; nth >= 0; nth--) held.end(nth);
      await rt.close();
    }
  });

  it("the init job's own events reach no thread's socket either, since they are about this host", async () => {
    const held = heldAdapter();
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: AGENTS_ON });
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
    const rt = runtimeWith({ claude: held.factory }, { reach: { url: "http://10.0.0.2:4700" } });
    const ws = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true, maxMachines: 3, maxDepth: 2 } });
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
