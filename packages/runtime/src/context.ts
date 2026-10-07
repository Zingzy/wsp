// SPDX-License-Identifier: AGPL-3.0-only
import type {
  GoneWatch,
  UpgradePlan,
  Builder,
  GoldenImport,
  SealResult,
  GoldenManifest,
  GoldenVersion,
  ListedMachine,
  Lifecycle,
  Machine,
  MachineBackend,
  MachineShape,
  MachineState,
  ReapFailure,
  ReapedMachine,
  VaultOptions,
} from "@wsp/engine";
import type { DaemonFrame } from "@wsp/protocol";
import type {
  AdapterEvent,
  SessionOrigin,
  AttachmentRoad,
  Capabilities,
  DaemonReachView,
  EventUnion,
  ExecStreamFactory,
  GoldenBuilderView,
  GoldenLogin,
  GoldenStage,
  GoldenStep,
  HarnessCatalog,
  Preferences,
  RecipeDigest,
  SealedImage,
  SealedImageBuilt,
  ProjectGolden,
  ProjectRef,
  ProjectSource,
  ProjectView,
  SeedChoice,
  SeedPlan,
  PermissionAsk,
  ReachState,
  SessionEvent,
  SessionRenameWrite,
  SessionStartOutcome,
  SessionView,
  TitleSource,
  Attachment,
  AttachmentRecord,
  McpServerSpec,
  TurnImage,
  TurnResult,
  Caller,
  WorkspaceAgents,
  WorkspaceKind,
  PlaceSettings,
  WorkspaceProject,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
  WorkspaceCreatingEvent,
} from "@wsp/protocol";
import type { LandingDeps, ProjectLanding } from "./project-landing.js";
import type {
  ThreadScope,
  WorkspaceOrigin,
  GitPrViewReply,
  GitRepoReadReply,
  GitUpdateReply,
  TreeFact,
  TreeRecord,
  PullRequestSeen,
  Checkout,
  SpawnAct,
  ThreadWaitingOn,
  ThreadCapWait,
} from "@wsp/protocol";
import type { CopyBuild, GoneSeenBy, WorktreeSettled } from "@wsp/protocol";
import type { agentsReads } from "./agents-read.js";
import type { DaemonChannel, DaemonChannelOptions } from "./daemon-channel.js";
import type { MachineExecOptions, TurnWaiting } from "./machine-exec.js";
import type { AccessChoice, ProjectOverrides, RanPicks, ResolvedFolder } from "@wsp/protocol";
import type { Clock } from "./clock.js";
import type { StatusApi } from "./status.js";
import type { DeviceDoor, ScopedRoad } from "./devices.js";
import type { PlaceDoor } from "./places.js";
import type { Store } from "./store.js";
import type { Slates } from "./slates.js";
import type { GitHubCache } from "./github-cache.js";
import type { AccountsAnswer } from "@wsp/protocol";
import type { IssueRead, PullRequest, StartResult, WorkspaceFrom } from "@wsp/protocol";
import type { Vaulted } from "./usage.js";
import type { ThreadFacts } from "@wsp/protocol";
import type { TranscriptRows } from "./sqlite-transcripts.js";
import type { TranscriptReader } from "./transcript-reader.js";
import type { HarnessSession, HarnessAdapter, HarnessStartOptions, StartPicksAsked } from "./types/harness.js";
import type {
  WorkspaceSpec,
  CreatedWorkspace,
  CreateWorkspaceOptions,
  ProjectImportOptions,
  WorkspaceRecord,
  LiveWorkspace,
  StageReport,
  SessionHandle,
  PlaceBackends,
  GoldenRecipe,
  RuntimeOptions,
  GoneOutcome,
  FoundMachine,
  AdoptedMachine,
  UsageDoor,
} from "./types/wiring.js";
import type { Runtime } from "./types/api.js";
import type {
  TranscriptIndex,
  Taken,
  TurnWritten,
  TranscriptRecord,
  TurnLive,
  TurnAsked,
  KeptProcess,
  KeptLaunch,
  ThreadRecord,
  BuilderRecord,
  LiveBuilder,
  KindModule,
  ImportReport,
  ImportLanded,
  WorkspaceLike,
  StageFrame,
  ChildStart,
  MachineMoment,
  LiveSession,
  Reopened,
  SessionEntry,
  SESSION_FACTS,
} from "./types/internal.js";
import type { EventBus } from "./types/events.js";
import type { HarnessAdapterFactory } from "./types/harness.js";
import type { LocalWiring } from "./types/wiring.js";
import type { AgentSetups } from "./agent-setup.js";
import type { PairedDevice } from "./devices.js";
import type { IdlePolicy } from "./idle.js";
import type { PlanAlerts } from "./plan-alerts.js";
import type { UsageLedger, ReplayedStamp } from "./usage.js";
import type { AccountRoad, AccountRow } from "@wsp/protocol";

/** The lets more than one area reads or writes, read through ctx.state at the moment they are needed. */
export interface RuntimeState {
  sayStops: ((line: string) => void) | undefined;
  /** When this state file began keeping read stamps: what a thread no window has shown since reads as its stamp. */
  readsSince: number;
  rootsRecheck: ReturnType<typeof setInterval> | undefined;
  owner: string;
  copiesMoving: Promise<void> | undefined;
  sweepTimer: (() => void) | undefined;
  sweeping: Promise<void> | undefined;
  sweepStopped: boolean;
  /** Marks the record as this process's, now; the sweep and the heartbeat timer refresh it and close() clears it. */
  beat: (() => void) | undefined;
  closed: boolean;
  /** Set as close() starts, before it shuts the daemon channels a card read still out goes over. */
  closing: boolean;
  ticking: Promise<void> | undefined;
  /** The record as last read or written, so a start reads the defaults without a trip to the store. */
  preferencesHeld: Preferences | undefined;
}

