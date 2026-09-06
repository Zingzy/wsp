// SPDX-License-Identifier: AGPL-3.0-only
// The verbs a person or a local agent runs beside the app: thin clients of
// the host's protocol on localhost, authenticated with the token the host
// wrote to the state dir. One command table, one dial, one output formatter;
// a verb is a function from its parsed arguments and the client to an exit
// code. The MCP server is a second door onto the same exported functions.
// Nothing here reads a key or imports the runtime: the host is the only
// process that talks to the provider.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import WebSocket from "ws";
import {
  NOTIFY_ME,
  fmtThreads,
  foldThreads,
  forgetNotice,
  goldenHead,
  goneRefusal,
  startPicks,
  workspaceState,
  workspaceWord,
  type ExecEvent,
  type GoldenManifest,
  type HarnessCatalog,
  type ProjectExportEvent,
  type ProjectExportResult,
  type ProjectGolden,
  type SessionEvent,
  type SessionOrigin,
  type SessionStartOutcome,
  SessionStartResult,
  type SessionView,
  type ThreadView,
  type TurnResult,
  type WorkspaceCreateResult,
  type WorkspaceCreatingEvent,
  type WorkspaceView,
} from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { hostTokenPath, servingHost } from "./host-lock.js";

type Frame = Record<string, unknown> & { id?: string | number | null; ok?: boolean; type?: string };

export interface HostClient {
  request<T extends Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
  /** Asks for the runtime's events once; a second call is a no-op, since each subscription would push every event again. */
  events(): Promise<void>;
  /** Every frame that is not a reply: events after events(), the frames an exec pushes. */
  onFrame(fn: (frame: Frame) => void): () => void;
  /** Settles when the socket is gone, however it went. */
  readonly closed: Promise<void>;
  close(): void;
}

const DIAL_MS = 5_000;

/** Where the host serving this state file listens and the token it wrote, or a plain refusal when none serves it. */
export function hostAddress(statePath: string): { wsPort: number; token: string } {
  const lock = servingHost(statePath);
  if (lock === undefined) throw new Error(`no wsp host is serving ${statePath}; run wsp up first`);
  const tokenPath = hostTokenPath(statePath);
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    throw new Error(`the host's token file is missing: ${tokenPath}`);
  }
  return { wsPort: lock.wsPort, token };
}

/** One socket to the host: the token rides in the first frame, never in the URL; then request and reply by id.
 * Open and auth share one deadline, so a port that accepts and never answers fails in one line. */
export async function dialHost(statePath: string, deadlineMs = DIAL_MS): Promise<HostClient> {
  const { wsPort, token } = hostAddress(statePath);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const opened = new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const closed = new Promise<void>(done => ws.once("close", () => done()));
  let next = 1;
  const pending = new Map<number, { settle: (f: Frame) => void; fail: (e: Error) => void }>();
  const listeners = new Set<(f: Frame) => void>();
  ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as Frame;
    const waiter = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
    if (waiter !== undefined) {
      pending.delete(frame.id as number);
      waiter.settle(frame);
      return;
    }
    for (const fn of listeners) fn(frame);
  });
  ws.on("close", () => {
    for (const w of pending.values()) w.fail(new Error("the host closed the connection"));
    pending.clear();
  });
  ws.on("error", () => {});
  const request = async <T extends Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = next++;
    const frame = await new Promise<Frame>((settle, fail) => {
      pending.set(id, { settle, fail });
      ws.send(JSON.stringify({ id, op, ...params }));
    });
    if (frame.ok !== true) throw Object.assign(new Error(typeof frame["error"] === "string" ? frame["error"] : `${op} failed`), typeof frame["kind"] === "string" ? { kind: frame["kind"] } : {});
    return frame as T;
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`the host on port ${wsPort} did not answer within ${deadlineMs} ms`)), deadlineMs);
  });
  try {
    await Promise.race([opened.then(() => request("auth", { token })), deadline]);
  } catch (e) {
    ws.terminate();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let subscribed: Promise<void> | undefined;
  return {
    request,
    events: () => (subscribed ??= request("events.subscribe").then(() => undefined)),
    onFrame: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    closed,
    close: () => ws.close(),
  };
}

