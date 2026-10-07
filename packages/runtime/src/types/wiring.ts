// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePathOn } from "node:path";
import {
  type Workspace,
  parseMergeOutput,
  plural,
  type Sighting,
  type BuildGoldenOptions,
  type CacheRule,
  type GoldenImport,
  type ExecResult,
  type GoldenManifest,
  type GoldenVersion,
  type KillConfirm,
  type Machine,
  type MachineBackend,
  type MachineShape,
  type ReapResult,
  type UnreadStore,
} from "@wsp/engine";
import type { EditorChoice, EditorId, RecipeFile, RecipeOptions } from "@wsp/protocol";
import type {
  DaemonReachView,
  ExecStream,
  ExecStreamFactory,
  HostFolderListing,
  InitJob,
  InitJobEvent,
  InitNeedsYouEvent,
  InitRoad,
  InitScreenId,
  InitSetup,
  Recipe,
  SealedImage,
  TerminalConfig,
  TerminalScheme,
  ProjectAgentOutcome,
  ProjectAgentResult,
  ProjectSource,
  ProjectPlan,
  MachineBind,
  SeedChoice,
  SeedPlan,
  WorkspaceCopy,
  SessionAnswerResult,
  SessionStartOutcome,
  SessionView,
  McpServerSpec,
  TurnResult,
  SysSample,
  WorkspaceCostEvent,
  WorkspaceCreateStage,
  Caller,
  WorkspaceAgents,
  WorkspaceKind,
  WorkspacePhase,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "@wsp/protocol";
import type { TreeFact, TreeRecord, PullRequestSent, PullRequestRecord, PullRequestSeen, Checkout } from "@wsp/protocol";
import { shellQuote } from "@wsp/protocol";
import type { AgentsActs, AgentsReader, ServerIcons, ServersActs, SkillsActs } from "../agents-read.js";
import type { DaemonChannel, DaemonChannelOptions } from "../daemon-channel.js";
import type { MachineExecOptions, TurnWaiting } from "../machine-exec.js";
import type { Copier } from "@wsp/engine";
import type { TaskStop } from "@wsp/protocol";
import { realClock, type Clock } from "../clock.js";
import type { StatusApi, StatusListOptions, StatusWatchOptions } from "../status.js";
import type { PlaceWiring } from "../places.js";
import type { Store } from "../store.js";
import type { GitHubCache } from "../github-cache.js";
import type { ReadingsAnswer, AccountsAnswer, ResetAnswer, UsageRange, UsageSplit, UsedAnswer } from "@wsp/protocol";
import type { ReviewDraft, WorkspaceFrom } from "@wsp/protocol";
import type { HarnessAdapterFactory } from "./harness.js";

// --- runtime ------------------------------------------------------------------

export interface WorkspaceSpec {
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** The workspace gets the place's container engine through the fenced socket; absent takes the image's recipe. */
  engine?: boolean;
  /** The folders of the computer's own this workspace mounts: its project's memory folder, where that computer
   * holds one. Written by the create off the project's landing road and read again by every wake. */
  binds?: MachineBind[];
  /** The checkout on that computer this workspace holds its own copy of, and where that copy is mounted inside.
   * Written by the create off the project's record, so a wake mounts the copy the create was made with. */
  copy?: WorkspaceCopy;
}

/** What a create answers: the view, and a notice when a builder kept after a save was stopped to make room. */
export interface CreatedWorkspace extends WorkspaceView {
  notice?: string;
}

export interface CreateWorkspaceOptions extends WorkspaceSpec {
  /** The project this workspace is made for, by id or by name. Its computer is where the workspace lands, so
   * nothing else says where. */
  project: string;
  /** Snapshot id of a project image to fork; absent takes the head of this host's own image. */
  golden?: string;
  name: string;
  /** What the agents on the new workspace may ask of this host; absent takes the default, and on a fork a thread asked for it
   * is the forking workspace's own switch, so a tree of machines carries one rule rather than needing it set again.
   * A key left out takes the default. */
  agents?: Partial<WorkspaceAgents>;
  /** Auto-nap window; undefined takes the runtime default, null turns auto-nap off. */
  idleWindowMs?: number | null;
  /** The workspace this one is forked out of, by id: a child of it, holding the same project and starting on the
   * branch that workspace is on right now. A create a thread asked for is a child of the thread's own workspace
   * whether or not this names one. */
  parent?: string;
}

/** A folder's archive as the host packs it: the bytes, what went in, the secret-shaped paths left out, and the ones
 * that went in rewritten as the plan offered. */
export interface PackedProject {
  tar: Buffer;
  files: number;
  bytes: number;
  cut: string[];
  rewritten: string[];
}

/** The agents whose state for the folder travels: each with its home on the machine and whether the agent is there
 * to read the state once it is keyed to `dest`. */
export interface StateRequest {
  dest: string;
  agents: readonly { agent: string; home: string; present: boolean }[];
}

/** The agents' state as the host packs it: an archive of each agent's files at its machine home, for the guest's
 * root, what became of each agent, and the merge scripts in the archive by agent, each at its path on the guest, for
 * the runtime to run once the archive has landed. */
export interface PackedState {
  tar: Buffer;
  agents: ProjectAgentResult[];
  merges: { agent: string; script: string }[];
}

/** A folder on this computer as the host reads it; the runtime never touches the disk itself. `plan` reads names
 * and sizes, `pack` reads the bytes once consent is known: a secret-shaped file travels only when `carry` names it,
 * or rewritten when `rewrite` names a path the plan offered a rewrite for. `packState` reads the named agents'
 * homes for their state for the folder, re-keyed to the destination for the agents on the machine. */
export interface ProjectBundler {
  plan(): Promise<ProjectPlan>;
  pack(carry: ReadonlySet<string>, rewrite: ReadonlySet<string>): Promise<PackedProject>;
  packState(req: StateRequest): Promise<PackedState>;
}

/** The folder's archive as it came off the machine, rooted at the folder, and the agents' state that came with it. */
export interface LandRequest {
  /** The folder's path on the machine: the key its agent state on the machine is stored under. */
  source: string;
  /** Where the folder lands on this computer, absolute. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists". */
  replace: boolean;
  /** The archive as a file on this computer, streamed off the machine rather than held in memory; whoever asked for
   * the landing removes it afterwards. */
  archive: string;
  /** The agents' state under the guest's root as an archive on this computer, each agent's home on the guest by
   * catalog id, and the agents whose state comes home (every one with sessions for the folder when absent). */
  state?: { archive: string; homes: Readonly<Record<string, string>>; agents?: readonly string[] };
  /** The stores an agent keeps for every project that the listing on the machine could not read: nothing of theirs is
   * in the archive, so the landing report carries a row for each one saying which store and why. */
  unread?: readonly UnreadStore[];
}

/** This computer's own folders as a browser tab's picker walks them, one level at a time; the runtime never touches
 * the disk itself, the host that owns it does. The desktop shell has the system dialog and never asks for this. */
export interface HostFolders {
  /** `wide` is this computer's own window, which is not held to the home root; `repos` asks for every repo under the roots. */
  list(req: { dir?: string; hidden?: boolean; repos?: boolean; wide?: boolean }): Promise<HostFolderListing>;
}

/** The person's terminal config on the computer running the host, read again on every ask; the runtime never reads
 * the disk itself, the host that owns it does. */
export interface HostTerminalConfig {
  read(scheme?: TerminalScheme): Promise<TerminalConfig>;
}

/** The editors on the computer running the host and how a path opens in one; the runtime never starts a program on
 * this computer itself, the host that owns it does. */
export interface HostEditor {
  list(): Promise<EditorChoice[]>;
  /** Opens the path in the editor named, else the first installed, and answers which one; refused where the path
   * does not resolve inside one of the folders given. */
  open(req: { path: string; line?: number; inside: readonly string[]; editor?: EditorId; remote?: EditorRemote }): Promise<EditorId>;
  /** The line open would refuse a workspace on another computer with, in the editor named or else the first
   * installed; nothing where that editor can open one. Asked before anything reaches that computer, and `name` is the
   * workspace's. */
  remoteRefusal(req: { editor?: EditorId; name: string }): Promise<string | undefined>;
}

/** Where a workspace on another computer opens from: its ssh alias on this computer and its folder there. */
export interface EditorRemote {
  alias: string;
  folder: string;
  /** The workspace's name, for the sentence an editor with no remote road answers with. */
  name: string;
}

/** An editor's ssh into a workspace on another computer, as the host on this computer carries it. */
export interface HostSsh {
  /** A port on this computer's loopback that carries to the workspace's own ssh server, started there with this
   * computer's key allowed, its host key pinned under the workspace's alias before this answers. */
  port(workspace: { id: string; name: string }): Promise<number>;
  /** Whether the person's ~/.ssh/config reads wsp's own ssh config. */
  include(): Promise<boolean>;
  /** Puts that one line in or takes it out, and answers whether it stands. */
  setInclude(on: boolean): Promise<boolean>;
}

/** The init job on the computer running the host: wsp init's run, read and driven from the app over the wire. The
 * host owns it (this computer's files, its Keychain, the sign-ins' terminal link are all the host's); the runtime
 * serves its ops and relays its events beside its own, as it does the host's forwards. */
export interface InitDoor {
  /** The setup as the modal opens on it, priced at the place `on` names, else the default build place. */
  get(o?: { on?: string }): Promise<InitSetup>;
  keys(keys: { provider?: string; key?: string; rows?: Record<string, string> }): Promise<InitSetup>;
  start(o: { road: InitRoad; harness?: string; on?: string }): Promise<InitJob>;
  answer(o: { screen: InitScreenId; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob>;
  step(o: { at: number }): Promise<InitJob>;
  /** Keeps a step's unsent ticks, picks and typed text on the job, so a sheet shut mid-step reopens on them. */
  draft(o: { at: string; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob>;
  retry(o: { tool: string }): Promise<InitJob>;
  /** Starts the build at the place `on` names, else the default build place. `rebuild` seals the next version from
   * a fresh machine rather than from the image plus the changes, which is the question a run at a terminal is asked;
   * absent takes whichever road the changes call for. */
  build(o: { firstWorkspace?: string; importFolder?: string; yes?: boolean; on?: string; rebuild?: boolean }): Promise<InitJob>;
  /** Types the code a sign-in's page handed back into the tool waiting for it on the machine; refused when none is. */
  signInCode(o: { tool: string; code: string }): Promise<InitJob>;
  cancel(): Promise<InitJob>;
  /** Every change to the job, and beside it the arrival of a wait on the person, which a client that speaks once per
   * need rides rather than diffing views. */
  on(fn: (e: InitJobEvent | InitNeedsYouEvent) => void): () => void;
}

/** The recipes a host keeps, as the runtime serves them: the files beside the state are the host's, and which
 * computers follow each is the place records', which the runtime folds in. */
export interface RecipeShelf {
  list(): Promise<{ slug: string; file: RecipeFile }[]>;
  /** One recipe by its name or slug, as saved; refused naming the ones there are. */
  read(word: string): Promise<{ slug: string; file: RecipeFile }>;
  /** One recipe by its name or slug, with the hash it resolves to on this computer now. */
  get(word: string): Promise<{ slug: string; file: RecipeFile; hash: string }>;
  /** Writes the recipe whole; refused for a name that makes no file name and for anything shaped like a secret. */
  save(file: unknown): Promise<{ slug: string; file: RecipeFile }>;
  remove(word: string): Promise<{ slug: string; file: RecipeFile }>;
  /** What a recipe can pick from on this computer, `folders` this computer's own projects to offer with their facts. */
  options(folders?: readonly { name: string; path: string }[]): Promise<RecipeOptions>;
  /** One recipe by its slug as this computer has it now: what it holds for each row, and the hash a computer that
   * follows it is held against. */
  resolve(slug: string): Promise<{ file: RecipeFile; items: Record<string, string>; hash: string }>;
  /** Picks saved under no name, resolved the same way, so a computer set up from them is held row by row too. */
  resolveFile(file: RecipeFile): Promise<{ file: RecipeFile; items: Record<string, string>; hash: string }>;
}

/** One agent's result with its catalog name, for the sentence the runtime says about it. */
export type LandedAgent = ProjectAgentResult & { name: string };

/** What landed on this computer: the folder's files and bytes, and each agent found on the machine with sessions for
 * the folder and what became of its state here. */
export interface LandedProject {
  files: number;
  bytes: number;
  agents: LandedAgent[];
}

/** This computer's side of an export, as the host does it; the runtime never touches the disk itself. `probe` looks at
 * the destination before anything is read from the machine, `land` extracts the folder beside its destination and
 * moves it into place, then keys the agents' state to it in their homes here as an overlay. */
export interface ProjectLander {
  /** What the machine's archive leaves behind: the bundle's own cache rule, so the trip home drops what the trip out dropped. */
  caches: CacheRule;
  /** How many files sit at dest on this computer now, or nothing when the path is free. */
  probe(dest: string): Promise<{ files: number } | undefined>;
  land(req: LandRequest): Promise<LandedProject>;
}

export interface ProjectExportOptions {
  workspaceId: string;
  /** The folder on the machine, absolute. */
  source: string;
  /** Where it lands on this computer, absolute. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists" before anything is read. */
  replace?: boolean;
  /** The agents whose state comes home, by catalog id; absent, every agent with sessions for the folder on the machine. */
  agents?: readonly string[];
  lander: ProjectLander;
}

export interface ProjectImportOptions {
  workspaceId: string;
  /** The folder on this computer, absolute; named in the events. */
  source: string;
  /** Where the folder lands on the machine, absolute; its parents are made. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists". */
  replace?: boolean;
  /** The secret-shaped paths from the plan that may travel as they are; every other one is cut and named. */
  carry?: readonly string[];
  /** The paths the plan offered a rewrite for that land rewritten; wins over carry for the same path. */
  rewrite?: readonly string[];
  /** The plan's agents whose state for the folder travels, by catalog id; nothing of any other agent is read. */
  agents?: readonly string[];
  bundler: ProjectBundler;
}

export interface WorkspaceRecord extends Omit<WorkspaceView, "project"> {
  /** cloud or local; a record stored before local existed has none and reads cloud. */
  kind: WorkspaceKind;
  /** The project this workspace was made for, by its id. The view joins the record's name, path and computer off
   * the projects map, so one fact has one stored home. */
  project: string;
  spec: Pick<WorkspaceSpec, "envs" | "labels" | "engine" | "binds" | "copy">;
  idleWindowMs?: number | null;
  /** What the provider built, read back after every create (it may clamp the
   * request); the rail and the rate use this, never what was asked for. */
  size: WorkspaceSize;
  firstLife: boolean;
  /** The provider's view of the current machine when it was created; a wake compares against it. */
  shape?: MachineShape;
  /** The branch this workspace's copy started from: the branch its parent was on at the fork for a child, and the
   * branch the project starts from for every other workspace. A fact of the fork and not a reading of the parent,
   * since it is the code this copy was cut from, which is where its work goes back however the parent moves on;
   * absent on a record written before it, which reads the project's own base as it always did. */
  base?: string;
  /** With phase gone: the provider's words when the machine was found missing; cleared when a fresh machine lands. */
  gone?: string;
  /** That this host put a daemon on the machine, and which one. Only a kind whose machine wsp did not make carries
   * it: a fork's daemon comes with the golden and its preview route says whether one answers, while a machine the
   * person owns had none until a deploy landed, and nothing may dial one to find out. */
  daemon?: { deployedAt: string; version: number };
  /** What the host keeps of the workspace's pull request: enough that a merged one reads merged after a restart and is
   * never read again, and nothing more of it is written under the host's folder. */
  pr?: PullRequestRecord;
  /** The checkout git last gave, so a machine nothing can ask after a restart still shows its branch and counts. */
  checkout?: Checkout;
  /** What a child keeps of the tree it is in: its merge into its lead, the files a merge stopped on, and why its last
   * push was refused. Absent on a workspace that is nobody's child and on one nothing has happened to yet. */
  tree?: TreeRecord;
  /** Where the work came from: an issue or a pull request started on, or a pull request under review. */
  from?: WorkspaceFrom;
  /** A review workspace's review as the person shapes it before Post. */
  review?: ReviewDraft;
  /** The items of its pull request's page sent to its agent, with when. */
  prSent?: PullRequestSent[];
  /** Folders an import landed on the machine beside the project, which its daemon may browse: kept here so every
   * whole write of the roots file lists them, and gone with the record. No project is made of them. */
  landed?: string[];
}

export interface LiveWorkspace {
  record: WorkspaceRecord;
  ws: Workspace;
  machine: Machine;
  /** Moves with every write of the record; the status poll drops a row it built under an older one. */
  generation: number;
  /** The wake in flight, so a second caller joins it instead of resuming twice. */
  waking?: Promise<WorkspaceView>;
  /** Running on a provider read alone, with no wake check behind it: a Boat box reads running while its disk still
   * streams in and refuses every command until it is done, so the next wake proves it takes commands first. */
  unchecked?: true;
  /** The nap in flight: a second nap joins it, a wake waits for it. */
  napping?: Promise<WorkspaceView>;
  /** The record following a machine the provider runs under a napping word: a second verb that read the same fact joins it. */
  adopting?: Promise<void>;
  /** The delete in flight: a second delete joins it, and the name stays held until the record is dropped. */
  deleting?: Promise<void>;
  /** Cancels the one read armed after a wake gave up. */
  lateRead?: () => void;
  /** Stops the wake in flight, whether it is on a call or waiting to ask again: what the row's stop pulls. Aborting
   * it ends the provider call under it, so nothing is left running behind a wake that is over. Absent when no wake
   * is running. */
  wakeStop?: AbortController;
  /** What the row says about the wake in flight, for as long as it is in flight: every status the poll builds carries
   * it, since a line pushed once would be wiped by the next tick and the row would fall silent between two asks. */
  wakeSaid?: string;
  /** What the last delete said when the provider kept the machine, read while the record's phase is still the one it
   * was said under, until the next delete or wake starts: held here, not on the record, so a restart forgets it. */
  deleteSaid?: { phase: WorkspacePhase; line: string };
  /** Which ask the host is on and how many it will make, while it is asking again on its own; the surfaces read it
   * at the length each has room for rather than being handed a sentence built for one of them. */
  wakeAsk?: { ask: number; of: number };
  /** Set from the fork until the create is ready: the sweep knows the machine, nothing else can reach it yet. */
  creating?: true;
  /** The copy's checkout as git last answered it, carried on every status built for the workspace. */
  checkout?: Checkout;
  /** The checkout read in flight, which a second asker joins. */
  checkoutReading?: Promise<Checkout | undefined>;
  /** A lead's children as last read, and the read in flight so a second caller joins it. */
  tree?: TreeFact;
  treeReading?: Promise<TreeFact | undefined>;
  /** The pull request as the git host last answered it, what the record kept of a settled one, or why it could not be
   * read, carried on every status built for the workspace. */
  pr?: PullRequestSeen;
  /** The pull request read in flight, which a second asker joins. */
  prReading?: Promise<PullRequestSeen | undefined>;
  /** Cancels the next timed read of an open pull request with a check still running. */
  prPoll?: () => void;
  /** The interval that timed read was armed at. */
  prPollMs?: number;
  /** The head commit a read by branch last found no pull request at: the branch is not read again until it moves. */
  prNoneAt?: string;
}

/** Reports one create stage as it is reached; the runtime stamps id, name and elapsed time. A notice is a second
 * line written for a person; a detail is what the machine answered, which rides the line's title. */
export type StageReport = (stage: WorkspaceCreateStage, message: string, said?: { notice?: string; detail?: string; waiting?: true }) => void;

export interface SessionHandle {
  readonly id: string;
  readonly workspaceId: string;
  readonly finished: Promise<TurnResult>;
  /** The runtime's id for the turn, as its events carry it. */
  readonly turnId: string;
  /** How the start that handed this out went: steered means the handle is the thread's running turn, not a new one. */
  readonly outcome: SessionStartOutcome;
  view(): SessionView;
  interrupt(): Promise<void>;
  steer?(prompt: string): Promise<"accepted" | "not-running">;
  /** Answers a permission prompt this turn raised, by the prompt's id and one of its options. Only a person answers
   * one: the prompt stands for as long as the turn does. Absent on a harness that raises none. */
  answer?(askId: string, opts: { optionId: string; reason?: string }): Promise<SessionAnswerResult["outcome"]>;
  /** Moves this running turn to another access mode, the prompt it is stopped on included; absent on a harness that
   * takes none mid-turn. */
  setAccess?(mode: string): Promise<"set" | "refused" | "gone">;
  /** Stops one of this turn's own subagents; absent on a harness that stops none by itself. */
  stopTask?(task: string): Promise<TaskStop>;
}

/** Which backend a place name resolves to. One row today, the provider this host is wired with; a row per joined
 * computer comes with the place link. The runtime reads only this interface, so nothing above it compares a place
 * by name. */
export interface PlaceBackends {
  /** The place every road that names none means: the provider this host forks on now. Read at each call, since a
   * host that starts with no key swaps its provider module in when one is saved. */
  readonly wired: string;
  backend(place: string): MachineBackend | undefined;
  list(): readonly string[];
}

/** The one-row table over the runtime's own backend; `id` is read at each call for the same reason `wired` is. */
export function wiredPlace(id: string | (() => string), backend: MachineBackend): PlaceBackends {
  const at = (): string => (typeof id === "string" ? id : id());
  return {
    get wired() {
      return at();
    },
    backend: place => (place === at() ? backend : undefined),
    list: () => [at()],
  };
}

/** What every golden built by this runtime gets; the host wires it (the daemon
 * bundle and the harness install script live there, not in the runtime). */
export interface GoldenRecipe {
  setup: string;
  /** Must exit 0 on a fork of the snapshot before a version is sealed. */
  smoke: string;
  baseTemplate?: string;
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** A returned string rides the deploying-daemon stage as its detail (the guest's Node version). */
  deployDaemon?: (machine: Machine) => Promise<void | string>;
  /** The person's files, tools and agents from the saved recipe; applied after the daemon, before the harness. */
  import?: GoldenImport;
  /** Every exec on a builder or its smoke fork, once it has returned or failed; the host's run log. */
  onExec?: (exec: GoldenExec) => void;
  /** Absolute guest paths the seal archives as the image vault: the sign-in state the ticked rows name and the
   * secrets files. Absent on a copy's own build, whose vault is the record's already. */
  vaultPaths?: readonly string[];
  /** The small recipe this build was planned from, kept on the record so another place builds from what was sealed. */
  source?: Recipe;
}

/** One exec on a golden machine as the run log records it: the command, what came back, and how long it took. */
export interface GoldenExec {
  machineId: string;
  cmd: string;
  ms: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The exec itself failed (the machine gone, the request refused); no exit code exists. */
  error?: string;
}

/** `ranIn` absent means the workspace's kind named no folder, so the machine's own home is where its shell landed. */
export interface RunningExec extends ExecStream {
  readonly ranIn?: string;
}

/** What a host wires for the one local workspace this computer can be: the backend that answers with this computer,
 * how a turn's process is launched on it (a real child, not the guest's polled road), where each harness keeps its
 * own sessions here, and the environment a turn runs under. Absent, the runtime serves cloud workspaces alone and
 * `createLocal` is refused. The one place the local variant is registered beside the cloud default. */
export interface LocalWiring {
  /** This computer's backend, which publishes the folder its commands run in: the folder a turn and a command start
   * in when the caller names none is that one and not the person's home, which is one `cd` away and holds the
   * checkouts they work in themselves. One fact, so the roads that go through the runtime and the ones that reach
   * the machine directly cannot land in two different folders. */
  backend: MachineBackend & { readonly folder: string };
  /** The launch factory for a turn on this computer, under the limits the registry hands every turn (the turn's own
   * by default, none for the exec verb), so a local turn is cut the way a cloud turn is. `waiting` rides beside them
   * and is not one: it says the run is stopped on a question only a person can answer, which holds the idle clock. */
  execStream: (opts?: MachineExecOptions, waiting?: TurnWaiting) => ExecStreamFactory;
  home: (agentId: string) => string;
  /** The person's own home: where this computer's daemon browses from, and what a path under it is shortened
   * against. */
  homeDir: string;
  /** Where the folders that daemon may browse as projects are written down. The host that started it names the
   * file, beside the state it serves, so one host's roots are never another's. */
  rootsPath: string;
  /** The environment a turn on this computer runs under, asked every time rather than copied: this process's own
   * environment moves after a host is built, the login shell PATH among them, and a copy would outlive the change. */
  env: () => Readonly<Record<string, string>>;
  /** Where this computer's daemon listens and the token that opens it, in the shape a cloud fork's preview route
   * arrives in, so the panes and the status probe read one view. The host starts that daemon on the first call and
   * closes it in close(); a host that wires none leaves the local workspace's panes with nothing to dial. */
  daemonRoad?: () => Promise<DaemonReachView>;
  /** The daemon staged beside this host, which is what a workspace here runs and what the copy road spawns: the
   * version its binary answers as and the line that stages the right one. Both or neither, since a version with no
   * fix line cannot word the refusal. A wiring that answers none refuses no copy over it, which is a test harness
   * that wired no daemon. */
  hereDaemon?: HereDaemon;
  /** Starts another daemon for this computer's workspace, in place of the one this host is holding: the daemon is
   * a child of this process, so nothing else can put it back. The old one is let go of and closed, and the call
   * answers once the new one has listened. */
  restartDaemon?: () => Promise<void>;
  /** This computer's own cpu, memory and disk, pushed to the listener every sample until the returned detach runs.
   * Read off this computer's daemon, the one reader of a machine's load wsp has, so the Live rows of the workspace
   * that is this computer start it if nothing else has. One watch however many listeners there are; it opens with
   * the first and closes with the last. */
  sysSamples?: (fn: (s: SysSample) => void) => Promise<() => void>;
  /** How a copy of a project folder is made and taken away on this computer: the daemon binary's own copy verb,
   * run as a child. Every workspace here is a copy, so a wiring with none refuses every create here in one
   * sentence naming the road it lacks. */
  copier?: Copier;
  /** Which computer this is, for the one line a row says about ports being shared: the word is a Mac's or a plain
   * computer's and nothing here can know which. */
  platform: "darwin" | "linux";
  /** Frees whatever the wiring holds open on this computer when the runtime closes. */
  close?: () => Promise<void>;
}

/** The daemon beside a host on the computer it runs on: which version the binary answers as in its hello, read by
 * starting it where nothing has, and the line that stages the right one where it is behind. The host owns both
 * facts, since the binary is staged beside the command it installed and only the install road knows how to
 * replace it; the runtime reads them before it runs that binary and says nothing else about it. */
export interface HereDaemon {
  version(): Promise<number>;
  /** The version of the daemon running here now, read without starting one; nothing while none runs. */
  held?(): number | undefined;
  fix: string;
}

/** What the host wires for the seed half of an add: the menu for a folder on this computer, and the archive of
 * whichever rows the person ticked. Both read that folder, which is why neither is the runtime's own. */
export interface SeedWiring {
  /** `homes` is each agent's folder on this computer as `agents.homesHere` answers it. */
  plan(folder: string, homes: Readonly<Record<string, string>>): Promise<SeedPlan>;
  pack(o: { plan: SeedPlan; choice: SeedChoice; homes: Readonly<Record<string, string>> }): Promise<{ tar: Buffer; files: number; bytes: number; commits: number; left: readonly string[] }>;
}

export interface RuntimeOptions {
  backend: MachineBackend;
  /** The file this runtime's store is kept in, for the one refusal that asks a person to move it aside: a record
   * written before projects were records of their own is not read, so the sentence has to name what to move. */
  statePath?: string;
  /** The local computer as a workspace, when a host wires it; the cloud backend serves every other workspace. */
  local?: LocalWiring;
  /** The computers joined to this host as places, when a host wires the keys and the provider row for them:
   * absent, the runtime holds no place and every place op is refused. Named for the links it wires rather than
   * `places`, which is the row below: that one is where this host can build a copy of its image, and one option
   * cannot be two things. `rt.places`, the `places.*` ops and `wsp places` are this one's. */
  placeLinks?: PlaceWiring;
  /** How long a computer has to dial back after its own join before an install gives up on it; the door's own wait
   * unless a test shortens it. */
  placeJoinWaitMs?: number;
  /** How long a computer that took an update has to dial back running it before the answer says what it still
   * reads; the door's own wait unless a test shortens it. */
  placeUpdateWaitMs?: number;
  /** The same for one dial of a computer, which the door bounds itself rather than leaving to whatever road the
   * dial takes. */
  placeDialWaitMs?: number;
  /** The same for one machine frame on a place link with no bound of its own. */
  placeFrameWaitMs?: number;
  /** The same for how long a frame that may be asked again waits on a computer's link to come back. */
  placeRelinkWaitMs?: number;
  store: Store;
  adapters: Record<string, HarnessAdapterFactory>;
  /** The variables the vault hands a turn, read at each launch off the wsp home's .env, never copied: a token
   * minted after the host started reaches the next turn. Absent, turns get none. */
  vault?: () => Readonly<Record<string, string>>;
  /** The recipes the host keeps beside its state, which the computers that follow one sync to. */
  recipes?: RecipeShelf;
  /** Reads LiteLLM's price file, the one outbound read the usage ledger makes, once a day; absent, nothing is read and
   * no row is priced off a table. The host wires GitHub's copy of it. */
  pricesFetch?: () => Promise<unknown>;
  /** How a folder on this computer is read and packed to seed a project on another computer. The runtime reads no
   * folder of the person's itself: the host wires the collector's menu and its own pack, and without them a folder
   * can only be a project on this computer. */
  seed?: SeedWiring;
  /** Required for golden.prepare / golden.seal; the scripted golden.build carries its own. */
  goldenRecipe?: GoldenRecipe;
  /** How a copy of the image is planned off the record, every login set to skip. The runtime writes no recipe of
   * its own, so without it no copy is built anywhere: the build op, the build behind a place being added or a
   * version cut, and a create that waits on one all stop at the one sentence. Asked for only once a build is going
   * to run, since it reads this computer. */
  copyRecipe?: (image: SealedImage) => Promise<GoldenRecipe> | GoldenRecipe;
  /** Where this host can build a copy of its image. Absent, one place named "default" over `backend`; the host
   * passes a row per provider module this computer is set up for, the wired one first. */
  places?: PlaceBackends;
  /**
   * Explicit guest paths carried across an upgrade. Default: everything under
   * /root except golden-provided dirs (VAULT_SKIP), enumerated at export time.
   */
  vaultPaths?: string[];
  /** What a vault export leaves behind, at those paths and under them: the project bundle's cache rule, so a
   * checkout's installs, build output and nested worktrees never travel and never count against the nap-time cap. */
  vaultCaches?: CacheRule;
  /** Defaults for the status poller / cost ticker (tests shrink the intervals). */
  status?: StatusWatchOptions;
  /** Defaults for a turn's stream on a machine: the poll pace and the clock its launch retry and its polls wait on
   * (tests hand in one they move by hand). Each road's own options win over these. */
  machineExec?: MachineExecOptions;
  idle?: { defaultWindowMs?: number };
  /** Drives the idle window and the transcript debounce; tests inject one they advance by hand. */
  clock?: Clock;
  /** Where the reads off a git host keep their bodies and ETags; held in memory where none is given. */
  githubCache?: GitHubCache;
  /** How long a seal waits for a killed machine to read gone (tests shrink it). */
  killConfirm?: KillConfirm;
  /** How long a seal waits between snapshot attempts the provider refused (tests shrink it). */
  snapshotRetryMs?: number;
  /** Names this machine and install on the holds it writes, so two machines over one state file never mistake
   * each other's. The entry points pass hostIdentity(); the bare hostname when absent, which touches no disk. */
  hostId?: string;
  wake?: WakeOptions;
  /** How long one read of the provider gets before a wake asks again (tests shrink it). */
  providerReadMs?: number;
  /** How long a gone verdict waits before it reads the machine's state once more (tests shrink it; 0 reads at once). */
  goneConfirmMs?: number;
  /** How a turn on this computer reaches back into this host: the loopback it dials, filled once the host's socket
   * binds and read at each turn, and the wsp command it runs. A fork needs neither, since its wsp rides the link
   * this host holds to its daemon. */
  agents?: { here?: { url?: string }; wspMcp?: McpServerSpec };
  /** The seed each machine's own daemon token is derived from, so a test that pins one reads a machine's token off
   * its reach view rather than naming it. Absent, every machine's token is minted at random. */
  daemonToken?: string;
  /** How this host dials a workspace's own daemon: for the frames the runtime sends itself, and for the channel a
   * client of this host drives one frame at a time; the real dial unless a test hands in its own. */
  daemonChannel?: (o: DaemonChannelOptions) => Promise<DaemonChannel>;
  /** How long a turn's launch waits on the snapshot of its folder before it runs without one (tests shrink it). */
  turnSnapshotMs?: number;
  /** How long a daemon gets to announce itself when an update reads the version either side of its deploy; the
   * hello lands on connect, so a daemon that is there answers in one round trip (tests shrink it). */
  daemonHelloTimeoutMs?: number;
  /** How the agents, skills and MCP servers are read off a computer or a workspace; the host wires the catalog's
   * readers. Absent, every agents.read is refused. */
  agentsReader?: AgentsReader;
  /** How the host signs agents in on a target, keeps their keys and writes the wsp tools into their configs; the host
   * wires the catalog's roads. Absent, every one of those acts is refused. */
  agentsActs?: AgentsActs;
  /** How the host searches skills.sh and previews, installs, turns off and on and removes a skill on a target; the
   * host wires skills.sh and the catalog's skill folders. Absent, every one of those is refused. */
  skillsActs?: SkillsActs;
  /** How the host adds, removes and turns off and on one MCP server in an agent's config on a target; the host wires
   * the catalog's format modules. Absent, every one of those is refused. */
  serversActs?: ServersActs;
  /** How the host asks Google for a remote MCP server's icon. Absent, every server draws its glyph. */
  serverIcons?: ServerIcons;
  /** The environment labs is read from; this process's when unset, which the entry points mean and a test does not:
   * a test says the environment it means here rather than inheriting the shell that started it. */
  env?: Readonly<Record<string, string | undefined>>;
  /** What a road that needs a machine says where nothing here starts one; the host names it from what it registered.
   * NO_PROVIDER_LINE when unset. */
  noMachinesLine?: string;
}

export interface WakeOptions {
  /** How long after a wake gave up the provider is read once more for a resume that landed late (tests shrink it). */
  lateReadMs?: number;
  /** A nap-time vault archive over this is not stored (a warning names the size). */
  vaultCapBytes?: number;
}

/** One read of the provider before a wake asks again; the client sets no request timeout of its own. */
export const PROVIDER_READ_MS = 30_000;
/** The pause a gone verdict takes before it reads the state once more. A verdict ends every turn on the machine and
 * their unpushed work with them, and the provider answered one call 404 over a machine a direct read found running
 * two minutes later (2026-09-08), so the verdict is worth a second read. */
export const GONE_CONFIRM_MS = 5_000;
/** What a gone sighting came to: the record settled gone, the state read found the machine there after all, the
 * reads that were to confirm it failed, or the record moved out from under the read (a rebuild, or another road
 * settled it first) and the sighting is stale. */
export type GoneOutcome = "settled" | "not-gone" | "unchecked" | "moot";
/** A read that found the machine, handed to the load in place of its own get. */
export type FoundMachine = Sighting & { machine: Machine };
/** Whether the record is gone after the sighting, by this one or by the road that settled it first. */
export const settled = (o: GoneOutcome): boolean => o === "settled" || o === "moot";
/** A resume the runtime stopped waiting on can still land: one read this long after a wake gave up finds it. */
export const WAKE_LATE_READ_MS = 3 * 60_000;
/** A daemon that is up answers the hello on connect; a machine whose daemon is gone costs this once on each side of an update. */
export const DAEMON_HELLO_TIMEOUT_MS = 5_000;
/** The probe's fetch bound; the frame keeps loading meanwhile, so silence costs nothing but the sentence. */
export const PORT_PROBE_TIMEOUT_MS = 10_000;

/** How long a project's clone inside a fresh copy may take before the create gives up on it. A repo of the size
 * wsp is dogfooded on lands in seconds; the budget is for a cold cache on a small machine. */
export const CLONE_MS = 300_000;

/** Why a login is no project: `wsp add user@host` joins a computer, which is the other thing this verb does, and
 * a person who typed one meant that. */
export const ADD_IS_A_COMPUTER_LINE = "that is a computer, not a project; wsp add user@host joins it, and a project is a folder here or a repo's url with --on <computer>";

/** The folder a person named as this computer sees it: `~` is their home and a relative word is under the folder
 * the host runs in, which is where a caller that resolved nothing typed it. */
export const folderNamed = (path: string): string => {
  const named = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : isAbsolute(path) ? path : resolvePathOn(path);
  // Through the links: a folder under /tmp on a Mac is reached by two names, and git answers with the real one, so
  // a record written under the other would never match the repo it names.
  try {
    return realpathSync(named);
  } catch {
    return named;
  }
};

/** Whether two sources are the same place: one source on one computer is one project, and the url or the path is
 * the whole of what says so. */
export const sameSource = (a: ProjectSource, b: ProjectSource): boolean => (a.kind === "git" && b.kind === "git" ? a.url === b.url : a.kind === "folder" && b.kind === "folder" ? a.path === b.path : false);

/** What a branch on a project here is refused with when the host wired no daemon binary: the binary makes worktrees. */
export const NO_COPIER_HERE = "this host has no daemon binary beside it to make a worktree with; stage this wsp's daemon binary and try again";


/** The last line a command said, which is what git puts its reason on. */
export const lastLineOf = (said: string): string => said.trimEnd().split("\n").at(-1)?.trim() ?? "";
/** How the import's done line reads each agent's outcome, after the agent's name. */
export const OUTCOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed but not yet in its session list",
  carried: "carried unchanged since it is not on the machine",
  nothing: "had nothing to carry",
};
export function outcomeWords(a: ProjectAgentResult): string {
  if (a.outcome === "failed") return `failed: ${a.error ?? "no reason given"}`;
  const word = OUTCOME_WORDS[a.outcome];
  const note = a.note !== undefined ? ` (${a.note})` : "";
  if (a.outcome === "moved" && a.rows !== undefined) return `${word}, ${a.rows > 0 ? `${plural(a.rows, "row")} merged` : "its rows already there"}${note}`;
  if (a.outcome === "transcript-only") return `${word}${note}`;
  return word;
}
/** Bounds a merge that hangs; one project's rows take python3 well under it. */
export const MERGE_DEADLINE_MS = 120_000;
/** Bounds a listing that hangs; walking the agents' homes takes python3 well under it, and past what one inline exec is allowed to run. */
export const LISTING_DEADLINE_MS = 120_000;

/** Runs one agent's merge script on the machine and folds what it printed into the agent's result: rows merged is
 * moved, a store not there yet leaves the rows waiting with the reason, a failure carries the last line of stderr.
 * The script is removed by its own exec once the run ended, so a run the deadline killed leaves nothing behind. */
export async function mergeOnMachine(machine: Machine, script: string, agent: ProjectAgentResult): Promise<ProjectAgentResult> {
  const dir = script.slice(0, script.lastIndexOf("/"));
  let run: ExecResult;
  try {
    run = await machine.run(`python3 ${shellQuote(script)}`, { deadlineMs: MERGE_DEADLINE_MS });
  } finally {
    await machine.exec(`rm -f ${shellQuote(script)}; rmdir ${shellQuote(dir)} 2>/dev/null`).catch(() => undefined);
  }
  if (run.exitCode !== 0) {
    const why = run.stderr.trimEnd().split("\n").at(-1) || "no output";
    return { ...agent, outcome: "failed", error: `the merge on the machine failed (exit ${run.exitCode}): ${why}` };
  }
  try {
    const out = parseMergeOutput(run.stdout);
    if ("waiting" in out) return { ...agent, note: out.waiting };
    return { ...agent, outcome: "moved", rows: out.merged, ...(out.note !== undefined ? { note: out.note } : {}) };
  } catch (e) {
    return { ...agent, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The same for the export's done line, where the state lands on this computer; `carried` cannot happen here. */
export const HOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed but not yet in its session list here",
  carried: "carried unchanged",
  nothing: "had nothing to bring",
};

/** One agent's export outcome in words: the name, the sessions counted, what became of them, the rollouts skipped. */
export function homeOutcome(a: LandedAgent): string {
  const counted = a.sessions === undefined ? "" : ` (${plural(a.sessions, "session")})`;
  const skipped = a.skipped === undefined || a.skipped === 0 ? "" : `, ${plural(a.skipped, "indexed rollout")} not under sessions/ skipped`;
  return `${a.name}${counted} ${a.outcome === "failed" ? `failed: ${a.error ?? "no reason given"}` : HOME_WORDS[a.outcome]}${skipped}`;
}

/** Vite's and Next's refusals fit in a few hundred bytes; a page that loaded fine is not carried back whole. */
export const PORT_PROBE_BODY_CAP = 2048;
export const VAULT_CAP_BYTES = 200 * 1024 * 1024;
/** Blob collection: the latest nap-time vault per workspace id. */
export const VAULTS = "vaults";

/** What `until` rejects with when the deadline passed and not the promise, so a caller that retries can tell the
 * two apart. */
export class DeadlineError extends Error {}

/** Rejects once the deadline passes; the underlying promise is left to settle on its own. The deadline is read on
 * the clock given, so a move budget measured on an injected clock times out on that clock. */
export function until<T>(p: Promise<T>, deadline: number, what: string, clock: Clock = realClock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ms = Math.max(0, deadline - clock.now());
    const cancel = clock.schedule(() => reject(new DeadlineError(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      v => { cancel(); resolve(v); },
      e => { cancel(); reject(e); },
    );
  });
}

/** Size fields the provider reports that differ from what was created, as
 * "field got != expected". createdAt is left out on purpose: Solari moves it
 * to the resume time on every resume, healthy ones included (measured 3/3
 * with exec answering right after), so it only rides along in the reason. */
export function shapeFault(expected: MachineShape, actual: MachineShape): string | undefined {
  const diffs: string[] = [];
  for (const key of ["cpu", "memMb"] as const) {
    const want = expected[key];
    const got = actual[key];
    if (want !== undefined && got !== undefined && want !== got) diffs.push(`${key} ${got} != ${want}`);
  }
  return diffs.length === 0 ? undefined : diffs.join(", ");
}

/** Dirs the golden image already provides on every fresh fork; re-vaulting
 * them is dead weight, and extracting them with --recursive-unlink would
 * delete the fork's own copies first (the image's uv, pipx and pnpm installs live in .local). */
export const VAULT_SKIP = new Set([".local", ".cache", ".npm"]);

/** One RFC 1123 label: lowercase alphanumerics and hyphens, at most 63 chars, hyphen-free at both ends. */
export function hostnameFor(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return label === "" ? "wsp" : label;
}

/** A fresh fork boots as "localhost"; naming it is cosmetic, so a guest that refuses is only logged. Hands back the
 * name set, or the refusal. */
export async function setHostname(machine: Machine, name: string): Promise<{ host: string; refused?: string }> {
  const host = hostnameFor(name);
  const res = await machine
    .exec(`hostname ${host} && echo ${host} > /etc/hostname`)
    .catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
  if (res.exitCode === 0) return { host };
  const refused = `hostname ${host} on ${machine.id} failed: ${res.stderr.trim()}`;
  console.warn(refused);
  return { host, refused };
}

export interface GoldenBuildRequest extends Omit<BuildGoldenOptions, "backend" | "manifest" | "hostId"> {
  /** Store key; several goldens can coexist. */
  name?: string;
}

/** One version the promote road visited: recorded with the template promoted for it, with how many templates
 * already carried the name when the listing was given, or left as it was with the reason, a lost snapshot in the
 * row's own words. */
export type GoldenPromotion = { golden: string; version: number } & ({ templateId: string; sharing?: number } | { error: string });

export interface GoldenUpgradeResult {
  manifest: GoldenManifest;
  version: GoldenVersion;
  /** builder: the delta went onto the builder kept since the save; fork: onto a fresh fork of the previous head. */
  road: "builder" | "fork";
  /** The previous version's snapshot was deleted and the version dropped from the manifest. */
  previousDropped: boolean;
  /** The builder is still running for its window; false when the cap fallback or a drop ended it. */
  builderKept: boolean;
}

/** How long a builder built from a recipe stays running after its seal, so one more change re-snapshots it (about
 * 11 s, measured) instead of forking. Our clock on the record, since every read of the machine resets the provider's. */
export const GRACE_MS = 10 * 60_000;

/** How long after one attempt to put a daemon back on a machine before another. A deploy that failed fails the
 * same way fifteen seconds later and the row has already said so, so the retry is slow enough to be worth
 * watching and quick enough that a machine whose npm registry blinked is not left dark for an hour. */
export const DAEMON_REVIVE_AGAIN_MS = 5 * 60_000;

/** How long a machine that answered with what it lacks is left alone before a daemon is offered to it again. Far
 * wider than the revive window because nothing this host does moves it: a compiler or a lingering login is a
 * person's to put on their own machine, and until they do, every attempt spends a round trip to be told the same
 * sentence. Read across host starts, since the refusal is on the record. */
export const DAEMON_LACKS_AGAIN_MS = 60 * 60_000;

/** A machine of this setup's the sweep found with no record and recorded again, under the id and name its fork stamped. */
export interface AdoptedMachine {
  id: string;
  workspaceId: string;
  name: string;
  phase: WorkspacePhase;
}

/** What one sweep did: the engine's kills and sparings, plus the machines it recorded rather than killed. */
export interface SweepResult extends ReapResult {
  adopted?: AdoptedMachine[];
}

/** The status tracker as the runtime serves it: the tracker's own surface, with the caller's origin last on the two
 * reads that answer for workspaces, so the snapshot leaves out what that caller may not drive. */
export interface OriginStatusApi extends Omit<StatusApi, "list" | "history"> {
  list(opts?: StatusListOptions, origin?: Caller): Promise<WorkspaceStatus[]>;
  history(workspaceId: string, origin?: Caller): Promise<WorkspaceCostEvent[]>;
}

/** How often a read of the Usage page may read the logs again: once a minute, so a turn run outside wsp shows soon. */
export const LOG_READ_EVERY_MS = 60_000;

/** How long one computer's daemon may take over its logs before that computer reads as not read this time: the first
 * read after the daemon starts opens every file, and the files it read are kept, so the next one is quick. */
export const LOG_READ_MS = 30_000;

/** How long one reset script may run on a computer: each of its reads waits ten seconds at most for a line. */
export const RESET_EXEC_MS = 30_000;

export interface UsageDoor {
  /** outside: count the rows read from the computers' agent logs, where the person has not turned that off. */
  used(q: { range: UsageRange; split: UsageSplit; outside?: boolean }): Promise<UsedAnswer>;
  accounts(): Promise<AccountsAnswer>;
  /** A computer's readings over a range, off the daemon that kept them: this computer, a joined one, or a workspace's
   * own machine. A daemon that keeps none, or none yet, answers no points. */
  readings(target: { placeId: string } | { workspaceId: string }, range: UsageRange, origin?: Caller): Promise<ReadingsAnswer>;
  /** Spends one of an account's banked resets on a computer of the person's that holds its login, `on` naming one by
   * a word a person types. Refused before anything runs for a key, an away computer and a provider's machines. */
  reset(ask: { account: string; creditId?: string; on?: string }): Promise<ResetAnswer>;
}