/** Built in createRuntime before any area and never reassigned: the options, the maps every area shares and the helpers they stand on. */
export interface RuntimeCore {
  readonly opts: RuntimeOptions;
  readonly backend: MachineBackend;
  readonly store: Store;
  readonly adapters: Record<string, HarnessAdapterFactory>;
  readonly local: LocalWiring | undefined;
  readonly placeDoor: PlaceDoor | undefined;
  readonly bus: EventBus & { emit(event: EventUnion): void; pass(event: EventUnion): void; };
  readonly goneConfirmMs: number;
  readonly lateReadMs: number;
  readonly clock: Clock;
  readonly githubCache: GitHubCache;
  readonly readsState: (machine: Machine) => Promise<MachineState | undefined>;
  readonly tookTheResume: (reads: MachineState | undefined) => boolean;
  readonly sleeps: (ms: number) => Promise<void>;
  readonly daemonHelloTimeoutMs: number;
  readonly vaultCapBytes: number;
  readonly defaultIdleWindowMs: number;
  readonly hostId: string;
  readonly vaultExport: (m: Machine, o?: Pick<VaultOptions, "maxBytes" | "drop">) => Promise<Buffer>;
  readonly imageMovePlan: (m: Machine, from: GoldenVersion | undefined, to: GoldenVersion) => Promise<UpgradePlan>;
  readonly deviceDoor: DeviceDoor;
  readonly threadLaunch: (entry: LiveWorkspace, threadId: string, rootThreadId: string, o?: { aside?: true; }) => Promise<{ scoped?: Awaited<ReturnType<(name: string, scope: ThreadScope, now: number, more?: { road?: ScopedRoad; aside?: true; }) => Promise<PairedDevice>>>; env: Record<string, string>; wsp?: McpServerSpec; }>;
  readonly landing: Map<string, number>;
  readonly live: Map<string, LiveWorkspace>;
  readonly projectsHeld: Map<string, ProjectView>;
  readonly setups: AgentSetups;
  readonly builders: Map<string, LiveBuilder>;
  readonly gone: GoneWatch;
  readonly preparing: Map<string, { hash: string | undefined; promise: Promise<GoldenBuilderView> }>;
  readonly copyBuilds: Map<string, Promise<SealedImageBuilt>>;
  readonly stageAt: Map<string, { place: string; name: string; named: boolean; frame: StageFrame }>;
  readonly copyRows: Map<string, CopyBuild>;
  readonly rowSaysFailure: (place: string, e: unknown) => boolean;
  readonly placeAway: (place: string) => boolean;
  readonly frameStopped: (place: string, name: string, e: unknown) => void;
  readonly threadRecords: Map<string, ThreadRecord & { workspaceId: string }>;
  readonly snoozeTimers: Map<string, () => void>;
  readonly wakeAt: (threadId: string, until: number) => void;
  readonly resumeTimers: Map<string, () => void>;
  readonly resumeOnReset: (threadId: string, at: number) => void;
  readonly sessions: Map<string, SessionEntry>;
  readonly execs: Set<{ workspaceId: string; end: (reason: string) => void }>;
  /** Each running turn's row of what its agent held, written as the host closes. */
  readonly heldAtClose: Set<() => void>;
  /** What a starting host still has out on each machine, by workspace id: the re-open of its turns, then the sweep of
   * its runs, which ends every run it lists that the host did not keep. Everything that starts a run there waits for it. */
  readonly bootWork: Map<string, Promise<void>>;
  readonly indexFlushes: Map<string, Promise<void>>;
  readonly transcripts: Map<string, SessionEvent[]>;
  readonly rows: TranscriptRows | undefined;
  readonly unreadIndexes: Set<string>;
  readonly pendingEvents: Map<string, SessionEvent[]>;
  readonly pendingBytes: Map<string, number>;
  readonly transcriptIndex: Map<string, TranscriptIndex>;
  readonly indexFor: (workspaceId: string) => TranscriptIndex;
  readonly transcriptBytes: Map<string, number>;
  readonly sizeOf: (e: SessionEvent) => number;
  readonly places: PlaceBackends;
  readonly state: RuntimeState;
}

export interface KindsArea {
  readonly projectOf: (dest: string, size: number) => WorkspaceProject;
  readonly remoteHere: (path: string) => Promise<{ remote: string; defaultBranch: string }>;
  readonly gitHere: (cwd: string, args: readonly string[], timeoutMs?: number, stdin?: string) => Promise<{ exitCode: number; stdout: string; stderr: string; }>;
  readonly gitTopOf: (path: string) => Promise<string | undefined>;
  readonly branchAt: (path: string) => Promise<string | undefined>;
  readonly stateFolder: () => string;
  readonly cloneHere: (word: string, source: ProjectSource, into: string) => Promise<string>;
  readonly localRoad: () => Promise<DaemonReachView>;
  readonly placeDoorOf: () => PlaceDoor;
  readonly machineReading: Set<() => void>;
  readonly moduleOf: (kind: WorkspaceKind) => KindModule;
  readonly placeAgentHome: (place: string | undefined, home: string, id: string) => string;
  readonly backendFor: (record: WorkspaceRecord) => MachineBackend;
  readonly openChannel: (o: DaemonChannelOptions) => Promise<DaemonChannel>;
  readonly backendOfKind: (kind: WorkspaceKind, place?: string) => MachineBackend;
  readonly keepsImages: (at: MachineBackend) => boolean;
  readonly pauseKeepsDisk: (at: MachineBackend) => boolean;
  readonly namesWorkspace: (at: MachineBackend) => boolean;
  readonly lifecycleOf: (entry: LiveWorkspace) => Lifecycle;
  readonly execFactoryFor: (entry: LiveWorkspace, o?: MachineExecOptions, waiting?: TurnWaiting) => ExecStreamFactory;
  readonly threadFolder: (entry: LiveWorkspace, o: { cwd?: string | undefined }) => Promise<string>;
  readonly kindOf: (computer: string) => WorkspaceKind;
}

