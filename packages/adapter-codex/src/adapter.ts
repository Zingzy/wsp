// SPDX-License-Identifier: AGPL-3.0-only
// Drives one Codex turn through `codex app-server` and normalizes what the
// server prints into the event set the runtime consumes. One server process
// per turn, launched the way any turn is: initialize, then thread/start (or
// thread/resume), then turn/start once the thread answers. The turn ends at
// the server's turn/completed; stdin closes there and the server exits on the
// EOF. A message offered mid-turn is turn/steer, an approval the server asks
// for is answered on the same stdin. Shapes are codex-cli 0.155.1's own schema
// (`codex app-server generate-json-schema`).
import { randomUUID } from "node:crypto";
import {
  INTERRUPT_GRACE_MS,
  PERMISSION_ALLOW,
  PERMISSION_DENY,
  ASIDE_WALL_MS,
  RUN_EXIT_MS,
  asideWallLine,
  codexKeyRefusedLine,
  codexMissingEnvLine,
  codexNotSignedInLine,
  codexReconnectLine,
  endAfterResult,
  endRun,
  limitKindOfMinutes,
  titlePrompt,
} from "@wsp/protocol";
import type {
  AdapterAttachOptions,
  AdapterEvent,
  ExecStream,
  ExecStreamFactory,
  HarnessCatalogAnswer,
  McpServerSpec,
  PermissionAsk,
  PermissionOutcome,
  SessionAsker,
  SessionRenamer,
  SessionReverter,
  SessionTitleMaker,
  CommitDrafter,
  SessionTitleReader,
  TurnImage,
  TurnRefusal,
  TurnResult,
  PlanStep,
  TurnTokens,
  HarnessLimit,
  LimitWindow,
} from "@wsp/protocol";
import { catalogProbeCommand, parseCatalogProbe } from "./catalog.js";
import { accessParams, buildCommand, buildEnv, imagePath } from "./command.js";
import {
  INITIALIZED_LINE,
  REQUEST,
  ACCOUNT_READ_LINE,
  RATE_LIMITS_READ_LINE,
  decisionLine,
  initializeLine,
  readMessage,
  refuseRequestLine,
  threadForkLine,
  threadResumeLine,
  threadRevertLine,
  threadStartLine,
  turnInterruptLine,
  turnStartLine,
  turnSteerLine,
  type RequestId,
} from "./rpc.js";
import { draftForCommand, parseDraftFor, parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "./session-title.js";

export interface CodexStartOptions {
  prompt: string;
  /** The thread id an earlier turn announced; the server reloads that thread. */
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** The model's faster output for this turn. */
  fast?: boolean;
  /** Images for this turn, read off their paths: the server reads each off the machine's disk, where the runtime
   * landed it under the thread's images folder before the start. */
  images?: readonly TurnImage[];
  /** MCP servers this turn gets besides the ones its config names, each rendered as a config override. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  onEvent: (event: AdapterEvent) => void;
}

export interface CodexSession {
  /** Registry key: the resume id, or one minted here, since the server names a new thread only once it runs. */
  readonly localId: string;
  /** The id the server gave the thread, equal to localId until it does. */
  readonly threadId: string;
  /** The line the launch ran; absent on a session attached to a run some earlier process launched. */
  readonly command?: string;
  /** What a later host process attaches to this turn by; absent when its run dies with this process. */
  readonly run?: string;
  /** The process this turn leads on the computer the host runs on, where it runs there; absent on a turn running on
   * another machine. */
  readonly pid?: number;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** turn/steer on the running turn; not-running before the server started it, after it ended, and when the server
   * turns the message down. */
  steer(prompt: string): Promise<"accepted" | "not-running">;
  /** Answers an approval the server asked for with accept or decline; gone when no such request is open. */
  answer(askId: string, answer: { optionId: string; outcome: PermissionOutcome; denyMessage: string }): Promise<"answered" | "gone">;
}

export interface CodexAdapterDeps {
  exec: ExecStreamFactory;
  /** CODEX_HOME on the machine. */
  home: string;
  /** The catalog's command for signing codex in on a machine, named when a turn fails for want of one. */
  login: string;
  /** The API key the vault holds for this agent; set on every turn's environment. */
  apiKey?: string;
  /** The variable that key travels under, for the sentence a turn fails with when the provider turns it down.
   * Absent where no key was handed, which is what tells a refused key from no credential at all. */
  keyEnv?: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  interruptGraceMs?: number;
  /** How long the server gets to exit on its own after its turn completed, before its process and its tree are
   * ended for it. */
  resultExitMs?: number;
  /** How long a run of Reconnecting errors with no turn progress may last before the turn is failed. */
  reconnectStallMs?: number;
  /** How long a side question may run before its process is ended; ASIDE_WALL_MS unless a test says otherwise. */
  asideWallMs?: number;
}

export interface CodexAdapter {
  start(options: CodexStartOptions): CodexSession;
  /** Re-opens a turn the server is still running on the machine, by the run handle the launch reported; `gone` is
   * the machine's own answer that it no longer holds the run, and nothing is emitted for one. A machine that
   * answers nothing rejects. Absent when the exec factory's runs die with the process that launched them. */
  attach?(options: AdapterAttachOptions): Promise<CodexSession | "gone">;
  readonly sessions: ReadonlyMap<string, CodexSession>;
  /** The server takes turn/steer while a turn runs. */
  readonly steers: true;
  /** The server takes images as local paths, so each one lands on the machine before the turn starts. */
  readonly attachments: "file";
  /** Servers ride the launch as `-c mcp_servers.<name>...` overrides over the config under CODEX_HOME. */
  readonly mcpServers: true;
  /** Makes the binary describe itself under the same home as a session, without running a turn. */
  probeCatalog(exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer>;
  /** What the CLI's thread index calls a thread: the name the person gave it, or the title it derived. */
  sessionTitle: SessionTitleReader;
  /** Names the thread in that same index, in the column the CLI's own rename writes. */
  renameSession: SessionRenamer;
  /** Asks the CLI itself, in one read-only turn, for a name for a thread it has just replied in. */
  titleFor: SessionTitleMaker;
  draftFor: CommitDrafter;
  /** Answers a question about a thread on an ephemeral fork of it, leaving the thread as it was. */
  aside: SessionAsker;
  /** Cuts the thread's own history before one of its turns; files are the checkpoint's business, not the server's. */
  revert: SessionReverter;
  readonly env: Readonly<Record<string, string>>;
}

type Item = Record<string, unknown> & { id: string; type: string };

/** The last lines the process printed that were not messages: codex's stderr shares the log with its stdout. */
const STDERR_TAIL_LINES = 5;
/** A provider that wants an OpenAI login answers 401, which the server retries and then fails the turn on. */
const UNAUTHORIZED = /401 Unauthorized/;
/** A provider whose env_key variable is unset: the CLI names the variable and fails the turn at once. */
const MISSING_ENV = /Missing environment variable: `([^`]+)`/;
/** A provider that refuses connections: the server says this forever, whatever its retry settings say. */
const RECONNECTING = /^Reconnecting\.\.\./;
const RECONNECT_STALL_MS = 90_000;

/** What the CLI said after the status it refused on, as a clause a sentence can carry: its own colon and spaces off
 * the front, and the url and bracket it trails with off the end. Empty where it said nothing. */
function refusedBecause(message: string): string {
  const at = UNAUTHORIZED.exec(message);
  if (at === null) return "";
  const tail = message.slice(at.index + at[0].length).split("\n")[0] ?? "";
  return (tail.replace(/^[:\s]+/, "").split(", url:")[0]?.split(")")[0] ?? "").trim();
}

/** The words for a failure the CLI reported in its own, with what wsp classes it as where it claims a cause;
 * undefined when the CLI's message stands as it is. A 401 is two different things to the person: with a key
 * handed, the provider turned that key down and signing in again fixes nothing; with none, nothing was signed in
 * there at all. */
function failureWords(message: string, login: string, keyEnv?: string): { line: string; cause?: TurnRefusal } | undefined {
  if (UNAUTHORIZED.test(message)) {
    const line = keyEnv === undefined ? codexNotSignedInLine(login) : codexKeyRefusedLine(keyEnv, refusedBecause(message), login);
    return { line, cause: "sign-in" };
  }
  const missing = MISSING_ENV.exec(message);
  return missing === null ? undefined : { line: codexMissingEnvLine(missing[1]!) };
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function itemOf(params: Record<string, unknown>): Item | undefined {
  const item = rec(params.item);
  const id = str(item?.id);
  const type = str(item?.type);
  return item !== undefined && id !== undefined && type !== undefined ? ({ ...item, id, type } as Item) : undefined;
}

/** A change as the timeline reads one: its path and its kind's own word (add, delete, update). */
const changesOf = (changes: unknown): { path: string; kind: string }[] =>
  Array.isArray(changes)
    ? changes
        .map(rec)
        .filter((c): c is Record<string, unknown> => c !== undefined)
        .map(c => ({ path: str(c.path) ?? "", kind: str(rec(c.kind)?.type) ?? str(c.kind) ?? "change" }))
    : [];

const changeLines = (changes: unknown): string =>
  changesOf(changes)
    .map(c => `${c.kind} ${c.path}`.trim())
    .join("\n");

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The fields of a token breakdown the server reports, by the names TurnTokens takes. */
const BREAKDOWN = [
  ["input", "inputTokens"],
  ["cached", "cachedInputTokens"],
  ["cacheWrite", "cacheWriteInputTokens"],
  ["output", "outputTokens"],
  ["reasoning", "reasoningOutputTokens"],
] as const;

/** Where the thread's running total stood as the turn began and the server's latest report of it: `total` is the
 * thread's, `last` the latest call's alone. */
interface UsageSeen {
  before: Record<string, unknown>;
  total: Record<string, unknown>;
  last: Record<string, unknown>;
  window?: number;
}

/** The turn's own tokens: the running total less where it stood before the turn's first call, each field falling back
 * to the latest call's where the total names none. What the model held is that latest call's whole count. */
function turnTokensOf(seen: UsageSeen): TurnTokens {
  const field = (key: string): number | undefined => {
    const total = count(seen.total[key]);
    const before = count(seen.before[key]);
    return total !== undefined && before !== undefined ? total - before : count(seen.last[key]);
  };
  const fields = Object.fromEntries(BREAKDOWN.flatMap(([name, key]) => (field(key) === undefined ? [] : [[name, field(key)!]])));
  const held = (count(seen.last.inputTokens) ?? 0) + (count(seen.last.outputTokens) ?? 0);
  return { input: 0, output: 0, ...fields, context: held, ...(seen.window !== undefined ? { window: seen.window } : {}) };
}

/** A window's reset as ms epoch: the server sends unix seconds, as the rollout's resets_at is. */
const resetMs = (value: number): number => (value < 1e11 ? value * 1000 : value);

/** The plan's windows off a rate-limit snapshot, each read as a kind by its length (the primary is the session and the
 * secondary the week where the server names no length), with the plan and the account account/read named. A limit
 * the backend says was reached reads reached. */
function limitOf(snapshot: Record<string, unknown>, account: { id?: string; label?: string; plan?: string }): HarnessLimit | undefined {
  const windows: LimitWindow[] = [];
  for (const [slot, fallback] of [["primary", 300], ["secondary", 10_080]] as const) {
    const w = rec(snapshot[slot]);
    const used = count(w?.usedPercent);
    if (w === undefined || used === undefined) continue;
    const resetsAt = count(w.resetsAt);
    windows.push({ kind: limitKindOfMinutes(count(w.windowDurationMins) ?? fallback), usedPercent: used, ...(resetsAt !== undefined ? { resetsAt: resetMs(resetsAt) } : {}) });
  }
  if (windows.length === 0) return undefined;
  const plan = str(snapshot.planType) ?? account.plan;
  const id = account.id ?? account.label;
  return {
    windows,
    ...(plan !== undefined ? { plan } : {}),
    status: snapshot.rateLimitReachedType === undefined || snapshot.rateLimitReachedType === null ? "ok" : "reached",
    ...(id !== undefined ? { account: { id, ...(account.label !== undefined ? { label: account.label } : {}) } } : {}),
  };
}

/** The running total as it stood before the call a report's `last` covers. */
const totalBefore = (total: Record<string, unknown>, last: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(BREAKDOWN.flatMap(([, key]) => (count(total[key]) === undefined ? [] : [[key, count(total[key])! - (count(last[key]) ?? 0)]])));

const stepState = (status: unknown): PlanStep["state"] => (status === "completed" ? "done" : status === "inProgress" ? "working" : "pending");

/** Each item as the deltas a timeline draws: a call when it starts, its result when it completes. The tool names are
 * the ones codex exec reported the same calls under, which the clients read. */
function itemDeltas(done: boolean, item: Item, sessionId: string): AdapterEvent[] {
  const delta = (fields: Omit<Extract<AdapterEvent, { type: "turn.delta" }>, "type" | "sessionId">): AdapterEvent => ({ type: "turn.delta", sessionId, ...fields });
  const failed = (): boolean => str(item.status) !== "completed";
  switch (item.type) {
    case "agentMessage":
      return done ? [delta({ kind: "text", text: str(item.text) ?? "", messageId: item.id })] : [];
    case "reasoning": {
      if (!done) return [];
      const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === "string") : [];
      const content = Array.isArray(item.content) ? item.content.filter((s): s is string => typeof s === "string") : [];
      const text = (summary.length > 0 ? summary : content).join("\n");
      return text.length > 0 ? [delta({ kind: "thinking", text })] : [];
    }
    case "commandExecution":
      return done
        ? [delta({ kind: "tool_result", text: str(item.aggregatedOutput) ?? "", toolUseId: item.id, isError: failed() })]
        : [delta({ kind: "tool_use", text: JSON.stringify({ command: str(item.command) ?? "" }), toolName: "command_execution", toolUseId: item.id })];
    case "fileChange":
      return done
        ? [delta({ kind: "tool_result", text: changeLines(item.changes), toolUseId: item.id, isError: failed() })]
        : [delta({ kind: "tool_use", text: JSON.stringify({ changes: changesOf(item.changes) }), toolName: "file_change", toolUseId: item.id })];
    case "mcpToolCall": {
      if (!done) return [delta({ kind: "tool_use", text: JSON.stringify(item.arguments ?? {}), toolName: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`, toolUseId: item.id })];
      const text = failed() ? (str(rec(item.error)?.message) ?? "") : JSON.stringify(rec(item.result)?.content ?? []);
      return [delta({ kind: "tool_result", text, toolUseId: item.id, isError: failed() })];
    }
    case "webSearch":
      return done
        ? [
            delta({ kind: "tool_use", text: JSON.stringify({ query: str(item.query) ?? "" }), toolName: "web_search", toolUseId: item.id }),
            delta({ kind: "tool_result", text: str(item.query) ?? "", toolUseId: item.id, isError: false }),
          ]
        : [];
    default:
      return [];
  }
}

