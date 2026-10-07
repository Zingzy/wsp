// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { agentName } from "@wsp/catalog";
import {
  AccessChoice,
  accessWordRefusal,
  pickRefusal,
  AFTER_CUT_LINE,
  EMPTY_MESSAGE_LINE,
  NOT_DELIVERED_LINE,
  fmtDuration,
  NOTIFY_ME,
  SessionStartOutcome,
  SessionStartResult,
  type SessionSteerEvent,
  type SessionStartingEvent,
  agentStartingLine,
  ThreadMessage,
  ThreadHead,
  ThreadView,
  TurnStatus,
  WorkspaceOut,
  WorkspaceView,
  authRefusal,
  guestNamesWorkspaceLine,
  guestNoFileLine,
  attachmentLine,
  imageTypeOf,
  filesRefusal,
  noAdapterLine,
  noMessagesLine,
  noReplyLine,
  needsYouLine,
  openAsk,
  askingLine,
  type PermissionEffect,
  type PermissionOption,
  ANSWER_WORDS,
  SessionAnswerResult,
  type SessionPermissionEvent,
  notAFileLine,
  startPicks,
  threadMessages,
  threadReplyRows,
  threadReadText,
  threadResult,
  threadStateWord,
  compactedLine,
  toolActivityLine,
  toolAnsweredLine,
  turnSettledLine,
  turnTokenOf,
  usageRefusal,
  type HarnessCatalog,
  type Attachment,
  type StartPicks,
  UNTYPED_FILE,
  type SessionEvent,
  type SessionOrigin,
  type SessionView,
  type TurnRefusal,
  type TurnResult,
  Preferences,
  homeShortened,
  BRANCH_HERE_ONLY_LINE,
  HOST_TOKEN_ENV,
  WorktreeMade,
  noThreadTargetLine,
  threadOpenedLine,
  threadWord,
  ProjectView,
  copiesFolder,
  kindForComputer,
  isLocalWorkspace,
  threadOnMachineLine,
} from "@wsp/protocol";
import { mainWorktreeOf } from "../repo-root.js";
import { SERVICE_WAIT_MS } from "../host-lock.js";
import { type Frame, type HostClient, stoppedUnder, HOST_RESTARTING_LINE, hostBack, untilSettled, pushedFrames, type Flags, type VerbDeps, type VerbContext, PICK_FLAGS, flag, absoluteFolder, accessWordOf, under, otherVersion, threadIdOf, openedThreadSaid } from "./client.js";
import { workspaces, threads, workspaceOf, threadOf, projectsOf, projectOf, projectsHere } from "./workspaces-help.js";
import type { TurnOut } from "./io.js";

const sessionEvent = (f: Frame): f is Frame & SessionEvent => typeof f.type === "string" && f.type.startsWith("session.");

/** A turn as a director sees it: the thread it opened or resumed, how the start went (its own turn, or the thread's
 * running one that took the message, or one that waited behind it), the harness's result once it ended, and the
 * runtime's reason when the runtime ended it. */
export interface Turn {
  session: SessionView;
  threadId: string;
  outcome: SessionStartOutcome;
  result?: TurnResult;
  reason?: string;
  /** The thread's previous turn ended without a result, as the turn's session.start said. */
  afterCut?: true;
}

/** The model, effort and access a start names: the model and effort as the composer's pickers name them, which the
 * runtime checks against the harness's catalog, and the access in wsp's own word, which the agent's row maps. */
export type Picks = Partial<Record<(typeof PICK_FLAGS)[number], string>> & { fast?: boolean };

/** The picks as sessions.start carries them: the fields the app's composer sends, absent ones left out. */
export function picksOf(picks: Picks): Omit<StartPicks, "permissionMode"> & { access?: AccessChoice } {
  return {
    ...(picks.model !== undefined ? { model: picks.model } : {}),
    ...(picks.effort !== undefined ? { effort: picks.effort } : {}),
    ...(picks.access !== undefined ? { access: accessWordOf(picks.access) } : {}),
    ...(picks.fast === true ? { fast: true } : {}),
  };
}

/** The head every image type is told apart by; the longest of the four is twelve bytes. */
const IMAGE_HEAD_BYTES = 12;

/**
 * The files a `--file` flag or an MCP `files` list names, read off this computer's disk and carried as bytes, so
 * nothing on the machine ever reaches back for the person's filesystem. An image is told by its own first bytes,
 * never by its name, and travels as one; any other file travels under its own name. The caps are checked against
 * what the files weigh before any of them is read whole, so naming a video does not pull it into memory to refuse it.
 */
export function filesFrom(paths: readonly string[], elsewhere = false): Attachment[] {
  // Before a path is resolved, let alone opened: a caller on a machine would otherwise learn from the refusals
  // which paths exist on the person's disk, and a file that does exist would be read and sent.
  if (elsewhere && paths.length > 0) throw usageRefusal(guestNoFileLine, "Name a file on the machine the line runs on, or none.");
  const files = paths.map(given => {
    const path = resolve(given);
    // A path this computer has nothing at, or has something other than a file at, answers in a sentence; the reader's
    // own ENOENT is what a person fat-fingering a screenshot path would otherwise get.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) throw usageRefusal(notAFileLine(given), "Name a file that is already here.");
    const head = Buffer.alloc(IMAGE_HEAD_BYTES);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, IMAGE_HEAD_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    return { path, mediaType: imageTypeOf(head) ?? UNTYPED_FILE, name: basename(path), bytes: stat.size };
  });
  const refusal = filesRefusal(files);
  if (refusal !== null) throw usageRefusal(`${refusal}.`, "Drop that one and send the rest.");
  return files.map(f => ({ mediaType: f.mediaType, name: f.name, bytes: readFileSync(f.path).toString("base64") }));
}

/** The pick flags as given on the command line, --fast among them on the verbs that take it. */
export function pickFlags(flags: Flags): Picks {
  return { ...Object.fromEntries(PICK_FLAGS.map(name => [name, flag(flags, name)])), ...(flags["fast"] === true ? { fast: true } : {}) };
}