export interface RulesArea {
  readonly rememberProject: (project: ProjectView) => Promise<void>;
  readonly rememberTarget: (record: WorkspaceRecord) => Promise<void>;
  readonly refuseCannot: (entry: LiveWorkspace, can: keyof Omit<Capabilities, "sizes" | "pauseMode">, action: string) => void;
  readonly pauses: (record: WorkspaceRecord) => boolean;
  readonly refusePauseless: (entry: LiveWorkspace, action: string) => void;
  readonly holdsSlot: (record: WorkspaceRecord) => boolean;
  readonly drives: (record: { kind: WorkspaceKind; machineId?: string }, caller: Caller | undefined) => boolean;
  readonly opensIn: (record: WorkspaceRecord, scope: ThreadScope | undefined) => boolean;
  readonly projectOfScope: (scope: ThreadScope) => string | undefined;
  readonly ofThreadsRepository: (caller: Caller | undefined, project: string) => boolean;
  readonly projectReached: (caller: Caller | undefined, project: string) => boolean;
  readonly refusalFor: (record: WorkspaceLike | undefined, caller: Caller | undefined) => string | undefined;
  readonly refuseRelayed: (record: WorkspaceLike | undefined, caller: Caller | undefined) => void;
  readonly refuseNamed: (workspaceId: string, caller: Caller | undefined) => void;
  readonly held: () => LiveWorkspace[];
  readonly listedFor: (caller: Caller | undefined) => LiveWorkspace[];
  readonly refuseRecording: (named: string, caller: Caller | undefined) => void;
  readonly agentsOf: (record: WorkspaceRecord) => WorkspaceAgents | undefined;
  readonly parentOf: (threadId: string) => string | undefined;
  readonly rootOf: (threadId: string) => string;
  readonly agentsReach: (entry: LiveWorkspace) => { url?: string; wsp?: McpServerSpec } | undefined;
  readonly spawnGuard: (act: SpawnAct, caller: Caller | undefined) => (() => void);
  readonly treeOf: (scope: ThreadScope | undefined) => { parentThreadId?: string; rootThreadId?: string };
}

export interface TranscriptsArea {
  readonly keptWrites: Map<string, Promise<void>>;
  readonly keepSentImages: (workspaceId: string, threadId: string, requestId: string | undefined, attachments: readonly Attachment[]) => Promise<void>;
  readonly dropSentImages: (workspaceId: string, threadIds: readonly string[] | "all") => Promise<void>;
  readonly moveTranscript: (moving: TranscriptRecord) => Promise<void>;
  readonly loadIndex: (workspaceId: string) => Promise<void>;
  readonly moveBlobs: (rows: TranscriptRows) => void;
  readonly transcriptQueue: Map<string, Promise<void>>;
  readonly openTranscript: (workspaceId: string) => Promise<SessionEvent[]>;
  readonly transcriptReader: TranscriptReader;
  readonly dropFromTranscript: (workspaceId: string, drops: (e: SessionEvent) => boolean) => Promise<void>;
  readonly transcriptTimers: Map<string, () => void>;
  readonly daemonTokens: Map<string, { hasDaemon: boolean; at: number }>;
  readonly daemonTokenOf: (machine: Machine, path?: string) => Promise<string | undefined>;
  readonly cancelFlush: (workspaceId: string) => void;
  readonly flushTranscript: (workspaceId: string) => Promise<void>;
  readonly viewedMarks: Map<string, Record<string, string>>;
  readonly persistSessions: (workspaceId: string) => Promise<void>;
  readonly record: (unstamped: SessionEvent) => void;
  readonly accrued: Map<string, number>;
  readonly ranOn: (workspaceId: string, threadId: string, session: string | undefined) => RanPicks;
  readonly boxOf: (threadId: string) => LiveWorkspace | undefined;
}

export interface SlatesArea {
  readonly slates: Slates;
}

