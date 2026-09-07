// SPDX-License-Identifier: AGPL-3.0-only
// The verbs a person or a local agent runs beside the app: thin clients of
// the host's protocol on localhost, authenticated with the token the host
// wrote to the state dir. One verb table with two doors on every entry: the
// command line (its usage, its flags, a run from the parsed line to an exit
// code) and the MCP tool (its description, the zod shape it takes and answers,
// a call from the parsed arguments to a result). The parser, the help and the
// tool list all read the table, so a verb is added in one place. Nothing here
// reads a key or imports the runtime: the host is the only process that talks
// to the provider.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { z } from "zod";
import { CATALOG_AGENTS, THREAD_AGENTS } from "@wsp/catalog";
import { nodeHost } from "@wsp/collect";
import {
  AFTER_CUT_LINE,
  EMPTY_TASK_LINE,
  EXIT_CODES,
  LOGIN_CHOICES,
  NOTIFY_ME,
  NOTIFY_WORDS,
  ProjectExportResult,
  ProjectGolden,
  ProjectImportResult,
  ProjectPlan,
  RECIPE_TICKS,
  RecipeTick,
  SessionInterruptOutcome,
  SessionInterruptResult,
  SessionStartOutcome,
  SessionStartResult,
  TURN_END_WORDS,
  ThreadView,
  WorkspaceView,
  actionRefusal,
  authRefusal,
  canTravel,
  defaultAgents,
  defaultConsent,
  deleteNotice,
  execFolderLine,
  fmtBytes,
  plural,
  fmtThreads,
  foldThreads,
  foreignFlagLine,
  forgetNotice,
  goldenHead,
  goneRefusal,
  importConsented,
  importRequest,
  noAdapterLine,
  offeredSize,
  secretOffer,
  sizeFromWord,
  sizeRefusal,
  startPicks,
  stillWorkingRefusal,
  toolActivityLine,
  toolResultLine,
  turnSettledLine,
  unknownAgentLine,
  usageRefusal,
  verbFailure,
  workspaceState,
  workspaceWord,
  type Capabilities,
  type ExecEvent,
  type GoldenManifest,
  type HarnessCatalog,
  type ProjectExportEvent,
  type ProjectImportEvent,
  type ProjectImportRequest,
  type SessionEvent,
  type SessionOrigin,
  type SessionView,
  type TurnResult,
  type WorkspaceCreateResult,
  type WorkspaceCreatingEvent,
  type WorkspaceSize,
} from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { hostTokenPath, servingHost } from "./host-lock.js";
import { colourDepth, isTTY, wrap } from "./init-layout.js";
import { RecipeAnswer, RecipeScan, recipePrintout, scanPrintout } from "./recipe-answer.js";
import { isRecipeTick, runRecipe, runScan, type ScanInput } from "./recipe-command.js";
import { historyCache, smallRecipePath } from "./recipe-file.js";

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
/** The close code the runtime sends with every token refusal, the one fact an older host still carries. */
const UNAUTHORIZED_CLOSE = 4401;
/** How long a refused auth waits for the close that follows its frame before the frame's own class stands. */
const CLOSE_GRACE_MS = 500;

