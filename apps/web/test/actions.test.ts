// SPDX-License-Identifier: AGPL-3.0-only
// One action registry per object kind: every entry carries its words, its
// enabled rule from the object's state, its keybinding and its handler, and
// the palette, the row buttons, the Machine tab and the context menus all
// read the same list. These tests pin the rules per kind and the shapes the
// menus are built from.
import { PauseIcon, PlayIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { goneRefusal, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { fileActions, type FileVerbs } from "../src/actions/fileActions.js";
import { FILE_WORDS, TERMINAL_WORDS, THREAD_WORDS, WORKSPACE_WORDS } from "../src/actions/format.js";
import { placeMenu } from "../src/actions/menuPlacement.js";
import { actionById, resolveActions, toMenuItems } from "../src/actions/registry.js";
import { terminalActions, type TerminalVerbs } from "../src/actions/terminalActions.js";
import { threadActions, type ThreadVerbs } from "../src/actions/threadActions.js";
import { workspaceActions, workspaceTarget, type WorkspaceTarget, type WorkspaceVerbs } from "../src/actions/workspaceActions.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { MAX_TERMINALS_PER_GROUP } from "../src/terminal/groups.js";

/** A target in one folded state, spelled as the phase, machine state and reach that fold to it. */
const workspace = (state: WorkspaceState, over: Partial<WorkspaceTarget> = {}): WorkspaceTarget => ({
  id: "ws_a",
  displayName: "api",
  machineId: "m_a",
  phase: state === "paused" ? "napping" : state === "unreachable" ? "running" : state,
  machineState: state === "gone" ? "gone" : null,
  reach: state === "gone" ? "gone" : state === "paused" ? "napping" : state === "unreachable" ? "unreachable" : "reachable",
  reason: null,
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
    importProject: vi.fn(),
    exportProject: vi.fn(),
    ...over,
  };
}

const enabled = (actions: ReturnType<typeof resolveActions>) => actions.filter(a => a.refusal === null).map(a => a.id);
const titles = (actions: ReturnType<typeof resolveActions>) => actions.map(a => a.title);

describe("workspace actions", () => {
  it("a running workspace offers pause, terminal, browser, machine, new thread, the project trips and copy id; rename, fork, rebuild and forget carry their refusal", () => {
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
      WORKSPACE_WORDS.fork,
      WORKSPACE_WORDS.copyId,
      WORKSPACE_WORDS.forget,
    ]);
    expect(enabled(actions)).toEqual(["phase", "new-thread", "open-terminal", "open-browser", "open-machine", "import-project", "export-project", "copy-id"]);
    expect(actionById(actions, "rename").refusal).toBe("Renaming is not in the runtime yet");
    expect(actionById(actions, "fork").refusal).toBe("Forking a workspace is not in the runtime yet; take a project snapshot in the Machine tab and start a workspace from it");
    expect(actionById(actions, "rebuild").refusal).toBe("Rebuild replaces a gone or zombie machine; this one answers");
    expect(actionById(actions, "forget").refusal).toBe("Only a workspace whose machine is gone can be forgotten; this one is running");
  });

  it("pause and wake are one slot: the word follows the state, and the moving states refuse it with a word", () => {
    const verbs = workspaceVerbs();
    expect(actionById(resolveActions(workspaceActions, workspace("running"), verbs), "phase").title).toBe(WORKSPACE_WORDS.pause);
    expect(actionById(resolveActions(workspaceActions, workspace("unreachable"), verbs), "phase").title).toBe(WORKSPACE_WORDS.pause);
    const paused = actionById(resolveActions(workspaceActions, workspace("paused"), verbs), "phase");
    expect(paused.title).toBe(WORKSPACE_WORDS.wake);
    expect(paused.refusal).toBeNull();
    expect(actionById(resolveActions(workspaceActions, workspace("pausing"), verbs), "phase").refusal).toBe("Workspace is pausing; it can be woken once it is paused");
    const waking = actionById(resolveActions(workspaceActions, workspace("waking"), verbs), "phase");
    expect(waking.title).toBe(WORKSPACE_WORDS.wake);
    expect(waking.refusal).toBe("Workspace is waking");
    expect(actionById(resolveActions(workspaceActions, workspace("gone"), verbs), "phase").refusal).toBe(goneRefusal("wake"));
  });

  it("a gone workspace offers rebuild and forget and refuses the machine actions; a zombie offers rebuild alone; a client without the verbs says so", () => {
    const verbs = workspaceVerbs();
    const gone = resolveActions(workspaceActions, workspace("gone"), verbs);
    expect(enabled(gone)).toEqual(["rebuild", "open-machine", "copy-id", "forget"]);
    expect(actionById(gone, "new-thread").refusal).toBe("New threads wait for the rebuild");
    expect(actionById(gone, "open-terminal").refusal).toBe(goneRefusal("open a terminal"));
    expect(actionById(gone, "open-browser").refusal).toBe(goneRefusal("preview"));
    const zombie = resolveActions(workspaceActions, workspace("unreachable", { reach: "zombie" }), verbs);
    expect(actionById(zombie, "rebuild").refusal).toBeNull();
    expect(actionById(zombie, "forget").refusal).toBe("Only a workspace whose machine is gone can be forgotten; this one is unreachable");
    const bare = resolveActions(workspaceActions, workspace("gone"), workspaceVerbs({ rebuild: undefined, forget: undefined }));
    expect(actionById(bare, "rebuild").refusal).toBe("This client cannot rebuild machines");
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
    expect([phaseOf("pausing").buttonWord, phaseOf("waking").buttonWord]).toEqual(["Pausing…", "Waking…"]);
    expect([phaseOf("running").icon, phaseOf("paused").icon, phaseOf("waking").icon]).toEqual([PauseIcon, PlayIcon, PlayIcon]);
    expect(phaseOf("running").hint).toBe("Suspend the VM and keep the disk");
    expect(phaseOf("paused").hint).toBe("Boot the VM from its disk");
    // A record that still says running while the provider holds the machine paused reads Wake, as its label does.
    const behind = phaseOf("running", { machineState: "paused" });
    expect([behind.buttonWord, behind.rowLabel, behind.title]).toEqual(["Wake", "Wake api", WORKSPACE_WORDS.wake]);
    const gone = resolveActions(workspaceActions, workspace("gone", { reason: "machine m_a is gone at the provider: Not found" }), verbs);
    expect(actionById(gone, "forget").buttonWord).toBe("Forget");
    expect(actionById(gone, "forget").hint).toBe("The machine is gone; forget the workspace to drop it from this computer");
    expect(actionById(gone, "rebuild").buttonWord).toBe("Rebuild");
    expect(actionById(gone, "rebuild").hint).toBe("machine m_a is gone at the provider: Not found");
    expect(actionById(resolveActions(workspaceActions, workspace("unreachable", { reach: "zombie" }), verbs), "rebuild").hint).toBe("The machine answers nothing; rebuild it from the golden image");
    expect(actionById(gone, "copy-id").buttonWord).toBeNull();
    expect(actionById(gone, "copy-id").hint).toBeNull();
  });

  it("one target builder serves every surface: the status's phase, machine state, reach and reason lead, the record fills in", () => {
    const view: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_old", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z", gone: "the record's words" };
    const status: WorkspaceStatus = { ...view, machineId: "m_new", phase: "napping", machineState: "paused", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, reason: "the status's words" };
    expect(workspaceTarget(view, status)).toEqual({ id: "ws_a", displayName: "api", machineId: "m_new", phase: "napping", machineState: "paused", reach: "napping", reason: "the status's words" });
    expect(workspaceTarget(view, null)).toEqual({ id: "ws_a", displayName: "api", machineId: "m_old", phase: "running", machineState: null, reach: null, reason: "the record's words" });
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
  const thread = (status: "running" | "completed", threadId: string | null = "thr_1", harness = "claude") => ({ sessionId: "s1", threadId, workspaceId: "ws_a", harness, title: "fix the port list", status });
  const threadVerbs = (over: Partial<ThreadVerbs> = {}): ThreadVerbs => ({ stop: vi.fn(async () => {}), rename: vi.fn(), copyText: vi.fn(async () => {}), ...over });

  it("a running thread offers stop, rename and copy link; delete carries its refusal", async () => {
    const verbs = threadVerbs();
    const actions = resolveActions(threadActions, thread("running"), verbs);
    expect(titles(actions)).toEqual([THREAD_WORDS.stop, THREAD_WORDS.rename, THREAD_WORDS.copyLink, THREAD_WORDS.delete]);
    expect(enabled(actions)).toEqual(["stop", "rename", "copy-link"]);
    expect(actionById(actions, "delete").refusal).toBe("Deleting a thread is not in the runtime yet");
    await actionById(actions, "stop").run();
    expect(verbs.stop).toHaveBeenCalledWith("s1");
    // The rename opens the name on the row the session id names; the row sends it.
    await actionById(actions, "rename").run();
    expect(verbs.rename).toHaveBeenCalledWith("s1");
  });

  it("a settled thread refuses stop; a client without the verb says so; a thread without an id has no link", () => {
    expect(actionById(resolveActions(threadActions, thread("completed"), threadVerbs()), "stop").refusal).toBe("Thread is not running");
    expect(actionById(resolveActions(threadActions, thread("running"), threadVerbs({ stop: undefined })), "stop").refusal).toBe("This client cannot stop a turn");
    expect(actionById(resolveActions(threadActions, thread("running", null), threadVerbs()), "copy-link").refusal).toBe("This thread has no id yet");
  });

  it("says the rename is not kept for an agent whose own store keeps no name, and names that agent; a client with nowhere to type says that instead", () => {
    const renameOf = (harness: string, over: Partial<ThreadVerbs> = {}): string | null =>
      actionById(resolveActions(threadActions, thread("completed", "thr_1", harness), threadVerbs(over)), "rename").refusal;
    expect(renameOf("claude")).toBeNull();
    expect(renameOf("codex")).toBeNull();
    expect(renameOf("gemini")).toBe("Rename in Gemini CLI is not kept");
    // The agent keeps a name and this client has no row to edit: that is the client's own refusal.
    expect(renameOf("claude", { rename: undefined })).toBe("This client cannot rename a thread");
    // An agent that keeps none refuses whatever the client has.
    expect(renameOf("gemini", { rename: undefined })).toBe("Rename in Gemini CLI is not kept");
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
      ["rename", WORKSPACE_WORDS.rename, "edit", false],
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
