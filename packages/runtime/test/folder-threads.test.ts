// SPDX-License-Identifier: AGPL-3.0-only
// A thread on this computer runs in the project folder; another branch runs
// it in a worktree of the project's repo. What is proved here is the record a
// start lands on, the folder its turn is handed, what the copier is asked for,
// what a rewind may move in a folder threads share, and where a thread goes
// once its worktree is gone. The copier and the daemon are fakes; git is real.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { CARRIED_DIR_NAMES } from "@wsp/catalog";
import {
  cwdOutsideLine,
  DAEMON_VERSION,
  noBranchesLine,
  notMadeWorktreeLine,
  REWIND_SHARED_LINE,
  worktreeChangedLine,
  PR_BEHIND_WORDS,
  projectInUseRefusal,
  WORKTREE_BUSY_LINE,
  WORKTREE_FORCE_LINE,
  type AdapterEvent,
  type Caller,
  type PullRequest,
  type ThreadScope,
  type DaemonFrame,
  type DaemonResponse,
  type TurnResult,
} from "@wsp/protocol";
import { createRuntime, NO_COPIER_HERE, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { gitCopier } from "./git-copier.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

const roots: string[] = [];
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-folder-threads-")));
  roots.push(root);
  return root;
};
/** A repo on main with one commit. */
const repo = (): string => {
  const at = scratch();
  git(at, "init", "-q", "-b", "main");
  git(at, "commit", "-q", "--allow-empty", "-m", "first");
  return at;
};

