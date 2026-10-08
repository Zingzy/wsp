// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenDelta, ExecResult, GoldenManifest, GoldenVersion, MachineBackend, MachineKind, RetentionPlan, SnapshotRow, TemplateRow } from "@wsp/engine";
import type { ThreadCapWait, AgentsReport, AgentsSignInEvent, AgentsSignInRun, AgentsTarget, ServerAdd, ServerAsk, ServerToolsAnswer, SignInLine, SkillAdded, SkillHit, SkillPreview } from "@wsp/protocol";
import type {
  Capabilities,
  DaemonReachView,
  GoldenBuilderView,
  GoldenLogin,
  HarnessCatalog,
  Preferences,
  PreferencesPatch,
  RecipeDigest,
  SealedImage,
  SealedImageBuilt,
  SealedImageView,
  PortProbeView,
  PortReachView,
  ProjectExportResult,
  ProjectGolden,
  ProjectGoldenRemoved,
  ProjectImportResult,
  ProjectView,
  SeedChoice,
  SeedPlan,
  SessionEvent,
  SessionAccessResult,
  SessionAnswerResult,
  SessionInterruptResult,
  SessionRenameResult,
  SessionSteerResult,
  SessionOrigin,
  SessionAsideResult,
  SessionRewindResult,
  SessionSearchResult,
  SessionView,
  ThreadMarks,
  SnapshotStorage,
  Attachment,
  McpServerSpec,
  SysSample,
  UpgradeResult,
  Caller,
  WorkspaceAgents,
  WorkspaceLook,
  WorkspaceView,
  WorkspaceCreatingEvent,
} from "@wsp/protocol";
import type { BringBackResult, GitCommitReply, GitDiscardReply, GitUpdateReply, MergeInResult, PullRequestPage, GitPrReplyReply, GitPrResolveReply, GitPrReactReply, ReactionContent, PullRequestItem, PullRequestSendResult, FixResult, MergeMethod, MergeResult, CheckoutReply, CommitDraft, ViewedMarks, RunStep, SessionRunEvent } from "@wsp/protocol";
import type { WorktreeMade, KeptAttachment, WorkspaceKind } from "@wsp/protocol";
import type { CallbackForwards, SignInAsk, SkillAsk } from "../agents-read.js";
import type { DaemonChannel } from "../daemon-channel.js";
import type { AccessChoice, AgentRow, AgentSetupSet, ThreadDefaults } from "@wsp/protocol";
import type { DeviceDoor } from "../devices.js";
import type { PlaceDoor } from "../places.js";
import type { Slates } from "../slates.js";
import type { GitPrDiffReply, ReviewDraft, ReviewPostResult, ReviewVerdict, StartResult } from "@wsp/protocol";
import type { HistoryPage, ThreadHead } from "@wsp/protocol";
import type { StartPicksAsked } from "./harness.js";
import type { EventBus } from "./events.js";
import type { CreatedWorkspace, CreateWorkspaceOptions, RecipeShelf, ProjectExportOptions, ProjectImportOptions, SessionHandle, GoldenRecipe, RunningExec, GoldenBuildRequest, GoldenPromotion, GoldenUpgradeResult, SweepResult, OriginStatusApi, UsageDoor } from "./wiring.js";

