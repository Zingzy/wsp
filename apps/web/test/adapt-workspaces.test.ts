// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces and statuses into sidebar projects with status indicators.
import { describe, expect, it } from "vitest";
import type { MachineState, ReachState, SessionView, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { deriveSidebarProjects, pausedLine, threadIndicator, turnWait, workspaceIndicator, type SidebarInput } from "../src/adapt/index.js";
import { LIVE_RUN_1, LIVE_RUN_1_RESTART, LIVE_WORKSPACE_1, LIVE_WORKSPACE_2, LIVE_WS } from "./fixtures/live-run-1.js";

const status = (phase: WorkspacePhase, machineState: MachineState, reach: ReachState, id = "ws_a"): WorkspaceStatus => ({
  id, name: id, machineId: `m_${id}`, phase, golden: "snap", createdAt: "2026-09-01T00:00:00Z",
  machineState, reach: { state: reach }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11,
});

describe("workspaceIndicator", () => {
  it.each<[WorkspacePhase, MachineState | null, ReachState | null, string, string, boolean]>([
    ["running", "running", "reachable", "Running", "running", false],
    ["running", null, null, "Running", "running", false],
    ["pausing", "running", "napping", "Pausing", "paused", true],
    ["waking", "starting", "unreachable", "Waking", "neutral", true],
    ["napping", "paused", "napping", "Paused", "paused", false],
    ["running", "starting", "unreachable", "Waking", "neutral", true],
    ["running", "paused", "napping", "Paused", "paused", false],
    ["running", "running", "unreachable", "Unreachable", "neutral", false],
    ["running", "running", "no-daemon", "Unreachable", "neutral", false],
    ["running", "gone", "gone", "Gone", "neutral", false],
    ["napping", "gone", "gone", "Gone", "neutral", false],
    ["gone", "gone", "gone", "Gone", "neutral", false],
    ["gone", null, null, "Gone", "neutral", false],
    ["running", "running", "zombie", "Unreachable", "neutral", false],
    ["running", "running", "slow", "Running", "running", false],
  ])("phase %s, machine %s, reach %s -> %s", (phase, machineState, reach, label, tone, pulse) => {
    const s = machineState !== null && reach !== null ? status(phase, machineState, reach) : null;
    expect(workspaceIndicator({ phase }, s)).toEqual({ label, tone, pulse });
  });
});

describe("threadIndicator", () => {
  it.each<[SessionView["status"], string, boolean]>([
    ["running", "Working", true], ["completed", "Idle", false], ["interrupted", "Idle", false], ["failed", "Ended", false],
  ])("%s -> %s", (st, label, pulse) => {
    expect(threadIndicator({ status: st, asking: undefined })).toEqual({ label, tone: "neutral", pulse });
  });

  it("a turn stopped on a permission prompt reads as needing the person and does not pulse, and goes back to working when it is answered", () => {
    const asking = "Permission for Write: out.txt";
    expect(threadIndicator({ status: "running", asking })).toEqual({ label: "Needs you", tone: "neutral", pulse: false });
    expect(threadIndicator({ status: "running", asking: undefined })).toEqual({ label: "Working", tone: "neutral", pulse: true });
  });
});

describe("turnWait", () => {
  const runs = { name: "profile", where: "ascii" };

  it("names the workspace a running turn waits for, where it runs while it wakes, and offers the wake only where one applies", () => {
    expect(turnWait("running", runs)).toBeNull();
    expect(turnWait("pausing", runs)).toEqual({ label: "waiting for profile to wake", wake: true, elapsed: false });
    expect(turnWait("paused", runs)).toEqual({ label: "waiting for profile to wake", wake: true, elapsed: false });
    // The wake a send started is the one line that counts the seconds, since that is what the send is waiting on.
    expect(turnWait("waking", runs)).toEqual({ label: "waking profile on ascii", wake: false, elapsed: true });
    expect(turnWait("unreachable", runs)).toEqual({ label: "waiting for profile to answer", wake: false, elapsed: false });
    expect(turnWait("gone", runs)).toEqual({ label: "profile is gone", wake: false, elapsed: false });
  });

  it("the paused line reads the idle window the runtime napped it after, and the state alone where no status carried one", () => {
    expect(pausedLine("idle 30 min")).toBe("paused after 30 min idle");
    expect(pausedLine("idle 20 min")).toBe("paused after 20 min idle");
    expect(pausedLine(undefined)).toBe("paused");
    // A reason of another shape is not a window: nothing is invented from it.
    expect(pausedLine("machine replaced")).toBe("paused");
  });
});

describe("deriveSidebarProjects", () => {
  const statusesFrom = (stream: typeof LIVE_RUN_1) => {
    const out: Record<string, WorkspaceStatus> = {};
    for (const { event } of stream) if (event.type === "workspace.status") out[event.status.id] = event.status;
    return out;
  };

  it("live run 1: two machines, the one created later and still quiet above the one whose thread ended before it existed, each a remote project with its machine as the environment label", () => {
    const projects = deriveSidebarProjects({
      workspaces: [LIVE_WORKSPACE_2, LIVE_WORKSPACE_1],
      statuses: statusesFrom(LIVE_RUN_1),
      sessions: {
        [LIVE_WS]: [
          { id: "s1", workspaceId: LIVE_WS, harness: "claude", status: "completed", claudeSessionId: "59094224", prompt: "hello", startedAt: Date.parse("2026-09-02T17:19:35.668Z"), endedAt: Date.parse("2026-09-02T17:19:37.768Z") },
          { id: "s0", workspaceId: LIVE_WS, harness: "claude", status: "running", claudeSessionId: "59094224" },
        ],
      },
    });
    expect(projects.map(p => [p.displayName, p.indicator.label, p.remoteEnvironmentLabels, p.threads.length])).toEqual([
      ["yolo", "Running", ["machine-2"], 0],
      ["first", "Running", ["machine-1"], 2],
    ]);
    expect(projects[1]).toMatchObject({ projectKey: LIVE_WS, environmentPresence: "remote-only", groupedProjectCount: 1, allRemoteMembersAreDesktopLocal: false, machineState: "running", reach: "reachable", state: "running" });
    expect(projects[1]?.threads).toEqual([
      { id: "s1", threadId: null, sessionId: "s1", workspaceId: LIVE_WS, title: "hello", status: "completed", ran: true, startedAt: "2026-09-02T17:19:35.668Z", endedAt: "2026-09-02T17:19:37.768Z", indicator: { label: "Idle", tone: "neutral", pulse: false }, harness: "claude", startedBy: "person", project: null, parentThreadId: null, asking: null },
      { id: "s0", threadId: null, sessionId: "s0", workspaceId: LIVE_WS, title: "59094224", status: "running", ran: true, startedAt: null, endedAt: null, indicator: { label: "Working", tone: "neutral", pulse: true }, harness: "claude", startedBy: "person", project: null, parentThreadId: null, asking: null },
    ]);
  });

  it("a thread carries the name of the project its folder sits in, the folder itself or one under it, and none outside every project", () => {
    const projects = [{ name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z" }, { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-02T00:00:00Z" }];
    const [p] = deriveSidebarProjects({
      workspaces: [{ ...LIVE_WORKSPACE_1, projects }],
      sessions: {
        [LIVE_WS]: [
          { id: "s1", workspaceId: LIVE_WS, harness: "claude", status: "completed", prompt: "in spoo", cwd: "/root/spoo", startedAt: 1_000 },
          { id: "s2", workspaceId: LIVE_WS, harness: "claude", status: "completed", prompt: "deep in wsp", cwd: "/root/wsp/packages/host", startedAt: 2_000 },
          { id: "s3", workspaceId: LIVE_WS, harness: "claude", status: "completed", prompt: "elsewhere", cwd: "/root/spoo-fork", startedAt: 3_000 },
          { id: "s4", workspaceId: LIVE_WS, harness: "claude", status: "completed", prompt: "nowhere yet", startedAt: 4_000 },
        ],
      },
    });
    expect(p!.threads.map(t => [t.title, t.project])).toEqual([["in spoo", "spoo"], ["deep in wsp", "wsp"], ["elsewhere", null], ["nowhere yet", null]]);
  });

  it("turns sharing a threadId fold into one thread titled by the opening prompt, in the state of the latest turn", () => {
    const [p] = deriveSidebarProjects({
      workspaces: [LIVE_WORKSPACE_1],
      sessions: {
        [LIVE_WS]: [
          { id: "s1", workspaceId: LIVE_WS, harness: "claude", status: "completed", startedBy: "cli", threadId: "thr_a", prompt: "make me a simple server", startedAt: 1_000, endedAt: 2_000 },
          { id: "s2", workspaceId: LIVE_WS, harness: "codex", status: "completed", startedBy: "person", threadId: "thr_b", prompt: "unrelated", startedAt: 3_000, endedAt: 4_000 },
          { id: "s3", workspaceId: LIVE_WS, harness: "claude", status: "running", startedBy: "person", threadId: "thr_a", prompt: "do you have access", startedAt: 5_000 },
          { id: "s4", workspaceId: LIVE_WS, harness: "claude", status: "failed", prompt: "before threads", startedAt: 6_000, endedAt: 7_000 },
        ],
      },
    });
    // A folded thread's session id is its latest turn's, the one a stop interrupts.
    expect(p!.threads.map(t => t.sessionId)).toEqual(["s3", "s2", "s4"]);
    expect(p!.threads.map(t => [t.id, t.threadId, t.title, t.status, t.startedAt, t.endedAt, t.indicator?.label])).toEqual([
      ["thr_a", "thr_a", "make me a simple server", "running", new Date(5_000).toISOString(), null, "Working"],
      ["thr_b", "thr_b", "unrelated", "completed", new Date(3_000).toISOString(), new Date(4_000).toISOString(), "Idle"],
      ["s4", null, "before threads", "failed", new Date(6_000).toISOString(), new Date(7_000).toISOString(), "Ended"],
    ]);
    // Provenance is the opening turn's: the thread the command line opened stays the command line's after a person's turn.
    expect(p!.threads.map(t => [t.harness, t.startedBy])).toEqual([["claude", "cli"], ["codex", "person"], ["claude", "person"]]);
  });

  describe("order", () => {
    const HOUR = 60 * 60_000;
    const T = Date.parse("2026-09-06T12:00:00Z");
    const ws = (id: string, phase: WorkspacePhase, createdAgoMs: number): WorkspaceView => ({
      id, name: id, machineId: `m_${id}`, phase, golden: "snap", createdAt: new Date(T - createdAgoMs).toISOString(),
    });
    const at = (w: WorkspaceView, machineState: MachineState, reach: ReachState, over: Partial<WorkspaceStatus> = {}): WorkspaceStatus => ({
      ...w, machineState, reach: { state: reach }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, ...over,
    });
    const turn = (id: string, workspaceId: string, startedAgoMs: number, endedAgoMs?: number): SessionView => ({
      id, workspaceId, harness: "claude", status: endedAgoMs === undefined ? "running" : "completed", prompt: id,
      startedAt: T - startedAgoMs, ...(endedAgoMs === undefined ? {} : { endedAt: T - endedAgoMs }),
    });
    const runningOld = ws("running-old", "running", 72 * HOUR);
    const runningMid = ws("running-mid", "running", 24 * HOUR);
    const unreachableNew = ws("unreachable-new", "running", 10 * 60_000);
    const pausedOld = ws("paused-old", "napping", 48 * HOUR);
    const pausedNew = ws("paused-new", "napping", 30 * 60_000);
    const goneNew = ws("gone-new", "running", 60_000);
    const fleet = {
      workspaces: [runningOld, pausedOld, runningMid, goneNew, pausedNew, unreachableNew],
      statuses: {
        [runningOld.id]: at(runningOld, "running", "reachable"),
        [runningMid.id]: at(runningMid, "running", "reachable"),
        [unreachableNew.id]: at(unreachableNew, "running", "unreachable"),
        [pausedOld.id]: at(pausedOld, "paused", "napping"),
        [pausedNew.id]: at(pausedNew, "paused", "napping"),
        [goneNew.id]: at(goneNew, "gone", "gone"),
      },
      sessions: {
        [runningOld.id]: [turn("s1", runningOld.id, 5 * 60_000)],
        [pausedOld.id]: [turn("s2", pausedOld.id, 2 * HOUR, HOUR)],
      },
    };
    const order = (input: SidebarInput) => deriveSidebarProjects(input).map(p => p.id);

    it("workspaces whose machine is up lead however old, then the paused, then the gone; inside a group the latest turn or creation is on top", () => {
      expect(order(fleet)).toEqual(["running-old", "unreachable-new", "running-mid", "paused-new", "paused-old", "gone-new"]);
    });

    it("a status tick that leaves the state alone leaves the order alone; a state change or a new turn moves the row", () => {
      const ticked = {
        ...fleet,
        statuses: {
          ...fleet.statuses,
          [runningOld.id]: at(runningOld, "running", "slow", { idleAt: T + 9 * 60_000 }),
          [runningMid.id]: at(runningMid, "running", "reachable", { idleAt: T + 3 * 60_000 }),
        },
      };
      expect(order(ticked)).toEqual(order(fleet));
      const woke = { ...fleet, statuses: { ...fleet.statuses, [pausedNew.id]: at({ ...pausedNew, phase: "running" }, "running", "reachable") } };
      expect(order(woke)).toEqual(["running-old", "unreachable-new", "paused-new", "running-mid", "paused-old", "gone-new"]);
      const spoke = { ...fleet, sessions: { ...fleet.sessions, [runningMid.id]: [turn("s3", runningMid.id, 60_000)] } };
      expect(order(spoke)).toEqual(["running-mid", "running-old", "unreachable-new", "paused-new", "paused-old", "gone-new"]);
    });

    it("a workspace just created, still waking, sits at the top of the up group with no thread yet", () => {
      const fresh = ws("fresh", "running", 0);
      expect(order({ ...fleet, workspaces: [...fleet.workspaces, fresh], statuses: { ...fleet.statuses, [fresh.id]: at(fresh, "starting", "unreachable") } })).toEqual([
        "fresh", "running-old", "unreachable-new", "running-mid", "paused-new", "paused-old", "gone-new",
      ]);
    });
  });

  it("the restart log: a napping status wins over the stale view phase", () => {
    const [p] = deriveSidebarProjects({ workspaces: [LIVE_WORKSPACE_1], statuses: statusesFrom(LIVE_RUN_1_RESTART) });
    expect(p).toMatchObject({ phase: "napping", indicator: { label: "Paused", tone: "paused" } });
  });

  it("without a status the view alone drives the indicator", () => {
    const [p] = deriveSidebarProjects({ workspaces: [{ ...LIVE_WORKSPACE_1, phase: "waking" }] });
    expect(p).toMatchObject({ status: null, machineState: null, reach: null, indicator: { label: "Waking", pulse: true } });
  });
});