/** Where the host serving this state file listens and the token it wrote, or a plain refusal when none serves it. */
export function hostAddress(statePath: string): { wsPort: number; token: string } {
  const lock = servingHost(statePath);
  if (lock === undefined) throw new Error(`no wsp host is serving ${statePath}; run wsp up first`);
  const tokenPath = hostTokenPath(statePath);
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    throw authRefusal(`the host's token file is missing: ${tokenPath}`);
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
  let closeCode: number | undefined;
  const closed = new Promise<void>(done =>
    ws.once("close", code => {
      closeCode = code;
      done();
    }),
  );
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
  // A refusal whose frame carries no kind is classed by the close code that follows it, so a host of an older version
  // that sends the code alone still reads as auth; a frame with a kind is the source when there is one.
  const authed = opened
    .then(() => request("auth", { token }))
    .catch(async (e: unknown) => {
      if ((e as { kind?: unknown }).kind !== undefined) throw e;
      await Promise.race([closed, new Promise(r => setTimeout(r, CLOSE_GRACE_MS))]);
      throw closeCode === UNAUTHORIZED_CLOSE ? authRefusal(e instanceof Error ? e.message : String(e)) : e;
    });
  try {
    await Promise.race([authed, deadline]);
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

type Flags = Record<string, string | boolean | string[] | undefined>;

/** What both doors are handed beside the line or the arguments: the state file the host serves, which the recipe
 * verbs write beside, and the scanner for tools outside the catalog when the caller has one (it reaches the engine,
 * which the MCP server may not import, so each door decides whether it runs). */
export interface VerbDeps {
  statePath: string;
  alsoHere?: ScanInput["alsoHere"];
  /** The socket to the host: a verb's own dial, closed when it returns; a tool server's one dial across calls. */
  client(): Promise<HostClient>;
}

interface VerbContext extends VerbDeps {
  args: string[];
  flags: Flags;
  io: CliIO;
  out: Out;
}

/** The verb as an MCP tool: what it does in the agent's words, the zod shape of what it takes and of what it
 * answers, and the call. The shapes are what tools/list serves and what the parity test holds the skill to. */
export interface Tool {
  description: string;
  input: z.ZodRawShape;
  output: z.ZodRawShape;
  /** The output fields the command line prints as frames under --json, one per line ahead of the result, which leaves
   * them out; a result with nothing left is not printed. */
  stream?: readonly string[];
  call(args: Record<string, unknown>, deps: VerbDeps): Promise<CallToolResult>;
}

/** Types the call's arguments from the input shape, then lets the entry sit in the table beside every other. */
function tool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(spec: {
  description: string;
  input: In;
  output: Out;
  stream?: readonly (keyof Out & string)[];
  call(args: z.objectOutputType<In, z.ZodTypeAny>, deps: VerbDeps): Promise<CallToolResult>;
}): Tool {
  return spec;
}

/** A verb on both doors: the words that select it on the command line, its usage and one phrase on what it does in
 * every help, the flags it reads beside COMMON, its run, and its tool. */
export interface CliVerb {
  name: string;
  usage: string;
  about: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(ctx: VerbContext): Promise<number>;
  tool: Tool;
}

/** A verb the tool door alone offers, with why the command line has no such line. */
export interface ToolOnlyVerb {
  name: string;
  tool: Tool;
  toolOnly: string;
}

export type Verb = CliVerb | ToolOnlyVerb;

/** The one rule that names a verb's tool: its words joined by underscores, so `thread new` is `thread_new`. */
export function toolName(words: string): string {
  return words.replace(/ /g, "_");
}

/** The flags every verb takes beside its own. */
export const COMMON: NonNullable<ParseArgsConfig["options"]> = {
  state: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

/** The model, effort and access mode flags, on every verb that starts a turn. */
const PICK_FLAGS = ["model", "effort", "access"] as const;
const PICK_OPTIONS: NonNullable<ParseArgsConfig["options"]> = Object.fromEntries(PICK_FLAGS.map(name => [name, { type: "string" }]));

const flag = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
const flagList = (flags: Flags, name: string): string[] => (Array.isArray(flags[name]) ? (flags[name] as string[]) : []);

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

/** The workspace's name and its state word, the line pause and wake print once the runtime has answered. */
export function stateLine(workspace: WorkspaceView): string {
  return `${workspace.name} ${workspaceWord(workspaceState({ phase: workspace.phase })).toLowerCase()}`;
}

/** Naps the workspace a person names; the view after, as every director shows it. */
export async function nap(client: HostClient, ref: string): Promise<WorkspaceView> {
  const source = await workspaceOf(client, ref);
  return (await client.request<{ workspace: WorkspaceView }>("workspaces.nap", { workspaceId: source.id })).workspace;
}

/** Every verb that needs the machine goes through here, so a paused or waking workspace is a wait and never the
 * provider's error. The runtime is asked even when the view says running: only its state read catches a provider-side
 * pause. The runtime refuses a gone workspace too; the refusal here exists to carry the verb's own action word. */
export async function awake(client: HostClient, workspace: WorkspaceView, action: string, tell: (line: string) => void): Promise<WorkspaceView> {
  const state = workspaceState({ phase: workspace.phase });
  if (state === "gone") throw new Error(goneRefusal(action, workspace.gone));
  if (state !== "running") tell(`waking ${workspace.name}`);
  return (await client.request<{ workspace: WorkspaceView }>("workspaces.wake", { workspaceId: workspace.id })).workspace;
}

/** What a stop came to, as every director prints it: the runtime's three answers, none an error. */
export interface Stopped {
  threadId: string;
  outcome: SessionInterruptOutcome;
}

/** Stops the running turn of the thread a person names, through the runtime as the app's stop button does; the
 * machine is not touched. Parsed, not trusted: an outcome outside the enum must not read as stopped. */
export async function stop(client: HostClient, ref: string): Promise<Stopped> {
  const thread = await threadOf(client, ref);
  const { outcome } = SessionInterruptResult.parse(await client.request("sessions.interrupt", { sessionId: thread.sessionId }));
  return { threadId: thread.id, outcome };
}

const STOP_WORDS: Record<SessionInterruptOutcome, string> = { accepted: "stopped", "not-running": "not running", "not-found": "not found by the host" };

export function stopLine(stopped: Stopped): string {
  return `thread ${stopped.threadId} ${STOP_WORDS[stopped.outcome]}`;
}

/** What dropping a workspace takes off this computer, counted before anyone is asked: its record and its threads. */
export interface Dropping {
  workspace: WorkspaceView;
  threads: number;
}

export async function dropping(client: HostClient, ref: string): Promise<Dropping> {
  const workspace = await workspaceOf(client, ref);
  return { workspace, threads: (await threads(client, workspace.id)).length };
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
  return `Delete ${d.workspace.name}?\n${deleteNotice(d.threads)}`;
}

/** Kills the workspace's machine at the provider, then drops its record here; a machine already gone is no error. */
export async function deleteWorkspace(client: HostClient, d: Dropping): Promise<void> {
  await client.request("workspaces.delete", { workspaceId: d.workspace.id });
}

export function deletedLine(d: Dropping): string {
  return `deleted ${d.workspace.name} ${d.workspace.id}: machine ${d.workspace.machineId} is gone at the provider, and its record and ${fmtThreads(d.threads)} are gone from this computer`;
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
export async function createFromHead(client: HostClient, out: Out, name: string, size?: string): Promise<WorkspaceCreateResult> {
  const { manifest } = await client.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
  const head = goldenHead(manifest);
  if (head === undefined) throw new Error("no golden yet; run wsp init");
  return create(client, out, head.snapshotId, name, size);
}

/** The size a --size word names, checked against what the host's provider offers before anything is minted. */
async function sizeChosen(client: HostClient, word: string): Promise<WorkspaceSize> {
  const { capabilities } = await client.request<{ capabilities: Capabilities }>("capabilities.get");
  const size = sizeFromWord(word);
  if (size === undefined || !offeredSize(capabilities.sizes, size)) throw usageRefusal(sizeRefusal(word, capabilities.sizes));
  return size;
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

/** `size` is the --size word; absent, the workspace takes the golden's size. */
export async function create(client: HostClient, out: Out, golden: string, name: string, size?: string): Promise<WorkspaceCreateResult> {
  const chosen = size === undefined ? undefined : await sizeChosen(client, size);
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
    const { workspace, notice } = await client.request<{ workspace: WorkspaceView; notice?: string }>("workspaces.create", { golden, name, ...chosen });
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
  /** The thread's previous turn ended without a result, as the turn's session.start said. */
  afterCut?: true;
}

/** A path a caller named, refused unless absolute: whoever reads it has a working folder of its own that the caller
 * cannot see, so a relative path resolves somewhere neither of them meant. `named` opens the line. */
export function absolutePath(named: string, path: string): string {
  if (!path.startsWith("/")) throw usageRefusal(`${named}, absolute: got ${JSON.stringify(path)}`);
  return path;
}

/** A folder named for a thread, refused unless absolute: the harness would run a relative one against its own home
 * and fail inside the guest, where the person reads it as a harness failure. */
export function absoluteFolder(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : absolutePath("--cwd is a path on the machine", cwd);
}

/** The folder a new thread works in and a command runs in: the one named, else the workspace's imported project
 * folder, else none, and the harness or the shell starts in its own home. A thread's folder decides which project
 * state its agent loads; a command's decides what its git or its tests see, so both read the one rule. */
export function workFolder(workspace: WorkspaceView, cwd?: string): string | undefined {
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

/** Refuses, in the runtime's own words and before a machine is minted or woken for it, what the runtime would refuse
 * once the machine was there: an empty task or message, an agent the host has no adapter for, a pick the agent's table
 * does not list. The tables are what the runtime knows without a machine; the start on the machine checks the rest. */
export async function checkedStart(client: HostClient, task: string, harness: string | undefined, picks: Picks): Promise<void> {
  if (task.trim() === "") throw usageRefusal(EMPTY_TASK_LINE);
  const { harnesses } = await client.request<{ harnesses: HarnessCatalog[] }>("harnesses.list");
  const table = harnesses.find(c => (harness === undefined ? c.isDefault === true : c.harness === harness));
  if (table === undefined && harness !== undefined) throw usageRefusal(noAdapterLine(harness, harnesses.map(c => c.harness)));
  try {
    startPicks(table, picksOf(picks), true);
  } catch (e) {
    throw usageRefusal(e instanceof Error ? e.message : String(e));
  }
}

/** The start that opens a new thread in a workspace, under the named agent or the runtime's default, in the named
 * folder or the workspace's own; cwd is the field the app's composer sends. notify is the thread its every turn's end
 * is told to, or NOTIFY_ME. */
export function openingOf(workspace: WorkspaceView, prompt: string, opts: Picks & { harness?: string; cwd?: string; notify?: string } = {}): Record<string, unknown> {
  const cwd = workFolder(workspace, opts.cwd);
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

/** The start a message to an existing thread makes: the thread named to the runtime, which resumes its latest turn
 * or, on a thread whose harness never announced a session, runs the message as its first turn; under the thread's own
 * agent, with any pick named for this turn. A row from before threads had ids resumes by its session, and one with
 * neither is refused: a start naming nothing would open a new thread in silence. */
export function messageTo(thread: ThreadView, prompt: string, picks: Picks = {}): Record<string, unknown> {
  if (thread.threadId === undefined && thread.claudeSessionId === undefined) throw new Error(`thread ${thread.id} has no session to resume yet`);
  const target = thread.threadId !== undefined ? { thread: thread.threadId } : { resume: thread.claudeSessionId };
  return { workspaceId: thread.workspaceId, prompt, harness: thread.harness, ...target, ...picksOf(picks) };
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
        if (e.type === "session.start" && e.afterCut === true) turn.afterCut = true;
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

/** A turn's stderr as a person watching it reads it: the reply's prose as it arrives, and a quiet line of its own
 * for each tool call, for what the call answered and for the turn's own end, so a turn that runs commands for
 * minutes shows work rather than silence. A line that lands mid-sentence breaks the sentence first; nothing is
 * redrawn, since the stream may be a file. */
function turnStream(ctx: VerbContext): { text(t: string): void; line(l: string): void } {
  let atLineStart = true;
  return {
    text: t => {
      if (t === "") return;
      ctx.out.stream(t);
      atLineStart = t.endsWith("\n");
    },
    line: l => {
      ctx.out.stream(`${atLineStart ? "" : "\n"}${ctx.io.muted?.(l) ?? l}\n`);
      atLineStart = true;
    },
  };
}

/** The verbs' way through a turn: text, the tool calls behind it and what each answered stream to stderr as they
 * arrive, the last message is printed on stdout when the reply is complete, with --json every event of the turn up
 * to its done is printed instead; a turn that did not complete is the verb's failure, in the harness's words. */
async function followVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, announce: boolean, picks: Picks = {}): Promise<Turn> {
  const stream = turnStream(ctx);
  const turn = await follow(client, start, "cli", {
    queued: () => ctx.io.error(WAITING),
    started: (t: Turn) => {
      if (announce) ctx.out.emit({ type: "thread", id: t.threadId, workspaceId: t.session.workspaceId, harness: t.session.harness, startedBy: t.session.startedBy }, `thread ${t.threadId}`);
      if (t.outcome !== "started") ctx.io.error(JOINED[t.outcome](picks));
    },
    event: e => {
      ctx.out.emit(e, e.type === "session.done" ? e.result.text : undefined);
      if (e.type === "session.start" && e.afterCut === true) ctx.io.error(AFTER_CUT_LINE);
      if (e.type === "session.delta" && e.kind === "text") stream.text(e.text);
      if (e.type === "session.delta" && e.kind === "tool_use") stream.line(toolActivityLine(e.toolName, e.text));
      if (e.type === "session.delta" && e.kind === "tool_result") {
        const answer = toolResultLine(e.text, e.isError);
        if (answer !== undefined) stream.line(answer);
      }
      if (e.type === "session.done") stream.line(turnSettledLine(e.result));
      if (e.type === "session.notify" && e.notify === NOTIFY_ME) ctx.io.error(e.text);
    },
  });
  const failure = turnFailure(turn);
  if (failure !== undefined) throw new Error(failure);
  return turn;
}

export type ExecExit = Extract<ExecEvent, { type: "exec.exit" }>;

/** Runs argv on the workspace's machine, in cwd when given, and follows it to its exit; `on` sees each output line
 * and the exit. Fails when the host goes away first. */
export async function execOn(client: HostClient, workspaceId: string, argv: readonly string[], cwd: string | undefined, on: (e: ExecEvent) => void): Promise<ExecExit> {
  const pushed = pushedFrames(client);
  const { execId } = await client.request<{ execId: string }>("workspaces.exec", { workspaceId, argv, ...(cwd !== undefined ? { cwd } : {}) });
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

/** The plan for a folder on this computer, as the app's dialog reads it: nothing is packed or uploaded. */
export async function planProject(client: HostClient, source: string): Promise<ProjectPlan> {
  return (await client.request<{ plan: ProjectPlan }>("project.plan", { source })).plan;
}

/** Lands a folder on this computer at dest on the workspace's machine, the way the app's dialog does: `on` sees each
 * stage of the import as the runtime says it, and the result is what landed. Fails when the host goes away first. */
export async function importProject(client: HostClient, workspaceId: string, req: ProjectImportRequest, on: (e: ProjectImportEvent) => void): Promise<ProjectImportResult> {
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "project.import" && f["workspaceId"] === workspaceId && f["source"] === req.source && f["dest"] === req.dest,
    f => on(f as unknown as ProjectImportEvent),
  );
  try {
    const { imported } = await untilSettled(client, client.request<{ imported: ProjectImportResult }>("project.import", { workspaceId, ...req }));
    return imported;
  } finally {
    pushed.stop();
  }
}

/** The rows a person changed from the plan's defaults: keep ticks a secret-shaped row, cut unticks it; a path the
 * plan does not list as secret-shaped is refused, since nothing would change for it. */
export function secretsChosen(plan: ProjectPlan, keep: readonly string[], cut: readonly string[]): ReadonlySet<string> {
  const listed = new Set(plan.secrets.map(s => s.path));
  for (const path of [...keep, ...cut]) {
    if (!listed.has(path)) throw usageRefusal(`${path} is not a secret-shaped file in the plan${listed.size === 0 ? "; the plan lists none" : `; the plan lists ${[...listed].join(", ")}`}`);
  }
  const ticked = new Set(defaultConsent(plan.secrets));
  for (const path of keep) ticked.add(path);
  for (const path of cut) ticked.delete(path);
  return ticked;
}

/** The agents whose sessions travel: the ones named, each with sessions in the plan, else the plan's default. */
export function agentsChosen(plan: ProjectPlan, named: readonly string[] | undefined): ReadonlySet<string> {
  if (named === undefined) return defaultAgents(plan.agents);
  const travelling = plan.agents.filter(canTravel);
  for (const id of named) {
    if (!travelling.some(a => a.agent === id)) throw usageRefusal(`${id} has no sessions for this folder${travelling.length === 0 ? "" : `; the plan lists ${travelling.map(a => a.agent).join(", ")}`}`);
  }
  return new Set(named);
}

/** The plan as the dialog shows it, one fact per line: the repository, the files and their size, the caches left
 * behind, the paths not carried, where it lands, then each secret-shaped row with its signals, size and what its tick
 * means, and each agent with its sessions and whether they travel. */
export function planLines(plan: ProjectPlan, ticked: ReadonlySet<string>, agents: ReadonlySet<string>): string[] {
  const rows: string[][] = [
    ["Repository", plan.repo ? "git, .git travels whole" : "none"],
    ["Files", `${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}`],
    ["Caches left behind", plan.excluded.length === 0 ? "none" : plan.excluded.join(", ")],
    ["Not carried", plan.skipped.length === 0 ? "none" : plural(plan.skipped.length, "path")],
    ...plan.skipped.map(s => [`  ${s.path}`, s.note]),
    ["Lands at", plan.source],
    ["Secret-shaped", plan.secrets.length === 0 ? "none" : plural(plan.secrets.length, "file")],
    ...plan.secrets.map(s => [`  ${s.path}`, `${s.signals.join(", ")}, ${fmtBytes(s.bytes)}`, secretOffer(s, ticked.has(s.path)).full]),
    ["Agents", plan.agents.length === 0 ? "none with sessions for the folder" : `${plural(plan.agents.length, "agent")} with sessions for the folder`],
    ...plan.agents.map(a => [`  ${a.name}`, a.error ?? plural(a.sessions, "session"), agents.has(a.agent) ? "sessions travel" : "stays"]),
  ];
  return table(rows);
}

/** The line under a plan nobody has consented to yet, off a terminal: nothing moved, and the two ways to say yes. */
export const PLAN_ONLY = "nothing imported; run again with --yes to take these defaults, or --keep <path> and --cut <path> per secret-shaped row";

/** The one question a person at the terminal is asked under the plan; no is the default and moves nothing. */
export const IMPORT_NOW = "Import now? y/N";

/** A destination the runtime refused as already there, with the flag that overwrites it named; any other failure as it came. */
function withReplaceHint(e: unknown): unknown {
  if ((e as { kind?: unknown }).kind !== "exists") return e;
  return Object.assign(new Error(`${e instanceof Error ? e.message : String(e)}\nRun again with --replace to overwrite it.`), { kind: "exists" });
}

/** The agents a --agents flag names, comma-separated, each one the catalog knows; nothing when the flag is absent. */
export function agentsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",").map(s => s.trim()).filter(s => s !== "");
  if (ids.length === 0) throw usageRefusal("--agents names at least one agent, comma-separated");
  const known = CATALOG_AGENTS.map(a => a.id);
  const unknown = ids.find(id => !known.includes(id));
  if (unknown !== undefined) throw usageRefusal(unknownAgentLine(unknown, known));
  return ids;
}

/** The one question a drop asks unless --yes, and the one line it prints when the answer is anything but yes. Off a
 * terminal nobody can answer, so the line without --yes is refused as written. */
async function confirmed(ctx: VerbContext, question: string, d: Dropping): Promise<boolean> {
  if (ctx.flags["yes"] === true) return true;
  if (ctx.io.isTTY !== true) throw usageRefusal(`${question.split("\n")[0]} There is no terminal to answer on; pass --yes to say yes.`);
  if ((await ctx.io.ask(question)) === "yes") return true;
  ctx.io.error(`${d.workspace.name} kept`);
  return false;
}

/** Nothing printed on the tool door: a tool answers with values, and the stages a create streams have no reader there. */
const QUIET: Out = { emit: () => {}, stream: () => {} };
/** The waking line has no reader on the tool door either: the result says which machine ran. */
const QUIET_LINE = (): void => {};
const QUIET_TURN = { event: () => {} };

const Created = z.object({ workspace: WorkspaceView, notice: z.string().optional() });

/** What a send meets on its thread, in the runtime's own words: the outcome it answers with on a free or a running
 * turn, and the line it refuses with when the last turn replied but its agent process has not exited. */
const { started, steered, queued } = SessionStartOutcome.enum;
const SEND_MEETS = `On a thread whose turn is not running the message starts a new turn (outcome \`${started}\`); when the turn is still running the message joins it (outcome \`${steered}\`) or waits for it and then runs (outcome \`${queued}\`), and the reply is that turn's. When the thread's turn has replied but its agent process is still running, nothing starts and the send is refused with \`${stillWorkingRefusal("1a2b3c4d")}\`; wait for the thread to leave running, then send again.`;

/** outcome says how the message landed: its own turn, steered into the thread's running one, or queued behind it;
 * afterCut is set when the thread's previous turn ended without a result, so the reply may be missing context. */
const TurnOut = z.object({ threadId: z.string(), workspaceId: z.string(), harness: z.string(), text: z.string(), outcome: SessionStartOutcome, afterCut: z.literal(true).optional() });
const ThreadRowOut = ThreadView.extend({ workspaceName: z.string() });
const Argv = z.array(z.string()).min(1);

type Structured = Record<string, unknown>;

/** A result the agent reads as text and a client with a schema reads as the same value. */
const asJson = (structured: Structured): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured });
const asText = (text: string, structured: Structured): CallToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });

const turnView = (turn: Turn): z.infer<typeof TurnOut> => ({
  threadId: turn.threadId,
  workspaceId: turn.session.workspaceId,
  harness: turn.session.harness,
  text: turn.result?.text ?? "",
  outcome: turn.outcome,
  ...(turn.afterCut === true ? { afterCut: true as const } : {}),
});

/** The reply as the tool's text, with the cut line first when the thread's previous turn did not finish. */
const turnText = (out: z.infer<typeof TurnOut>): string => (out.afterCut === true ? `${AFTER_CUT_LINE}\n${out.text}` : out.text);

/** The turn's reply as the tool result; a turn that did not complete is a tool error with the harness's reason. */
function turnOut(turn: Turn): z.infer<typeof TurnOut> {
  const failure = turnFailure(turn);
  if (failure !== undefined) throw new Error(failure);
  return turnView(turn);
}

/** The line under a plan the tool returned without importing: the call that says yes, and the two per-row answers. */
const PLAN_ONLY_TOOL = "nothing imported; call import again with yes true to take these defaults, or keep and cut per secret-shaped row";

const WorkspaceIn = z.string().describe("the workspace's name, or its id when two share a name");
const AgentIn = z.string().optional().describe(`the agent to run in the thread, one of ${THREAD_AGENTS.join(", ")}; absent means the host's default`);
const NotifyIn = z.string().optional().describe("a thread (by id, or a prefix of it) told in one line each time a turn of the new thread ends, as a message into it; or me, for the person's app");
const CwdIn = z.string().optional().describe("the folder on the machine the thread works in or the command runs in, absolute; absent means the workspace's project folder, else the home folder");
const ConfirmIn = z.boolean().optional().describe("true deletes the machine; absent or false answers with what would go and deletes nothing, so a person can be asked first");
/** The same three words the app's composer uses; the runtime refuses a value the agent's catalog does not list, naming the list. */
const PICK_INPUTS = {
  model: z.string().optional().describe("the model the turn runs on, by the agent's own slug (claude-sonnet-5); absent on a new thread means the catalog's default, on send the thread's own"),
  effort: z.string().optional().describe("the reasoning effort, by the agent's own word (low, medium, high); absent means the agent's default"),
  access: z.string().optional().describe("the access mode, by the agent's own word (plan, acceptEdits, bypassPermissions); absent means the agent's default"),
};
/** The same word on new and fork; the refusal for a size the provider does not offer names the ones it does. */
const SizeIn = z.string().optional().describe("the machine size as <cpu>x<memGb>, like 2x4; absent takes the golden's size. A size the provider does not offer is refused with the list it does, so read that list rather than guessing twice; a build wants the largest memory offered");

const PROJECT_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count");
/** The same folders on the write verb, where naming them is also naming a rule input, so it re-decides the ticks. */
const WEIGH_BY_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count. Naming one re-decides every tick from the rule, as tick does, so any flip an earlier call made goes");
/** Absolute, since the tool server's own folder is wherever the agent launched it and a prefix test on a relative
 * path silently matches nothing. */
const projectFolders = (folders: readonly string[]): string[] => folders.map(f => absolutePath("project is a folder on this computer", f));

/** The --project folders a recipe line names, resolved from where the person stands; nothing when it names none. */
const projectsFlag = (flags: Flags): { projects?: string[] } => (Array.isArray(flags["project"]) ? { projects: (flags["project"] as string[]).map(p => resolve(p)) } : {});

/** The reading is progress, not the answer: it goes to stderr so what is on stdout is the whole answer. */
const progress = (io: CliIO): { log(line: string): void; note(line: string): void } => ({ log: line => io.log(line), note: line => io.error(line) });

/** The recipe verbs' answer on the command line: one JSON object under --json, else the table's lines in the
 * terminal's colours and the line that says what to do next. */
function printTable(ctx: VerbContext, value: unknown, lines: (depth: number) => string[], next: string): void {
  ctx.out.emit(value);
  if (ctx.flags["json"] === true) return;
  for (const line of lines(colourDepth(isTTY(process.stdout)))) ctx.io.log(line);
  ctx.io.log(next);
}

export const VERBS: readonly Verb[] = [
  {
    name: "workspaces",
    toolOnly: "the rows wsp threads folds its output from; the command line lists threads with their workspace on every row",
    tool: tool({
      description: "Every workspace this host runs, as the app lists them: id, name, phase (running or napping) and the golden it forked from.",
      input: {},
      output: { workspaces: z.array(WorkspaceView) },
      call: async (_args, deps) => asJson({ workspaces: await workspaces(await deps.client()) }),
    }),
  },
  {
    name: "threads",
    usage: "wsp threads [--in <workspace>]",
    about: "every thread as the sidebar lists it: agent, state, who opened it, the folder it works in",
    options: { in: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp threads takes no positional arguments");
      const rows = await threadRows(await ctx.client(), flag(ctx.flags, "in"));
      ctx.out.emit({ threads: rows }, table([["THREAD", "WORKSPACE", "AGENT", "STATE", "BY", "FOLDER", "TITLE"], ...rows.map(threadLine)]).join("\n"));
      return 0;
    },
    tool: tool({
      description: "Every thread as the sidebar lists it: the workspace, the agent inside, its state, who opened it (person, cli or agent), the folder it works in and its title. Optionally within one workspace.",
      input: { workspace: WorkspaceIn.optional() },
      output: { threads: z.array(ThreadRowOut) },
      call: async ({ workspace: within }, deps) => asJson({ threads: await threadRows(await deps.client(), within) }),
    }),
  },
  {
    name: "recipe scan",
    usage: "wsp recipe scan [--project <folder>]",
    about:
      "read this computer and print every option, writing nothing: the agents, the tools with why and size, what else a package manager here has that the image could take, the commands your agents ran, and the sign-ins, each with what to do about it and one line of why; --project weighs the histories by a folder and --json prints it as one object",
    options: { project: { type: "string", multiple: true } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe scan takes no positional arguments");
      const scan = await runScan(nodeHost(), { ...projectsFlag(ctx.flags), cache: historyCache(ctx.statePath), ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}) }, progress(ctx.io));
      printTable(ctx, scan, depth => scanPrintout(scan, depth), `Nothing was written. Take the do column with wsp recipe --set <id>=on and --signin <id>=machine, then run wsp init --recipe ${resolve(smallRecipePath(ctx.statePath))}.`);
      return 0;
    },
    tool: tool({
      description:
        "Every option this computer offers for a machine, read once and written nowhere: the person's agents and the catalog's tools with the tick their own use reaches and what each adds to the machine, what else a package manager on this computer has that the image could take (alsoHere, by manager, with the line that installs each on the machine, each row's id being the one to hand recipe's set, which ticks that package as a row of its own), whose scanned says whether anything looked, the commands their agents ran that the catalog does not carry, and the sign-in each ticked row brings. Every row carries a recommended value and a one-line reason, so apply those and put only the rows whose reason says worth a question. Run this before recipe, and before asking the person anything. Only names and counts are read.",
      input: { project: PROJECT_FOLDERS },
      output: RecipeScan.shape,
      call: async ({ project }, deps) => {
        const scan = await runScan(nodeHost(), {
          cache: historyCache(deps.statePath),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(scanPrintout(scan).join("\n"), scan);
      },
    }),
  },
  {
    name: "recipe",
    usage: `wsp recipe [--tick ${RECIPE_TICKS.join("|")}] [--set <id>=on|off] [--signin <id>=${LOGIN_CHOICES.join("|")}] [--add <id>=<command>] [--add-check <id>=<command>] [--project <folder>] [--out <path>]`,
    about:
      "write the recipe and print it as a table: every catalog agent and tool with its tick, why it has it and what it costs on the machine, then the commands your agents ran that no catalog row carries. --tick used|installed|default names the rule that decides every tick (used, the default, ticks what your agents actually ran here); --set <id>=on|off flips a row by its catalog id, or a package this Mac's own package managers have by the id wsp recipe scan gives it, which the build installs by that package's own road; --signin <id>=copy|machine|key|skip answers a sign-in by catalog id, key bringing the key files beside a login and nothing else of it; --add <id>=<command> carries a tool neither the catalog nor this Mac has, installed by that command on the machine, with --add-check <id>=<command> saying it is there; --project reads a folder's own manifests for what it takes to build and weighs the histories by it, --out says where the file goes and --json prints the table as one object. Naming --tick or --project decides every tick again; without either, what the file says stands and the flags flip rows on top of it. A sign-in answer stands either way: no rule decides one. All of them repeat. Review it, then wsp init --recipe",
    options: {
      out: { type: "string" },
      tick: { type: "string" },
      set: { type: "string", multiple: true },
      signin: { type: "string", multiple: true },
      add: { type: "string", multiple: true },
      "add-check": { type: "string", multiple: true },
      project: { type: "string", multiple: true },
    },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe takes no positional arguments; wsp recipe scan is its one subcommand");
      const tick = flag(ctx.flags, "tick");
      if (tick !== undefined && !isRecipeTick(tick)) throw usageRefusal(`--tick takes one of ${RECIPE_TICKS.join(", ")}, not ${JSON.stringify(tick)}`);
      const out = resolve(flag(ctx.flags, "out") ?? smallRecipePath(ctx.statePath));
      const table = await runRecipe(
        nodeHost(),
        {
          out,
          cache: historyCache(ctx.statePath),
          ...(tick !== undefined ? { tick } : {}),
          set: flagList(ctx.flags, "set"),
          signin: flagList(ctx.flags, "signin"),
          add: flagList(ctx.flags, "add"),
          addCheck: flagList(ctx.flags, "add-check"),
          ...projectsFlag(ctx.flags),
          ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}),
        },
        progress(ctx.io),
      );
      printTable(ctx, table, depth => recipePrintout(table, depth), `Recipe written to ${out}. Review it, flip a row with wsp recipe --set <id>=on, then run wsp init --recipe ${out}.`);
      return 0;
    },
    tool: tool({
      description: `The recipe for a machine, read off this computer and written to a file: every catalog agent and tool with its tick, why it has that tick, and what it adds to the machine, plus the commands the person's agents ran that no catalog row carries. tick names the rule: used ticks what their agents actually ran here, installed ticks what is on this computer, default ticks what the catalog ships on; an agent wsp cannot open a thread on is off unless installed. The file is the state, so a second call is not a fresh start: naming tick or project lets the rule decide every tick again and throws away the flips a call before it made, and a call that names neither keeps what the file says and puts its own flips on top. Sign-in answers stand through every call whatever the rule, since nothing but the person decides one. Put the heavy rows to the person with their sizes before anything is built, then flip rows with set and run \`wsp init --recipe <out> --non-interactive --json\` from a shell, handing the person each sign-in line it prints, since the sign-ins finish in their browser. Only names and counts are read; nothing a session held is returned.`,
      input: {
        tick: RecipeTick.optional().describe(`which rule decides every tick: ${RECIPE_TICKS.join(", ")}. Naming it re-decides every row from the rule, so any flip an earlier call made goes; absent, the file's own rule and its ticks stand, and used decides a first call and any row the file does not carry`),
        set: z.array(z.string()).optional().describe('rows to flip, "<id>=on" or "<id>=off", applied over whatever decided the row: a catalog id, or the id recipe_scan gives a package one of this computer\'s own package managers has (alsoHere), which ticks that package as a row of its own and installs it by its own road. On a call that names tick or project they sit over the rule\'s fresh answer; on any other call they sit over the ticks already in the file'),
        signin: z.array(z.string()).optional().describe(`what happens to a row's sign-in, "<id>=${LOGIN_CHOICES.join("|")}"; key brings the key files beside its login and the login still runs on the machine. An answer already in the file stands until a later call names that row again, whatever tick or project do to the ticks`),
        add: z.array(z.string()).optional().describe('tools neither the catalog carries nor this computer has, "<id>=<install command>"; the line runs on the machine as given after every catalog install, and such a row is never offered a sign-in. A package recipe_scan already lists under alsoHere is refused here and ticked with set instead, since it is a row of its own. Rows an earlier call added stand, whatever tick or project do to the ticks'),
        add_check: z.array(z.string()).optional().describe('what proves an added tool landed, "<id>=<command that exits 0>"; without one the id on PATH is the check'),
        why: z.string().optional().describe("what the rows this call adds are for, in your own words; absent, they say an agent added them"),
        project: WEIGH_BY_FOLDERS,
        out: z.string().optional().describe("where the recipe file goes, absolute; absent means the host's own recipe.json beside its state"),
      },
      output: RecipeAnswer.shape,
      call: async ({ tick, set, signin, add, add_check: addCheck, why, project, out }, deps) => {
        const table = await runRecipe(nodeHost(), {
          out: out === undefined ? smallRecipePath(deps.statePath) : absolutePath("out is a path on this computer", out),
          cache: historyCache(deps.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(set !== undefined ? { set } : {}),
          ...(signin !== undefined ? { signin } : {}),
          ...(add !== undefined ? { add } : {}),
          ...(addCheck !== undefined ? { addCheck } : {}),
          ...(why !== undefined ? { why } : {}),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(recipePrintout(table).join("\n"), table);
      },
    }),
  },
  {
    name: "new",
    usage: "wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>]",
    about: "a workspace from the golden's head or, with --from, a project golden; --size picks a size",
    options: { from: { type: "string" }, size: { type: "string" } },
    run: async ctx => {
      const [name] = ctx.args;
      if (name === undefined || ctx.args.length !== 1) throw usageRefusal("wsp new takes one name");
      const client = await ctx.client();
      const from = flag(ctx.flags, "from");
      const size = flag(ctx.flags, "size");
      if (from === undefined) await createFromHead(client, ctx.out, name, size);
      else await create(client, ctx.out, (await projectGoldenOf(client, from)).snapshotId, name, size);
      return 0;
    },
    tool: tool({
      description: "A new workspace forked from the golden image's head, or with from, from a project golden (the project already in place), booted and reachable when this returns.",
      input: { name: z.string(), from: z.string().optional().describe("a project golden: its project's name (the newest taken of it) or its snapshot id, as snapshot returns them"), size: SizeIn },
      output: Created.shape,
      call: async ({ name, from, size: word }, deps) => {
        const client = await deps.client();
        if (from === undefined) return asJson(await createFromHead(client, QUIET, name, word));
        return asJson(await create(client, QUIET, (await projectGoldenOf(client, from)).snapshotId, name, word));
      },
    }),
  },
  {
    name: "snapshot",
    usage: "wsp snapshot <workspace>",
    about: "a project golden of the workspace: its golden plus the project as it is now, ready to fork",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp snapshot takes one workspace");
      const projectGolden = await snapshot(await ctx.client(), ref);
      ctx.out.emit({ projectGolden }, projectGoldenLine(projectGolden));
      return 0;
    },
    tool: tool({
      description: "A project golden of the workspace: its golden version plus the project loaded on it as it stands now, ready for new with from. Only a running first-life machine with a project imported can be snapshotted; anything else is refused in one line and nothing is taken.",
      input: { workspace: WorkspaceIn },
      output: { projectGolden: ProjectGolden },
      call: async ({ workspace: ref }, deps) => asJson({ projectGolden: await snapshot(await deps.client(), ref) }),
    }),
  },
  {
    name: "fork",
    usage: 'wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>] [--send "<task>" [thread new\'s flags]]',
    about: "a new machine from the source's golden version, not a copy of its live disk; --size as new's",
    options: { name: { type: "string" }, size: { type: "string" }, send: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp fork takes one workspace");
      const task = flag(ctx.flags, "send");
      for (const dependent of ["agent", ...PICK_FLAGS, "cwd", "notify"]) if (task === undefined && flag(ctx.flags, dependent) !== undefined) throw usageRefusal(`--${dependent} needs --send`);
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      if (workspaceState({ phase: source.phase }) === "gone") throw new Error(goneRefusal("fork", source.gone));
      // Resolved and checked before the machine is minted, so a bad reference or pick costs nothing.
      const notify = await notifyOf(client, flag(ctx.flags, "notify"));
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      if (task !== undefined) await checkedStart(client, task, harness, picks);
      const created = await create(client, ctx.out, source.golden, flag(ctx.flags, "name") ?? `${source.name}-fork`, flag(ctx.flags, "size"));
      if (task === undefined) return 0;
      ctx.out.emit({ turn: turnView(await followVerb(ctx, client, openingOf(created.workspace, task, { harness, ...picks, cwd: flag(ctx.flags, "cwd"), notify }), true)) });
      return 0;
    },
    tool: tool({
      description: "A sibling workspace from the source's golden version (a new machine, not a copy of its live disk); with a task, its first thread is opened and the reply returned. When that first turn fails, the error still names the workspace, which exists: continue with thread_new on it rather than forking again.",
      input: { workspace: WorkspaceIn, name: z.string().optional().describe("defaults to <source>-fork"), size: SizeIn, task: z.string().optional(), agent: AgentIn, ...PICK_INPUTS, cwd: CwdIn, notify: NotifyIn },
      output: Created.extend({ turn: TurnOut.optional(), failure: z.string().optional() }).shape,
      stream: ["workspace", "notice"],
      call: async ({ workspace: ref, name, size: word, task, agent: harness, cwd: folder, notify: tell, ...input }, deps) => {
        absoluteFolder(folder);
        const client = await deps.client();
        const source = await workspaceOf(client, ref);
        if (task !== undefined) await checkedStart(client, task, harness, input);
        const created = await create(client, QUIET, source.golden, name ?? `${source.name}-fork`, word);
        if (task === undefined) return asJson(created);
        let failure: string;
        try {
          const turn = await follow(client, openingOf(created.workspace, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell) }), "agent", QUIET_TURN);
          const ended = turnFailure(turn);
          if (ended === undefined) return asJson({ ...created, turn: turnView(turn) });
          failure = ended;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
        return { ...asText(`created ${created.workspace.name} ${created.workspace.id}; first turn failed: ${failure}`, { ...created, failure }), isError: true };
      },
    }),
  },
  {
    name: "pause",
    usage: "wsp pause <workspace>",
    about: "naps the workspace's machine",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp pause takes one workspace");
      const workspace = await nap(await ctx.client(), ref);
      ctx.out.emit({ workspace }, stateLine(workspace));
      return 0;
    },
    tool: tool({
      description: "Naps the workspace's machine; it wakes on the next thread or command.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceView },
      call: async ({ workspace: ref }, deps) => asJson({ workspace: await nap(await deps.client(), ref) }),
    }),
  },
  {
    name: "wake",
    usage: "wsp wake <workspace>",
    about: "wakes the workspace's machine and prints its state once the runtime has answered",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp wake takes one workspace");
      const client = await ctx.client();
      const workspace = await awake(client, await workspaceOf(client, ref), "wake", line => ctx.io.error(line));
      ctx.out.emit({ workspace }, stateLine(workspace));
      return 0;
    },
    tool: tool({
      description: "Wakes the workspace's machine and returns its view once the runtime has answered; one already running comes back unchanged. thread_new, send and exec do this themselves, so it is only needed to wake a machine ahead of them.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceView },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        return asJson({ workspace: await awake(client, await workspaceOf(client, ref), "wake", QUIET_LINE) });
      },
    }),
  },
  {
    name: "forget",
    usage: "wsp forget <workspace> [--yes]",
    about: "drops a gone workspace and its threads from this computer; refused while its machine exists",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp forget takes one workspace");
      const client = await ctx.client();
      const f = await dropping(client, ref);
      if (!(await confirmed(ctx, forgetQuestion(f), f))) return 1;
      await forget(client, f);
      ctx.out.emit({ workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads }, forgotLine(f));
      return 0;
    },
    tool: tool({
      description:
        "Drops a workspace whose machine the provider no longer has: its record and its threads leave this computer and the person's sidebar, and nothing is asked of the provider. Refused in one line while the machine still exists (pause it, or delete it at the provider, first).",
      input: { workspace: WorkspaceIn },
      output: { workspaceId: z.string(), name: z.string(), threads: z.number().int() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const f = await dropping(client, ref);
        await forget(client, f);
        return asText(forgotLine(f), { workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads });
      },
    }),
  },
  {
    name: "delete",
    usage: "wsp delete <workspace> [--yes]",
    about: "deletes the machine at the provider, then drops the record and threads from this computer",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp delete takes one workspace");
      const client = await ctx.client();
      const d = await dropping(client, ref);
      if (!(await confirmed(ctx, deleteQuestion(d), d))) return 1;
      await deleteWorkspace(client, d);
      ctx.out.emit({ workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads }, deletedLine(d));
      return 0;
    },
    tool: tool({
      description:
        "Deletes the workspace's machine at the provider and drops its record and its threads from this computer and the person's sidebar. Everything on that machine's disk that was not exported or pushed goes with it and no wake brings it back; a workspace whose machine is already gone takes forget instead. Called without confirm it deletes nothing and answers with what would go, which is the line to put to the person.",
      input: { workspace: WorkspaceIn, confirm: ConfirmIn },
      output: { workspaceId: z.string(), name: z.string(), machineId: z.string(), threads: z.number().int() },
      call: async ({ workspace: ref, confirm }, deps) => {
        const client = await deps.client();
        const d = await dropping(client, ref);
        const going = { workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads };
        // The command line asks a person before this and the app will; over MCP the second call is that step, so a
        // machine is never killed by one tool call the caller made on its own.
        if (confirm !== true) {
          return { ...asText(`${d.workspace.name} kept. ${deleteNotice(d.threads)} Ask the person, then call delete again with confirm true.`, going), isError: true };
        }
        await deleteWorkspace(client, d);
        return asText(deletedLine(d), going);
      },
    }),
  },
  {
    name: "thread new",
    usage: 'wsp thread new --in <workspace> [--agent, --model, --effort, --access, --cwd, --notify] "<task>"',
    about: "opens a thread with the agent, model, effort and access the app offers; follows its first turn",
    options: { in: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string" } },
    run: async ctx => {
      const [task] = ctx.args;
      const within = flag(ctx.flags, "in");
      if (within === undefined) throw usageRefusal("wsp thread new needs --in <workspace>");
      if (task === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread new takes one task");
      const client = await ctx.client();
      const found = await workspaceOf(client, within);
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      await checkedStart(client, task, harness, picks);
      const workspace = await awake(client, found, "send", line => ctx.io.error(line));
      ctx.out.emit(turnView(await followVerb(ctx, client, openingOf(workspace, task, { harness, ...picks, cwd: flag(ctx.flags, "cwd"), notify: await notifyOf(client, flag(ctx.flags, "notify")) }), true)));
      return 0;
    },
    tool: tool({
      description: `Opens a thread in the workspace under the named agent, on the model, effort and access mode named or the catalog's defaults (a cheaper model for a review, say), in the folder cwd names or the workspace's project folder, and follows its first turn; returns the reply text as soon as it is complete, with the thread id for send. ${TURN_END_WORDS}. With notify, each turn of the thread sends one line (outcome, duration, cost, last line of the reply) into the named thread, so a caller need not wait here or poll. ${NOTIFY_WORDS}.`,
      input: { workspace: WorkspaceIn, task: z.string(), agent: AgentIn, ...PICK_INPUTS, cwd: CwdIn, notify: NotifyIn },
      output: TurnOut.shape,
      call: async ({ workspace: ref, task, agent: harness, cwd: folder, notify: tell, ...input }, deps) => {
        const client = await deps.client();
        const found = await workspaceOf(client, ref);
        await checkedStart(client, task, harness, input);
        const target = await awake(client, found, "send", QUIET_LINE);
        const out = turnOut(await follow(client, openingOf(target, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell) }), "agent", QUIET_TURN));
        return asText(turnText(out), out);
      },
    }),
  },
  {
    name: "send",
    usage: 'wsp send <thread> [--model, --effort, --access <value>] "<message>"',
    about: "a message to the thread, on a named model, effort or access; a running turn keeps its own",
    options: PICK_OPTIONS,
    run: async ctx => {
      const [ref, message] = ctx.args;
      if (ref === undefined || message === undefined || ctx.args.length !== 2) throw usageRefusal("wsp send takes a thread and one message");
      const client = await ctx.client();
      const picks = pickFlags(ctx.flags);
      const thread = await threadOf(client, ref);
      await checkedStart(client, message, thread.harness, picks);
      await awake(client, await workspaceOf(client, thread.workspaceId), "send", line => ctx.io.error(line));
      ctx.out.emit(turnView(await followVerb(ctx, client, messageTo(thread, message, picks), false, picks)));
      return 0;
    },
    tool: tool({
      description: `Sends a message to an existing thread (by id, or a prefix of it) and returns the reply when it is complete; a person's message on the same thread lands in order with yours. A model, effort or access named here is the turn's; a turn that joins a running one keeps that one's. ${SEND_MEETS}`,
      input: { thread: z.string(), message: z.string(), ...PICK_INPUTS },
      output: TurnOut.shape,
      call: async ({ thread: ref, message, ...input }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await checkedStart(client, message, thread.harness, input);
        await awake(client, await workspaceOf(client, thread.workspaceId), "send", QUIET_LINE);
        const out = turnOut(await follow(client, messageTo(thread, message, input), "agent", QUIET_TURN));
        return asText(turnText(out), out);
      },
    }),
  },
  {
    name: "stop",
    usage: "wsp stop <thread>",
    about: "stops the thread's running turn, as the app's stop does; the machine stays up",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp stop takes one thread");
      const stopped = await stop(await ctx.client(), ref);
      ctx.out.emit(stopped, stopLine(stopped));
      return 0;
    },
    tool: tool({
      description: "Stops the thread's running turn (by id, or a prefix of it), as the app's stop button does; the machine stays up and the thread takes the next send. outcome accepted means the turn ended interrupted; not-running means it had already ended, which is an answer, not an error.",
      input: { thread: z.string() },
      output: { threadId: z.string(), outcome: SessionInterruptOutcome },
      call: async ({ thread: ref }, deps) => {
        const stopped = await stop(await deps.client(), ref);
        return asText(stopLine(stopped), { ...stopped });
      },
    }),
  },
  {
    name: "exec",
    usage: "wsp exec <workspace> [--cwd <dir>] -- <command...>",
    about: "runs the command on the machine, each word as given, in --cwd or the project folder",
    options: { cwd: { type: "string" } },
    run: async ctx => {
      const [ref, ...words] = ctx.args;
      if (ref === undefined || words.length === 0) throw usageRefusal("wsp exec takes a workspace, then -- and the command");
      const client = await ctx.client();
      const workspace = await awake(client, await workspaceOf(client, ref), "exec", line => ctx.io.error(line));
      const folder = workFolder(workspace, flag(ctx.flags, "cwd"));
      const exit = await execOn(client, workspace.id, words, folder, e => {
        if (e.type === "exec.output") ctx.out.emit(e, e.text);
      });
      if (exit.error !== undefined) throw new Error(exit.error);
      ctx.out.emit({ exitCode: exit.exitCode, ...(folder !== undefined ? { cwd: folder } : {}) });
      if (exit.exitCode !== null && exit.exitCode !== 0) ctx.io.error(execFolderLine(folder));
      return exit.exitCode ?? EXIT_CODES.provider;
    },
    tool: tool({
      description: "Runs a command on the workspace's machine as argv (each word as given; use sh -c for a shell line), in the folder cwd names or the workspace's project folder, and returns its output lines, exit code and the folder it ran in. A non-zero exit is a result; the machine going away is an error.",
      input: { workspace: WorkspaceIn, argv: Argv, cwd: CwdIn },
      output: { exitCode: z.number().int().nullable(), output: z.array(z.string()), cwd: z.string().optional().describe("the folder the command ran in; absent, the home folder") },
      stream: ["output"],
      call: async ({ workspace: ref, argv, cwd: folder }, deps) => {
        absoluteFolder(folder);
        const client = await deps.client();
        const target = await awake(client, await workspaceOf(client, ref), "exec", QUIET_LINE);
        const ranIn = workFolder(target, folder);
        const output: string[] = [];
        const exit = await execOn(client, target.id, argv, ranIn, e => {
          if (e.type === "exec.output") output.push(e.text);
        });
        if (exit.error !== undefined) throw new Error(exit.error);
        return asText(output.join("\n"), { exitCode: exit.exitCode, output, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      },
    }),
  },
  {
    name: "import",
    usage: "wsp import <folder> --to <workspace> [--yes] [--keep, --cut <path>] [--agents <ids>] [--replace]",
    about: "lands a folder on the machine at its path here; the plan first, then --yes or one question",
    options: { to: { type: "string" }, yes: { type: "boolean" }, keep: { type: "string", multiple: true }, cut: { type: "string", multiple: true }, agents: { type: "string" }, replace: { type: "boolean" } },
    run: async ctx => {
      const [folder] = ctx.args;
      const to = flag(ctx.flags, "to");
      if (to === undefined) throw usageRefusal("wsp import needs --to <workspace>");
      if (folder === undefined || ctx.args.length !== 1) throw usageRefusal("wsp import takes one folder on this computer");
      const source = resolve(folder);
      const named = agentsFlag(flag(ctx.flags, "agents"));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, to);
      const refusal = actionRefusal(workspaceState({ phase: workspace.phase }), "import", workspace.gone);
      if (refusal !== null) throw new Error(refusal);
      const plan = await planProject(client, source);
      const keep = flagList(ctx.flags, "keep");
      const cut = flagList(ctx.flags, "cut");
      const ticked = secretsChosen(plan, keep, cut);
      const agents = agentsChosen(plan, named);
      ctx.out.emit({ plan }, planLines(plan, ticked, agents).join("\n"));
      if (!importConsented({ yes: ctx.flags["yes"] === true, keep, cut })) {
        if (ctx.io.isTTY !== true) {
          ctx.io.error(PLAN_ONLY);
          return 0;
        }
        if ((await ctx.io.ask(IMPORT_NOW)) !== "yes") return 0;
      }
      let done = "";
      try {
        const imported = await importProject(client, workspace.id, importRequest(plan, source, ticked, agents, ctx.flags["replace"] === true), e => {
          if (e.stage === "done") done = e.message;
          else if (e.stage !== "failed") ctx.out.stream(`${e.message}\n`);
        });
        ctx.out.emit({ imported }, done);
        return 0;
      } catch (e) {
        throw withReplaceHint(e);
      }
    },
    tool: tool({
      description:
        "Lands a project folder from this computer on the workspace's machine at the same path, as the app's import dialog does, with the sessions of the agents named keyed to it there. Called without yes, keep or cut it uploads nothing and answers with the plan: the repository, files and size, the caches left behind, each secret-shaped file with its default (cut, unless a rewrite that removes the credential is offered) and each agent with sessions for the folder; put those rows to the person, then call again with yes true for the defaults or keep and cut per row. Refused in one line while the workspace is not running.",
      input: {
        workspace: WorkspaceIn,
        folder: z.string().describe("the folder on this computer, absolute; it lands at this path on the machine"),
        yes: z.boolean().optional().describe("true imports with the plan's defaults; absent or false answers with the plan and imports nothing unless keep or cut is given"),
        keep: z.array(z.string()).optional().describe("secret-shaped paths from the plan, relative to the folder, that travel (as they are, or rewritten when the plan offers it)"),
        cut: z.array(z.string()).optional().describe("secret-shaped paths from the plan that stay behind, for rows the plan would carry rewritten"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions travel, each with sessions in the plan; absent means every agent the plan lists with readable sessions"),
        replace: z.boolean().optional().describe("remove what is at the path on the machine first; without it an existing folder there is refused"),
      },
      output: { plan: ProjectPlan, imported: ProjectImportResult.optional() },
      stream: ["plan"],
      call: async ({ workspace: ref, folder, yes, keep = [], cut = [], agents, replace }, deps) => {
        const client = await deps.client();
        const target = await workspaceOf(client, ref);
        const refusal = actionRefusal(workspaceState({ phase: target.phase }), "import", target.gone);
        if (refusal !== null) throw new Error(refusal);
        const plan = await planProject(client, folder);
        const ticked = secretsChosen(plan, keep, cut);
        const chosen = agentsChosen(plan, agents);
        const lines = planLines(plan, ticked, chosen).join("\n");
        if (!importConsented({ yes, keep, cut })) return asText(`${lines}\n${PLAN_ONLY_TOOL}`, { plan });
        let done = "";
        const imported = await importProject(client, target.id, importRequest(plan, folder, ticked, chosen, replace), e => {
          if (e.stage === "done") done = e.message;
        });
        return asText(done, { plan, imported });
      },
    }),
  },
  {
    name: "export",
    usage: "wsp export <workspace> <folder> [--from <path on the machine>] [--replace] [--agents <ids>]",
    about: "brings a project folder and the agent sessions keyed to it home from the machine",
    options: { from: { type: "string" }, replace: { type: "boolean" }, agents: { type: "string" } },
    run: async ctx => {
      const [ref, folder] = ctx.args;
      if (ref === undefined || folder === undefined || ctx.args.length !== 2) throw usageRefusal("wsp export takes a workspace and a folder on this computer");
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
        ctx.out.emit(exported, done);
        return 0;
      } catch (e) {
        throw withReplaceHint(e);
      }
    },
    tool: tool({
      description:
        "Brings a project folder and the agent sessions keyed to it home from the workspace's machine to this computer: the folder lands at `folder` (absolute, must not exist unless replace), the sessions in the agents' homes here keyed to it. `from` is the folder's path on the machine, the same path as `folder` when absent. The result says per agent what moved, what landed as transcripts only, and how many indexed rollouts were skipped.",
      input: {
        workspace: WorkspaceIn,
        folder: z.string().describe("where the folder lands on this computer, absolute"),
        from: z.string().optional().describe("the folder's path on the machine; defaults to folder"),
        replace: z.boolean().optional().describe("remove what is at folder first; without it an existing folder is refused"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions come home; absent means every agent with sessions for the folder"),
      },
      output: ProjectExportResult.shape,
      call: async ({ workspace: ref, folder, from, replace, agents }, deps) => {
        const client = await deps.client();
        const target = await workspaceOf(client, ref);
        const req: ExportRequest = { source: from ?? folder, dest: folder, ...(replace !== undefined ? { replace } : {}), ...(agents !== undefined ? { agents } : {}) };
        let done = "";
        const exported = await exportProject(client, target.id, req, e => {
          if (e.stage === "done") done = e.message;
        });
        return asText(done, exported);
      },
    }),
  },
];

/** The entries the command line answers, in the help's order. */
export const CLI_VERBS: readonly CliVerb[] = VERBS.filter((v): v is CliVerb => "run" in v);

/** The verb whose words open argv, the longest first, so `thread new` wins over a verb named `thread`. */
export function findVerb(argv: ReadonlyArray<string>): CliVerb | undefined {
  return [...CLI_VERBS].sort((a, b) => b.name.length - a.name.length).find(v => {
    const words = v.name.split(" ");
    return words.every((w, i) => argv[i] === w);
  });
}

/** Every line of help fits this many columns. */
const HELP_WIDTH = 80;

/** The verb's about behind the indent, wrapped to the help's width. */
const aboutLines = (verb: CliVerb, indent: string): string[] => wrap(`${indent}${verb.about}`, HELP_WIDTH, indent);

/** The usage wrapped at the gaps between its groups and never inside a bracket, so a flag stays on the line with its
 * value. */
function usageLines(usage: string, indent: string): string[] {
  let depth = 0;
  const grouped = [...usage]
    .map(c => {
      if (c === "[") depth++;
      if (c === "]") depth--;
      return c === " " && depth > 0 ? "\u00a0" : c;
    })
    .join("");
  return wrap(`  ${grouped}`, HELP_WIDTH, indent).map(line => line.replaceAll("\u00a0", " "));
}

/** Each verb for the top-level help: its usage, then what it does indented under it, so no line runs wide. */
export function verbHelp(): string {
  return CLI_VERBS.map(v => [...usageLines(v.usage, "    "), ...aboutLines(v, "      ")].join("\n")).join("\n");
}

/** The usage of every verb that opens with this word, for a command that stopped short of one; none when no verb does. */
export function verbUsage(word: string): string | undefined {
  const usages = CLI_VERBS.filter(v => v.name.split(" ")[0] === word).map(v => `usage: ${v.usage}`);
  return usages.length > 0 ? usages.join("\n") : undefined;
}

/** The parser's refusal or, when the unknown option is a flag other verbs read, the line naming those verbs. */
function parseRefusal(verb: CliVerb, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const named = (e as { code?: unknown }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /^Unknown option '--([^']+)'/.exec(message)?.[1] : undefined;
  if (named === undefined) return message;
  const readers = CLI_VERBS.filter(v => v !== verb && Object.hasOwn(v.options, named)).map(v => `wsp ${v.name}`);
  return readers.length === 0 ? message : foreignFlagLine(`--${named}`, readers, `wsp ${verb.name}`);
}