/** What a side question's fork is told, since no Codex turn can run with its tools off. */
const ASIDE_INSTRUCTIONS =
  "The person is asking a side question about this conversation while its work goes on elsewhere. Answer it from the conversation so far, briefly. Run nothing, edit nothing and call no tool.";

/** The two approvals the server raises as a person's allow or deny; every other request it sends is refused. */
const APPROVALS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "command_execution",
  "item/fileChange/requestApproval": "file_change",
};

export function createCodexAdapter(deps: CodexAdapterDeps): CodexAdapter {
  const sessions = new Map<string, CodexSession>();
  const env = buildEnv({ base: deps.baseEnv, home: deps.home, ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}) });
  const graceMs = deps.interruptGraceMs ?? INTERRUPT_GRACE_MS;

  /** Everything a turn is once its stream exists. A launched turn sends turn/start when its thread answers; an
   * attached one replays a log whose turn already started, so it writes nothing in answer to what it reads, and its
   * thread, model and folder come off the row that outlived the host. */
  const follow = (o: {
    stream: ExecStream;
    localId: string;
    startedAt: number;
    command?: string;
    model?: string;
    cwd?: string;
    turnLine?: (threadId: string) => string;
    /** A side question's own run: every approval it raises is declined here, it joins no registry, and it has a wall. */
    aside?: true;
    /** A run that asks the thread one thing and no turn (a revert): declined and unregistered as a side question is. */
    sideRun?: true;
    onEvent: (event: AdapterEvent) => void;
  }): CodexSession => {
    const { stream, localId, startedAt } = o;

    let threadId = localId;
    let announced = false;
    let turnId: string | undefined;
    let exited = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let lastText: string | undefined;
    let usage: UsageSeen | undefined;
    /** The account's plan windows as last read, with the sign-in account/read named, merged across rolling updates. */
    let rateLimits: Record<string, unknown> | undefined;
    let account: { id?: string; label?: string; plan?: string } = {};
    let modelUsed = o.model;
    /** The last failure the stream showed, if any, in wsp's words and under the cause it claims. */
    let words: { line: string; cause?: TurnRefusal } | undefined;
    /** What the server said last in an error, for a process that dies without completing its turn. */
    let lastError: string | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalledAt: number | undefined;
    const stderrTail: string[] = [];
    /** Notes the server printed before the thread had an id to file them under. */
    const early: string[] = [];
    /** The changes each file-change item started with, which its approval request does not repeat. */
    const changesById = new Map<string, unknown>();
    /** Approvals the server is waiting on, by the askId the runtime holds, with the id the server asked under. */
    const pending = new Map<string, { id: RequestId; ask: PermissionAsk }>();
    const steers = new Map<string, (accepted: boolean) => void>();
    let steerSeq = 0;

    const emit = (event: AdapterEvent): void => o.onEvent(event);
    const escalate = (): Promise<void> => endRun(stream, graceMs);
    const progress = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
      stalledAt = undefined;
    };
    /** Armed by the first Reconnecting error after the last progress; a run that outlives it ends the turn in words. */
    const reconnecting = (): void => {
      if (stallTimer !== undefined) return;
      stalledAt = Date.now();
      stallTimer = setTimeout(() => {
        words = { line: codexReconnectLine(Date.now() - (stalledAt ?? startedAt)) };
        void escalate();
      }, deps.reconnectStallMs ?? RECONNECT_STALL_MS);
    };

    const note = (text: string): void => {
      if (announced) emit({ type: "turn.delta", sessionId: threadId, kind: "note", text });
      else early.push(text);
    };

    const announce = (id: string | undefined, model: string | undefined, cwd: string | undefined): void => {
      if (announced) return;
      announced = true;
      threadId = id ?? threadId;
      const runs = o.model ?? model;
      modelUsed = runs;
      const where = o.cwd ?? cwd;
      emit({ type: "session.start", sessionId: threadId, ...(runs !== undefined ? { model: runs } : {}), ...(where !== undefined ? { cwd: where } : {}) });
      for (const text of early.splice(0)) emit({ type: "turn.delta", sessionId: threadId, kind: "note", text });
    };

    const closeAsk = (askId: string, outcome: PermissionOutcome, optionId?: string): void => {
      pending.delete(askId);
      emit({ type: "permission.close", sessionId: threadId, askId, outcome, ...(optionId !== undefined ? { optionId } : {}) });
    };

    const settleSteers = (): void => {
      for (const settle of steers.values()) settle(false);
      steers.clear();
    };

    /** The turn's reply is final: the server waits for more input after it, and EOF is what lets it exit; one that
     * does not go on its own is ended with its tree once the wait passes. */
    const finish = (result: TurnResult): void => {
      if (turnResult !== undefined) return;
      turnResult = result;
      emit({ type: "turn.done", sessionId: threadId, result });
      for (const askId of [...pending.keys()]) closeAsk(askId, "cancelled");
      settleSteers();
      stream.closeInput();
      void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, graceMs).catch(() => {});
    };

    const failed = (message: string): TurnResult => {
      words = failureWords(message, deps.login, deps.keyEnv) ?? words;
      return { status: "failed", durationMs: Date.now() - startedAt, error: words?.line ?? message, ...(words?.cause !== undefined ? { refusal: words.cause } : {}) };
    };

    const emitLimit = (): void => {
      if (rateLimits === undefined) return;
      const limit = limitOf(rateLimits, account);
      if (limit !== undefined) emit({ type: "limit", sessionId: threadId, limit });
    };

    const onRequest = (id: RequestId, method: string, params: Record<string, unknown>): void => {
      const toolName = APPROVALS[method];
      if (toolName === undefined) {
        void stream.write(refuseRequestLine(id, method));
        return;
      }
      if (o.aside === true || o.sideRun === true) {
        void stream.write(decisionLine(id, "decline"));
        return;
      }
      const itemId = str(params.itemId);
      const input =
        toolName === "file_change"
          ? { changes: changesOf(itemId === undefined ? undefined : changesById.get(itemId)) }
          : { command: str(params.command) ?? "", ...(str(params.cwd) !== undefined ? { cwd: str(params.cwd) } : {}) };
      const reason = str(params.reason);
      const ask: PermissionAsk = {
        askId: String(id),
        toolName,
        ...(itemId !== undefined ? { toolUseId: itemId } : {}),
        input: JSON.stringify(input),
        ...(reason !== undefined && reason !== "" ? { detail: reason } : {}),
        options: [
          { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
          { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
        ],
      };
      pending.set(ask.askId, { id, ask });
      emit({ type: "permission.ask", sessionId: threadId, ask });
    };

    const onResponse = (id: RequestId, result: unknown): void => {
      if (id === REQUEST.thread) {
        const answer = rec(result);
        const thread = rec(answer?.thread);
        announce(str(thread?.id), str(answer?.model) ?? str(thread?.model), str(answer?.cwd) ?? str(thread?.cwd));
        if (o.turnLine !== undefined) void stream.write(o.turnLine(threadId));
        return;
      }
      if (id === REQUEST.revert) {
        finish({ status: "completed", durationMs: Date.now() - startedAt });
        return;
      }
      if (id === REQUEST.account) {
        const signIn = rec(rec(result)?.account);
        if (str(signIn?.type) === "apiKey") emit({ type: "limit", sessionId: threadId, limit: { windows: [], keyed: true } });
        const email = str(signIn?.email);
        const plan = str(signIn?.planType);
        account = { ...account, ...(email !== undefined ? { label: email } : {}), ...(plan !== undefined ? { plan } : {}) };
        emitLimit();
        return;
      }
      if (id === REQUEST.rateLimits) {
        const answer = rec(result);
        const accountId = str(answer?.accountId);
        if (accountId !== undefined) account = { ...account, id: accountId };
        rateLimits = rec(answer?.rateLimits);
        emitLimit();
        return;
      }
      const settle = typeof id === "string" ? steers.get(id) : undefined;
      if (settle !== undefined) {
        steers.delete(id as string);
        settle(true);
      }
    };

    const onError = (id: RequestId, message: string): void => {
      const settle = typeof id === "string" ? steers.get(id) : undefined;
      if (settle !== undefined) {
        steers.delete(id as string);
        settle(false);
        return;
      }
      if (id === REQUEST.revert) finish({ status: "failed", error: `codex would not cut the thread: ${message}` });
      else if (id === REQUEST.thread) finish({ status: "failed", error: `codex could not open the thread: ${message}` });
      else if (id === REQUEST.turn || id === REQUEST.initialize) finish({ status: "failed", error: `codex could not start the turn: ${message}` });
    };

    const onNotification = (method: string, params: Record<string, unknown>): void => {
      if (method !== "error") progress();
      switch (method) {
        case "thread/started": {
          const thread = rec(params.thread);
          announce(str(thread?.id), str(thread?.model), str(thread?.cwd));
          break;
        }
        case "turn/started": {
          const first = turnId === undefined;
          turnId = str(rec(params.turn)?.id) ?? turnId;
          if (first && turnId !== undefined) emit({ type: "turn.anchor", sessionId: threadId, anchor: turnId });
          break;
        }
        case "item/started":
        case "item/completed": {
          const item = itemOf(params);
          if (item === undefined) break;
          const done = method === "item/completed";
          if (item.type === "fileChange") changesById.set(item.id, item.changes);
          if (done && item.type === "agentMessage") lastText = str(item.text);
          for (const delta of itemDeltas(done, item, threadId)) emit(delta);
          break;
        }
        case "thread/tokenUsage/updated": {
          const reported = rec(params.tokenUsage);
          const total = rec(reported?.total) ?? {};
          const last = rec(reported?.last);
          if (last === undefined) break;
          const window = count(reported?.modelContextWindow);
          usage = { before: usage?.before ?? totalBefore(total, last), total, last, ...(window !== undefined ? { window } : {}) };
          break;
        }
        case "account/rateLimits/updated": {
          // A rolling update is sparse: what it leaves out, or names null, keeps the last reading's value.
          const update = Object.fromEntries(Object.entries(rec(params.rateLimits) ?? {}).filter(([, value]) => value !== null));
          rateLimits = { ...(rateLimits ?? {}), ...update };
          emitLimit();
          break;
        }
        case "turn/plan/updated": {
          const plan = Array.isArray(params.plan) ? params.plan.map(rec).filter((p): p is Record<string, unknown> => p !== undefined) : [];
          emit({ type: "turn.plan", sessionId: threadId, steps: plan.map(p => ({ text: str(p.step) ?? "", state: stepState(p.status) })) });
          break;
        }
        case "configWarning":
        case "warning": {
          const text = str(params.summary) ?? str(params.message);
          if (text !== undefined) note(text);
          break;
        }
        case "serverRequest/resolved": {
          const askId = params.requestId === undefined ? undefined : String(params.requestId as RequestId);
          if (askId !== undefined && pending.has(askId)) closeAsk(askId, "cancelled");
          break;
        }
        case "error": {
          const error = rec(params.error);
          const message = str(error?.message) ?? "";
          lastError = message;
          words = failureWords(`${message} ${str(error?.additionalDetails) ?? ""}`, deps.login, deps.keyEnv) ?? words;
          if (RECONNECTING.test(message)) reconnecting();
          break;
        }
        case "turn/completed": {
          const turn = rec(params.turn);
          const id = str(turn?.id);
          if (turnId !== undefined && id !== undefined && id !== turnId) break;
          const status = str(turn?.status);
          if (status === "completed")
            finish({ status: "completed", durationMs: Date.now() - startedAt, ...(lastText !== undefined ? { text: lastText } : {}), ...(usage !== undefined ? { tokens: turnTokensOf(usage) } : {}), ...(modelUsed !== undefined ? { model: modelUsed } : {}) });
          else if (status === "interrupted") finish({ status: "interrupted" });
          else finish(failed(str(rec(turn?.error)?.message) ?? "codex reported a failed turn"));
          break;
        }
        default:
          break;
      }
    };

    /** A side question's own limit: a fork that never completes its turn and never says Reconnecting would hold its
     * process and the window's request for good. */
    const asideWallMs = deps.asideWallMs ?? ASIDE_WALL_MS;
    const asideWall =
      o.aside === true
        ? setTimeout(() => {
            words = { line: asideWallLine(asideWallMs) };
            void escalate();
          }, asideWallMs)
        : undefined;

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const message = readMessage(raw);
          if (message === undefined) {
            const text = raw.trim();
            if (text.length > 0 && stderrTail.push(text) > STDERR_TAIL_LINES) stderrTail.shift();
            continue;
          }
          switch (message.kind) {
            case "notification":
              onNotification(message.method, message.params);
              break;
            case "request":
              onRequest(message.id, message.method, message.params);
              break;
            case "response":
              onResponse(message.id, message.result);
              break;
            case "error":
              onError(message.id, message.message);
              break;
          }
        }
      } catch (cause) {
        // The transport ended the turn itself and its message says why; that message is the turn's error.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      if (asideWall !== undefined) clearTimeout(asideWall);
      exited = true;
      progress();
      for (const askId of [...pending.keys()]) closeAsk(askId, "cancelled");
      settleSteers();
      const sawResult = turnResult !== undefined;
      if (turnResult === undefined) {
        const reason = lastError ?? (stderrTail.length === 0 ? undefined : stderrTail.join("\n"));
        const died = `codex exited with code ${String(exitCode)} before its turn ended${reason === undefined ? "" : `: ${reason}`}`;
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : words !== undefined
            ? { status: "failed", error: words.line, ...(words.cause !== undefined ? { refusal: words.cause } : {}) }
            : { status: "failed", error: streamError ?? died };
        emit({ type: "turn.done", sessionId: threadId, result: turnResult });
      }
      emit({ type: "session.end", sessionId: threadId, exitCode, sawResult });
      return turnResult;
    })();

    /** The turn is open to a message: the server started it and it has neither completed nor gone. */
    const running = (): boolean => turnId !== undefined && turnResult === undefined && !exited && !interruptRequested;

    const session: CodexSession = {
      localId,
      get threadId() {
        return threadId;
      },
      ...(o.command !== undefined ? { command: o.command } : {}),
      ...(stream.run !== undefined ? { run: stream.run } : {}),
      ...(stream.pid !== undefined ? { pid: stream.pid } : {}),
      finished,
      steer: async prompt => {
        if (!running() || turnId === undefined) return "not-running";
        const id = `wsp-steer-${++steerSeq}`;
        const answered = new Promise<boolean>(resolve => steers.set(id, resolve));
        const wrote = await stream.write(turnSteerLine(id, { threadId, turnId, text: prompt })).catch(() => "gone" as const);
        if (wrote !== "written") {
          steers.delete(id);
          return "not-running";
        }
        return (await answered) ? "accepted" : "not-running";
      },
      answer: async (askId, answer) => {
        const open = pending.get(askId);
        if (open === undefined || exited) return "gone";
        // Taken off the map before the write, so two answers racing on one request cannot both reach the server.
        pending.delete(askId);
        const wrote = await stream.write(decisionLine(open.id, answer.optionId === PERMISSION_ALLOW ? "accept" : "decline")).catch(() => "gone" as const);
        if (wrote !== "written") return "gone";
        emit({ type: "permission.close", sessionId: threadId, askId, outcome: answer.outcome, optionId: answer.optionId });
        return "answered";
      },
      interrupt: async () => {
        if (exited) return;
        const live = running() ? turnId : undefined;
        interruptRequested = true;
        if (live === undefined) return escalate();
        await stream.write(turnInterruptLine({ threadId, turnId: live })).catch(() => "gone" as const);
        // The server completes an interrupted turn and exits on the EOF that follows; one that does not is ended.
        await endAfterResult(stream, graceMs, graceMs);
      },
    };
    if (o.aside !== true && o.sideRun !== true) sessions.set(localId, session);
    return session;
  };

  /** An image reaches the server as a file, so one that arrived with no path never travelled the runtime's file road
   * and the turn is refused rather than started without it. */
  const imagePathOf = (image: TurnImage): string => {
    if (image.path === undefined) throw new Error("codex reads images off the machine's disk; this one has no path on it");
    return imagePath(image.path);
  };

  const start = (options: CodexStartOptions): CodexSession => {
    if (options.contextWindow !== undefined) throw new Error("codex takes no context window");
    const images = options.images?.map(imagePathOf);
    const access = accessParams(options.permissionMode);
    const localId = options.resume ?? randomUUID();
    const thread = { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.model !== undefined ? { model: options.model } : {}), ...(options.fast === true ? { serviceTier: "fast" as const } : {}), access };
    const threadLine = options.resume === undefined ? threadStartLine(thread) : threadResumeLine({ ...thread, threadId: options.resume });
    const command = buildCommand({ ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}) });
    return follow({
      stream: deps.exec(command, { env: { ...env }, input: [initializeLine(), INITIALIZED_LINE, ACCOUNT_READ_LINE, RATE_LIMITS_READ_LINE, threadLine] }),
      localId,
      startedAt: Date.now(),
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      turnLine: threadId => turnStartLine({ threadId, text: options.prompt, ...(images !== undefined ? { images } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}) }),
      onEvent: options.onEvent,
    });
  };

  /** A question put to a copy of the thread: an ephemeral fork writes no rollout, so the thread's own history and its
   * store are left as they were, and a read-only sandbox that asks nobody is the nearest a Codex turn comes to having
   * no tools. */
  const aside: SessionAsker = async o => {
    const command = buildCommand({ ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) });
    const fork = threadForkLine({ threadId: o.session, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(o.model !== undefined ? { model: o.model } : {}), developerInstructions: ASIDE_INSTRUCTIONS });
    const result = await follow({
      stream: deps.exec(command, { env: { ...env }, input: [initializeLine(), INITIALIZED_LINE, fork] }),
      localId: randomUUID(),
      startedAt: Date.now(),
      command,
      turnLine: threadId => turnStartLine({ threadId, text: o.question }),
      aside: true,
      onEvent: () => {},
    }).finished;
    if (result.status !== "completed") throw new Error(result.error ?? "codex did not answer the question");
    return { text: result.text ?? "", ...(result.tokens !== undefined ? { usage: result.tokens } : {}) };
  };

  /** The thread's own history cut before one of its turns, on a server run of its own that runs no turn: the
   * thread resumed, then thread/revert, then EOF. */
  const revert: SessionReverter = async o => {
    const command = buildCommand({ ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) });
    const resume = threadResumeLine({ threadId: o.session, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), access: accessParams("read-only") });
    const result = await follow({
      stream: deps.exec(command, { env: { ...env }, input: [initializeLine(), INITIALIZED_LINE, resume] }),
      localId: randomUUID(),
      startedAt: Date.now(),
      command,
      turnLine: threadId => threadRevertLine({ threadId, beforeTurnId: o.beforeTurn }),
      sideRun: true,
      onEvent: () => {},
    }).finished;
    if (result.status !== "completed") throw new Error(result.error ?? "codex did not cut the thread");
  };

  const attach = deps.exec.attach?.bind(deps.exec);

  const probeCatalog = (exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer> =>
    exec(catalogProbeCommand({ home: deps.home, baseEnv: deps.baseEnv })).then(stdout => parseCatalogProbe(stdout, deps.login));

  return {
    start,
    attachments: "file",
    ...(attach !== undefined
      ? {
          attach: async (options: AdapterAttachOptions) => {
            const stream = await attach(options.run, { input: true, startedAt: options.startedAt });
            return stream === "gone"
              ? "gone"
              : follow({
                  stream,
                  localId: options.sessionId,
                  startedAt: options.startedAt,
                  ...(options.model !== undefined ? { model: options.model } : {}),
                  ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                  onEvent: options.onEvent,
                });
          },
        }
      : {}),
    sessions,
    steers: true,
    mcpServers: true,
    aside,
    revert,
    probeCatalog,
    sessionTitle: (threadId, exec) => exec(sessionTitleCommand({ home: deps.home, threadId })).then(parseSessionTitle),
    renameSession: (threadId, title, exec) => exec(renameCommand({ home: deps.home, threadId, title })).then(parseRename),
    titleFor: (turn, exec) =>
      exec(
        titleForCommand({
          home: deps.home,
          prompt: titlePrompt(turn.opening, turn.reply),
          ...(turn.model !== undefined ? { model: turn.model } : {}),
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
        }),
      ).then(parseTitleFor),
    draftFor: (ask, exec) =>
      exec(
        draftForCommand({
          home: deps.home,
          promptFile: ask.promptFile,
          ...(ask.model !== undefined ? { model: ask.model } : {}),
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
        }),
      ).then(parseDraftFor),
    env,
  };
}
