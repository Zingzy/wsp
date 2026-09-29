// SPDX-License-Identifier: AGPL-3.0-only
// The pull request's host half: the read through this computer's own daemon with the remote off the project's record,
// the copy asked only when this computer has no command line and the copy runs, the timer that reads an open one
// whatever its checks say and nothing merged, the tree settled once its pull request merges and nothing in it works, and the
// acts on it: the page, a fix sent into the workspace's thread, a merge of the head the host read, and an update.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_MERGE_OFF_LINE,
  PR_POLL_MS,
  checkNotFailedRefusal,
  childPushedLine,
  mergeMethodRefusal,
  pullRequestStoppedLine,
  pullRequestUnreadLine,
  spawnActRefusal,
  type Caller,
  type DaemonFrame,
  type DaemonResponse,
  type EventUnion,
  type PullRequest,
  type ThreadScope,
  type TurnResult,
} from "@wsp/protocol";
import { LocalBackend } from "@wsp/engine";
import { CHECKOUT_TTL_MS, copyKey, createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { copyingFake, createOn, projectOn, stubBackend, testPlatform, tokenGuest, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);
/** Where this computer's own daemon answers, and where the copy's does: every frame is told apart by the road it came on. */
const HERE = "ws://this-computer";
const COPY = "http://127.0.0.1:7070";
const HEAD = "ec5c10de663bd1860925ad42e9580bab4eb1d377";

const STATUS: DaemonResponse = { id: 1, ok: true, branch: { oid: "abc", head: "fix/ci", upstream: "origin/fix/ci", ahead: 1, behind: 0 }, entries: [], root: "/root/stub" };

const open = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 12,
  url: "https://github.com/wsp/pr-lab/pull/12",
  state: "open",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "fix/ci",
  headOid: HEAD,
  headSubject: "Set .ci-status to 1",
  mergeable: "mergeable",
  mergeState: "clean",
  review: "none",
  checks: [{ name: "ci", workflow: "ci", state: "pass", run: { runId: 36, jobId: 109 }, link: "https://github.com/wsp/pr-lab/actions/runs/36/job/109" }],
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  commits: 1,
  behindBase: 0,
  ...over,
});

type Answer = (frame: Record<string, unknown>) => DaemonResponse;

/** Two daemons behind one dial: this computer's and the copy's, told apart by the url dialled. Each records every frame
 * with its road, and answers by op; a road with no answer for an op refuses it as a daemon does. */
function fakeDaemons(o: { here?: Partial<Record<string, Answer>>; copy?: Partial<Record<string, Answer>> } = {}) {
  const frames: { road: "here" | "copy"; frame: Record<string, unknown> }[] = [];
  const here: Record<string, Answer> = { "git.prRead": () => ({ id: 1, ok: true, pr: open() }), ...o.here } as Record<string, Answer>;
  const copy: Record<string, Answer> = { "git.status": () => STATUS, ...o.copy } as Record<string, Answer>;
  return {
    frames,
    ops: (road?: "here" | "copy") => frames.filter(f => road === undefined || f.road === road).map(f => f.frame["op"]),
    open: async (opts: DaemonChannelOptions): Promise<DaemonChannel> => ({
      send: async (frame: DaemonFrame) => {
        const held = frame as unknown as Record<string, unknown>;
        const road = opts.url === HERE ? "here" : "copy";
        frames.push({ road, frame: held });
        const answer = (road === "here" ? here : copy)[String(held["op"])];
        return answer === undefined ? ({ id: 1, ok: false, error: `${String(held["op"])} was not answered here` } as DaemonResponse) : answer(held);
      },
      close: () => {},
      closed: new Promise(() => {}),
    }),
  };
}

const NO_GH: Answer = () => ({ id: 1, ok: false, code: "no-host-cli", error: "no signed-in command line for github.com is on this computer; the branch is pushed and the pull request waits for one" }) as DaemonResponse;

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
const AGENTS_ON = { spawn: true, maxMachines: 3, maxDepth: 3 };
const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

