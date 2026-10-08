// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect as connectTcp } from "node:net";
import type { Readable, Writable } from "node:stream";
import { ROAD_MODULES, agentName, catalogEntry, isRoad } from "@wsp/catalog";
import {
  LOOPBACK,
  SSH_ALIAS_PREFIX,
  sshAlias,
  IMAGE_ALREADY_NEWEST,
  ProjectGolden,
  ProjectGoldenRemoved,
  SealedImage,
  SealedImageBuilt,
  SealedImageView,
  NO_SEALED_IMAGE,
  IMAGE_PASSPHRASE_ENV,
  IMAGE_PASSPHRASE_MIN,
  GOLDEN_STAGE_WORDS,
  sealedCopyLine,
  sealedPinLine,
  sealedImageLine,
  sealedProjectLine,
  noProjectImageLine,
  projectImageRemoveNotice,
  type GoldenStageEvent,
  PlaceView,
  SessionInterruptOutcome,
  SessionInterruptResult,
  SessionRenameOutcome,
  SessionRenameResult,
  ThreadView,
  UpgradeResult,
  WorkspaceAgents,
  WorkspaceListing,
  WorkspaceOut,
  WorkspaceView,
  deleteNotice,
  onDeleteOf,
  fmtThreads,
  foldThreads,
  threadWordOf,
  subagentStateWord,
  forgetNotice,
  goneRefusal,
  goneRoadRefusal,
  imageKeptLine,
  type MachineOnDelete,
  type StandsOn,
  UNNAMED_COMPUTER,
  machineWord,
  needsRebuild,
  notFoundRefusal,
  offeredSize,
  sizeFromWord,
  sizeRefusal,
  usageRefusal,
  workspaceAsleepAgainLine,
  workspaceKind,
  workspaceState,
  workspaceStateLine,
  type PauseMode,
  workspaceStateOf,
  workspaceStaysAwakeLine,
  type Capabilities,
  type SessionView,
  type WorkspaceCreateResult,
  type WorkspaceCreatingEvent,
  type WorkspaceSize,
  type WorkspaceState,
  homeShortened,
  localFolderRefusal,
  localWorktreeRefusal,
  threadWithoutIdRefusal,
  threadWord,
  ProjectView,
  computerNamed,
  copyTakesNone,
  copiesFolder,
  kindForComputer,
  sourceWord,
  isLocalWorkspace,
  runsInFolder,
  namesPlace,
  packageOf,
  type SealedPin,
  CommitDraft,
  GitCommitReply,
  FixResult,
  MergeInResult,
  fixMergeChildLine,
  GitUpdateReply,
  MergeMethod,
  MergeResult,
  fixAskedLine,
  fixConflictsLine,
  fixNothingLine,
  updateConflictsLine,
  updatedLine,
  isProviderPlace,
  ReviewPostResult,
  START_WORDS,
  StartResult,
  type ReviewVerdict,
} from "@wsp/protocol";
import { gitRootOf } from "../repo-root.js";
import { type HostClient, pushedFrames, type Out, hostPlatform, flagFor, type SshAsked, type VerbContext, tableName, absolutePath, accessWordOf, under, otherVersion, threadIdOf, openedThreadSaid } from "./client.js";
import type { Turn } from "./turns-help.js";

export async function workspaces(client: HostClient): Promise<WorkspaceOut[]> {
  return (await client.request<{ workspaces: WorkspaceOut[] }>("workspaces.list")).workspaces;
}

/** Every workspace with what the app's rail reads live beside it: the provider's word for the machine and the daemon
 * reach, without the route the reach carries, which the runtime keeps off this door. The listing above is what every
 * verb that only needs to name a workspace takes, since this one probes. */
export async function workspaceStatuses(client: HostClient): Promise<WorkspaceListing[]> {
  return (await client.request<{ statuses: WorkspaceListing[] }>("status.list")).statuses;
}

export async function threads(client: HostClient, workspaceId?: string): Promise<ThreadView[]> {
  const { sessions } = await client.request<{ sessions: SessionView[] }>("sessions.list", workspaceId !== undefined ? { workspaceId } : {});
  return foldThreads(sessions);
}

/** A workspace as a person names it: by id, else by its name when exactly one carries it. The host reads the name off
 * the same list it prints, so a workspace the listing shows is never denied here as absent, and one this caller may
 * not drive is refused in the words of the rule that hides it. */
export async function workspaceOf(client: HostClient, ref: string, verb?: "exec"): Promise<WorkspaceOut> {
  const { workspace } = await client.request<{ workspace?: unknown }>("workspaces.resolve", { ref, ...(verb !== undefined ? { verb } : {}) });
  const read = WorkspaceOut.safeParse(workspace);
  if (!read.success) throw new Error(otherVersion("workspaces.resolve"));
  return read.data;
}

/** The thread a reference names among these rows: by id, or by a prefix of it that names exactly one. */
function pickThread(all: readonly ThreadView[], ref: string): ThreadView {
  const exact = all.find(t => t.id === ref);
  if (exact !== undefined) return exact;
  const prefixed = all.filter(t => t.id.startsWith(ref));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) throw new Error(`${prefixed.length} threads start with ${ref}; give more of the id`);
  throw notFoundRefusal(`no thread ${ref}`);
}

/** A thread by id, or by a prefix of it that names exactly one. */
export async function threadOf(client: HostClient, ref: string): Promise<ThreadView> {
  return pickThread(await threads(client), ref);
}

/** Several threads by the same rule, off one listing, in the order named. */
export async function threadsOf(client: HostClient, refs: readonly string[]): Promise<ThreadView[]> {
  const all = await threads(client);
  return refs.map(ref => pickThread(all, ref));
}

export type ThreadRow = ThreadView & { projectName: string; folder: string; branch: string; computerName: string };

/** The sidebar's rows with the project, the folder, the branch and the computer each thread is on, within one
 * project when named, as every director lists them. The folder is where the thread's latest turn ran; its branch is
 * read off git where that folder is on this computer, since an agent may switch it, else off the worktree's record.
 * The names come off one reading of the records and one of the computers, so a table is never half of two. */