export interface ChannelsArea {
  readonly startedAs: (workspaceId: string, threadId: string) => string | undefined;
  readonly cutBefore: (workspaceId: string, threadId: string) => boolean;
  readonly resumedFact: (workspaceId: string, resume: string, fact: (typeof SESSION_FACTS)[number]) => string | undefined;
  readonly folderOf: (workspaceId: string, resume: string) => string | undefined;
  readonly accessOf: (workspaceId: string, threadId: string, resume: string | undefined) => string | undefined;
  readonly daemonNotes: Map<string, string>;
  readonly homeOf: (r: WorkspaceRecord) => { home?: string };
  readonly providerOf: (r: WorkspaceRecord) => string | undefined;
  readonly placeIdOf: (r: WorkspaceRecord) => string | undefined;
  readonly settingsAt: (placeId: string | undefined) => PlaceSettings | undefined;
  readonly turnLimitOf: (r: WorkspaceRecord) => MachineExecOptions | undefined;
  readonly agentsHeld: (r: WorkspaceRecord) => WorkspaceAgents;
  readonly spawnAt: (placeId: string | undefined) => WorkspaceAgents;
  readonly projectHeld: (id: string) => ProjectView;
  readonly refOf: (p: ProjectView) => ProjectRef;
  readonly checkoutOf: (r: WorkspaceRecord) => string;
  readonly computerOf: (entry: LiveWorkspace) => string;
  readonly servedByItsComputer: (entry: LiveWorkspace) => ((frame: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  readonly channelOver: (reach: DaemonReachView, name: string, onEvent: (event: Record<string, unknown>) => void) => Promise<DaemonChannel>;
  readonly withDaemon: <T>(entry: LiveWorkspace, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>) => Promise<T>;
  readonly overChannel: <T>(channel: DaemonChannel, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>) => Promise<T>;
  readonly onThisComputer: <T>(work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>, home: string) => Promise<T>) => Promise<T>;
  readonly placeGuard: (placeId: string) => Promise<void>;
  readonly placeRefuses: (placeId: string | undefined) => Promise<void>;
  readonly copyBlocked: (entry: LiveWorkspace) => Promise<void>;
  readonly WORKSPACE_FRAMES: string[];
  readonly GUEST_ROAD_FRAMES: string[];
  readonly portPids: Map<string, Map<string, number>>;
  readonly heldToOwner: (owner: string, channel: DaemonChannel) => DaemonChannel;
  readonly sharedDaemonReplaced: () => void;
  readonly turnGroups: Map<string, Set<number>>;
  readonly armRootsRecheck: () => void;
  readonly portRootsMoved: (workspaceId: string) => void;
  readonly rootedPorts: (workspaceId: string, folder: string, ptys: Map<string, number>, channel: DaemonChannel) => DaemonChannel;
  readonly copyChannel: (entry: LiveWorkspace, onEvent: (event: Record<string, unknown>) => void, carries: readonly string[]) => Promise<DaemonChannel>;
  readonly leadStart: (lead: LiveWorkspace, child: string) => Promise<ChildStart>;
  readonly startChildOn: (child: LiveWorkspace, branch: string, lead: string) => Promise<string>;
  readonly sameRepository: (a: ProjectView, b: ProjectView, caller: Caller | undefined) => boolean;
}

export interface RecordsArea {
  readonly view: (r: WorkspaceRecord) => WorkspaceView;
  readonly putLook: <K extends "theme" | "glyph">(r: WorkspaceRecord, key: K, value: WorkspaceRecord[K] | null | undefined) => void;
  readonly persist: (r: WorkspaceRecord) => Promise<void>;
  readonly shapeOf: (m: Machine) => Promise<MachineShape | undefined>;
  readonly sizeBuilt: (shape: MachineShape | undefined, asked: WorkspaceSize) => WorkspaceSize;
  readonly readMemory: (record: WorkspaceRecord, machine: Machine, sizes: MachineBackend["capabilities"]["sizes"]) => Promise<boolean>;
  readonly forkedFrom: (snapshotId: string) => string[];
  readonly copyOf: (place: string, name: string) => Promise<GoldenManifest | undefined>;
  readonly putCopy: (place: string, name: string, manifest: GoldenManifest) => Promise<void>;
  readonly copyRecipeOf: (place: string, name: string, version: number) => Promise<RecipeDigest | undefined>;
  readonly putCopyRecipe: (place: string, name: string, version: number, digest: RecipeDigest) => Promise<void>;
  readonly dropCopyRecipe: (place: string, name: string, version: number) => Promise<void>;
  readonly migrateCopies: () => Promise<void>;
  readonly recordOf: (name: string) => Promise<SealedImage | undefined>;
  readonly recordedImages: () => Promise<Set<string>>;
  readonly goldenManifestOf: (snapshotId: string) => Promise<GoldenManifest | undefined>;
  readonly recipeAsksEngine: (version: GoldenVersion) => Promise<boolean>;
  readonly imageOf: (snapshotId: string) => Promise<{ golden: string; version?: GoldenVersion; projects?: WorkspaceProject[] }>;
  readonly projectGoldenOf: (raw: unknown) => ProjectGolden;
}

export interface ReachArea {
  readonly polledReach: Map<string, { machineId: string; reach: ReachState }>;
  readonly napRefusals: Map<string, { machineId: string; said: string }>;
  readonly napRefusedOf: (entry: LiveWorkspace) => string | undefined;
  readonly napRefusedReason: (entry: LiveWorkspace) => string | undefined;
  readonly stopRefusals: Map<string, { machineId: string; said: string }>;
  readonly stopRefusedReason: (entry: LiveWorkspace) => string | undefined;
  readonly diskReason: (entry: LiveWorkspace) => string | undefined;
  readonly readDisk: (entry: LiveWorkspace) => Promise<void>;
  readonly reachOf: (entry: LiveWorkspace) => ReachState;
  readonly emitStatus: (entry: LiveWorkspace, reach: ReachState, reason?: string) => Promise<void>;
  readonly saysWaking: (entry: LiveWorkspace, words: string) => Promise<void>;
  readonly pingDaemon: (entry: LiveWorkspace) => Promise<string | undefined>;
  readonly helloVersion: (entry: LiveWorkspace) => Promise<number | null>;
  readonly pushStatus: (entry: LiveWorkspace) => Promise<void>;
  readonly readCheckout: (entry: LiveWorkspace, force: boolean) => Promise<Checkout | undefined>;
  readonly readTree: (lead: LiveWorkspace) => Promise<TreeFact | undefined>;
  readonly readLeadOf: (child: LiveWorkspace) => void;
  readonly statusNow: (entry: LiveWorkspace) => Promise<void>;
}

export interface PullRequestsArea {
  readonly readHost: <T>(entry: LiveWorkspace, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T) => Promise<T>;
  readonly pullRequestOn: (workspaceId: string, origin: Caller | undefined) => Promise<{ entry: LiveWorkspace; remote: string; number: number }>;
  readonly pageKey: (remote: string, number: number) => string;
  readonly readPage: (entry: LiveWorkspace, remote: string, number: number, fresh: boolean) => Promise<{ page: GitPrViewReply; here: boolean }>;
  readonly postAsPerson: <T>(remote: string, number: number, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T) => Promise<T>;
  readonly readPullRequest: (entry: LiveWorkspace, force: boolean, whole?: boolean) => Promise<PullRequestSeen | undefined>;
  readonly takePullRequest: (entry: LiveWorkspace, seen: PullRequestSeen | undefined) => Promise<void>;
  readonly pollPullRequest: (entry: LiveWorkspace, from?: number) => void;
  readonly keepTree: (child: LiveWorkspace, kept: TreeRecord) => Promise<void>;
  readonly settleTree: (entry: LiveWorkspace) => Promise<void>;
  readonly mergeSettings: (remote: string) => Promise<GitRepoReadReply>;
  readonly updateCopy: (entry: LiveWorkspace) => Promise<GitUpdateReply>;
}

export interface DaemonArea {
  readonly sendDetached: (workspaceId: string, o: { prompt: string; thread?: string }, origin: Caller | undefined) => Promise<DetachedSend>;
  readonly toFirstThread: (workspaceId: string, prompt: string, origin: Caller | undefined) => Promise<DetachedSend>;
  readonly writeDaemonRoots: (entry: LiveWorkspace, strict?: boolean) => Promise<void>;
  readonly turnRuns: (workspaceId: string) => boolean;
  readonly deployDaemonOn: (entry: LiveWorkspace, deploy: (e: LiveWorkspace) => Promise<void | string>) => Promise<void | string>;
  readonly daemonSyncs: Map<string, Promise<void>>;
  readonly syncDaemon: (entry: LiveWorkspace) => Promise<void>;
  readonly revivedAt: Map<string, MachineMoment>;
  readonly unreadAt: Map<string, MachineMoment>;
  readonly unreached: Map<string, { machineId: string; line: string }>;
  readonly unreachedOf: (entry: LiveWorkspace) => string | undefined;
  readonly reviveDaemon: (entry: LiveWorkspace, reach: ReachState) => void;
  readonly offerDaemonAgain: (entry: LiveWorkspace, polled: WorkspaceStatus) => void;
  readonly readVersionAgain: (entry: LiveWorkspace, polled: WorkspaceStatus) => void;
}

export interface MachinesArea {
  readonly imageMark: () => string;
  readonly inflight: Set<string>;
  readonly claiming: <T>(purpose: string, run: (b: MachineBackend) => Promise<T>, at?: MachineBackend) => Promise<T>;
  readonly observed: (machine: Machine) => Machine;
  readonly observing: (b: MachineBackend) => MachineBackend;
  readonly fork: (record: WorkspaceRecord, bind: (machine: Machine) => void, override?: WorkspaceSpec, report?: StageReport, readsMemory?: boolean) => Promise<Machine>;
  readonly unfork: (entry: LiveWorkspace) => Promise<void>;
  readonly followMachine: (entry: LiveWorkspace) => void;
  readonly attach: (record: WorkspaceRecord, machine: Machine) => LiveWorkspace;
  readonly endSessions: (workspaceId: string, reason: string) => void;
  readonly drop: (id: string) => Promise<void>;
  readonly napWith: (id: string, reason?: string) => Promise<WorkspaceView>;
  readonly armLateRead: (entry: LiveWorkspace) => void;
  readonly adoptPause: (entry: LiveWorkspace) => Promise<void>;
  readonly runsUnderNapping: (entry: LiveWorkspace) => Promise<boolean>;
  readonly adoptRunning: (entry: LiveWorkspace) => Promise<void>;
  readonly proven: (entry: LiveWorkspace) => Promise<WorkspaceView>;
  readonly settleGone: (entry: LiveWorkspace, reason: string) => Promise<GoneOutcome>;
  readonly markGone: (entry: LiveWorkspace, machineId: string, reason: string) => Promise<GoneOutcome>;
  readonly rereading: Set<string>;
  readonly adoptGone: (entry: LiveWorkspace, reason: string) => Promise<void>;
  readonly recoverGone: (entry: LiveWorkspace) => Promise<"running" | "napping" | undefined>;
  readonly idle: IdlePolicy;
}

export interface BootArea {
  readonly refreshBuilders: () => Promise<void>;
  readonly isHeldAway: (id: string) => boolean;
  readonly rereadHeld: (id: string, by: GoneSeenBy) => Promise<void>;
  readonly hydrateWorkspace: (raw: unknown, seen?: FoundMachine) => Promise<LiveWorkspace | undefined>;
  readonly ready: () => Promise<void>;
  readonly entryOf: (id: string, origin?: Caller, o?: { now?: true }) => Promise<LiveWorkspace>;
  readonly childOf: (lead: LiveWorkspace, ref: string, origin?: Caller) => Promise<LiveWorkspace>;
  readonly reachesRow: (row: { threadId?: string; workspaceId: string }, caller: Caller | undefined) => boolean;
  readonly entryOfRow: (row: { threadId?: string; workspaceId: string }, origin: Caller | undefined) => Promise<LiveWorkspace | undefined>;
  readonly listedRows: (held: readonly (Map<string, SessionEntry> extends Map<string, infer V> ? V : never)[]) => SessionView[];
  readonly threadFacts: (threadId: string) => ThreadFacts | undefined;
  readonly pushHead: (threadId: string) => void;
  readonly mark: (threadIds: readonly string[], stamps: Partial<Omit<ThreadRecord, "harness" | "permissionMode">>, origin: Caller | undefined) => Promise<void>;
  readonly endSnoozeFor: (row: Pick<SessionView, "threadId" | "rootThreadId">) => void;
  readonly armResume: (threadIds: readonly string[], on: boolean, origin: Caller | undefined) => Promise<void>;
  readonly resumeAfterLimit: (threadId: string) => Promise<void>;
  readonly treeStandsOn: (workspaceId: string, caller: Caller | undefined) => boolean;
  readonly computerRows: () => Promise<{ id: string; name: string }[]>;
  readonly nameOfComputer: (computer: string, rows: readonly { id: string; name: string }[]) => string;
  readonly imageHeadOrNone: () => Promise<string | undefined>;
  readonly imageHead: () => Promise<string>;
  readonly landingPlace: (computer: string) => Promise<{ placeId?: string }>;
}

export interface CreateArea {
  readonly createStaged: (o: CreateWorkspaceOptions, project: ProjectView, id: string, report: StageReport, spawned?: ThreadScope, landed?: () => void, childBase?: string) => Promise<CreatedWorkspace>;
  readonly nameGiven: (name: string) => string;
  readonly forking: Set<string>;
  readonly failedCreates: Map<string, WorkspaceView>;
  readonly createStages: Map<string, WorkspaceCreatingEvent>;
  readonly failedView: (id: string, name: string, kind: WorkspaceKind, golden: string, began: number, project: ProjectView, said: string) => WorkspaceView;
  readonly supersedeFailed: (name: string) => void;
  readonly stageReporter: (id: string, name: string, began: number, spawned: ThreadScope | undefined) => StageReport;
  readonly nameRefusal: (name: string) => string | undefined;
  readonly foldersOf: (projectId: string) => LiveWorkspace[];
  readonly oneFolder: (key: string, make: () => Promise<LiveWorkspace>) => Promise<LiveWorkspace>;
}

export interface FoldersArea {
  readonly projectFolder: (project: ProjectView) => Promise<LiveWorkspace>;
  readonly worktreeFolder: (project: ProjectView, top: string, branch: string, parent?: string, madeFor?: string) => Promise<LiveWorkspace>;
  readonly folderFor: (o: { project?: string; branch?: string; cwd?: string; picks?: StartPicksAsked }, origin: Caller | undefined) => Promise<{ entry: LiveWorkspace; cwd?: string }>;
  readonly queued: <T>(id: string, work: () => Promise<T>) => Promise<T>;
  readonly removeWorktree: (entry: LiveWorkspace, force: boolean, o?: { ending?: boolean }) => Promise<void>;
  readonly refuseChanged: (path: string) => Promise<void>;
  readonly dropCheckpoints: (entry: LiveWorkspace, threadId: string) => Promise<void>;
  readonly holdsThread: (workspaceId: string) => boolean;
  readonly worktreeGone: (entry: LiveWorkspace, why: WorktreeSettled["why"], o?: { starting?: boolean }) => Promise<void>;
  readonly runsIn: (entry: LiveWorkspace, ranIn: string | undefined, folder: string) => string;
  readonly armSweep: () => void;
  readonly moveOldCopies: () => Promise<void>;
  readonly gitSaid: (res: { stdout: string; stderr: string }) => string;
  readonly worktreesOf: (top: string) => Promise<{ path: string; branch?: string }[]>;
}

export interface StartFromArea {
  readonly projectByRepo: (repo: string, named: string | undefined) => ProjectView;
  readonly issueOf: (remote: string, number: number) => Promise<IssueRead>;
  readonly pullRequestOf: (remote: string, number: number) => Promise<PullRequest>;
  readonly fromOf: (kind: WorkspaceFrom["kind"], repo: string, read: IssueRead, fact: PullRequest | undefined) => WorkspaceFrom;
  readonly workspaceFrom: (project: ProjectView, from: WorkspaceFrom, fact: PullRequest | undefined, kind: "start" | "review", origin: Caller | undefined) => Promise<LiveWorkspace>;
  readonly picksHold: (project: ProjectView, o: StartPicksAsked) => Promise<void>;
  readonly openWith: (entry: LiveWorkspace, o: { prompt: string; harness?: string; model?: string; effort?: string; permissionMode?: string; access?: AccessChoice }, origin: Caller | undefined) => Promise<StartResult>;
  readonly readOnlyOf: (agent: string) => string | undefined;
  readonly reviewers: () => string[];
  readonly takeReview: (entry: LiveWorkspace, threadId: string, text: string) => Promise<void>;
}

export interface WorkspacesArea {
  readonly workspaces: Runtime["workspaces"];
}

export interface AgentsArea {
  readonly catalogOn: (table: HarnessCatalog, entry: LiveWorkspace, adapter: HarnessAdapter) => Promise<HarnessCatalog>;
  readonly firstRunHere: (entry: LiveWorkspace, harness: string) => Promise<boolean>;
  readonly refreshTitle: (view: SessionView, force: boolean) => Promise<void>;
  readonly sourceOf: (view: SessionView) => TitleSource;
  readonly rowsOn: (threadId: string) => SessionView[];
  readonly carriedTitle: (threadId: string) => Pick<SessionView, "harnessTitle" | "titleSource">;
  readonly nameInHarness: (view: SessionView, title: string) => Promise<void>;
  readonly makeTitle: (view: SessionView) => Promise<void>;
  readonly agentAsks: Set<Promise<unknown>>;
  readonly holdAsk: <T>(ask: Promise<T>) => Promise<T>;
  readonly titleRows: (rows: readonly SessionView[]) => SessionView[];
  readonly setupPlace: (entry: LiveWorkspace) => string | undefined;
  readonly agentOff: (entry: LiveWorkspace, agent: string) => boolean;
  readonly agentLabel: (agent: string) => string;
  readonly configFolderOn: (placeId: string, path: string) => Promise<ResolvedFolder>;
  readonly setupRefusals: Map<string, string>;
  readonly setupRefusal: (entry: LiveWorkspace, named?: string) => Promise<string | null>;
  readonly homesHere: () => Promise<Record<string, string>>;
  readonly confineSetup: (entry: LiveWorkspace, named?: string) => Promise<void>;
  readonly launchAdapterFor: (entry: LiveWorkspace, named?: string | undefined, turnEnv?: Readonly<Record<string, string>> | undefined, waiting?: TurnWaiting | undefined, servers?: Readonly<Record<string, string>> | undefined) => Promise<ReturnType<(entry: LiveWorkspace, named?: string, turnEnv?: Readonly<Record<string, string>>, waiting?: TurnWaiting, servers?: Readonly<Record<string, string>>) => { harness: string; adapter: HarnessAdapter; }>>;
  readonly defaultAgentOf: (prefs: Preferences, entry: LiveWorkspace | undefined) => string;
  readonly defaultsOn: (catalog: HarnessCatalog, prefs: Preferences, project: ProjectOverrides | undefined) => { catalog: HarnessCatalog; open: { model?: string; effort?: string } };
  readonly namedMode: (catalog: HarnessCatalog | undefined, harness: string, word: AccessChoice) => string;
  readonly landImages: (entry: LiveWorkspace, road: AttachmentRoad | undefined, folder: string, dir: string, images: readonly Attachment[]) => Promise<{ images: TurnImage[]; dir?: string }>;
  readonly landFiles: (entry: LiveWorkspace, folder: string, dir: string, files: readonly Attachment[]) => Promise<string[]>;
  readonly dropThreadFiles: (entry: LiveWorkspace, threadIds: Iterable<string>) => Promise<void>;
  readonly dropImages: (entry: LiveWorkspace, dir: string) => void;
  readonly threadEnv: (entry: LiveWorkspace, harness?: string) => Readonly<Record<string, string>>;
  readonly placeStores: (place: string, home: string) => Readonly<Record<string, string>>;
  readonly serverValuesFor: (entry: LiveWorkspace, harness: string, folder: string) => Promise<HarnessStartOptions["serverValues"]>;
  readonly adapterFor: (entry: LiveWorkspace, named?: string, turnEnv?: Readonly<Record<string, string>>, waiting?: TurnWaiting, servers?: Readonly<Record<string, string>>, thread?: string) => { harness: string; adapter: HarnessAdapter };
}

/** What a message sent without its caller waiting answers: where it went, and the wait where its computer holds it. */
export interface DetachedSend {
  outcome: "steered" | "queued" | "started" | "held";
  threadId: string;
  harness: string;
  capped?: ThreadCapWait;
}

/** A turn its computer's threads at once has not let through yet: the computer, the running turns that wait on it and
 * so lend it a slot, the order it came in, the reason a stop gave it, and once it waits, what its row says and the two
 * ways the wait ends. */
export interface CapHeld {
  placeId: string | undefined;
  lenders: string[];
  order: number;
  stopped?: string;
  stops?: Set<Promise<void>>;
  waiting?: { wait: ThreadCapWait; wake: () => void; stop: (reason: string) => void };
}

export interface ThreadsArea {
  readonly threadRuns: (threadId: string) => boolean;
  readonly launchingOn: (threadId: string) => { turnId: string; launch: Promise<void> } | undefined;
  readonly runningOn: (threadId: string) => LiveSession | undefined;
  readonly latestOn: (threadId: string) => SessionView | undefined;
  readonly keptAgents: Map<string, KeptProcess>;
  readonly reapKept: (threadId: string, o?: { now: true }) => void;
  readonly endKept: (threadId: string, kept: KeptProcess, o?: { now: true }) => void;
  readonly hostWrites: Map<string, Promise<void>>;
  readonly writeSession: (harnessSessionId: string, write: () => Promise<SessionRenameWrite>) => Promise<SessionRenameWrite>;
  readonly takeKept: (threadId: string, launch: KeptLaunch | undefined, session: string | undefined) => KeptProcess | undefined;
  readonly holdKept: (threadId: string, o: Omit<KeptProcess, "file" | "usedAt" | "cancel">) => boolean;
  readonly threadOfToken: (token: string) => string;
  readonly treeUnder: (threadId: string) => string[];
  readonly drivesThread: (threadId: string | undefined, caller: Caller | undefined) => boolean;
  readonly leadAsks: Map<string, PermissionAsk>;
  readonly capHeld: Map<string, CapHeld>;
  readonly capHold: (record: WorkspaceRecord, turnId: string, lender: string | undefined) => void;
  readonly capLend: (turnId: string, lender: string) => void;
  readonly capFull: (record: WorkspaceRecord, turnId: string) => ThreadCapWait | undefined;
  readonly capWait: (at: { workspaceId: string; threadId: string; turnId: string; sessionId: string; requestId?: string }, wait: ThreadCapWait) => Promise<void>;
  readonly capStop: (turnId: string, reason: string) => boolean;
  readonly capStopping: (turnId: string) => () => void;
  readonly capLeft: (turnId: string) => void;
  readonly stoppedBehind: (s: { view: SessionView; calls?: Map<string, { toolName: string; input: string }> }) => ThreadWaitingOn | undefined;
  readonly stopUnder: (threadId: string, caller: Caller | undefined) => Promise<string[]>;
  readonly notifyOn: (threadId: string) => { notify: readonly string[]; by?: ThreadScope; road?: WorkspaceOrigin } | undefined;
  readonly notifyReach: (from: readonly string[]) => Set<string>;
  readonly tellAs: (s: { notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin }) => { by?: ThreadScope; road?: WorkspaceOrigin };
  readonly notifyEnd: (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, notify: readonly string[], named: { by?: ThreadScope; road?: WorkspaceOrigin }, result: TurnResult) => void;
  readonly deliverOwed: () => Promise<void>;
  readonly sendBack: (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, ids: readonly string[], stopped: boolean) => void;
  readonly settleCut: (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; snapshot?: string }, reason: string, cutLine: (endedAt: number) => string) => void;
  readonly notARepo: (r: WorkspaceRecord) => boolean;
  readonly checkpointsLanding: Map<string, Promise<void>>;
  readonly keepCheckpoint: (entry: LiveWorkspace, turn: { sessionId: string; threadId: string; turnId: string; anchor?: string; kept?: string }) => Promise<void>;
  readonly takenTurn: (workspaceId: string, taken: Taken) => Promise<SessionHandle | undefined>;
  readonly recordSteer: (s: { view: SessionView; turnId: string; turnLive?: TurnLive }, handleId: string, o: { prompt: string; requestId?: string; via?: "slate"; startedBy?: SessionOrigin }, caller: Caller | undefined, steerId: string) => void;
  readonly snapshotOf: (entry: LiveWorkspace, cwd: string) => Promise<string | undefined>;
  readonly readTurnChanges: (entry: LiveWorkspace, turn: { sessionId: string; turnId: string; threadId: string; cwd: string; from: string; startedAt: number; wrote?: ReadonlySet<string> }) => Promise<boolean>;
  readonly usageComputerOf: (r: WorkspaceRecord) => string;
  readonly vaultedFor: (agent: string, loginStands?: boolean) => Vaulted;
  readonly usageAccountOf: (entry: LiveWorkspace, harness: string, named?: { id: string; label?: string; }) => { key: string; label: string; road: AccountRoad; };
  readonly limitDetailsDue: (entry: LiveWorkspace, harness: string) => Promise<boolean>;
}