let rt: Runtime | undefined;
let root: string;
let store: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "wsp-pr-"));
  store = memoryStore();
  await store.put("goldens", copyKey("default", "default"), IMAGE);
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** This computer wired as a host wires it, its own daemon at HERE. */
const localOn = (daemonRoad = true): LocalWiring => ({
  backend: new LocalBackend({ root }),
  execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
  home: () => join(root, ".claude"),
  homeDir: root,
  rootsPath: join(root, "roots"),
  env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
  platform: testPlatform(),
  copier: copyingFake(),
  ...(daemonRoad ? { daemonRoad: async () => ({ url: HERE, expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN }) } : {}),
});

async function withWorkspace(
  daemons: ReturnType<typeof fakeDaemons>,
  o: { adapters?: Record<string, HarnessAdapterFactory>; clock?: ReturnType<typeof fakeClock>["clock"]; daemonRoad?: boolean } = {},
): Promise<{ backend: StubBackend; id: string; name: string; remote: string }> {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  rt = createRuntime({
    backend,
    store,
    adapters: o.adapters ?? {},
    daemonToken: DAEMON_TOKEN,
    daemonChannel: daemons.open,
    local: localOn(o.daemonRoad ?? true),
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
  });
  lastPr.clear();
  rt.events.on("workspace.status", e => {
    if (e.type === "workspace.status") lastPr.set(e.status.id, e.status.pr as Record<string, unknown> | undefined);
  });
  const project = await projectOn(rt, undefined, undefined, { base: "main" });
  const ws = await createOn(rt, { project: project.id, golden: "snap_g", name: "pr-lab", agents: AGENTS_ON });
  backend.machines[0]!.previewUrl = async () => ({ url: COPY, token: "e", expiresAt: Date.now() + 3_600_000 });
  return { backend, id: ws.id, name: ws.name, remote: project.remote };
}

/** The pull request each workspace's latest pushed status carried. */
const lastPr = new Map<string, Record<string, unknown> | undefined>();
const prOf = async (id: string): Promise<{ pr?: Record<string, unknown> }> => {
  const pr = lastPr.get(id);
  return pr === undefined ? {} : { pr };
};

const statuses = (runtime: Runtime): EventUnion[] => {
  const seen: EventUnion[] = [];
  runtime.events.on("workspace.status", e => seen.push(e));
  return seen;
};

