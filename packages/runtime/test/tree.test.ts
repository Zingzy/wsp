// SPDX-License-Identifier: AGPL-3.0-only
// The tree of branches on the host: a fork pushes its lead's own work branch first and starts the child's copy on it,
// the lead's status carries its children read against its branch at the moments something moved and never on a
// timer, a merge into the lead runs through the lead's own daemon under the tree rule, and a merge that stopped is
// handed to the lead's agent. Every daemon is a fake that answers by op and tells each copy apart by the machine
// token its dial carries, since a lead and its child hold the project at the same path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HERE_PLACE_ID,
  branchUnreadRefusal,
  childStartedLine,
  forkNeedsPushLine,
  leadBusyRefusal,
  mergeChildPrompt,
  mergeIntoOwnRefusal,
  nothingAheadLine,
  noRemoteForTreeLine,
  notTheLeadsChildRefusal,
  parentProjectRefusal,
  pushedForChildLine,
  uncommittedStayed,
  type Caller,
  type DaemonFrame,
  type DaemonResponse,
  type EventUnion,
  type ThreadScope,
  type TreeFact,
  type TurnResult,
} from "@wsp/protocol";
import { LocalBackend } from "@wsp/engine";
import { copyKey, createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { daemonTokenFor } from "../src/daemon-token.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { copyingFake, createOn, projectOn, stubBackend, tempRepo, testPlatform, tokenGuest, type StubBackend, type StubMachine } from "./stub-backend.js";
import { until } from "./until.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);
/** Where this computer's own daemon answers; every machine's copy answers at the one preview url below. */
const HERE = "ws://this-computer";
const COPY = "http://127.0.0.1:9";

type Answer = (frame: Record<string, unknown>) => DaemonResponse;
type Road = "here" | string;

const ok = (fields: Record<string, unknown>): DaemonResponse => ({ id: 1, ok: true, ...fields }) as DaemonResponse;
const refused = (error: string, code?: string): DaemonResponse => ({ id: 1, ok: false, error, ...(code !== undefined ? { code } : {}) }) as DaemonResponse;
/** A copy on a branch: its upstream where it has one, commits ahead of that (or of the default branch without one), and changed files. */
const status = (head: string, o: { upstream?: string; ahead?: number; changed?: number } = {}): DaemonResponse =>
  ok({
    branch: { oid: "abc", head, ...(o.upstream !== undefined ? { upstream: o.upstream } : {}), ahead: o.ahead ?? 0, behind: 0 },
    entries: Array.from({ length: o.changed ?? 0 }, (_, i) => ({ xy: ".M", path: `f${i}.txt` })),
    root: "/root/stub",
  });

/** This computer's daemon and one per machine behind one dial, told apart by the url and the machine token. Each records
 * every frame with its road; an op a road was given no answer for is refused, as a daemon refuses an unknown op. */
function fakeDaemons(answers: Record<Road, Partial<Record<string, Answer>>>) {
  const frames: { road: Road; frame: Record<string, unknown> }[] = [];
  const roadOf = (o: DaemonChannelOptions): Road => {
    if (o.url === HERE) return "here";
    for (let n = 1; n < 20; n++) if (o.token === daemonTokenFor(DAEMON_TOKEN, `m${n}`)) return `m${n}`;
    return "unknown";
  };
  return {
    frames,
    answers,
    ops: (road?: Road) => frames.filter(f => road === undefined || f.road === road).map(f => String(f.frame["op"])),
    sent: (road: Road, op: string) => frames.filter(f => f.road === road && f.frame["op"] === op).map(f => f.frame),
    open: async (o: DaemonChannelOptions): Promise<DaemonChannel> => {
      const road = roadOf(o);
      return {
        send: async (frame: DaemonFrame) => {
          const held = frame as unknown as Record<string, unknown>;
          frames.push({ road, frame: held });
          const answer = answers[road]?.[String(held["op"])] ?? answers["*"]?.[String(held["op"])];
          return answer === undefined ? refused(`${String(held["op"])} was not answered on ${road}`) : answer(held);
        },
        close: () => {},
        closed: new Promise(() => {}),
      };
    },
  };
}

/** An agent whose turns are held until the test ends them, recording every prompt it was given. */
function heldAgent(): { factory: HarnessAdapterFactory; prompts: string[]; end: (nth: number) => void } {
  const ends: (() => void)[] = [];
  const prompts: string[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    start: ({ resume, prompt, onEvent }) => {
      const sessionId = resume ?? randomUUID();
      prompts.push(prompt);
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
      return { localId: sessionId, finished, interrupt: async () => mine() };
    },
  });
  return { factory, prompts, end: nth => ends[nth]!() };
}