let rt: Runtime | undefined;
afterEach(async () => {
  holding.on = false;
  holding.waiting.splice(0).forEach(go => go());
  await rt?.close();
  rt = undefined;
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** A harness that answers each turn at once and records what it was started with. A resume keeps its session, and
 * every new one is numbered on the one count the harnesses share, so no two threads hold one session. */
let n = 0;
/** Turns held until the test lets them go, where a test holds them. */
const holding: { on: boolean; waiting: (() => void)[] } = { on: false, waiting: [] };
function harness(starts: HarnessStartOptions[]): HarnessAdapterFactory {
  return () => ({
    steers: false,
    resumesAt: true,
    start: o => {
      n += 1;
      starts.push(o);
      const sessionId = o.resume ?? `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const held = holding.on ? new Promise<void>(go => holding.waiting.push(go)) : Promise.resolve();
      if (holding.on) o.onEvent({ type: "session.start", sessionId });
      const finished = held.then(() => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.anchor", sessionId, anchor: `a${n}` },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

/** A daemon that takes checkpoints and restores, recording every frame; a test adds an answer to any op. */
function fakeDaemon() {
  const frames: Record<string, unknown>[] = [];
  const answers: Record<string, (f: Record<string, unknown>) => DaemonResponse | Promise<DaemonResponse>> = {};
  const open = async (): Promise<DaemonChannel> => ({
    send: async (frame: DaemonFrame) => {
      const f = frame as unknown as Record<string, unknown>;
      frames.push(f);
      const answer = answers[String(f["op"])];
      if (answer !== undefined) return answer(f);
      if (f["op"] === "git.checkpoint") return { id: 1, ok: true, ref: `refs/wsp/checkpoints/${String(f["scope"])}/${String(f["thread"])}/${String(f["turn"])}`, commit: "c", changed: true } as DaemonResponse;
      if (f["op"] === "git.restore") return { id: 1, ok: true, before: `${String(f["checkpoint"])}-before-1`, files: 1 } as DaemonResponse;
      if (f["op"] === "git.checkpointDrop") return { id: 1, ok: true } as DaemonResponse;
      return { id: 1, ok: false, error: `no ${String(f["op"])} here` } as DaemonResponse;
    },
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { frames, answers, open };
}

function here(wire: Partial<LocalWiring> = {}) {
  const root = scratch();
  const state = join(root, "state");
  mkdirSync(state);
  const copier = gitCopier();
  const starts: HarnessStartOptions[] = [];
  const daemon = fakeDaemon();
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier,
    daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
    ...wire,
  };
  rt = createRuntime({
    backend: stubBackend(),
    store: memoryStore(),
    adapters: { claude: harness(starts), codex: harness(starts) },
    local,
    statePath: join(state, "state.json"),
    daemonChannel: daemon.open,
  });
  return { rt, copier, starts, daemon, home: state, worktrees: join(state, "worktrees"), roots: join(root, "roots") };
}

describe("a thread on a project on this computer", () => {
  it("runs in the project folder, two at once, on one record and with no copy made", async () => {
    const { rt, copier, starts } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const [a, b] = await Promise.all([rt.workspaces.folderFor({ project: project.id }), rt.workspaces.folderFor({ project: project.name })]);
    expect(a.workspace.id).toBe(b.workspace.id);
    expect(a.workspace.folder).toBe(folder);
    expect(a.workspace.worktree).toBeUndefined();
    await (await rt.sessions.start(a.workspace.id, { prompt: "hello" })).finished;
    await (await rt.sessions.start(b.workspace.id, { prompt: "hello" })).finished;
    expect(starts.map(s => s.cwd)).toEqual([folder, folder]);
    expect(copier.asks).toEqual([]);
    expect(copier.worktrees).toEqual([]);
  });

  it("hands its turn no port of its own: threads here share the person's ports", async () => {
    const { rt, starts } = here();
    const project = await rt.projects.add({ source: repo() });
    const at = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(at.workspace.id, { prompt: "hello" })).finished;
    expect(at.workspace).not.toHaveProperty("portBase");
    expect(starts).toHaveLength(1);
  });

  it("is what a create on a project here answers, whatever name it is given, twice over", async () => {
    const { rt, copier } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const one = await rt.workspaces.create({ project: project.id, name: "hello" });
    const two = await rt.workspaces.create({ project: project.id, name: "hello" });
    expect(two.id).toBe(one.id);
    expect(one.folder).toBe(folder);
    expect(copier.asks).toEqual([]);
  });

  it("answers the project folder's start under the budget, with no git asked of a start that names nothing", async () => {
    const { rt, starts } = here();
    const project = await rt.projects.add({ source: repo() });
    const at = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(at.workspace.id, { prompt: "warm" })).finished;
    const began = performance.now();
    const found = await rt.workspaces.folderFor({ project: project.id });
    const handle = await rt.sessions.start(found.workspace.id, { prompt: "hello" });
    const took = performance.now() - began;
    await handle.finished;
    expect(starts).toHaveLength(2);
    expect(took).toBeLessThan(50);
  });
});

describe("a thread on another branch", () => {
  it("runs in a worktree the copier makes under the host's folder, keyed by the project, carrying the catalogue's directories", async () => {
    const { rt, copier, starts, home, worktrees } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "feat/login" });
    expect(copier.worktrees).toEqual([{ from: folder, home, project: project.id, branch: "feat/login", carry: [...CARRIED_DIR_NAMES] }]);
    const path = join(worktrees, project.id, "feat-login");
    expect(at.workspace.worktree).toEqual({ path, branch: "feat/login", made: true });
    expect(at.workspace.folder).toBe(path);
    await (await rt.sessions.start(at.workspace.id, { prompt: "fix login" })).finished;
    expect(starts[0]!.cwd).toBe(path);
    // The same branch asked again, twice at once, is the same record.
    const [again, twice] = await Promise.all([rt.workspaces.folderFor({ project: project.id, branch: "feat/login" }), rt.workspaces.folderFor({ project: project.id, branch: "feat/login" })]);
    expect(again.workspace.id).toBe(at.workspace.id);
    expect(twice.workspace.id).toBe(at.workspace.id);
  });

  it("makes no record of the project folder to read which branch it holds", async () => {
    const { rt } = here();
    const project = await rt.projects.add({ source: repo() });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "feat/only" });
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([at.workspace.id]);
  });

  it("is refused in one sentence when the daemon binary beside this host is behind, and the binary is never run", async () => {
    const { rt, copier } = here({ hereDaemon: { version: async () => DAEMON_VERSION - 1, fix: "npm i -g @zingzy/wsp" } });
    const project = await rt.projects.add({ source: repo() });
    await expect(rt.workspaces.folderFor({ project: project.id, branch: "feat/x" })).rejects.toThrow(
      `this computer's wsp daemon is version ${DAEMON_VERSION - 1} and this wsp needs ${DAEMON_VERSION}; npm i -g @zingzy/wsp stages the right one`,
    );
    expect(copier.worktrees).toEqual([]);
  });

  it("is refused where the host found no daemon binary, and the project folder still takes threads", async () => {
    const { rt } = here({ copier: undefined });
    const project = await rt.projects.add({ source: repo() });
    await expect(rt.workspaces.folderFor({ project: project.id, branch: "feat/x" })).rejects.toThrow(NO_COPIER_HERE);
    expect((await rt.workspaces.folderFor({ project: project.id })).workspace.worktree).toBeUndefined();
  });

  it("runs in the project folder when the branch is the one the folder has checked out", async () => {
    const { rt, copier } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "main" });
    expect(at.workspace.folder).toBe(folder);
    expect(at.workspace.worktree).toBeUndefined();
    expect(copier.worktrees).toEqual([]);
  });

  it("is refused on a folder git holds no repo in, which is still a project", async () => {
    const { rt } = here();
    const folder = scratch();
    const project = await rt.projects.add({ source: folder });
    expect(project.git).toBeUndefined();
    await expect(rt.workspaces.folderFor({ project: project.id, branch: "x" })).rejects.toThrow(noBranchesLine(project.name));
    expect((await rt.workspaces.folderFor({ project: project.id })).workspace.folder).toBe(folder);
  });
});

