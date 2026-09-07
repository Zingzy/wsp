// SPDX-License-Identifier: AGPL-3.0-only
// The words every action carries: its title as the palette and the menus
// show it, the label a row button on the object's own row wears, and the one
// sentence for why it cannot run right now. Every surface reads these, so a
// menu, a palette row and a button never say two things about one action.
import { agentName, keepsRename } from "@wsp/catalog";
import { actionRefusal, goneRefusal, isBilling, workspaceWord, type WorkspaceState } from "@wsp/protocol";
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
export const NO_WORKSPACE_RENAME = "Renaming is not in the runtime yet";
export const NO_WORKSPACE_FORK = "Forking a workspace is not in the runtime yet; take a project snapshot in the Machine tab and start a workspace from it";

export function forgetRefusal(state: WorkspaceState): string | null {
  return state === "gone" ? null : `Only a workspace whose machine is gone can be forgotten; this one is ${workspaceWord(state).toLowerCase()}`;
}

export const openTerminalRefusal = (state: WorkspaceState): string | null => (state === "gone" ? goneRefusal("open a terminal") : null);
export const openBrowserRefusal = (state: WorkspaceState): string | null => actionRefusal(state, "preview");

export const THREAD_NOT_RUNNING = "Thread is not running";
export const CLIENT_CANNOT_STOP = "This client cannot stop a turn";
export const THREAD_HAS_NO_ID = "This thread has no id yet";
export const RENAME_NEEDS_COMMAND_LINE = "No rename box here yet; wsp thread rename names a thread";
export const NO_THREAD_DELETE = "Deleting a thread is not in the runtime yet";

/** Why the rename cannot run, per agent: an agent whose own store keeps no name of a person's would lose it at the
 * thread's next turn, so no client offers one there; where the store does keep one, this app has nowhere to type the
 * name yet and the command line does it. */
export function threadRenameRefusal(harness: string): string {
  return keepsRename(harness) ? RENAME_NEEDS_COMMAND_LINE : `Rename in ${agentName(harness)} is not kept`;
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