export interface TurnsArea {
  readonly runTurn: (t: {
    entry: LiveWorkspace;
    view: SessionView;
    /** How much of itself a turn re-opened after a restart has written. A new turn has written nothing. */
    written?: TurnWritten;
    /** The thread this turn runs on, which every row the runtime writes carries. */
    threadId: string;
    turnId: string;
    notify?: readonly string[];
    /** The thread that named those targets, where a thread named them: the line their end delivers starts the
     * target's turn under it, so the rules that let it name them are read again when the line goes. */
    notifyBy?: ThreadScope;
    /** And the road they were named from, read at delivery beside the thread, so a caller that may start no
     * process on the target's workspace gets none started for it a turn later. */
    notifyRoad?: WorkspaceOrigin;
    /** The token this turn was launched with, kept on its row while the turn runs so a request out of it can name
     * this thread. */
    turnToken?: string;
    /** The device this turn's launch environment carries into the machine, taken away at the exit beside the turn
     * token: the two are one turn's identity and they end together. */
    scopeDeviceId?: string;
    outcome: Exclude<SessionStartOutcome, "held">;
    /** What this turn's own session.start row carries, for the road that still has to write it. */
    opening: { prompt: string; requestId?: string; via?: "slate"; afterCut?: boolean; afterLimit?: number; opensThread?: boolean; title?: string; attachments?: readonly AttachmentRecord[] };
    /** The message the agent is handed and the effort it runs at, kept beside the run while the turn runs. */
    asked?: TurnAsked;
    /** The harness session this turn resumes, so the row it takes over keeps who opened the thread and with what. */
    resume?: string;
    /** The rewind's anchor this turn was launched to cut at; the thread lets it go once the turn announces itself. */
    cutAt?: string;
    /** What the row already knows of this turn's reply: a re-opened turn whose result landed before the restart is
     * still working, and reads as such until the run's own result line comes round again. */
    turnLive?: TurnLive;
    /** The folder this turn's images landed in on the machine, removed when the turn ends however it ends; absent on
     * a turn that landed none, whose harness read them inline or which carried none at all. */
    imagesDir?: string;
    /** The snapshot of the turn's folder taken as it launched, which the range of what it changed starts from: the
     * commit itself where it is known as the turn is handed over, a launch's already in or a re-opened turn's off
     * its row. */
    snapshot?: { from: Promise<string | undefined> | string; cwd: string };
    /** Whether the harness names every file its tool calls write (HarnessAdapter.reportsEdits). */
    reportsEdits?: boolean;
    /** The box the turn's own exec stream reads to know it is waiting on something outside its own process: flipped
     * while a permission prompt of this turn stands open, and while its harness reports a command or a subagent it
     * started still running, so the turn's idle clock does not run out under a question nobody has answered yet nor
     * under a quiet watch on work the turn started. Absent on a road that hands the adapter no stream of its own. */
    waiting?: { on: boolean };
    /** What the turn's process was launched with, where it may be kept for the thread's next turn once this one is over. */
    keep?: { launch: KeptLaunch };
    open: (onEvent: (event: AdapterEvent) => void) => HarnessSession;
  }) => SessionHandle;
  readonly sweepRuns: (entry: LiveWorkspace) => Promise<void>;
  readonly reattach: (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; from?: number; asked?: TurnAsked; turnToken?: string; scopeDeviceId?: string; snapshot?: string }) => Promise<Reopened>;
}

