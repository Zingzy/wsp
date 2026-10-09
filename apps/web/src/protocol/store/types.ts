// SPDX-License-Identifier: AGPL-3.0-only
import type { Attachment, AccountRow, BringBackResult, Capabilities, GoldenStageEvent, HarnessCatalog, InitJob, InitSetup, PendingComputer, PlaceDial, PlaceSetAlso, PlaceSettingsAsk, PlaceSettingWord, PlaceView, PortForward, Preferences, PreferencesPatch, ProjectView, ReleaseView, ReviewDraft, SessionView, ThreadMarks, WorkspaceCreateStage, WorkspaceLanding, WorkspaceLook, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import type { Launch } from "../../adapt/view-model.js";
import type { Api, ConnStatus, ProtocolEvent } from "../client.js";
import type { Failure } from "../failure.js";
import type { ComposerStart } from "../../components/chat/composerPicks.js";

export interface CostTick {
  rateUsdPerHour: number;
  accruedUsd: number;
  at: string;
}

/** One line of a create's stage log, stamped with the wall clock when it arrived here. A line the image build put
 * there carries `image` rather than one of the create's own stages: the two streams share the log. */
export interface CreationLine {
  readonly stage: WorkspaceCreateStage | "image";
  readonly message: string;
  readonly at: string;
  readonly elapsedMs: number;
  readonly notice?: string;
  /** What the machine answered this step with, for the line's title; never drawn as a sentence. */
  readonly detail?: string;
  /** What the step waits for now, in the runtime's words, newest only: drawn in place of the step's own word. */
  readonly waiting?: string;
}

/** A workspace being created: the sidebar row and the center view read it until workspace.created replaces it. */
export interface Creation {
  /** What select() takes for it; stable from the click through the runtime's first stage event. */
  readonly key: string;
  readonly name: string;
  /** When this row was made here, in wall-clock ms. A line the create's own stages carry their elapsed on needs
   * nothing from it; a line this app stamps itself (the image build's) measures from here, since the build runs
   * before the runtime's own clock on this create starts. */
  readonly askedAt: number;
  /** The project this work is on, by its id: what the create was asked with, and what a retry asks again. Absent on
   * a row another client started, whose creating frames name the workspace and not the project it came from. */
  readonly project?: string;
  /** The snapshot the create forks, when it is not the image's head: a project image's. */
  readonly golden?: string;
  /** The size the person picked; absent, the golden's. */
  readonly size?: WorkspaceSize;
  /** The message that asked for this work, drawn as the thread's first message while the machine is made. */
  readonly asked?: string;
  /** The asked message goes to the workspace once it is up, and the row is kept in local storage until then;
   * absent, the caller sends it itself. */
  readonly queued?: true;
  /** The thread the asked message opens on the workspace, started from here once it is up; absent, the message
   * waits on the workspace's queue for its composer. */
  readonly opens?: Opens;
  /** The files that go with the message; never kept, so a reload sends it without them. */
  readonly attachments?: ReadonlyArray<Attachment>;
  /** The computer the work lands on, which is the project's own, by the id its row carries. The image build's own
   * frames name their place, so this is what says which are this create's. */
  readonly where?: string;
  /** The id the runtime minted, known from its first stage event. */
  readonly workspaceId: string | null;
  readonly lines: ReadonlyArray<CreationLine>;
  /** Set once the create was refused; the lines keep the failing one. */
  readonly failed: CreateRefusal | null;
}

/** The message a create was asked with. With `queuedFrom`, the page it was sent from: that page's picks go with it, and
 * the message waits on the workspace's queue; without, the caller sends it once the workspace is up. */
export interface Asked {
  readonly prompt: string;
  readonly queuedFrom?: string;
  /** The agent and the picks the message opens its thread at, for a send no page's composer will drain. */
  readonly opens?: Opens;
  readonly attachments?: ReadonlyArray<Attachment>;
}

/** A thread's start as a send to several models names it: the agent, its picks and the send's one attempt id. */
export type Opens = ComposerStart & { readonly harness: string; readonly attempt?: string };

export interface CreateRefusal {
  readonly title: string;
  readonly detail: string;
}

export interface State {
  api: Api | null;
  /** The runtime socket as the client reports it; the shell's banner reads this. */
  conn: ConnStatus;
  /** Backend feature flags; null until the first reply. Gate upgrade/resize on these. */
  capabilities: Capabilities | null;
  /** Whether a golden with a head is sealed; null until the first reply. The sidebar's cloud row shows while it is false. */
  hasGolden: boolean | null;
  /** The init job on the host as its last event or the first reply left it; null while none has run. The cloud row
   * reads its progress while the modal is shut, and the modal opens where it stands. */
  initJob: InitJob | null;
  /** The last golden.stage frames of the copy built at each place, by the place id the frames carry, the newest
   * last: only the build running there or the one that last ended, since a frame after a sealed or failed one starts
   * the place over. Cleared on every pull, since a host that restarted mid-build holds no build to end it. */
  goldenFrames: Record<string, GoldenStageEvent[]>;
  /** What each harness's CLI takes at launch, from the runtime's table; empty until it answers, and the composer shows no pickers. */
  harnesses: HarnessCatalog[];
  /** The same, as the binaries on a workspace's machine reported them; set once loadHarnesses got an answer for it. */
  harnessesByWorkspace: Record<string, HarnessCatalog[]>;
  workspaces: WorkspaceView[];
  statuses: Record<string, WorkspaceStatus>;
  costs: Record<string, CostTick>;
  /** Live session count per workspace; > 0 renders the spend-pulse. */
  spending: Record<string, number>;
  /** Guest ports the host forwards to localhost here, from the host's list and its forward events. */
  forwards: PortForward[];
  /** Every computer this wsp runs on, as the Settings table shows them; the four place events keep it current. */
  places: PlaceView[];
  /** Every add that has not reached Set up, as the places list and its pending events carry them. */
  pending: PendingComputer[];
  /** Every project this wsp holds, which is what a workspace is made of; the two project events keep it current. */
  projects: ProjectView[];
  /** What the last bring back on a workspace answered, by its id: the branch it pushed and the pull request it
   * opened, which the row's third line reads until another one lands. Nothing is kept for a workspace nobody has
   * brought work back from. */
  broughtBack: Record<string, BringBackResult>;
  /** Each workspace's viewed marks by path against the blob the file had then, as the host last said them. */
  viewed: Record<string, Readonly<Record<string, string>>>;
  /** Each review workspace's draft as the host last answered it. */
  reviews: Record<string, ReviewDraft>;
  /** Reads a review workspace's draft from the host. */
  loadReview(workspaceId: string): Promise<void>;
  /** Where a workspace of each project would land, by the project's id: asked once per project, and the one home of
   * the flags a row's words about its copy's ports and its state word are read off. A key with null under it is a
   * project the runtime refused a landing for, which is what keeps that refusal from being asked again on every
   * render; its rows say what their records carry and nothing more. */
  landings: Record<string, WorkspaceLanding | null>;
  /** Whether the host has answered about that list yet. An empty list is an answer and a list not asked for yet is
   * not: what draws only while this computer is the only row would otherwise draw on every load and go again. */
  placesRead: boolean;
  /** The same for the projects: the first run is the whole centre while this wsp holds none, and the workspaces
   * list answers first, so a host with projects and no workspace painted that screen for one round trip. */
  projectsRead: boolean;
  /** Why the host refused the place list, while it does; a list this socket may not see is not refused, only empty. */
  placesRefused: Failure | null;
  /** The same for the projects. */
  projectsRefused: Failure | null;
  /** Whether the Add a computer sheet stands open over the Settings page. */
  addComputerOpen: boolean;
  /** Whether the Connect a provider sheet stands open over the Settings page. */
  /** A workspace id, or a creation's key while that create runs. */
  selectedId: string | null;
  /** The project whose home stands in the centre while no workspace is picked: where its next task is typed. */
  projectHome: string | null;
  /** The thread of the selected workspace the centre is on, which the page's address names too; null until a pick
   * or the centre's own view has settled on one, where the workspace's latest thread shows. */
  selectedThreadId: string | null;
  /** Whether the centre is on the screen the selected workspace's next thread is written on: it has no thread of its
   * own yet, and its address says so, so a reload opens it again rather than the thread it was opened from. */
  freshThread: boolean;
  creations: Creation[];
  /** The create asked with no message that landed on the workspace the centre shows, and when: its setup stays as
   * that thread's first content until the first message or until the person goes elsewhere, so nothing on the page
   * moves as it lands. */
  landed: { workspaceId: string; creation: Creation; at: number } | null;
  /** Each workspace's rows once a list answered for it, an empty list where it answered none; absent while unread. */
  sessions: Record<string, SessionView[]>;
  /** The send that has opened no thread yet, per workspace. The runtime writes a session row only once the agent
   * announces itself, which on this computer is the seconds the agent takes to boot, so between the send and that
   * row the sidebar had nothing to draw while the message was already in the transcript. */
  launches: Record<string, Launch>;
  ready: boolean;
  /** How many reconnects the runtime could not replay events for; anything built from sessions.history reloads when it moves. */
  gaps: number;
  /** The person's view preferences, the host's one record; until the host answers, the defaults with what this browser
   * kept of the last record, so the first paint is the side, the width and the body the person picked. */
  preferences: Preferences;
  /** The newest release as the host last read it; null until it answers, and on a host that reads none. */
  release: ReleaseView | null;
  /** Every sign-in's row by its key, as usage.accounts answered and usage.account pushes keep it; null until a slate
   * that binds usage asks for it. */
  usageAccounts: Record<string, AccountRow> | null;
  /** Reads the accounts once; a slate's usage source asks when it is first bound. */
  loadUsageAccounts(): void;
  /** Whether the centre shows the settings page in place of the selected workspace's thread. */
  settingsOpen: boolean;
  bind(api: Api): void;
  noteGap(): void;
  /** Mirrors the client's status; live with an api bound pulls list and statuses again so a reconnect converges. */
  setConn(conn: ConnStatus): void;
  /** Also leaves the settings page: every road to a workspace lands on its thread. The pick goes into the page's
   * address, which is where the next load reads it back from. */
  select(id: string | null, threadId?: string | null): void;
  /** Lets the landed setup go once the thread it stood over has a message. */
  dropLanded(workspaceId: string): void;
  /** Opens a project's home in the centre, where a task typed and sent becomes a workspace of its own. */
  openProjectHome(projectId: string): void;
  /** Opens the screen the workspace's next thread is written on, with an address of its own, and asks the chat for
   * that workspace to clear itself: the palette, the shortcut, the row's action and the files pane take this road. */
  newThread(workspaceId: string): void;
  /** What the centre settled on with nothing picked: the thread its own view holds, whether it found it in the
   * transcript or this turn opened it. The address records it, so a reload comes back to it and a thread an agent
   * opens next cannot take the centre. Ignored once anything else is selected. */
  readingThread(workspaceId: string, threadId: string): void;
  openSettings(): void;
  closeSettings(): void;
  toggleSettings(): void;
  /** Paints the patch at once and sends it; the host's answer settles the record, a refusal is a toast and the host's record is read again. */
  setPreferences(patch: PreferencesPatch): Promise<void>;
  /** Starts a workspace for one piece of work on the project named, by the project's id, selects its row and follows
   * it through the stage events; resolves with the runtime's id for the new workspace, or null when the create was
   * refused. `picked` carries a project image or a size only where the person chose one; `asked` is the message the
   * work was asked with, which the creation view draws until the workspace is up. */
  createWorkspace(project: string, name: string, picked?: { golden?: string; size?: WorkspaceSize }, asked?: Asked): Promise<string | null>;
  /** Records a project and answers the record the host kept: a folder on this computer, or a repository address on
   * the computer named. The row arrives by the project.added event too; this is what the first run and the sheet
   * wait on. Null on a client that cannot record one. */
  addProject(source: string, on?: string, into?: string): Promise<ProjectView | null>;
  /** Forgets a project; the row leaves on project.removed. A refusal (a workspace still stands on it) is a toast. */
  removeProject(projectId: string): Promise<void>;
  /** Pushes the agent's branch and opens its pull request. The answer lands under the workspace's id, where the
   * row's third line reads it; a refusal is thrown for the caller's own toast, in the daemon's own sentence. */
  bringBack(workspaceId: string): Promise<void>;
  /** Asks where a workspace of this project would land, once per project. A refusal is remembered as no landing
   * rather than asked again on every render. */
  loadLanding(project: string): Promise<void>;
  /** Runs a failed creation again under the same row. */
  retryCreation(key: string): Promise<void>;
  dismissCreation(key: string): void;
  refresh(): Promise<void>;
  /** Optimistic nap/wake: paint now, reconcile on the event, revert + toast on failure. */
  toggle(id: string): Promise<void>;
  /** The wake alone: what every Wake button calls, whatever the row says. A running workspace is left as it is. */
  wake(id: string): Promise<void>;
  /** Stops the host asking the provider again for a wake it never took; the row repaints on the runtime's own push. */
  stopWake(id: string): Promise<void>;
  /** A workspace view the runtime handed back to a caller, over the one in the rail: no event carries the image a
   * workspace forks from, so a move to a newer golden version would read stale until the next full refresh. */
  applyWorkspace(workspace: WorkspaceView): void;
  /** The project an import landed, onto the workspace it landed on: the host answers the record it has just kept, so
   * the pane lists the folder as soon as the import returns, whether or not the machine's daemon is up to say
   * anything about what is in it. */
  /** The row leaves on the host's forward.close; a refusal is a toast. */
  stopForward(workspaceId: string, port: number): Promise<void>;
  /** Opens Settings with the Add a computer sheet over it: the palette row and the table's button take one road. */
  openAddComputer(): void;
  closeAddComputer(): void;
  /** Saves keys on the host and answers with its setup after the save. A provider key makes that provider a
   * computer, so the places and the setup Settings reads are taken again here rather than at the next reload. */
  saveKeys(keys: { provider?: string; key?: string; rows?: Record<string, string> }): Promise<InitSetup>;
  /** Asks the host to dial one computer once and takes the row it answers with, so every surface reading that row
   * says the same thing about it. Answers the whole of what came back for the slot that asked. */
  dialPlace(placeId: string): Promise<PlaceDial>;
  /** Puts this wsp's daemon on one computer, what it was set up with staying, and reads the rows again so that row
   * carries the daemon it now runs. A refusal is the host's own sentence in a notice. */
  updatePlace(placeId: string): Promise<void>;
  /** Sets a computer's own settings, or takes the ones named under `reset` back to their defaults, and puts the row
   * the host answers in place of the one held. A refusal is the host's own sentence in a notice. */
  /** Rejects with the host's refusal, for the caller to say where the person is looking. */
  setPlace(placeId: string, ask: PlaceSettingsAsk & PlaceSetAlso, reset?: ReadonlyArray<PlaceSettingWord>): Promise<void>;
  applyEvent(e: ProtocolEvent): void;
  /** Rows come from the runtime (only it knows harness and final status); events say when to ask. */
  reloadSessions(workspaceId: string): Promise<void>;
  /** Holds a send whose thread the runtime has yet to write a row for, so every surface reading the workspace's
   * threads has the one the transcript already shows. */
  launching(workspaceId: string, launch: Launch): void;
  /** Drops it: any start or end of this workspace's own means the runtime's rows are the newer answer, and a send
   * refused before it reached the runtime drops its own by request id, so a late refusal cannot take a newer send's
   * row away. A refresh drops every one of them in the same write as the rows it answered, since that list is the
   * whole of what threads there are. */
  launched(workspaceId: string, requestId?: string): void;
  /** Names the thread's harness session through the runtime, which writes it into the harness's own store: the
   * machine comes up first, as the command line's own rename does, then the name goes, then the workspace's rows are
   * reloaded so the sidebar shows it. True once the store took the name; an answer that named nothing and a failure
   * are false and a toast, so the caller can leave the name where a person can still see it. */
  renameThread(opts: { sessionId: string; workspaceId: string; harness: string; title: string }): Promise<boolean>;
  /** Drops a thread no turn ever ran on through the runtime, then reloads the workspace's rows so the row leaves
   * the sidebar. True once the runtime dropped it; its refusal for a thread whose turn reached its agent is false
   * and a toast. */
  forgetThread(opts: { threadId: string; workspaceId: string }): Promise<boolean>;
  /** Tells the host this window showed the thread; the thread.marked it answers with reloads the rows in every
   * window. A refusal says nothing: nobody asked for it, and the thread reads Done until the next showing. */
  readThread(threadId: string): Promise<void>;
  /** Settles the threads by hand through the host, a root and every thread under it; a refusal is a toast, and the
   * answer is whether the host settled them. */
  settleThreads(threadIds: readonly string[]): Promise<boolean>;
  /** Pins, snoozes or places threads through the host, or takes one of those back; a refusal is a toast. */
  markThreads(threadIds: readonly string[], marks: ThreadMarks): Promise<void>;
  /** Takes settled threads back out of the fold through the host; a refusal is a toast. */
  restoreThreads(threadIds: readonly string[]): Promise<void>;
  /** Names the workspace through the runtime, which holds the name on this computer, and puts the record it answers
   * with in place of the row. True once the runtime took the name; a refusal (a name another workspace holds, a blank
   * one) is false and a toast, so the caller can leave the name where a person can still see it. */
  renameWorkspace(opts: { workspaceId: string; name: string }): Promise<boolean>;
  /** Sets the workspace's hue or its glyph through the runtime, which holds them beside the record, and puts what it
   * answers with on the row. A key left out keeps that fact as it is and null clears it. False on a client without
   * the verb or a refusal, which lands in the toast. */
  setWorkspaceLook(opts: { workspaceId: string; look: WorkspaceLook }): Promise<boolean>;
  /** Asks the runtime for the catalogs as the workspace's machine reports them; a refusal leaves the table's in place. */
  loadHarnesses(workspaceId: string): Promise<void>;
}