describe("a folder a start names", () => {
  it("runs inside the project folder, and in a worktree the person made, which is recorded as not wsp's", async () => {
    const { rt } = here();
    const folder = repo();
    mkdirSync(join(folder, "src"));
    const project = await rt.projects.add({ source: folder });
    const inside = await rt.workspaces.folderFor({ project: project.id, cwd: join(folder, "src") });
    expect(inside.cwd).toBe(join(folder, "src"));
    expect(inside.workspace.worktree).toBeUndefined();
    const theirs = join(scratch(), "by-hand");
    git(folder, "worktree", "add", "-q", "-b", "by-hand", theirs);
    const there = await rt.workspaces.folderFor({ project: project.id, cwd: theirs });
    expect(there.workspace.worktree).toEqual({ path: theirs, branch: "by-hand", made: false });
    expect(there.cwd).toBe(theirs);
  });

  it("is refused outside the project and its worktrees, in one sentence", async () => {
    const { rt } = here();
    const project = await rt.projects.add({ source: repo() });
    const elsewhere = scratch();
    await expect(rt.workspaces.folderFor({ project: project.id, cwd: elsewhere })).rejects.toThrow(cwdOutsideLine(elsewhere, project.name));
  });
});

describe("a subfolder of a repo added as a project", () => {
  it("records the repo's top, and its threads run in the subfolder, in a worktree too", async () => {
    const { rt, starts, worktrees } = here();
    const top = repo();
    mkdirSync(join(top, "apps", "web"), { recursive: true });
    const project = await rt.projects.add({ source: join(top, "apps", "web") });
    expect(project.git).toEqual({ top });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "feat/web" });
    expect(at.workspace.folder).toBe(join(worktrees, project.id, "feat-web", "apps", "web"));
    const home = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(home.workspace.id, { prompt: "hi" })).finished;
    expect(starts[0]!.cwd).toBe(join(top, "apps", "web"));
  });
});

describe("a rewind in a folder threads share", () => {
  it("puts files back when no other thread ran there after the checkpoint, and only the conversation once one has", async () => {
    const { rt, daemon } = here();
    const project = await rt.projects.add({ source: repo() });
    const at = await rt.workspaces.folderFor({ project: project.id });
    const first = await rt.sessions.start(at.workspace.id, { prompt: "one" });
    await first.finished;
    const threadId = first.view().threadId!;
    const second = await rt.sessions.start(at.workspace.id, { prompt: "two", thread: threadId });
    await second.finished;
    const third = await rt.sessions.start(at.workspace.id, { prompt: "three", thread: threadId });
    await third.finished;
    await until(() => daemon.frames.filter(f => f["op"] === "git.checkpoint").length === 3);
    expect(daemon.frames.find(f => f["op"] === "git.checkpoint")).toMatchObject({ scope: at.workspace.id, thread: threadId });
    daemon.frames.length = 0;
    expect(await rt.sessions.rewind(threadId, { turnId: second.turnId, files: true })).toEqual({ turns: 1, files: 1 });
    expect(daemon.frames.filter(f => f["op"] === "git.restore")).toHaveLength(1);
    // Another thread works in the same folder after the first turn.
    await (await rt.sessions.start(at.workspace.id, { prompt: "beside" })).finished;
    daemon.frames.length = 0;
    expect(await rt.sessions.rewind(threadId, { turnId: first.turnId, files: true })).toEqual({ turns: 1, kept: REWIND_SHARED_LINE });
    expect(daemon.frames.filter(f => f["op"] === "git.restore")).toEqual([]);
  });
});

describe("a thread whose worktree is gone", () => {
  it("runs its next turn in the project folder, its transcript says so, Claude Code keeps its session and another agent opens a fresh one", async () => {
    const { rt, starts } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "feat/gone" });
    const path = at.workspace.worktree!.path;
    const claude = await rt.sessions.start(at.workspace.id, { prompt: "one", harness: "claude" });
    await claude.finished;
    const codex = await rt.sessions.start(at.workspace.id, { prompt: "one", harness: "codex" });
    await codex.finished;
    rmSync(path, { recursive: true, force: true });
    await (await rt.sessions.start(at.workspace.id, { prompt: "two", thread: claude.view().threadId! })).finished;
    await (await rt.sessions.start(at.workspace.id, { prompt: "two", thread: codex.view().threadId! })).finished;
    expect(starts.slice(2).map(s => s.cwd)).toEqual([folder, folder]);
    expect(starts[2]!.resume).toBe(claude.view().claudeSessionId);
    expect(starts[3]!.resume).toBeUndefined();
    const moved = (await rt.sessions.history(at.workspace.id)).filter(e => e.type === "session.moved");
    expect(moved).toEqual([
      expect.objectContaining({ threadId: claude.view().threadId, from: path, to: folder, branch: "feat/gone" }),
      expect.objectContaining({ threadId: codex.view().threadId, from: path, to: folder, branch: "feat/gone", fresh: true }),
    ]);
    expect(moved[0]).not.toHaveProperty("fresh");
    expect((await rt.workspaces.get(at.workspace.id)).worktree).toMatchObject({ gone: true });
  });
});

