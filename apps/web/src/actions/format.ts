// SPDX-License-Identifier: AGPL-3.0-only
// The words every action carries: its title as the palette and the menus
// show it, the label a row button on the object's own row wears, and the one
// sentence for why it cannot run right now. Every surface reads these, so a
// menu, a palette row and a button never say two things about one action.
import { agentName } from "@wsp/catalog";
import { actionRefusal, goneRefusal, isBilling, keepsRename, workspaceWord, type HarnessCatalog, type SessionRenameOutcome, type SidebarMode, type WorkspaceState } from "@wsp/protocol";
import { MAX_TERMINALS_PER_GROUP } from "../terminal/groups.js";

export const WORKSPACE_WORDS = {
  pause: "Pause workspace",
  wake: "Wake workspace",
  rebuild: "Rebuild machine",
  newThread: "New thread",
  openTerminal: "Open terminal",
  openBrowser: "Open browser",
  openMachine: "Open machine",
  importProject: "Import project",
  exportProject: "Export project",
  rename: "Rename workspace",
  fork: "Fork workspace",
  copyId: "Copy machine id",
  forget: "Forget workspace",
} as const;

/** The sidebar's two bodies, keyed by mode: the body's name as the settings page lists it, the toggle's words as the
 * palette and the Workspaces section menu name a pick that moves to it, and the sentence under both for what it shows. */
export const SIDEBAR_MODE_WORDS: Record<SidebarMode, { readonly name: string; readonly title: string; readonly hint: string }> = {
  spaces: { name: "Spaces", title: "Show Spaces", hint: "One workspace at a time, with a dot per workspace at the bottom" },
  list: { name: "List", title: "Show the workspace list", hint: "Every workspace and its threads" },
};

export const THREAD_WORDS = {
  stop: "Stop thread",
  rename: "Rename thread",
  copyLink: "Copy thread link",
  delete: "Delete thread",
} as const;

export const FILE_WORDS = {
  open: "Open file",
  showDiff: "Show in diff",
  copyPath: "Copy path",
} as const;

export const TERMINAL_WORDS = {
  copy: "Copy",
  paste: "Paste",
  clear: "Clear",
  split: "Split Terminal Horizontally",
  splitVertical: "Split Terminal Vertically",
  new: "New Terminal",
  close: "Close Terminal",
} as const;

/** Pause and wake are one slot: a machine that is up offers the pause, every other state the wake, and the moving
 * states refuse it with a word. */
export function phaseWord(state: WorkspaceState): string {
  return isBilling(state) ? WORKSPACE_WORDS.pause : WORKSPACE_WORDS.wake;
}

/** The word the phase button on the machine's own surface shows: the verb, or the moving state while it moves. */
export function phaseButtonWord(state: WorkspaceState): string {
  switch (state) {
    case "running":
    case "unreachable":
      return "Pause";
    case "paused":
    case "gone":
      return "Wake";
    case "pausing":
      return "Pausing…";
    case "waking":
      return "Waking…";
    default: {
      const _exhaustive: never = state;
      return "";
    }
  }
}

export const phaseHint = (state: WorkspaceState): string => (isBilling(state) ? "Suspend the VM and keep the disk" : "Boot the VM from its disk");
export const FORGET_HINT = "The machine is gone; forget the workspace to drop it from this computer";
export const REBUILD_HINT = "The machine answers nothing; rebuild it from the golden image";