export interface SessionsArea {
  readonly sessionsApi: Runtime["sessions"];
}

export interface BuildersArea {
  readonly builderView: (r: BuilderRecord, b: LiveBuilder) => GoldenBuilderView;
  readonly graceTimers: Map<string, () => void>;
  readonly armGrace: (id: string, sealedAt: string) => void;
  readonly inWindow: (sealedAt: string) => boolean;
  readonly expireGrace: () => Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }>;
  readonly hold: (b: LiveBuilder) => Promise<void>;
  readonly refuseUntouchable: (entry: LiveBuilder) => void;
  readonly forgetBuilder: (id: string) => Promise<void>;
  readonly forgetIfGone: (entry: LiveBuilder, at: MachineBackend) => Promise<void>;
  readonly stageOf: (name: string, on?: string, named?: boolean) => (stage: GoldenStage, detail?: string, step?: GoldenStep, left?: readonly string[]) => void;
  readonly backendAt: (place: string) => MachineBackend;
  readonly placeAt: (word: string) => Promise<{ place: string; at: MachineBackend }>;
  readonly landingBackend: (placeId: string | undefined) => Promise<MachineBackend>;
  readonly forkingAt: (placeId: string | undefined) => Promise<MachineBackend | undefined>;
  readonly placeName: (place: string) => string;
  readonly imagePlace: (name: string) => Promise<string>;
  readonly buildPlaces: () => Promise<{ place: string; name: string; backend: MachineBackend }[]>;
  readonly copyRecipeOrThrow: () => ((image: SealedImage) => Promise<GoldenRecipe> | GoldenRecipe);
  readonly recipeOrThrow: (named?: GoldenRecipe) => GoldenRecipe;
  readonly builderLabels: (extra: Record<string, string> | undefined) => Record<string, string>;
  readonly recordingCreates: (b: MachineBackend, name: string, imp: Pick<GoldenImport, "recipeHash" | "recipe"> | undefined, made: (placeholder: LiveBuilder) => void, stop: { signal: AbortSignal | undefined; began: (creating: Promise<Machine>) => void } | undefined, place: string) => MachineBackend;
  readonly settleBuilder: (name: string, builder: Builder, placeholder: LiveBuilder | undefined, place: string) => Promise<LiveBuilder>;
  readonly sealEntry: (entry: LiveBuilder, keep: boolean, logins?: GoldenLogin[], copy?: SealedImage) => Promise<SealResult>;
  readonly dropImage: (v: GoldenVersion, at?: MachineBackend) => Promise<void>;
}