describe("reading the pull request", () => {
  it("goes over this computer's own daemon with the project's remote and the copy's branch, and never asks the copy for it", async () => {
    const daemons = fakeDaemons();
    const { id, remote } = await withWorkspace(daemons);
    const seen = statuses(rt!);
    await rt!.workspaces.checkout(id);
    await until(() => daemons.ops("here").includes("git.prRead"));
    const read = daemons.frames.find(f => f.frame["op"] === "git.prRead")!;
    expect(read).toEqual({ road: "here", frame: { op: "git.prRead", cwd: root, remote, branch: "fix/ci" } });
    expect(remote).toMatch(/^https:\/\/github\.com\/wsp\/stub-\d+\.git$/);
    expect(daemons.ops("copy")).toEqual(["git.status"]);
    await until(() => seen.some(e => e.type === "workspace.status" && (e.status.pr as { number?: number } | undefined)?.number === 12));
    expect((await prOf(id))?.pr).toMatchObject({ number: 12, state: "open", readAt: expect.any(Number) });
    // The listing every client and `wsp workspaces --json` read carries it where it carries the branch line.
    expect((await rt!.status.list()).find(w => w.id === id)?.pr).toMatchObject({ number: 12, state: "open" });
  });

  it("asks the copy only where this computer has no command line for the host and the copy runs, and reads not read otherwise", async () => {
    const daemons = fakeDaemons({ here: { "git.prRead": NO_GH }, copy: { "git.prRead": () => ({ id: 1, ok: true, pr: open({ number: 3 }) }) } });
    const { clock, advance } = fakeClock();
    const { id, name, remote } = await withWorkspace(daemons, { clock });
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["number"] === 3);
    const asked = daemons.frames.filter(f => f.frame["op"] === "git.prRead");
    expect(asked.map(f => f.road)).toEqual(["here", "copy"]);
    // The copy is told the same remote, off the record, and runs its own gh in its own checkout.
    expect(asked[1]!.frame).toMatchObject({ remote, branch: "fix/ci", cwd: expect.stringMatching(/^\/root\/stub-\d+$/) });
    // Napped, the copy is never woken for a read, and the tile says why it is not read.
    await rt!.workspaces.nap(id);
    daemons.frames.length = 0;
    advance(CHECKOUT_TTL_MS + 1);
    await rt!.workspaces.checkout(id);
    await until(async () => typeof (await prOf(id))?.pr?.["why"] === "string");
    expect((await prOf(id))?.pr).toMatchObject({ why: pullRequestStoppedLine("github.com", name) });
    expect(daemons.ops("copy").filter(op => op === "git.prRead")).toEqual([]);
  });

  it("reads not read where neither this computer nor the copy has a command line for the host", async () => {
    const daemons = fakeDaemons({ here: { "git.prRead": NO_GH }, copy: { "git.prRead": NO_GH } });
    const { id } = await withWorkspace(daemons);
    await rt!.workspaces.checkout(id);
    await until(async () => typeof (await prOf(id))?.pr?.["why"] === "string");
    expect((await prOf(id))?.pr).toMatchObject({ why: pullRequestUnreadLine("github.com") });
  });

  it("keeps the fact it holds through a read gh failed, and reads again on its timer after it", async () => {
    let answer: Answer = () => ({ id: 1, ok: true, pr: open({ checks: [{ name: "ci", state: "pass" }] }) });
    const daemons = fakeDaemons({ here: { "git.prRead": held => answer(held) } });
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemons, { clock });
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["number"] === 12);
    answer = () => ({ id: 1, ok: false, error: "gh said: error connecting to api.github.com" }) as DaemonResponse;
    advance(PR_POLL_MS);
    await until(() => daemons.ops("here").length === 2);
    await new Promise(r => setTimeout(r, 20));
    expect((await prOf(id))?.pr).toMatchObject({ number: 12, state: "open" });
    answer = () => ({ id: 1, ok: true, pr: open({ state: "merged" }) });
    advance(PR_POLL_MS);
    await until(() => daemons.ops("here").length === 3);
    await until(async () => (await prOf(id))?.pr?.["state"] === "merged");
  });

  it("reads an open one again on its timer whatever its checks say, so a merge made on the host's own page is seen, and never again once merged", async () => {
    // Just after a push the host answers the old head with no checks at all, and once checks pass nothing is pending:
    // neither is the last word on an open pull request.
    let pr = open({ checks: [] });
    const daemons = fakeDaemons({ here: { "git.prRead": () => ({ id: 1, ok: true, pr }) } });
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemons, { clock });
    await rt!.workspaces.checkout(id);
    await until(() => daemons.ops("here").length === 1);
    pr = open({ checks: [{ name: "ci", state: "pass" }] });
    advance(PR_POLL_MS);
    await until(() => daemons.ops("here").length === 2);
    // Merged on the host's page, with no window open and no turn ending: the timer is what sees it.
    pr = open({ state: "merged", checks: [{ name: "ci", state: "pass" }] });
    advance(PR_POLL_MS);
    await until(() => daemons.ops("here").length === 3);
    await until(async () => (await prOf(id))?.pr?.["state"] === "merged");
    // Merged is never read again, whatever asks.
    advance(PR_POLL_MS * 3);
    advance(20_000);
    await rt!.workspaces.checkout(id);
    await new Promise(r => setTimeout(r, 20));
    expect(daemons.ops("here")).toHaveLength(3);
  });
});

