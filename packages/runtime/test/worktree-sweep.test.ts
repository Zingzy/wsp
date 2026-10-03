// SPDX-License-Identifier: AGPL-3.0-only
// The one sweep of the worktrees wsp made. A worktree settles when its pull
// request merged or closed, when the branch it pushed is gone at the remote,
// or when the person removed it; a settled one goes once six hours have
// passed with nothing uncommitted and no turn running, and says why it stays
// otherwise. A branch never pushed, a repo with no remote and a worktree the
// person made are never touched. git is real; the copier removes as the daemon
// binary's verb does, and the daemon answers the branch and the pull request.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { KEPT_ABANDONED_LINE, KEPT_RUNNING_LINE, keptChangedLine, type AdapterEvent, type DaemonFrame, type DaemonResponse, type PullRequest, type TurnResult, type WorkspaceView } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { gitCopier } from "./git-copier.js";
import { stubBackend, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

const SWEEP = 10 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const roots: string[] = [];
let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-sweep-")));
  roots.push(root);
  return root;
};

/** A project folder cloned from a bare origin, or with no remote at all. */
function project(o: { remote?: boolean } = {}): { folder: string; origin?: string } {
  const root = scratch();
  const folder = join(root, "spoo");
  if (o.remote === false) {
    mkdirSync(folder);
    git(folder, "init", "-q", "-b", "main");
    git(folder, "commit", "-q", "--allow-empty", "-m", "first");
    return { folder };
  }
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, folder]);
  git(folder, "commit", "-q", "--allow-empty", "-m", "first");
  git(folder, "push", "-q", "origin", "main");
  return { folder, origin };
}

const pr = (branch: string, state: PullRequest["state"]): PullRequest => ({
  number: 7,
  url: "https://github.com/dev/spoo/pull/7",
  state,
  host: "github.com",
  draft: false,
  base: "main",
  branch,
  headOid: "a".repeat(40),
  headSubject: "the work",
  mergeable: "mergeable",
  mergeState: "clean",
  review: "none",
  checks: [],
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
});

/** This computer's daemon: the branch a folder has checked out, read with git, and the pull request of a branch as the
 * test sets it; every frame noted. */