describe("removing a project whose folders hold no thread", () => {
  it("takes the records no thread names with it, a worktree wsp made too, and is refused while a thread stands", async () => {
    const { rt, copier } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const home = await rt.workspaces.folderFor({ project: project.id });
    const run = await rt.sessions.start(home.workspace.id, { prompt: "one" });
    await run.finished;
    const tree = await rt.workspaces.worktree({ project: project.id, branch: "feat/w" });
    await expect(rt.projects.remove(project.id)).rejects.toMatchObject({ message: projectInUseRefusal(project.name, [home.workspace.name]), kind: "conflict" });
    await rt.sessions.delete(run.view().threadId!);
    await rt.projects.remove(project.id);
    expect(await rt.projects.list()).toEqual([]);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(copier.worktreesRemoved.map(r => r.path)).toEqual([tree.path]);
    expect(existsSync(join(folder, ".git"))).toBe(true);
  });
});

describe("taking a folder's record away", () => {
  it("never touches the project folder, and drops its threads' checkpoints", async () => {
    const { rt, copier, daemon } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id });
    const run = await rt.sessions.start(at.workspace.id, { prompt: "one" });
    await run.finished;
    await rt.workspaces.delete(at.workspace.id);
    expect(existsSync(join(folder, ".git"))).toBe(true);
    expect(copier.worktreesRemoved).toEqual([]);
    expect(daemon.frames.filter(f => f["op"] === "git.checkpointDrop")).toEqual([{ op: "git.checkpointDrop", cwd: folder, scope: at.workspace.id, thread: run.view().threadId }]);
  });

  it("refuses a worktree wsp made while it holds a file no commit has, and removes it once clean", async () => {
    const { rt, copier, home } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "feat/keep" });
    const path = at.workspace.worktree!.path;
    writeFileSync(join(path, "notes.md"), "mine\n");
    await expect(rt.workspaces.delete(at.workspace.id)).rejects.toThrow(worktreeChangedLine(1));
    await expect(rt.workspaces.worktreeRemove({ project: project.id, branch: "feat/keep" })).rejects.toThrow(worktreeChangedLine(1));
    expect(existsSync(join(path, "notes.md"))).toBe(true);
    rmSync(join(path, "notes.md"));
    await rt.workspaces.delete(at.workspace.id);
    expect(existsSync(path)).toBe(false);
    expect(git(folder, "branch", "--list", "feat/keep")).toContain("feat/keep");
    expect(copier.worktreesRemoved).toEqual([{ from: folder, home, path, force: false }]);
  });

  it("never removes a worktree somebody else made, whatever is asked of it", async () => {
    const { rt, copier } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const theirs = join(scratch(), "theirs");
    git(folder, "worktree", "add", "-q", "-b", "theirs", theirs);
    const held = await rt.workspaces.folderFor({ project: project.id, branch: "theirs" });
    expect(held.workspace.worktree).toEqual({ path: theirs, branch: "theirs", made: false });
    await expect(rt.workspaces.worktreeRemove({ project: project.id, branch: "theirs" })).rejects.toThrow(notMadeWorktreeLine("theirs"));
    await rt.workspaces.delete(held.workspace.id);
    expect(existsSync(theirs)).toBe(true);
    expect(copier.worktreesRemoved).toEqual([]);
  });
});

