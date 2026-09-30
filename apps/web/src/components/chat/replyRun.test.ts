// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { PTY_RUN_DAEMON_VERSION, type RunStep, type SessionRunEvent } from "@wsp/protocol";
import type { RunExit, RunOpts } from "../../terminal/link.js";
import { useTerminalDrawerStore } from "../../terminal/drawerStore.js";
import { heldPty, moveRun, resumeRun, runDaemonBehindLine, startRun, takeFocus, type RunDeps, type RunTarget } from "./replyRun.js";

/** A terminal model for one workspace that runs nothing: each run's exit and output are the test's to give. */
function fakeTerminals() {
  const exits = new Map<string, (exit: RunExit) => void>();
  const runs: RunOpts[] = [];
  const forgotten: string[] = [];
  const moved: string[] = [];
  const resumable = new Set<string>();
  let next = 0;
  const output = new Map<string, string>();
  const wt = {
    status: () => "live" as const,
    run: async (opts: RunOpts) => {
      runs.push(opts);
      next += 1;
      return `pty_${next}`;
    },
    runExit: (ptyId: string) => new Promise<RunExit>(resolve => exits.set(ptyId, resolve)),
    mirrorText: (ptyId: string) => output.get(ptyId) ?? "",
    forgetRun: async (ptyId: string) => void forgotten.push(ptyId),
    moveToTab: async (ptyId: string) => void moved.push(ptyId),
    resumeRun: async (ptyId: string) => resumable.has(ptyId),
  };
  return { wt, runs, forgotten, moved, resumable, output, exit: (ptyId: string, exit: RunExit) => exits.get(ptyId)!(exit) };
}

function recorder() {
  const steps: RunStep[] = [];
  const api = {
    recordRun: async (step: RunStep): Promise<SessionRunEvent> => {
      steps.push(step);
      return { type: "session.run", workspaceId: "ws_a", sessionId: "s", ...step };
    },
  };
  return { api, steps };
}

const TARGET: RunTarget = { workspaceId: "ws_a", threadId: "th_1", turnId: "turn_1", block: "turn_1:m0@12", command: "kill 60082 60083", cwd: "/work/copy" };
const settle = () => new Promise(r => setTimeout(r, 0));

afterEach(() => useTerminalDrawerStore.setState({ byWorkspaceId: {} }));