describe("settling on merge", () => {
  it("stamps every thread of a quiet tree settled and naps its machine, and restore brings it back with nothing read again", async () => {
    let pr = open();
    const daemons = fakeDaemons({ here: { "git.prRead": () => ({ id: 1, ok: true, pr }) } });
    const agent = heldAgent();
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemons, { adapters: { claude: agent.factory }, clock });
    const lead = await rt!.sessions.start(id, { prompt: "fix the check" });
    const threadId = lead.view().threadId!;
    agent.end(0);
    await lead.finished;
    await until(async () => (await prOf(id))?.pr?.["state"] === "open");
    expect((await rt!.sessions.list(id)).every(r => r.settledAt === undefined)).toBe(true);
    // Merged on GitHub: the tile's next ask, past the window a read stands for, sees it.
    pr = open({ state: "merged" });
    advance(CHECKOUT_TTL_MS + 1);
    await rt!.workspaces.checkout(id);
    await until(async () => (await rt!.sessions.list(id)).every(r => r.settledAt !== undefined));
    await until(async () => (await rt!.workspaces.list()).find(w => w.id === id)?.phase === "napping");
    const reads = daemons.ops("here").filter(op => op === "git.prRead").length;
    await rt!.sessions.restore([threadId]);
    expect((await rt!.sessions.list(id)).every(r => r.settledAt === undefined)).toBe(true);
    advance(CHECKOUT_TTL_MS + 1);
    await rt!.workspaces.checkout(id);
    await new Promise(r => setTimeout(r, 20));
    expect(daemons.ops("here").filter(op => op === "git.prRead")).toHaveLength(reads);
    expect((await rt!.sessions.list(id)).every(r => r.settledAt === undefined)).toBe(true);
  });

  it("leaves a merged tree live while a child works, and stamps it when the child's turn ends", async () => {
    const daemons = fakeDaemons({ here: { "git.prRead": () => ({ id: 1, ok: true, pr: open({ state: "merged" }) }) } });
    const agent = heldAgent();
    const { id } = await withWorkspace(daemons, { adapters: { claude: agent.factory } });
    const lead = await rt!.sessions.start(id, { prompt: "lead" });
    const rootThread = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: id, rootThreadId: rootThread };
    const child = await rt!.sessions.start(id, { prompt: "child" }, asThread(scope));
    agent.end(0);
    await lead.finished;
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["state"] === "merged");
    await new Promise(r => setTimeout(r, 20));
    expect((await rt!.sessions.list(id)).some(r => r.settledAt !== undefined)).toBe(false);
    expect(child.view().rootThreadId).toBe(rootThread);
    agent.end(1);
    await child.finished;
    await until(async () => (await rt!.sessions.list(id)).every(r => r.settledAt !== undefined));
  });

  it("settles nothing off a child workspace's own pull request, and a child's bring back pushes and opens none", async () => {
    const daemons = fakeDaemons({
      here: { "git.prRead": () => ({ id: 1, ok: true, pr: open({ state: "merged" }) }) },
      copy: { "git.push": () => ({ id: 1, ok: true, branch: "fix/ci", base: "main", remote: "origin", ahead: 1, uncommitted: 0, stat: [] }) },
    });
    const agent = heldAgent();
    const { backend, id } = await withWorkspace(daemons, { adapters: { claude: agent.factory } });
    const lead = await rt!.sessions.start(id, { prompt: "lead" });
    const rootThread = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: id, rootThreadId: rootThread };
    const child = await createOn(rt!, { name: "helper" }, asThread(scope));
    backend.machines[1]!.previewUrl = async () => ({ url: COPY, token: "e", expiresAt: Date.now() + 3_600_000 });
    agent.end(0);
    await lead.finished;
    const brought = await rt!.workspaces.bringBack({ workspaceId: child.id }, asThread(scope));
    expect(brought).toMatchObject({ branch: "fix/ci", note: childPushedLine("fix/ci") });
    expect(brought.pr).toBeUndefined();
    expect(daemons.ops()).not.toContain("git.pr");
    // A root's bring back asks for both halves.
    await rt!.workspaces.bringBack({ workspaceId: id }).catch(() => undefined);
    expect(daemons.ops("copy")).toContain("git.pr");
  });
});