export async function threadRows(client: HostClient, within?: string): Promise<ThreadRow[]> {
  const all = await workspaces(client);
  const rows = (await threads(client)).filter(t => {
    if (within === undefined) return true;
    const w = all.find(x => x.id === t.workspaceId);
    return w !== undefined && (w.project.id === within || w.project.name === within || w.id === within || w.name === within);
  });
  // The names a person gave their computers are the person's to read: a caller the host answers as a thread is
  // refused that list, and its rows carry the computer's id instead of falling over.
  const named = rows.length === 0 ? new Map<string, string>() : await placeNames(client).catch(() => new Map<string, string>());
  const branches = new Map<string, string>();
  return rows.map(t => {
    const workspace = all.find(w => w.id === t.workspaceId);
    // A thread whose worktree is gone runs its next turn in the folder its record answers now, and is listed there.
    const moved = workspace?.worktree?.gone === true && t.cwd !== undefined && under(t.cwd, workspace.worktree.path);
    const folder = (moved ? undefined : t.cwd) ?? workspace?.folder ?? workspace?.project.path ?? "";
    if (!branches.has(folder)) branches.set(folder, (isLocalWorkspace(workspace ?? {}) ? branchHere(folder) : undefined) ?? (workspace?.worktree?.gone === true ? undefined : workspace?.worktree?.branch) ?? "");
    return {
      ...t,
      projectName: workspace?.project.name ?? "",
      folder,
      branch: branches.get(folder)!,
      computerName: workspace === undefined ? "" : (named.get(workspace.project.computer) ?? workspace.project.computer),
    };
  });
}

/** How the computer a workspace's project lands on pauses a machine, for every line that prints a state word: the
 * landing's own flags, which is the reading the app's rows take it from too, so the table and the sidebar cannot
 * say two things about one nap. Nothing where the landing is refused, which reads the stopping words as every
 * caller holding no mode does. */
export async function pauseModeOf(client: HostClient, project: string): Promise<PauseMode | undefined> {
  try {
    return (await client.request<{ capabilities: Capabilities }>("workspaces.landing", { project })).capabilities.pauseMode;
  } catch {
    return undefined;
  }
}

/** The workspace's name and its state word, the line a pause prints once the runtime has answered: the phase is the
 * whole of what a pause changed, and the machine's own state follows it. The computer's pause mode rides, so a nap
 * at a provider that keeps the machine's memory reads paused and a stop reads stopped. */
export function stateLine(workspace: WorkspaceView, pauseMode?: PauseMode): string {
  return workspaceStateLine(workspace.name, workspaceState({ phase: workspace.phase }), pauseMode);
}

/** The line a wake prints: the word the next `wsp workspaces` will print for this workspace, read back off the
 * listing once the wake has settled rather than off the phase the wake wrote. A wake that says running while the
 * table says unreachable is two answers about one machine, and the phase alone cannot tell them apart. */
export async function wokeLine(client: HostClient, workspace: WorkspaceOut): Promise<string> {
  const listed = (await workspaceStatuses(client)).find(w => w.id === workspace.id);
  const mode = await pauseModeOf(client, workspace.project.id);
  return workspaceStateLine(workspace.name, listed === undefined ? workspaceState({ phase: workspace.phase }) : workspaceStateOf(listed, listed), mode);
}

/** Naps the workspace a person names; the view after, as every director shows it. */
export async function nap(client: HostClient, ref: string): Promise<WorkspaceOut> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ workspace: WorkspaceOut }>("workspaces.nap", { workspaceId: source.id })).workspace;
}

/** Replaces the machine under a workspace the provider no longer has, the road out of gone that the app's row
 * action takes. The status is read beside the record so the refusal is the row's own: the record alone carries no
 * reach, and a workspace whose machine stopped answering would read as answering here while every pane on it read
 * that it had not. The runtime alone knows the machine is replaced, and the view it returns carries the new one. */
export async function rebuild(client: HostClient, ref: string): Promise<WorkspaceOut> {
  const source = await workspaceOf(client, ref);
  const listed = (await workspaceStatuses(client)).find(w => w.id === source.id) ?? null;
  const state = { phase: source.phase, machineState: listed?.machineState, reach: listed?.reach.state, wakeRefused: source.wakeRefused };
  if (!needsRebuild(state)) throw new Error(goneRoadRefusal(workspaceState(state), "rebuild"));
  return (await client.request<{ workspace: WorkspaceOut }>("workspaces.rebuild", { workspaceId: source.id })).workspace;
}

/** The state line every director prints after a rebuild, with the machine now under the workspace: the id changed,
 * so a caller that held the old one is told. No pause mode rides: a machine forked a moment ago is running, and the
 * mode only ever picks between the words for a machine that is not. */
export function rebuiltLine(workspace: WorkspaceView): string {
  return `${stateLine(workspace)} on ${workspace.machineId}`;
}

/** The image and its copies as this host serves them, parsed and not trusted, for every director that draws them. */
export async function imageView(client: HostClient): Promise<SealedImageView> {
  const { view } = await client.request<{ view: unknown }>("image.get", {});
  return SealedImageView.parse(view);
}

/** Builds this host's image at a place, streaming the build's lines as the runtime reports them: one line per stage,
 * the same words the creation log prints. The record is read back after it, so the copy is said in the words `wsp
 * image` says it in; every refusal is the host's. */
export async function buildImageAt(client: HostClient, out: Out, word: string, force?: boolean): Promise<{ image: SealedImage; built: SealedImageBuilt }> {
  // The build's frames carry the place's id, whichever word the person typed for it, and the lines read its name. A
  // word the list does not hold goes to the host as typed: the host is the one judge of what it names.
  const listed = (await client.request<{ places: PlaceView[] }>("places.list")).places.find(p => namesPlace(p, word));
  const place = listed ?? { id: word, name: word };
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "golden.stage" && (f as unknown as GoldenStageEvent).place === place.id,
    f => {
      const e = f as unknown as GoldenStageEvent;
      const words = e.stage === "failed" ? "Failed" : GOLDEN_STAGE_WORDS[e.stage];
      out.stream(`${[`${place.name}: ${words}`, ...(e.detail !== undefined ? [e.detail] : [])].join("  ")}\n`);
    },
  );
  try {
    const { build } = await client.request<{ build: unknown }>("image.build", { place: place.id, ...(force === true ? { force } : {}) });
    const view = await imageView(client);
    if (view.image === null) throw new Error(NO_SEALED_IMAGE);
    return { image: view.image, built: SealedImageBuilt.parse(build) };
  } finally {
    pushed.stop();
  }
}