export interface GoldenArea {
  readonly golden: Runtime["golden"];
}

export interface ImageArea {
  readonly conflict: (message: string) => Error;
  readonly image: Runtime["image"];
  readonly copyForFork: (golden: string, placeId: string | undefined, announce?: (where: string, rateUsdPerHour: number) => void) => Promise<string>;
}

export interface ProjectsArea {
  readonly copyImport: (entry: LiveWorkspace, o: ProjectImportOptions, report: ImportReport) => Promise<ImportLanded>;
  readonly landingKind: (computer: string, at: MachineBackend | undefined) => ProjectLanding["kind"];
  readonly landingDeps: (computer: string) => Promise<{ deps: LandingDeps; at: MachineBackend | undefined; placeId: string | undefined }>;
  readonly projectsDoor: { seedPlan(source: string): Promise<SeedPlan>; add(o: { source: string; on?: string; name?: string; base?: string; into?: string; seed?: SeedChoice; id?: string; createdAt?: string; report?: (line: string) => void; }, origin?: Caller): Promise<ProjectView & { notice?: string; }>; list(origin?: Caller): Promise<ProjectView[]>; computers(): Promise<{ id: string; name: string; }[]>; resolve(ref: string, origin?: Caller): Promise<ProjectView>; folderStands(id: string): Promise<boolean>; seedInto(id: string, plan: SeedPlan, files: readonly string[]): Promise<void>; remove(id: string, origin?: Caller): Promise<{ said: string; }>; };
  readonly projects: Runtime["projects"];
}