describe("the acts on a pull request", () => {
  it("reads the page over this computer's daemon, never kept", async () => {
    const page = { title: "t", body: "b", commits: [], reviews: [], comments: [], reviewComments: [], files: [] };
    const merge = { methods: ["squash", "merge"], defaultMethod: "squash", autoMerge: true };
    const daemons = fakeDaemons({ here: { "git.prView": () => ({ id: 1, ok: true, ...page }), "git.repoRead": () => ({ id: 1, ok: true, ...merge }) } });
    const { id, remote } = await withWorkspace(daemons);
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["number"] === 12);
    // The pane offers the methods the repository allows, read once an hour on this computer.
    expect(await rt!.workspaces.pullRequestView({ workspaceId: id })).toEqual({ ...page, merge });
    await rt!.workspaces.pullRequestView({ workspaceId: id });
    expect(daemons.ops("here").filter(op => op === "git.repoRead")).toHaveLength(1);
    expect(daemons.frames.filter(f => f.frame["op"] === "git.prView")).toEqual([
      { road: "here", frame: { op: "git.prView", cwd: root, remote, number: 12 } },
      { road: "here", frame: { op: "git.prView", cwd: root, remote, number: 12 } },
    ]);
  });

  it("sends a failed check's log into the workspace's thread as a message framed as a log, and answers at once", async () => {
    const failed = open({ checks: [{ name: "ci", workflow: "ci", state: "fail", run: { runId: 36, jobId: 109 }, link: "https://github.com/wsp/pr-lab/actions/runs/36/job/109" }, { name: "lint", state: "pass" }] });
    const daemons = fakeDaemons({
      here: {
        "git.prRead": () => ({ id: 1, ok: true, pr: failed }),
        "git.runLog": () => ({ id: 1, ok: true, lines: ["Run check\texit 1"], truncated: false }),
      },
    });
    const agent = heldAgent();
    const { id } = await withWorkspace(daemons, { adapters: { claude: agent.factory } });
    const lead = await rt!.sessions.start(id, { prompt: "set .ci-status to 1" });
    const threadId = lead.view().threadId!;
    agent.end(0);
    await lead.finished;
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["number"] === 12);
    const asked = await rt!.workspaces.fix({ workspaceId: id, check: "ci" });
    expect(asked).toEqual({ outcome: "started", threadId, check: "ci", base: "main", agent: "claude" });
    expect(daemons.frames.find(f => f.frame["op"] === "git.runLog")).toMatchObject({ road: "here", frame: { runId: 36, jobId: 109 } });
    expect(agent.prompts[1]).toContain('The check "ci" in the ci workflow failed on commit ec5c10d (Set .ci-status to 1).');
    expect(agent.prompts[1]).toContain("```text\nRun check\texit 1\n```");
    // A check that passed is not one to fix, and one the pull request lacks is named with the ones it has.
    await expect(rt!.workspaces.fix({ workspaceId: id, check: "lint" })).rejects.toThrow(checkNotFailedRefusal("lint", "pass"));
    await expect(rt!.workspaces.fix({ workspaceId: id, check: "e2e" })).rejects.toThrow("the pull request has no check called e2e; it has ci, lint");
    agent.end(1);
  });

  it("with no check updates from the base first, sends nothing when it merged clean, and sends the conflicts when it did not", async () => {
    let update: DaemonResponse = { id: 1, ok: true, base: "main", merged: true, commits: 2, conflicts: [] };
    const daemons = fakeDaemons({ copy: { "git.update": () => update } });
    const agent = heldAgent();
    const { id } = await withWorkspace(daemons, { adapters: { claude: agent.factory } });
    const lead = await rt!.sessions.start(id, { prompt: "change the readme" });
    agent.end(0);
    await lead.finished;
    expect(await rt!.workspaces.fix({ workspaceId: id })).toEqual({ outcome: "updated", base: "main" });
    expect(agent.prompts).toHaveLength(1);
    expect(daemons.frames.find(f => f.frame["op"] === "git.update")).toMatchObject({ road: "copy", frame: { base: "main" } });
    update = { id: 1, ok: true, base: "main", merged: false, commits: 0, conflicts: ["README.md"] };
    expect(await rt!.workspaces.fix({ workspaceId: id })).toMatchObject({ outcome: "started", base: "main" });
    expect(agent.prompts[1]).toBe("Merge the latest main into fix/ci, and resolve the conflicts in README.md. Run the tests, commit the merge, and push.");
    agent.end(1);
  });

  it("merges the head the host read by the repository's default, refuses a method it does not allow and a wait it does not offer, then reads again", async () => {
    let pr = open();
    const daemons = fakeDaemons({
      here: {
        "git.prRead": () => ({ id: 1, ok: true, pr }),
        "git.repoRead": () => ({ id: 1, ok: true, methods: ["merge", "squash"], defaultMethod: "squash", autoMerge: false }),
        "git.prMerge": () => {
          pr = open({ state: "merged" });
          return { id: 1, ok: true, merged: true, autoArmed: false };
        },
      },
    });
    const { id, remote } = await withWorkspace(daemons);
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["number"] === 12);
    await expect(rt!.workspaces.merge({ workspaceId: id, method: "rebase" })).rejects.toThrow(mergeMethodRefusal("rebase", ["merge", "squash"]));
    await expect(rt!.workspaces.merge({ workspaceId: id, whenChecksPass: true })).rejects.toThrow(AUTO_MERGE_OFF_LINE);
    expect(await rt!.workspaces.merge({ workspaceId: id })).toEqual({ number: 12, method: "squash", merged: true, autoArmed: false });
    expect(daemons.frames.find(f => f.frame["op"] === "git.prMerge")).toEqual({
      road: "here",
      frame: { op: "git.prMerge", cwd: root, remote, number: 12, method: "squash", auto: false, headOid: HEAD },
    });
    // The repository's settings are asked once for all three.
    expect(daemons.ops("here").filter(op => op === "git.repoRead")).toHaveLength(1);
    await until(async () => (await prOf(id))?.pr?.["state"] === "merged");
  });

  it("merges the head the person was shown and never one a later read found, whatever the fact's age", async () => {
    let pr = open();
    const merges: Record<string, unknown>[] = [];
    const daemons = fakeDaemons({
      here: {
        "git.prRead": () => ({ id: 1, ok: true, pr }),
        "git.repoRead": () => ({ id: 1, ok: true, methods: ["squash"], defaultMethod: "squash", autoMerge: false }),
        "git.prMerge": f => {
          merges.push(f);
          return { id: 1, ok: true, merged: false, autoArmed: false };
        },
      },
    });
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemons, { clock });
    await rt!.workspaces.checkout(id);
    await until(async () => (await prOf(id))?.pr?.["headOid"] === HEAD);
    // The agent pushes after the page was drawn and the fact grows old: the merge still names what was shown.
    pr = open({ headOid: "b".repeat(40) });
    advance(60_000);
    const reads = daemons.ops("here").filter(op => op === "git.prRead").length;
    // With no head named, the fact the host holds is the head, not a fresh read of it.
    await rt!.workspaces.merge({ workspaceId: id });
    expect(merges.at(-1)).toMatchObject({ headOid: HEAD });
    const before = daemons.frames.findIndex(f => f.frame["op"] === "git.prMerge");
    expect(daemons.frames.slice(0, before).filter(f => f.frame["op"] === "git.prRead")).toHaveLength(reads);
    // The read after that merge holds the new head; a window that drew the old one still merges only the old one.
    await until(async () => (await prOf(id))?.pr?.["headOid"] === "b".repeat(40));
    await rt!.workspaces.merge({ workspaceId: id, head: HEAD });
    expect(merges.at(-1)).toMatchObject({ headOid: HEAD });
  });

  it("refuses a merge asked by a thread's own token in the guard's words, and lets a thread update a copy of its tree", async () => {
    const daemons = fakeDaemons({ copy: { "git.update": () => ({ id: 1, ok: true, base: "main", merged: true, commits: 1, conflicts: [] }) } });
    const agent = heldAgent();
    const { id } = await withWorkspace(daemons, { adapters: { claude: agent.factory } });
    const lead = await rt!.sessions.start(id, { prompt: "lead" });
    const rootThread = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: id, rootThreadId: rootThread };
    await expect(rt!.workspaces.merge({ workspaceId: id }, asThread(scope))).rejects.toThrow(spawnActRefusal(rootThread, "merge"));
    expect(await rt!.workspaces.update({ workspaceId: id }, asThread(scope))).toEqual({ base: "main", merged: true, commits: 1, conflicts: [] });
    expect(daemons.ops()).not.toContain("git.prMerge");
    agent.end(0);
  });

  it("updates the copy from its base through the copy's own daemon, then reads the branch line and the pull request again", async () => {
    const daemons = fakeDaemons({ copy: { "git.update": () => ({ id: 1, ok: true, base: "main", merged: false, commits: 0, conflicts: ["README.md"] }) } });
    const { id } = await withWorkspace(daemons);
    expect(await rt!.workspaces.update({ workspaceId: id })).toEqual({ base: "main", merged: false, commits: 0, conflicts: ["README.md"] });
    const ops = daemons.frames.map(f => `${f.road}:${String(f.frame["op"])}`);
    expect(ops.indexOf("copy:git.update")).toBeLessThan(ops.lastIndexOf("copy:git.status"));
    await until(() => daemons.ops("here").includes("git.prRead"));
  });
});
