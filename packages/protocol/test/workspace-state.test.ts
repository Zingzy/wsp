// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { actionRefusal, agentsKindRefusal, agentsMayDrive, computerOffline, deleteNotice, importDest, screenCommandLine, screenCommandTyped, screenCommandsOf, goneRefusal, isBilling, isLocalWorkspace, kindWords, MACHINE_WSP_FORKS, machineWord, needsRebuild, NOT_ON_THIS_KIND, OVER_SSH, providerCannotRefusal, reachShown, relayedRefusal, sendRefusal, servesReading, signInRefusalLine, signInRoad, stillWorkingLine, THIS_COMPUTER, undrivenRefusal, WORKSPACE_KIND_WORDS, workspaceKind, workspaceState, workspaceStateOf, workspaceWord, type ReachState, type SendBlock, type WorkspaceState } from "../src/index.js";

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

  it("a status carries all three facts, so every surface holding one reads the state off it; without one the phase stands alone", () => {
    const paused = { machineState: "paused" as const, reach: { state: "napping" as const } };
    expect(workspaceStateOf({ phase: "running" }, paused)).toBe("paused");
    expect(workspaceStateOf({ phase: "running" }, { machineState: "running", reach: { state: "no-daemon" } })).toBe("unreachable");
    expect(workspaceStateOf({ phase: "running" }, { machineState: "running", reach: { state: "reachable" } })).toBe("running");
    expect(workspaceStateOf({ phase: "running" }, null)).toBe("running");
    expect(workspaceStateOf({ phase: "napping" }, null)).toBe("paused");
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
    expect(stillWorkingLine("thr_0001")).toBe("thread thr_0001 replied, still working; the message runs as its next turn once that process exits");
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

  it("needsRebuild: the rebuild is a road for a gone machine, a zombie, or one the provider would not resume", () => {
    expect(needsRebuild({ phase: "gone" })).toBe(true);
    expect(needsRebuild({ phase: "running", machineState: "gone", reach: "gone" })).toBe(true);
    expect(needsRebuild({ phase: "running", machineState: "running", reach: "zombie" })).toBe(true);
    expect(needsRebuild({ phase: "running", machineState: "running", reach: "unreachable" })).toBe(false);
    expect(needsRebuild({ phase: "napping", machineState: "paused", reach: "napping" })).toBe(false);
    // A paused machine whose last wake ran its asking out: the words are the record's, and a cleared one is null.
    expect(needsRebuild({ phase: "napping", machineState: "paused", reach: "napping", wakeRefused: "the provider answered none of 31 resume requests over 30m" })).toBe(true);
    expect(needsRebuild({ phase: "napping", machineState: "paused", reach: "napping", wakeRefused: null })).toBe(false);
    // The state words never move for it: the machine is paused, and the wake is offered beside the rebuild.
    expect(workspaceState({ phase: "napping", machineState: "paused", wakeRefused: "x" })).toBe("paused");
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

  it("a dead daemon port waits out the same window: a restart under the unit takes about a second, less than a poll", () => {
    expect(reachShown("reachable", "no-daemon")).toBe("reachable");
    expect(reachShown("slow", "no-daemon")).toBe("slow");
    expect(reachShown("no-daemon", "no-daemon")).toBe("no-daemon");
    // The two unanswered words do not cover for each other: either one after the other is the second silence.
    expect(reachShown("unreachable", "no-daemon")).toBe("no-daemon");
    expect(reachShown("no-daemon", "unreachable")).toBe("unreachable");
  });

  it("a machine never heard from, or one already failing, reads its silence at once", () => {
    expect(reachShown(undefined, "unreachable")).toBe("unreachable");
    expect(reachShown(undefined, "no-daemon")).toBe("no-daemon");
    for (const previous of ["no-daemon", "zombie", "napping", "gone", "unsupported"] as const) expect(reachShown(previous, "unreachable")).toBe("unreachable");
    for (const previous of ["unreachable", "zombie", "napping", "gone", "unsupported"] as const) expect(reachShown(previous, "no-daemon")).toBe("no-daemon");
  });

  it("every answer is shown as it came, whatever went before", () => {
    const answers: ReachState[] = ["reachable", "slow", "napping", "unsupported", "gone", "zombie"];
    for (const probed of answers) for (const previous of [undefined, ...answers, "unreachable" as const, "no-daemon" as const]) expect(reachShown(previous, probed)).toBe(probed);
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

  it("a machine wsp drives has a state, a bill and an image; this computer has none of the three and its row reads its own size", () => {
    expect(kindWords("cloud")).toEqual({ machine: MACHINE_WSP_FORKS, rowReadsMachine: true, cpu: "vCPU", driven: true, daemon: true, metrics: true, processes: true, imports: "copies", importsAt: "same path", agents: true, onDelete: { asked: "machine is deleted at the provider", done: expect.any(Function) } });
    // This computer serves a daemon and reads both its own load and its own processes off its host. A folder is
    // already on this computer, so an import registers its path and copies nothing. Its row's second line is its
    // cores and memory in the size line a fork's row reads, in its own word for a cpu, since its cores are not virtual.
    expect(kindWords("local")).toEqual({ machine: THIS_COMPUTER, rowReadsMachine: true, cpu: "cores", driven: false, daemon: true, metrics: true, processes: true, imports: "registers", importsAt: "same path", agents: false, onDelete: { asked: "machine is left as it is", done: expect.any(Function) } });
    // A machine over ssh is the person's own too: wsp neither forks it, pauses it, resizes it nor pays for it. It
    // carries the same daemon a fork does, put there under the person's own login, so it serves the panes, reads
    // its own load off its own /proc and lists its own processes, and a folder is copied onto it the way one is
    // copied onto a fork. Its cpus are cores like this computer's, though its words win over any size today.
    expect(kindWords("ssh")).toEqual({ machine: OVER_SSH, rowReadsMachine: false, cpu: "cores", driven: false, daemon: true, metrics: true, processes: true, imports: "copies", importsAt: "under home", agents: false, onDelete: { asked: "daemon, its unit and its login line come off the machine, which is otherwise left as it is", done: expect.any(Function) } });
    // Only the machines wsp forks run agents that could drive this host: this computer answers no request relayed
    // from a machine, and a machine somebody already owns is handed no wsp to drive one with.
    expect(agentsMayDrive("cloud")).toBe(true);
    expect(agentsMayDrive("local")).toBe(false);
    expect(agentsMayDrive("ssh")).toBe(false);
    expect(agentsKindRefusal("local")).toContain("cannot drive this host");
    // A machine wsp made carries the path the folder has here; a machine somebody owns takes it into their own
    // home, since a path from this computer is neither theirs to write nor theirs to find.
    expect(importDest("/Users/dev/spoo", { kind: "cloud", home: "/root" })).toBe("/Users/dev/spoo");
    expect(importDest("/Users/dev/spoo", { kind: "local", home: "/Users/dev" })).toBe("/Users/dev/spoo");
    expect(importDest("/Users/dev/spoo/", { kind: "ssh", home: "/home/maya" })).toBe("/home/maya/spoo");
    expect(importDest("/Users/dev/spoo", { kind: "ssh", home: undefined })).toBe("/Users/dev/spoo");
  });

  it("the two readings a pane waits on are the table's to answer, so nothing sits at pending for a stream that never comes", () => {
    // Every kind reads both today: this computer off its own host, a fork and a machine over ssh off that
    // machine's own /proc through the daemon on it. The words stay so the next kind that reads neither says so.
    for (const kind of ["local", "cloud", "ssh"] as const) {
      expect(servesReading(kind, "metrics")).toBe(true);
      expect(servesReading(kind, "processes")).toBe(true);
    }
    expect(NOT_ON_THIS_KIND).toBe("not on this kind");
  });

  it("every kind has a row in the table, so adding one is a row here and nothing else", () => {
    expect(Object.keys(WORKSPACE_KIND_WORDS).sort()).toEqual(["cloud", "local", "place", "ssh"]);
  });

  it("the delete sentence says what the delete does to this kind's machine, the ssh sweep included", () => {
    expect(deleteNotice(2, "cloud")).toBe("Its machine is deleted at the provider; its record and 2 threads leave this computer.");
    expect(deleteNotice(1, "local")).toBe("Its machine is left as it is; its record and 1 thread leave this computer.");
    // wsp puts a daemon, a user unit and a login line on a machine somebody owns, and the delete takes those off
    // again: a sentence saying the machine is left as it is would be saying nothing happened over there.
    expect(deleteNotice(1, "ssh")).toBe("Its daemon, its unit and its login line come off the machine, which is otherwise left as it is; its record and 1 thread leave this computer.");
    expect(WORKSPACE_KIND_WORDS.cloud.onDelete.done("m_1")).toBe("machine m_1 is gone at the provider");
    expect(WORKSPACE_KIND_WORDS.local.onDelete.done("local")).toBe("its machine is left as it is");
    expect(WORKSPACE_KIND_WORDS.ssh.onDelete.done("maya@box")).toBe("its daemon, its unit and its login line come off the machine, which is otherwise left as it is");
    // Neither sentence names the machine on a kind whose machine stays: naming it would read as the machine going.
    for (const kind of ["local", "ssh"] as const) expect(WORKSPACE_KIND_WORDS[kind].onDelete.done("m_2")).not.toContain("m_2");
  });

  it("the phrase for this computer has one home: the refusals read it too", () => {
    expect(THIS_COMPUTER).toBe("this computer");
    expect(relayedRefusal("mac")).toContain(THIS_COMPUTER);
    expect(undrivenRefusal("mac", machineWord("local"), "be paused")).toBe(`mac is ${THIS_COMPUTER}, not a machine wsp runs; it cannot be paused`);
    expect(undrivenRefusal("box", machineWord("ssh"), "be paused")).toBe(`box is ${OVER_SSH}, not a machine wsp runs; it cannot be paused`);
  });

  it("every kind's own word is in the table, so no sentence about one kind's machine borrows another's", () => {
    // The cloud kind's machine is wsp's own, whether the provider runs virtual machines or containers, so a refusal
    // on one names the provider's limit and never tells a person their fork is the computer they are sitting at.
    expect(machineWord("cloud")).toBe(MACHINE_WSP_FORKS);
    expect(machineWord("local")).toBe(THIS_COMPUTER);
    expect(machineWord("ssh")).toBe(OVER_SSH);
    // The machine is the subject of every action these sentences take, since each action is the machine's own verb
    // phrase: the provider is where the road is missing, not the thing that would be resized or moved.
    expect(providerCannotRefusal("api", machineWord("cloud"), "be resized")).toBe("api is a machine wsp forks, and it cannot be resized on the provider it runs on");
    expect(providerCannotRefusal("api", machineWord("cloud"), "move to a newer image")).toBe("api is a machine wsp forks, and it cannot move to a newer image on the provider it runs on");
    for (const kind of ["cloud", "local", "ssh"] as const) expect(machineWord(kind)).not.toBe("");
    expect(new Set(["cloud", "local", "ssh"].map(k => machineWord(k as "cloud")))).toHaveLength(3);
  });
});

describe("a slash command that works only in the CLI's own terminal", () => {
  const SCREEN = [
    { name: "login", control: "sign-in" as const },
    { name: "logout", control: "sign-in" as const },
    { name: "model", control: "model" as const },
    { name: "permissions", control: "access" as const },
    { name: "config", control: "settings" as const },
    { name: "help", control: "docs" as const },
  ];
  const catalog = { label: "Claude Code", screenCommands: SCREEN };

  it("is read off the message only where the slash opens it, by name without its slash, and nothing else is one", () => {
    expect(screenCommandTyped(catalog, "/login")).toEqual({ name: "login", control: "sign-in" });
    expect(screenCommandTyped(catalog, "  /login  ")).toEqual({ name: "login", control: "sign-in" });
    expect(screenCommandTyped(catalog, "/model opus")).toEqual({ name: "model", control: "model" });
    expect(screenCommandTyped(catalog, "/loginx")).toBeNull();
    expect(screenCommandTyped(catalog, "/compact")).toBeNull();
    expect(screenCommandTyped(catalog, "see /login")).toBeNull();
    expect(screenCommandTyped(catalog, "login")).toBeNull();
    expect(screenCommandTyped(catalog, "")).toBeNull();
  });

  it("a catalog from before the field, or none at all, names no screen command", () => {
    expect(screenCommandsOf(null)).toEqual([]);
    expect(screenCommandsOf(undefined)).toEqual([]);
    expect(screenCommandsOf({})).toEqual([]);
    expect(screenCommandsOf(catalog)).toBe(SCREEN);
    expect(screenCommandTyped(null, "/login")).toBeNull();
    expect(screenCommandTyped({}, "/login")).toBeNull();
  });

  it("the composer's line says the command is the CLI's own screen and names wsp's control for the same intent", () => {
    const cloud = { kind: "cloud" as const };
    const local = { kind: "local" as const };
    expect(screenCommandLine(SCREEN[0]!, catalog, cloud)).toBe("/login works only in Claude Code's own terminal; sign this machine in from the Machine tab");
    expect(screenCommandLine(SCREEN[1]!, catalog, cloud)).toBe("/logout works only in Claude Code's own terminal; sign this machine in from the Machine tab");
    expect(screenCommandLine(SCREEN[0]!, catalog, local)).toBe(`/login works only in Claude Code's own terminal; sign in from a terminal on ${THIS_COMPUTER}`);
    expect(screenCommandLine(SCREEN[2]!, catalog, cloud)).toBe("/model works only in Claude Code's own terminal; pick the model in the row under the box");
    expect(screenCommandLine(SCREEN[3]!, catalog, local)).toBe("/permissions works only in Claude Code's own terminal; pick the access mode in the row under the box");
    expect(screenCommandLine(SCREEN[4]!, catalog, cloud)).toBe("/config works only in Claude Code's own terminal; wsp's settings open from the command palette");
    expect(screenCommandLine(SCREEN[5]!, catalog, cloud)).toBe("/help works only in Claude Code's own terminal; wsp's docs are at wsp.apidocumentation.com");
    // A record from before kinds existed is a provider fork, so it reads the machine's road.
    expect(screenCommandLine(SCREEN[0]!, catalog, {})).toContain("Machine tab");
    // Every line is one sentence for the composer's slot: no line break, sentence case, nothing but words.
    for (const command of SCREEN) for (const view of [cloud, local]) expect(screenCommandLine(command, catalog, view)).toMatch(/^\/[a-z]+ works only in [^\n]+; [a-z][^\n]+[^.]$/);
  });

  it("the composer's sign-in line and a refused turn's half read one road rule, so the two never send a person two ways", () => {
    const cloud = { kind: "cloud" as const };
    const local = { kind: "local" as const };
    expect(signInRoad(local)).toBe(`sign in from a terminal on ${THIS_COMPUTER}`);
    expect(signInRoad(cloud)).toBe("sign this machine in from the Machine tab");
    // A record from before kinds existed is a provider fork, so it reads the machine's road here too.
    expect(signInRoad({})).toBe(signInRoad(cloud));
    for (const view of [cloud, local, {}]) {
      expect(signInRefusalLine(view)).toBe(`${signInRoad(view)}, then send again`);
      expect(screenCommandLine(SCREEN[0]!, catalog, view)).toContain(signInRoad(view));
    }
  });
});