/** A follower's promise, or a failure when the host goes away first: a director waiting on a turn must never hang. */
function untilSettled<T>(client: HostClient, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    client.closed.then((): never => {
      throw new Error("the host closed the connection");
    }),
  ]);
}

/** Frames pushed to the socket, held from before the request that names what to wait for: the id to match is
 * only known once the reply lands, and the host may push the first frame right behind it. A stop from inside `on`
 * drops the held frames not yet replayed too: a whole turn may sit in them when the harness answered at once. */
function pushedFrames(client: HostClient): { follow(pick: (f: Frame) => boolean, on: (f: Frame) => void): void; stop(): void } {
  const held: Frame[] = [];
  let sink: ((f: Frame) => void) | undefined;
  const off = client.onFrame(f => (sink !== undefined ? sink(f) : held.push(f)));
  return {
    follow: (pick, on) => {
      sink = f => {
        if (pick(f)) on(f);
      };
      for (const f of held.splice(0)) sink(f);
    },
    stop: () => {
      off();
      sink = () => {};
    },
  };
}

/** Every verb speaks through this. With --json each value is one JSON line on stdout and nothing else is
 * printed; without it the line is printed when there is one, and a reply streams to stderr as it arrives. */
export interface Out {
  emit(value: unknown, line?: string): void;
  stream(text: string): void;
}

function formatter(io: CliIO, json: boolean): Out {
  return {
    emit: (value, line) => {
      if (json) io.log(JSON.stringify(value));
      else if (line !== undefined) io.log(line);
    },
    stream: text => {
      if (!json) io.stream?.(text);
    },
  };
}

/** Columns padded to their widest cell, two spaces apart; the last column is never padded. */
function table(rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const widths = rows.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
  return rows.map(row => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

type Flags = Record<string, string | boolean | undefined>;

interface VerbContext {
  args: string[];
  flags: Flags;
  io: CliIO;
  out: Out;
  client(): Promise<HostClient>;
}

interface Verb {
  /** The words that select it; what follows is the verb's own. */
  name: string;
  usage: string;
  /** One phrase on what it does, in every help. */
  about: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(ctx: VerbContext): Promise<number>;
}

const COMMON: NonNullable<ParseArgsConfig["options"]> = {
  state: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

/** The model, effort and access mode flags, on every verb that starts a turn. */
const PICK_FLAGS = ["model", "effort", "access"] as const;
const PICK_OPTIONS: NonNullable<ParseArgsConfig["options"]> = Object.fromEntries(PICK_FLAGS.map(name => [name, { type: "string" }]));

const flag = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

export async function workspaces(client: HostClient): Promise<WorkspaceView[]> {
  return (await client.request<{ workspaces: WorkspaceView[] }>("workspaces.list")).workspaces;
}

async function threads(client: HostClient, workspaceId?: string): Promise<ThreadView[]> {
  const { sessions } = await client.request<{ sessions: SessionView[] }>("sessions.list", workspaceId !== undefined ? { workspaceId } : {});
  return foldThreads(sessions);
}

/** A workspace as a person names it: by id, else by its name when exactly one carries it. */
export async function workspaceOf(client: HostClient, ref: string): Promise<WorkspaceView> {
  const all = await workspaces(client);
  const byId = all.find(w => w.id === ref);
  if (byId !== undefined) return byId;
  const byName = all.filter(w => w.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`${byName.length} workspaces are named ${ref}; use the id`);
  throw new Error(`no workspace ${ref}`);
}

/** A thread by id, or by a prefix of it that names exactly one. */
export async function threadOf(client: HostClient, ref: string): Promise<ThreadView> {
  const all = await threads(client);
  const exact = all.find(t => t.id === ref);
  if (exact !== undefined) return exact;
  const prefixed = all.filter(t => t.id.startsWith(ref));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) throw new Error(`${prefixed.length} threads start with ${ref}; give more of the id`);
  throw new Error(`no thread ${ref}`);
}

export type ThreadRow = ThreadView & { workspaceName: string };

/** The sidebar's rows with each workspace's name on them, within one workspace when named, as every director lists them. */
export async function threadRows(client: HostClient, within?: string): Promise<ThreadRow[]> {
  const all = await workspaces(client);
  const scope = within !== undefined ? await workspaceOf(client, within) : undefined;
  const rows = await threads(client, scope?.id);
  return rows.map(t => ({ ...t, workspaceName: all.find(w => w.id === t.workspaceId)?.name ?? t.workspaceId }));
}

/** Naps the workspace a person names; the view after, as every director shows it. */
export async function nap(client: HostClient, ref: string): Promise<WorkspaceView> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ workspace: WorkspaceView }>("workspaces.nap", { workspaceId: source.id })).workspace;
}