/** A pin's row by name: the catalog's for a catalog id, else the package a row outside the catalog names. */
const pinName = (pin: SealedPin): string => catalogEntry(pin.id)?.name ?? packageOf(pin);

/** What every director prints for the image: the record, a row per place, what each row installed at the seal, and
 * the project images under it. */
export function imageLines(view: SealedImageView): string[] {
  if (view.image === null) return [NO_SEALED_IMAGE];
  const image = view.image;
  return [
    sealedImageLine(image),
    ...view.copies.map(c => sealedCopyLine(image, c)),
    ...(image.pins ?? []).map(p => `  ${sealedPinLine(pinName(p), p, isRoad(p.road) ? ROAD_MODULES[p.road].words : undefined)}`),
    ...view.projects.map(sealedProjectLine),
  ];
}

/** Why an export runs at its own host's terminal: the bytes it writes are the person's sign-ins, so the file lands
 * on the computer whose terminal asked for it and the passphrase never crosses to another. */
export const HOST_SIDE_VAULT = "The vault leaves the host only as a sealed file on the computer that typed the line.";

/** wsp ssh on a line with no stdin and stdout of this computer's: carried from a machine, it has nothing to pipe. */
export const SSH_PIPES_HERE_LINE = "wsp ssh pipes the stdin and stdout of the ssh client that runs it, on the computer the host runs on; there is none here.";

/** The workspace an ssh alias names, by the one rule the host pins its key under, else the workspace a person
 * names as they do on any line. */
export async function sshWorkspaceOf(client: HostClient, ref: string): Promise<{ id: string }> {
  if (ref.startsWith(SSH_ALIAS_PREFIX)) {
    const hits = (await workspaces(client)).filter(w => sshAlias(w.name) === ref);
    if (hits.length > 1) throw usageRefusal(`${hits.length} workspaces go by ${ref}: ${hits.map(w => `${w.name} (${w.id})`).join(", ")}`, "Rename one with wsp rename and open it again.");
    if (hits.length === 1) return hits[0]!;
  }
  return workspaceOf(client, ref);
}

/** Bytes both ways between this process's own streams and a port on this computer's loopback, until that side ends. */
export function pipeBytes(port: number, bytes: { input: Readable; output: Writable }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, LOOPBACK);
    socket.once("error", reject);
    socket.once("connect", () => {
      bytes.input.pipe(socket);
      socket.pipe(bytes.output, { end: false });
    });
    socket.once("close", () => {
      bytes.input.unpipe(socket);
      resolve();
    });
  });
}

/** The passphrase an export is sealed to: typed twice at a terminal, read from the environment where there is none,
 * and never taken from the command line, which every process on this computer can read. */
export async function imagePassphrase(ctx: VerbContext): Promise<string> {
  const short = (word: string): string => (word.length < IMAGE_PASSPHRASE_MIN ? `the passphrase is ${IMAGE_PASSPHRASE_MIN} characters at least` : "");
  if (ctx.io.isTTY !== true) {
    const held = ctx.env[IMAGE_PASSPHRASE_ENV];
    if (held === undefined || held === "") throw usageRefusal("nobody is at this terminal to type a passphrase.", `Set ${IMAGE_PASSPHRASE_ENV} for this run instead.`);
    const why = short(held);
    if (why !== "") throw usageRefusal(`${IMAGE_PASSPHRASE_ENV} is too short: ${why}.`, "Set a longer one and run this again.");
    return held;
  }
  // Through the run's own io, as every other question this command line asks is: it is what a terminal answers
  // without echo and what a test answers in its place.
  const typed = await ctx.io.askSecret(`A passphrase for this export\n${IMAGE_PASSPHRASE_MIN} characters at least; it is the only way back into the file`);
  const why = short(typed);
  if (why !== "") throw usageRefusal(`${why}.`, "Nothing was exported; run it again and type a longer one.");
  const again = await ctx.io.askSecret("The same passphrase again");
  if (again !== typed) throw usageRefusal("the two passphrases are not the same.", "Nothing was exported; run it again and type the same one twice.");
  return typed;
}

/** Moves a workspace onto the newest version of the image it stands on, by the id a caller already resolved. The
 * runtime alone knows which of the image's own files the workspace changed, so the whole answer, the kept list
 * included, comes back from it. */
export async function moveImage(client: HostClient, workspaceId: string): Promise<UpgradeResult> {
  const { workspace, moved, kept, fallback } = await client.request<UpgradeResult>("workspaces.updateImage", { workspaceId });
  return { workspace, moved, kept, ...(fallback === true ? { fallback: true } : {}) };
}

/** What every director prints after the move: where the workspace stands, on which machine, and what of the image's
 * own files came across as this workspace's rather than the new image's. One that had nowhere to go says that
 * instead of naming files nothing judged, off the answer's own word for it. */
export function imageMovedLine(moved: UpgradeResult): string {
  return `${rebuiltLine(moved.workspace)}; ${moved.moved ? imageKeptLine(moved.kept, moved.fallback) : IMAGE_ALREADY_NEWEST}`;
}

/** What a workspace rename came to, as every director prints it: the name it went in under and the record after. */
export interface RenamedWorkspace {
  was: string;
  workspace: WorkspaceOut;
}

/** Names the workspace a person names, through the runtime, which holds the name on this computer. The name is
 * unique here, so a duplicate and a blank one come back as the runtime's own refusal. */
export async function renameWorkspace(client: HostClient, ref: string, name: string): Promise<RenamedWorkspace> {
  const source = await workspaceOf(client, ref);
  const { workspace } = await client.request<{ workspace: WorkspaceOut }>("workspaces.rename", { workspaceId: source.id, name });
  return { was: source.name, workspace };
}

export function renamedWorkspaceLine(r: RenamedWorkspace): string {
  return `${r.was} is now ${r.workspace.name} ${r.workspace.id}`;
}

/** A workspace a verb woke to do its work on, and whether this call is what woke it: a machine the person already
 * had running is theirs, and only the caller that took it off its nap owes it one back. */
