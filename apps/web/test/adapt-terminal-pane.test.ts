// SPDX-License-Identifier: AGPL-3.0-only
// The terminal pane's state from (phase, reach, socket): what it says over the frame, in the empty state, and to a key.
import { describe, expect, it } from "vitest";
import type { DaemonLinkStatus, MachineState, ReachState, WorkspacePhase } from "@wsp/protocol";
import { workspaceState } from "@wsp/protocol";
import { terminalEmptyLine, terminalInputRefusal, terminalPaneHints, terminalPaneState, terminalPaneTitle, type TerminalPaneState } from "../src/adapt/index.js";

const pane = (phase: WorkspacePhase, machineState: MachineState | null, reach: ReachState | null, socket: DaemonLinkStatus): TerminalPaneState =>
  terminalPaneState({ state: workspaceState({ phase, machineState, reach }), reach, socket });

describe("terminalPaneState", () => {
  it.each<[WorkspacePhase, MachineState | null, ReachState | null, DaemonLinkStatus, TerminalPaneState]>([
    ["running", "running", "reachable", "live", { kind: "live" }],
    ["running", null, null, "live", { kind: "live" }],
    ["running", "running", "reachable", "connecting", { kind: "reconnecting" }],
    ["running", "running", "unreachable", "connecting", { kind: "reconnecting" }],
    ["running", "running", "unreachable", "live", { kind: "reconnecting" }],
    ["running", "running", "reachable", "reauth-needed", { kind: "reauth" }],
    ["running", "running", "unreachable", "reauth-needed", { kind: "reconnecting" }],
    ["running", "running", "zombie", "connecting", { kind: "not-answering" }],
    ["napping", "paused", "napping", "connecting", { kind: "paused", pausing: false }],
    ["napping", "paused", "napping", "live", { kind: "paused", pausing: false }],
    ["running", "paused", "napping", "live", { kind: "paused", pausing: false }],
    ["pausing", "running", "napping", "live", { kind: "paused", pausing: true }],
    ["waking", "starting", "napping", "connecting", { kind: "waking" }],
    ["running", "gone", "gone", "connecting", { kind: "gone" }],
  ])("phase %s, machine %s, reach %s, socket %s", (phase, machineState, reach, socket, expected) => {
    expect(pane(phase, machineState, reach, socket)).toEqual(expected);
  });

  it("says one thing per state over the frame, in the empty pane and to a refused key; nothing while live", () => {
    expect(terminalPaneTitle({ kind: "live" })).toBeNull();
    expect(terminalEmptyLine({ kind: "live" })).toBeNull();
    expect(terminalInputRefusal({ kind: "live" })).toBeNull();
    expect(terminalPaneTitle({ kind: "paused", pausing: false })).toBe("Paused. The shell is kept; wake the workspace to continue");
    expect(terminalPaneTitle({ kind: "paused", pausing: true })).toBe("Pausing. The shell is kept; wake the workspace to continue");
    expect(terminalPaneTitle({ kind: "reconnecting" })).toBe("Reconnecting to the workspace");
    expect(terminalPaneTitle({ kind: "not-answering" })).toBe("The workspace is not answering");
    expect(terminalPaneTitle({ kind: "reauth" })).toBe("The workspace refused a stale daemon token; reconnecting with the one wsp holds now");
    expect(terminalEmptyLine({ kind: "reauth" })).toBe("The workspace refused a stale daemon token; terminals open once the link carries the current one");
    expect(terminalInputRefusal({ kind: "reauth" })).toBe("Typing is refused until the workspace takes the current daemon token");
    expect(terminalEmptyLine({ kind: "reconnecting" })).toBe("The daemon link is reconnecting; terminals open when it is back");
    expect(terminalEmptyLine({ kind: "paused", pausing: false })).toBe("Workspace is paused; wake it to open a terminal");
    expect(terminalInputRefusal({ kind: "paused", pausing: false })).toBe("Typing is refused: the workspace is paused");
    expect(terminalInputRefusal({ kind: "reconnecting" })).toBe("Typing is refused while the workspace is reconnecting");
    for (const kind of ["reconnecting", "not-answering", "waking", "gone"] as const) {
      expect(terminalPaneTitle({ kind })).toBeTruthy();
      expect(terminalEmptyLine({ kind })).toBeTruthy();
      expect(terminalInputRefusal({ kind })).toBeTruthy();
    }
  });
});