const IMAGE = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", kind: "desktop", baseTemplate: "base", setupSha: "abc", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }],
};
const AGENTS_ON = { spawn: true, maxMachines: 5, maxDepth: 3 };
const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

let rt: Runtime | undefined;
let root: string;
let store: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "wsp-tree-"));
  store = memoryStore();
  await store.put("goldens", copyKey("default", "default"), IMAGE);
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  rmSync(root, { recursive: true, force: true });
});

const localOn = (): LocalWiring => ({
  backend: new LocalBackend({ root }),
  execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
  home: () => join(root, ".claude"),
  homeDir: root,
  rootsPath: join(root, "roots"),
  env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
  platform: testPlatform(),
  copier: copyingFake(),
  daemonRoad: async () => ({ url: HERE, expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN }),
});

/** Every machine the stub makes answers at the copy's url from the moment it exists, as a fork's daemon does once its
 * create has run: a child's copy is put on its branch inside the create that made it. */
function answeringAtOnce(backend: StubBackend): void {
  const make = backend.create.bind(backend);
  backend.create = async spec => {
    const m = (await make(spec)) as StubMachine;
    m.previewUrl = async () => ({ url: COPY, token: "e", expiresAt: Date.now() + 3_600_000 });
    m.daemonAnswers = async () => true;
    return m;
  };
}

/** A lead workspace on a provider with its first thread running under a held agent: the scope a child is forked under. */
async function withLead(daemons: ReturnType<typeof fakeDaemons>, o: { clock?: ReturnType<typeof fakeClock>["clock"] } = {}) {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  answeringAtOnce(backend);
  const agent = heldAgent();
  rt = createRuntime({
    backend,
    store,
    adapters: { claude: agent.factory },
    daemonToken: DAEMON_TOKEN,
    daemonChannel: daemons.open,
    local: localOn(),
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
  });
  const project = await projectOn(rt, undefined, undefined, { base: "main" });
  const lead = await createOn(rt, { project: project.id, golden: "snap_g", name: "lead", agents: AGENTS_ON });
  const turn = await rt.sessions.start(lead.id, { prompt: "lead the work" });
  const rootThread = turn.view().threadId!;
  const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: lead.id, rootThreadId: rootThread };
  return { backend, agent, project, lead, scope, turn };
}

/** The tree each workspace's latest pushed status carried. */
function trees(runtime: Runtime): Map<string, TreeFact | undefined> {
  const last = new Map<string, TreeFact | undefined>();
  runtime.events.on("workspace.status", (e: EventUnion) => {
    if (e.type === "workspace.status") last.set(e.status.id, e.status.tree);
  });
  return last;
}

const PUSHED = (branch: string, uncommitted = 0): Answer => () => ok({ branch, base: "main", remote: "origin", ahead: 2, uncommitted, stat: [] });
const STARTED: Answer = f => ok({ branch: String(f["branch"]), oid: "c0ffee" });