describe("a second start on a pull request whose branch a worktree holds", () => {
  async function held() {
    const g = await onGitHubHere();
    const first = await g.rt.workspaces.start({ url: g.url, agent: "claude" });
    const path = first.workspace.worktree!.path;
    git(g.author, "commit", "-q", "--allow-empty", "-m", "two");
    git(g.author, "push", "-q", "origin", "feat/pr");
    return { ...g, first, path };
  }
  const behindLines = async (rt: Runtime, id: string): Promise<string[]> =>
    (await rt.sessions.history(id)).flatMap(e => (e.type === "session.behind" ? [e.text] : []));

  it("runs in that worktree, brought up to the pull request first where it is clean and only behind", async () => {
    const { rt, author, first, path } = await held();
    const second = await rt.workspaces.start({ url: "https://github.com/dev/spoo/pull/7", agent: "claude" });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(git(path, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "HEAD"));
    expect(await behindLines(rt, first.workspace.id)).toEqual([]);
  });

  it("runs there as it stands where it holds files no commit has, and the thread says how to update", async () => {
    const { rt, author, first, path } = await held();
    writeFileSync(join(path, "draft.md"), "mine\n");
    const was = git(path, "rev-parse", "HEAD");
    const second = await rt.workspaces.start({ url: "https://github.com/dev/spoo/pull/7", agent: "claude" });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(git(path, "rev-parse", "HEAD")).toBe(was);
    expect(git(path, "rev-parse", "HEAD")).not.toBe(git(author, "rev-parse", "HEAD"));
    expect(await behindLines(rt, first.workspace.id)).toEqual([PR_BEHIND_WORDS.changed(7, path)]);
  });

  it("runs in a worktree removed by hand and made again, brought up to the pull request", async () => {
    const { rt, author, first, path } = await held();
    expect(path.startsWith(tmpdir()) || path.startsWith("/private")).toBe(true);
    rmSync(path, { recursive: true, force: true });
    const second = await rt.workspaces.start({ url: "https://github.com/dev/spoo/pull/7", agent: "claude" });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(git(path, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "HEAD"));
    expect(await behindLines(rt, first.workspace.id)).toEqual([]);
  });

  it("tells a thread of a project in a subfolder that its worktree was left behind", async () => {
    const g = await onGitHubHere({ sub: "apps/web" });
    const first = await g.rt.workspaces.start({ url: g.url, agent: "claude" });
    const path = first.workspace.worktree!.path;
    git(g.author, "commit", "-q", "--allow-empty", "-m", "two");
    git(g.author, "push", "-q", "origin", "feat/pr");
    writeFileSync(join(path, "draft.md"), "mine\n");
    await g.rt.workspaces.start({ url: g.url, agent: "claude" });
    expect(await behindLines(g.rt, first.workspace.id)).toEqual([PR_BEHIND_WORDS.changed(7, path)]);
  });

  it("never moves the project folder when it holds the branch: the thread runs there as it stands, told it is behind", async () => {
    const { rt, daemon, folder, author, url, bare } = await onGitHubHere();
    git(folder, "fetch", "-q", bare, "feat/pr:feat/pr");
    git(folder, "checkout", "-q", "feat/pr");
    git(author, "commit", "-q", "--allow-empty", "-m", "two");
    git(author, "push", "-q", "origin", "feat/pr");
    const was = git(folder, "rev-parse", "HEAD");
    const started = await rt.workspaces.start({ url, agent: "claude" });
    expect(started.workspace.worktree).toBeUndefined();
    expect(git(folder, "rev-parse", "HEAD")).toBe(was);
    expect(daemon.frames.filter(f => f["op"] === "git.update")).toEqual([]);
    expect(await behindLines(rt, started.workspace.id)).toEqual([PR_BEHIND_WORDS.folder(7, folder)]);
  });

  it("runs there as it stands where its branch went another way, and the thread says how to bring them together", async () => {
    const { rt, first, path } = await held();
    git(path, "commit", "-q", "--allow-empty", "-m", "mine");
    const was = git(path, "rev-parse", "HEAD");
    const second = await rt.workspaces.start({ url: "https://github.com/dev/spoo/pull/7", agent: "claude" });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(git(path, "rev-parse", "HEAD")).toBe(was);
    expect(await behindLines(rt, first.workspace.id)).toEqual([PR_BEHIND_WORDS.diverged(7, path)]);
  });
});

/** A thread on this computer, as its turn's own token reaches the host over this computer's road. */
const asThread = (scope: ThreadScope): Caller => ({ origin: "here", by: scope });

