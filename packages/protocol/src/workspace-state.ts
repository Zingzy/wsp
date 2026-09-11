// SPDX-License-Identifier: AGPL-3.0-only
// The one vocabulary for a workspace's state. The runtime's phase leads; the
// provider's word and the daemon reach only change it where they contradict
// it. Every client renders these words, and the runtime refuses a send with
// the same sentence the composer shows, so one screen never says two things.
import { MACHINE_WSP_FORKS, OVER_SSH, THIS_COMPUTER, type CpuWord } from "./format.js";
import type { HarnessCatalog, MachineState, ReachState, ScreenCommand, ScreenControl, WorkspaceKind, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "./index.js";

export type WorkspaceState = "running" | "pausing" | "paused" | "waking" | "unreachable" | "gone";

/** A workspace's kind as every client must read it: a record written before local workspaces existed carries none
 * and is a provider fork. The one place an absent kind is resolved. */
export function workspaceKind(view: Pick<WorkspaceView, "kind">): WorkspaceKind {
  return view.kind ?? "cloud";
}

/** Whether this workspace is this computer. Asked by every surface that offers to make one (the app's sidebar and
 * palette, wsp init's workspace step), and written once so the two cannot disagree about what counts. */
export const isLocalWorkspace = (view: Pick<WorkspaceView, "kind">): boolean => workspaceKind(view) === "local";

/** What a workspace's kind changes about the words a client shows for it. */
export interface WorkspaceKindWords {
  /** What a sentence calls a machine of this kind, read through machineWord: every refusal that names the machine,
   * the line a recorded machine is announced with and the notice a second record on one is refused with. Every kind
   * has its own, so no sentence about one kind's machine borrows another kind's words. */
  machine: string;
  /** Whether the slot a row gives to what the machine is reads a fact off that machine: the size its status carries
   * in this kind's own word for a cpu on the sidebar row and the Spaces header, the provider's id in the command
   * line's table. False for a kind wsp holds no such fact about, whose rows print the word above there instead. */
  rowReadsMachine: boolean;
  /** What this kind calls one of its cpus in that size line: a provider's are virtual, a machine that exists has cores. */
  cpu: CpuWord;
  /** Whether wsp forks this machine, pauses it, wakes it, resizes it and pays for it by the hour, or it is a machine
   * that already exists and simply runs while the host does. The state word beside the name, the state dot, the
   * spend, the rate, the nap countdown, the usage chart and the pause and upgrade buttons all ride this. */
  driven: boolean;
  /** Whether a machine of this kind ever serves a daemon, which is what the terminal, files and ports ride. False
   * says the reach word `unsupported` is this kind's steady state rather than something missing from one machine,
   * so a row says what the machine is instead of that its daemon is not there. True on a kind whose machines take
   * one, even before one has landed on a given machine: what a machine without one yet says is its own reach word. */
  daemon: boolean;
  /** Whether a machine of this kind reads its own load, memory and disk for the Machine tab's Live rows. False says
   * those rows read that the reading is not on this kind, rather than waiting on a sample that never comes. */
  metrics: boolean;
  /** Whether a machine of this kind lists its processes for the Processes tab, which the same rule holds for. */
  processes: boolean;
  /** What `import` does to a folder on this computer for a machine of this kind: copies it there and asks about the
   * secret-shaped files first, or registers its path with nothing copied and nothing to ask, the folder being on
   * this computer already. Null where no road lands a folder yet, so no tile and no verb offers one. */
  imports: "copies" | "registers" | null;
  /** Where the folder lands when the caller names no path. A machine wsp made carries the path the folder has on
   * this computer, since its whole disk is wsp's and a path a person already knows is worth keeping; a machine
   * somebody already owns takes the folder into their own home under its own name, since a path from this
   * computer is neither theirs to write nor theirs to find. */
  importsAt: "same path" | "under home";
  /** Whether the agents on a machine of this kind could drive this host at all, which is what says the spawn switch
   * means anything there. A fork's agents reach the host over the road a scoped token opens; this computer answers
   * no request relayed from a machine, and a machine somebody already owns is handed no wsp to drive one with, so
   * on both the switch would hand out a token that opens nothing. */
  agents: boolean;
}

/** The two readings a pane waits on. Each is one module per kind: the cloud kind and a machine over ssh read
 * that machine's own /proc through the daemon on it, and this computer reads its own host. */
export type KindReading = "metrics" | "processes";

/** The words per kind, the one table every client reads instead of comparing a kind itself. Adding a kind (an ssh
 * machine) is a row here. */
export const WORKSPACE_KIND_WORDS: Record<WorkspaceKind, WorkspaceKindWords> = {
  cloud: { machine: MACHINE_WSP_FORKS, rowReadsMachine: true, cpu: "vCPU", driven: true, daemon: true, metrics: true, processes: true, imports: "copies", importsAt: "same path", agents: true },
  local: { machine: THIS_COMPUTER, rowReadsMachine: true, cpu: "cores", driven: false, daemon: true, metrics: true, processes: true, imports: "registers", importsAt: "same path", agents: false },
  ssh: { machine: OVER_SSH, rowReadsMachine: false, cpu: "cores", driven: false, daemon: true, metrics: true, processes: true, imports: "copies", importsAt: "under home", agents: false },
};

export function kindWords(kind: WorkspaceKind): WorkspaceKindWords {
  return WORKSPACE_KIND_WORDS[kind];
}

/** Whether a machine of this kind answers this reading at all. The one question a pane asks before it waits: a kind
 * that serves it shows pending until the first value lands, and a kind that serves it on no road says so at once,
 * so no slot sits at pending for a stream that will never come. */
export function servesReading(kind: WorkspaceKind, reading: KindReading): boolean {
  return WORKSPACE_KIND_WORDS[kind][reading];
}

/** Whether the spawn switch means anything on a workspace of this kind, the one reading both doors that set it
 * take: the create that names it on a new workspace and the verb that turns it on for one that exists. */
export function agentsMayDrive(kind: WorkspaceKind): boolean {
  return WORKSPACE_KIND_WORDS[kind].agents;
}

/** The one sentence both those doors refuse with, so a person reads the same thing whichever they typed. */
export function agentsKindRefusal(kind: WorkspaceKind): string {
  return `agents on ${machineWord(kind)} cannot drive this host, so the spawn switch would hand out a token that opens nothing; it is for the machines wsp forks`;
}

/** What a sentence calls this workspace's machine. Every kind answers for itself: a refusal on a machine wsp forks
 * says so, and this computer's words are this computer's alone. */
export function machineWord(kind: WorkspaceKind): string {
  return WORKSPACE_KIND_WORDS[kind].machine;
}

export interface WorkspaceStateInput {
  phase: WorkspacePhase;
  machineState?: MachineState | null | undefined;
  reach?: ReachState | null | undefined;
  /** Set on a record whose last wake ran its asks out with the machine still paused at the provider; the state words
   * are unchanged by it (the machine is paused, and a wake may be tried again) but the rebuild is offered. */
  wakeRefused?: string | null | undefined;
}

export function workspaceState(input: WorkspaceStateInput): WorkspaceState {
  const machine = input.machineState ?? null;
  const reach = input.reach ?? null;
  if (machine === "gone") return "gone";
  switch (input.phase) {
    case "pausing":
      return "pausing";
    case "napping":
      return "paused";
    case "waking":
      return "waking";
    case "gone":
      return "gone";
    case "running":
      if (machine === "paused") return "paused";
      if (machine === "starting") return "waking";
      if (reach === "unreachable" || reach === "no-daemon" || reach === "zombie") return "unreachable";
      return "running";
    default: {
      const _exhaustive: never = input.phase;
      return "running";
    }
  }
}

/** The one state word's key for a workspace as every client knows it: its phase, and the machine state and reach of
 * its status when one has arrived. A caller holding only the record passes null and reads the phase alone, which is
 * why a surface that shows a state asks for the status: the phase alone calls a paused or unreachable machine
 * running. */
export function workspaceStateOf(workspace: Pick<WorkspaceView, "phase">, status: Pick<WorkspaceStatus, "machineState" | "reach"> | null): WorkspaceState {
  return workspaceState({ phase: workspace.phase, machineState: status?.machineState, reach: status?.reach.state });
}

const WORDS: Record<WorkspaceState, string> = {
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  waking: "Waking",
  unreachable: "Unreachable",
  gone: "Gone",
};

export function workspaceWord(state: WorkspaceState): string {
  return WORDS[state];
}

/** Why an action that needs the machine (send, import, export) cannot run in this state; null while running.
 * goneWords are the provider's, quoted when the caller holds them (the runtime does, the composer does not). */
export function actionRefusal(state: WorkspaceState, action: string, goneWords?: string): string | null {
  switch (state) {
    case "running":
      return null;
    case "pausing":
    case "paused":
      return `Workspace is ${state}; wake it to ${action}`;
    case "waking":
      return `Workspace is waking; ${action}s open when it is running`;
    case "unreachable":
      return `Workspace is unreachable; ${action}s open when the machine answers`;
    case "gone":
      return goneRefusal(action, goneWords);
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

/** What refuses a send before the workspace's state is asked: the socket to wsp, the workspace lookup, the
 * transcript still loading. */
export type SendBlock = "connecting" | "reconnecting" | "closed" | "not-found" | "loading";

/** Every kind of send refusal: a block, or a state other than running. */
export type SendRefusalKind = WorkspaceState | SendBlock;

const BLOCK_WORDS: Record<SendBlock, string> = {
  connecting: "Connecting to wsp",
  reconnecting: "wsp is not running, reconnecting",
  closed: "wsp is not running",
  "not-found": "Workspace not found",
  loading: "Loading transcript",
};

/** Why a turn cannot be sent, one sentence per kind; null while running. The composer draws every row; the runtime
 * throws the state rows, so the two say the same thing about a machine. A thread whose turn replied but still runs
 * has stillWorkingLine, which says the message waits for it. */
export function sendRefusal(kind: SendRefusalKind, goneWords?: string): string | null {
  return isBlock(kind) ? BLOCK_WORDS[kind] : actionRefusal(kind, "send", goneWords);
}

const isBlock = (kind: SendRefusalKind): kind is SendBlock => kind in BLOCK_WORDS;

const CONTROL_WORDS: Record<Exclude<ScreenControl, "sign-in">, string> = {
  model: "pick the model in the row under the box",
  access: "pick the access mode in the row under the box",
  settings: "wsp's settings open from the command palette",
  docs: "wsp's docs are at wsp.apidocumentation.com",
};

/** The composer's line for a slash command the CLI runs only in its own terminal, in place of a turn that would answer
 * the command is not available: what the command is, then the wsp control that serves the same intent. The sign-in
 * road is the machine's: the Machine tab signs a machine in, and this computer is signed in from its own terminal. */
export function screenCommandLine(command: ScreenCommand, catalog: Pick<HarnessCatalog, "label">, view: Pick<WorkspaceView, "kind">): string {
  const control =
    command.control === "sign-in"
      ? isLocalWorkspace(view)
        ? `sign in from a terminal on ${THIS_COMPUTER}`
        : "sign this machine in from the Machine tab"
      : CONTROL_WORDS[command.control];
  return `/${command.name} works only in ${catalog.label}'s own terminal; ${control}`;
}

/** A probe that found the machine: the edge answered, promptly or late. */
const ANSWERED: ReadonlySet<ReachState> = new Set<ReachState>(["reachable", "slow"]);
/** A probe nothing answered: silence, or the edge dialling the guest and finding the daemon port dead. */
const UNANSWERED: ReadonlySet<ReachState> = new Set<ReachState>(["unreachable", "no-daemon"]);

/** The reach word a row shows after one probe. A single silence after an answer keeps the answer's word: one slow
 * edge answer, one DNS blip, one busy second on the box or one probe that landed while the daemon was restarting
 * is not the machine gone dark, so the word turns only on the second silence in a row. Every answer, and a silence
 * after anything but an answer, shows as it came. This is also the window the runtime waits out before it puts a
 * daemon back: the word the row is given is already the second unanswered probe. */
export function reachShown(lastProbe: ReachState | undefined, probed: ReachState): ReachState {
  if (!UNANSWERED.has(probed)) return probed;
  return lastProbe !== undefined && ANSWERED.has(lastProbe) ? lastProbe : probed;
}

/** Whether the latest poll's probes failed before leaving this computer. A road that fails here fails for every
 * machine at once, so one row saying so is the computer's network, never that row's machine. */
export function computerOffline(statuses: Iterable<Pick<WorkspaceStatus, "reach">>): boolean {
  for (const s of statuses) if (s.reach.offline === true) return true;
  return false;
}

/** Whether the machine is up and billing in this state: running, or running with its edge or daemon dark (the
 * provider bills a machine it cannot be reached on). Paused, moving and gone ones bill nothing, and only a billing
 * machine has anything to nap, so the rate and the nap countdown on every surface read this one rule. */
export function isBilling(state: WorkspaceState): boolean {
  return state === "running" || state === "unreachable";
}

/** Rebuild is a road out: the machine is gone, a zombie the provider still calls running, or one the provider would
 * not resume for the whole of a wake's asking. Every surface that offers the rebuild (sidebar row, palette, Machine
 * tab, the command line and its tool) asks this and nothing else. It is the only one left on the first two; on the
 * third the wake can be tried again beside it, since the fault is the provider's and may pass. */
export function needsRebuild(input: WorkspaceStateInput): boolean {
  return workspaceState(input) === "gone" || input.reach === "zombie" || (input.wakeRefused ?? null) !== null;
}

/** The one sentence for a rebuild asked of a machine that still answers, so the row's disabled tooltip and the
 * command line refuse in the same words. A caller holding only the record reads no reach, so this is its gone rule. */
export const NO_REBUILD_NEEDED = "Rebuild replaces a machine wsp cannot get back; this one answers";

/** The one sentence for a verb a gone machine cannot take (send, wake, fork), with the provider's words when the
 * caller holds them; rebuild and delete are the roads out. */
export function goneRefusal(action: string, words?: string): string {
  const sentence = `Workspace machine is gone; rebuild it to ${action}`;
  return words === undefined || words === "" ? sentence : `${sentence} (${words})`;
}

/** What a workspace's image is, for a move onto the golden's head: whether any golden of this host knows the
 * snapshot it forked from as a version, and whether that snapshot is a project golden. */
export interface ImageMoveInput {
  knownVersion: boolean;
  projectImage: boolean;
}

/** Why a workspace cannot be moved onto its golden's head, or null when it can. One rule, so the app's offer and
 * the runtime's refusal cannot drift apart: the app hides the button on the sentence the runtime would throw.
 * A move replaces the machine, so only a running one can take it; a project image is refused outright, since the
 * disk the move leaves behind is the project's. */
export function imageMoveRefusal(name: string, state: WorkspaceState, image: ImageMoveInput): string | null {
  if (image.projectImage) return `${name} was forked from a project image, which a version move would throw away; make a new workspace on the newer version instead`;
  if (!image.knownVersion) return `${name}'s image is not a version of any golden this host knows`;
  if (state === "gone") return `${name}'s machine is gone; rebuild it to move it to a newer image`;
  if (state !== "running") return `${name} is ${workspaceWord(state).toLowerCase()}; wake it to move it to a newer image`;
  return null;
}
