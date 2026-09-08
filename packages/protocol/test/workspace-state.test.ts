// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { actionRefusal, computerOffline, goneRefusal, isBilling, isLocalWorkspace, kindWords, localMachineRefusal, needsRebuild, reachShown, relayedRefusal, sendRefusal, stillWorkingRefusal, THIS_COMPUTER, workspaceKind, workspaceState, workspaceWord, WORKSPACE_KIND_WORDS, type ReachState, type SendBlock, type WorkspaceState } from "../src/index.js";

describe("workspaceState", () => {
  it("phase alone: running, pausing, napping and waking each have one word", () => {
    expect(workspaceState({ phase: "running" })).toBe("running");
    expect(workspaceState({ phase: "pausing" })).toBe("pausing");
    expect(workspaceState({ phase: "napping" })).toBe("paused");
    expect(workspaceState({ phase: "waking" })).toBe("waking");
  });

  it("phase gone is gone whatever the machine or the reach say: the record outlives the provider's view", () => {
    expect(workspaceState({ phase: "gone" })).toBe("gone");
    expect(workspaceState({ phase: "gone", machineState: "running", reach: "reachable" })).toBe("gone");
  });

  it("the provider's word overrides the phase only where it contradicts it", () => {
    expect(workspaceState({ phase: "running", machineState: "gone", reach: "gone" })).toBe("gone");
    expect(workspaceState({ phase: "napping", machineState: "gone", reach: "gone" })).toBe("gone");
    expect(workspaceState({ phase: "running", machineState: "paused", reach: "napping" })).toBe("paused");
    expect(workspaceState({ phase: "running", machineState: "starting", reach: "unreachable" })).toBe("waking");
    expect(workspaceState({ phase: "waking", machineState: "starting", reach: "unreachable" })).toBe("waking");
    expect(workspaceState({ phase: "pausing", machineState: "paused", reach: "napping" })).toBe("pausing");
  });

  it("a running machine whose daemon does not answer is unreachable; a slow edge is still running", () => {
    expect(workspaceState({ phase: "running", machineState: "running", reach: "unreachable" })).toBe("unreachable");
    expect(workspaceState({ phase: "running", machineState: "running", reach: "no-daemon" })).toBe("unreachable");
    expect(workspaceState({ phase: "running", machineState: "running", reach: "zombie" })).toBe("unreachable");
    expect(workspaceState({ phase: "running", machineState: "running", reach: "slow" })).toBe("running");
    expect(workspaceState({ phase: "running", machineState: "running", reach: "unsupported" })).toBe("running");
    expect(workspaceState({ phase: "running", machineState: null, reach: null })).toBe("running");
  });

  it("every state has a capitalised word", () => {
    const words: Record<WorkspaceState, string> = { running: "Running", pausing: "Pausing", paused: "Paused", waking: "Waking", unreachable: "Unreachable", gone: "Gone" };
    for (const [state, word] of Object.entries(words)) expect(workspaceWord(state as WorkspaceState)).toBe(word);
  });

  it("sendRefusal names the state in the sentence the composer and the host both use, and is null while running", () => {
    expect(sendRefusal("running")).toBeNull();
    expect(sendRefusal("pausing")).toBe("Workspace is pausing; wake it to send");
    expect(sendRefusal("paused")).toBe("Workspace is paused; wake it to send");
    expect(sendRefusal("waking")).toBe("Workspace is waking; sends open when it is running");
    expect(sendRefusal("unreachable")).toBe("Workspace is unreachable; sends open when the machine answers");
    expect(sendRefusal("gone")).toBe("Workspace machine is gone; rebuild it to send");
  });

  it("sendRefusal is one table over everything that refuses a send: the socket, the lookup, the transcript, the thread, then the states", () => {
    const blocks: Record<SendBlock, string> = {
      connecting: "Connecting to wsp",
      reconnecting: "wsp is not running, reconnecting",
      closed: "wsp is not running",
      "not-found": "Workspace not found",
      loading: "Loading transcript",
    };
    for (const [kind, words] of Object.entries(blocks)) expect(sendRefusal(kind as SendBlock)).toBe(words);
    expect(stillWorkingRefusal("thr_0001")).toBe("thread thr_0001 replied, still working; wait for its turn to finish before sending");
  });

  it("actionRefusal is the same sentence for any verb that needs the machine, and a send's is it with send", () => {
    expect(actionRefusal("running", "import")).toBeNull();
    expect(actionRefusal("paused", "import")).toBe("Workspace is paused; wake it to import");
    expect(actionRefusal("pausing", "export")).toBe("Workspace is pausing; wake it to export");
    expect(actionRefusal("waking", "import")).toBe("Workspace is waking; imports open when it is running");
    expect(actionRefusal("unreachable", "export")).toBe("Workspace is unreachable; exports open when the machine answers");
    expect(actionRefusal("gone", "import", "404")).toBe("Workspace machine is gone; rebuild it to import (404)");
    for (const state of ["running", "pausing", "paused", "waking", "unreachable", "gone"] as const) expect(actionRefusal(state, "send", "x")).toBe(sendRefusal(state, "x"));
  });

  it("needsRebuild: the rebuild is the one action for a gone machine or a zombie, and for nothing else", () => {
    expect(needsRebuild({ phase: "gone" })).toBe(true);
    expect(needsRebuild({ phase: "running", machineState: "gone", reach: "gone" })).toBe(true);
    expect(needsRebuild({ phase: "running", machineState: "running", reach: "zombie" })).toBe(true);
    expect(needsRebuild({ phase: "running", machineState: "running", reach: "unreachable" })).toBe(false);
    expect(needsRebuild({ phase: "napping", machineState: "paused", reach: "napping" })).toBe(false);
    expect(needsRebuild({ phase: "running" })).toBe(false);
  });

  it("goneRefusal is one sentence per verb, quoting the provider when the caller holds its words; a send's is sendRefusal's", () => {
    expect(goneRefusal("wake")).toBe("Workspace machine is gone; rebuild it to wake");
    expect(goneRefusal("fork", "machine m1 is gone at the provider: Not found")).toBe("Workspace machine is gone; rebuild it to fork (machine m1 is gone at the provider: Not found)");
    expect(goneRefusal("wake", "")).toBe("Workspace machine is gone; rebuild it to wake");
    expect(sendRefusal("gone", "machine m1 is gone at the provider: Not found")).toBe(goneRefusal("send", "machine m1 is gone at the provider: Not found"));
  });
});