/** What a forget takes off this computer, counted before anyone is asked: the workspace's record and its threads. */
export interface Forgetting {
  workspace: WorkspaceView;
  threads: number;
}

export async function forgetting(client: HostClient, ref: string): Promise<Forgetting> {
  const workspace = await workspaceOf(client, ref);
  return { workspace, threads: (await threads(client, workspace.id)).length };
}

/** The one confirmation a forget asks, naming what goes; the first line is the question, the second its hint. */
export function forgetQuestion(f: Forgetting): string {
  return `Forget ${f.workspace.name}?\n${forgetNotice(f.threads)}`;
}

/** Drops the workspace from the host's store; the runtime refuses while its machine still exists. */
export async function forget(client: HostClient, f: Forgetting): Promise<void> {
  await client.request("workspaces.forget", { workspaceId: f.workspace.id });
}

export function forgotLine(f: Forgetting): string {
  return `forgot ${f.workspace.name} ${f.workspace.id}: its record and ${fmtThreads(f.threads)} are gone from this computer`;
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

function threadLine(t: ThreadRow): string[] {
  return [t.id, t.workspaceName, t.harness, t.status, t.startedBy, t.cwd !== undefined ? shortenedFront(t.cwd, FOLDER_WIDTH) : "", shortenedEnd(t.title, TITLE_WIDTH)];
}

/** Forks the golden's head into a new workspace, the way the app's create does, with the stages streamed as they land. */
export async function createFromHead(client: HostClient, out: Out, name: string): Promise<WorkspaceCreateResult> {
  const { manifest } = await client.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
  const head = goldenHead(manifest);
  if (head === undefined) throw new Error("no golden yet; run wsp init");
  return create(client, out, head.snapshotId, name);
}

/** The project golden a person names: by snapshot id, else the newest whose project carries that name. */
export async function projectGoldenOf(client: HostClient, ref: string): Promise<ProjectGolden> {
  const { projectGoldens } = await client.request<{ projectGoldens: ProjectGolden[] }>("projectGoldens.list");
  const byId = projectGoldens.find(g => g.snapshotId === ref);
  if (byId !== undefined) return byId;
  const byName = projectGoldens.filter(g => g.project.name === ref).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (byName[0] !== undefined) return byName[0];
  throw new Error(`no project golden named ${ref}; wsp snapshot <workspace> takes one`);
}

/** Snapshots the workspace a person names as a project golden; the record, as every director shows it. */
export async function snapshot(client: HostClient, ref: string): Promise<ProjectGolden> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ projectGolden: ProjectGolden }>("workspaces.snapshot", { workspaceId: source.id })).projectGolden;
}

export function projectGoldenLine(g: ProjectGolden): string {
  const version = g.version !== undefined ? `golden v${g.version}` : `golden ${g.golden}`;
  return `project golden ${g.snapshotId}: ${version} plus ${g.project.name} as imported ${g.project.importedAt.slice(0, 10)}, taken from ${g.workspaceName}\nfork it with: wsp new <name> --from ${g.project.name}`;
}

export async function create(client: HostClient, out: Out, golden: string, name: string): Promise<WorkspaceCreateResult> {
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
    const { workspace, notice } = await client.request<{ workspace: WorkspaceView; notice?: string }>("workspaces.create", { golden, name });
    const created: WorkspaceCreateResult = { workspace, ...(notice !== undefined ? { notice } : {}) };
    out.emit(created, `created ${workspace.name} ${workspace.id}${notice !== undefined ? `\n${notice}` : ""}`);
    return created;
  } finally {
    pushed.stop();
  }
}

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
}

