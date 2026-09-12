// SPDX-License-Identifier: AGPL-3.0-only
// One action registry per object kind: every entry carries its words, its
// enabled rule from the object's state, its keybinding and its handler, and
// the palette, the row buttons, the Machine tab and the context menus all
// read the same list. These tests pin the rules per kind and the shapes the
// menus are built from.
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { goneRefusal, machineWord, NO_REBUILD_NEEDED, threadForgetRefusal, undrivenRefusal, type HarnessCatalog, type SessionStatus, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { fileActions, type FileVerbs } from "../src/actions/fileActions.js";
import { FILE_WORDS, SIDEBAR_MODE_WORDS, TERMINAL_WORDS, THIS_COMPUTER_HINTS, THREAD_WORDS, WORKSPACE_WORDS } from "../src/actions/format.js";
import { NEW_LOCAL_ACTION, SIDEBAR_MODE_ACTION, sidebarActions, type SidebarTarget, type SidebarVerbs } from "../src/actions/sidebarActions.js";
import { placeMenu } from "../src/actions/menuPlacement.js";
import { actionById, resolveActions, toMenuItems } from "../src/actions/registry.js";
import { terminalActions, type TerminalVerbs } from "../src/actions/terminalActions.js";
import { threadActions, threadTarget, type ThreadTarget, type ThreadVerbs } from "../src/actions/threadActions.js";
import { workspaceActions, workspaceTarget, type WorkspaceTarget, type WorkspaceVerbs } from "../src/actions/workspaceActions.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { MAX_TERMINALS_PER_GROUP } from "../src/terminal/groups.js";

/** A target in one folded state, spelled as the phase, machine state and reach that fold to it. */
const workspace = (state: WorkspaceState, over: Partial<WorkspaceTarget> = {}): WorkspaceTarget => ({
  id: "ws_a",
  displayName: "api",
  machineId: "m_a",
  kind: "cloud",
  phase: state === "paused" ? "napping" : state === "unreachable" ? "running" : state,
  machineState: state === "gone" ? "gone" : null,
  reach: state === "gone" ? "gone" : state === "paused" ? "napping" : state === "unreachable" ? "unreachable" : "reachable",
  reason: null,
  wakeRefused: null,
  ...over,
});

function workspaceVerbs(over: Partial<WorkspaceVerbs> = {}): WorkspaceVerbs {
  return {
    togglePhase: vi.fn(async () => {}),
    openTerminal: vi.fn(async () => {}),
    openBrowser: vi.fn(),
    openMachine: vi.fn(),
    newThread: vi.fn(),
    copyText: vi.fn(async () => {}),
    rebuild: vi.fn(async () => {}),
    forget: vi.fn(),
    rename: vi.fn(),
    pickLook: vi.fn(),
    importProject: vi.fn(),
    exportProject: vi.fn(),
    ...over,
  };
}

const enabled = (actions: ReturnType<typeof resolveActions>) => actions.filter(a => a.refusal === null).map(a => a.id);
const titles = (actions: ReturnType<typeof resolveActions>) => actions.map(a => a.title);

describe("workspace actions", () => {
  it("a running workspace offers pause, terminal, browser, machine, new thread, the project trips, rename and copy id; fork, rebuild and forget carry their refusal", () => {
    const verbs = workspaceVerbs();
    const actions = resolveActions(workspaceActions, workspace("running"), verbs);
    expect(titles(actions)).toEqual([
      WORKSPACE_WORDS.pause,
      WORKSPACE_WORDS.rebuild,
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      WORKSPACE_WORDS.openMachine,
      WORKSPACE_WORDS.importProject,
      WORKSPACE_WORDS.exportProject,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.icon,
      WORKSPACE_WORDS.theme,
      WORKSPACE_WORDS.fork,
      WORKSPACE_WORDS.copyId,
      WORKSPACE_WORDS.forget,
    ]);
    expect(enabled(actions)).toEqual(["phase", "new-thread", "open-terminal", "open-browser", "open-machine", "import-project", "export-project", "rename", "icon", "theme", "copy-id"]);
    expect(actionById(actions, "rename").refusal).toBeNull();
    // A workspace name is this computer's own record, so the box opens whatever the machine is doing.
    expect(actionById(resolveActions(workspaceActions, workspace("gone"), verbs), "rename").refusal).toBeNull();
    // A client with no rename verb says so rather than opening a box nothing would take.
    expect(actionById(resolveActions(workspaceActions, workspace("running"), workspaceVerbs({ rename: undefined })), "rename").refusal).toBe("This client cannot rename workspaces");
    // The theme and the icon are the same record, so they open on a gone machine too; a client without the verb says so.
    for (const id of ["theme", "icon"]) {
      expect(actionById(resolveActions(workspaceActions, workspace("gone"), verbs), id).refusal).toBeNull();
      expect(actionById(resolveActions(workspaceActions, workspace("running"), workspaceVerbs({ pickLook: undefined })), id).refusal).toBe("This client cannot set a workspace's theme or icon");
    }
    actionById(actions, "icon").run();
    expect(verbs.pickLook).toHaveBeenCalledWith("ws_a", "glyph");
    actionById(actions, "theme").run();
    expect(verbs.pickLook).toHaveBeenCalledWith("ws_a", "theme");
    expect(actionById(actions, "fork").refusal).toBe("Running a copy of a workspace is not in the runtime yet; take a project snapshot in the Workspace tab and start a workspace from it");
    expect(actionById(actions, "rebuild").refusal).toBe("Rebuild replaces a machine wsp cannot get back; this one answers");
    expect(actionById(actions, "forget").refusal).toBe("Only a workspace whose computer is gone can be forgotten; this one is running");
  });

  it("pause and wake are one slot: the word follows the state, and the moving states refuse it with a word", () => {
    const verbs = workspaceVerbs();
    expect(actionById(resolveActions(workspaceActions, workspace("running"), verbs), "phase").title).toBe(WORKSPACE_WORDS.pause);
    expect(actionById(resolveActions(workspaceActions, workspace("unreachable"), verbs), "phase").title).toBe(WORKSPACE_WORDS.pause);
    const paused = actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "phase");
    expect(paused.title).toBe(WORKSPACE_WORDS.wake);
    expect(paused.refusal).toBeNull();
    expect(actionById(resolveActions(workspaceActions, workspace("pausing"), verbs), "phase").refusal).toBe("Workspace is pausing; it can be woken once it is paused");
    // A waking workspace is the one moving state with something to offer: the stop on the host's own asking again.
    const waking = actionById(resolveActions(workspaceActions, workspace("waking"), verbs), "phase");
    expect(waking.title).toBe(WORKSPACE_WORDS.stopWake);
    expect(waking.refusal).toBeNull();
    expect(waking.rowLabel).toBe("Stop api");
    expect(actionById(resolveActions(workspaceActions, workspace("gone"), verbs), "phase").refusal).toBe(goneRefusal("wake"));
  });

  it("this computer refuses the pause with the runtime's own sentence, wherever it is offered, and keeps every verb that is about threads", () => {
    const mac = workspace("running", { kind: "local", displayName: "zingzy-mac" });
    const actions = resolveActions(workspaceActions, mac, workspaceVerbs());
    expect(actionById(actions, "phase").refusal).toBe(undrivenRefusal("zingzy-mac", machineWord("local"), "be paused"));
    expect(actionById(actions, "new-thread").refusal).toBeNull();
    expect(actionById(actions, "open-terminal").refusal).toBeNull();
    expect(actionById(actions, "copy-id").refusal).toBeNull();
  });

  it("a gone workspace offers rebuild and forget and refuses the machine actions; a zombie offers rebuild alone; a client without the verbs says so", () => {
    const verbs = workspaceVerbs();
    const gone = resolveActions(workspaceActions, workspace("gone"), verbs);
    expect(enabled(gone)).toEqual(["rebuild", "open-machine", "rename", "icon", "theme", "copy-id", "forget"]);
    expect(actionById(gone, "new-thread").refusal).toBe("New threads wait for the rebuild");
    expect(actionById(gone, "open-terminal").refusal).toBe(goneRefusal("open a terminal"));
    expect(actionById(gone, "open-browser").refusal).toBe(goneRefusal("preview"));
    const zombie = resolveActions(workspaceActions, workspace("unreachable", { reach: "zombie" }), verbs);
    expect(actionById(zombie, "rebuild").refusal).toBeNull();
    expect(actionById(zombie, "forget").refusal).toBe("Only a workspace whose computer is gone can be forgotten; this one is unreachable");
    const bare = resolveActions(workspaceActions, workspace("gone"), workspaceVerbs({ rebuild: undefined, forget: undefined }));
    expect(actionById(bare, "rebuild").refusal).toBe("This client cannot rebuild workspaces");
    expect(actionById(bare, "forget").refusal).toBe("This client cannot forget workspaces");
    // The project trips: the machine must answer, and the client must have the folder ops; a browser tab without them says so.
    expect(actionById(gone, "import-project").refusal).toBe("Projects wait for the rebuild");
    expect(actionById(zombie, "export-project").refusal).toBe("Projects wait for the rebuild");
    expect(actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "import-project").refusal).toBeNull();
    const noTrips = resolveActions(workspaceActions, workspace("running"), workspaceVerbs({ importProject: undefined, exportProject: undefined }));
    expect(actionById(noTrips, "import-project").refusal).toBe("This client cannot import projects");
    expect(actionById(noTrips, "export-project").refusal).toBe("This client cannot export projects");
    expect(actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "open-browser").refusal).toBe("Workspace is paused; wake it to preview");
    expect(actionById(resolveActions(workspaceActions, workspace("waking"), verbs), "open-browser").refusal).toBe("Workspace is waking; previews open when it is running");
  });

  it("every handler reaches its verb with the workspace, and copy id copies the machine id", async () => {
    const verbs = workspaceVerbs();
    const actions = resolveActions(workspaceActions, workspace("running"), verbs);
    await actionById(actions, "phase").run();
    await actionById(actions, "new-thread").run();
    await actionById(actions, "open-terminal").run();
    await actionById(actions, "open-browser").run();
    await actionById(actions, "open-machine").run();
    await actionById(actions, "copy-id").run();
    await actionById(actions, "import-project").run();
    await actionById(actions, "export-project").run();
    expect(verbs.importProject).toHaveBeenCalledWith("ws_a");
    expect(verbs.exportProject).toHaveBeenCalledWith("ws_a");
    expect(verbs.togglePhase).toHaveBeenCalledWith("ws_a");
    expect(verbs.newThread).toHaveBeenCalledWith("ws_a");
    expect(verbs.openTerminal).toHaveBeenCalledWith("ws_a");
    expect(verbs.openBrowser).toHaveBeenCalledWith("ws_a");
    expect(verbs.openMachine).toHaveBeenCalledWith("ws_a");
    expect(verbs.copyText).toHaveBeenCalledWith("m_a");
    const gone = resolveActions(workspaceActions, workspace("gone"), verbs);
    await actionById(gone, "rebuild").run();
    await actionById(gone, "forget").run();
    expect(verbs.rebuild).toHaveBeenCalledWith("ws_a");
    expect(verbs.forget).toHaveBeenCalledWith("ws_a");
  });

  it("a button on the object's own surface reads its word, its icon and its hover text from the entry, so a button never says two things", () => {
    const verbs = workspaceVerbs();
    const phaseOf = (state: WorkspaceState, over: Partial<WorkspaceTarget> = {}) => actionById(resolveActions(workspaceActions, workspace(state, over), verbs), "phase");
    expect([phaseOf("running").buttonWord, phaseOf("unreachable").buttonWord, phaseOf("paused").buttonWord, phaseOf("gone").buttonWord]).toEqual(["Pause", "Pause", "Wake", "Wake"]);
    expect([phaseOf("pausing").buttonWord, phaseOf("waking").buttonWord]).toEqual(["Pausing…", "Stop"]);
    expect([phaseOf("running").icon, phaseOf("paused").icon, phaseOf("waking").icon]).toEqual([PauseIcon, PlayIcon, SquareIcon]);
    expect(phaseOf("running").hint).toBe("Suspend the VM and keep the disk");
    expect(phaseOf("paused").hint).toBe("Boot the VM from its disk");
    expect(phaseOf("waking").hint).toBe("Stop asking the provider to wake this workspace");
    // A record that still says running while the provider holds the machine paused reads Wake, as its label does.
    const behind = phaseOf("running", { machineState: "paused" });
    expect([behind.buttonWord, behind.rowLabel, behind.title]).toEqual(["Wake", "Wake api", WORKSPACE_WORDS.wake]);
    const gone = resolveActions(workspaceActions, workspace("gone", { reason: "machine m_a is gone at the provider: Not found" }), verbs);
    expect(actionById(gone, "forget").buttonWord).toBe("Forget");
    expect(actionById(gone, "forget").hint).toBe("Its computer is gone; forget the workspace to drop it from this computer");
    expect(actionById(gone, "rebuild").buttonWord).toBe("Rebuild");
    expect(actionById(gone, "rebuild").hint).toBe("machine m_a is gone at the provider: Not found");
    expect(actionById(resolveActions(workspaceActions, workspace("unreachable", { reach: "zombie" }), verbs), "rebuild").hint).toBe("The workspace answers nothing; rebuild it from the golden image");
    expect(actionById(gone, "copy-id").buttonWord).toBeNull();
    expect(actionById(gone, "copy-id").hint).toBeNull();
  });

  it("one target builder serves every surface: the status's phase, machine state, reach and reason lead, the record fills in", () => {
    const view: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_old", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z", gone: "the record's words" };
    const status: WorkspaceStatus = { ...view, machineId: "m_new", phase: "napping", machineState: "paused", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, reason: "the status's words" };
    expect(workspaceTarget(view, status)).toEqual({ id: "ws_a", displayName: "api", kind: "cloud", machineId: "m_new", phase: "napping", machineState: "paused", reach: "napping", reason: "the status's words", wakeRefused: null });
    expect(workspaceTarget(view, null)).toEqual({ id: "ws_a", displayName: "api", kind: "cloud", machineId: "m_old", phase: "running", machineState: null, reach: null, reason: "the record's words", wakeRefused: null });
    // The record's own wake words ride apart from the reason, which the next status push replaces.
    expect(workspaceTarget({ ...view, wakeRefused: "the provider answered none of 31 resume requests over 30m" }, null).wakeRefused).toBe("the provider answered none of 31 resume requests over 30m");
    // A record from before local workspaces existed carries no kind and reads as a fork; one that does keeps it.
    expect(workspaceTarget({ ...view, kind: "local" }, null).kind).toBe("local");
  });

  it("a paused machine the provider would not resume offers the rebuild beside the wake, with the record's own words on it", () => {
    const words = "the provider answered none of 31 resume requests over 30m; the work on this machine's disk stays with the provider, and a rebuild starts a new machine from the image";
    const target = workspace("paused", { wakeRefused: words });
    const actions = resolveActions(workspaceActions, target, workspaceVerbs());
    const rebuild = actionById(actions, "rebuild");
    expect(rebuild.refusal).toBeNull();
    expect(rebuild.hint).toBe(words);
    // The wake stands beside it: the fault is the provider's and may pass, so nothing takes the other road away.
    expect(actionById(actions, "phase").refusal).toBeNull();
    expect(actionById(actions, "phase").buttonWord).toBe("Wake");
    // The same machine before its wake ran out is refused the rebuild, in the sentence every surface refuses with.
    expect(actionById(resolveActions(workspaceActions, workspace("paused"), workspaceVerbs()), "rebuild").refusal).toBe(NO_REBUILD_NEEDED);
  });

  it("the row buttons' labels name the workspace, and the keybindings come from the one table", () => {
    const actions = resolveActions(workspaceActions, workspace("gone"), workspaceVerbs());
    expect(actionById(actions, "forget").rowLabel).toBe("Forget api");
    expect(actionById(actions, "rebuild").rowLabel).toBe("Rebuild api");
    expect(actionById(actions, "new-thread").rowLabel).toBe("New thread in api");
    expect(actionById(actions, "phase").rowLabel).toBe("Wake api");
    expect(actionById(resolveActions(workspaceActions, workspace("running"), workspaceVerbs()), "phase").rowLabel).toBe("Pause api");
    expect(actionById(actions, "open-terminal").shortcutCommand).toBe("terminal.toggle");
    expect(actionById(actions, "new-thread").shortcutCommand).toBe("chat.new");
    expect(actionById(actions, "open-browser").shortcutCommand).toBe("preview.toggle");
    expect(actionById(actions, "copy-id").shortcutCommand).toBeUndefined();
  });
});