export function phaseRefusal(state: WorkspaceState): string | null {
  switch (state) {
    case "running":
    case "unreachable":
    case "paused":
      return null;
    case "pausing":
      return "Workspace is pausing; it can be woken once it is paused";
    case "waking":
      return "Workspace is waking";
    case "gone":
      return goneRefusal("wake");
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

export const NO_REBUILD_NEEDED = "Rebuild replaces a gone or zombie machine; this one answers";
export const CLIENT_CANNOT_REBUILD = "This client cannot rebuild machines";
export const CLIENT_CANNOT_FORGET = "This client cannot forget workspaces";
export const NEW_THREAD_WAITS = "New threads wait for the rebuild";
export const PROJECTS_WAIT = "Projects wait for the rebuild";
export const CLIENT_CANNOT_IMPORT = "This client cannot import projects";
export const CLIENT_CANNOT_EXPORT = "This client cannot export projects";
export const CLIENT_CANNOT_RENAME_WORKSPACE = "This client cannot rename workspaces";
export const NO_WORKSPACE_FORK = "Forking a workspace is not in the runtime yet; take a project snapshot in the Machine tab and start a workspace from it";

export function forgetRefusal(state: WorkspaceState): string | null {
  return state === "gone" ? null : `Only a workspace whose machine is gone can be forgotten; this one is ${workspaceWord(state).toLowerCase()}`;
}

export const openTerminalRefusal = (state: WorkspaceState): string | null => (state === "gone" ? goneRefusal("open a terminal") : null);
export const openBrowserRefusal = (state: WorkspaceState): string | null => actionRefusal(state, "preview");

export const THREAD_NOT_RUNNING = "Thread is not running";
export const CLIENT_CANNOT_STOP = "This client cannot stop a turn";
export const THREAD_HAS_NO_ID = "This thread has no id yet";
export const CLIENT_CANNOT_RENAME = "This client cannot rename a thread";
export const NO_THREAD_DELETE = "Deleting a thread is not in the runtime yet";

/** The one sentence for an agent whose own store keeps no name of a person's: a rename there would be gone at the
 * thread's next turn, so nothing offers one. The refusal and the toast both read it. */
export const notKeptLine = (harness: string): string => `Rename in ${agentName(harness)} is not kept`;

/** Why the rename cannot run, or null when it can. The harness's own catalog row answers whether a name is kept, as
 * it answers whether a turn steers; a row the runtime's table stood in for is no answer, so the box opens and the
 * runtime says. A machine that is not up is woken by the rename itself, as the command line's own rename does, so
 * only a machine that cannot be woken at all refuses here. */
export function threadRenameRefusal(opts: { catalog: HarnessCatalog | null; harness: string; state: WorkspaceState; goneWords?: string; hasVerb: boolean }): string | null {
  if (!keepsRename(opts.catalog)) return notKeptLine(opts.harness);
  if (!opts.hasVerb) return CLIENT_CANNOT_RENAME;
  return opts.state === "gone" ? goneRefusal("rename", opts.goneWords) : null;
}

/** What the toast says when the runtime named nothing: the answer in the person's words, never the enum, and the
 * machine's own line where the store refused the write, since nothing else is known about it then. */
export function renameNotTakenLine(harness: string, outcome: Exclude<SessionRenameOutcome, "renamed">, error?: string): string {
  switch (outcome) {
    case "unsupported":
      return notKeptLine(harness);
    case "no-session":
      return `${agentName(harness)} on the machine has no session for this thread yet`;
    case "failed":
      return error ?? "The machine said nothing about the write";
    case "not-found":
      return "The runtime has no such thread any more";
    default: {
      const _exhaustive: never = outcome;
      return "";
    }
  }
}

export const FOLDER_OPENS_IN_TREE = "A folder opens in the tree";
export const ONLY_FILES_HAVE_DIFFS = "Only a file has a diff";

export const NOTHING_SELECTED = "Nothing is selected";
export const NO_CLIPBOARD_READ = "The clipboard cannot be read here";
export const NO_TERMINAL = "No terminal is active";
export const SPLIT_LIMIT = `max ${MAX_TERMINALS_PER_GROUP} per group`;

/** A thread link named a thread the workspace's list does not carry; the workspace opened instead. */
export const noSuchThreadLine = (threadId: string): string => `No thread ${threadId} in this workspace; opened the workspace instead`;

/** Show in diff asked for a file the diff does not touch. */
export const noDiffLine = (fileName: string, scopeLabel: string): string => `${fileName} has no diff in ${scopeLabel.toLowerCase()}`;

/** A row button on the object's own row names the object: Forget api, New thread in api. */
export const rowVerb = (verb: string, name: string): string => `${verb} ${name}`;
export const rowNewThread = (name: string): string => `New thread in ${name}`;