/** A folder named for a thread, refused unless absolute: the harness would run a relative one against its own home
 * and fail inside the guest, where the person reads it as a harness failure. */
export function absoluteFolder(cwd: string | undefined): string | undefined {
  if (cwd !== undefined && !cwd.startsWith("/")) throw new Error(`--cwd is a path on the machine, absolute: got "${cwd}"`);
  return cwd;
}

/** The folder a new thread works in: the one named, else the workspace's imported project folder, else none, and the
 * harness starts in its own home. A thread's folder decides which project state its agent loads, so a workspace with
 * a project opens its threads there. */
export function threadFolder(workspace: WorkspaceView, cwd?: string): string | undefined {
  return absoluteFolder(cwd) ?? workspace.project?.dest;
}

/** The model, effort and access mode a start names, as the composer's pickers name them; the runtime checks each
 * against the harness's catalog and refuses with the list. access is the wire's permissionMode. */
export type Picks = Partial<Record<(typeof PICK_FLAGS)[number], string>>;

/** The picks as sessions.start carries them: the fields the app's composer sends, absent ones left out. */
export function picksOf(picks: Picks): Record<string, string> {
  return { ...(picks.model !== undefined ? { model: picks.model } : {}), ...(picks.effort !== undefined ? { effort: picks.effort } : {}), ...(picks.access !== undefined ? { permissionMode: picks.access } : {}) };
}

/** The three pick flags as given on the command line. */
export function pickFlags(flags: Flags): Picks {
  return Object.fromEntries(PICK_FLAGS.map(name => [name, flag(flags, name)]));
}

/** Refuses a pick the harness table does not list, in the runtime's own words, before a machine is minted for it;
 * the table is what the runtime knows without a machine, and the start on the new machine checks the rest. */
export async function checkedPicks(client: HostClient, harness: string | undefined, picks: Picks): Promise<void> {
  const { harnesses } = await client.request<{ harnesses: HarnessCatalog[] }>("harnesses.list");
  startPicks(harnesses.find(c => (harness === undefined ? c.isDefault === true : c.harness === harness)), picksOf(picks), true);
}

/** The start that opens a new thread in a workspace, under the named agent or the runtime's default, in the named
 * folder or the workspace's own; cwd is the field the app's composer sends. notify is the thread its every turn's end
 * is told to, or NOTIFY_ME. */
export function openingOf(workspace: WorkspaceView, prompt: string, opts: Picks & { harness?: string; cwd?: string; notify?: string } = {}): Record<string, unknown> {
  const cwd = threadFolder(workspace, opts.cwd);
  return {
    workspaceId: workspace.id,
    prompt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
    ...picksOf(opts),
  };
}

/** What a --notify names for the runtime: NOTIFY_ME as given, else the thread the reference picks, by its full id. */
export async function notifyOf(client: HostClient, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined || ref === NOTIFY_ME) return ref;
  const thread = await threadOf(client, ref);
  return thread.threadId ?? thread.id;
}

/** The start a message to an existing thread makes: its latest turn resumed under the thread's own agent, with any
 * pick named for this turn; the harness takes a new model, effort or mode on a resume. */
export function resumeOf(thread: ThreadView, prompt: string, picks: Picks = {}): Record<string, unknown> {
  if (thread.claudeSessionId === undefined) throw new Error(`thread ${thread.id} has no session to resume yet`);
  return { workspaceId: thread.workspaceId, prompt, harness: thread.harness, resume: thread.claudeSessionId, ...picksOf(picks) };
}

/** A start reply the protocol schema refuses: the host process predates or postdates this command's build. */
const OTHER_VERSION = "the host answered sessions.start in a shape this wsp does not read; it runs another version of wsp, restart it with wsp up";

/** Starts a turn as `startedBy` and follows it to its reply: `on.queued` when the runtime says the start waits behind
 * the thread's running turn, `on.started` the thread as soon as the runtime names it, `on.event` every event of the
 * turn with the turn so far. Fails when the host goes away first. The send carries its own request id so an app view
 * with the same text in flight cannot take this turn's start for its own, and so the queued notice is known to be
 * this start's. Events are picked by the turn's id: a start that waited behind the thread's running turn must not
 * read that turn's end as its own. The follow ends at session.done, which carries the whole reply: session.end
 * follows the runtime's exit read and reap, minutes later when the machine is slow to answer. A turn the runtime
 * ended itself has no done, so its end is the last event instead. */