/** The one line a refusal or a failure leaves on stderr, the failure object under --json and the prose behind its
 * prefix otherwise, and the exit code the failure's class owns. */
export function failed(io: CliIO, json: boolean, e: unknown, prefix = ""): number {
  const failure = verbFailure(e);
  io.error(json ? JSON.stringify(failure) : `${prefix}${failure.error}`);
  return failure.exit;
}

/** A tool call's failure: the text the agent reads, and the object a --json run prints, marked as an error. */
export function toolFailure(e: unknown): CallToolResult {
  const failure = verbFailure(e);
  return { content: [{ type: "text", text: failure.error }], structuredContent: failure, isError: true };
}

/** Whether a line asked for JSON, read off the words before any `--`, for the refusal of a line the parser would not read. */
export function jsonAsked(argv: ReadonlyArray<string>): boolean {
  const cut = argv.indexOf("--");
  return argv.slice(0, cut === -1 ? argv.length : cut).includes("--json");
}

export async function runVerb(verb: CliVerb, argv: ReadonlyArray<string>, io: CliIO, statePathOf: (flag?: string) => string, deps: Pick<VerbDeps, "alsoHere"> = {}): Promise<number> {
  let flags: Flags;
  let args: string[];
  try {
    const parsed = parseArgs({ args: argv.slice(verb.name.split(" ").length), options: { ...COMMON, ...verb.options }, allowPositionals: true });
    flags = parsed.values as Flags;
    args = parsed.positionals;
    absoluteFolder(flag(flags, "cwd"));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(`${parseRefusal(verb, e)}\n\nusage: ${verb.usage}`));
  }
  if (flags["help"] === true) {
    io.log(`usage: ${verb.usage}\n${aboutLines(verb, "  ").join("\n")}\n\n  --json         print the raw protocol values, one JSON line each\n  --state PATH   the state file the host serves`);
    return 0;
  }
  const statePath = statePathOf(flag(flags, "state"));
  let client: HostClient | undefined;
  const ctx: VerbContext = {
    args,
    flags,
    io,
    out: formatter(io, flags["json"] === true),
    statePath,
    ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
    client: async () => (client ??= await dialHost(statePath)),
  };
  try {
    return await verb.run(ctx);
  } catch (e) {
    return failed(io, flags["json"] === true, e, `wsp ${verb.name}: `);
  } finally {
    client?.close();
  }
}
