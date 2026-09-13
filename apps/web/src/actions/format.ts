// SPDX-License-Identifier: AGPL-3.0-only
// The words every action carries: its title as the palette and the menus
// show it, the label a row button on the object's own row wears, and the one
// sentence for why it cannot run right now. Every surface reads these, so a
// menu, a palette row and a button never say two things about one action.
import { agentName } from "@wsp/catalog";
import { actionRefusal, goneRefusal, isBilling, keepsRename, notAnsweringYet, threadForgetRefusal, workspaceWord, type HarnessCatalog, type SessionRenameOutcome, type SidebarMode, type WorkspaceState } from "@wsp/protocol";
import { MAX_TERMINALS_PER_GROUP } from "../terminal/groups.js";

export const WORKSPACE_WORDS = {
  pause: "Pause workspace",
  wake: "Wake workspace",
  stopWake: "Stop waking",
  rebuild: "Rebuild workspace",
  newThread: "New thread",
  openTerminal: "Open terminal",
  openBrowser: "Open browser",
  openMachine: "Open the workspace pane",
  importProject: "Import project",
  exportProject: "Export project",
  rename: "Rename workspace",
  theme: "Edit theme colour",
  icon: "Change icon",
  fork: "Run a copy",
  copyId: "Copy computer id",
  forget: "Forget workspace",
  startDaemon: "Start the daemon",
} as const;

/** The sidebar's two bodies, keyed by mode: the body's name as the settings page lists it, the toggle's words as the
 * palette and the Workspaces section menu name a pick that moves to it, and the sentence under both for what it shows. */
export const SIDEBAR_MODE_WORDS: Record<SidebarMode, { readonly name: string; readonly title: string; readonly hint: string }> = {
  spaces: { name: "Spaces", title: "Show Spaces", hint: "One workspace at a time, with an icon per workspace at the bottom" },
  list: { name: "List", title: "Show the workspace list", hint: "Every workspace and its threads" },
};

/** What the creation log and the sidebar's creation row say before the runtime's first stage line lands; one
 * sentence in one place, since both surfaces stand in for the same silence. */
export const CREATION_ASKED = "Asking wsp to start it.";