export async function follow(
  client: HostClient,
  start: Record<string, unknown>,
  startedBy: SessionOrigin,
  on: { queued?(): void; started?(turn: Turn): void; event(e: SessionEvent, turn: Turn): void },
): Promise<Turn> {
  const pushed = pushedFrames(client);
  await client.events();
  const requestId = randomUUID();
  const offQueued = client.onFrame(f => {
    if (f.type === "session.queued" && f["requestId"] === requestId) on.queued?.();
  });
  let answer: Record<string, unknown>;
  try {
    answer = await client.request("sessions.start", { ...start, startedBy, requestId });
  } finally {
    offQueued();
  }
  const reply = SessionStartResult.safeParse(answer);
  if (!reply.success) throw new Error(OTHER_VERSION);
  const { session, outcome, turnId } = reply.data;
  const threadId = session.threadId;
  if (threadId === undefined) throw new Error("the runtime stamped no thread on the session");
  const turn: Turn = { session, threadId, outcome };
  on.started?.(turn);
  const ended = new Promise<Turn>(done => {
    pushed.follow(
      f => sessionEvent(f) && f.turnId === turnId,
      f => {
        const e = f as unknown as SessionEvent;
        if (e.type === "session.done") turn.result = e.result;
        if (e.type === "session.end" && e.reason !== undefined) turn.reason = e.reason;
        on.event(e, turn);
        if (e.type !== "session.done" && e.type !== "session.end") return;
        pushed.stop();
        done(turn);
      },
    );
  });
  try {
    return await untilSettled(client, ended);
  } finally {
    pushed.stop();
  }
}

/** Why the turn did not complete, in one line; nothing when it did. */
export function turnFailure(turn: Turn): string | undefined {
  if (turn.result?.status === "completed") return undefined;
  return turn.result?.error ?? turn.reason ?? `turn ${turn.result?.status ?? "ended without a result"}`;
}

/** What a send that met a running turn on its thread says on stderr: WAITING when the runtime announces the wait,
 * the rest once it answered. A steered message cannot change the running turn's picks, so the line names the flags
 * it dropped. */
const WAITING = "waiting behind the running turn";
const JOINED: Record<Exclude<SessionStartOutcome, "started">, (picks: Picks) => string> = {
  steered: picks => {
    const dropped = PICK_FLAGS.filter(name => picks[name] !== undefined).map(name => `--${name}`);
    return `joined the running turn${dropped.length === 0 ? "" : `; ${dropped.join(", ")} dropped, it keeps its own model, effort and access`}`;
  },
  queued: () => "queued behind the running turn; it has ended and this turn started",
};

/** The verbs' way through a turn: text streams to stderr as it arrives, the last message is printed on stdout when
 * the reply is complete, with --json every event of the turn up to its done is printed instead; the failure is one
 * line on stderr, exit 1. */
async function followVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, announce: boolean, picks: Picks = {}): Promise<number> {
  const turn = await follow(client, start, "cli", {
    queued: () => ctx.io.error(WAITING),
    started: (t: Turn) => {
      if (announce) ctx.out.emit({ type: "thread", id: t.threadId, workspaceId: t.session.workspaceId, harness: t.session.harness, startedBy: t.session.startedBy }, `thread ${t.threadId}`);
      if (t.outcome !== "started") ctx.io.error(JOINED[t.outcome](picks));
    },
    event: e => {
      ctx.out.emit(e, e.type === "session.done" ? e.result.text : undefined);
      if (e.type === "session.delta" && e.kind === "text") ctx.out.stream(e.text);
      if (e.type === "session.notify" && e.notify === NOTIFY_ME) ctx.io.error(e.text);
    },
  });
  const failure = turnFailure(turn);
  if (failure !== undefined) ctx.io.error(failure);
  return failure === undefined ? 0 : 1;
}

export type ExecExit = Extract<ExecEvent, { type: "exec.exit" }>;