describe("where a child's branch comes from", () => {
  it("pushes the lead's own work branch first and puts the child's copy on it, and the fork's reply says both", async () => {
    const daemons = fakeDaemons({ m1: { "git.status": () => status("tree/lead", { ahead: 1, changed: 3 }), "git.push": PUSHED("tree/lead", 3) }, m2: { "git.startOn": STARTED, "git.status": () => status("tree/lead") } });
    const { lead, scope } = await withLead(daemons);
    const child = await createOn(rt!, { name: "helper" }, asThread(scope));
    expect(daemons.sent("m1", "git.push")).toEqual([{ op: "git.push", cwd: expect.any(String), base: "main" }]);
    expect(daemons.sent("m2", "git.startOn")).toEqual([{ op: "git.startOn", cwd: expect.any(String), branch: "tree/lead" }]);
    expect(daemons.ops("m1").indexOf("git.push")).toBeGreaterThan(daemons.ops("m1").indexOf("git.status"));
    expect(child.parentWorkspaceId).toBe(lead.id);
    expect(child.notice).toContain(pushedForChildLine("tree/lead", "helper"));
    expect(child.notice).toContain(uncommittedStayed(3, "lead"));
    expect(child.notice).toContain(childStartedLine("helper", "tree/lead"));
    // The child's work goes back into the branch it was cut from, which is what the push answered.
    const back = await rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope)).catch(() => undefined);
    void back;
    expect(daemons.sent("m2", "git.push").at(-1)?.["base"]).toBe("tree/lead");
  });

  it("pushes nothing for a lead on the branch its work started from, and the child starts from that base", async () => {
    const daemons = fakeDaemons({ m1: { "git.status": () => status("main", { upstream: "origin/main" }) }, m2: { "git.startOn": STARTED } });
    const { scope } = await withLead(daemons);
    const child = await createOn(rt!, { name: "helper" }, asThread(scope));
    expect(daemons.ops("m1")).not.toContain("git.push");
    expect(daemons.ops("m2")).not.toContain("git.startOn");
    expect(child.notice ?? "").not.toContain("pushed");
  });

  it("pushes nothing for a lead whose branch the remote already holds whole, and starts the child on it", async () => {
    const daemons = fakeDaemons({ m1: { "git.status": () => status("tree/lead", { upstream: "origin/tree/lead", ahead: 0 }) }, m2: { "git.startOn": STARTED } });
    const { scope } = await withLead(daemons);
    await createOn(rt!, { name: "helper" }, asThread(scope));
    expect(daemons.ops("m1")).not.toContain("git.push");
    expect(daemons.sent("m2", "git.startOn").map(f => f["branch"])).toEqual(["tree/lead"]);
  });

  it("pushes a lead's branch that tracks an upstream of another name, since the remote holds nothing under its own", async () => {
    const daemons = fakeDaemons({ m1: { "git.status": () => status("tree/lead", { upstream: "origin/feature", ahead: 0 }), "git.push": PUSHED("tree/lead") }, m2: { "git.startOn": STARTED } });
    const { scope } = await withLead(daemons);
    await createOn(rt!, { name: "helper" }, asThread(scope));
    expect(daemons.ops("m1")).toContain("git.push");
    expect(daemons.sent("m2", "git.startOn").map(f => f["branch"])).toEqual(["tree/lead"]);
  });

  it("pushes nothing for a lead cut from the base's own remote branch with no commits yet, and the child starts from the base", async () => {
    // git checkout -b tree/lead origin/main: the upstream is the base, and bring back's push refuses a branch with nothing over it.
    const daemons = fakeDaemons({
      m1: { "git.status": () => status("tree/lead", { upstream: "origin/main", ahead: 0 }), "git.push": () => refused(nothingAheadLine("tree/lead", "main")) },
      m2: { "git.startOn": STARTED },
    });
    const { scope } = await withLead(daemons);
    await createOn(rt!, { name: "helper" }, asThread(scope));
    expect(daemons.ops("m1")).not.toContain("git.push");
    expect(daemons.ops("m2")).not.toContain("git.startOn");
  });

  it("pushes nothing for a lead on a branch with no commits over the base, and the child starts from the base", async () => {
    const daemons = fakeDaemons({ m1: { "git.status": () => status("tree/empty", { ahead: 0 }) }, m2: { "git.startOn": STARTED } });
    const { scope } = await withLead(daemons);
    await createOn(rt!, { name: "helper" }, asThread(scope));
    expect(daemons.ops("m1")).not.toContain("git.push");
    expect(daemons.ops("m2")).not.toContain("git.startOn");
  });

  it("refuses the fork in the push's own sentence where the lead has no credential, and makes nothing", async () => {
    const why = "this computer has no git credential for github.com, so nothing was pushed";
    const daemons = fakeDaemons({ m1: { "git.status": () => status("tree/lead", { ahead: 1 }), "git.push": () => refused(why) } });
    const { backend, scope } = await withLead(daemons);
    await expect(createOn(rt!, { name: "helper" }, asThread(scope))).rejects.toThrow(forkNeedsPushLine("lead", why));
    expect((await rt!.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
    expect(backend.machines.length).toBe(1);
  });

  it("refuses the fork where the lead's copy did not say which branch it is on, and makes nothing", async () => {
    const daemons = fakeDaemons({ m1: { "git.status": () => refused("the daemon did not answer") } });
    const { backend, scope } = await withLead(daemons);
    await expect(createOn(rt!, { name: "helper" }, asThread(scope))).rejects.toThrow(branchUnreadRefusal("lead", "the daemon did not answer"));
    expect(backend.machines.length).toBe(1);
  });

  it("deletes the child it made where its copy would not go onto the lead's branch, and refuses the fork", async () => {
    const why = "the remote has no branch tree/lead to start from";
    const daemons = fakeDaemons({ m1: { "git.status": () => status("tree/lead", { ahead: 1 }), "git.push": PUSHED("tree/lead") }, m2: { "git.startOn": () => refused(why) } });
    const { backend, scope } = await withLead(daemons);
    await expect(createOn(rt!, { name: "helper" }, asThread(scope))).rejects.toThrow(forkNeedsPushLine("lead", why));
    expect((await rt!.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
    await until(() => backend.machines[1]?.killed === true);
  });
});

describe("a child's project", () => {
  it("may be another computer's project of the same repository, and never one of another repository", async () => {
    const daemons = fakeDaemons({ "*": { "git.status": () => status("main", { upstream: "origin/main" }) } });
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    answeringAtOnce(backend);
    rt = createRuntime({ backend, store, adapters: {}, daemonToken: DAEMON_TOKEN, daemonChannel: daemons.open, local: localOn() });
    const folder = tempRepo();
    execFileSync("git", ["-C", folder, "remote", "add", "origin", "git@github.com:wsp/tree-lab.git"]);
    const here = await projectOn(rt, HERE_PLACE_ID, folder, { name: "lab" });
    const there = await projectOn(rt, undefined, "https://github.com/wsp/tree-lab.git", { name: "lab-box", base: "main" });
    const other = await projectOn(rt, undefined, "https://github.com/wsp/elsewhere.git", { name: "other", base: "main" });
    const lead = await rt.workspaces.create({ project: here.id, name: "lead" });
    const child = await rt.workspaces.create({ project: there.id, golden: "snap_g", name: "on the box", parent: lead.id });
    expect(child.parentWorkspaceId).toBe(lead.id);
    await expect(rt.workspaces.create({ project: other.id, golden: "snap_g", name: "stranger", parent: lead.id })).rejects.toThrow(parentProjectRefusal(lead.name, "lab", "other"));
  });
});

describe("what the lead sees", () => {
  it("reads each child's branch against the lead's at a child's turn end and after its bring back, and never on a timer", async () => {
    const compare = (f: Record<string, unknown>): DaemonResponse => ok(f["head"] === "child/one" ? { pushed: true, aheadBy: 2, behindBy: 0, status: "ahead" } : { pushed: false });
    const daemons = fakeDaemons({
      here: { "git.branchCompare": compare, "git.prRead": () => ok({}) },
      m1: { "git.status": () => status("tree/lead", { upstream: "origin/tree/lead" }) },
      m2: { "git.startOn": STARTED, "git.status": () => status("child/one"), "git.push": PUSHED("child/one") },
    });
    const { clock, advance } = fakeClock();
    const { lead, scope, agent } = await withLead(daemons, { clock });
    const seen = trees(rt!);
    const child = await createOn(rt!, { name: "helper" }, asThread(scope));
    const childTurn = await rt!.sessions.start(child.id, { prompt: "add a file" }, asThread(scope));
    void childTurn;
    agent.end(1);
    await until(() => seen.get(lead.id)?.children.length === 1);
    expect(seen.get(lead.id)).toMatchObject({ leadBranch: "tree/lead", children: [{ workspaceId: child.id, branch: "child/one", pushed: true, aheadOfLead: 2, behindLead: 0 }] });
    expect(daemons.sent("here", "git.branchCompare")[0]).toMatchObject({ base: "tree/lead", head: "child/one", remote: expect.stringMatching(/^https:\/\/github\.com\/wsp\/stub-\d+\.git$/) });
    const reads = (): number => daemons.sent("here", "git.branchCompare").length;
    const before = reads();
    advance(60 * 60_000);
    await new Promise(r => setTimeout(r, 20));
    expect(reads()).toBe(before);
    await rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope));
    await until(() => reads() > before);
    // The lead's thread opening reads it again, as its checkout does.
    const opened = reads();
    await rt!.workspaces.checkout(lead.id);
    await until(() => reads() > opened);
    agent.end(0);
  });

  it("keeps a push the child could not make on the child's row, and clears it once a push lands", async () => {
    // Known by the code the daemon stamps on it where it was born, never by its words.
    const why = "no credential here for git.example.com; sign in and bring back again";
    let push: Answer = () => refused(why, "no-git-credential");
    const daemons = fakeDaemons({
      here: { "git.branchCompare": () => ok({ pushed: false }), "git.prRead": () => ok({}) },
      m1: { "git.status": () => status("tree/lead", { upstream: "origin/tree/lead" }) },
      m2: { "git.startOn": STARTED, "git.status": () => status("child/one"), "git.push": f => push(f) },
    });
    const { lead, scope, agent } = await withLead(daemons);
    const seen = trees(rt!);
    const child = await createOn(rt!, { name: "helper" }, asThread(scope));
    await expect(rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope))).rejects.toThrow(why);
    await until(() => seen.get(lead.id)?.children[0]?.pushRefused === why);
    // A refusal for anything else is the push's own and says nothing about the computer's sign-in.
    push = PUSHED("child/one");
    await rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope));
    await until(() => seen.get(lead.id)?.children[0] !== undefined && seen.get(lead.id)?.children[0]?.pushRefused === undefined);
    push = () => refused("this computer has no git credential for github.com, so nothing was pushed");
    await expect(rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope))).rejects.toThrow();
    await new Promise(r => setTimeout(r, 20));
    expect(seen.get(lead.id)?.children[0]?.pushRefused).toBeUndefined();
    push = PUSHED("child/one");
    await rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope));
    await until(() => seen.get(lead.id)?.children[0] !== undefined && seen.get(lead.id)?.children[0]?.pushRefused === undefined);
    agent.end(0);
  });
});