describe("a drop with memory near full", () => {
  const GiB = 1024 ** 3;
  const oom = { used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 };
  const OOM_LINE = "Out of memory (3.6 GB of 3.9 GB used, load 6.4) when the workspace last answered; the work on it took the memory, not a fault of the computer it runs on";
  const size = { cpu: 2, memMb: 4096 };
  const sizes = [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
  ];
  const SIZE_LINE = "A workspace on 2 vCPU · 8 GB ($0.15/hr) fits more; pick it when you make the next one";
  const REBUILD = "Rebuild it from the Workspace panel";

  it("rides the reconnecting and not-answering panes and no other", () => {
    expect(terminalPaneState({ state: "unreachable", reach: "unreachable", socket: "connecting", outOfMemory: oom })).toEqual({ kind: "reconnecting", outOfMemory: oom });
    expect(terminalPaneState({ state: "running", reach: "reachable", socket: "connecting", outOfMemory: oom })).toEqual({ kind: "reconnecting", outOfMemory: oom });
    expect(terminalPaneState({ state: "unreachable", reach: "zombie", socket: "connecting", outOfMemory: oom })).toEqual({ kind: "not-answering", outOfMemory: oom });
    expect(terminalPaneState({ state: "running", reach: "reachable", socket: "live", outOfMemory: oom })).toEqual({ kind: "live" });
    expect(terminalPaneState({ state: "gone", reach: "gone", socket: "connecting", outOfMemory: oom })).toEqual({ kind: "gone" });
    expect(terminalPaneState({ state: "unreachable", reach: "unreachable", socket: "connecting", outOfMemory: null })).toEqual({ kind: "reconnecting" });
  });

  it("once the runtime gave up, the title says out of memory instead of not answering; while reconnecting the title keeps its clock and the line goes under it", () => {
    expect(terminalPaneTitle({ kind: "not-answering", outOfMemory: oom })).toBe(OOM_LINE);
    expect(terminalPaneTitle({ kind: "reconnecting", outOfMemory: oom })).toBe("Reconnecting to the workspace");
    expect(terminalPaneHints({ kind: "reconnecting", outOfMemory: oom }, size, sizes)).toEqual([OOM_LINE, SIZE_LINE]);
  });

  it("the next size up comes before the rebuild, and the rebuild alone is what a plain silence or a gone machine offers", () => {
    expect(terminalPaneHints({ kind: "not-answering", outOfMemory: oom }, size, sizes)).toEqual([SIZE_LINE, REBUILD]);
    expect(terminalPaneHints({ kind: "not-answering" }, size, sizes)).toEqual([REBUILD]);
    expect(terminalPaneHints({ kind: "gone" }, size, sizes)).toEqual([REBUILD]);
    expect(terminalPaneHints({ kind: "reconnecting" }, size, sizes)).toEqual([]);
    for (const kind of ["live", "reauth", "waking"] as const) expect(terminalPaneHints({ kind }, size, sizes)).toEqual([]);
    expect(terminalPaneHints({ kind: "paused", pausing: false }, size, sizes)).toEqual([]);
    // Before the status or the provider's table arrived there is no size to name; the rebuild still comes last.
    expect(terminalPaneHints({ kind: "not-answering", outOfMemory: oom }, null, sizes)).toEqual([REBUILD]);
    expect(terminalPaneHints({ kind: "reconnecting", outOfMemory: oom }, size, null)).toEqual([OOM_LINE]);
  });

  it("a machine with no daemon road says so in one sentence, with nothing to wait for and nothing to rebuild", () => {
    // The runtime's own word for a machine it has no daemon road to; nothing is reconnecting.
    const pane = terminalPaneState({ state: "running", reach: "unsupported", socket: "connecting" });
    expect(pane).toEqual({ kind: "no-daemon" });
    expect(terminalPaneTitle(pane)).toBe("There is no daemon on this workspace");
    expect(terminalEmptyLine(pane)).toBe("There is no daemon on this workspace, so no terminal opens here");
    expect(terminalInputRefusal(pane)).toBe("Typing is refused: there is no daemon on this workspace");
    expect(terminalPaneHints(pane, size, sizes)).toEqual([]);
    // Nothing about it promises a return, which is what the reconnecting copy did for a kind that had no daemon.
    for (const line of [terminalPaneTitle(pane), terminalEmptyLine(pane)]) {
      expect(line).not.toMatch(/reconnect|when it is back|when it does/i);
    }
  });

  it("a daemon that is dropping out still reads as reconnecting, since that one does come back", () => {
    expect(terminalPaneState({ state: "running", reach: "reachable", socket: "connecting" })).toEqual({ kind: "reconnecting" });
    expect(terminalPaneState({ state: "unreachable", reach: "no-daemon", socket: "dead" })).toEqual({ kind: "reconnecting" });
  });

  it("a refused connection says what happened to this window and that threads keep running, in the ruled words", () => {
    const reason = "the connection was refused with 403: cross-origin websocket denied";
    const refused = terminalPaneState({ state: "running", reach: "reachable", socket: "refused", refusal: reason });
    expect(refused).toEqual({ kind: "refused", reason });
    // The words are the coordinator's ruling on this ticket, read against the word table of the design spec.
    expect(terminalPaneTitle(refused)).toBe("The connection to this workspace was refused; its threads keep running");
    expect(terminalEmptyLine(refused)).toBe(`No terminal opens from this window: ${reason}. The workspace's threads keep running.`);
    expect(terminalInputRefusal(refused)).toBe("Typing is refused: the connection to this workspace was refused");
    expect(terminalPaneHints(refused, size, sizes)).toEqual([]);
    const lines = [terminalPaneTitle(refused)!, terminalEmptyLine(refused)!, terminalInputRefusal(refused)!];
    // A person never reads machine or daemon, and nothing here says door either: the sentence is about this window.
    for (const line of lines) expect(line).not.toMatch(/\bmachines?\b|\bdaemons?\b|\bdoors?\b/i);
    // A connection that was turned away is not one that dropped, so nothing promises it back or offers a wait.
    for (const line of lines) expect(line).not.toMatch(/reconnect|when it is back|when it does|try again/i);
    // The work on the workspace is untouched by this window, and the pane says so where a person will read it.
    expect(terminalPaneTitle(refused)).toContain("threads keep running");
    expect(terminalEmptyLine(refused)).toContain("threads keep running");

    // Without a sentence from the far side the pane still says what happened rather than falling back to reconnecting.
    expect(terminalPaneState({ state: "running", reach: "reachable", socket: "refused" })).toEqual({ kind: "refused", reason: "" });
    // Only a running workspace has a connection to be refused; a paused one says what it is.
    expect(terminalPaneState({ state: "paused", reach: "napping", socket: "refused", refusal: reason })).toEqual({ kind: "paused", pausing: false });
  });
});