export interface Woken {
  workspace: WorkspaceOut;
  woke: boolean;
}

/** The states a machine is down in, which are the only ones a wake can lift it out of. A machine another client is
 * already waking, or one running but out of reach, was not taken off its nap by the caller that met it there, so
 * neither counts: the fact is the transition this call made, never the word the state happened to read. `pausing`
 * is here because the nap behind it is one somebody asked for, and a run that cuts that short owes it back. */
const MACHINE_DOWN: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(["paused", "pausing"]);

/** Every verb that needs the machine goes through here, so a paused or waking workspace is a wait and never the
 * provider's error. The runtime is asked even when the view says running: only its state read catches a provider-side
 * pause. The runtime refuses a gone workspace too; the refusal here exists to carry the verb's own action word. */
export async function awake(client: HostClient, workspace: WorkspaceView, action: string, tell: (line: string) => void): Promise<Woken> {
  const before = workspaceState({ phase: workspace.phase });
  if (before === "gone") throw new Error(goneRefusal(workspace.name, action, workspace.gone));
  if (before !== "running") tell(`waking ${workspace.name}`);
  const woken = (await client.request<{ workspace: WorkspaceOut }>("workspaces.wake", { workspaceId: workspace.id })).workspace;
  return { workspace: woken, woke: MACHINE_DOWN.has(before) && workspaceState({ phase: woken.phase }) === "running" };
}

/** Why a commit has no message when the workspace's agent drafted none, and what to do instead. */
export const noDraftLine = (note: string | undefined): string => `no message was drafted: ${note ?? "the agent gave none"}`;
export const NO_DRAFT_FIX = 'Pass one with --message "<message>".';

/** A commit of the files named, or of every changed file, with the message given; without one the workspace's agent
 * drafts it and the draft is said on the line given before the commit is made with it. */
export async function committed(client: HostClient, workspaceId: string, message: string | undefined, files: string[], say: (line: string) => void): Promise<GitCommitReply> {
  const named = files.length > 0 ? { paths: files } : {};
  let text = message;
  if (text === undefined) {
    const draft = CommitDraft.parse(await client.request("workspaces.commitDraft", { workspaceId, ...named }));
    if (draft.message === null) throw usageRefusal(noDraftLine(draft.note), NO_DRAFT_FIX);
    say(draft.message);
    text = draft.message;
  }
  return GitCommitReply.parse(await client.request("workspaces.commit", { workspaceId, message: text, ...named }));
}

/** A fix asked of the host, one road for the command line and the tool. */
export async function askedToFix(client: HostClient, workspaceId: string, check: string | undefined, child?: string): Promise<FixResult> {
  const read = FixResult.safeParse(await client.request("workspaces.fix", { workspaceId, ...(check !== undefined ? { check } : {}), ...(child !== undefined ? { child } : {}) }));
  if (!read.success) throw new Error(otherVersion("workspaces.fix"));
  return read.data;
}

/** A merge of a child into its lead asked of the host, the lead woken first; one road for the command line and the tool. */
export async function mergedIn(client: HostClient, leadRef: string, child: string, said: (line: string) => void): Promise<MergeInResult> {
  const lead = await workspaceOf(client, leadRef);
  const { workspace: awoken } = await awake(client, lead, "merge in", said);
  return MergeInResult.parse(await client.request("workspaces.mergeIn", { workspaceId: awoken.id, child }));
}

/** What a fix reads as: which agent was asked to fix what, or that the update left nothing to fix. */
export function fixLine(workspace: string, asked: FixResult): string {
  if (asked.outcome === "updated") return fixNothingLine(workspace, asked.base);
  const agent = agentName(asked.agent);
  if (asked.child !== undefined) return fixMergeChildLine(workspace, agent, asked.child);
  return asked.check !== undefined ? fixAskedLine(workspace, agent, asked.check) : fixConflictsLine(workspace, agent, asked.base);
}

/** A workspace started off a link, as the host answers it: the workspace in the host's own bytes, as a create's. */
export async function startedFrom(client: HostClient, o: { url: string; project?: string; agent?: string; model?: string; effort?: string; access?: string }): Promise<StartResult> {
  const asked = Object.fromEntries(Object.entries({ ...o, access: o.access === undefined ? undefined : accessWordOf(o.access) }).filter(([, v]) => v !== undefined));
  const { workspace, threadId, sessionId } = await client.request<StartResult>("workspaces.start", asked);
  return { workspace, threadId, sessionId };
}

/** A reviewer thread on a pull request, off a link or a workspace's own pull request. */
export async function reviewStarted(client: HostClient, o: { url?: string; workspaceId?: string; agent?: string; model?: string; effort?: string }): Promise<StartResult> {
  const asked = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const { workspace, threadId, sessionId } = await client.request<StartResult>("workspaces.review", asked);
  return { workspace, threadId, sessionId };
}

/** A review posted, its draft edited first where a verdict or a summary is named. */
export async function reviewPosted(client: HostClient, workspaceId: string, edits: { verdict?: ReviewVerdict; summary?: string }): Promise<ReviewPostResult> {
  if (edits.verdict !== undefined || edits.summary !== undefined) await client.request("workspaces.reviewDraft", { workspaceId, ...edits });
  return ReviewPostResult.parse(await client.request("workspaces.reviewPost", { workspaceId }));
}

/** The two lines a start or a review prints: what was made from what, then the thread as the command line's detached
 * run prints it, or as the run tool answers it. */
export function startedLines(started: StartResult, thread: (threadId: string) => string = id => openedThreadSaid(id, undefined)): string {
  return `${START_WORDS.made(started.workspace.name, started.workspace.from)}\n${thread(started.threadId)}`;
}

/** The verdict a line names, in the command line's dashed spelling or the host's own. */
export const VERDICTS: Record<string, ReviewVerdict> = { comment: "comment", approve: "approve", "request-changes": "request_changes", request_changes: "request_changes" };

/** A merge asked of the host, one road for the command line and the tool. */
export async function mergedPr(client: HostClient, workspaceId: string, method: MergeMethod | undefined, whenChecksPass: boolean): Promise<MergeResult> {
  return MergeResult.parse(await client.request("workspaces.merge", { workspaceId, ...(method !== undefined ? { method } : {}), ...(whenChecksPass ? { whenChecksPass } : {}) }));
}

