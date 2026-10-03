// SPDX-License-Identifier: AGPL-3.0-only
// A thread on this computer runs in the project folder; another branch runs
// it in a worktree of the project's repo. What is proved here is the record a
// start lands on, the folder its turn is handed, what the copier is asked for,
// what a rewind may move in a folder threads share, and where a thread goes
// once its worktree is gone. The copier and the daemon are fakes; git is real.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  type AdapterEvent,
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
  await rt?.close();
  rt = undefined;
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** A harness that answers each turn at once and records what it was started with. A resume keeps its session, and
 * every new one is numbered on the one count the harnesses share, so no two threads hold one session. */
let n = 0;
function harness(starts: HarnessStartOptions[]): HarnessAdapterFactory {
  return () => ({
    steers: false,
    resumesAt: true,
    start: o => {
      n += 1;
      starts.push(o);
      const sessionId = o.resume ?? `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
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

/** A daemon that takes checkpoints and restores, recording every frame. */
function fakeDaemon() {
  const frames: Record<string, unknown>[] = [];
  const open = async (): Promise<DaemonChannel> => ({
    send: async (frame: DaemonFrame) => {
      const f = frame as unknown as Record<string, unknown>;
      frames.push(f);
      if (f["op"] === "git.checkpoint") return { id: 1, ok: true, ref: `refs/wsp/checkpoints/${String(f["scope"])}/${String(f["thread"])}/${String(f["turn"])}`, commit: "c", changed: true } as DaemonResponse;
      if (f["op"] === "git.restore") return { id: 1, ok: true, before: `${String(f["checkpoint"])}-before-1`, files: 1 } as DaemonResponse;
      if (f["op"] === "git.checkpointDrop") return { id: 1, ok: true } as DaemonResponse;
      return { id: 1, ok: false, error: `no ${String(f["op"])} here` } as DaemonResponse;
    },
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { frames, open };
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
  return { rt, copier, starts, daemon, home: state, worktrees: join(state, "worktrees") };
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

/** Waits for a condition the runtime reaches after a turn's end, without a fixed sleep. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5));
  expect(done()).toBe(true);
}

