// SPDX-License-Identifier: AGPL-3.0-only
// A turn an agent's usage limit stopped, on a thread on this computer: the
// row carries the limit, Resume at reset arms on the thread's record and
// outlives a restart, and at the reset the stopped turn goes on, unless by then
// the thread was settled or deleted, a newer turn ran, something on it waits
// on the person, or the plan's latest reading still holds the agent. Cancel
// takes the arm back. The harness and the daemon are fakes; git is real.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { foldThreads, LIMIT_RESUME_PROMPT, type AdapterEvent, type DaemonFrame, type DaemonResponse, type HarnessLimit, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { gitCopier } from "./git-copier.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

const HOUR = 3_600_000;
/** How one turn goes: stopped at the limit with its reset (null where the agent named none), stopped and then asking
 * with its process still up, or done; reading is the plan as the turn reports it. */
type Plan = { limit?: number | null; asks?: true; reading?: HarnessLimit };

/** A harness that runs each turn by the next plan in the list, done once the list is spent, and records each start.
 * A resume keeps its session. */
function harness(starts: HarnessStartOptions[], plans: Plan[]): HarnessAdapterFactory {
  let n = 0;
  return () => ({
    steers: false,
    start: o => {
      n += 1;
      starts.push(o);
      const sessionId = o.resume ?? `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
      const plan = plans.shift() ?? {};
      const result: TurnResult =
        plan.limit !== undefined ? { status: "failed", error: "You've hit your limit · resets 1pm", limit: plan.limit === null ? {} : { resetsAt: plan.limit } } : { status: "completed", text: "ok" };
      const feed: AdapterEvent[] = [
        { type: "session.start", sessionId },
        ...(plan.reading !== undefined ? [{ type: "limit" as const, sessionId, limit: plan.reading }] : []),
        { type: "turn.done", sessionId, result },
        ...(plan.asks === true
          ? [{ type: "permission.ask" as const, sessionId, ask: { askId: "ask_1", toolName: "Bash", input: '{"command":"ls"}', options: [{ id: "allow", label: "Allow", effect: "allow" as const }] } }]
          : [{ type: "session.end" as const, sessionId, exitCode: plan.limit !== undefined ? 1 : 0, sawResult: true }]),
      ];
      const finished = Promise.resolve().then(() => {
        for (const e of feed) o.onEvent(e);
        return plan.asks === true ? new Promise<TurnResult>(() => {}) : result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

const daemon = async (): Promise<DaemonChannel> => ({
  send: async (frame: DaemonFrame) => {
    const f = frame as unknown as Record<string, unknown>;
    if (f["op"] === "git.checkpoint") return { id: 1, ok: true, ref: `refs/wsp/checkpoints/x/${String(f["thread"])}/${String(f["turn"])}`, commit: "c", changed: true } as DaemonResponse;
    return { id: 1, ok: true } as DaemonResponse;
  },
  close: () => {},
  closed: new Promise(() => {}),
});

/** A runtime with a project folder on this computer, on a clock the test moves; `again` is the same state served by a
 * second runtime, which is a host restart. */
async function here(plans: Plan[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-limit-resume-")));
  roots.push(root);
  const folder = join(root, "repo");
  mkdirSync(folder);
  execFileSync("git", ["-C", folder, "init", "-q", "-b", "main"], { env: GIT_ENV });
  execFileSync("git", ["-C", folder, "commit", "-q", "--allow-empty", "-m", "first"], { env: GIT_ENV });
  const store: Store = memoryStore();
  const { clock, advance } = fakeClock();
  const starts: HarnessStartOptions[] = [];
  const adapters = { claude: harness(starts, plans) };
  const open = (): Runtime => {
    const rt = createRuntime({
      backend: stubBackend(),
      store,
      clock,
      adapters,
      local: {
        backend: new LocalBackend({ root }),
        execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
        home: () => join(root, ".claude"),
        homeDir: root,
        rootsPath: join(root, "roots"),
        env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
        platform: testPlatform(),
        copier: gitCopier(),
        daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
      },
      daemonChannel: daemon,
    });
    runtimes.push(rt);
    return rt;
  };
  const rt = open();
  const project = await rt.projects.add({ source: folder });
  const { workspace } = await rt.workspaces.folderFor({ project: project.id });
  const first = await rt.sessions.start(workspace.id, { prompt: "fix the flaky test" });
  const threadId = first.view().threadId!;
  const thread = async (on: Runtime = rt) => foldThreads(await on.sessions.list(workspace.id)).find(t => t.id === threadId)!;
  // A turn left asking never ends, so the wait is for its result to be on the row.
  for (let i = 0; i < 200 && (await thread()).status === "running" && (await thread()).limit === undefined; i++) await settled();
  await settled();
  /** The turns that went on after a reset: each start that handed the agent Resume at reset's words. */
  const resumed = () => starts.filter(s => s.prompt === LIMIT_RESUME_PROMPT);
  return { rt, open, clock, advance, starts, resumed, workspaceId: workspace.id, threadId, thread };
}

const settled = () => new Promise(resolve => setTimeout(resolve, 20));

describe("a turn stopped at the agent's usage limit", () => {
  it("rides the row and the thread with its reset, and its failure stays the agent's words in the result", async () => {
    const reset = Date.now() + 2 * HOUR;
    const t = await here([{ limit: reset }]);
    const view = await t.thread();
    expect(view).toMatchObject({ status: "failed", limit: { resetsAt: reset } });
    expect(view).not.toHaveProperty("resumeAt");
  });

  it("arms Resume at reset on the thread, which outlives a restart and goes on with the turn at the reset", async () => {
    const reset = Date.now() + 2 * HOUR;
    const t = await here([{ limit: reset }]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect(await t.thread()).toMatchObject({ limit: { resetsAt: reset }, resumeAt: reset });
    await t.rt.close();

    const again = t.open();
    expect(await t.thread(again)).toMatchObject({ resumeAt: reset });
    t.advance(reset - t.clock.now() - 1);
    await settled();
    expect(t.resumed()).toHaveLength(0);
    t.advance(1);
    await settled();
    expect(t.resumed()).toHaveLength(1);
    expect(t.resumed()[0]!.resume).toBeDefined();
    const starts = (await again.sessions.history(t.workspaceId)).filter((e): e is Extract<SessionEvent, { type: "session.start" }> => e.type === "session.start");
    expect(starts.at(-1)).toMatchObject({ threadId: t.threadId, afterLimit: reset, prompt: LIMIT_RESUME_PROMPT });
    const after = await t.thread(again);
    expect(after.status).toBe("completed");
    expect(after).not.toHaveProperty("resumeAt");
    expect(after).not.toHaveProperty("limit");
  });

  it("is refused an arm where the agent named no reset", async () => {
    const t = await here([{ limit: null }]);
    expect((await t.thread()).limit).toEqual({});
    await expect(t.rt.sessions.mark([t.threadId], { resumeAtReset: true })).rejects.toMatchObject({ kind: "usage" });
  });

  it("Cancel takes the arm back, and the reset sends nothing", async () => {
    const reset = Date.now() + HOUR;
    const t = await here([{ limit: reset }]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect((await t.thread()).resumeAt).toBe(reset);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: false });
    expect(await t.thread()).not.toHaveProperty("resumeAt");
    t.advance(2 * HOUR);
    await settled();
    expect(t.resumed()).toEqual([]);
  });
});

describe("Resume at reset sends nothing at the reset", () => {
  it("once the thread was settled", async () => {
    const reset = Date.now() + HOUR;
    const t = await here([{ limit: reset }]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect((await t.thread()).resumeAt).toBe(reset);
    await t.rt.sessions.settle([t.threadId]);
    t.advance(HOUR);
    await settled();
    expect(t.resumed()).toEqual([]);
    expect(await t.thread()).not.toHaveProperty("resumeAt");
  });

  it("once the thread was deleted", async () => {
    const reset = Date.now() + HOUR;
    const t = await here([{ limit: reset }]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect((await t.thread()).resumeAt).toBe(reset);
    await t.rt.sessions.delete(t.threadId);
    t.advance(HOUR);
    await settled();
    expect(t.resumed()).toEqual([]);
    expect(t.starts).toHaveLength(1);
  });

  it("once a newer turn was sent, even one the limit stopped again, and the newer turn takes the arm off", async () => {
    const reset = Date.now() + HOUR;
    const t = await here([{ limit: reset }, { limit: reset + HOUR }]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect((await t.thread()).resumeAt).toBe(reset);
    await (await t.rt.sessions.start(t.workspaceId, { prompt: "try the other test first", thread: t.threadId })).finished;
    expect(await t.thread()).toMatchObject({ limit: { resetsAt: reset + HOUR } });
    expect(await t.thread()).not.toHaveProperty("resumeAt");
    t.advance(2 * HOUR);
    await settled();
    expect(t.resumed()).toEqual([]);
    expect(t.starts.map(s => s.prompt)).toEqual(["fix the flaky test", "try the other test first"]);
  });

  it("while a prompt on the thread waits on the person", async () => {
    const reset = Date.now() + HOUR;
    const t = await here([{ limit: reset, asks: true }]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect((await t.thread()).resumeAt).toBe(reset);
    expect((await t.thread()).asking).toBeDefined();
    const queued: unknown[] = [];
    t.rt.events.on("session.queued", e => queued.push(e));
    t.advance(HOUR);
    await settled();
    expect(queued).toEqual([]);
    expect(t.resumed()).toEqual([]);
    expect(await t.thread()).not.toHaveProperty("resumeAt");
  });

  it("where the plan's latest reading moved the reset later, and the row takes the new reset", async () => {
    const reset = Date.now() + HOUR;
    const later = reset + 24 * HOUR;
    const t = await here([
      { limit: reset, reading: { windows: [{ kind: "session", usedPercent: 100, resetsAt: reset }], status: "reached" } },
      { reading: { windows: [{ kind: "session", usedPercent: 100, resetsAt: reset }, { kind: "week", usedPercent: 100, resetsAt: later }], status: "reached" } },
    ]);
    await t.rt.sessions.mark([t.threadId], { resumeAtReset: true });
    expect((await t.thread()).resumeAt).toBe(reset);
    // Another thread on the same account reads the plan again: the week ran out too.
    await (await t.rt.sessions.start(t.workspaceId, { prompt: "a side job" })).finished;
    await settled();
    t.advance(HOUR);
    await settled();
    expect(t.resumed()).toEqual([]);
    const view = await t.thread();
    expect(view).not.toHaveProperty("resumeAt");
    expect(view.limit).toEqual({ resetsAt: later });
  });
});