function daemon() {
  const prs = new Map<string, PullRequest>();
  const frames: Record<string, unknown>[] = [];
  const open = async (): Promise<DaemonChannel> => ({
    send: async (frame: DaemonFrame) => {
      const f = frame as unknown as Record<string, unknown>;
      frames.push(f);
      if (f["op"] === "git.status") {
        const head = git(String(f["cwd"]), "symbolic-ref", "--short", "HEAD");
        return { id: 1, ok: true, branch: { oid: git(String(f["cwd"]), "rev-parse", "HEAD"), head, ahead: 0, behind: 0 }, entries: [], root: String(f["cwd"]) } as DaemonResponse;
      }
      if (f["op"] === "git.prRead") return { id: 1, ok: true, ...(prs.has(String(f["branch"])) ? { pr: prs.get(String(f["branch"])) } : {}) } as DaemonResponse;
      if (f["op"] === "git.checkpoint") return { id: 1, ok: true, ref: "refs/wsp/checkpoints/x", commit: "c", changed: false } as DaemonResponse;
      return { id: 1, ok: false, error: `no ${String(f["op"])} here` } as DaemonResponse;
    },
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { prs, frames, open };
}

/** A harness whose turns end at once, or stay running until the test lets them go. */
function harness(o: { hold?: boolean } = {}): { factory: HarnessAdapterFactory; release: () => void } {
  const waiting: (() => void)[] = [];
  let n = 0;
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    start: s => {
      n += 1;
      const sessionId = `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (o.hold === true ? new Promise<void>(done => waiting.push(done)) : Promise.resolve()).then(() => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) s.onEvent(e);
        return result;
      });
      s.onEvent({ type: "session.start", sessionId });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { factory, release: () => waiting.splice(0).forEach(done => done()) };
}

function host(o: { hold?: boolean; copier?: ReturnType<typeof gitCopier> } = {}) {
  const root = scratch();
  const state = join(root, "state");
  mkdirSync(state);
  const copier = o.copier ?? gitCopier();
  const d = daemon();
  const time = fakeClock(Date.UTC(2026, 9, 1, 12));
  const agent = harness({ hold: o.hold === true });
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: x => localExecStream({ root, runDir: join(root, "runs"), ...x }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier,
    daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
  };
  rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: agent.factory }, local, statePath: join(state, "state.json"), daemonChannel: d.open, clock: time.clock });
  return { rt, copier, daemon: d, time, agent };
}

/** The worktree record a branch start lands on, with one thread run in it so the record outlives its folder. */
async function worktreeWithThread(h: ReturnType<typeof host>, folder: string, branch: string, o: { wait?: boolean } = {}): Promise<WorkspaceView> {
  const added = await h.rt.projects.add({ source: folder });
  const at = await h.rt.workspaces.folderFor({ project: added.id, branch });
  const turn = await h.rt.sessions.start(at.workspace.id, { prompt: "work" });
  if (o.wait !== false) await turn.finished;
  return at.workspace;
}

const recordOf = async (h: ReturnType<typeof host>, id: string): Promise<WorkspaceView | undefined> => (await h.rt.workspaces.list()).find(w => w.id === id);

/** The clock moved on by ms, then one sweep run there and waited out, and done holding after it. A sweep arms the next
 * one only once it is over, so a long move runs one sweep on the way and the one that counts runs where it stands. */
async function sweep(h: ReturnType<typeof host>, ms: number, done: () => boolean | Promise<boolean>): Promise<void> {
  await later(h, ms);
  await later(h, SWEEP);
  await until(done, 3_000);
}

/** The clock moved on by ms, and whatever sweep that ran waited out. */
async function later(h: ReturnType<typeof host>, ms: number): Promise<void> {
  h.time.advance(ms);
  await until(() => h.time.dueFor(h.time.clock.now() + SWEEP), 3_000);
}

describe("the sweep of worktrees wsp made", () => {
  it("removes one whose pull request merged once six hours have passed, clean and with no turn running", async () => {
    const h = host();
    const { folder } = project();
    const made = await worktreeWithThread(h, folder, "feat/x");
    const path = made.worktree!.path;
    h.daemon.prs.set("feat/x", pr("feat/x", "merged"));
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.settled !== undefined);
    expect((await recordOf(h, made.id))!.worktree!.settled!.why).toBe("merged");
    expect(existsSync(path)).toBe(true);
    await sweep(h, 6 * HOUR, async () => (await recordOf(h, made.id))?.worktree?.gone === true);
    expect(existsSync(path)).toBe(false);
    expect(h.copier.worktreesRemoved.map(r => r.path)).toEqual([path]);
    expect(git(folder, "branch", "--list", "feat/x")).not.toBe("");
  });

  it("keeps a settled one with a file no commit holds, and says how many", async () => {
    const h = host();
    const { folder } = project();
    const made = await worktreeWithThread(h, folder, "feat/x");
    h.daemon.prs.set("feat/x", pr("feat/x", "closed"));
    writeFileSync(join(made.worktree!.path, "draft.md"), "mine\n");
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.settled !== undefined);
    await sweep(h, 6 * HOUR, async () => (await recordOf(h, made.id))?.worktree?.kept !== undefined);
    expect((await recordOf(h, made.id))!.worktree!.kept).toBe(keptChangedLine(1));
    expect(existsSync(join(made.worktree!.path, "draft.md"))).toBe(true);
    expect(h.copier.worktreesRemoved).toEqual([]);
  });

  it("keeps a settled one while a turn runs in it", async () => {
    const h = host({ hold: true });
    const { folder } = project();
    const made = await worktreeWithThread(h, folder, "feat/x", { wait: false });
    h.daemon.prs.set("feat/x", pr("feat/x", "merged"));
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.settled !== undefined);
    await sweep(h, 6 * HOUR, async () => (await recordOf(h, made.id))?.worktree?.kept !== undefined);
    expect((await recordOf(h, made.id))!.worktree!.kept).toBe(KEPT_RUNNING_LINE);
    expect(existsSync(made.worktree!.path)).toBe(true);
    h.agent.release();
  });

  it("marks git's refusal, and clears it once the person removed the worktree by hand", async () => {
    const copier = gitCopier();
    const h = host({
      copier: {
        ...copier,
        async worktreeRemove(o) {
          copier.worktreesRemoved.push(o);
          throw new Error(`fatal: '${o.path}' is locked; use 'unlock' to override`);
        },
      },
    });
    const { folder } = project();
    const made = await worktreeWithThread(h, folder, "feat/x");
    const path = made.worktree!.path;
    h.daemon.prs.set("feat/x", pr("feat/x", "merged"));
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.settled !== undefined);
    await sweep(h, 6 * HOUR, async () => (await recordOf(h, made.id))?.worktree?.removeFailed !== undefined);
    const refused = (await recordOf(h, made.id))!.worktree!;
    expect(refused.removeFailed).toBe(`fatal: '${path}' is locked; use 'unlock' to override`);
    expect(refused.kept).toBeUndefined();
    rmSync(path, { recursive: true, force: true });
    git(folder, "worktree", "prune");
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.gone === true);
    const after = (await recordOf(h, made.id))!.worktree!;
    expect(after.removeFailed).toBeUndefined();
    expect(after.kept).toBeUndefined();
  });

  it("leaves one it could not remove for seven days to the person, and stops trying", async () => {
    const h = host();
    const { folder } = project();
    const made = await worktreeWithThread(h, folder, "feat/x");
    h.daemon.prs.set("feat/x", pr("feat/x", "merged"));
    writeFileSync(join(made.worktree!.path, "draft.md"), "mine\n");
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.settled !== undefined);
    await sweep(h, 7 * DAY, async () => (await recordOf(h, made.id))?.worktree?.kept === KEPT_ABANDONED_LINE);
    rmSync(join(made.worktree!.path, "draft.md"));
    await later(h, SWEEP);
    await later(h, SWEEP);
    expect(existsSync(made.worktree!.path)).toBe(true);
    expect((await recordOf(h, made.id))!.worktree!.kept).toBe(KEPT_ABANDONED_LINE);
    expect(h.copier.worktreesRemoved).toEqual([]);
  });

  it("settles a pushed branch the remote no longer has, and removes it six hours on", async () => {
    const h = host();
    const { folder, origin } = project();
    const made = await worktreeWithThread(h, folder, "feat/x");
    git(made.worktree!.path, "push", "-q", "-u", "origin", "feat/x");
    git(origin!, "branch", "-D", "feat/x");
    await sweep(h, 0, async () => (await recordOf(h, made.id))?.worktree?.settled !== undefined);
    expect((await recordOf(h, made.id))!.worktree!.settled!.why).toBe("deleted");
    await sweep(h, 6 * HOUR, async () => (await recordOf(h, made.id))?.worktree?.gone === true);
    expect(existsSync(made.worktree!.path)).toBe(false);
  });

  it("never settles a branch that was never pushed", async () => {
    const h = host();
    const { folder } = project();
    const made = await worktreeWithThread(h, folder, "feat/x");
    await later(h, 8 * DAY);
    await later(h, SWEEP);
    const held = (await recordOf(h, made.id))!.worktree!;
    expect(held.settled).toBeUndefined();
    expect(held.kept).toBeUndefined();
    expect(existsSync(held.path)).toBe(true);
  });

  it("never settles a worktree of a repo with no remote, and asks no host about it", async () => {
    const h = host();
    const { folder } = project({ remote: false });
    const made = await worktreeWithThread(h, folder, "feat/x");
    await later(h, 8 * DAY);
    await later(h, SWEEP);
    const held = (await recordOf(h, made.id))!.worktree!;
    expect(held.settled).toBeUndefined();
    expect(existsSync(held.path)).toBe(true);
    expect(h.daemon.frames.filter(f => f["op"] === "git.prRead")).toEqual([]);
  });

  it("never removes a worktree the person made, merged pull request and all, and gives it no kept line", async () => {
    const h = host();
    const { folder } = project();
    const mine = join(scratch(), "mine");
    git(folder, "worktree", "add", "-q", "-b", "feat/y", mine);
    h.daemon.prs.set("feat/y", pr("feat/y", "merged"));
    const made = await worktreeWithThread(h, folder, "feat/y");
    expect(made.worktree).toMatchObject({ path: mine, made: false });
    await later(h, 8 * DAY);
    await later(h, SWEEP);
    const held = (await recordOf(h, made.id))!.worktree!;
    expect(existsSync(mine)).toBe(true);
    expect(held).toEqual({ path: mine, branch: "feat/y", made: false });
    expect(h.copier.worktreesRemoved).toEqual([]);
  });

  it("reads the pull request of a worktree no thread ever ran in", async () => {
    const h = host();
    const { folder } = project();
    const added = await h.rt.projects.add({ source: folder });
    await h.rt.workspaces.worktree({ project: added.id, branch: "feat/z" });
    await sweep(h, 0, () => h.daemon.frames.some(f => f["op"] === "git.prRead" && f["branch"] === "feat/z"));
  });
});