/** What an update reads as: the commits it brought from the base, or the files that conflict with it. */
export function updateLine(workspace: string, done: GitUpdateReply): string {
  return done.merged ? updatedLine(workspace, done.base, done.commits) : updateConflictsLine(workspace, done.base, done.conflicts);
}

/** What a launch owes the machine it woke when its thread never got going. Sleeping is automatic by window, and a
 * window is twenty minutes of the provider's rate for a turn that never reached the agent; the launch that took
 * the machine off its nap is the one that knows nothing else ran there. A machine the person already had running
 * is theirs and is neither touched nor spoken about here. Answers the line, which is the run's last, or nothing
 * where this launch changed nothing about the machine. */
export async function napAfterDeadLaunch(client: HostClient, woken: Woken, turn: Turn | undefined): Promise<string | undefined> {
  if (!woken.woke) return undefined;
  // An agent that named a refusal of its own is an agent that ran: the launch reached it, and the window the rule
  // gives a turn that ran is the right one.
  if (turn?.result?.refusal !== undefined) return undefined;
  try {
    const rows = await threads(client, woken.workspace.id);
    const mine = turn === undefined ? undefined : rows.find(t => threadIdOf(t) === turn.threadId);
    // A thread whose turn did work is not a launch that died: the machine holds what it did.
    if (mine?.ran === true) return undefined;
    if (rows.some(t => t !== mine && t.status === "running")) {
      const listed = (await workspaceStatuses(client)).find(w => w.id === woken.workspace.id);
      return workspaceStaysAwakeLine(woken.workspace.name, listed?.idleAt === undefined ? undefined : Math.max(0, listed.idleAt - Date.now()));
    }
    await client.request("workspaces.nap", { workspaceId: woken.workspace.id });
    return workspaceAsleepAgainLine(woken.workspace.name);
  } catch {
    // Whatever this road came to, the machine is awake as far as this run knows and the person is told that much.
    // The failure the run is answering with is what stands; none of it is worth losing to a second one.
    return workspaceStaysAwakeLine(woken.workspace.name);
  }
}

/** The same refusal with one more line under it. The class an exit code is read off is stamped on the error, so a
 * line added to what a person reads carries that stamp over rather than making a plain failure of a refusal. */
export function withLine(e: unknown, line: string | undefined): unknown {
  if (line === undefined || !(e instanceof Error)) return e;
  const kind = (e as { kind?: unknown }).kind;
  return Object.assign(new Error(`${e.message}\n${line}`), typeof kind === "string" ? { kind } : {});
}

/** What a stop came to, as every director prints it: the runtime's answers, none an error. */
export interface Stopped {
  threadId: string;
  /** The one subagent of the thread's turn the stop named, where it named one. */
  task?: string;
  outcome: SessionInterruptOutcome;
  /** The threads this thread's agents spawned that were running and stopped with it. */
  under?: readonly string[];
  /** Why a subagent's stop was refused or is not offered, in words. */
  error?: string;
  /** What the stop could not end on a computer the person joined, in words. */
  left?: string;
}

/** Stops the running turn of the thread a person names, or with task one of its agent's own subagents alone, through
 * the runtime as the app's stop button does; the machine is not touched. Parsed, not trusted: an outcome outside the
 * enum must not read as stopped. */
export async function stop(client: HostClient, ref: string, task?: string): Promise<Stopped> {
  const thread = await threadOf(client, ref);
  const { outcome, under, error, left } = SessionInterruptResult.parse(await client.request("sessions.interrupt", { sessionId: thread.sessionId, ...(task !== undefined ? { task } : {}) }));
  return { threadId: thread.id, ...(task !== undefined ? { task } : {}), outcome, ...(under !== undefined && under.length > 0 ? { under } : {}), ...(error !== undefined ? { error } : {}), ...(left !== undefined ? { left } : {}) };
}

const STOP_WORDS: Record<SessionInterruptOutcome, string> = { accepted: "stopped", "not-running": "not running", "not-found": "not found by the host", refused: "not stopped", unsupported: "not stopped" };

export function stopLine(stopped: Stopped): string {
  const named = `thread ${stopped.threadId}${stopped.task !== undefined ? ` task ${stopped.task}` : ""}`;
  if (stopped.error !== undefined) return `${named}: ${stopped.error}`;
  const under = stopped.under ?? [];
  const tree = under.length === 0 ? "" : `, and with it ${under.length} ${under.length === 1 ? "thread" : "threads"} its agents spawned: ${under.map(threadWord).join(", ")}`;
  return `${named} ${STOP_WORDS[stopped.outcome]}${tree}${stopped.left === undefined ? "" : `, but ${stopped.left}`}`;
}

/** Drops the thread from this computer through the runtime, the road the app's row action takes; the runtime
 * refuses one whose turn ran and nothing on the machine is touched either way. A row from before threads carries
 * no thread id, so it is refused here in its own words rather than dialled for and answered as a thread nobody has,
 * which is the guard the app's row action makes before it offers the action at all. */
export async function forgetThread(client: HostClient, thread: ThreadView): Promise<void> {
  if (thread.threadId === undefined) throw new Error(threadWithoutIdRefusal(thread.id));
  await client.request("sessions.forget", { threadId: thread.threadId });
}

/** The line every director prints for a forget, naming what nobody loses: no turn of the thread did any work. */
export function threadForgotLine(thread: ThreadView): string {
  return `forgot thread ${thread.id}: no turn ever ran on it, so nothing of its work is gone`;
}

/** What a rename came to, as every director prints it: the runtime's five answers, none an error. `error` is the
 * line the machine gave for a write it refused, and rides only that answer. */
export interface Renamed {
  threadId: string;
  title: string;
  harness: string;
  outcome: SessionRenameOutcome;
  error?: string;
}

/** Names the thread a person names, through the runtime, which writes the name into the agent's own store on the
 * machine. Parsed, not trusted: an outcome outside the enum must not read as renamed. */
