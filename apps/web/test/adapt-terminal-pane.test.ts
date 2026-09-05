// SPDX-License-Identifier: AGPL-3.0-only
// The terminal pane's state from (phase, reach, socket): what it says over the frame, in the empty state, and to a key.
import { describe, expect, it } from "vitest";
import type { DaemonLinkStatus, MachineState, ReachState, WorkspacePhase } from "@wsp/protocol";
import { workspaceState } from "@wsp/protocol";
import { terminalEmptyLine, terminalInputRefusal, terminalPaneState, terminalPaneTitle, type TerminalPaneState } from "../src/adapt/index.js";

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
    expect(terminalPaneTitle({ kind: "reconnecting" })).toBe("Reconnecting to the machine");
    expect(terminalPaneTitle({ kind: "not-answering" })).toBe("The machine is not answering");
    expect(terminalPaneTitle({ kind: "reauth" })).toBe("The machine refused a stale daemon token; reconnecting with the one wsp holds now");
    expect(terminalEmptyLine({ kind: "reauth" })).toBe("The machine refused a stale daemon token; terminals open once the link carries the current one");
    expect(terminalInputRefusal({ kind: "reauth" })).toBe("Typing is refused until the machine takes the current daemon token");
    expect(terminalEmptyLine({ kind: "reconnecting" })).toBe("The daemon link is reconnecting; terminals open when it is back");
    expect(terminalEmptyLine({ kind: "paused", pausing: false })).toBe("Workspace is paused; wake it to open a terminal");
    expect(terminalInputRefusal({ kind: "paused", pausing: false })).toBe("Typing is refused: the workspace is paused");
    expect(terminalInputRefusal({ kind: "reconnecting" })).toBe("Typing is refused while the machine is reconnecting");
    for (const kind of ["reconnecting", "not-answering", "waking", "gone"] as const) {
      expect(terminalPaneTitle({ kind })).toBeTruthy();
      expect(terminalEmptyLine({ kind })).toBeTruthy();
      expect(terminalInputRefusal({ kind })).toBeTruthy();
    }
  });
});