describe("what a thread's own token reaches on this computer", () => {
  /** A person's thread in the project folder, a worktree the person made beside it, and the scope the thread's token carries. */
  async function lead() {
    const h = here();
    const folder = repo();
    const project = await h.rt.projects.add({ source: folder });
    const theirs = await h.rt.workspaces.folderFor({ project: project.id, branch: "feat/theirs" });
    const home = await h.rt.workspaces.folderFor({ project: project.id });
    const run = await h.rt.sessions.start(home.workspace.id, { prompt: "lead" });
    await run.finished;
    const threadId = run.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId, workspaceId: home.workspace.id, rootThreadId: threadId };
    return { ...h, folder, project, theirs: theirs.workspace, home: home.workspace, scope };
  }

  it("reaches the folder it runs in and the worktrees made for its tree, and never another tree's worktree", async () => {
    const { rt, project, theirs, home, scope } = await lead();
    await expect(rt.workspaces.checkout(home.id, asThread(scope))).resolves.toBeDefined();
    const child = await rt.workspaces.folderFor({ project: project.id, branch: "feat/mine" }, asThread(scope));
    const ran = await rt.sessions.start(child.workspace.id, { prompt: "child" }, asThread(scope));
    await ran.finished;
    await expect(rt.workspaces.checkout(child.workspace.id, asThread(scope))).resolves.toBeDefined();
    expect((await rt.workspaces.get(child.workspace.id)).worktree?.madeFor).toBe(scope.rootThreadId);
    // A thread working in a worktree opens threads in the project folder every thread shares, and drives nothing there.
    const side = await rt.sessions.start(theirs.id, { prompt: "the person's, on a branch" });
    await side.finished;
    const there: ThreadScope = { kind: "thread", threadId: side.view().threadId!, workspaceId: theirs.id, rootThreadId: side.view().threadId! };
    await expect(rt.workspaces.checkout(home.id, asThread(there))).rejects.toThrow();
    await (await rt.sessions.start(home.id, { prompt: "in the folder" }, asThread(there))).finished;
    await expect(rt.workspaces.checkout(theirs.id, asThread(scope))).rejects.toThrow();
    await expect(rt.sessions.start(theirs.id, { prompt: "theirs" }, asThread(scope))).rejects.toThrow();
    await expect(rt.workspaces.worktreeRemove({ project: project.id, branch: "feat/theirs" }, asThread(scope))).rejects.toThrow();
    expect(existsSync(theirs.worktree!.path)).toBe(true);
  });

  it("never removes a worktree over files no commit holds, which only the person may force", async () => {
    const { rt, project, scope } = await lead();
    const child = await rt.workspaces.folderFor({ project: project.id, branch: "feat/mine" }, asThread(scope));
    await (await rt.sessions.start(child.workspace.id, { prompt: "child" }, asThread(scope))).finished;
    writeFileSync(join(child.workspace.worktree!.path, "draft.md"), "mine\n");
    await expect(rt.workspaces.worktreeRemove({ project: project.id, branch: "feat/mine", force: true }, asThread(scope))).rejects.toThrow(WORKTREE_FORCE_LINE);
    await expect(rt.workspaces.worktreeRemove({ project: project.id, branch: "feat/mine" }, asThread(scope))).rejects.toThrow(worktreeChangedLine(1));
    expect(existsSync(join(child.workspace.worktree!.path, "draft.md"))).toBe(true);
    await rt.workspaces.worktreeRemove({ project: project.id, branch: "feat/mine", force: true });
    expect(existsSync(child.workspace.worktree!.path)).toBe(false);
  });
});

describe("the worktrees a thread asks for itself", () => {
  async function lead() {
    const h = here();
    const folder = repo();
    const project = await h.rt.projects.add({ source: folder });
    const home = await h.rt.workspaces.folderFor({ project: project.id });
    const run = await h.rt.sessions.start(home.workspace.id, { prompt: "lead" });
    await run.finished;
    const threadId = run.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId, workspaceId: home.workspace.id, rootThreadId: threadId };
    return { ...h, folder, project, scope };
  }

  it("are its tree's when it asks wsp worktree for one, so a start by its path or its branch runs there", async () => {
    const { rt, project, scope, starts } = await lead();
    const made = await rt.workspaces.worktree({ project: project.id, branch: "feat/mine" }, asThread(scope));
    const record = (await rt.workspaces.list()).find(w => w.worktree?.path === made.path)!;
    expect(record.worktree?.madeFor).toBe(scope.rootThreadId);
    const byPath = await rt.workspaces.folderFor({ project: project.id, cwd: made.path }, asThread(scope));
    expect(byPath.workspace.id).toBe(record.id);
    await (await rt.sessions.start(byPath.workspace.id, { prompt: "by path", cwd: made.path }, asThread(scope))).finished;
    const byBranch = await rt.workspaces.folderFor({ project: project.id, branch: "feat/mine" }, asThread(scope));
    expect(byBranch.workspace.id).toBe(record.id);
    await (await rt.sessions.start(byBranch.workspace.id, { prompt: "by branch" }, asThread(scope))).finished;
    expect(starts.slice(1).map(s => s.cwd)).toEqual([made.path, made.path]);
  });

  it("are its tree's when it made one with plain git worktree add and starts a thread there by its path", async () => {
    const { rt, project, scope, starts } = await lead();
    const plain = join(scratch(), "plain");
    git(project.path, "worktree", "add", "-q", "-b", "feat/plain", plain);
    const at = await rt.workspaces.folderFor({ project: project.id, cwd: plain }, asThread(scope));
    expect(at.workspace.worktree).toMatchObject({ path: plain, made: false, madeFor: scope.rootThreadId });
    await (await rt.sessions.start(at.workspace.id, { prompt: "in my own", cwd: plain }, asThread(scope))).finished;
    expect(starts.at(-1)!.cwd).toBe(plain);
  });

  it("stay its tree's when one is removed by hand and made again", async () => {
    const { rt, project, scope } = await lead();
    const first = await rt.workspaces.folderFor({ project: project.id, branch: "feat/again" }, asThread(scope));
    const path = first.workspace.worktree!.path;
    git(project.path, "worktree", "remove", "--force", path);
    const again = await rt.workspaces.folderFor({ project: project.id, branch: "feat/again" }, asThread(scope));
    expect(again.workspace.id).toBe(first.workspace.id);
    expect(again.workspace.worktree?.madeFor).toBe(scope.rootThreadId);
    await expect(rt.workspaces.checkout(again.workspace.id, asThread(scope))).resolves.toBeDefined();
    await (await rt.sessions.start(again.workspace.id, { prompt: "again" }, asThread(scope))).finished;
  });
});