describe("merge into lead", () => {
  const merged = (f: Record<string, unknown>): DaemonResponse => ok({ branch: String(f["branch"]), merged: true, commits: 2, oid: "d00d", conflicts: [] });

  async function leadWithChild(extra: Partial<Record<string, Answer>> = {}) {
    const daemons = fakeDaemons({
      here: { "git.branchCompare": () => ok({ pushed: true, aheadBy: 2, behindBy: 0, status: "ahead" }), "git.prRead": () => ok({}) },
      m1: { "git.status": () => status("tree/lead", { upstream: "origin/tree/lead" }), "git.mergeIn": merged, ...extra },
      m2: { "git.startOn": STARTED, "git.status": () => status("child/one") },
    });
    const at = await withLead(daemons);
    const child = await createOn(rt!, { name: "helper" }, asThread(at.scope));
    return { daemons, child, ...at };
  }

  it("lets the lead's thread merge from inside its own turn, and refuses while any other turn runs on the lead, naming it", async () => {
    const { daemons, lead, child, scope } = await leadWithChild();
    expect((await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id }, asThread(scope))).merged).toBe(true);
    // The person's merge would land under the lead's running turn, so it is refused with the thread that must stop.
    await expect(rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id })).rejects.toThrow(leadBusyRefusal("lead", [scope.threadId]));
    const second = await rt!.sessions.start(lead.id, { prompt: "a second thread on the lead" }, asThread(scope));
    const other = second.view().threadId!;
    await expect(rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id }, asThread(scope))).rejects.toThrow(leadBusyRefusal("lead", [other]));
    expect(daemons.sent("m1", "git.mergeIn")).toHaveLength(1);
  });

  it("is refused while a turn runs on the lead, and merges through the lead's own daemon once it is quiet", async () => {
    const { daemons, lead, child, agent, scope } = await leadWithChild();
    await expect(rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id })).rejects.toThrow(leadBusyRefusal("lead", [scope.threadId]));
    expect(daemons.ops("m1")).not.toContain("git.mergeIn");
    agent.end(0);
    await until(async () => (await rt!.sessions.list(lead.id)).every(s => s.status !== "running"));
    const done = await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: "helper" });
    expect(done).toEqual({ lead: "lead", child: "helper", branch: "child/one", merged: true, commits: 2, conflicts: [] });
    expect(daemons.sent("m1", "git.mergeIn")).toEqual([{ op: "git.mergeIn", cwd: expect.any(String), branch: "child/one" }]);
  });

  it("keeps the files a merge stopped on on the child's row, and a merge that lands on it", async () => {
    let answer: Answer = f => ok({ branch: String(f["branch"]), merged: false, commits: 0, conflicts: ["lead.txt"] });
    const { lead, child, agent } = await leadWithChild({ "git.mergeIn": f => answer(f) });
    const seen = trees(rt!);
    agent.end(0);
    await until(async () => (await rt!.sessions.list(lead.id)).every(s => s.status !== "running"));
    expect(await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id })).toMatchObject({ merged: false, conflicts: ["lead.txt"] });
    await until(() => seen.get(lead.id)?.children[0]?.conflicts?.[0] === "lead.txt");
    answer = merged;
    await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id });
    await until(() => seen.get(lead.id)?.children[0]?.merged?.oid === "d00d");
    expect(seen.get(lead.id)?.children[0]?.conflicts).toBeUndefined();
  });

  it("reads a child merged into the lead as nothing ahead at once, counted against the commit the merge took, and its new commits as ahead again", async () => {
    const took = (f: Record<string, unknown>): DaemonResponse => ok({ branch: String(f["branch"]), merged: true, commits: 2, oid: "d00d", head: "c0de", conflicts: [] });
    const { daemons, lead, child, scope } = await leadWithChild({ "git.mergeIn": took });
    // The remote's lead branch lacks the merge until the lead's bring back; the commit the merge took is in the copy.
    let since = 0;
    daemons.answers.here!["git.branchCompare"] = f =>
      ok(f["base"] === "c0de" ? { pushed: true, aheadBy: since, behindBy: 0, status: since > 0 ? "ahead" : "identical" } : { pushed: true, aheadBy: 2, behindBy: 0, status: "ahead" });
    const seen = trees(rt!);
    await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id }, asThread(scope));
    await until(() => seen.get(lead.id)?.children[0]?.merged?.head === "c0de");
    expect(seen.get(lead.id)?.children[0]).toMatchObject({ aheadOfLead: 0, merged: { oid: "d00d", head: "c0de" } });
    expect(daemons.sent("here", "git.branchCompare").at(-1)).toMatchObject({ base: "c0de", head: "child/one" });
    since = 1;
    await rt!.workspaces.checkout(lead.id);
    await until(() => seen.get(lead.id)?.children[0]?.aheadOfLead === 1);
  });

  it("is refused for a workspace that is not the lead's child", async () => {
    const { lead, agent } = await leadWithChild();
    agent.end(0);
    await until(async () => (await rt!.sessions.list(lead.id)).every(s => s.status !== "running"));
    await expect(rt!.workspaces.mergeIn({ workspaceId: lead.id, child: lead.id })).rejects.toThrow(notTheLeadsChildRefusal("lead", "lead"));
  });

  it("lets a lead's own thread merge into its own workspace and refuses a child's thread merging into its lead", async () => {
    const { daemons, lead, child, scope, agent } = await leadWithChild();
    const childTurn = await rt!.sessions.start(child.id, { prompt: "work" }, asThread(scope));
    const childScope: ThreadScope = { kind: "thread", threadId: childTurn.view().threadId!, workspaceId: child.id, rootThreadId: scope.rootThreadId };
    agent.end(1);
    // A child's thread does not reach its lead's workspace at all, and a lead's thread may not make its child the target.
    await expect(rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id }, asThread(childScope))).rejects.toThrow("no such workspace");
    await expect(rt!.workspaces.mergeIn({ workspaceId: child.id, child: lead.id }, asThread(scope))).rejects.toThrow(mergeIntoOwnRefusal(scope.threadId));
    expect(daemons.ops("m1")).not.toContain("git.mergeIn");
    expect(daemons.ops("m2")).not.toContain("git.mergeIn");
    // The lead's own turn is the one running, and the lead's thread calls from inside it.
    expect((await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id }, asThread(scope))).merged).toBe(true);
  });

  it("hands a stopped merge to the lead's first thread with the files named, and runs no update", async () => {
    const { daemons, lead, child, agent, project } = await leadWithChild({ "git.mergeIn": f => ok({ branch: String(f["branch"]), merged: false, commits: 0, conflicts: ["lead.txt"] }) });
    agent.end(0);
    await until(async () => (await rt!.sessions.list(lead.id)).every(s => s.status !== "running"));
    await rt!.workspaces.mergeIn({ workspaceId: lead.id, child: child.id });
    const fixed = await rt!.workspaces.fix({ workspaceId: lead.id, child: child.id });
    expect(fixed.outcome).toBe("started");
    await until(() => agent.prompts.length === 2);
    expect(agent.prompts[1]).toBe(mergeChildPrompt({ leadBranch: "tree/lead", childBranch: "child/one", remote: "origin", conflicts: ["lead.txt"] }));
    expect(daemons.ops()).not.toContain("git.update");
    void project;
  });
});