/** Refuses, in the runtime's own words and before a machine is minted or woken for it, what the runtime would refuse
 * once the machine was there: an empty task or message, an agent the host has no adapter for, a pick the agent's
 * catalog does not list. Named a workspace, this asks that workspace's own machine, the same lists the app's composer
 * shows and the start itself will check against, so a model only that machine's config knows (a provider the agent is
 * routed to) is not refused here for being absent from a table. On a workspace that is not running the table answers,
 * and the start on the machine checks the rest. A start on this computer mints and wakes nothing, so its picks are
 * left to the start, which reads them against the agent's own lists here before it makes a folder. */
export async function checkedStart(client: HostClient, task: string, harness: string | undefined, picks: Picks, workspaceId?: string): Promise<void> {
  if (task.trim() === "") throw usageRefusal(EMPTY_MESSAGE_LINE, "Put it in quotes after the flags.");
  const { harnesses } = await client.request<{ harnesses: HarnessCatalog[] }>("harnesses.list", workspaceId === undefined ? undefined : { workspaceId });
  const table = harnesses.find(c => (harness === undefined ? c.isDefault === true : c.harness === harness));
  if (table === undefined && harness !== undefined) {
    // An agent the host runs that is off on this workspace's computer is the start's to refuse, naming that computer.
    const all = workspaceId === undefined ? harnesses : (await client.request<{ harnesses: HarnessCatalog[] }>("harnesses.list")).harnesses;
    if (all.some(c => c.harness === harness)) return;
    throw usageRefusal(noAdapterLine(harness, all.map(c => c.harness)), "Name one of those with --agent.");
  }
  if (workspaceId === undefined) return;
  const asked = picksOf(picks);
  try {
    startPicks(table, asked, true);
  } catch (e) {
    throw pickRefusal(e, table);
  }
  const refused = asked.access === undefined || table === undefined ? null : accessWordRefusal(table, asked.access);
  if (refused !== null) throw refused;
}

/** The person's view preferences as the host keeps them: the last project per workspace and the last target. */
export async function preferencesOf(client: HostClient): Promise<Preferences> {
  return Preferences.parse((await client.request<{ preferences: unknown }>("preferences.get")).preferences);
}

/** A thread on this computer as a start names it: the project, else the thread asking, and the branch or the folder
 * inside it; the host finds or makes the folder's record. */
export interface FolderTarget {
  here: { project?: Pick<ProjectView, "id" | "name" | "path">; branch?: string; cwd?: string };
  opened: (threadId: string, folder?: string) => string;
}

/** Where a run goes: the project named when it is on this computer, else the box machine the word names, which goes
 * on as before; with no word, beside the thread asking, or the project whose folder, or a worktree of whose repo,
 * the caller's own folder is in. */
export async function runTarget(
  client: HostClient,
  ref: string | undefined,
  callerCwd: string | undefined,
  env: VerbDeps["env"],
  elsewhere: boolean | undefined,
  where: { branch?: string | undefined; cwd?: string | undefined },
): Promise<FolderTarget | { workspace: WorkspaceOut; opened?: (threadId: string, folder?: string) => string }> {
  const asked = { ...(where.branch !== undefined ? { branch: where.branch } : {}), ...(where.cwd !== undefined ? { cwd: where.cwd } : {}) };
  const said = (name: string | undefined) => (threadId: string, folder?: string): string =>
    folder === undefined ? `thread ${threadId}` : threadOpenedLine(threadId, name, homeShortened(folder, homedir()));
  if (ref !== undefined) {
    const project = ((await projectsHere(client).catch(() => undefined)) ?? []).find(p => p.id === ref || p.name === ref);
    if (project !== undefined && copiesFolder(kindForComputer(project.computer))) {
      const full = await projectOf(client, project.id).catch(() => undefined);
      return { here: { project: { id: project.id, name: project.name, path: full?.path ?? "" }, ...asked }, opened: said(project.name) };
    }
    if (where.branch !== undefined) throw usageRefusal(BRANCH_HERE_ONLY_LINE, "Name a project on this computer.");
    return { workspace: await workspaceOf(client, ref) };
  }
  // A line out of a thread carries the thread's own token, and with no project named it runs beside that thread.
  const fromThread = turnTokenOf(env) !== undefined || (env[HOST_TOKEN_ENV] ?? "") !== "";
  if (fromThread && elsewhere !== true) return { here: asked, opened: said(undefined) };
  if (elsewhere === true) throw usageRefusal(guestNamesWorkspaceLine, "Name the workspace on the line.");
  const project = callerCwd === undefined ? undefined : projectOfFolder(await projectsOf(client).catch(() => []), callerCwd);
  if (project === undefined) throw usageRefusal(noThreadTargetLine("<project>"), "Run wsp projects to read the names.");
  const inside = callerCwd !== undefined && !under(callerCwd, project.path);
  return { here: { project, ...asked, ...(inside && where.cwd === undefined && where.branch === undefined ? { cwd: callerCwd } : {}) }, opened: said(project.name) };
}

/** The project on this computer a folder is in: the one whose folder holds it, the deepest where two do, else the one
 * whose repo the folder is a worktree of. */