/** Runs argv on the workspace's machine and follows it to its exit; `on` sees each output line and the exit. Fails
 * when the host goes away first. */
export async function execOn(client: HostClient, workspaceId: string, argv: readonly string[], on: (e: ExecEvent) => void): Promise<ExecExit> {
  const pushed = pushedFrames(client);
  const { execId } = await client.request<{ execId: string }>("workspaces.exec", { workspaceId, argv });
  const exited = new Promise<ExecExit>(done => {
    pushed.follow(
      f => (f.type === "exec.output" || f.type === "exec.exit") && f["execId"] === execId,
      f => {
        const e = f as unknown as ExecEvent;
        on(e);
        if (e.type === "exec.exit") done(e);
      },
    );
  });
  try {
    return await untilSettled(client, exited);
  } finally {
    pushed.stop();
  }
}

/** What an export asks for: the folder on the machine, where it lands here, whether to replace what is there, and
 * which agents' sessions come home (every one with sessions for the folder when absent). */
export interface ExportRequest {
  source: string;
  dest: string;
  replace?: boolean;
  agents?: readonly string[];
}

/** Brings a project folder and the agent sessions keyed to it home from the workspace's machine: `on` sees each
 * stage of the export as the runtime says it, and the result is what landed. Fails when the host goes away first. */
export async function exportProject(client: HostClient, workspaceId: string, req: ExportRequest, on: (e: ProjectExportEvent) => void): Promise<ProjectExportResult> {
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "project.export" && f["workspaceId"] === workspaceId && f["dest"] === req.dest,
    f => on(f as unknown as ProjectExportEvent),
  );
  try {
    const { exported } = await untilSettled(
      client,
      client.request<{ exported: ProjectExportResult }>("project.export", {
        workspaceId,
        source: req.source,
        dest: req.dest,
        ...(req.replace !== undefined ? { replace: req.replace } : {}),
        ...(req.agents !== undefined ? { agents: req.agents } : {}),
      }),
    );
    return exported;
  } finally {
    pushed.stop();
  }
}

/** The agents a --agents flag names, comma-separated; nothing when the flag is absent. */
export function agentsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",").map(s => s.trim()).filter(s => s !== "");
  if (ids.length === 0) throw new Error("--agents names at least one agent, comma-separated");
  return ids;
}

const notYet = (verb: string, usage: string, options: Verb["options"], does: string): Verb => ({
  name: verb,
  usage,
  about: `${does}; not here yet, lands with the project bundle`,
  options,
  run: async ctx => {
    const line = `wsp ${verb} is not here yet: ${does} lands with the project bundle.`;
    if (ctx.flags["json"] === true) ctx.out.emit({ verb, available: false, note: line });
    else ctx.io.error(line);
    return 1;
  },
});