export interface Runtime {
  readonly events: EventBus;
  readonly backend: MachineBackend;
  /** The places this host holds, when one wired them: the handshake a joining computer takes, the links it keeps
   * and what a remove sweeps. Absent on a runtime wired without them. */
  readonly places?: PlaceDoor;
  /** The recipes the host wired, which the ops serve and the computers that follow one sync to. */
  readonly recipes?: RecipeShelf;
  /** One channel to the daemon of the computer this host runs on, the one its local workspace dials, for a terminal
   * that belongs to this computer rather than to a workspace on it. */
  hereChannel(onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel>;
  /** The agents, skills and MCP servers on one computer or workspace, read as that computer's login. A napping
   * workspace answers the last report read while it ran and is never woken for this. */
  readonly agents: {
    read(target: AgentsTarget, origin?: Caller): Promise<AgentsReport>;
    /** One MCP server there, started or asked once for its tools on the person's ask; a napping workspace is refused. */
    tools(target: AgentsTarget, ask: { agent: string; name: string; refresh?: boolean }, origin?: Caller): Promise<ServerToolsAnswer>;
    /** Runs an agent's sign-in, or one server's, in a watched pty there, or joins the one already running for that
     * agent or server there; each step goes to `emit` and to nobody outside the sign-in, and `leave` stops following
     * it, which never ends it: it runs until it lands, fails, passes its cap or is stopped. A napping workspace is
     * refused. */
    signIn(target: AgentsTarget, ask: SignInAsk, emit: (event: AgentsSignInEvent) => void, origin?: Caller): Promise<{ signInId: string; leave(): void }>;
    /** Every sign-in running and every one that ended in the last ten minutes, each with its last step. */
    signIns(): AgentsSignInRun[];
    /** Follows a running sign-in by its id, as signIn joins one: its last step goes to `emit` at once. */
    signInFollow(signInId: string, emit: (event: AgentsSignInEvent) => void): { signInId: string; leave(): void };
    /** Types what a page handed back into that sign-in's pty. */
    signInCode(signInId: string, code: string): Promise<void>;
    /** Ends that sign-in and kills its pty, for everyone following it. */
    signInStop(signInId: string): void;
    /** The sign-in as the line the person's own terminal runs there. */
    signInLine(target: AgentsTarget, ask: SignInAsk, origin?: Caller): Promise<SignInLine>;
    /** Writes an agent's token or key into this host's vault. */
    key(agent: string, key: string): Promise<void>;
    /** Writes the wsp server into that agent's own config on this computer. */
    addTools(target: AgentsTarget, agent: string, origin?: Caller): Promise<{ file: string }>;
    /** Hands every sign-in from here on the host relay's callback forward to its target; the return takes it back. */
    forwards(relay: CallbackForwards): () => void;
    /** skills.sh searched by this host, the only caller of it. */
    skillsSearch(q: string, limit?: number): Promise<SkillHit[]>;
    /** A skill's SKILL.md off skills.sh, nothing installed. */
    skillsGet(skill: string): Promise<SkillPreview>;
    /** One skill's SKILL.md there, its first part and its size. */
    skillsPreview(target: AgentsTarget, ask: SkillAsk, origin?: Caller): Promise<SkillPreview>;
    /** A skill off skills.sh put there, checked whole before it lands and run never. */
    skillsAdd(target: AgentsTarget, ask: { skill: string; agents?: readonly string[]; project?: boolean }, origin?: Caller): Promise<SkillAdded>;
    /** Every folder of a skill there and every link to it, gone. */
    skillsRemove(target: AgentsTarget, ask: SkillAsk, origin?: Caller): Promise<{ removed: string[] }>;
    /** A skill turned off or on there, by the rename of its SKILL.md. */
    skillsToggle(target: AgentsTarget, ask: SkillAsk & { on: boolean }, origin?: Caller): Promise<{ paths: string[] }>;
    /** One MCP server written into an agent's config there: its values into that file on this computer, and on any
     * other the file names a variable for each and the value goes to the vault. */
    serversAdd(target: AgentsTarget, ask: ServerAdd, origin?: Caller): Promise<{ file: string }>;
    /** One server's entry taken out of an agent's config there, every other line as it was. */
    serversRemove(target: AgentsTarget, ask: ServerAsk, origin?: Caller): Promise<{ file: string }>;
    /** One server turned off or on there by the switch its agent reads. */
    serversToggle(target: AgentsTarget, ask: ServerAsk & { on: boolean }, origin?: Caller): Promise<{ file: string }>;
    /** A remote server's icon as a data url, asked of Google by this host only while the person's switch is on. */
    serversIcon(host: string, refresh?: boolean): Promise<string | null>;
    /** Changes how one agent runs on one computer, checked first, and answers its row there, names only. */
    setup(placeId: string, agent: string, change: AgentSetupSet, origin?: Caller): Promise<AgentRow>;
    /** Every catalog agent's config folder on this computer by id, where a launch here finds it: the one the person
     * kept, refused in a launch's words once it leads out of the home, else the agent's own. */
    homesHere(): Promise<Record<string, string>>;
  };
  /** Every verb takes where the request reached the host from as its last argument: here, this computer's own app,
   * CLI or MCP, or relayed from a machine. Absent reads here. A workspace whose kind takes no relayed request
   * refuses one with the one sentence, and the lists that serve workspaces leave it out for that caller. */
  readonly workspaces: {
    create(opts: CreateWorkspaceOptions, origin?: Caller): Promise<CreatedWorkspace>;
    /** Where a workspace of this project would land and what that computer offers, gated as a create is; `place` is
     * absent where the landing is this computer or the provider this host forks on. Read ahead of a create so the
     * refusal for a computer that forks nothing comes in one sentence before any stage is streamed. */
    landing(o: { project: string }, origin?: Caller): Promise<{ place?: string; name: string; capabilities: Capabilities; kind?: WorkspaceKind }>;
    get(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Every workspace this host holds, less the ones the caller's origin may not drive. */
    list(origin?: Caller): Promise<WorkspaceView[]>;
    /** The workspace a name or an id names, off the reading list() serves: every verb that takes a workspace from a
     * person or an agent comes through here, so what the listing shows and what a verb accepts are one thing. A name
     * nothing here carries is refused as absent, and one the caller may not drive with the sentence of the rule that
     * hides it rather than as missing. */
    resolve(ref: string, origin?: Caller, verb?: "exec"): Promise<WorkspaceView>;
    nap(id: string, origin?: Caller): Promise<WorkspaceView>;
    wake(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Stops a wake that is asking the provider again on its own, and answers with the record it leaves behind. The
     * wake itself ends with WAKE_STOPPED; a workspace with no wake in flight is answered with as it stands. */
    stopWake(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Replaces the workspace's machine with a fresh fork of the image behind it, its vaulted files carried over. */
    upgrade(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Moves the workspace onto its golden's head version, carrying its files across. Refused in one sentence when
     * the machine is not running, the image is a project golden, or no golden knows the image; a workspace past
     * those and already on the head is returned untouched. */
    updateImage(id: string, origin?: Caller): Promise<UpgradeResult>;
    /** Fresh golden fork with the nap-time vault, old machine killed, id and name kept: the way out of a zombie. */
    rebuild(id: string, origin?: Caller): Promise<WorkspaceView>;
    /** Starts another daemon for a workspace whose daemon this host holds the process of, in place of one that is
     * not running. Refused in one sentence for every kind whose daemon lives on a machine instead. */
    restartDaemon(id: string, origin?: Caller): Promise<void>;
    /** Names the workspace, under the rules a fork's name takes: the space around the name is dropped, and a name
     * another workspace holds, one a fork is landing under and a blank one are refused (kind conflict) naming the
     * holder. A name the workspace already carries answers with the record untouched. The record alone changes, so
     * this goes out as workspace.renamed and never as workspace.created, which the awake meter and the auto-nap
     * window read as the machine coming up. Threads on the machine are addressed by id and run on through it. The
     * machine's own metadata keeps the name it was forked under, since the provider takes metadata at create and
     * its API offers no update; the next fork or rebuild stamps the new one, and the name is kept here beside the
     * records so a sweep that records this machine after the store lost its workspace document restores it under
     * the name a person gave rather than the fork's. */
    rename(id: string, name: string, origin?: Caller): Promise<WorkspaceView>;
    /** The theme and the glyph a person gave this workspace. A key left out keeps that fact as it is and null
     * clears it, so the colour picker and the icon picker each send their own without reading the other's. The record
     * alone changes and the machine is untouched, so this goes out as workspace.look. */
    look(id: string, look: WorkspaceLook, origin?: Caller): Promise<WorkspaceView>;
    /** Snapshots the running machine as a project golden: the golden it stands on plus the project as it is now, so a
     * fork of the snapshot starts a task with the project in place. Refused in one sentence when the workspace is not
     * running or holds no project; a machine that was ever resumed is refused by the engine (kind notFirstLife). The
     * guest freezes for about three seconds and stays first-life. */
    snapshot(id: string, origin?: Caller): Promise<ProjectGolden>;
    /** The recipe's daemon deploy on the running machine, replacing the daemon there, then this runtime's token
     * written again so the next reach opens it. The runtime runs it by itself when a machine's daemon is older than
     * this wsp. Throws on a workspace that is not running or a runtime without the deploy. */
    updateDaemon(id: string, origin?: Caller): Promise<void>;
    /** Turns the workspace's agents switch on or off and names its caps; a key left out keeps what the record holds.
     * Never a thread's own act: what agents may do is the person's to decide. */
    agents(id: string, patch: Partial<WorkspaceAgents>, origin?: Caller): Promise<WorkspaceView>;
    delete(id: string, origin?: Caller): Promise<void>;
    /** Drops a workspace whose machine the provider no longer has: its record, transcripts and sessions go and nothing
     * is asked of the provider. Refused with the reason (kind conflict) while the machine still exists. */
    forget(id: string, origin?: Caller): Promise<void>;
    /** A person acted in the workspace; its idle window starts over. */
    touch(id: string, origin?: Caller): Promise<void>;
    /** One-shot command on the workspace's machine (plumbing for clients; sessions are the main road). */
    exec(id: string, cmd: string, opts?: { timeoutMs?: number }, origin?: Caller): Promise<ExecResult>;
    /** The command, word by word, launched the way a harness turn is: detached on the machine, each word quoted for
     * its shell, exported with what the default harness's turns get, its output streamed by line, its exit code at
     * the end; in cwd when given, else the folder the workspace's kind names, as a harness turn does. The stream
     * carries that folder back as `ranIn`, so a client says where the command ran rather than restating the rule.
     * Rejects when the workspace or that harness's adapter is unknown; a launch that fails ends the stream. */
    execStream(id: string, argv: ReadonlyArray<string>, cwd?: string, origin?: Caller): Promise<RunningExec>;
    /** Pushes the branch this workspace's copy is on and opens or finds its pull request against the base. The
     * base is the branch its parent was on at the fork for a child, read off the child's own record and never off
     * the parent again, and the project's own base otherwise; the base branch itself is refused: work leaves a
     * workspace as a branch of its own. A machine with no signed-in command line for the git host still pushes,
     * and says why the pull request waits as the result's note. */
    bringBack(o: { workspaceId: string; title?: string; body?: string }, origin?: Caller): Promise<BringBackResult>;
    /** The record of the folder a thread on this computer runs in, made at its first thread: the project folder, the
     * caller's own folder when a thread asks naming nothing, the worktree holding a branch, or the folder a cwd
     * names inside the project or a worktree of its repo. cwd is the folder the start runs in where it named one.
     * picks, where given, are read against the agent's lists on this computer before any folder is made or found. */
    folderFor(o: { project?: string; branch?: string; cwd?: string; picks?: StartPicksAsked }, origin?: Caller): Promise<{ workspace: WorkspaceView; cwd?: string }>;
    /** The record of a project's folder on this computer, made where no thread has made it yet: what the folder's
     * own acts name before its first thread. */
    folder(o: { project: string }, origin?: Caller): Promise<WorkspaceView>;
    /** The worktree holding a branch of a project's repo on this computer, made under the host's folder where none
     * holds it. */
    worktree(o: { project: string; branch: string }, origin?: Caller): Promise<WorktreeMade>;
    /** Takes a worktree wsp made away with git: refused while a turn runs in it, and without force while it holds
     * files no commit has. Its threads go on in the project folder. With check, refuses as it would and takes nothing. */
    worktreeRemove(o: { project: string; branch: string; force?: boolean; check?: boolean }, origin?: Caller): Promise<void>;
    /** The copy's checkout as the host holds it, read again through the copy's daemon unless it was read within
     * CHECKOUT_TTL_MS; a machine that is not running and whose computer does not answer for it keeps its last fact. */
    checkout(id: string, origin?: Caller): Promise<CheckoutReply>;
    /** Puts one changed file of the copy back as HEAD has it, then reads the checkout again. With check, refuses a file
     * with no change as the discard would and puts nothing back. */
    discard(o: { workspaceId: string; path: string; check?: boolean }, origin?: Caller): Promise<GitDiscardReply>;
    /** Commits the files named in the copy with the message given, then reads the checkout again; no paths is every
     * changed file. A thread commits under the same guard a bring back passes. */
    commit(o: { workspaceId: string; message: string; paths?: string[] }, origin?: Caller): Promise<GitCommitReply>;
    /** A commit message for the files named, or every changed file, from their diff against HEAD and the task the
     * workspace's newest thread was opened with, drafted by that thread's agent with no thread and no tool; none with
     * the line saying why. */
    commitDraft(o: { workspaceId: string; paths?: string[] }, origin?: Caller): Promise<CommitDraft>;
    /** The workspace's viewed marks; with a path, the mark on that file set against the blob or taken off at null. */
    viewed(o: { workspaceId: string; path?: string; blob?: string | null }, origin?: Caller): Promise<ViewedMarks>;
    /** The workspace's pull request page, read through the git host's command line on this computer, or the running
     * copy's where this computer has none; held PR_PAGE_HOLD_MS unless asked fresh. */
    pullRequestView(o: { workspaceId: string; fresh?: boolean }, origin?: Caller): Promise<PullRequestPage>;
    /** The workspace's pull request's diff against its base, read as the page is and cut at GIT_DIFF_CAP_BYTES. */
    pullRequestDiff(o: { workspaceId: string }, origin?: Caller): Promise<GitPrDiffReply>;
    /** Sends items of the page to the workspace's agent as one message, read off the page anew, into the thread a fix
     * goes to; keeps each item sent with when. Answers once the message is on its way. */
    pullRequestSend(o: { workspaceId: string; items: readonly PullRequestItem[] }, origin?: Caller): Promise<PullRequestSendResult>;
    /** Posts a reply as the person through this computer's signed-in command line alone: under the comment on a line
     * replyTo names, in the thread threadId names, or a new comment in the conversation. */
    pullRequestReply(o: { workspaceId: string; replyTo?: number; threadId?: string; body: string }, origin?: Caller): Promise<GitPrReplyReply>;
    /** Resolves or unresolves a review thread by its node id as the person. */
    pullRequestResolve(o: { workspaceId: string; threadId: string; resolved: boolean }, origin?: Caller): Promise<GitPrResolveReply>;
    /** Adds a reaction to the item a node id names, or takes it off, as the person. */
    pullRequestReact(o: { workspaceId: string; subject: string; content: ReactionContent; on: boolean }, origin?: Caller): Promise<GitPrReactReply>;
    /** Asks the workspace's agent to fix a failed check, named, with the failed steps of its log; with none, updates the
     * copy from its base and asks it to fix the conflicts where the merge had any, sending nothing when it merged
     * clean. Answers once the message is on its way, the turn going on without the caller. */
    fix(o: { workspaceId: string; check?: string; child?: string }, origin?: Caller): Promise<FixResult>;
    /** Merges the workspace's pull request by the method named, or the repository's default, only while its head is
     * the commit named, which is the one the window drew, else the one the host holds; or arms it to merge once its
     * checks pass; then reads it again. A person's act: a thread's own token is refused. */
    merge(o: { workspaceId: string; method?: MergeMethod; whenChecksPass?: boolean; head?: string }, origin?: Caller): Promise<MergeResult>;
    /** Merges the base's latest commits into the copy's branch, or answers the files that conflict with the copy left
     * as it was; then reads the branch line and the pull request again. */
    update(o: { workspaceId: string }, origin?: Caller): Promise<GitUpdateReply>;
    /** Merges a child's branch into the lead's copy with a merge commit through the lead's own daemon, from the remote,
     * or from the child's folder where the project has none and both copies sit on this computer; keeps what it came
     * to on the child's record, then reads the lead's branch line and its tree again. Refused for a workspace that is
     * not the lead's child, while a turn runs on the lead, and for a thread merging into any workspace but its own. */
    mergeIn(o: { workspaceId: string; child: string }, origin?: Caller): Promise<MergeInResult>;
    /** A workspace started off a GitHub issue or pull request link: the project whose remote names the link's
     * repository, the text read on this computer, the copy made and, for a pull request, put on its head branch, and
     * a thread opened with the composed task. A person's act: a thread's own token is refused. */
    start(o: { url: string; project?: string; agent?: string; model?: string; effort?: string; access?: AccessChoice }, origin?: Caller): Promise<StartResult>;
    /** A reviewer thread on a pull request, off its link or a workspace's own pull request: a fresh copy at its head,
     * the agent at its harness's read-only word, Codex where none is named, the diff in its task. A person's act. */
    review(o: { url?: string; workspaceId?: string; agent?: string; model?: string; effort?: string }, origin?: Caller): Promise<StartResult>;
    /** A review workspace's draft, edited first where asked: its summary, its verdict and which comments stay ticked. */
    reviewDraft(o: { workspaceId: string; summary?: string; verdict?: ReviewVerdict; on?: readonly { id: string; on: boolean }[] }, origin?: Caller): Promise<{ review?: ReviewDraft }>;
    /** Posts the draft on its pull request in one call as the person, the ticked comments alone, pinned to the head the
     * review was written against. A person's act. */
    reviewPost(o: { workspaceId: string }, origin?: Caller): Promise<ReviewPostResult>;
    /** How a browser dials this workspace's daemon; throws on backends without preview URLs. */
    daemonReach(id: string, origin?: Caller): Promise<DaemonReachView>;
    /** One channel to the daemon answering for this workspace, frame by frame, with every event that daemon
     * pushes for it: the dial of its own daemon where it runs one, and the link of the computer holding it where
     * that computer answers for it. The one reading of how a workspace's daemon is reached, so the pane's road
     * and the runtime's own cannot disagree about which road a workspace is on. */
    daemonChannel(id: string, onEvent: (event: Record<string, unknown>) => void, origin?: Caller): Promise<DaemonChannel>;
    /** The same channel for the host's own guest road, which also answers the guest sessions that daemon relays. A
     * client of this host is never handed one. */
    guestChannel(id: string, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel>;
    /** Whether the computer holding this workspace answers its daemon frames, which is what a road that would
     * otherwise dial reads first: a workspace on a computer somebody owns runs no daemon of its own. */
    servedByItsComputer(id: string, origin?: Caller): Promise<boolean>;
    /** This workspace's own utilisation, pushed to the listener every poll tick until the returned detach runs.
     * Refused for a kind whose Live rows are read off its machine's daemon, which a pane asks over its own link:
     * the kind table says which is which, so neither side decides it for itself. */
    watchSys(id: string, fn: (s: SysSample) => void, origin?: Caller): Promise<() => void>;
    /** The public route to one guest port, for a browser to frame; same caching and refusal as daemonReach. */
    portReach(id: string, port: number, origin?: Caller): Promise<PortReachView>;
    /** One fetch of that route from here, as the frame would see it, redirects unfollowed; rejects when nothing answers at
     * all. A 401 is the edge refusing the token, so the port's route is reminted before the reply and the next portReach
     * carries the fresh one. */
    portProbe(id: string, port: number, origin?: Caller): Promise<PortProbeView>;
    /** The same rule every verb above reads, as a sentence, for the rows and the roads the runtime does not own
     * itself: the host's port forwards, which it lists and stops by the id of their target. Answers the sentence to
     * refuse this request with, or nothing when it may drive that workspace; a target no record here names, as a
     * builder whose ports the host forwards is, is nobody's to hide or refuse for. */
    originRefusal(id: string, origin?: Caller): Promise<string | undefined>;
    /** Whether one event off the bus is this caller's to see: the same rule read without asking anything, for the
     * one road that cannot await, where a per event promise would sit in the path every delta of every turn takes.
     * A workspace this host does not hold is nobody's to refuse for, as the sentence has it, unless the caller is a
     * thread: a thread sees its own tree, and an id no record answers for is not in it, which is what a fork still
     * landing under somebody else is. An event naming the thread it was asked for by is that thread's and its
     * tree's whatever the records say, which is what a fork's own stages are before its record exists. */
    seenBy(event: unknown, origin?: Caller): boolean;
    /** The last stage of every create this host is making and of every refused one it still holds, oldest first:
     * a window that connects after a create began hears nothing else of it. */
    creating(): WorkspaceCreatingEvent[];
  };
  readonly projects: {
    /** Records a project: the word a person typed, which is a folder on this computer, a repo cloned into an empty
     * folder here, or a repo a computer clones, and the computer it lives on. Refused when the word is neither, when the computer's kind takes no source of
     * that shape, and when that source is already a project on that computer. */
    add(opts: { source: string; on?: string; name?: string; base?: string; into?: string; seed?: SeedChoice }, origin?: Caller): Promise<ProjectView & { notice?: string }>;
    /** What a seed of a folder on this computer would carry, with the ticks a remembered choice for that folder
     * leaves on it. Nothing of the folder is read whole and nothing leaves this computer. */
    seedPlan(source: string): Promise<SeedPlan>;
    /** Every project this host holds, oldest first. */
    list(origin?: Caller): Promise<ProjectView[]>;
    /** What a new thread on each of those projects starts on, by project id, off the runtime's table. */
    defaults(origin?: Caller): Promise<Record<string, ThreadDefaults>>;
    /** The computers a project can live on, by the id and the name each carries in the places table: what `add`
     * resolves `on` against, read here so a caller names one rather than guessing at the refusal. */
    computers(): Promise<{ id: string; name: string }[]>;
    /** The project a word names, by id or by name; refused naming the ones there are. */
    resolve(ref: string, origin?: Caller): Promise<ProjectView>;
    /** Drops a project's record and whatever the add made for it on the computer holding it, with the one
     * sentence the person reads for that computer; refused while a workspace of it stands, naming them, and while its
     * folder on a computer of the person's holds work no remote has, unless force. With check, refuses as it would and
     * answers with that work, taking nothing. */
    remove(id: string, origin?: Caller, o?: { force?: boolean; check?: boolean }): Promise<{ said: string; unsaved?: string }>;
    /** Lands the host's bundle of a folder on the workspace's machine; progress rides project.import events. */
    import(opts: ProjectImportOptions, origin?: Caller): Promise<ProjectImportResult>;
    /** Brings a folder and the agent state keyed to it home from the workspace's machine; progress rides project.export events. */
    export(opts: ProjectExportOptions, origin?: Caller): Promise<ProjectExportResult>;
  };
  readonly sessions: {
    /** Starts a turn; never a second one on a session whose turn is running. A start on a thread whose turn runs
     * steers the message into it when the harness steers (the handle is the running turn's, outcome steered), else
     * waits for the turn to end and then starts (outcome queued), several such starts one after another in order. */
    start(
      workspaceId: string,
      opts: {
        prompt: string;
        harness?: string;
        /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness
         * never announced a session (a launch that never reached the machine) takes the message as a first turn on
         * that same thread. Rejects when no thread on the workspace has that id. */
        thread?: string;
        /** The folder the thread starts in, absolute; it wins over project and the default folder rule. */
        cwd?: string;
        model?: string;
        effort?: string;
        permissionMode?: string;
        /** The access in wsp's own word, which the harness's row turns into its mode; a permissionMode beside it wins. */
        access?: AccessChoice;
        contextWindow?: string;
        /** The model's faster output; refused naming the model where its catalog row offers none. */
        fast?: boolean;
        /** Absent means a person asked. */
        startedBy?: SessionOrigin;
        /** The client's id for this send, stamped on the turn's session.start as sent. */
        requestId?: string;
        /** Set where a press in the thread's slate sent this message; stamped on the turn's start or steer. */
        via?: "slate";
        /** The id a send to several models opens each of its threads under, stamped on the row as sent. */
        attempt?: string;
        /** Who the end of every turn on the thread this start opens is told, each a thread id or NOTIFY_ME: the line
         * (notifyLine) goes into each named thread through this same start, and for me it is recorded for the person.
         * A start that resumes a thread keeps what the thread had. Rejects when a target names no thread, and rejects
         * when one names the thread this start opens. */
        notify?: readonly string[];
        /** The TURN_TOKEN_ENV of the turn this request came out of, when it came out of one, off the client's own
         * environment: what NOTIFY_ME is read against, so a thread names itself without knowing its own id. Rejects
         * when no turn here carries it. */
        turnToken?: string;
        /** The name the thread takes as a person's: it stands from the first second, the harness is told it too, and
         * no generated title ever replaces it. Rejects on a blank one. */
        title?: string;
        /** The images the message carries. Rejects over the caps, and rejects naming the agent when that agent's
         * adapter reads no image, both before the machine is asked for anything. */
        attachments?: readonly Attachment[];
        /** MCP servers the thread this start opens gets besides the ones the harness's own config names, by the name
         * each takes in a config: what a caller that needs a tool loaded whatever the person's config says hands
         * over (the cloud setup's own thread, which calls the wsp recipe tools). */
        mcpServers?: Readonly<Record<string, McpServerSpec>>;
        /** The line a thread opened on a pull request is told first: the worktree holding the branch was left behind it. */
        behind?: string;
        /** Set by Resume at reset alone: the reset this turn goes on at, stamped on its session.start. */
        afterLimit?: number;
        /** Set by a child's finished line into its lead alone: no computer's threads at once holds it, since it is
         * how a tree waiting on its children moves. */
        wakesLead?: true;
        /** Called once, as its computer's threads at once first holds the turn back, with the row it waits on: a
         * caller that answers a held start at once reads it here, and the start goes on to its launch. */
        onHeld?: (held: { view: SessionView; turnId: string; wait: ThreadCapWait }) => void;
        /** The thread this request came out of follows the turn to its end, so the turn runs in that thread's slot. A
         * start with no onHeld is followed whatever this says, since its caller waits for the launch. */
        followed?: boolean;
      },
      origin?: Caller,
    ): Promise<SessionHandle>;
    /** Every turn this state file knows, the ones before a restart as they were last written. One that was still
     * running then reads running while its machine still holds its run, since the run is re-opened at load and goes
     * on to its reply; one whose run no machine has left reads failed. */
    list(workspaceId?: string, origin?: Caller): Promise<SessionView[]>;
    /** The workspace's persisted session events, oldest first; a chat replays these on mount. */
    history(workspaceId: string, origin?: Caller): Promise<SessionEvent[]>;
    /** One thread's newest events under `before`, as sessions.history answers a page; nothing for a thread the caller
     * does not reach, as history leaves its events out. */
    page(workspaceId: string, window: { threadId: string; before?: number; limit?: number }, origin?: Caller): Promise<HistoryPage>;
    /** The thread's head, by its fold key; refused as not found where the caller reaches no row of it. */
    head(threadId: string, origin?: Caller): Promise<ThreadHead>;
    /** One image a person's message carried on that workspace's thread, by the request id its start carries and its
     * place in the message; refused as not found where the host keeps none. */
    attachment(workspaceId: string, threadId: string, requestId: string, index: number, origin?: Caller): Promise<KeptAttachment>;
    /** Stops the session's running turn through its harness, or with task the one subagent of it the agent calls by that
     * id; a turn already over or an unknown id answers, never throws. */
    interrupt(sessionId: string, origin?: Caller, task?: string): Promise<SessionInterruptResult>;
    /** Sends a message into the session's running turn through its harness and records it as session.steer once the
     * harness took it; a turn already over, a harness without steer or an unknown id answers. Refuses like start
     * while the workspace is pausing or paused. */
    steer(sessionId: string, opts: { prompt: string; requestId?: string }, origin?: Caller): Promise<SessionSteerResult>;
    /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's own id and one
     * of the options it carried; the tool call it blocks then runs or is refused, and a session.permission.closed
     * event records which option did it. The session is the one the prompt's row names, by the agent's own id or the
     * runtime's. A prompt already answered, one the harness withdrew and an unknown id answer rather than throw, since
     * two clients may reach one prompt. */
    answer(sessionId: string, opts: { askId: string; optionId: string; reason?: string }, origin?: Caller): Promise<SessionAnswerResult>;
    /** Puts the session's thread at another access mode: the one road that changes a thread's access, since a send
     * into a thread names none. The thread's record takes the mode and its next turn runs at it; where a turn is
     * running and its harness takes such a change, the turn in front of the person follows it from its next tool
     * call on. unsupported is a running turn that takes none mid-turn and keeps its mode, the next turn taking the
     * pick. The session named is any row of the thread; a thread between turns answers set. */
    access(sessionId: string, permissionMode: string, origin?: Caller): Promise<SessionAccessResult>;
    /** Names the session's harness session in the harness's own store, in the field the harness itself writes, and
     * keeps the name on every row of the thread; a harness that keeps no name of a person's, a store without that
     * session and an unknown id answer. Refuses while the workspace cannot be reached, as a listing's read needs it. */
    rename(sessionId: string, title: string, origin?: Caller): Promise<SessionRenameResult>;
    /** Stamps a thread as shown by a window now, by its fold key, and tells every window with thread.marked. Reads
     * the absence a name nothing holds reads for a thread the caller cannot reach. */
    read(threadId: string, origin?: Caller): Promise<void>;
    /** Stamps each thread as settled by the person and as read, now, and tells every window as read does. */
    settle(threadIds: readonly string[], origin?: Caller): Promise<void>;
    /** Pins, snoozes or places each thread, or takes one of those back, and tells every window as read does; a snooze
     * stamps the thread read too, and every window is told again the moment it ends. */
    mark(threadIds: readonly string[], marks: ThreadMarks, origin?: Caller): Promise<void>;
    /** Takes each thread's settled stamp away and stamps it read now, and tells every window as read does. */
    restore(threadIds: readonly string[], origin?: Caller): Promise<void>;
    /** The threads the caller reaches whose messages or replies hold the query, case aside, one hit each with the
     * words around it, off the transcripts this host holds. */
    search(query: string, origin?: Caller): Promise<SessionSearchResult>;
    /** Asks the thread's harness a question beside the thread, off the thread's latest row, and records nothing. Takes
     * any of the thread's session ids. Refused where the harness never announced a session or takes no side question.
     * With askId, each piece of the answer passes by as an aside.text event under it while the harness writes it. */
    aside(sessionId: string, question: string, origin?: Caller, askId?: string): Promise<SessionAsideResult>;
    /** Rewinds a thread to the end of one of its turns, or with undo puts back the files its last rewind replaced.
     * Refused whole, before anything is written, on a working thread, one whose threads under it run, the latest
     * turn, files a turn kept no checkpoint of, and a workspace that is the person's own folder. */
    rewind(threadId: string, opts: { turnId?: string; files?: boolean; undo?: boolean }, origin?: Caller): Promise<SessionRewindResult>;
    /** Records one step of a reply's block run on its thread and answers the step the thread now holds: the one asked
     * for, or the ending the run already had, since two windows may both report one run's end. The output is cut to
     * its tail. The person's act alone: a thread's own token is refused. */
    run(step: RunStep, origin?: Caller): Promise<SessionRunEvent>;
    /** Drops a thread no turn ever ran on, the row a launch that never got going leaves: its rows and its
     * transcript rows go and nothing is asked of the machine. Takes the runtime's thread id, not a session id.
     * Refused (kind conflict) with threadForgetRefusal's sentence once a turn of it did work, which threadRan
     * decides: a turn the agent refused did none, however far its launch got. A thread of another tree reads the
     * absence a name nothing holds reads, before any of that. With check, refuses as it would and drops nothing. */
    forget(threadId: string, origin?: Caller, o?: { check?: boolean }): Promise<void>;
    /** Takes a thread on this computer away with its turns and checkpoints, and a worktree wsp made with the thread
     * when the thread ran in one, every thread in it going too. Never the project folder. */
    delete(threadId: string, origin?: Caller): Promise<{ workspaceId: string; worktree?: string; threads: number }>;
  };
  readonly harnesses: {
    /** What each harness with an adapter takes at launch; the composer's pickers render from this. With a running
     * workspace each adapter that probes is asked on its machine, at a session start too, and its answer, or the table
     * when it gives none, is kept per machine and harness for CATALOG_TTL_MS; without one, or on a workspace that is not
     * running, the table answers. */
    list(workspaceId?: string, origin?: Caller): Promise<HarnessCatalog[]>;
  };
  readonly golden: {
    build(opts: GoldenBuildRequest): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    /** The manifest at the place the image's own seal stands: the versions wsp init built and updates there. */
    get(name?: string): Promise<GoldenManifest | undefined>;
    /** Where an image build goes: the image's own place once a record stands, whatever `word` says; before that,
     * the place `word` names, by the name or id wsp places lists, else the default place, else the one other place
     * that runs workspaces. Answers the id its copies are filed under, the name a person
     * reads and the backend a builder there is made on. Refused with the place's own reason where it runs none, with
     * NO_BUILD_PLACE_LINE where no place here does, and with buildPlaceAskLine where more than one does and none is the
     * default. */
    buildPlace(word?: string): Promise<{ place: string; name: string; backend: MachineBackend }>;
    /** Boots a first-life builder from the recipe; a person sets it up on its live screen, then seals it.
     * Once `signal` aborts the call rejects with PrepareStoppedError: a machine this prepare made is killed by its
     * recorded id and its record dropped (a create still in flight is killed as it lands); a builder it attached to
     * keeps the seal in it, its hold is released and its record stays reusable. `place` is where the builder is
     * made, a joined computer or a provider by name or id; absent is the provider this host forks on. `copy` marks a
     * copy's build, whose frames name the place; the image's own build names none, wherever it runs, which is how
     * the app tells the two apart. */
    prepare(opts?: { name?: string; kind?: MachineKind; signal?: AbortSignal; recipe?: GoldenRecipe; place?: string; copy?: boolean }): Promise<GoldenBuilderView>;
    /** Snapshot, smoke-fork, append a version. A builder built from a recipe is kept running for GRACE_MS after a
     * successful seal so one more change re-snapshots it; any other builder, and every failed or refused seal, consumes
     * it, except a snapshot the provider refused: that builder is left as it was and stays recorded for the next init
     * to attach to while the provider still has it (SnapshotFailedError says which). keepBuilder false ends it with
     * the seal instead: a caller with no process left to end the window would otherwise leave it billing until the
     * next host sweeps it. logins: what each sign-in asked of the builder came to, stamped on the version. */
    seal(builderId: string, opts?: { logins?: GoldenLogin[]; keepBuilder?: boolean }): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    /** The recipe the golden's head was built from, or nothing when it was not built from one. */
    recipe(name?: string): Promise<RecipeDigest | undefined>;
    /** The next version from the recipe delta: on the builder kept since the save when there is one, else on a
     * fresh fork of the head. Seals it, repoints the head, and drops the previous version's snapshot when asked. */
    upgrade(opts: { name?: string; delta: GoldenDelta; keepPrevious?: boolean; logins?: GoldenLogin[]; recipe?: GoldenRecipe }): Promise<GoldenUpgradeResult>;
    /** How a browser dials the builder's daemon; the builder is not a workspace, so it has its own road. */
    builderReach(builderId: string): Promise<DaemonReachView>;
    builders(): Promise<GoldenBuilderView[]>;
    /** Stops a builder of this setup by its recorded id and drops the record; one another live process holds or another setup owns is refused. */
    kill(builderId: string): Promise<void>;
    /** Moves the golden's head; new forks follow it, workspaces already forked keep their image. */
    rollback(version: number, name?: string): Promise<GoldenManifest>;
    /** Makes every version of the golden durable: one with no template gets a fresh promotion of its snapshot and
     * forks boot from it from then on; one whose snapshot the provider has lost is a row saying so and nothing is
     * written. Undefined on a backend without templates; empty when every version already has one. */
    promote(name?: string): Promise<GoldenPromotion[] | undefined>;
    /** Every project golden this runtime took, oldest first. */
    projects(): Promise<ProjectGolden[]>;
    /** Deletes a project golden's snapshot at the provider of its place and drops the record once the listing reads
     * it gone, or at once where the provider already lost it. Refused while any workspace stands on it; a refusal
     * of the provider's, or a listing that holds the id through the read-back window, keeps the record. */
    removeProject(snapshotId: string): Promise<ProjectGoldenRemoved>;
    /** Every snapshot on the account by count, size and monthly cost past the free GB, sized from the provider's
     * listing and split by who made each one; undefined on a backend that cannot list snapshots. */
    storage(): Promise<SnapshotStorage | undefined>;
    /** The snapshots and templates this host made that nothing here records, and the rows left alone beside them;
     * undefined on a backend that cannot list snapshots. */
    orphans(): Promise<AccountOrphans | undefined>;
    /** Deletes what orphans() names, each orphan template before the snapshots (the provider refuses to delete a
     * snapshot a template stands on). The split is read again first, so nothing recorded since is touched, and
     * nothing without this host's mark is ever passed to a delete. */
    deleteOrphans(): Promise<OrphansDeleted | undefined>;
    /** The golden's ancestors older than its head and the head's parent, with what deleting them frees, minus every
     * version a workspace of this runtime was forked from; undefined with no golden or no snapshot listing. */
    retention(name?: string): Promise<RetentionPlan | undefined>;
    /** Deletes the snapshots retention offers and drops those versions and their recipes from the manifest. The plan
     * is read again first, so a workspace forked since the offer keeps its version; a delete the provider refuses
     * keeps the version and is reported by version. */
    prune(name?: string): Promise<{ dropped: GoldenVersion[]; failed: { version: number; message: string }[] }>;
  };
  /** The image this host owns, as against the copy each place holds of it. */
  readonly image: {
    get(name?: string): Promise<SealedImageView>;
    /** The vault bytes and the record, for the host to seal and write; refused when the record holds no vault. */
    vault(name?: string): Promise<{ image: SealedImage; tar: Buffer }>;
    /** Prepares a builder at `place` from the recipe `copyRecipe` composes off the record (every login set to skip),
     * lands the record's vault on it and seals; the copy is recorded under that place at the record's hash. The
     * recipe is asked for only once every refusal has passed, so the host composes nothing for a build that cannot
     * run. A place already holding a copy of this record is answered with that copy and builds nothing; a place
     * whose copy is building is answered with that build, joined, never a second one. Any place wsp places lists
     * takes it, a joined computer by name or id included. Refused when the place builds no copy at all, when the
     * record has no small recipe to build from, and, without `force`, when it holds no vault. Progress rides
     * golden.stage frames carrying the place's id, and the place's row reads them. */
    build(o: { place: string; name?: string; force?: boolean; signal?: AbortSignal; starting?: () => void }): Promise<SealedImageBuilt>;
    /** Brings a joined computer's copy up to the record at the end of its setup: nothing where this host holds no
     * image, where the place runs no workspaces or is not connected, or where its copy already stands on the
     * record; else the build, joined where one is running there, and built again where the record moved while it
     * ran. Never rejects: a build that stopped leaves its reason on the place's row until the next build there
     * takes the row over, which wsp image build or a fork there starts. Resolves once the copy stands or the build
     * stopped. */
    keepCurrent(place: string, name?: string): Promise<void>;
  };
  /** Enriched status (machine state, daemon reach, size, rate) + cost ticker; its list leaves out the workspaces the
   * caller's origin may not drive, as workspaces.list does. */
  readonly status: OriginStatusApi;
  /** The two usage records, never added together: what was used, split four ways over a range, and what each account
   * signed in anywhere may still use. */
  readonly usage: UsageDoor;
  /** Each thread's slate: its record, the ops a window and the slate verbs send, and a press into the thread. */
  readonly slates: Slates;
  /** The computers paired with this host and the one time codes that pair them, one collection each on this state
   * file, so a restart neither locks a paired computer out nor keeps a revoked one in. */
  readonly devices: DeviceDoor;
  /** The person's view preferences, one record on this state file, so the desktop app and a browser tab agree. */
  readonly preferences: {
    get(): Promise<Preferences>;
    /** The patch over the record; the record kept and pushed as preferences.changed to every socket. */
    set(patch: PreferencesPatch): Promise<{ preferences: Preferences; notice?: string }>;
  };
  /** This state file's owner id, stamped on every machine it creates: a machine wearing another one was made by
   * another host standing on the same account. Minted on the first read when the state file has none. */
  owner(): Promise<string>;
  /** Records this state file's workspace machines that no record claims, kills its builders and smoke forks that none
   * claims plus orphans past their backstop, and lists the running machines it left alone. `say` is where every
   * later line about a machine still being asked to stop goes, from this sweep on. */
  reap(olderThanMs?: number, say?: (line: string) => void): Promise<SweepResult>;
  /** Writes every transcript still waiting on its debounce; the store is complete once this resolves. */
  close(): Promise<void>;
}

/** What this host left on the account that nothing here records, and what it deliberately leaves alone beside it.
 * A snapshot carries no provider metadata, so a row is this host's only by the mark in its name; anything without
 * that mark is another host's or a person's and is named, never deleted. */
export interface AccountOrphans {
  snapshots: SnapshotRow[];
  templates: TemplateRow[];
  /** What the orphan snapshots hold, and what deleting them takes off the monthly bill once storage is billed. */
  freedBytes: number;
  savesUsdPerMonth: number;
  /** No mark of this host, so nothing here may touch them. */
  others: { snapshots: SnapshotRow[]; templates: TemplateRow[] };
}

export interface OrphansDeleted {
  snapshots: SnapshotRow[];
  templates: TemplateRow[];
  /** One per delete the provider refused; the row stays on the account. */
  failed: { id: string; name?: string; message: string }[];
}
