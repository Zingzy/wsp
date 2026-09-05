// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces and statuses into sidebar projects with status indicators.
import { describe, expect, it } from "vitest";
import type { MachineState, ReachState, SessionView, WorkspacePhase, WorkspaceStatus } from "@wsp/protocol";
import { deriveSidebarProjects, threadIndicator, turnWait, workspaceIndicator } from "../src/adapt/index.js";
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
    expect(threadIndicator({ status: st })).toEqual({ label, tone: "neutral", pulse });
  });
});

describe("turnWait", () => {
  it("names what a running turn waits for on a machine that is not running, and offers the wake only where one applies", () => {
    expect(turnWait("running")).toBeNull();
    expect(turnWait("pausing")).toEqual({ label: "Waiting for the machine to wake", wake: true });
    expect(turnWait("paused")).toEqual({ label: "Waiting for the machine to wake", wake: true });
    expect(turnWait("waking")).toEqual({ label: "Waking the machine", wake: false });
    expect(turnWait("unreachable")).toEqual({ label: "Waiting for the machine to answer", wake: false });
    expect(turnWait("gone")).toEqual({ label: "The machine is gone", wake: false });
  });
});

describe("deriveSidebarProjects", () => {
  const statusesFrom = (stream: typeof LIVE_RUN_1) => {
    const out: Record<string, WorkspaceStatus> = {};
    for (const { event } of stream) if (event.type === "workspace.status") out[event.status.id] = event.status;
    return out;
  };

  it("live run 1: two machines in creation order, each a remote project with its machine as the environment label", () => {
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
      ["first", "Running", ["machine-1"], 2],
      ["yolo", "Running", ["machine-2"], 0],
    ]);
    expect(projects[0]).toMatchObject({ projectKey: LIVE_WS, environmentPresence: "remote-only", groupedProjectCount: 1, allRemoteMembersAreDesktopLocal: false, machineState: "running", reach: "reachable" });
    expect(projects[0]?.threads).toEqual([
      { id: "s1", workspaceId: LIVE_WS, title: "hello", status: "completed", startedAt: "2026-09-02T17:19:35.668Z", endedAt: "2026-09-02T17:19:37.768Z", indicator: { label: "Idle", tone: "neutral", pulse: false } },
      { id: "s0", workspaceId: LIVE_WS, title: "59094224", status: "running", startedAt: null, endedAt: null, indicator: { label: "Working", tone: "neutral", pulse: true } },
    ]);
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
