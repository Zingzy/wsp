// SPDX-License-Identifier: AGPL-3.0-only
// The verbs a person or a local agent runs beside the app: thin clients of
// the host's protocol on localhost, authenticated with the token the host
// wrote to the state dir. One command table, one dial, one output formatter;
// a verb is a function from its parsed arguments and the client to an exit
// code. The MCP server is a second door onto the same exported functions.
// Nothing here reads a key or imports the runtime: the host is the only
// process that talks to the provider.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import WebSocket from "ws";
import {
  foldThreads,
  goldenHead,
  workspaceState,
  workspaceWord,
  type ExecEvent,
  type GoldenManifest,
  type SessionEvent,
  type SessionOrigin,
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
    if (frame.ok !== true) throw new Error(typeof frame["error"] === "string" ? frame["error"] : `${op} failed`);
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
 * only known once the reply lands, and the host may push the first frame right behind it. */
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
    stop: off,
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

function threadLine(t: ThreadRow): string[] {
  return [t.id, t.workspaceName, t.harness, t.status, t.startedBy, t.title];
}

/** Forks the golden's head into a new workspace, the way the app's create does, with the stages streamed as they land. */
export async function createFromHead(client: HostClient, out: Out, name: string): Promise<WorkspaceCreateResult> {
  const { manifest } = await client.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
  const head = goldenHead(manifest);
  if (head === undefined) throw new Error("no golden yet; run wsp init");
  return create(client, out, head.snapshotId, name);
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

/** A turn as a director sees it: the thread it opened or resumed, the harness's result once it ended, and the
 * runtime's reason when the runtime ended it. */
export interface Turn {
  session: SessionView;
  threadId: string;
  result?: TurnResult;
  reason?: string;
}

/** The start that opens a new thread in a workspace, under the named agent or the runtime's default. */
export function openingOf(workspaceId: string, prompt: string, harness?: string): Record<string, unknown> {
  return { workspaceId, prompt, ...(harness !== undefined ? { harness } : {}) };
}

/** The start a message to an existing thread makes: its latest turn resumed under the thread's own agent. */
export function resumeOf(thread: ThreadView, prompt: string): Record<string, unknown> {
  if (thread.claudeSessionId === undefined) throw new Error(`thread ${thread.id} has no session to resume yet`);
  return { workspaceId: thread.workspaceId, prompt, harness: thread.harness, resume: thread.claudeSessionId };
}

/** Starts a turn as `startedBy` and follows it to its end: `on.started` sees the thread as soon as the runtime names
 * it, `on.event` every event of the turn with the turn so far. Fails when the host goes away first. */
export async function follow(
  client: HostClient,
  start: Record<string, unknown>,
  startedBy: SessionOrigin,
  on: { started?(turn: Turn): void; event(e: SessionEvent, turn: Turn): void },
): Promise<Turn> {
  const pushed = pushedFrames(client);
  await client.events();
  const { session } = await client.request<{ session: SessionView }>("sessions.start", { ...start, startedBy });
  const threadId = session.threadId;
  if (threadId === undefined) throw new Error("the runtime stamped no thread on the session");
  const turn: Turn = { session, threadId };
  on.started?.(turn);
  const ended = new Promise<Turn>(done => {
    pushed.follow(
      f => sessionEvent(f) && f.threadId === threadId,
      f => {
        const e = f as unknown as SessionEvent;
        if (e.type === "session.done") turn.result = e.result;
        if (e.type === "session.end" && e.reason !== undefined) turn.reason = e.reason;
        on.event(e, turn);
        if (e.type === "session.end") done(turn);
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

/** The verbs' way through a turn: text streams to stderr as it arrives, the last message is printed on stdout when
 * the turn ends, with --json every event of the turn is printed instead; the failure is one line on stderr, exit 1. */
async function followVerb(ctx: VerbContext, client: HostClient, start: Record<string, unknown>, announce: boolean): Promise<number> {
  const turn = await follow(client, start, "cli", {
    ...(announce
      ? { started: (t: Turn) => ctx.out.emit({ type: "thread", id: t.threadId, workspaceId: t.session.workspaceId, harness: t.session.harness, startedBy: t.session.startedBy }, `thread ${t.threadId}`) }
      : {}),
    event: (e, t) => {
      ctx.out.emit(e, e.type === "session.end" ? t.result?.text : undefined);
      if (e.type === "session.delta" && e.kind === "text") ctx.out.stream(e.text);
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
    usage: "wsp new <name>",
    about: "a workspace forked from the golden's head",
    options: {},
    run: async ctx => {
      const [name] = ctx.args;
      if (name === undefined || ctx.args.length !== 1) throw new Error("wsp new takes one name");
      await createFromHead(await ctx.client(), ctx.out, name);
      return 0;
    },
  },
  {
    name: "fork",
    usage: 'wsp fork <workspace> [--name <name>] [--send "<task>" [--agent <name>]]',
    about: "a new machine from the source's golden version, not a copy of its live disk",
    options: { name: { type: "string" }, send: { type: "string" }, agent: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw new Error("wsp fork takes one workspace");
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      const created = await create(client, ctx.out, source.golden, flag(ctx.flags, "name") ?? `${source.name}-fork`);
      const task = flag(ctx.flags, "send");
      if (task === undefined) return 0;
      return followVerb(ctx, client, openingOf(created.workspace.id, task, flag(ctx.flags, "agent")), true);
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
    name: "threads",
    usage: "wsp threads [--in <workspace>]",
    about: "every thread as the sidebar lists it: agent, state, who opened it",
    options: { in: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw new Error("wsp threads takes no positional arguments");
      const rows = await threadRows(await ctx.client(), flag(ctx.flags, "in"));
      ctx.out.emit({ threads: rows.map(({ workspaceName: _name, ...t }) => t) }, table([["THREAD", "WORKSPACE", "AGENT", "STATE", "BY", "TITLE"], ...rows.map(threadLine)]).join("\n"));
      return 0;
    },
  },
  {
    name: "thread new",
    usage: 'wsp thread new --in <workspace> [--agent <name>] "<task>"',
    about: "opens a thread in the workspace and follows its first turn",
    options: { in: { type: "string" }, agent: { type: "string" } },
    run: async ctx => {
      const [task] = ctx.args;
      const within = flag(ctx.flags, "in");
      if (within === undefined) throw new Error("wsp thread new needs --in <workspace>");
      if (task === undefined || ctx.args.length !== 1) throw new Error("wsp thread new takes one task");
      const client = await ctx.client();
      const workspace = await workspaceOf(client, within);
      return followVerb(ctx, client, openingOf(workspace.id, task, flag(ctx.flags, "agent")), true);
    },
  },
  {
    name: "send",
    usage: 'wsp send <thread> "<message>"',
    about: "a message to the thread; follows the turn, prints the last message",
    options: {},
    run: async ctx => {
      const [ref, message] = ctx.args;
      if (ref === undefined || message === undefined || ctx.args.length !== 2) throw new Error("wsp send takes a thread and one message");
      const client = await ctx.client();
      return followVerb(ctx, client, resumeOf(await threadOf(client, ref), message), false);
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
  notYet("export", "wsp export <workspace> <folder>", {}, "bringing a workspace's project folder home"),
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