export async function rename(client: HostClient, thread: ThreadView, title: string): Promise<Renamed> {
  const { outcome, error } = SessionRenameResult.parse(await client.request("sessions.rename", { sessionId: thread.sessionId, title }));
  return { threadId: thread.id, title, harness: thread.harness, outcome, ...(error !== undefined ? { error } : {}) };
}

/** Each answer in one phrase, the agent named where the answer is about the agent's own store, and the machine's own
 * line where the store refused the write: nothing here says which sessions a store has unless the store said it. */
export function renameLine(renamed: Renamed): string {
  const agent = agentName(renamed.harness);
  const words: Record<SessionRenameOutcome, string> = {
    renamed: `named ${renamed.title}, in ${agent} too`,
    unsupported: `not named: ${agent} keeps no name of a person's for a session`,
    "no-session": `not named: ${agent} on the machine has no such session`,
    failed: `not named: ${renamed.error ?? "the machine said nothing about the write"}`,
    "not-found": "not found by the host",
  };
  return `thread ${renamed.threadId} ${words[renamed.outcome]}`;
}

/** What a delete does to this workspace's machine, in its kind's own words: both lines about what a delete takes
 * read the one entry, so neither can say the other kind's sentence. */
const onDelete = (d: Dropping): MachineOnDelete => onDeleteOf(workspaceKind(d.workspace), madeWorktree(d.workspace), d.workspace.machineId, d.on);
/** The worktree a delete takes with the record: only one wsp made. */
export const madeWorktree = (w: Pick<WorkspaceView, "worktree">): { path: string } | undefined => (w.worktree?.made === true && w.worktree.gone !== true ? { path: w.worktree.path } : undefined);

/** What dropping a workspace takes off this computer, counted before anyone is asked: its record and its threads. */
export interface Dropping {
  workspace: WorkspaceView;
  threads: number;
  /** The computer somebody joined that it stands on, by the names a person reads; absent everywhere else, and where
   * the caller may not read the computers' names. */
  on?: StandsOn;
}

export async function dropping(client: HostClient, ref: string): Promise<Dropping> {
  const workspace = await workspaceOf(client, ref);
  if (isLocalWorkspace(workspace) && workspace.worktree !== undefined) {
    throw usageRefusal(localWorktreeRefusal(workspace.name), "Remove it with wsp worktree remove <project> <branch>, or delete a thread there with wsp delete <thread>.");
  }
  if (runsInFolder(workspaceKind(workspace))) throw usageRefusal(localFolderRefusal(workspace.name), "Run wsp threads to find its threads, then wsp delete <thread>.");
  return { workspace, threads: (await threads(client, workspace.id)).length };
}

/** What a delete takes, with the computer somebody joined that the workspace stands on named, which is what its two
 * lines say is deleted from: a forget names no computer, so only a delete reads the computers' names. */
export async function deleting(client: HostClient, ref: string): Promise<Dropping> {
  const d = await dropping(client, ref);
  const at = d.workspace.place;
  if (at === undefined) return d;
  // Null where the list could not be read: the computer is then named without its name, never by the machine's id.
  const place = await client.request<{ places: PlaceView[] }>("places.list").then(
    ({ places }) => places.find(p => p.id === at),
    () => null,
  );
  // A fork at another provider's account is a cloud machine, whose delete takes its kind's words.
  if (place === undefined || (place !== null && isProviderPlace(place))) return d;
  return { ...d, on: { name: d.workspace.name, computer: place === null ? UNNAMED_COMPUTER : tableName(place) } };
}

/** The one confirmation a forget asks, naming what goes; the first line is the question, the second its hint. */
export function forgetQuestion(f: Dropping): string {
  return `Forget ${f.workspace.name}?\n${forgetNotice(f.threads)}`;
}

/** Drops the workspace from the host's store; the runtime refuses while its machine still exists. */
export async function forget(client: HostClient, f: Dropping): Promise<void> {
  await client.request("workspaces.forget", { workspaceId: f.workspace.id });
}

export function forgotLine(f: Dropping): string {
  return `forgot ${f.workspace.name} ${f.workspace.id}: its record and ${fmtThreads(f.threads)} are gone from this computer`;
}

/** The one confirmation a delete asks, in the words every client shows: what a forget takes, and the machine too. */
export function deleteQuestion(d: Dropping): string {
  return `Delete ${d.workspace.name}?\n${deleteNotice(d.threads, workspaceKind(d.workspace), madeWorktree(d.workspace), d.workspace.machineId, d.on)}`;
}

/** The one confirmation a project image's removal asks: the id, and what goes with it. */
export function imageRemoveQuestion(g: ProjectGolden): string {
  return `Remove project image ${g.snapshotId}?\n${projectImageRemoveNotice(g)}`;
}

/** Kills the workspace's machine at the provider, then drops its record here; a machine already gone is no error. */
export async function deleteWorkspace(client: HostClient, d: Dropping): Promise<void> {
  await client.request("workspaces.delete", { workspaceId: d.workspace.id });
}

export function deletedLine(d: Dropping): string {
  return `deleted ${d.workspace.name} ${d.workspace.id}: ${onDelete(d).done(d.workspace.machineId)}, and its record and ${fmtThreads(d.threads)} are gone from this computer`;
}

/** The most characters a folder cell holds before its front is cut: the end of a path is what a person recognises. */
const FOLDER_WIDTH = 40;

/** The most characters a title cell holds before its end is cut: the opening words are what a person recognises. */
const TITLE_WIDTH = 60;