describe("a worktree removed by hand before any thread ran in it", () => {
  it("takes its first thread in the project folder with the moved line, and keeps the record and the thread", async () => {
    const { rt, starts } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const made = await rt.workspaces.worktree({ project: project.id, branch: "feat/bare" });
    const record = (await rt.workspaces.list()).find(w => w.worktree?.path === made.path)!;
    rmSync(made.path, { recursive: true, force: true });
    const run = await rt.sessions.start(record.id, { prompt: "hello" });
    await run.finished;
    expect(starts.map(s => s.cwd)).toEqual([folder]);
    expect((await rt.workspaces.list()).find(w => w.id === record.id)?.worktree).toMatchObject({ gone: true });
    expect((await rt.sessions.list()).map(t => t.threadId)).toContain(run.view().threadId);
    const moved = (await rt.sessions.history(record.id)).filter(e => e.type === "session.moved");
    expect(moved).toEqual([expect.objectContaining({ threadId: run.view().threadId, from: made.path, to: folder, branch: "feat/bare" })]);
  });
});

describe("deleting a thread that runs in a worktree wsp made", () => {
  it("is refused while a turn runs there, and once it ended takes the worktree and the thread's checkpoint refs", async () => {
    const { rt, copier, daemon } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id, branch: "feat/busy" });
    holding.on = true;
    const run = await rt.sessions.start(at.workspace.id, { prompt: "working" });
    const threadId = run.view().threadId!;
    await expect(rt.sessions.delete(threadId)).rejects.toThrow(WORKTREE_BUSY_LINE);
    expect(existsSync(at.workspace.worktree!.path)).toBe(true);
    holding.on = false;
    holding.waiting.splice(0).forEach(go => go());
    await run.finished;
    await until(() => daemon.frames.some(f => f["op"] === "git.checkpoint"));
    await rt.sessions.delete(threadId);
    expect(copier.worktreesRemoved.map(r => r.path)).toEqual([at.workspace.worktree!.path]);
    expect(daemon.frames.filter(f => f["op"] === "git.checkpointDrop")).toEqual([expect.objectContaining({ scope: at.workspace.id, thread: threadId })]);
  });
});

describe("deleting a thread whose last checkpoint is still being written", () => {
  it("waits for the checkpoint to land before it drops the thread's refs", async () => {
    const { rt, daemon } = here();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id });
    let land = (): void => {};
    const landing = new Promise<void>(go => (land = go));
    daemon.answers["git.checkpoint"] = async f => {
      await landing;
      daemon.frames.push({ op: "checkpoint landed" });
      return { id: 1, ok: true, ref: `refs/wsp/checkpoints/${String(f["scope"])}/${String(f["thread"])}/${String(f["turn"])}`, commit: "c", changed: true } as DaemonResponse;
    };
    const run = await rt.sessions.start(at.workspace.id, { prompt: "one" });
    await run.finished;
    await until(() => daemon.frames.some(f => f["op"] === "git.checkpoint"));
    const deleting = rt.sessions.delete(run.view().threadId!);
    await new Promise(r => setTimeout(r, 20));
    land();
    await deleting;
    const ops = daemon.frames.map(f => f["op"]);
    expect(ops.indexOf("checkpoint landed")).toBeGreaterThan(-1);
    expect(ops.indexOf("git.checkpointDrop")).toBeGreaterThan(ops.indexOf("checkpoint landed"));
  });
});

/** Whether the daemon fake's roots file lists a folder at or above this one, as the daemon resolves a frame's folder. */
const inRoots = (roots: string, cwd: string): boolean =>
  existsSync(roots) && readFileSync(roots, "utf8").split("\n").some(root => root !== "" && (cwd === root || cwd.startsWith(`${root}/`)));