export const THREAD_WORDS = {
  stop: "Stop thread",
  rename: "Rename thread",
  copyLink: "Copy thread link",
  forget: "Forget thread",
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

/** Pause, wake and the stop are one slot: a machine that is up offers the pause, one the host is still asking the
 * provider for offers the stop, and every other state the wake. */
export function phaseWord(state: WorkspaceState): string {
  if (state === "waking") return WORKSPACE_WORDS.stopWake;
  return isBilling(state) ? WORKSPACE_WORDS.pause : WORKSPACE_WORDS.wake;
}

/** The phase slot's two words per state: what its button offers, and the verb a machine that cannot take the move
 * is refused for, in the runtime's own words. One table, so a state whose button changes cannot leave the refusal
 * beside it naming the other verb. */
const PHASE_SLOT: Record<WorkspaceState, { button: string; cannot: string }> = {
  running: { button: "Pause", cannot: "be paused" },
  unreachable: { button: "Pause", cannot: "be paused" },
  paused: { button: "Wake", cannot: "be woken" },
  gone: { button: "Wake", cannot: "be woken" },
  pausing: { button: "Pausing…", cannot: "be paused" },
  waking: { button: "Stop", cannot: "be woken" },
};

/** The word the phase button on the machine's own surface shows: the verb, or the moving state while it moves. */
export const phaseButtonWord = (state: WorkspaceState): string => PHASE_SLOT[state].button;

/** The verb the machine cannot take, for the one sentence a machine wsp does not drive refuses with. */
export const phaseCannot = (state: WorkspaceState): string => PHASE_SLOT[state].cannot;

export const phaseHint = (state: WorkspaceState): string =>
  state === "waking" ? "Stop asking the provider to wake this workspace" : isBilling(state) ? "Suspend the VM and keep the disk" : "Boot the VM from its disk";
export const FORGET_HINT = "Its computer is gone; forget the workspace to drop it from this computer";
export const REBUILD_HINT = "The workspace answers nothing; rebuild it from your image";

/** What a rebuild the host refused says, wherever it was asked from. The host's own reason is not quoted: it ends
 * in whatever threw, and the line used to begin with the workspace's name and a colon. */
export const rebuildRefusedLine = (name: string): string => `${name} was not rebuilt. The Workspace panel says what it is doing.`;

export function phaseRefusal(state: WorkspaceState): string | null {
  switch (state) {
    case "running":
    case "unreachable":
    case "paused":
      return null;
    case "pausing":
      return "Workspace is pausing; it can be woken once it is paused";
    // A wake the host keeps asking the provider for is the one moving state with something to offer: its own stop.
    case "waking":
      return null;
    case "gone":
      return goneRefusal("wake");
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

export const CLIENT_CANNOT_REBUILD = "This client cannot rebuild workspaces";
export const CLIENT_CANNOT_FORGET = "This client cannot forget workspaces";
export const CLIENT_CANNOT_START_DAEMON = "This client cannot start a daemon";
export const NEW_THREAD_WAITS = "New threads wait for the rebuild";
export const PROJECTS_WAIT = "Projects wait for the rebuild";
export const CLIENT_CANNOT_IMPORT = "This client cannot import projects";
export const CLIENT_CANNOT_EXPORT = "This client cannot export projects";
export const CLIENT_CANNOT_RENAME_WORKSPACE = "This client cannot rename workspaces";
export const CLIENT_CANNOT_LOOK = "This client cannot set a workspace's theme or icon";
export const NO_WORKSPACE_FORK = "Running a copy of a workspace is not in the runtime yet; take a project snapshot in the Workspace tab and start a workspace from it";

/** The half of the forget's refusal that holds whatever the workspace is: what is so about it comes after, and
 * two callers word that half differently. */
const FORGET_NEEDS_GONE = "Only a workspace whose computer is gone can be forgotten";

/** Why a road that waits on the machine being gone is not offered yet, for the two rows that are such roads: the
 * rebuild and the forget. They sit in one list, so both read the one state and say it in the one word the row
 * under them shows; each names its own road in the second half, which is all that differs between them. */
export function goneRoadRefusal(state: WorkspaceState, road: "rebuild" | "forget"): string {
  if (state === "unreachable") return notAnsweringYet(road);
  const word = workspaceWord(state).toLowerCase();
  return road === "rebuild" ? `This one is ${word}, so nothing needs rebuilding; the rebuild is offered once a workspace is gone` : `${FORGET_NEEDS_GONE}; this one is ${word}`;
}

/** Why a forget cannot run, or null when it can. `said` is what the computer this workspace stands on says about
 * itself while it is not answering, which stands in place of the state word: on the computer the app is drawn on
 * that word would be unreachable, and the part that is down is what a person can act on. */
export function forgetRefusal(state: WorkspaceState, said?: string): string | null {
  if (state === "gone") return null;
  return said === undefined ? goneRoadRefusal(state, "forget") : `${FORGET_NEEDS_GONE}; ${said}`;
}

/** Why the daemon cannot be started from here, which is both the workspace whose daemon is answering and every
 * kind whose daemon runs on a machine this host does not hold the process of: one sentence, since what a person
 * needs from either is that this is not theirs to press. */
export const NO_DAEMON_TO_START = "Only a daemon this host started offers this, and only while it is not running";

/** What a terminal the workspace refused says, wherever it was asked from: the link is up, so no pane stands in
 * for this and the sentence says what did not happen and what is left to try. The link's own words are not
 * quoted; they end in whatever threw, and the line used to begin with a workspace name and a colon. Named where
 * the app holds a record for the workspace, which is everywhere but a pane outliving its own row. */
export const terminalRefusedLine = (name?: string): string =>
  name === undefined ? "No terminal opened; try again in a moment." : `No terminal opened on ${name}; try again in a moment.`;

export const openTerminalRefusal = (state: WorkspaceState): string | null => (state === "gone" ? goneRefusal("open a terminal") : null);
export const openBrowserRefusal = (state: WorkspaceState): string | null => actionRefusal(state, "preview");

export const THREAD_NOT_RUNNING = "Thread is not running";
export const CLIENT_CANNOT_STOP = "This client cannot stop a turn";
export const THREAD_HAS_NO_ID = "This thread has no id yet";
export const CLIENT_CANNOT_RENAME = "This client cannot rename a thread";
export const CLIENT_CANNOT_FORGET_THREAD = "This client cannot forget a thread";

/** Why the forget cannot run, or null when it can. The runtime owns the rule and raises the same sentence; the row
 * reads it off the fold so the menu says why without asking the host. */
export function threadForgetRefusalFor(thread: { threadId: string | null; ran: boolean }, hasVerb: boolean): string | null {
  if (thread.threadId === null) return THREAD_HAS_NO_ID;
  if (!hasVerb) return CLIENT_CANNOT_FORGET_THREAD;
  return thread.ran ? threadForgetRefusal(thread.threadId) : null;
}

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
      return `${agentName(harness)} on the workspace has no session for this thread yet`;
    case "failed":
      return error ?? "The workspace said nothing about the write";
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

/** A thread link named a thread the workspace's list does not carry; the workspace opened instead. The thread is
 * not named: the link carried an id, and an id names no thread to the person who followed it. */
export const noSuchThreadLine = (): string => "That thread is not in this workspace; opened the workspace instead";

/** Show in diff asked for a file the diff does not touch. */
export const noDiffLine = (fileName: string, scopeLabel: string): string => `${fileName} has no diff in ${scopeLabel.toLowerCase()}`;

/** A row button on the object's own row names the object: Forget api, New thread in api. */
export const rowVerb = (verb: string, name: string): string => `${verb} ${name}`;
export const rowNewThread = (name: string): string => `New thread in ${name}`;

/** What the road to this computer says under its name: what a pick will do, since there is one local workspace per
 * host and the second pick is a selection, and why it cannot be picked at all. */
export const THIS_COMPUTER_HINTS = {
  fresh: "This computer itself, nothing to copy",
  existing: "Already a workspace; go to it",
  offline: "Not connected to wsp",
} as const;