/** The path within `width` cells, cut at the front behind an ellipsis when it is longer. */
export function shortenedFront(path: string, width: number): string {
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

/** The text within `width` cells, cut at the end before an ellipsis when it is longer. */
export function shortenedEnd(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

export const THREAD_HEAD = ["PROJECT", "FOLDER", "BRANCH", "THREAD", "TASK", "AGENT", "STATE", "BY", "COMPUTER", "TITLE"];

/** A thread's line and one line per subagent of its agent's under it, a step in: a subagent's THREAD and TASK are the
 * two words `wsp stop <thread> --task <task>` takes, and BY is the agent that started it. */
export function threadLines(t: ThreadRow, indent = ""): string[][] {
  const folder = shortenedFront(homeShortened(t.folder, homedir()), FOLDER_WIDTH);
  const own = [t.projectName, folder, t.branch, `${indent}${t.id}`, "", t.harness, threadWordOf(t), t.startedBy, t.computerName, shortenedEnd(t.title, TITLE_WIDTH)];
  const under = (t.subagents ?? []).map(c => [t.projectName, folder, t.branch, `${indent}  ${t.id}`, c.id, t.harness, subagentStateWord(c.state), "agent", t.computerName, shortenedEnd(c.title, TITLE_WIDTH)]);
  return [own, ...under];
}

/** The rows a --tree listing prints: every thread a person or the command line opened, each followed by the ones
 * its agents spawned, indented one step per level. A row whose parent is not in the listing stands at the top
 * rather than vanishing, so a workspace filter never hides a thread. */
export function threadTree(rows: readonly ThreadRow[]): { row: ThreadRow; depth: number }[] {
  const held = new Set(rows.map(r => r.id));
  const parentOf = (row: ThreadRow): string | undefined => (row.parentThreadId !== undefined && held.has(row.parentThreadId) ? row.parentThreadId : undefined);
  const out: { row: ThreadRow; depth: number }[] = [];
  const drawn = new Set<string>();
  const walk = (parent: string | undefined, depth: number): void => {
    for (const row of rows) {
      if (drawn.has(row.id) || parentOf(row) !== parent) continue;
      drawn.add(row.id);
      out.push({ row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // A row whose parents lead round in a circle is under no top row, and a listing prints every row it was given:
  // it stands at the top rather than vanishing, since a thread nobody can see is worse than one drawn flat.
  for (const row of rows) if (!drawn.has(row.id)) out.push({ row, depth: 0 });
  return out;
}

/** What each place this host holds is called, by the id a record names it with: the rows carry the id, and a person
 * reads the name they gave the computer. Asked only when a row names one. */
export async function placeNames(client: HostClient): Promise<Map<string, string>> {
  const { places } = await client.request<{ places: PlaceView[] }>("places.list");
  return new Map(places.map(p => [p.id, tableName(p)]));
}

/** Every project this host holds, as every director draws them. */
export async function projectsOf(client: HostClient): Promise<ProjectView[]> {
  return (await client.request<{ projects: ProjectView[] }>("projects.list")).projects;
}

/** The project a person names, by id or by name; a word naming none is refused with the ones there are. */
export async function projectOf(client: HostClient, ref: string): Promise<ProjectView> {
  return (await client.request<{ project: ProjectView }>("projects.resolve", { ref })).project;
}

/** One project's row: its name, its id, the computer it lives on by the name this wsp holds for it, where its code
 * comes from, where the checkout sits inside a workspace of it, the branch a workspace starts on, and how many
 * workspaces it has. */
export function projectLine(p: ProjectView, workspaces: readonly WorkspaceView[], threadsHeld: readonly ThreadView[], named: ReadonlyMap<string, string>): string[] {
  return [
    p.name,
    p.id,
    computerNamed(p.computer, named, hostPlatform()),
    sourceWord(p.source),
    shortenedFront(p.path, FOLDER_WIDTH),
    p.base ?? "",
    String(threadsHeld.filter(t => workspaces.some(w => w.id === t.workspaceId && w.project.id === p.id)).length),
  ];
}

/** What a road with no project to make a workspace of says, with the road that records one. Exported because the
 * host's own workspace road and the command line both end on it. */
export const NO_PROJECT_YET = "no projects yet; wsp add <folder> records one here, and wsp add <url> --on <computer> records one there";

/** A workspace of one project: the landing is read first, so a computer that forks nothing refuses in one sentence
 * before a stage is streamed, and the image is the computer's own head unless a project image is named. `size`
 * is the --size word; `engine` asks the computer for its container engine through the fenced socket. */
/** The two flags a computer declares about copies, read through the landing of a project standing on it: a row
 * that carries a copy is a row on the computer the host runs on, so its own project is what answers. Asked once
 * per table and only where a row holds a copy, since every other row's cells are empty either way. */
export async function hereCapabilities(client: HostClient, project: string): Promise<Pick<Capabilities, "copies" | "ownNetwork" | "pauseMode">> {
  return (await client.request<{ capabilities: Capabilities }>("workspaces.landing", { project })).capabilities;
}

export async function createFor(
  client: HostClient,
  out: Out,
  project: Pick<ProjectView, "id" | "name" | "computer">,
  name: string,
  asked: { size?: string; agents?: Partial<WorkspaceAgents>; parent?: string } = {},
): Promise<WorkspaceCreateResult> {
  // A folder on this computer forks nothing, so a size has nothing to act on: refused before the landing is read.
  if (copiesFolder(kindForComputer(project.computer)) && asked.size !== undefined) throw usageRefusal(copyTakesNone(project.name, ["--size"]), "Drop them.");
  const capabilities = (await client.request<{ capabilities: Capabilities }>("workspaces.landing", { project: project.id })).capabilities;
  const chosen = asked.size === undefined ? undefined : sizeChosen(capabilities, asked.size);
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "workspace.creating" && (f as unknown as WorkspaceCreatingEvent).name === name,
    f => {
      out.emit(f);
      out.stream(`${(f as unknown as WorkspaceCreatingEvent).message}\n`);
    },
  );
  try {
    const { workspace, notice } = await client.request<{ workspace: WorkspaceOut; notice?: string }>("workspaces.create", {
      project: project.id,
      name,
      ...chosen,
      ...(asked.agents !== undefined ? { agents: asked.agents } : {}),
      ...(asked.parent !== undefined ? { parent: asked.parent } : {}),
    });
    const created: WorkspaceCreateResult = { workspace, ...(notice !== undefined ? { notice } : {}) };
    // The folder this workspace holds the project in: the copy's on this computer, since a person who just had a
    // copy made needs the path it landed at, and the checkout's inside a fork.
    const at = workspace.folder ?? workspace.project.path;
    out.emit(created, `created ${workspace.name} ${workspace.id}, a copy of ${workspace.project.name} at ${at}${notice !== undefined ? `\n${notice}` : ""}`);
    return created;
  } finally {
    pushed.stop();
  }
}

/** The projects a caller may name, as the host's list answers it: every one for a person's terminal, and for a
 * thread its own and its repository's on computers that fork machines. A host from before threads could list
 * projects refuses the list, and a thread there names the projects its own workspaces hold. */
export async function projectsHere(client: HostClient): Promise<Pick<ProjectView, "id" | "name" | "computer">[]> {
  const held = await projectsOf(client).catch(() => undefined);
  if (held !== undefined) return held;
  const byId = new Map<string, Pick<ProjectView, "id" | "name" | "computer">>();
  for (const w of await workspaces(client)) if (w.project !== undefined) byId.set(w.project.id, { id: w.project.id, name: w.project.name, computer: w.project.computer });
  return [...byId.values()];
}

/** What a --spawn line and its caps ask for, the one reading of them: nothing when none was named, so a workspace
 * made without them takes the default, and a cap named alone tightens the switch as it stands, on or off. */
export function agentsAsked(spawn: string | boolean | undefined, maxMachines?: string | number, maxDepth?: string | number, computer?: string): Partial<WorkspaceAgents> | undefined {
  const on = typeof spawn === "string" ? onOffWord(spawn, computer) : spawn;
  const machines = maxMachines === undefined ? undefined : countAsked("--max-machines", maxMachines, 0, computer);
  // One level is the least a switch that is on can mean; none of them is what --spawn off already says.
  const depth = maxDepth === undefined ? undefined : countAsked("--max-depth", maxDepth, 1, computer);
  if (on === undefined && machines === undefined && depth === undefined) return undefined;
  return { ...(on !== undefined ? { spawn: on } : {}), ...(machines !== undefined ? { maxMachines: machines } : {}), ...(depth !== undefined ? { maxDepth: depth } : {}) };
}

function onOffWord(word: string, computer?: string): boolean {
  if (word === "on") return true;
  if (word === "off") return false;
  throw usageRefusal(`${flagFor("--spawn", computer)} takes on or off, and got ${JSON.stringify(word)}.`, "Write --spawn on or --spawn off.");
}

export function countAsked(flagName: string, word: string | number, least: number, computer?: string): number {
  const n = Number(word);
  if (!Number.isInteger(n) || n < least) throw usageRefusal(`${flagFor(flagName, computer)} takes a whole number of ${least === 0 ? "zero" : "one"} or more, and got ${JSON.stringify(String(word))}.`, `Write it as ${flagName} <n>.`);
  return n;
}

/** The size a --size word names, read but not checked: on a joined computer what is on offer is that computer's to
 * say, and the host refuses a size it does not offer with the same sentence this one would have. */
/** The size a --size word names, checked against what the host's provider offers before anything is minted. */
function sizeChosen(capabilities: Capabilities, word: string): WorkspaceSize {
  const size = sizeFromWord(word);
  if (size === undefined || !offeredSize(capabilities.sizes, size)) throw usageRefusal(sizeRefusal(word, capabilities.sizes), "Name one of those with --size.");
  return size;
}

/** The project image a snapshot id names, and nothing else: a remove never picks one by a project's name. */
export async function projectImageOf(client: HostClient, id: string): Promise<ProjectGolden> {
  const { projectGoldens } = await client.request<{ projectGoldens: ProjectGolden[] }>("projectGoldens.list");
  const golden = projectGoldens.find(g => g.snapshotId === id);
  if (golden === undefined) throw notFoundRefusal(noProjectImageLine(id));
  return golden;
}

export async function removeProjectImage(client: HostClient, id: string): Promise<ProjectGoldenRemoved> {
  return ProjectGoldenRemoved.parse(await client.request("projectGoldens.remove", { snapshotId: id }));
}

/** Sets what the agents on the workspace a person names may ask of this host; the record, as every director shows it. */
export async function setAgents(client: HostClient, ref: string, agents: Partial<WorkspaceAgents>): Promise<WorkspaceOut> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ workspace: WorkspaceOut }>("workspaces.agents", { workspaceId: source.id, ...agents })).workspace;
}

/** Snapshots the workspace a person names as a project golden; the record, as every director shows it. */
export async function snapshot(client: HostClient, ref: string): Promise<ProjectGolden> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ projectGolden: ProjectGolden }>("workspaces.snapshot", { workspaceId: source.id })).projectGolden;
}