/** A project whose origin is a GitHub repository, served from a bare repo here by this computer's daemon fake. */
async function onGitHubHere(o: { sub?: string } = {}) {
  const h = here();
  const root = scratch();
  const bare = join(root, "spoo.git");
  const folder = join(root, "spoo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, folder]);
  git(folder, "commit", "-q", "--allow-empty", "-m", "first");
  git(folder, "push", "-q", "origin", "main");
  const author = join(root, "author");
  execFileSync("git", ["clone", "-q", bare, author]);
  git(author, "checkout", "-q", "-b", "feat/pr");
  git(author, "commit", "-q", "--allow-empty", "-m", "one");
  git(author, "push", "-q", "origin", "feat/pr");
  if (o.sub !== undefined) {
    mkdirSync(join(folder, o.sub), { recursive: true });
    writeFileSync(join(folder, o.sub, "README.md"), "sub\n");
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "sub");
    git(folder, "push", "-q", "origin", "main");
    git(author, "pull", "-q", "--rebase", "origin", "main");
    git(author, "push", "-q", "-f", "origin", "feat/pr");
  }
  git(folder, "remote", "set-url", "origin", "https://github.com/dev/spoo.git");
  const url = "https://github.com/dev/spoo/pull/7";
  const fact: PullRequest = { number: 7, url, state: "open", host: "github.com", draft: false, base: "main", branch: "feat/pr", headOid: "a".repeat(40), headSubject: "one", mergeable: "mergeable", mergeState: "clean", review: "none", checks: [], additions: 0, deletions: 0, changedFiles: 0, commits: 1 };
  h.daemon.answers["git.prRead"] = () => ({ id: 1, ok: true, pr: fact }) as DaemonResponse;
  h.daemon.answers["git.issueRead"] = () => ({ id: 1, ok: true, issue: { number: 7, url, title: "one", body: "", state: "OPEN", comments: [] } }) as DaemonResponse;
  h.daemon.answers["git.fetchBranch"] = f => {
    if (!inRoots(h.roots, String(f["cwd"]))) return { id: 1, ok: false, code: "outside-root", error: `${String(f["cwd"])} resolves outside the workspace root` } as DaemonResponse;
    const into = String(f["into"] ?? f["branch"]);
    try {
      git(String(f["cwd"]), "fetch", "-q", "--no-tags", String(f["remote"]), `refs/heads/${String(f["branch"])}:refs/heads/${into}`);
    } catch (e) {
      return { id: 1, ok: false, error: e instanceof Error ? e.message : String(e) } as DaemonResponse;
    }
    return { id: 1, ok: true, branch: into, oid: git(String(f["cwd"]), "rev-parse", `refs/heads/${into}`) } as DaemonResponse;
  };
  h.daemon.answers["git.update"] = f => {
    const cwd = String(f["cwd"]);
    if (!inRoots(h.roots, cwd)) return { id: 1, ok: false, code: "outside-root", error: `${cwd} resolves outside the workspace root` } as DaemonResponse;
    git(cwd, "fetch", "-q", "--no-tags", "origin", `refs/heads/${String(f["base"])}`);
    git(cwd, "merge", "-q", "--ff-only", "FETCH_HEAD");
    return { id: 1, ok: true, base: String(f["base"]), merged: true, commits: 1, conflicts: [] } as DaemonResponse;
  };
  const project = await h.rt.projects.add({ source: o.sub === undefined ? folder : join(folder, o.sub) });
  // Once the project holds its GitHub address, that address reads the bare repo here, for this computer's git and
  // the daemon fake's alike.
  git(folder, "config", `url.${bare}.insteadOf`, "https://github.com/dev/spoo.git");
  return { ...h, folder, author, project, url, bare };
}

describe("a pull request's head", () => {
  it("of a merged pull request whose branch was deleted is still fetched, off the pull request's own head", async () => {
    const { rt, author, url, bare } = await onGitHubHere();
    const tip = git(author, "rev-parse", "HEAD");
    git(bare, "update-ref", "refs/pull/7/head", tip);
    git(bare, "update-ref", "-d", "refs/heads/feat/pr");
    const started = await rt.workspaces.start({ url, agent: "claude" });
    expect(git(started.workspace.worktree!.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("is refused for a pick the agent does not take before any worktree is made", async () => {
    const { rt, copier, url } = await onGitHubHere();
    await expect(rt.workspaces.start({ url, agent: "claude", model: "no-such-model" })).rejects.toThrow();
    expect(copier.worktrees).toEqual([]);
  });

  it("is fetched through the daemon at every start, so a second start runs on what the author pushed since", async () => {
    const { rt, daemon, folder, author, project, url } = await onGitHubHere();
    const first = await rt.workspaces.start({ url, agent: "claude" });
    const path = first.workspace.worktree!.path;
    expect(git(path, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "HEAD"));
    await rt.workspaces.worktreeRemove({ project: project.id, branch: "feat/pr" });
    git(author, "commit", "-q", "--allow-empty", "-m", "two");
    git(author, "push", "-q", "origin", "feat/pr");
    const second = await rt.workspaces.start({ url, agent: "claude" });
    expect(git(second.workspace.worktree!.path, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "HEAD"));
    expect(daemon.frames.filter(f => f["op"] === "git.fetchBranch")).toEqual([
      expect.objectContaining({ cwd: folder, remote: "https://github.com/dev/spoo.git", branch: "feat/pr" }),
      expect.objectContaining({ cwd: folder, remote: "https://github.com/dev/spoo.git", branch: "feat/pr" }),
    ]);
  });
});

/** Waits for a condition the runtime reaches after a turn's end, without a fixed sleep. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5));
  expect(done()).toBe(true);
}