export interface UsageArea {
  readonly awayLine: (record: WorkspaceRecord) => string | undefined;
  readonly rowReason: (e: LiveWorkspace) => string | undefined;
  readonly ledger: UsageLedger;
  readonly alerts: PlanAlerts;
  readonly burn: { add(o: { account: string; threadId: string; tokens: number; replayed?: ReplayedStamp; }): void; of(account: string): AccountRow["burn"]; };
  readonly usageAccounts: () => Promise<AccountsAnswer>;
  readonly usage: UsageDoor;
}

export interface StatusArea {
  readonly status: StatusApi;
  readonly adoptLost: (listing: ListedMachine[], known: Set<string>, failed: ReapFailure[]) => Promise<AdoptedMachine[]>;
}

export interface PreferencesArea {
  readonly preferences: Runtime["preferences"];
  readonly agentsRead: ReturnType<typeof agentsReads<Caller>>;
}

/** Every area's members on one object, filled in createRuntime in file order: a member is read at the moment it is
 * called, never copied into a local while the areas are still being built. */
export type RuntimeContext = RuntimeCore & KindsArea & RulesArea & TranscriptsArea & SlatesArea & ChannelsArea & RecordsArea & ReachArea & PullRequestsArea & DaemonArea & MachinesArea & BootArea & CreateArea & FoldersArea & StartFromArea & WorkspacesArea & AgentsArea & ThreadsArea & TurnsArea & SessionsArea & BuildersArea & GoldenArea & ImageArea & ProjectsArea & UsageArea & StatusArea & PreferencesArea;