export function projectGoldenLine(g: ProjectGolden): string {
  const version = g.version !== undefined ? `image v${g.version}` : `image ${g.golden}`;
  const carried = g.projects.map(p => `${p.name} imported ${p.importedAt.slice(0, 10)}`).join(", ");
  return `project image ${g.snapshotId}: ${version} plus ${carried}, taken from ${g.workspaceName}`;
}

/** The words a person gave beside the address, read once for the command line and the tool alike: a port that is a
 * number, a key that is a path on this computer, and the name they chose for the workspace. */
export function sshAsked(name?: string, port?: string, keyPath?: string): SshAsked {
  const dialled = port === undefined ? undefined : Number(port);
  if (dialled !== undefined && (!Number.isInteger(dialled) || dialled < 1 || dialled > 65535)) throw usageRefusal(`--ssh-port takes a port, and got ${JSON.stringify(port)}.`, "A port is a whole number from 1 to 65535.");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(dialled !== undefined ? { port: dialled } : {}),
    ...(keyPath !== undefined ? { keyPath: absolutePath("--ssh-key is a path on this computer", keyPath) } : {}),
  };
}

/** The line every recorded machine is announced with: its kind's own word for what the machine is, and under it
 * anything the one dial that recorded it has to say (the key a machine over ssh answered with). */
function createdExisting(out: Out, workspace: WorkspaceView, notice?: string): WorkspaceCreateResult {
  const created: WorkspaceCreateResult = { workspace, ...(notice !== undefined ? { notice } : {}) };
  out.emit(created, `created ${workspace.name} ${workspace.id} (${machineWord(workspaceKind(workspace))})${notice !== undefined ? `\n${notice}` : ""}`);
  return created;
}

/** The branch a folder on this computer has checked out, read off its HEAD file: nothing where the folder is not
 * here, holds no repo, or stands on no branch. */
function branchHere(folder: string): string | undefined {
  const root = gitRootOf(folder);
  if (root === undefined) return undefined;
  try {
    const dotGit = join(root, ".git");
    const gitDir = statSync(dotGit).isDirectory() ? dotGit : resolve(root, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
    return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}