describe("thread actions", () => {
  /** The agent's row as its machine answered it: renames is the adapter's answer there, as steers is. */
  const row = (harness: string, over: Partial<HarnessCatalog> = {}): HarnessCatalog => ({
    harness,
    label: harness === "claude" ? "Claude Code" : harness,
    source: "harness",
    version: "2.1.263",
    models: [],
    efforts: [],
    contextWindows: [],
    permissionModes: [],
    steers: false,
    renames: true,
    images: true,
    ...over,
  });
  const thread = (
    status: SessionStatus,
    threadId: string | null = "thr_1",
    harness = "claude",
    machine: { catalog?: HarnessCatalog | null; state?: WorkspaceState; goneWords?: string } = {},
    ran = true,
  ): ThreadTarget =>
    threadTarget(
      { id: "thr_1", sessionId: "s1", threadId, workspaceId: "ws_a", harness, title: "fix the port list", status, ran, startedAt: null, endedAt: null, indicator: null, startedBy: "person", project: null, parentThreadId: null, costUsd: null },
      { catalog: machine.catalog === undefined ? row(harness) : machine.catalog, state: machine.state ?? "running", ...(machine.goneWords !== undefined ? { goneWords: machine.goneWords } : {}) },
    );
  const threadVerbs = (over: Partial<ThreadVerbs> = {}): ThreadVerbs => ({ stop: vi.fn(async () => {}), rename: vi.fn(), forget: vi.fn(), copyText: vi.fn(async () => {}), ...over });

  it("a running thread offers stop, rename and copy link; forget carries the runtime's own refusal", async () => {
    const verbs = threadVerbs();
    const actions = resolveActions(threadActions, thread("running"), verbs);
    expect(titles(actions)).toEqual([THREAD_WORDS.stop, THREAD_WORDS.rename, THREAD_WORDS.copyLink, THREAD_WORDS.forget]);
    expect(enabled(actions)).toEqual(["stop", "rename", "copy-link"]);
    expect(actionById(actions, "forget").refusal).toBe(threadForgetRefusal("thr_1"));
    await actionById(actions, "stop").run();
    expect(verbs.stop).toHaveBeenCalledWith("s1");
    // The rename opens the name on the row the thread's own key names, which a new turn does not move.
    await actionById(actions, "rename").run();
    expect(verbs.rename).toHaveBeenCalledWith("thr_1");
  });

  it("a thread no turn ever ran on offers the forget, which names the thread and its workspace; a client without the verb says so", async () => {
    const verbs = threadVerbs();
    const never = thread("failed", "thr_1", "claude", {}, false);
    const actions = resolveActions(threadActions, never, verbs);
    expect(actionById(actions, "forget").refusal).toBeNull();
    await actionById(actions, "forget").run();
    expect(verbs.forget).toHaveBeenCalledWith({ threadId: "thr_1", workspaceId: "ws_a" });
    expect(actionById(resolveActions(threadActions, never, threadVerbs({ forget: undefined })), "forget").refusal).toBe("This client cannot forget a thread");
    // A row the runtime stamped no thread id on names nothing to forget.
    expect(actionById(resolveActions(threadActions, thread("completed", null, "claude", {}, false), threadVerbs()), "forget").refusal).toBe("This thread has no id yet");
  });

  it("a settled thread refuses stop; a client without the verb says so; a thread without an id has no link", () => {
    expect(actionById(resolveActions(threadActions, thread("completed"), threadVerbs()), "stop").refusal).toBe("Thread is not running");
    expect(actionById(resolveActions(threadActions, thread("running"), threadVerbs({ stop: undefined })), "stop").refusal).toBe("This client cannot stop a turn");
    expect(actionById(resolveActions(threadActions, thread("running", null), threadVerbs()), "copy-link").refusal).toBe("This thread has no id yet");
  });

  it("reads whether a name is kept off the agent's own catalog row, and a row the runtime's table stood in for is no answer", () => {
    const renameOf = (target: ThreadTarget, over: Partial<ThreadVerbs> = {}): string | null =>
      actionById(resolveActions(threadActions, target, threadVerbs(over)), "rename").refusal;
    expect(renameOf(thread("completed"))).toBeNull();
    expect(renameOf(thread("completed", "thr_1", "codex", { catalog: row("codex") }))).toBeNull();
    // The machine answered no for this agent: nothing offers the rename.
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: row("gemini", { renames: false }) }))).toBe("Rename in Gemini CLI is not kept");
    // Nobody has asked that machine yet: the box opens and the runtime answers.
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: row("gemini", { renames: false, source: "table" }) }))).toBeNull();
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: null }))).toBeNull();
    // The agent keeps a name and this client has no row to edit: that is the client's own refusal.
    expect(renameOf(thread("completed"), { rename: undefined })).toBe("This client cannot rename a thread");
    // An agent that keeps none refuses whatever the client has.
    expect(renameOf(thread("completed", "thr_1", "gemini", { catalog: row("gemini", { renames: false }) }), { rename: undefined })).toBe("Rename in Gemini CLI is not kept");
  });

  it("a machine that is napping is woken by the rename itself, so only one that is gone refuses before the box opens", () => {
    const renameOf = (state: WorkspaceState, goneWords?: string): string | null =>
      actionById(resolveActions(threadActions, thread("completed", "thr_1", "claude", { state, ...(goneWords !== undefined ? { goneWords } : {}) }), threadVerbs()), "rename").refusal;
    expect(renameOf("paused")).toBeNull();
    expect(renameOf("waking")).toBeNull();
    expect(renameOf("unreachable")).toBeNull();
    expect(renameOf("gone")).toBe("Workspace machine is gone; rebuild it to rename");
    expect(renameOf("gone", "machine m1 is gone at the provider")).toBe("Workspace machine is gone; rebuild it to rename (machine m1 is gone at the provider)");
  });

  it("copy link writes the page's address for the thread", async () => {
    const verbs = threadVerbs();
    await actionById(resolveActions(threadActions, thread("completed"), verbs), "copy-link").run();
    expect(verbs.copyText).toHaveBeenCalledWith(`${window.location.origin}${window.location.pathname}#w/ws_a/t/thr_1`);
  });
});