export const VERBS: readonly Verb[] = [
  {
    name: "new",
    usage: "wsp new <name> [--from <project golden>]",
    about: "a workspace forked from the golden's head, or with --from, from a project golden",
    options: { from: { type: "string" } },
    run: async ctx => {
      const [name] = ctx.args;
      if (name === undefined || ctx.args.length !== 1) throw new Error("wsp new takes one name");
      const client = await ctx.client();
      const from = flag(ctx.flags, "from");
      if (from === undefined) await createFromHead(client, ctx.out, name);
      else await create(client, ctx.out, (await projectGoldenOf(client, from)).snapshotId, name);
      return 0;
    },
  },
  {
    name: "snapshot",
    usage: "wsp snapshot <workspace>",
    about: "a project golden of the workspace: its golden plus the project as it is now, ready to fork",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw new Error("wsp snapshot takes one workspace");
      const projectGolden = await snapshot(await ctx.client(), ref);
      ctx.out.emit({ projectGolden }, projectGoldenLine(projectGolden));
      return 0;
    },
  },
  {
    name: "fork",
    usage: 'wsp fork <workspace> [--name <name>] [--send "<task>" [the flags of thread new]]',
    about: "a new machine from the source's golden version, not a copy of its live disk",
    options: { name: { type: "string" }, send: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw new Error("wsp fork takes one workspace");
      const task = flag(ctx.flags, "send");
      for (const dependent of ["agent", ...PICK_FLAGS, "cwd", "notify"]) if (task === undefined && flag(ctx.flags, dependent) !== undefined) throw new Error(`--${dependent} needs --send`);
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      if (source.phase === "gone") throw new Error(goneRefusal("fork", source.gone));
      // Resolved and checked before the machine is minted, so a bad reference or pick costs nothing.
      const notify = await notifyOf(client, flag(ctx.flags, "notify"));
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      if (task !== undefined) await checkedPicks(client, harness, picks);
      const created = await create(client, ctx.out, source.golden, flag(ctx.flags, "name") ?? `${source.name}-fork`);
      if (task === undefined) return 0;
      return followVerb(ctx, client, openingOf(created.workspace, task, { harness, ...picks, cwd: flag(ctx.flags, "cwd"), notify }), true);
    },
  },
  {
    name: "pause",
    usage: "wsp pause <workspace>",
    about: "naps the workspace's machine",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw new Error("wsp pause takes one workspace");
      const workspace = await nap(await ctx.client(), ref);
      ctx.out.emit({ workspace }, `${workspace.name} ${workspaceWord(workspaceState({ phase: workspace.phase })).toLowerCase()}`);
      return 0;
    },
  },
  {
    name: "forget",
    usage: "wsp forget <workspace> [--yes]",
    about: "drops a gone workspace and its threads from this computer; refused while its machine exists",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw new Error("wsp forget takes one workspace");
      const client = await ctx.client();
      const f = await forgetting(client, ref);
      if (ctx.flags["yes"] !== true && (await ctx.io.ask(forgetQuestion(f))) !== "yes") {
        ctx.io.error(`${f.workspace.name} kept`);
        return 1;
      }
      await forget(client, f);
      ctx.out.emit({ forgot: { workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads } }, forgotLine(f));
      return 0;
    },
  },
  {
    name: "threads",
    usage: "wsp threads [--in <workspace>]",
    about: "every thread as the sidebar lists it: agent, state, who opened it, the folder it works in",
    options: { in: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw new Error("wsp threads takes no positional arguments");
      const rows = await threadRows(await ctx.client(), flag(ctx.flags, "in"));
      ctx.out.emit({ threads: rows.map(({ workspaceName: _name, ...t }) => t) }, table([["THREAD", "WORKSPACE", "AGENT", "STATE", "BY", "FOLDER", "TITLE"], ...rows.map(threadLine)]).join("\n"));
      return 0;
    },
  },
  {
    name: "thread new",
    usage: 'wsp thread new --in <workspace> [--agent, --model, --effort, --access, --cwd, --notify] "<task>"',
    about: "opens a thread with the agent, model, effort and access the app offers; follows its first turn",
    options: { in: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string" } },
    run: async ctx => {
      const [task] = ctx.args;
      const within = flag(ctx.flags, "in");
      if (within === undefined) throw new Error("wsp thread new needs --in <workspace>");
      if (task === undefined || ctx.args.length !== 1) throw new Error("wsp thread new takes one task");
      const client = await ctx.client();
      const workspace = await workspaceOf(client, within);
      return followVerb(ctx, client, openingOf(workspace, task, { harness: flag(ctx.flags, "agent"), ...pickFlags(ctx.flags), cwd: flag(ctx.flags, "cwd"), notify: await notifyOf(client, flag(ctx.flags, "notify")) }), true);
    },
  },
  {
    name: "send",
    usage: 'wsp send <thread> [--model, --effort, --access <value>] "<message>"',
    about: "a message to the thread, on a named model, effort or access; a running turn keeps its own",
    options: PICK_OPTIONS,
    run: async ctx => {
      const [ref, message] = ctx.args;
      if (ref === undefined || message === undefined || ctx.args.length !== 2) throw new Error("wsp send takes a thread and one message");
      const client = await ctx.client();
      const picks = pickFlags(ctx.flags);
      return followVerb(ctx, client, resumeOf(await threadOf(client, ref), message, picks), false, picks);
    },
  },
  {
    name: "exec",
    usage: "wsp exec <workspace> -- <command...>",
    about: "runs the command on the workspace's machine, each word as given",
    options: {},
    run: async ctx => {
      const [ref, ...words] = ctx.args;
      if (ref === undefined || words.length === 0) throw new Error("wsp exec takes a workspace, then -- and the command");
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const exit = await execOn(client, workspace.id, words, e => ctx.out.emit(e, e.type === "exec.output" ? e.text : undefined));
      if (exit.error !== undefined) ctx.io.error(exit.error);
      return exit.exitCode ?? 1;
    },
  },
  notYet("import", "wsp import <folder> --to <workspace>", { to: { type: "string" } }, "moving a project folder into a workspace"),
  {
    name: "export",
    usage: "wsp export <workspace> <folder> [--from <path on the machine>] [--replace] [--agents <ids>]",
    about: "brings a project folder and the agent sessions keyed to it home from the machine",
    options: { from: { type: "string" }, replace: { type: "boolean" }, agents: { type: "string" } },
    run: async ctx => {
      const [ref, folder] = ctx.args;
      if (ref === undefined || folder === undefined || ctx.args.length !== 2) throw new Error("wsp export takes a workspace and a folder on this computer");
      const dest = resolve(folder);
      const agents = agentsFlag(flag(ctx.flags, "agents"));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const req: ExportRequest = { source: flag(ctx.flags, "from") ?? dest, dest, ...(ctx.flags["replace"] === true ? { replace: true } : {}), ...(agents !== undefined ? { agents } : {}) };
      let done = "";
      try {
        const exported = await exportProject(client, workspace.id, req, e => {
          if (e.stage === "done") done = e.message;
          else if (e.stage !== "failed") ctx.out.stream(`${e.message}\n`);
        });
        ctx.out.emit({ exported }, done);
        return 0;
      } catch (e) {
        if ((e as { kind?: unknown }).kind !== "exists") throw e;
        ctx.io.error(`wsp export: ${e instanceof Error ? e.message : String(e)}\nRun again with --replace to overwrite it.`);
        return 1;
      }
    },
  },
];