describe("isBilling", () => {
  it("a machine bills while it runs, reachable or not; paused, moving and gone ones bill nothing and have nothing to nap", () => {
    expect(isBilling("running")).toBe(true);
    expect(isBilling("unreachable")).toBe(true);
    for (const state of ["pausing", "paused", "waking", "gone"] as const) expect(isBilling(state)).toBe(false);
    // The provider's gone word wins over a record that still says running.
    expect(isBilling(workspaceState({ phase: "running", machineState: "gone", reach: "gone" }))).toBe(false);
  });
});

describe("reachShown", () => {
  it("one silence after an answer keeps the answer's word; two in a row read unreachable; an answer clears at once", () => {
    expect(reachShown("reachable", "unreachable")).toBe("reachable");
    expect(reachShown("slow", "unreachable")).toBe("slow");
    expect(reachShown("unreachable", "unreachable")).toBe("unreachable");
    expect(reachShown("unreachable", "reachable")).toBe("reachable");
    expect(reachShown("unreachable", "slow")).toBe("slow");
  });

  it("a machine never heard from, or one already failing, reads its silence at once", () => {
    expect(reachShown(undefined, "unreachable")).toBe("unreachable");
    for (const previous of ["no-daemon", "zombie", "napping", "gone", "unsupported"] as const) expect(reachShown(previous, "unreachable")).toBe("unreachable");
  });

  it("every answer is shown as it came, whatever went before", () => {
    const answers: ReachState[] = ["reachable", "slow", "no-daemon", "napping", "unsupported", "gone", "zombie"];
    for (const probed of answers) for (const previous of [undefined, ...answers, "unreachable" as const]) expect(reachShown(previous, probed)).toBe(probed);
  });
});

describe("computerOffline", () => {
  it("one row whose probe never left this computer is the computer's road, not its machine", () => {
    expect(computerOffline([{ reach: { state: "reachable" } }, { reach: { state: "unreachable" } }])).toBe(false);
    expect(computerOffline([{ reach: { state: "reachable" } }, { reach: { state: "unreachable", offline: true } }])).toBe(true);
    expect(computerOffline([])).toBe(false);
  });
});

describe("what a workspace's kind changes about its words", () => {
  it("a record from before local workspaces existed carries no kind and reads as a provider fork", () => {
    expect(workspaceKind({ kind: undefined })).toBe("cloud");
    expect(workspaceKind({ kind: "cloud" })).toBe("cloud");
    expect(workspaceKind({ kind: "local" })).toBe("local");
  });

  it("whether a workspace is this computer is one predicate, so the app's rows and wsp init's tick cannot disagree", () => {
    expect(isLocalWorkspace({ kind: "local" })).toBe(true);
    expect(isLocalWorkspace({ kind: "cloud" })).toBe(false);
    // A record from before local workspaces existed is a provider fork, here as everywhere.
    expect(isLocalWorkspace({ kind: undefined })).toBe(false);
  });

  it("a machine wsp drives has a state, a bill and an image; this computer has none of the three and says what it is", () => {
    expect(kindWords("cloud")).toEqual({ machine: null, driven: true });
    expect(kindWords("local")).toEqual({ machine: THIS_COMPUTER, driven: false });
  });

  it("every kind has a row in the table, so adding one is a row here and nothing else", () => {
    expect(Object.keys(WORKSPACE_KIND_WORDS).sort()).toEqual(["cloud", "local"]);
  });

  it("the phrase for this computer has one home: the refusals read it too", () => {
    expect(THIS_COMPUTER).toBe("this computer");
    expect(relayedRefusal("mac")).toContain(THIS_COMPUTER);
    expect(localMachineRefusal("mac", "be paused")).toBe(`mac is ${THIS_COMPUTER}, not a machine wsp runs; it cannot be paused`);
  });
});