describe("file actions", () => {
  const fileVerbs = (): FileVerbs => ({ open: vi.fn(), revealInDiff: vi.fn(), copyText: vi.fn(async () => {}) });

  it("a file opens, shows in the diff and copies its path; a folder copies its path alone", async () => {
    const verbs = fileVerbs();
    const file = resolveActions(fileActions, { path: "/root/src/a.ts", kind: "file" }, verbs);
    expect(titles(file)).toEqual([FILE_WORDS.open, FILE_WORDS.showDiff, FILE_WORDS.copyPath]);
    expect(enabled(file)).toEqual(["open", "show-diff", "copy-path"]);
    await actionById(file, "open").run();
    await actionById(file, "show-diff").run();
    await actionById(file, "copy-path").run();
    expect(verbs.open).toHaveBeenCalledWith("/root/src/a.ts");
    expect(verbs.revealInDiff).toHaveBeenCalledWith("/root/src/a.ts");
    expect(verbs.copyText).toHaveBeenCalledWith("/root/src/a.ts");
    const folder = resolveActions(fileActions, { path: "/root/src", kind: "directory" }, verbs);
    expect(enabled(folder)).toEqual(["copy-path"]);
    expect(actionById(folder, "open").refusal).toBe("A folder opens in the tree");
    expect(actionById(folder, "show-diff").refusal).toBe("Only a file has a diff");
  });
});