describe("merge into lead with no remote", () => {
  it("fetches from the child's own folder where both copies sit on this computer, and refuses a child on another computer", async () => {
    const daemons = fakeDaemons({
      here: {
        "git.status": f => status(String(f["cwd"]).includes("child") ? "child/one" : "tree/lead"),
        "git.mergeIn": f => ok({ branch: String(f["branch"]), merged: true, commits: 1, oid: "d00d", conflicts: [] }),
        "git.startOn": STARTED,
      },
      "*": { "git.status": () => status("child/two"), "git.startOn": STARTED },
    });
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    answeringAtOnce(backend);
    rt = createRuntime({ backend, store, adapters: {}, daemonToken: DAEMON_TOKEN, daemonChannel: daemons.open, local: localOn() });
    const here = await projectOn(rt, HERE_PLACE_ID, undefined, { name: "lab" });
    const lead = await rt.workspaces.create({ project: here.id, name: "lead" });
    // A thread in the project folder starts its child on a branch: the child runs in a worktree, a child of the folder.
    const child = (await rt.workspaces.folderFor({ project: here.id, branch: "child/one" }, { origin: "here", by: { kind: "thread", threadId: "lead-thread", workspaceId: lead.id, rootThreadId: "lead-thread" } })).workspace;
    expect(child.parentWorkspaceId).toBe(lead.id);
    const done = await rt.workspaces.mergeIn({ workspaceId: lead.id, child: child.id });
    expect(done.merged).toBe(true);
    const asked = daemons.sent("here", "git.mergeIn")[0]!;
    expect(asked["from"]).toBe(child.folder);
    expect(asked["cwd"]).toBe(lead.folder);
  });

  it("hands a stopped merge to the lead's agent with the child's folder to fetch from, since there is no remote to name", async () => {
    const daemons = fakeDaemons({
      here: {
        "git.status": f => status(String(f["cwd"]).includes("child") ? "child/one" : "tree/lead"),
        "git.mergeIn": f => ok({ branch: String(f["branch"]), merged: false, commits: 0, conflicts: ["lead.txt"] }),
      },
    });
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    answeringAtOnce(backend);
    const agent = heldAgent();
    rt = createRuntime({ backend, store, adapters: { claude: agent.factory }, daemonToken: DAEMON_TOKEN, daemonChannel: daemons.open, local: localOn() });
    const here = await projectOn(rt, HERE_PLACE_ID, undefined, { name: "lab" });
    const lead = await rt.workspaces.create({ project: here.id, name: "lead", agents: AGENTS_ON });
    const child = (await rt.workspaces.folderFor({ project: here.id, branch: "child/one" }, { origin: "here", by: { kind: "thread", threadId: "lead-thread", workspaceId: lead.id, rootThreadId: "lead-thread" } })).workspace;
    await rt.workspaces.mergeIn({ workspaceId: lead.id, child: child.id });
    await rt.workspaces.fix({ workspaceId: lead.id, child: child.id });
    await until(() => agent.prompts.length === 1);
    expect(agent.prompts[0]).toBe(mergeChildPrompt({ leadBranch: "tree/lead", childBranch: "child/one", remote: child.folder!, conflicts: ["lead.txt"] }));
  });

  it("refuses in one sentence naming the project where either copy sits on another computer, and fetches nothing", async () => {
    const daemons = fakeDaemons({ "*": { "git.status": () => status("main", { upstream: "origin/main" }) } });
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    answeringAtOnce(backend);
    rt = createRuntime({ backend, store, adapters: {}, daemonToken: DAEMON_TOKEN, daemonChannel: daemons.open, local: localOn() });
    const there = await projectOn(rt, undefined, "file:///srv/lab.git", { name: "lab-box", base: "main" });
    const lead = await rt.workspaces.create({ project: there.id, golden: "snap_g", name: "lead" });
    const child = await rt.workspaces.create({ project: there.id, golden: "snap_g", name: "child", parent: lead.id });
    daemons.answers["*"]!["git.status"] = () => status("child/one");
    await expect(rt.workspaces.mergeIn({ workspaceId: lead.id, child: child.id })).rejects.toThrow(noRemoteForTreeLine("lab-box"));
    expect(daemons.ops()).not.toContain("git.mergeIn");
  });
});