function projectOfFolder(projects: readonly ProjectView[], folder: string): ProjectView | undefined {
  const here = projects.filter(p => copiesFolder(kindForComputer(p.computer)));
  const holding = here.filter(p => under(folder, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (holding !== undefined) return holding;
  const main = mainWorktreeOf(folder);
  return main === undefined ? undefined : here.find(p => p.git?.top === main);
}

/** A thread on this computer a word names, with the worktree wsp made that it runs in; nothing where the word names
 * no thread, or one on a box, which a workspace delete takes. */
export async function threadHere(client: HostClient, ref: string): Promise<{ id: string; workspaceId: string; worktree?: string } | undefined> {
  const thread = await threadOf(client, ref).catch(() => undefined);
  if (thread === undefined) return undefined;
  const at = (await workspaces(client)).find(w => w.id === thread.workspaceId);
  if (at === undefined || !isLocalWorkspace(at)) return undefined;
  return { id: threadIdOf(thread), workspaceId: at.id, ...(at.worktree?.made === true && at.worktree.gone !== true ? { worktree: at.worktree.path } : {}) };
}

/** Refuses a thread on a box's machine, which goes with its machine, in the runtime's own words; nothing for any
 * other ref, so the caller's own refusal stands. */
export async function refuseMachineThread(client: HostClient, ref: string): Promise<void> {
  const thread = await threadOf(client, ref).catch(() => undefined);
  if (thread === undefined) return;
  const at = (await workspaces(client)).find(w => w.id === thread.workspaceId);
  if (at !== undefined && !isLocalWorkspace(at)) throw Object.assign(new Error(threadOnMachineLine(at.name)), { kind: "usage" });
}

/** What the host took with a thread it deleted: the record's id, the worktree that went with it, and how many threads. */
export async function threadDeleted(client: HostClient, threadId: string): Promise<{ workspaceId: string; worktree?: string; threads: number }> {
  const { workspaceId, worktree, threads } = await client.request<{ workspaceId: string; worktree?: string; threads: number }>("sessions.delete", { threadId });
  return { workspaceId, ...(worktree !== undefined ? { worktree } : {}), threads };
}

/** The worktree holding a branch of a project here, as the host answers it. */
export async function worktreeFor(client: HostClient, project: string, branch: string): Promise<WorktreeMade> {
  return WorktreeMade.parse(await client.request("worktree.make", { project, branch }));
}

/** The start that opens a new thread in a workspace, under the named agent or the runtime's default, in the folder
 * or the project named; both go to the host as given, since the folder a thread starts in when neither is named is
 * the runtime's one rule, the same one the app's composer reads. notify names who every turn's end on it is told,
 * each a thread or NOTIFY_ME. The one place both doors, the command line and the MCP server, put the token of the
 * turn they are running inside on a start: it is what the host reads NOTIFY_ME against, and there is none when the
 * caller is not a turn; the environment it is read off is the caller's, handed in, never this process's. */
export function openingOf(env: VerbDeps["env"], at: Pick<WorkspaceView, "id"> | FolderTarget, prompt: string, opts: Picks & { harness?: string; cwd?: string; notify?: readonly string[]; title?: string; files?: readonly string[]; elsewhere?: boolean } = {}): Record<string, unknown> {
  const cwd = absoluteFolder("here" in at ? at.here.cwd : opts.cwd);
  const attachments = filesFrom(opts.files ?? [], opts.elsewhere);
  const turnToken = turnTokenOf(env);
  return {
    ...("here" in at
      ? { ...(at.here.project !== undefined ? { project: at.here.project.id } : {}), ...(at.here.branch !== undefined ? { branch: at.here.branch } : {}) }
      : { workspaceId: at.id }),
    prompt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
    ...(turnToken !== undefined ? { turnToken } : {}),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...picksOf(opts),
  };
}

/** What the --notify flags name for the runtime: NOTIFY_ME as given, and every other reference as the thread it
 * picks, by its full id. Nothing when the caller named none, so the thread keeps whatever it already had. */
export async function notifyOf(client: HostClient, refs: readonly string[]): Promise<string[] | undefined> {
  if (refs.length === 0) return undefined;
  const named: string[] = [];
  for (const ref of refs) {
    if (ref === NOTIFY_ME) named.push(NOTIFY_ME);
    else {
      const thread = await threadOf(client, ref);
      named.push(thread.threadId ?? thread.id);
    }
  }
  return named;
}

/** The start a message to an existing thread makes: the thread named to the runtime, which resumes its latest turn
 * or, on a thread whose harness never announced a session, runs the message as its first turn; under the thread's own
 * agent, with any pick named for this turn. */
export function messageTo(thread: ThreadView, prompt: string, picks: Picks = {}, files: readonly string[] = [], elsewhere = false): Record<string, unknown> {
  const attachments = filesFrom(files, elsewhere);
  return { workspaceId: thread.workspaceId, prompt, harness: thread.harness, thread: thread.threadId ?? thread.id, ...(attachments.length > 0 ? { attachments } : {}), ...picksOf(picks) };
}
const OTHER_VERSION = otherVersion("sessions.start");

/** What the runtime pushes about a start before it answers it: the wait behind the thread's running turn, and the
 * moment the harness took a message into that turn. Both are minted by this start's own request id, so a view with
 * the same text in flight cannot hand this one another start's news. */
interface StartNews {
  queued?(): void;
  /** Fires when the start has waited on its agent long enough to say the agent is starting. */
  starting?(event: SessionStartingEvent): void;
  /** Fires when the runtime records the steer, which is the moment the harness took the message; it carries what
   * that turn was doing then, which the start's own reply does not. */
  steered?(event: SessionSteerEvent): void;
}

/** Starts a turn as `startedBy` and answers with it the moment the runtime names it: what a detached start returns
 * and what a follow goes on from. The send carries its own request id so an app view with the same text in flight
 * cannot take this turn's start for its own, and so each notice is known to be this start's. */
async function begin(client: HostClient, start: Sent, startedBy: SessionOrigin, news: StartNews = {}): Promise<{ turn: Turn; turnId: string }> {
  await client.events();
  const { requestId, ...asked } = start;
  const offNews = client.onFrame(f => {
    if (f["requestId"] !== requestId) return;
    if (f.type === "session.queued") news.queued?.();
    if (f.type === "session.steer") news.steered?.(f as unknown as SessionSteerEvent);
  });
  // The start is answered once its launch is handed over, which is before the agent's session starts, and the wait
  // the starting line is about can be that launch: it is heard until it comes, the session starts, the message steers
  // a running turn instead, or the turn ends without a start.
  let turnOf: string | undefined;
  const offStarting = client.onFrame(f => {
    if (f.type === "session.end" && turnOf !== undefined && f["turnId"] === turnOf) return offStarting();
    if (f["requestId"] !== requestId) return;
    if (f.type === "session.starting") news.starting?.(f as unknown as SessionStartingEvent);
    if (f.type === "session.starting" || f.type === "session.start" || f.type === "session.steer") offStarting();
  });
  let answer: Record<string, unknown>;
  try {
    answer = await client.request("sessions.start", { ...asked, startedBy, requestId });
  } catch (e) {
    offStarting();
    throw e;
  } finally {
    offNews();
  }
  const reply = SessionStartResult.safeParse(answer);
  if (!reply.success) {
    offStarting();
    throw new Error(OTHER_VERSION);
  }
  const { session, outcome, turnId } = reply.data;
  turnOf = turnId;
  if (outcome === "steered") offStarting();
  const threadId = session.threadId;
  if (threadId === undefined) throw new Error("the runtime stamped no thread on the session");
  return { turn: { session, threadId, outcome }, turnId };
}

/** A start as it goes out: with the request id its every send carries, so the host that answers it, or a host that
 * comes back after one stopped under it, can tell this message from any other with the same words. */
type Sent = Record<string, unknown> & { requestId: string };

const sent = (start: Record<string, unknown>): Sent => ({ ...start, requestId: randomUUID() });

/** The socket to send a start again on, after `failed` ended the try before the host answered it: a host that stopped
 * under it is dialled again, and the host that comes back knows the start by its request id and answers with the turn
 * it already opened where it took the message, so whether a message landed is the host's to say. Any other failure is
 * the start's own, and a host that did not come back in time, or no road back, is a message nobody took: the line says
 * so rather than that a turn goes on. */
async function redialUnanswered(failed: unknown, socket: HostClient, redial: (() => Promise<HostClient>) | undefined, redialed?: () => void): Promise<HostClient> {
  if (!(await stoppedUnder(socket))) throw failed;
  if (redial === undefined) throw new Error(NOT_DELIVERED_LINE);
  redialed?.();
  return redial().catch(() => {
    throw new Error(NOT_DELIVERED_LINE);
  });
}

/** A start whose caller does not stay for the reply: the turn runs on, and a wait on the thread or its notify
 * carries the end. Answers once the turn is started, so a start queued behind the thread's running turn answers
 * when that turn has ended and this one began. A host that stops before it answers is dialled again through
 * `redial`, and the same start goes to the host that comes back. */
export async function startDetached(client: HostClient, start: Record<string, unknown>, startedBy: SessionOrigin, onQueued?: () => void, redial?: () => Promise<HostClient>): Promise<Turn> {
  const going = sent(start);
  let socket = client;
  for (;;) {
    try {
      return (await begin(socket, going, startedBy, onQueued === undefined ? {} : { queued: onQueued })).turn;
    } catch (e) {
      socket = await redialUnanswered(e, socket, redial);
    }
  }
}

/** Starts a turn as `startedBy` and follows it to its reply: `on.queued` when the runtime says the start waits behind
 * the thread's running turn, `on.started` the thread as soon as the runtime names it, `on.event` every event of the
 * turn with the turn so far. Events are picked by the turn's id: a start that waited behind the thread's running
 * turn must not read that turn's end as its own. The follow ends at session.done, which carries the whole reply:
 * session.end follows the runtime's exit read and reap, minutes later when the machine is slow to answer. A turn the
 * runtime ended itself has no done, so its end is the last event instead. A host that stops under the follow once
 * the turn is named is dialled again through `redial`, `on.redialed` says so, and the follow goes on from the new
 * host, which re-opens the run: an end the transcript already holds is read off it, and the rest arrive as they
 * come. A host that stops before it answers the start is dialled again the same way and sent the same start, which
 * it answers with the turn it opened where it took it; none back in time is a message not delivered. Fails when the
 * host goes away any other way. */
export async function follow(
  client: HostClient,
  start: Record<string, unknown>,
  startedBy: SessionOrigin,
  on: { queued?(): void; starting?(event: SessionStartingEvent): void; steered?(event: SessionSteerEvent): void; started?(turn: Turn): void; redialed?(): void; event(e: SessionEvent, turn: Turn): void },
  redial?: () => Promise<HostClient>,
): Promise<Turn> {
  const going = sent(start);
  let named: { turn: Turn; turnId: string } | undefined;
  let over = false;
  const take = (f: Frame, turn: Turn): void => {
    if (over) return;
    const e = f as unknown as SessionEvent;
    if (e.type === "session.start" && e.afterCut === true) turn.afterCut = true;
    if (e.type === "session.done") turn.result = e.result;
    if (e.type === "session.end" && e.reason !== undefined) turn.reason = e.reason;
    on.event(e, turn);
    over = e.type === "session.done" || e.type === "session.end";
  };
  let socket = client;
  for (;;) {
    const pushed = pushedFrames(socket);
    try {
      if (named === undefined) {
        named = await begin(socket, going, startedBy, { ...(on.queued !== undefined ? { queued: on.queued } : {}), ...(on.starting !== undefined ? { starting: on.starting } : {}), ...(on.steered !== undefined ? { steered: on.steered } : {}) });
        on.started?.(named.turn);
      } else await socket.events();
      const { turn, turnId } = named;
      const ended = new Promise<Turn>(done => {
        pushed.follow(
          f => sessionEvent(f) && f.turnId === turnId,
          f => {
            take(f, turn);
            if (over) done(turn);
          },
        );
      });
      if (socket !== client) {
        for (const e of await history(socket, turn.session.workspaceId)) {
          if (e.turnId === turnId && (e.type === "session.done" || e.type === "session.end")) take(e as unknown as Frame, turn);
        }
        if (over) return turn;
      }
      return await untilSettled(socket, ended);
    } catch (e) {
      if (named === undefined) {
        socket = await redialUnanswered(e, socket, redial, on.redialed);
        continue;
      }
      if (redial === undefined || named === undefined || !(await stoppedUnder(socket))) throw e;
      on.redialed?.();
      socket = await redial();
    } finally {
      pushed.stop();
    }
  }
}

/** The first of the named threads to leave running, as `firstEnded` answers it, dialled through a host that stops
 * under the wait: the threads went on without it, so the question is asked again of the host that comes back. A
 * deadline that passes while that host is still coming back is the deadline's answer, as it is anywhere else. */
export async function waitThrough(deps: Pick<VerbDeps, "client" | "hostWaitMs">, named: readonly ThreadView[], timeoutMs?: number, redialed?: () => void): Promise<Waited> {
  const until = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const left = (): number | undefined => (until === undefined ? undefined : Math.max(0, until - Date.now()));
  let client = await deps.client();
  for (;;) {
    try {
      const waited = await firstEnded(client, named, left());
      return "timedOutMs" in waited ? { timedOutMs: timeoutMs! } : waited;
    } catch (e) {
      if (!(await stoppedUnder(client))) throw e;
      redialed?.();
      const hostWait = deps.hostWaitMs ?? SERVICE_WAIT_MS;
      try {
        client = await hostBack(deps, Math.min(hostWait, left() ?? hostWait));
      } catch (refused) {
        if (timeoutMs !== undefined && left() === 0) return { timedOutMs: timeoutMs };
        throw refused;
      }
    }
  }
}

/** What a restart that the host answered and never acted on says: the host is still the one that was asked. */
export const hostDidNotStopLine = (waitMs: number): string => `the host took the restart and was still serving after ${fmtDuration(waitMs)}`;

/** What a restart says once the host that replaced the old one serves: the threads still running on it, which went
 * on across the restart and which that host re-opened. */
export const hostRestartedLine = (running: readonly string[]): string =>
  `the host restarted and serves again; ${running.length === 0 ? "no thread is running on it" : `${running.length === 1 ? "1 thread is" : `${running.length} threads are`} still running on it: ${running.map(id => id.slice(0, 8)).join(", ")}`}`;

/** Has the host restart on the road it came up on and answers, once the host that replaced it serves, with the
 * threads running there. The host answers the ask before it closes, so the close after the answer is the restart
 * under way; a road that would not bring it back refuses the ask in its own words, before anything stops. */
export async function restartHost(deps: Pick<VerbDeps, "client" | "hostWaitMs">): Promise<{ running: string[] }> {
  const client = await deps.client();
  await client.request("host.restart");
  let timer: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([client.closed.then(() => true), new Promise<false>(done => (timer = setTimeout(() => done(false), SERVICE_WAIT_MS)))]);
  clearTimeout(timer);
  if (!stopped) throw new Error(hostDidNotStopLine(SERVICE_WAIT_MS));
  const back = await hostBack(deps);
  return { running: (await threads(back)).filter(t => t.status === "running").map(threadIdOf) };
}

/** A thread's turn as it ended, for whoever waited on it: the thread and the runtime's result for the turn. */
export interface Ended {
  threadId: string;
  result: TurnResult;
}

/** What a wait came to: the thread that left running, or the deadline that passed first. */
export type Waited = { ended: Ended } | { timedOutMs: number };

/** The thread's latest turn as its transcript ended it, by the protocol's one reading of a transcript; a thread the
 * transcript holds no turn of answers with `ended`, what the end that woke this wait carried. A turn the runtime
 * gave up before it opened is the case with no rows behind it: it never wrote any, since it never ran, and the
 * reason it did not is on that end and nowhere else. */
async function endedOf(client: HostClient, workspaceId: string, threadId: string, ended: TurnResult): Promise<Ended> {
  return { threadId, result: threadResult(await history(client, workspaceId), threadId) ?? ended };
}

/** The workspace's transcript as the host holds it, the rows every read and every wait folds. */
async function history(client: HostClient, workspaceId: string): Promise<SessionEvent[]> {
  return (await client.request<{ events: SessionEvent[] }>("sessions.history", { workspaceId })).events;
}

/** A thread's messages as the app lists them, or its final reply alone: the transcript is the host's, so nothing is
 * woken for a read and a napping machine reads the same as a running one. */
export async function readThread(client: HostClient, thread: ThreadView, last: boolean): Promise<{ threadId: string; messages: ThreadMessage[] }> {
  const threadId = threadIdOf(thread);
  const events = await history(client, thread.workspaceId);
  // A read is a showing, as a window's is: the stamp moves, so the thread stops reading Done here and in every window.
  await client.request("sessions.read", { threadId: thread.id });
  return { threadId, messages: last ? threadReplyRows(events, threadId) : threadMessages(events, threadId) };
}

/** What a read prints when the transcript holds nothing to print: which of the two silences it is. */
export const readLine = (read: { threadId: string; messages: readonly ThreadMessage[] }, last: boolean): string =>
  read.messages.length === 0 ? (last ? noReplyLine(read.threadId) : noMessagesLine(read.threadId)) : threadReadText(read.messages);

/** A thread's head as the host answers it, by its fold key, its facts and events passed on as the host wrote them. */
export const threadHead = async (client: HostClient, thread: ThreadView): Promise<ThreadHead> => {
  const { facts, events, pos, total } = await client.request<ThreadHead>("sessions.head", { threadId: thread.id });
  return { facts, events, pos, total };
};

/** What a head prints: the title, what the thread runs on and where it stands, how much of it the head carries, and
 * those newest events as a read lists them. */
export const headLine = (head: ThreadHead): string => {
  const f = head.facts;
  const runs = [f.model === undefined ? f.harness : `${f.harness} on ${f.model}`, ...(f.permissionMode !== undefined ? [f.permissionMode] : []), f.status].join(", ");
  const rows = threadMessages(head.events, f.threadId ?? f.id);
  return [f.title, runs, ...(f.cwd !== undefined ? [f.cwd] : []), `the newest ${head.events.length} of ${head.total} events`, ...(rows.length > 0 ? ["", threadReadText(rows)] : [])].join("\n");
};

/** Blocks until one of the named threads leaves running and answers with that thread's end: at once for one already
 * over, else on the first done or end the host pushes for any of them; the deadline when `timeoutMs` passes first.
 * The rows are listed after the subscription, so an end between the two is a held frame and not a gap. A named
 * thread the listing no longer holds is over too: its only turn was given up before it opened, between the naming
 * and this call, and its end went out before the subscription, so it is answered failed off what the transcript
 * holds of it, which is nothing but the status. A done carries its result; an end without one in hand is read off
 * the transcript, since the reply may have landed before this call. Fails when the host goes away first. */
export async function firstEnded(client: HostClient, named: readonly ThreadView[], timeoutMs?: number): Promise<Waited> {
  const pushed = pushedFrames(client);
  let timer: NodeJS.Timeout | undefined;
  try {
    await client.events();
    const rows = await threads(client);
    const gone = named.find(t => rows.every(r => threadIdOf(r) !== threadIdOf(t)));
    if (gone !== undefined) return { ended: await endedOf(client, gone.workspaceId, threadIdOf(gone), { status: "failed" }) };
    const over = named.map(t => rows.find(r => r.id === t.id)).find((r): r is ThreadView & { status: TurnStatus } => r !== undefined && r.status !== "running");
    if (over !== undefined) return { ended: await endedOf(client, over.workspaceId, threadIdOf(over), { status: over.status }) };
    const ids = new Set(named.map(threadIdOf));
    const ended = new Promise<Waited>(done => {
      pushed.follow(
        f => sessionEvent(f) && (f.type === "session.done" || f.type === "session.end") && f.threadId !== undefined && ids.has(f.threadId),
        f => {
          const e = f as unknown as SessionEvent & { threadId: string };
          pushed.stop();
          if (e.type === "session.done") done({ ended: { threadId: e.threadId, result: e.result } });
          else done(endedOf(client, e.workspaceId, e.threadId, { status: "failed", ...(e.type === "session.end" && e.reason !== undefined ? { error: e.reason } : {}) }).then(ended => ({ ended })));
        },
      );
    });
    const deadline = new Promise<Waited>(settle => {
      if (timeoutMs !== undefined) timer = setTimeout(() => settle({ timedOutMs: timeoutMs }), timeoutMs);
    });
    return await untilSettled(client, Promise.race([ended, deadline]));
  } finally {
    clearTimeout(timer);
    pushed.stop();
  }
}

/** Why the turn did not complete, in one line; nothing when it did. */
export function turnFailure(turn: Turn): string | undefined {
  if (turn.result?.status === "completed") return undefined;
  return turn.result?.error ?? turn.reason ?? `turn ${turn.result?.status ?? "ended without a result"}`;
}

/** The refusal each cause an agent named is thrown as, so the exit code and the tool error say which class the
 * failure was: a turn refused for want of a sign-in is the auth class, which already means no key and no sign-in.
 * A cause with no row here takes the provider class every other turn failure takes. Adding a cause is a row. */
const REFUSAL_THROWS: Readonly<Record<TurnRefusal, (message: string) => Error>> = { "sign-in": authRefusal };

/** The turn's failure as the error every door throws for it, classed by what the agent refused it for; nothing when
 * it completed. The class is read off the cause the adapter stamped, never out of the agent's own words. */
export function turnRefusal(turn: Turn): Error | undefined {
  const failure = turnFailure(turn);
  if (failure === undefined) return undefined;
  const cause = turn.result?.refusal;
  const thrown = cause === undefined ? undefined : REFUSAL_THROWS[cause];
  return thrown === undefined ? new Error(failure) : thrown(failure);
}

/** What a send that met a running turn on its thread says on stderr: WAITING when the runtime announces the wait,
 * the rest once it answered. A steered message cannot change the running turn's picks, so the line names the flags
 * it dropped. */
const WAITING = "waiting behind the running turn";
const JOINED: Record<Exclude<SessionStartOutcome, "started">, (picks: Picks) => string> = {
  steered: picks => {
    const dropped = [...PICK_FLAGS.filter(name => picks[name] !== undefined), ...(picks.fast === true ? ["fast"] : [])].map(name => `--${name}`);
    return `joined the running turn${dropped.length === 0 ? "" : `; ${dropped.join(", ")} dropped, it keeps its own model, effort and access`}`;
  },
  queued: () => "queued behind the running turn; it has ended and this turn started",
};

/** What a message that joined a turn stopped on a prompt says under the join: the turn takes it up when the person
 * answers, and nothing before then, which is why the terminal goes quiet. The word is the thread table's own, so
 * the line sends the reader to the row that says the same thing. */
const WAITING_ON_A_PERSON = `the turn is waiting on a permission; wsp threads shows it as ${threadStateWord("waiting")}`;

/** A turn's stderr as a person watching it reads it: the reply's prose as it arrives, and a quiet line of its own
 * for each tool call, for what the call answered and for the turn's own end, so a turn that runs commands for
 * minutes shows work rather than silence. A line that lands mid-sentence breaks the sentence first; nothing is
 * redrawn, since the stream may be a file. The reply is one turn's text written once: `reply` hands the stdout
 * print the finished text only where the stream has not already put it in front of the same person, and closes
 * whatever the stream stopped mid-line on first, so the print under it never lands on the work's last line. */
function turnStream(ctx: VerbContext): { text(t: string, messageId?: string): void; line(l: string): void; says(l: string): void; reply(text: string | undefined): string | undefined } {
  let atLineStart = true;
  let streamedProse = false;
  /** The harness message the prose on the screen is a piece of, and whether prose is what was written last: another
   * message opens its own paragraph, the rule SessionDeltaEvent's messageId carries, and it is a paragraph only
   * where prose would run into prose. A line of the work between them has already parted them. */
  let said: string | undefined;
  let lastWasProse = false;
  const says = (l: string): void => {
    ctx.out.stream(`${atLineStart ? "" : "\n"}${l}\n`);
    atLineStart = true;
    lastWasProse = false;
  };
  return {
    text: (t, messageId) => {
      if (t === "") return;
      if (lastWasProse && said !== undefined && messageId !== undefined && messageId !== said) {
        ctx.out.stream(atLineStart ? "\n" : "\n\n");
        atLineStart = true;
      }
      said = messageId ?? said;
      streamedProse = true;
      lastWasProse = true;
      ctx.out.stream(t);
      atLineStart = t.endsWith("\n");
    },
    line: l => says(ctx.io.muted?.(l) ?? l),
    says,
    reply: text => {
      if (!atLineStart) ctx.out.stream("\n");
      atLineStart = true;
      return streamedProse && ctx.io.sameScreen === true ? undefined : text;
    },
  };
}

/** How a prompt a turn stopped on is answered from a terminal: the key a person types while the turn is watched, and
 * which of the prompt's own options that picks, by what picking it does to the call and never by the option's id,
 * which is the harness's. `does` is what the line under the prompt says typing the key does; a road without it takes
 * the option's own label, since which mode a harness offered is the harness's to say and its words ride the option.
 * `answer` is the road another terminal takes: the verb, its help row and the line printed after that pick; absent
 * where no verb carries the road. One row per answer, so an answer added later is a row here and reaches the keys,
 * the verbs and every line at once. */
export interface AnswerRoad {
  key: string;
  effect: PermissionEffect;
  does?: string;
  /** `reasons` is a road whose verb takes the person's words on what to do instead, as the app's deny does. */
  answer?: { verb: string; about: string; said: string; reasons?: true };
}

export const ANSWER_ROADS: readonly AnswerRoad[] = [
  { key: "y", effect: "allow", does: "run it", answer: { verb: "allow", about: "answers the prompt the thread is stopped on and lets the call run", said: "allowed" } },
  { key: "n", effect: "deny", does: "refuse it", answer: { verb: "deny", about: "answers the prompt the thread is stopped on and refuses the call", said: "denied", reasons: true } },
  { key: "a", effect: "mode" },
];

/** The roads this prompt's own options carry, each beside the option it picks. A call that asks the person something
 * rather than for consent carries its own answers and no road here, which is what leaves a terminal nothing to type. */
function answerRoads(options: readonly PermissionOption[]): { road: AnswerRoad; option: PermissionOption }[] {
  return ANSWER_ROADS.flatMap(road => {
    const option = options.find(o => o.effect === road.effect);
    return option === undefined ? [] : [{ road, option }];
  });
}

/** What the person at the keyboard types to answer the prompt above, printed under it: each key with what it does,
 * in the road's words or, where the road has none, in the words the option itself arrived with. */
export function answerKeysLine(options: readonly PermissionOption[]): string {
  const typed = answerRoads(options).map(({ road, option }) => `${road.key} to ${road.does ?? lowerFirst(option.label)}`);
  return `answer here: type ${typed.join(", ")}`;
}

/** A sentence's first letter in the case a sentence takes, for a label written to stand on a button. */
const lowerFirst = (words: string): string => `${words.slice(0, 1).toLowerCase()}${words.slice(1)}`;

/** The same answer for a caller with nobody at the keyboard: the lines another terminal runs, by the thread's id. */
export function answerVerbsLine(threadId: string): string {
  const verbs = ANSWER_ROADS.flatMap(road => (road.answer === undefined ? [] : [`wsp thread ${road.answer.verb} ${threadWord(threadId)}`]));
  return `answer from another terminal: ${verbs.join(", or ")}`;
}

/** What a prompt carrying none of the answers above is answered on: its options are the question's own, which no key
 * and no verb here stands for. */
export const ANSWER_IN_THE_APP = "answer it in the app: this prompt carries its own answers";

/** What a prompt answered from a terminal says once the pick landed: which answer it was and which call it closed,
 * so the line says what was allowed rather than only that something was. */
export function answeredLine(threadId: string, ask: { toolName: string; input: string; detail?: string }, said: string): string {
  return `${said} on thread ${threadWord(threadId)}: ${askingLine(ask)}`;
}

/** The one sentence a line that answers a prompt is refused with when the thread is stopped on none. */
export function noOpenAskLine(threadId: string): string {
  return `thread ${threadWord(threadId)} is waiting on no prompt; wsp threads says which threads need you`;
}

/** The one sentence it is refused with when the thread's prompt carries no option this answer stands for. */
export function noSuchAnswerLine(threadId: string, verb: string): string {
  return `the prompt thread ${threadWord(threadId)} is stopped on takes no ${verb}; wsp thread read shows what it asks`;
}

/** Picks one option on a prompt the runtime holds open, the op the app's own buttons send; anything but a pick the
 * harness took is the caller's failure, in the words of the outcome. */
async function answerAsk(client: HostClient, sessionId: string, askId: string, optionId: string, reason?: string): Promise<void> {
  const { outcome } = SessionAnswerResult.parse(await client.request("sessions.answer", { sessionId, askId, optionId, ...(reason === undefined ? {} : { reason }) }));
  if (outcome !== "answered") throw new Error(ANSWER_WORDS[outcome]);
}

/** What a thread's open prompt answered by one of the roads above came to, for a terminal that is not watching the
 * turn: the prompt is read off the transcript the host holds, so a thread anybody opened is answerable from here. */
export async function answerOpenAsk(client: HostClient, ref: string, road: AnswerRoad & { answer: NonNullable<AnswerRoad["answer"]> }, reason?: string): Promise<{ threadId: string; askId: string; optionId: string; line: string }> {
  const thread = await threadOf(client, ref);
  const threadId = threadIdOf(thread);
  const ask = openAsk(await history(client, thread.workspaceId), threadId);
  if (ask === undefined) throw new Error(noOpenAskLine(threadId));
  const option = ask.options.find((o: PermissionOption) => o.effect === road.effect);
  if (option === undefined) throw new Error(noSuchAnswerLine(threadId, road.answer.verb));
  await answerAsk(client, ask.sessionId, ask.askId, option.id, reason);
  return { threadId, askId: ask.askId, optionId: option.id, line: answeredLine(threadId, ask, road.answer.said) };
}

/** The prompt road a watched turn takes: the ask said in the terminal that is blocked, the way to answer under it,
 * and, where somebody is at the keyboard, the answer they type sent back as the option it picks. A prompt closed by
 * anyone (this terminal, another one, the app, the turn ending) releases the read, so nothing sits on stdin after
 * the question it belonged to is gone. */
function answering(ctx: VerbContext, say: (line: string) => void): { opened(ask: SessionPermissionEvent, threadId: string): void; closed(askId: string): void; stop(): void } {
  let open: { askId: string; release: () => void } | undefined;
  const release = (): void => {
    open?.release();
    open = undefined;
  };
  return {
    opened: (ask, threadId) => {
      const roads = answerRoads(ask.options);
      // Nobody is offered keys where no line printed which keys answer: --json writes the events and no stream, so
      // its caller answers by the verb, as a caller with no terminal does.
      const keyed = ctx.flags["json"] === true ? undefined : ctx.io.answerKey;
      say(needsYouLine(ask));
      // The way to answer, in the words of whoever is reading: the keys where somebody is at the keyboard, the
      // verbs where nobody is, and neither on a prompt whose options are the question's own.
      say(roads.length === 0 ? ANSWER_IN_THE_APP : keyed === undefined ? answerVerbsLine(threadId) : answerKeysLine(ask.options));
      if (keyed === undefined || roads.length === 0) return;
      release();
      let settle = (): void => {};
      const until = new Promise<void>(done => (settle = done));
      open = { askId: ask.askId, release: settle };
      void keyed(roads.map(({ road }) => road.key), until)
        .then(async typed => {
          const picked = roads.find(({ road }) => road.key === typed);
          // The line's socket as it stands when the key is typed, which is the host that came back where one restarted.
          if (picked !== undefined) await answerAsk(await ctx.client(), ask.sessionId, ask.askId, picked.option.id);
        })
        .catch((e: unknown) => ctx.io.error(e instanceof Error ? e.message : String(e)));
    },
    closed: askId => {
      if (open?.askId === askId) release();
    },
    stop: release,
  };
}


/** What a followed turn says about itself beyond the reply: the line that names the thread it opened where the
 * workspace was inferred, and the word the turn's own figure carries where this run knows what the figure is. */
interface SaidAbout {
  opened?: ((threadId: string, folder?: string) => string) | undefined;
  spend?: string | undefined;
}

/** The verbs' way through a turn: text, the tool calls behind it and what each answered stream to stderr as they
 * arrive, and the reply is read once. Where the stream is the person's own screen the streamed prose is that copy
 * and stdout adds only the lines around it; where stdout parts from the stream it carries the finished text whole,
 * with --json every event of the turn up to its done instead; a turn that did not complete is the verb's failure,
 * in the harness's words. */
export async function followVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, announce: boolean, picks: Picks = {}, said: SaidAbout = {}, onTurn?: (turn: Turn) => void): Promise<Turn> {
  const { opened, spend } = said;
  const stream = turnStream(ctx);
  const asks = answering(ctx, line => stream.says(line));
  /** Each call this turn has open, by the id the harness named it, so its result is read against the call's own
   * input rather than against the harness's words for it. */
  const calls = new Map<string, { name: string; input: string }>();
  // What the runtime said about the turn this message joined, kept for the line under the join: the steer is
  // recorded as the harness takes the message, which is before the start this follow is waiting on is answered.
  let joinedWaiting = false;
  // Set once the host stopped under the turn: the stream on the screen has a gap where it went, so it is no copy of
  // the reply and the reply is printed whole.
  let redialed = false;
  let turn: Turn;
  try {
    turn = await follow(client, start, "cli", {
      queued: () => ctx.io.error(WAITING),
      starting: event => ctx.io.error(agentStartingLine(agentName(event.harness), event.installs === true)),
      steered: event => {
        joinedWaiting = event.waiting === true;
      },
      started: (t: Turn) => {
        // The live turn, which follow fills in as its events land: whoever waited on it reads its end off this.
        onTurn?.(t);
        if (announce) ctx.out.emit({ type: "thread", id: t.threadId, workspaceId: t.session.workspaceId, harness: t.session.harness, startedBy: t.session.startedBy }, openedThreadSaid(t.threadId, opened, t.session.cwd));
        if (t.outcome !== "started") ctx.io.error(JOINED[t.outcome](picks));
        if (joinedWaiting) ctx.io.error(WAITING_ON_A_PERSON);
      },
      redialed: () => {
        redialed = true;
        ctx.io.error(HOST_RESTARTING_LINE);
      },
      event: (e, t) => {
        if (e.type === "session.done") {
          const reply = stream.reply(e.result.text);
          ctx.out.emit(e, redialed ? e.result.text : reply);
        } else ctx.out.emit(e);
        if (e.type === "session.start" && e.afterCut === true) ctx.io.error(AFTER_CUT_LINE);
        // The person's turn as the transcript keeps it: one bracket per image, since a terminal draws no pixels.
        if (e.type === "session.start") for (const file of e.attachments ?? []) stream.line(attachmentLine(file));
        if (e.type === "session.delta" && e.kind === "text") stream.text(e.text, e.messageId);
        // The harness's own note reads as the aside it is: the muted ink every line around the prose takes, and no
        // word of failure, which belongs to a call that failed and to the turn's own end.
        if (e.type === "session.delta" && e.kind === "note") stream.line(e.text);
        if (e.type === "session.compacted") stream.line(compactedLine(e.before, e.after));
        if (e.type === "session.delta" && e.kind === "tool_use") {
          stream.line(toolActivityLine(e.toolName, e.text));
          if (e.toolUseId !== undefined) {
            const open = calls.get(e.toolUseId);
            calls.set(e.toolUseId, { name: e.toolName ?? open?.name ?? "tool", input: (open?.input ?? "") + e.text });
          }
        }
        if (e.type === "session.delta" && e.kind === "tool_result") {
          const call = e.toolUseId === undefined ? undefined : calls.get(e.toolUseId);
          if (e.toolUseId !== undefined) calls.delete(e.toolUseId);
          const answer = toolAnsweredLine(call?.name, call?.input ?? "", { text: e.text, ...(e.isError !== undefined ? { isError: e.isError } : {}) });
          if (answer !== undefined) stream.line(answer);
        }
        if (e.type === "session.permission") asks.opened(e, t.threadId);
        if (e.type === "session.permission.closed") asks.closed(e.askId);
        if (e.type === "session.done") stream.line(turnSettledLine(e.result, spend));
        if (e.type === "session.notify" && e.notify === NOTIFY_ME) ctx.io.error(e.text);
      },
    }, () => hostBack(ctx));
  } finally {
    asks.stop();
  }
  const failure = turnRefusal(turn);
  if (failure !== undefined) throw failure;
  return turn;
}

/** A send's reads before its start, which send nothing: a host that stops under them has taken no message, so the
 * line says the message was not delivered rather than that a turn goes on. */
export async function beforeSending<T>(client: HostClient, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (await stoppedUnder(client)) throw new Error(NOT_DELIVERED_LINE);
    throw e;
  }
}

/** The verbs' way through a detached start: the queued and joined lines on stderr as a follow prints them, then the
 * thread's id on stdout the moment the runtime names it, and nothing of the reply, which the thread's finished line
 * carries to whoever its start named. */
export async function detachVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, picks: Picks = {}, opened?: (threadId: string, folder?: string) => string): Promise<void> {
  const turn = await startDetached(client, start, "cli", () => ctx.io.error(WAITING), () => hostBack(ctx));
  if (turn.outcome !== "started") ctx.io.error(JOINED[turn.outcome](picks));
  ctx.out.emit(turnView(turn), openedThreadSaid(turn.threadId, opened, turn.session.cwd));
}

export const turnView = (turn: Turn): z.infer<typeof TurnOut> => ({
  threadId: turn.threadId,
  workspaceId: turn.session.workspaceId,
  harness: turn.session.harness,
  ...(turn.result !== undefined ? { text: turn.result.text ?? "" } : {}),
  outcome: turn.outcome,
  ...(turn.afterCut === true ? { afterCut: true as const } : {}),
});