describe("terminal actions", () => {
  const terminalVerbs = (over: Partial<TerminalVerbs> = {}): TerminalVerbs => ({
    copy: vi.fn(async () => {}),
    paste: vi.fn(async () => {}),
    clear: vi.fn(),
    split: vi.fn(),
    splitVertical: vi.fn(),
    newTerminal: vi.fn(),
    close: vi.fn(),
    ...over,
  });

  it("copy needs a selection, split needs room, paste needs a clipboard, and the chords come from the one table", async () => {
    const verbs = terminalVerbs();
    const actions = resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, verbs);
    expect(titles(actions)).toEqual([TERMINAL_WORDS.copy, TERMINAL_WORDS.paste, TERMINAL_WORDS.clear, TERMINAL_WORDS.split, TERMINAL_WORDS.splitVertical, TERMINAL_WORDS.new, TERMINAL_WORDS.close]);
    expect(actionById(actions, "copy").refusal).toBe("Nothing is selected");
    expect(enabled(actions)).toEqual(["paste", "clear", "split", "split-vertical", "new", "close"]);
    const full = resolveActions(terminalActions, { hasSelection: true, atSplitLimit: true }, verbs);
    expect(actionById(full, "copy").refusal).toBeNull();
    expect(actionById(full, "split").refusal).toBe(`max ${MAX_TERMINALS_PER_GROUP} per group`);
    expect(actionById(full, "split-vertical").refusal).toBe(`max ${MAX_TERMINALS_PER_GROUP} per group`);
    expect(actionById(resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, terminalVerbs({ paste: undefined })), "paste").refusal).toBe("The clipboard cannot be read here");
    const toolbar = resolveActions(terminalActions, { hasSelection: true, atSplitLimit: false }, terminalVerbs({ copy: undefined, clear: undefined }));
    expect(actionById(toolbar, "copy").refusal).toBe("No terminal is active");
    expect(actionById(toolbar, "clear").refusal).toBe("No terminal is active");
    expect(actionById(actions, "split").shortcutCommand).toBe("terminal.split");
    expect(actionById(actions, "new").shortcutCommand).toBe("terminal.new");
    for (const id of ["paste", "clear", "split", "split-vertical", "new", "close"]) await actionById(actions, id).run();
    await actionById(full, "copy").run();
    for (const verb of Object.values(verbs)) expect(verb).toHaveBeenCalledTimes(1);
  });
});