/** The verb whose words open argv, the longest first, so `thread new` wins over a verb named `thread`. */
export function findVerb(argv: ReadonlyArray<string>): Verb | undefined {
  return [...VERBS].sort((a, b) => b.name.length - a.name.length).find(v => {
    const words = v.name.split(" ");
    return words.every((w, i) => argv[i] === w);
  });
}

/** Two lines per verb for the top-level help: its usage, then what it does indented under it, so no line runs wide. */
export function verbHelp(): string {
  return VERBS.map(v => `  ${v.usage}\n      ${v.about}`).join("\n");
}

/** The usage of every verb that opens with this word, for a command that stopped short of one; none when no verb does. */
export function verbUsage(word: string): string | undefined {
  const usages = VERBS.filter(v => v.name.split(" ")[0] === word).map(v => `usage: ${v.usage}`);
  return usages.length > 0 ? usages.join("\n") : undefined;
}

export async function runVerb(verb: Verb, argv: ReadonlyArray<string>, io: CliIO, defaultStatePath: () => string): Promise<number> {
  let flags: Flags;
  let args: string[];
  try {
    const parsed = parseArgs({ args: argv.slice(verb.name.split(" ").length), options: { ...COMMON, ...verb.options }, allowPositionals: true });
    flags = parsed.values as Flags;
    args = parsed.positionals;
    absoluteFolder(flag(flags, "cwd"));
  } catch (e) {
    io.error(`${e instanceof Error ? e.message : String(e)}\n\nusage: ${verb.usage}`);
    return 1;
  }
  if (flags["help"] === true) {
    io.log(`usage: ${verb.usage}\n  ${verb.about}\n\n  --json         print the raw protocol values, one JSON line each\n  --state PATH   the state file the host serves`);
    return 0;
  }
  const statePath = resolve(flag(flags, "state") ?? defaultStatePath());
  let client: HostClient | undefined;
  const ctx: VerbContext = {
    args,
    flags,
    io,
    out: formatter(io, flags["json"] === true),
    client: async () => (client ??= await dialHost(statePath)),
  };
  try {
    return await verb.run(ctx);
  } catch (e) {
    io.error(`wsp ${verb.name}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    client?.close();
  }
}