describe("a reply block's run, as this window drives it", () => {
  it("runs the command in the thread's folder, records it running, and records its text and code when it ends", async () => {
    const t = fakeTerminals();
    const { api, steps } = recorder();
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION, runId: () => "run-1" };
    expect(await startRun(api, TARGET, deps)).toBe("run-1");
    expect(t.runs).toEqual([{ command: "kill 60082 60083", cwd: "/work/copy" }]);
    expect(steps).toEqual([{ threadId: "th_1", turnId: "turn_1", runId: "run-1", block: TARGET.block, command: TARGET.command, state: "running", ptyId: "pty_1" }]);
    t.output.set("pty_1", "\x1b[31mkill: 60082: No such process\x1b[0m\r\n");
    t.exit("pty_1", { code: 1 });
    await settle();
    await settle();
    expect(steps[1]).toEqual({ threadId: "th_1", turnId: "turn_1", runId: "run-1", block: TARGET.block, command: TARGET.command, state: "exited", exitCode: 1, output: "kill: 60082: No such process" });
    // Its text is on the thread now, so the live terminal and its pty go.
    expect(t.forgotten).toEqual(["pty_1"]);
  });

  it("is refused where the workspace's daemon is older than the one that runs a command, and starts nothing", async () => {
    const t = fakeTerminals();
    const { api, steps } = recorder();
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION - 1, runId: () => "run-1" };
    await expect(startRun(api, TARGET, deps)).rejects.toThrow(runDaemonBehindLine(PTY_RUN_DAEMON_VERSION - 1));
    expect(t.runs).toEqual([]);
    expect(steps).toEqual([]);
  });

  it("holds the run while its start is being recorded, since the block the record draws may mount before the answer", async () => {
    const t = fakeTerminals();
    let seenHeld: string | null | undefined;
    const api = {
      recordRun: async (step: RunStep): Promise<SessionRunEvent> => {
        seenHeld = heldPty(step.runId);
        return { type: "session.run", workspaceId: "ws_a", sessionId: "s", ...step };
      },
    };
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION, runId: () => "run-held" };
    await startRun(api, TARGET, deps);
    expect(seenHeld).toBe("pty_1");
  });

  it("gives the keyboard to the run a click here started, once, and never to one taken back after a reload", async () => {
    const t = fakeTerminals();
    const { api } = recorder();
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION, runId: () => "run-focus" };
    await startRun(api, TARGET, deps);
    expect(takeFocus("run-focus")).toBe(true);
    // A block scrolled out and back in mounts its terminal again, and must not take the composer's keys.
    expect(takeFocus("run-focus")).toBe(false);
    t.resumable.add("pty_5");
    await resumeRun(api, { type: "session.run", workspaceId: "ws_a", sessionId: "s", threadId: "th_1", turnId: "turn_1", runId: "run-back", block: "b", command: "ls", state: "running", ptyId: "pty_5" }, deps);
    expect(takeFocus("run-back")).toBe(false);
  });

  it("lets go of the pty it made when the host will not record the run, and says why", async () => {
    const t = fakeTerminals();
    const api = { recordRun: async (): Promise<SessionRunEvent> => Promise.reject(new Error("unknown op sessions.run")) };
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION, runId: () => "run-x" };
    await expect(startRun(api, TARGET, deps)).rejects.toThrow("unknown op sessions.run");
    expect(t.forgotten).toEqual(["pty_1"]);
  });

  it("moved to a terminal tab, it is recorded moved, opens that tab, and its end is the tab's, never recorded here", async () => {
    const t = fakeTerminals();
    const { api, steps } = recorder();
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION, runId: () => "run-2" };
    await startRun(api, TARGET, deps);
    const running = { type: "session.run", workspaceId: "ws_a", sessionId: "s", ...steps[0]! } as SessionRunEvent;
    await moveRun(api, running, deps);
    expect(t.moved).toEqual(["pty_1"]);
    expect(steps.at(-1)).toMatchObject({ state: "moved", ptyId: "pty_1" });
    const drawer = useTerminalDrawerStore.getState().byWorkspaceId["ws_a"];
    expect(drawer?.terminalOpen).toBe(true);
    expect(drawer?.activeTerminalId).toBe("pty_1");
    t.exit("pty_1", { code: 0 });
    await settle();
    expect(steps.map(s => s.state)).toEqual(["running", "moved"]);
    expect(t.forgotten).toEqual([]);
  });

  it("taken back after a reload by the record, it is watched to its end; one whose pty is gone is recorded lost", async () => {
    const t = fakeTerminals();
    const { api, steps } = recorder();
    const deps: RunDeps = { terminals: () => t.wt as never, version: () => PTY_RUN_DAEMON_VERSION, runId: () => "unused" };
    const running = (runId: string, ptyId: string): SessionRunEvent => ({ type: "session.run", workspaceId: "ws_a", sessionId: "s", threadId: "th_1", turnId: "turn_1", runId, block: "b", command: "npm test", state: "running", ptyId });
    t.resumable.add("pty_9");
    await resumeRun(api, running("run-9", "pty_9"), deps);
    t.output.set("pty_9", "ok\r\n");
    t.exit("pty_9", { code: 0 });
    await settle();
    await settle();
    expect(steps).toEqual([{ threadId: "th_1", turnId: "turn_1", runId: "run-9", block: "b", command: "npm test", state: "exited", exitCode: 0, output: "ok" }]);
    await resumeRun(api, running("run-8", "pty_8"), deps);
    expect(steps.at(-1)).toMatchObject({ runId: "run-8", state: "lost" });
    // A second window taking back the same run watches it once.
    t.resumable.add("pty_7");
    await resumeRun(api, running("run-7", "pty_7"), deps);
    await resumeRun(api, running("run-7", "pty_7"), deps);
    t.exit("pty_7", { code: 0 });
    await settle();
    await settle();
    expect(steps.filter(s => s.runId === "run-7")).toHaveLength(1);
  });
});