describe("menu items from actions", () => {
  it("carry the label, the group, the enabled bit, the refusal and the chord for the platform", () => {
    const items = toMenuItems(resolveActions(workspaceActions, workspace("paused"), workspaceVerbs()), DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" });
    expect(items.map(i => [i.id, i.label, i.group, i.enabled])).toEqual([
      ["phase", WORKSPACE_WORDS.wake, "state", true],
      ["rebuild", WORKSPACE_WORDS.rebuild, "state", false],
      ["new-thread", WORKSPACE_WORDS.newThread, "open", true],
      ["open-terminal", WORKSPACE_WORDS.openTerminal, "open", true],
      ["open-browser", WORKSPACE_WORDS.openBrowser, "open", false],
      ["open-machine", WORKSPACE_WORDS.openMachine, "open", true],
      ["import-project", WORKSPACE_WORDS.importProject, "project", true],
      ["export-project", WORKSPACE_WORDS.exportProject, "project", true],
      ["rename", WORKSPACE_WORDS.rename, "edit", true],
      ["icon", WORKSPACE_WORDS.icon, "edit", true],
      ["theme", WORKSPACE_WORDS.theme, "edit", true],
      ["fork", WORKSPACE_WORDS.fork, "edit", false],
      ["copy-id", WORKSPACE_WORDS.copyId, "copy", true],
      ["forget", WORKSPACE_WORDS.forget, "remove", false],
    ]);
    expect(items.find(i => i.id === "open-browser")?.refusal).toBe("Workspace is paused; wake it to preview");
    expect(items.find(i => i.id === "open-terminal")).toMatchObject({ shortcut: "⌘J", accelerator: "CommandOrControl+J" });
    expect(items.find(i => i.id === "new-thread")).toMatchObject({ shortcut: "⌘N", accelerator: "CommandOrControl+N" });
    expect(items.find(i => i.id === "phase")).not.toHaveProperty("shortcut");
    expect(items.find(i => i.id === "phase")).not.toHaveProperty("refusal");
    expect(items.find(i => i.id === "forget")?.destructive).toBe(true);
    const linux = toMenuItems(resolveActions(workspaceActions, workspace("paused"), workspaceVerbs()), DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux x86_64" });
    expect(linux.find(i => i.id === "open-terminal")).toMatchObject({ shortcut: "Ctrl+J", accelerator: "CommandOrControl+J" });
    // A terminal's chords are bound while a terminal has focus; read without that context they are nobody's.
    const terminal = resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, { split: () => {}, splitVertical: () => {}, newTerminal: () => {}, close: () => {} });
    expect(toMenuItems(terminal, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }).find(i => i.id === "split")).not.toHaveProperty("shortcut");
    expect(toMenuItems(terminal, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel", context: { terminalFocus: true } }).find(i => i.id === "split")).toMatchObject({ shortcut: "⌘D", accelerator: "CommandOrControl+D" });
  });
});

describe("placing the in-app menu", () => {
  const viewport = { width: 1000, height: 600 };

  it("opens at the pointer when it fits", () => {
    expect(placeMenu({ x: 100, y: 200 }, { width: 180, height: 240 }, viewport)).toEqual({ left: 100, top: 200 });
  });

  it("flips left of the pointer and up from it when the edge is near, and never leaves the margin", () => {
    expect(placeMenu({ x: 900, y: 500 }, { width: 180, height: 240 }, viewport)).toEqual({ left: 720, top: 260 });
    expect(placeMenu({ x: 990, y: 590 }, { width: 2000, height: 2000 }, viewport)).toEqual({ left: 8, top: 8 });
  });
});

describe("the Workspaces section registry", () => {
  const target = (over: Partial<SidebarTarget> = {}): SidebarTarget => ({ mode: "list", hasLocal: false, connected: true, ...over });
  const verbs = (): SidebarVerbs & { calls: string[] } => {
    const calls: string[] = [];
    return { calls, setMode: mode => calls.push(`mode:${mode}`), newLocal: () => calls.push("newLocal") };
  };

  it("offers one road to this computer, saying whether the pick makes it or goes to the one there is", () => {
    const row = (over?: Partial<SidebarTarget>) => actionById(resolveActions(sidebarActions, target(over), verbs()), NEW_LOCAL_ACTION)!;
    expect(row().title).toBe("This computer");
    expect(row().hint).toBe(THIS_COMPUTER_HINTS.fresh);
    expect(row().refusal).toBeNull();
    // One per host: the second pick is a selection, and the row says so rather than offering a second create.
    expect(row({ hasLocal: true }).hint).toBe(THIS_COMPUTER_HINTS.existing);
    expect(row({ hasLocal: true }).refusal).toBeNull();
    // Nothing to ask while there is no host to ask.
    expect(row({ connected: false }).refusal).toBe(THIS_COMPUTER_HINTS.offline);
  });

  it("running it asks the store, and the mode row still runs the toggle: one registry, two rows", () => {
    const v = verbs();
    const rows = resolveActions(sidebarActions, target(), v);
    actionById(rows, NEW_LOCAL_ACTION)!.run();
    actionById(rows, SIDEBAR_MODE_ACTION)!.run();
    expect(v.calls).toEqual(["newLocal", "mode:spaces"]);
  });

  it("both rows reach the palette and the section menu from the same list, so neither can say two things", () => {
    const ids = resolveActions(sidebarActions, target(), verbs()).map(a => a.id);
    expect(ids).toEqual([SIDEBAR_MODE_ACTION, NEW_LOCAL_ACTION]);
    const menu = toMenuItems(resolveActions(sidebarActions, target(), verbs()), DEFAULT_RESOLVED_KEYBINDINGS);
    expect(menu.map(item => [item.label, item.group, item.enabled])).toEqual([
      [SIDEBAR_MODE_WORDS.spaces.title, "view", true],
      ["This computer", "create", true],
    ]);
    // A row the host cannot answer carries its refusal into the menu rather than reading as available.
    expect(toMenuItems(resolveActions(sidebarActions, target({ connected: false }), verbs()), DEFAULT_RESOLVED_KEYBINDINGS).at(-1)).toMatchObject({
      enabled: false,
      refusal: THIS_COMPUTER_HINTS.offline,
    });
  });
});
