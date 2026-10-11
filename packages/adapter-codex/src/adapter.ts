// SPDX-License-Identifier: AGPL-3.0-only
// Drives one Codex turn through `codex app-server` and normalizes what the
// server prints into the event set the runtime consumes. One server process
// per turn, launched the way any turn is: initialize, then thread/start (or
// thread/resume), then turn/start once the thread answers. The turn ends at
// the server's turn/completed, or once the last subagent it spawned ends after
// it; stdin closes there and the server exits on the EOF. Subagents are more
// threads on the same server. A message offered mid-turn is turn/steer, an
// approval the server asks for is answered on the same stdin. Shapes are
// codex-cli 0.155.1's own schema (`codex app-server generate-json-schema`).
import { randomUUID } from "node:crypto";
import {
  conversationWrittenElsewhereLine,
  INTERRUPT_GRACE_MS,
  MCP_SERVER_NAME,
  PERMISSION_ALLOW,
  PERMISSION_DENY,
  ASIDE_WALL_MS,
  CODEX_FEWER_TURNS,
  CODEX_LEGACY_HISTORY,
  HUNK_HEAD,
  RUN_EXIT_MS,
  asideWallLine,
  codexKeyRefusedLine,
  codexMissingEnvLine,
  codexNotSignedInLine,
  codexReconnectLine,
  endAfterResult,
  endRun,
  keepRun,
  limitKindOfMinutes,
  RESET_CREDIT_STATUSES,
  SLATE_SERVER_NAME,
  subagentAsked,
  titlePrompt,
  wholeFileHunk,
} from "@wsp/protocol";
import type {
  AdapterAttachOptions,
  AdapterEvent,
  AgentLaunch,
  ConversationLine,
  ConversationStore,
  ExecStream,
  ExecStreamFactory,
  FilePatch,
  HarnessCatalogAnswer,
  HarnessExec,
  McpServerSpec,
  PermissionAsk,
  PermissionOutcome,
  PatchHunk,
  SessionAsker,
  SessionRenamer,
  SessionReverter,
  SessionTitleMaker,
  CommitDrafter,
  SubagentState,
  TaskStop,
  SessionTitleReader,
  TurnImage,
  TurnRefusal,
  TurnResult,
  PlanStep,
  TurnTokens,
  HarnessLimit,
  KeptAgent,
  KeptRun,
  KeptTurn,
  LimitWindow,
  ResetCredit,
} from "@wsp/protocol";
import { catalogProbeCommand, parseCatalogProbe, versionProbeCommand, parseVersion } from "./catalog.js";
import { accessParams, buildCommand, buildEnv, imagePath, slug } from "./command.js";
import {
  INITIALIZED_LINE,
  REQUEST,
  ACCOUNT_READ_LINE,
  decisionLine,
  initializeLine,
  rateLimitsReadLine,
  readMessage,
  refuseRequestLine,
  threadCompactStartLine,
  threadCopyLine,
  threadForkLine,
  threadResumeLine,
  threadRevertLine,
  threadStartLine,
  threadTurnsListLine,
  threadUnsubscribeLine,
  turnInterruptLine,
  turnStartLine,
  turnSteerLine,
  type RequestId,
  type ThreadOptions,
} from "./rpc.js";
import { LETS_GO, LIST_PAGES, WRITER_HELD, itemsCommand, listCommand, newestLines, parseItems, parseList, parseOpened, parseSizes, parseTurns, sizesCommand, turnsCommand } from "./conversations.js";
import { draftForCommand, parseDraftFor, parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "./session-title.js";
import { shellScriptOf } from "./shell-script.js";

export interface CodexStartOptions {
  prompt: string;
  /** The thread id an earlier turn announced; the server reloads that thread. */
  resume?: string;
  /** The turn runs on a copy of `resume` the server writes as a thread of its own, the original left as it was: what a
   * thread another process writes is continued on. */
  copy?: true;
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
  /** Config keys that hand the config's own servers the values the host holds, for this thread alone: they ride the
   * thread's start in the run's seed, which lands in a file of the run's, never on the command line or in the
   * server's environment. */
  serverValues?: { config?: Readonly<Record<string, string>> };
  /** The turn reads each banked reset in full rather than their count alone. */
  limitDetails?: boolean;
  /** The server boots and opens the thread at once, and turn/start goes once this settles. */
  promptAfter?: Promise<void>;
  /** The server stays up once the turn is over, for the thread's next turn/start: kept() hands it over. */
  keep?: boolean;
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
  /** Where this turn starts in the run's log, on a server that ran the thread's earlier turns. */
  readonly from?: number;
  readonly finished: Promise<TurnResult>;
  /** turn/interrupt on the running turn and its subagents; on a kept server the server stays up for the next turn. */
  interrupt(): Promise<void>;
  /** Once the turn is over, the server still up for the thread's next turn; nothing where the turn was not kept or
   * the server went with it. */
  kept?(): KeptAgent<CodexSession> | undefined;
  /** turn/steer on the running turn; not-running before the server started it, after it ended, and when the server
   * turns the message down. */
  steer(prompt: string): Promise<"accepted" | "not-running">;
  /** Answers an approval the server asked for with accept or decline; gone when no such request is open. */
  answer(askId: string, answer: { optionId: string; outcome: PermissionOutcome; denyMessage: string; reason?: string }): Promise<"answered" | "gone">;
  /** turn/interrupt on one subagent's own thread, by that thread's id, the lead and its other subagents running on. */
  stopTask(task: string): Promise<TaskStop>;
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
  /** The program the person runs in place of codex on this computer, and the words every turn's launch adds. */
  launch?: AgentLaunch;
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
  /** Every fileChange item names the files it wrote. */
  readonly reportsEdits: true;
  /** A turn whose message is this alone runs the server's own compaction of the thread, as codex's own /compact does. */
  readonly compacts: typeof COMPACT;
  /** The server takes images as local paths, so each one lands on the machine before the turn starts. */
  readonly attachments: "file";
  /** Servers ride the launch as `-c mcp_servers.<name>...` overrides over the config under CODEX_HOME. */
  readonly mcpServers: true;
  /** A start takes promptAfter: the server touches no file before turn/start hands it the prompt. */
  readonly waitsForPrompt: true;
  /** Makes the binary describe itself under the same home as a session, without running a turn. */
  probeCatalog(exec: HarnessExec): Promise<HarnessCatalogAnswer>;
  /** Asks the binary only its version, under the same environment as the probe; null where it printed none. */
  probeVersion(exec: HarnessExec): Promise<string | null>;
  /** What the CLI's thread index calls a thread: the name the person gave it, or the title it derived. */
  sessionTitle: SessionTitleReader;
  /** Names the thread through the app server's own rename, which writes the column that read takes. */
  renameSession: SessionRenamer;
  /** Asks the CLI itself, in one read-only turn, for a name for a thread it has just replied in. */
  titleFor: SessionTitleMaker;
  draftFor: CommitDrafter;
  /** Answers a question about a thread on an ephemeral fork of it, leaving the thread as it was. */
  aside: SessionAsker;
  /** Cuts the thread's own history before one of its turns; files are the checkpoint's business, not the server's. */
  revert: SessionReverter;
  readonly env: Readonly<Record<string, string>>;
  /** The threads Codex kept on the computer, read through its own app server there. */
  readonly conversations: ConversationStore;
}

type Item = Record<string, unknown> & { id: string; type: string };

const COMPACT = "/compact";

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

/** The words a server that refuses to cut a legacy thread says it in (thread_processor.rs, 0.155.1). */
const PAGINATED_ONLY = "only supports paginated threads";

/** The start of every failure this adapter words itself before the server opened the turn. */
const NEVER_OPENED = "codex could not ";

/** Whether the server opened a cut turn, so the thread's own history holds it: one that kept the server's turn id did;
 * of the rest, a turn refused for want of a sign-in, or one the adapter failed before the server took it, left none
 * there, and one that never said how it ended counts as opened. */
const serverOpened = (turn: { anchor?: string; result?: TurnResult }): boolean =>
  turn.anchor !== undefined || (turn.result?.refusal === undefined && turn.result?.error?.startsWith(NEVER_OPENED) !== true);

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

const MOVED = /\n\nMoved to: ([^\n]+)$/;

/** The hunks of a unified diff; a line before the first hunk head is a header and is skipped. */
function unifiedHunks(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const head = HUNK_HEAD.exec(line);
    if (head !== null) hunks.push({ oldStart: Number(head[1]), oldLines: Number(head[2] ?? 1), newStart: Number(head[3]), newLines: Number(head[4] ?? 1), lines: [] });
    else hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

/** Each change as the hunks it made, as the delta's patch field, absent where none made any; read only off a completed
 * item, since a declined or failed one carries the diff it would have made. The app server (0.162.1,
 * format_file_change_diff) sends an add's whole new file, a delete's whole old file, and an update's unified diff as
 * `similar` writes it, with no file header and one line of context, then "\n\nMoved to: <path>" for a rename. */
const filePatches = (changes: unknown): { patch?: FilePatch[] } => {
  const patch = (Array.isArray(changes) ? changes : []).flatMap((raw): FilePatch[] => {
    const change = rec(raw);
    const path = str(change?.path);
    const diff = str(change?.diff) ?? "";
    if (change === undefined || path === undefined || path === "") return [];
    const kind = str(rec(change.kind)?.type) ?? str(change.kind);
    if (kind === "add" || kind === "delete") return diff === "" ? [] : [{ path, hunks: [wholeFileHunk(diff, kind === "add" ? "+" : "-")] }];
    const moved = MOVED.exec(diff);
    const hunks = unifiedHunks(moved === null ? diff : diff.slice(0, moved.index));
    return hunks.length === 0 && moved === null ? [] : [{ path, hunks, ...(moved !== null ? { movedTo: moved[1]! } : {}) }];
  });
  return patch.length > 0 ? { patch } : {};
};

const changeLines = (changes: unknown): string =>
  changesOf(changes)
    .map(c => `${c.kind} ${c.path}`.trim())
    .join("\n");

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A finished command's exit code and how long it ran, each where the server gave one. */
const ran = (item: Item): { exitCode?: number; durationMs?: number } => {
  const exitCode = count(item.exitCode);
  const durationMs = count(item.durationMs);
  return { ...(exitCode !== undefined ? { exitCode } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
};

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
  return { input: 0, output: 0, ...fields, context: heldOf(seen.last), ...(seen.window !== undefined ? { window: seen.window } : {}) };
}

/** What the model held at one call, off its usage. A compaction's own usage line reports no input or output, only
 * what the thread holds after it, as its total. */
const heldOf = (last: Record<string, unknown>): number => count(last.totalTokens) ?? (count(last.inputTokens) ?? 0) + (count(last.outputTokens) ?? 0);

/** A window's reset as ms epoch: the server sends unix seconds, as the rollout's resets_at is. */
const resetMs = (value: number): number => (value < 1e11 ? value * 1000 : value);

/** The resets the plan has banked, off a rate-limits answer, read fail closed: a count that is not a whole number at
 * or above zero reads the whole field absent, and a credit of a kind other than this plan's windows, or in a state
 * this code does not know, reads unknown and never available. */
export function creditsOf(answer: Record<string, unknown> | undefined): HarnessLimit["credits"] {
  const summary = rec(answer?.rateLimitResetCredits);
  const banked = summary?.availableCount;
  if (typeof banked !== "number" || !Number.isInteger(banked) || banked < 0) return undefined;
  if (!Array.isArray(summary?.credits)) return { count: banked };
  const credits = summary.credits.flatMap((raw): ResetCredit[] => {
    const credit = rec(raw);
    const id = str(credit?.id);
    if (credit === undefined || id === undefined) return [];
    const said = RESET_CREDIT_STATUSES.find(s => s === credit.status);
    const expiresAt = count(credit.expiresAt);
    return [{ id, status: credit.resetType === "codexRateLimits" && said !== undefined ? said : "unknown", ...(expiresAt !== undefined ? { expiresAt: resetMs(expiresAt) } : {}) }];
  });
  return { count: banked, credits };
}

/** The reset a turn the server stopped at the plan's limit waits on: the fullest window whose reset is still ahead.
 * At the cap the server reads 99 as often as 100, so no threshold says which window it was. */
function stoppedUntil(windows: readonly LimitWindow[], now: number): number | undefined {
  const ahead = windows.filter((w): w is LimitWindow & { resetsAt: number } => w.resetsAt !== undefined && w.resetsAt > now);
  return ahead.sort((a, b) => b.usedPercent - a.usedPercent || b.resetsAt - a.resetsAt)[0]?.resetsAt;
}

/** The server's codexErrorInfo on an error the plan's usage limit raised. */
const USAGE_LIMIT_CODE = "usageLimitExceeded";

/** The snapshot a rate-limits answer reads the windows off: the legacy single bucket can name another meter than
 * codex's own, and the buckets by id say which is which. */
export const snapshotOf = (answer: Record<string, unknown> | undefined): Record<string, unknown> | undefined => rec(rec(answer?.rateLimitsByLimitId)?.codex) ?? rec(answer?.rateLimits);

/** The plan's windows off a rate-limit snapshot, each read as a kind by its length (the primary is the session and the
 * secondary the week where the server names no length), with the plan and the account account/read named. A limit
 * the backend says was reached reads reached. */
export function limitOf(snapshot: Record<string, unknown>, account: { id?: string; label?: string; plan?: string }, credits?: HarnessLimit["credits"]): HarnessLimit | undefined {
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
    ...(credits !== undefined ? { credits } : {}),
  };
}

/** The running total as it stood before the call a report's `last` covers. */
const totalBefore = (total: Record<string, unknown>, last: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(BREAKDOWN.flatMap(([, key]) => (count(total[key]) === undefined ? [] : [[key, count(total[key])! - (count(last[key]) ?? 0)]])));

const stepState = (status: unknown): PlanStep["state"] => (status === "completed" ? "done" : status === "inProgress" ? "working" : "pending");

/** One call as a thread's earlier messages show it: the tool and its input as a turn's own tool_use row names them. */
export function toolCallOf(item: Record<string, unknown>): { tool: string; text: string } | undefined {
  if (typeof item.id !== "string" || typeof item.type !== "string") return undefined;
  for (const e of [false, true].flatMap(done => itemDeltas(done, item as Item, ""))) {
    if (e.type === "turn.delta" && e.kind === "tool_use" && e.toolName !== undefined) return { tool: e.toolName, text: e.text };
  }
  return undefined;
}

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
        ? [delta({ kind: "tool_result", text: str(item.aggregatedOutput) ?? "", toolUseId: item.id, isError: failed(), ...ran(item) })]
        : [delta({ kind: "tool_use", text: JSON.stringify({ command: shellScriptOf(str(item.command) ?? "") }), toolName: "command_execution", toolUseId: item.id })];
    case "fileChange":
      return done
        ? [delta({ kind: "tool_result", text: changeLines(item.changes), toolUseId: item.id, isError: failed(), ...(failed() ? {} : filePatches(item.changes)) })]
        : [delta({ kind: "tool_use", text: JSON.stringify({ changes: changesOf(item.changes) }), toolName: "file_change", toolUseId: item.id })];
    case "mcpToolCall": {
      // The slate's second server exists only for Codex's tool listing; its tools are wsp's, so they are named as wsp's.
      const server = str(item.server) === SLATE_SERVER_NAME ? MCP_SERVER_NAME : (str(item.server) ?? "mcp");
      if (!done) return [delta({ kind: "tool_use", text: JSON.stringify(item.arguments ?? {}), toolName: `mcp__${server}__${str(item.tool) ?? "tool"}`, toolUseId: item.id })];
      // A tool that answers isError fails the call with its words in the result and no error message.
      const said = str(rec(item.error)?.message);
      const content = rec(item.result)?.content;
      const text = failed() && said !== undefined && said !== "" ? said : failed() && content === undefined ? "" : JSON.stringify(content ?? []);
      return [delta({ kind: "tool_result", text, toolUseId: item.id, isError: failed() })];
    }
    case "collabAgentToolCall":
      if (item.tool !== "spawnAgent") return [];
      return done
        ? [delta({ kind: "tool_result", text: "", toolUseId: item.id, isError: failed() })]
        : [delta({ kind: "tool_use", text: JSON.stringify({ prompt: str(item.prompt) ?? "" }), toolName: "spawn_agent", toolUseId: item.id })];
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

/** A subagent of the turn: one more thread on the same server, which its lead spawned. */
interface Child {
  state: SubagentState;
  /** The turn it has in progress, which a stop of it names. */
  turnId?: string;
  /** The call that spawned it, which its prompts are named by; its own thread id until one is seen. */
  parent: string;
  title?: string;
  /** The spawn's prompt, which the title is read off; the agent's call carries it, never the subagent's own rows. */
  prompt?: string;
  /** The model the spawn named, where it named one. */
  model?: string;
  depth?: number;
  summary?: string;
}

/** How a subagent's own turn ended, in the shared words. */
const childEnd = (status: string | undefined): SubagentState => (status === "completed" ? "done" : status === "interrupted" ? "stopped" : "failed");

/** A subagent's depth under the lead off codex's path for it: /root is the lead, /root/alpha one it spawned. */
const depthOf = (path: string | undefined): number | undefined => (path === undefined ? undefined : Math.max(1, path.split("/").filter(Boolean).length - 1));

/** The turn's tokens with its subagents' calls added: what the lead's model held and its window stay the lead's. */
function withChildTokens(lead: TurnTokens | undefined, children: Readonly<Record<string, number>>): TurnTokens | undefined {
  if (Object.keys(children).length === 0) return lead;
  const sum: TurnTokens = { ...(lead ?? { input: 0, output: 0, context: 0 }) };
  for (const [name] of BREAKDOWN) if (children[name] !== undefined) sum[name] = (sum[name] ?? 0) + children[name]!;
  return sum;
}

/** What a side question's fork is told, since no Codex turn can run with its tools off. */
const ASIDE_INSTRUCTIONS =
  "The person is asking a side question about this conversation while its work goes on elsewhere. Answer it from the conversation so far, briefly. Run nothing, edit nothing and call no tool.";

/** The two approvals the server raises as a person's allow or deny; every other request it sends is refused. */
const APPROVALS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "command_execution",
  "item/fileChange/requestApproval": "file_change",
};

/** The line that starts a turn's work: the server's own compaction for a message that is /compact alone, as codex's
 * own /compact does, and turn/start for any other. */
function turnLineFor(o: { threadId: string; prompt: string; images?: readonly string[]; effort?: string }): string {
  if (o.prompt.trim() === COMPACT) return threadCompactStartLine({ threadId: o.threadId });
  return turnStartLine({ threadId: o.threadId, text: o.prompt, ...(o.images !== undefined ? { images: o.images } : {}), ...(o.effort !== undefined ? { effort: o.effort } : {}) });
}

/** Whether a line on the run's channel already started its turn, a compaction's included. */
const isTurnStart = (line: string): boolean => {
  try {
    const method = (JSON.parse(line) as { method?: unknown }).method;
    return method === "turn/start" || method === "thread/compact/start";
  } catch {
    return false;
  }
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
    /** What turn/start waits on once the thread answers; a stop in the meantime sends no turn at all. */
    promptAfter?: Promise<void>;
    /** A re-opened run's turn, written when the replayed log shows the thread answered and the run's channel holds no
     * turn: a host that went before it handed the prompt over leaves the turn owed. */
    owedTurn?: (threadId: string) => string;
    /** A side question's own run: every approval it raises is declined here, it joins no registry, and it has a wall. */
    aside?: true;
    /** A run that asks the thread things and runs no turn (a revert), declined and unregistered as a side question
     * is: handed the thread's answer and each later answer of its own, it names the next request or how the run ends. */
    sideRun?: (id: RequestId, answer: Record<string, unknown> | undefined) => string | TurnResult;
    /** The server this turn runs on, kept for the thread's next turn once this one is over. */
    keeper?: KeptRun;
    /** Where this turn starts in the run's log, on a kept server past its first turn. */
    from?: number;
    /** The thread already open on the server, a kept one or a re-opened run read from a later turn's start: nothing
     * this turn reads announces it again, so it is announced at once. */
    opened?: { threadId: string; legacy?: boolean };
    /** What the thread was opened with, which a kept server's next turn resumes it with after this one let it go. */
    threadOptions?: ThreadOptions;
    onEvent: (event: AdapterEvent) => void;
  }): CodexSession => {
    const { stream, localId, startedAt } = o;

    let threadId = localId;
    let announced = false;
    /** The run hands its turn's prompt over after the thread answers: it announces itself unprompted, and again once
     * the turn under that prompt has started. */
    const promptsLater = o.turnLine !== undefined || o.owedTurn !== undefined;
    /** The server keeps this thread's history in a form thread/revert cannot cut, as its thread answer said. */
    let legacy = false;
    let turnId: string | undefined;
    let exited = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let lastText: string | undefined;
    let usage: UsageSeen | undefined;
    /** A compaction from its item's start until it is said: what the thread held before it, off the usage line the
     * resume sent, and after it, off the first usage line once it started, which 0.155.1 sends inside the item and
     * an earlier recording after it (measured 2026-10-05). */
    let compaction: { before?: number; after?: number; ended: boolean } | undefined;
    const sayCompacted = (): void => {
      if (compaction === undefined) return;
      const { before, after } = compaction;
      emit({ type: "turn.compacted", sessionId: threadId, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
      compaction = undefined;
    };
    /** The account's plan windows as last read, with the sign-in account/read named, merged across rolling updates. */
    let rateLimits: Record<string, unknown> | undefined;
    let account: { id?: string; label?: string; plan?: string } = {};
    let modelUsed = o.model;
    let cwdUsed = o.cwd;
    /** The last failure the stream showed, if any, in wsp's words and under the cause it claims. */
    let words: { line: string; cause?: TurnRefusal } | undefined;
    /** What the server said last in an error, for a process that dies without completing its turn. */
    let lastError: string | undefined;
    /** Set once the server said the plan's usage limit stopped this turn, in an error it will not retry. */
    let usageLimited = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalledAt: number | undefined;
    const stderrTail: string[] = [];
    /** Notes the server printed before the thread had an id to file them under. */
    const early: string[] = [];
    /** The commands of this turn and its subagents that started and have not completed, by item id. */
    const commands = new Set<string>();
    /** The changes each file-change item started with, which its approval request does not repeat. */
    const changesById = new Map<string, unknown>();
    /** Approvals the server is waiting on, by the askId the runtime holds, with the id the server asked under. */
    const pending = new Map<string, { id: RequestId; ask: PermissionAsk }>();
    /** Requests this adapter sent whose answer a caller waits on (steers, a stop of one subagent), by their id. */
    const awaiting = new Map<string, (answer: { error?: string } | "gone") => void>();
    let requestSeq = 0;
    /** The turn's subagents by their thread ids, in the order they were first seen. */
    const children = new Map<string, Child>();
    /** Each token field the subagents' calls drew, summed. */
    const childTokens: Record<string, number> = {};
    let tasksSaid = 0;
    /** How the lead's own turn ended, held while any subagent still runs. */
    let leadEnd: { status: string; error?: string } | undefined;

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

    /** A message another thread on this server sent: one naming no thread, or sent before this one is known, is this
     * thread's. */
    const foreign = (params: Record<string, unknown>): boolean => {
      const id = str(params.threadId);
      return announced && id !== undefined && id !== threadId;
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
      cwdUsed = where;
      emit({ type: "session.start", sessionId: threadId, ...(runs !== undefined ? { model: runs } : {}), ...(where !== undefined ? { cwd: where } : {}), ...(promptsLater && turnId === undefined ? { prompted: false as const } : {}) });
      for (const text of early.splice(0)) emit({ type: "turn.delta", sessionId: threadId, kind: "note", text });
    };

    const closeAsk = (askId: string, outcome: PermissionOutcome, optionId?: string): void => {
      pending.delete(askId);
      emit({ type: "permission.close", sessionId: threadId, askId, outcome, ...(optionId !== undefined ? { optionId } : {}) });
    };

    const settleAwaiting = (): void => {
      for (const settle of awaiting.values()) settle("gone");
      awaiting.clear();
    };

    const runningChildren = (): number => [...children.values()].filter(c => c.state === "running").length;
    /** What holds the turn's idle clock: a subagent with a turn in progress. One known only from its spawn holds the
     * reply but not the clock, so a spawn that never starts is ended by the watchdog. */
    const sayTasks = (): void => {
      const running = [...children.values()].filter(c => c.state === "running" && c.turnId !== undefined).length;
      if (running === tasksSaid) return;
      tasksSaid = running;
      emit({ type: "turn.tasks", sessionId: threadId, running });
    };
    const sayChild = (task: string, c: Child): void =>
      emit({
        type: "subagent",
        sessionId: threadId,
        task,
        state: c.state,
        parentToolUseId: c.parent,
        ...(c.state === "running"
          ? {
              ...(c.title !== undefined ? { title: c.title } : {}),
              ...(c.depth !== undefined ? { depth: c.depth } : {}),
              ...(c.model !== undefined ? { model: c.model } : {}),
              ...(c.prompt !== undefined ? { asked: subagentAsked(c.prompt) } : {}),
            }
          : c.summary !== undefined ? { summary: c.summary } : {}),
      });
    /** A sign of a subagent: a new one starts running, and one already running is said again where the sign adds to
     * what was said of it. */
    const learn = (task: string, said: { parent?: string; prompt?: string; model?: string; name?: string; depth?: number } = {}): void => {
      if (task === threadId) return;
      const c = children.get(task);
      const title = said.prompt?.split("\n")[0]?.trim() || said.name;
      if (c === undefined) {
        const fresh: Child = { state: "running", parent: said.parent ?? task, ...(title !== undefined ? { title } : {}), ...(said.prompt !== undefined ? { prompt: said.prompt } : {}), ...(said.model !== undefined ? { model: said.model } : {}), ...(said.depth !== undefined ? { depth: said.depth } : {}) };
        children.set(task, fresh);
        sayChild(task, fresh);
        sayTasks();
        return;
      }
      const adds = (said.parent !== undefined && c.parent === task) || (said.prompt !== undefined && c.prompt === undefined) || (said.model !== undefined && c.model === undefined) || (said.depth !== undefined && c.depth === undefined) || (title !== undefined && c.title === undefined);
      if (said.parent !== undefined && c.parent === task) c.parent = said.parent;
      if (said.prompt !== undefined && c.prompt === undefined) {
        c.prompt = said.prompt;
        c.title = title;
      }
      c.depth ??= said.depth;
      c.model ??= said.model;
      c.title ??= title;
      if (adds && c.state === "running") sayChild(task, c);
    };
    const endChild = (task: string, state: SubagentState): void => {
      const c = children.get(task);
      if (c === undefined || c.state !== "running") return;
      c.state = state;
      delete c.turnId;
      sayChild(task, c);
      sayTasks();
      settleLead();
    };
    /** The subagents a collab call or an activity item names, wherever on the server it was printed. */
    const childSigns = (item: Item, done: boolean): void => {
      if (item.type === "collabAgentToolCall") {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((t): t is string => typeof t === "string") : [];
        if (item.tool === "spawnAgent" && item.status !== "failed") for (const task of receivers) learn(task, { parent: item.id, ...(str(item.prompt) !== undefined ? { prompt: str(item.prompt) } : {}), ...(str(item.model) ? { model: str(item.model)! } : {}) });
        if (item.tool === "closeAgent" && done && item.status === "completed") for (const task of receivers) endChild(task, "done");
      }
      if (item.type === "subAgentActivity") {
        const task = str(item.agentThreadId);
        if (task === undefined || task === threadId) return;
        const path = str(item.agentPath);
        if (item.kind === "started") learn(task, { parent: item.id, ...(path !== undefined ? { name: path.split("/").at(-1)!, depth: depthOf(path)! } : {}) });
        else if (item.kind === "completed") endChild(task, "done");
        else if (item.kind === "interrupted") endChild(task, "stopped");
      }
    };

    /** The turn's reply is final: the server waits for more input after it, and EOF is what lets it exit; one that
     * does not go on its own is ended with its tree once the wait passes. */
    /** A failed turn the plan's limit stopped, with the limit on it: the reset is the latest reading's fullest window
     * still ahead, and unknown where no window names one. */
    const withLimit = (result: TurnResult): TurnResult => {
      if (result.status !== "failed" || !usageLimited) return result;
      const resetsAt = stoppedUntil(limitOf(rateLimits ?? {}, account)?.windows ?? [], Date.now());
      return { ...result, limit: resetsAt !== undefined ? { resetsAt } : {} };
    };

    const finish = (ended: TurnResult): void => {
      if (turnResult !== undefined) return;
      const result = withLimit(ended);
      turnResult = result;
      // A server is kept only past a turn that went as it should, so a sign-in or a fix made in between reaches the
      // next turn on a server launched again.
      if (result.status !== "completed" && result.status !== "interrupted") o.keeper?.release();
      // A kept server lets go of the thread, so the person's own Codex may open it while wsp waits for the next message.
      else if (o.keeper?.up === true && o.threadOptions !== undefined) void stream.write(threadUnsubscribeLine(threadId));
      emit({ type: "turn.done", sessionId: threadId, result });
      for (const askId of [...pending.keys()]) closeAsk(askId, "cancelled");
      settleAwaiting();
      stream.closeInput();
      void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, graceMs).catch(() => {});
    };

    const failed = (message: string): TurnResult => {
      words = failureWords(message, deps.login, deps.keyEnv) ?? words;
      return { status: "failed", durationMs: Date.now() - startedAt, error: words?.line ?? message, ...(words?.cause !== undefined ? { refusal: words.cause } : {}) };
    };

    /** The lead's turn as it ended, with every subagent call it waited on counted in its tokens. */
    const leadResult = (end: { status: string; error?: string }): TurnResult => {
      if (end.status === "interrupted") return { status: "interrupted" };
      if (end.status !== "completed") return failed(end.error ?? "codex reported a failed turn");
      const tokens = withChildTokens(usage === undefined ? undefined : turnTokensOf(usage), childTokens);
      return { status: "completed", durationMs: Date.now() - startedAt, ...(lastText !== undefined ? { text: lastText } : {}), ...(tokens !== undefined ? { tokens } : {}), ...(modelUsed !== undefined ? { model: modelUsed } : {}) };
    };

    /** The lead's reply goes once its own turn has ended and no subagent of it still runs, as Claude's held reply does:
     * ending it sooner closes stdin and arms the exit wait, which would end a running subagent with the server. */
    const settleLead = (): void => {
      if (leadEnd !== undefined && runningChildren() === 0 && !exited) finish(leadResult(leadEnd));
    };

    /** Everything a subagent's thread prints on this stdout: its turn, its tokens, its items and the subagents it
     * spawns in turn. */
    const onChild = (task: string, method: string, params: Record<string, unknown>, emittedAtMs?: number): void => {
      switch (method) {
        case "turn/started": {
          const id = str(rec(params.turn)?.id);
          learn(task);
          const c = children.get(task)!;
          if (id !== undefined) c.turnId = id;
          if (c.state !== "running") {
            c.state = "running";
            delete c.summary;
            sayChild(task, c);
          }
          sayTasks();
          break;
        }
        case "turn/completed": {
          const turn = rec(params.turn);
          const c = children.get(task);
          const id = str(turn?.id);
          if (c?.turnId !== undefined && id !== undefined && id !== c.turnId) break;
          endChild(task, childEnd(str(turn?.status)));
          break;
        }
        case "item/started":
        case "item/completed": {
          const item = itemOf(params);
          if (item === undefined) break;
          const done = method === "item/completed";
          if (item.type === "commandExecution") commands[done ? "delete" : "add"](item.id);
          if (item.type === "fileChange") changesById.set(item.id, item.changes);
          const c = children.get(task);
          if (done && item.type === "agentMessage" && c !== undefined) c.summary = str(item.text);
          childSigns(item, done);
          break;
        }
        case "thread/tokenUsage/updated": {
          const last = rec(rec(params.tokenUsage)?.last);
          if (last === undefined) break;
          emit({ type: "turn.usage", sessionId: threadId, tokens: (count(last.inputTokens) ?? 0) + (count(last.outputTokens) ?? 0), ...(emittedAtMs !== undefined ? { at: emittedAtMs } : {}) });
          for (const [name, key] of BREAKDOWN) if (count(last[key]) !== undefined) childTokens[name] = (childTokens[name] ?? 0) + count(last[key])!;
          break;
        }
        default:
          break;
      }
    };

    const emitLimit = (credits?: HarnessLimit["credits"]): void => {
      if (rateLimits === undefined) return;
      const limit = limitOf(rateLimits, account, credits);
      if (limit !== undefined) emit({ type: "limit", sessionId: threadId, limit });
    };

    const onRequest = (id: RequestId, method: string, params: Record<string, unknown>): void => {
      const toolName = APPROVALS[method];
      if (toolName === undefined) {
        void stream.write(refuseRequestLine(id, method));
        return;
      }
      if (o.aside === true || o.sideRun !== undefined) {
        void stream.write(decisionLine(id, "decline"));
        return;
      }
      const itemId = str(params.itemId);
      const input =
        toolName === "file_change"
          ? { changes: changesOf(itemId === undefined ? undefined : changesById.get(itemId)) }
          : { command: shellScriptOf(str(params.command) ?? ""), ...(str(params.cwd) !== undefined ? { cwd: str(params.cwd) } : {}) };
      const reason = str(params.reason);
      const asker = foreign(params) ? str(params.threadId)! : undefined;
      const ask: PermissionAsk = {
        askId: String(id),
        toolName,
        ...(itemId !== undefined ? { toolUseId: itemId } : {}),
        ...(asker !== undefined ? { parentToolUseId: children.get(asker)?.parent ?? asker } : {}),
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

    /** The turn goes once its prompt is due and not after a stop; held beside the run meanwhile where the road keeps
     * one, so a host that goes inside the wait leaves it for the next. */
    const handOver = (line: string): void => {
      const due = (o.promptAfter ?? Promise.resolve()).then(() => {
        if (interruptRequested || exited) throw new Error("the turn was stopped before its prompt was due");
      });
      if (o.promptAfter !== undefined && stream.writeAfter !== undefined) stream.writeAfter(line, due);
      else void due.then(() => stream.write(line), () => {});
    };

    const side = (id: RequestId, answer: Record<string, unknown> | undefined): void => {
      const next = o.sideRun!(id, answer);
      if (typeof next === "string") void stream.write(next);
      else finish(next);
    };

    const onResponse = (id: RequestId, result: unknown): void => {
      if (id === REQUEST.thread) {
        const answer = rec(result);
        const thread = rec(answer?.thread);
        legacy ||= !announced && thread?.historyMode === "legacy";
        announce(str(thread?.id), str(answer?.model) ?? str(thread?.model), str(answer?.cwd) ?? str(thread?.cwd));
        if (o.sideRun !== undefined) side(id, answer);
        // A thread already open handed its turn over as it began; this answer is its resume's.
        else if (o.turnLine !== undefined && o.opened === undefined) handOver(o.turnLine(threadId));
        else if (o.owedTurn !== undefined && stream.taken !== undefined && !stream.taken.some(isTurnStart)) void stream.write(o.owedTurn(threadId));
        return;
      }
      if (o.sideRun !== undefined && (id === REQUEST.turns || id === REQUEST.revert)) {
        side(id, rec(result));
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
        rateLimits = snapshotOf(answer);
        emitLimit(creditsOf(answer));
        return;
      }
      const settle = typeof id === "string" ? awaiting.get(id) : undefined;
      if (settle !== undefined) {
        awaiting.delete(id as string);
        settle({});
      }
    };

    const onError = (id: RequestId, message: string): void => {
      const settle = typeof id === "string" ? awaiting.get(id) : undefined;
      if (settle !== undefined) {
        awaiting.delete(id as string);
        settle({ error: message });
        return;
      }
      if (id === REQUEST.revert) finish({ status: "failed", error: `codex would not cut the thread: ${message}` });
      else if (id === REQUEST.turns) finish({ status: "failed", error: `codex could not list the thread's turns: ${message}` });
      else if (id === REQUEST.thread) finish({ status: "failed", error: message.includes(WRITER_HELD) ? conversationWrittenElsewhereLine("Codex", LETS_GO) : `codex could not open the thread: ${message}` });
      else if (id === REQUEST.turn || id === REQUEST.initialize) finish({ status: "failed", error: `codex could not start the turn: ${message}` });
    };

    const onNotification = (method: string, params: Record<string, unknown>, emittedAtMs?: number): void => {
      if (method !== "error") progress();
      // A subagent's thread prints its own turn, tokens, plan and items on this stdout under its own id; none of them
      // is this thread's. Request ids are the connection's, so a resolved request is read whoever asked it.
      if (method !== "serverRequest/resolved" && foreign(params)) {
        onChild(str(params.threadId)!, method, params, emittedAtMs);
        return;
      }
      switch (method) {
        case "thread/started": {
          const thread = rec(params.thread);
          legacy ||= !announced && thread?.historyMode === "legacy";
          announce(str(thread?.id), str(thread?.model), str(thread?.cwd));
          break;
        }
        case "turn/started": {
          const first = turnId === undefined;
          turnId = str(rec(params.turn)?.id) ?? turnId;
          if (first && turnId !== undefined) {
            if (promptsLater && announced) emit({ type: "session.start", sessionId: threadId, ...(modelUsed !== undefined ? { model: modelUsed } : {}), ...(cwdUsed !== undefined ? { cwd: cwdUsed } : {}) });
            emit({ type: "turn.anchor", sessionId: threadId, anchor: turnId, ...(legacy ? { kept: CODEX_LEGACY_HISTORY } : {}) });
          }
          break;
        }
        case "item/started":
        case "item/completed": {
          const item = itemOf(params);
          if (item === undefined) break;
          const done = method === "item/completed";
          if (item.type === "commandExecution") commands[done ? "delete" : "add"](item.id);
          if (item.type === "fileChange") changesById.set(item.id, item.changes);
          if (done && item.type === "agentMessage") lastText = str(item.text);
          if (item.type === "contextCompaction") {
            compaction ??= { ...(usage !== undefined ? { before: heldOf(usage.last) } : {}), ended: false };
            if (done) compaction.ended = true;
            if (done && compaction.after !== undefined) sayCompacted();
          }
          childSigns(item, done);
          for (const delta of itemDeltas(done, item, threadId)) emit(delta);
          break;
        }
        case "thread/tokenUsage/updated": {
          const reported = rec(params.tokenUsage);
          const total = rec(reported?.total) ?? {};
          const last = rec(reported?.last);
          if (last === undefined) break;
          const window = count(reported?.modelContextWindow);
          emit({ type: "turn.usage", sessionId: threadId, tokens: (count(last.inputTokens) ?? 0) + (count(last.outputTokens) ?? 0), context: heldOf(last), ...(window !== undefined ? { window } : {}), ...(emittedAtMs !== undefined ? { at: emittedAtMs } : {}) });
          usage = { before: usage?.before ?? totalBefore(total, last), total, last, ...(window !== undefined ? { window } : {}) };
          if (compaction !== undefined && compaction.after === undefined) {
            compaction.after = heldOf(last);
            if (compaction.ended) sayCompacted();
          }
          break;
        }
        case "account/rateLimits/updated": {
          // A rolling update is sparse: what it leaves out, or names null, keeps the last reading's value.
          const snapshot = rec(params.rateLimits) ?? {};
          if (typeof snapshot.limitId === "string" && snapshot.limitId !== "codex") break;
          const update = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== null));
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
          if (error?.codexErrorInfo === USAGE_LIMIT_CODE && params.willRetry !== true) usageLimited = true;
          words = failureWords(`${message} ${str(error?.additionalDetails) ?? ""}`, deps.login, deps.keyEnv) ?? words;
          if (RECONNECTING.test(message)) reconnecting();
          break;
        }
        case "turn/completed": {
          const turn = rec(params.turn);
          const id = str(turn?.id);
          if (turnId !== undefined && id !== undefined && id !== turnId) break;
          const error = str(rec(turn?.error)?.message);
          if (rec(turn?.error)?.codexErrorInfo === USAGE_LIMIT_CODE) usageLimited = true;
          leadEnd = { status: str(turn?.status) ?? "failed", ...(error !== undefined ? { error } : {}) };
          sayCompacted();
          settleLead();
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

    if (o.opened !== undefined) {
      legacy = o.opened.legacy === true;
      announce(o.opened.threadId, undefined, undefined);
      if (o.turnLine !== undefined) handOver(o.turnLine(threadId));
    }

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      let streamFailure: unknown;
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
              onNotification(message.method, message.params, message.emittedAtMs);
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
        streamFailure = cause;
      }
      const exitCode = await stream.exited;
      if (asideWall !== undefined) clearTimeout(asideWall);
      exited = true;
      progress();
      for (const askId of [...pending.keys()]) closeAsk(askId, "cancelled");
      settleAwaiting();
      // A subagent lives in this process, so it is over too, whatever its thread last said.
      for (const [task, c] of children) if (c.state === "running") endChild(task, interruptRequested ? "stopped" : "failed");
      if (turnResult === undefined && leadEnd !== undefined) {
        turnResult = withLimit(leadResult(leadEnd));
        emit({ type: "turn.done", sessionId: threadId, result: turnResult });
      }
      const sawResult = turnResult !== undefined;
      if (turnResult === undefined) {
        const reason = lastError ?? (stderrTail.length === 0 ? undefined : stderrTail.join("\n"));
        const died = `codex exited with code ${String(exitCode)} before its turn ended${reason === undefined ? "" : `: ${reason}`}`;
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : withLimit(words !== undefined ? { status: "failed", error: words.line, ...(words.cause !== undefined ? { refusal: words.cause } : {}) } : { status: "failed", error: streamError ?? died });
        emit({ type: "turn.done", sessionId: threadId, result: turnResult });
      }
      emit({ type: "session.end", sessionId: threadId, exitCode, sawResult, ...(streamFailure !== undefined ? { failure: streamFailure } : {}) });
      return turnResult;
    })();

    /** The turn is open to a message: the server started it and it has neither completed nor gone. */
    const running = (): boolean => turnId !== undefined && leadEnd === undefined && turnResult === undefined && !exited && !interruptRequested;

    /** Asks the server to stop one turn and settles on its answer: accepted, refused in its words, or gone. */
    const interruptTurn = async (target: { threadId: string; turnId: string }): Promise<{ error?: string } | "gone"> => {
      const id = `wsp-interrupt-${++requestSeq}`;
      const answered = new Promise<{ error?: string } | "gone">(resolve => awaiting.set(id, resolve));
      const wrote = await stream.write(turnInterruptLine({ id, ...target })).catch(() => "gone" as const);
      if (wrote === "written") return answered;
      awaiting.delete(id);
      return "gone";
    };

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
        const id = `wsp-steer-${++requestSeq}`;
        const answered = new Promise<{ error?: string } | "gone">(resolve => awaiting.set(id, resolve));
        // A write whose answer was lost may still have landed: the server's own answer to the request says which, and
        // the turn's end settles it as gone where none comes, so the message never lands twice.
        const wrote = await stream.write(turnSteerLine(id, { threadId, turnId, text: prompt })).catch(() => (running() ? ("unanswered" as const) : ("gone" as const)));
        if (wrote === "gone") {
          awaiting.delete(id);
          return "not-running";
        }
        const answer = await answered;
        return answer !== "gone" && answer.error === undefined ? "accepted" : "not-running";
      },
      answer: async (askId, answer) => {
        const open = pending.get(askId);
        if (open === undefined || exited) return "gone";
        // Taken off the map before the write, so two answers racing on one request cannot both reach the server.
        pending.delete(askId);
        const wrote = await stream.write(decisionLine(open.id, answer.optionId === PERMISSION_ALLOW ? "accept" : "decline")).catch(() => "gone" as const);
        if (wrote !== "written") return "gone";
        emit({ type: "permission.close", sessionId: threadId, askId, outcome: answer.outcome, optionId: answer.optionId });
        // A decline carries no words on this server, so the person's reason goes to the turn as their own message.
        if (answer.outcome === "denied" && answer.reason !== undefined) void session.steer(answer.reason);
        return "answered";
      },
      stopTask: async task => {
        const c = children.get(task);
        if (exited || turnResult !== undefined || c?.state !== "running" || c.turnId === undefined) return { outcome: "not-running" };
        const answer = await interruptTurn({ threadId: task, turnId: c.turnId });
        if (answer === "gone") return { outcome: "not-running" };
        return answer.error === undefined ? { outcome: "accepted" } : { outcome: "refused", error: answer.error };
      },
      interrupt: async () => {
        if (exited) return;
        const live = running() ? turnId : undefined;
        interruptRequested = true;
        const kids = [...children].flatMap(([task, c]) => (c.state === "running" && c.turnId !== undefined ? [{ threadId: task, turnId: c.turnId }] : []));
        if (live === undefined && kids.length === 0) return escalate();
        // turn/interrupt completes the turn and leaves a command it was running going (seen on codex-cli 0.155.1 in 17
        // of 18 stops); the server's exit is what ends it, so a turn stopped mid-command takes its server down.
        if (commands.size > 0) o.keeper?.release();
        // Each subagent first, as T3 Code stops a lineage, so none is left mid-turn when its lead's process ends.
        for (const kid of kids) void interruptTurn(kid);
        if (live !== undefined) void interruptTurn({ threadId, turnId: live });
        // The server completes an interrupted turn and exits on the EOF that follows, or rests for the next turn
        // where it is kept; one that does not is ended.
        await endAfterResult(stream, graceMs, graceMs);
      },
      kept: () => {
        const keeper = o.keeper;
        if (keeper === undefined || !keeper.up || turnResult === undefined) return undefined;
        const thread = { threadId, legacy, ...(modelUsed !== undefined ? { model: modelUsed } : {}), ...(cwdUsed !== undefined ? { cwd: cwdUsed } : {}) };
        return {
          // Keyed as a cold resume of the thread is, so the rows a kept turn writes are the ones a launched one would.
          next: turn => nextOn(keeper, threadId, thread, turn, o.threadOptions),
          close: c => keeper.close(c?.now === true ? 0 : (deps.resultExitMs ?? RUN_EXIT_MS), graceMs),
          exited: keeper.exited,
          sessionFile: { folder: `${deps.home}/sessions`, name: `-${threadId}.jsonl`, depth: 3 },
        };
      },
      ...(o.from !== undefined ? { from: o.from } : {}),
    };
    if (o.aside !== true && o.sideRun === undefined) sessions.set(localId, session);
    return session;
  };

  /** An image reaches the server as a file, so one that arrived with no path never travelled the runtime's file road
   * and the turn is refused rather than started without it. */
  const imagePathOf = (image: TurnImage): string => {
    if (image.path === undefined) throw new Error("codex reads images off the machine's disk; this one has no path on it");
    return imagePath(image.path);
  };

  /** The thread's next turn on a server its last turn left up: turn/start on the thread it already holds, at the
   * model, effort and access the earlier turn set, which the server keeps for every later turn. */
  const nextOn = (keeper: KeptRun, localId: string, thread: { threadId: string; legacy: boolean; model?: string; cwd?: string }, turn: KeptTurn, threadOptions?: ThreadOptions): CodexSession => {
    const images = turn.images?.map(imagePathOf);
    const { stream, from } = keeper.turn();
    // The last turn let the thread go, so this one opens it again on the same server, its turn/start right behind:
    // 0.162.1 takes the two in order when they arrive together, and a turn/start alone on a thread let go is never
    // answered (measured 2026-10-11).
    if (threadOptions !== undefined) void stream.write(threadResumeLine({ ...threadOptions, threadId: thread.threadId }));
    return follow({
      stream,
      localId,
      startedAt: Date.now(),
      keeper,
      ...(from !== undefined ? { from } : {}),
      opened: { threadId: thread.threadId, legacy: thread.legacy },
      ...(threadOptions !== undefined ? { threadOptions } : {}),
      ...(thread.model !== undefined ? { model: thread.model } : {}),
      ...(thread.cwd !== undefined ? { cwd: thread.cwd } : {}),
      turnLine: threadId => turnStartLine({ threadId, text: turn.prompt, ...(images !== undefined ? { images } : {}) }),
      ...(turn.after !== undefined ? { promptAfter: turn.after } : {}),
      onEvent: turn.onEvent,
    });
  };

  const start = (options: CodexStartOptions): CodexSession => {
    if (options.contextWindow !== undefined) throw new Error("codex takes no context window");
    const images = options.images?.map(imagePathOf);
    const access = accessParams(options.permissionMode);
    const localId = options.copy === true ? randomUUID() : (options.resume ?? randomUUID());
    const config = options.serverValues?.config ?? {};
    const valued = Object.keys(config).length > 0;
    const thread = { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.model !== undefined ? { model: options.model } : {}), ...(options.fast === true ? { serviceTier: "fast" as const } : {}), access, ...(valued ? { config } : {}) };
    const threadLine =
      options.resume === undefined ? threadStartLine(thread) : options.copy === true ? threadCopyLine({ ...thread, threadId: options.resume }) : threadResumeLine({ ...thread, threadId: options.resume });
    const command = buildCommand({ ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}), ...(deps.launch !== undefined ? { launch: deps.launch } : {}) });
    const run = deps.exec(command, { env: { ...env }, input: [initializeLine(), INITIALIZED_LINE, ACCOUNT_READ_LINE, rateLimitsReadLine(options.limitDetails === true), threadLine], ...(valued ? { secret: { input: true as const } } : {}) });
    const keeper = options.keep === true ? keepRun(run) : undefined;
    return follow({
      stream: keeper === undefined ? run : keeper.turn().stream,
      ...(keeper !== undefined ? { keeper } : {}),
      localId,
      startedAt: Date.now(),
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      threadOptions: thread,
      turnLine: threadId => turnLineFor({ threadId, prompt: options.prompt, ...(images !== undefined ? { images } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}) }),
      ...(options.promptAfter !== undefined ? { promptAfter: options.promptAfter } : {}),
      onEvent: options.onEvent,
    });
  };

  /** A question put to a copy of the thread: an ephemeral fork writes no rollout, so the thread's own history and its
   * store are left as they were, and a read-only sandbox that asks nobody is the nearest a Codex turn comes to having
   * no tools. */
  const aside: SessionAsker = async o => {
    const command = buildCommand({ ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(deps.launch?.program !== undefined ? { launch: { program: deps.launch.program } } : {}) });
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
   * thread resumed, then thread/revert, then EOF. Without the turn's own id the boundary is found by count, the way
   * T3 Code's CodexThreadRevert.ts does it (MIT): the thread's turns newest first, page by page, the count-th one the
   * first cut. */
  const revert: SessionReverter = async o => {
    const command = buildCommand({ ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(deps.launch?.program !== undefined ? { launch: { program: deps.launch.program } } : {}) });
    const resume = threadResumeLine({ threadId: o.session, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), access: accessParams("read-only") });
    let legacy = false;
    let remaining = "turns" in o ? o.turns.filter(serverOpened).length : 0;
    let beforeTurnId = "beforeTurn" in o ? o.beforeTurn : undefined;
    let cursor: string | null = null;
    const seen = new Set<string | null>();
    let threadId = o.session;
    const done = (): TurnResult => ({ status: "completed" });
    const page = (): string => {
      seen.add(cursor);
      return threadTurnsListLine({ threadId, cursor, limit: Math.min(remaining, 100) });
    };
    const cutAt = (): string | TurnResult => (beforeTurnId === undefined ? done() : threadRevertLine({ threadId, beforeTurnId }));
    const result = await follow({
      stream: deps.exec(command, { env: { ...env }, input: [initializeLine(), INITIALIZED_LINE, resume] }),
      localId: randomUUID(),
      startedAt: Date.now(),
      command,
      sideRun: (id, answer) => {
        if (id === REQUEST.thread) {
          const thread = rec(answer?.thread);
          threadId = str(thread?.id) ?? threadId;
          legacy = thread?.historyMode === "legacy";
          if (legacy) return done();
          return beforeTurnId === undefined && remaining > 0 ? page() : cutAt();
        }
        if (id === REQUEST.turns) {
          for (const turn of Array.isArray(answer?.data) ? answer.data : []) {
            const turnId = str(rec(turn)?.id);
            if (turnId === undefined) continue;
            beforeTurnId = turnId;
            if (--remaining === 0) break;
          }
          cursor = str(answer?.nextCursor) ?? null;
          if (remaining === 0) return cutAt();
          // wsp's count is rebuilt from its own transcript, so a server that runs out first disagrees with it.
          if (cursor === null) return { status: "failed", error: CODEX_FEWER_TURNS };
          return seen.has(cursor) ? { status: "failed", error: "codex could not list the thread's turns: it handed back a page it already gave" } : page();
        }
        return done();
      },
      onEvent: () => {},
    }).finished;
    if (legacy || (result.status === "failed" && result.error?.includes(PAGINATED_ONLY) === true)) return { kept: CODEX_LEGACY_HISTORY };
    if (result.status !== "completed") throw new Error(result.error ?? "codex did not cut the thread");
  };

  const attach = deps.exec.attach?.bind(deps.exec);

  const launch = deps.launch !== undefined ? { launch: deps.launch } : {};
  /** What every question outside a turn reads off its input: the session's own environment, never words of its text. */
  const questionEnv = (): Record<string, string> => buildEnv({ base: deps.baseEnv, home: deps.home });
  /** The threads Codex kept on this computer, each read through a server that runs no turn and ends at once. */
  const conversations: ConversationStore = {
    letsGo: LETS_GO,
    list: async (cwds, road) => {
      if (cwds.length === 0) return [];
      const rows: Awaited<ReturnType<typeof parseList>>["rows"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES; page++) {
        const read = parseList(await road.exec(listCommand({ cwds, ...(cursor !== undefined ? { cursor } : {}), ...launch }), questionEnv()));
        rows.push(...read.rows);
        if (read.next === undefined) break;
        cursor = read.next;
      }
      const paths = rows.flatMap(r => (r.path !== undefined ? [r.path] : []));
      const sizes = paths.length === 0 ? [] : parseSizes(await road.exec(sizesCommand(paths)).catch(() => ""), paths.length);
      const sizeOf = new Map(paths.map((p, i) => [p, sizes[i]]));
      return rows.map(({ path, ...row }) => {
        const bytes = path === undefined ? undefined : sizeOf.get(path);
        return { ...row, ...(bytes !== undefined ? { bytes } : {}) };
      });
    },
    earlier: async (id, o, road) => {
      const threadId = slug("threadId", id);
      const first = await road.exec(turnsCommand({ threadId, probe: o.probe, ...launch }), questionEnv());
      const opened = parseOpened(first);
      if (opened === "gone" || opened === "open") return opened;
      let page = parseTurns(first);
      const turns = [...page.turns];
      for (let read = 1; page.next !== undefined && read < LIST_PAGES; read++) {
        page = parseTurns(await road.exec(turnsCommand({ threadId, probe: false, cursor: page.next, ...launch }), questionEnv()));
        turns.push(...page.turns);
      }
      const total = turns.reduce((n, t) => n + t.messages, 0);
      // The newest turns that hold the messages kept: their items are read and nothing older.
      const kept = new Set<string>();
      let held = 0;
      for (const turn of turns) {
        if (held >= o.last) break;
        kept.add(turn.id);
        held += turn.messages;
      }
      const lines: ConversationLine[] = [];
      let cursor: string | undefined;
      reading: for (let read = 0; read < LIST_PAGES; read++) {
        const items = parseItems(await road.exec(itemsCommand({ threadId, ...(cursor !== undefined ? { cursor } : {}), ...launch }), questionEnv()), toolCallOf);
        for (const item of items.items) {
          if (item.turnId !== undefined && !kept.has(item.turnId)) break reading;
          lines.unshift(item.line);
        }
        if (items.next === undefined) break;
        cursor = items.next;
      }
      return { ...opened, ...newestLines(lines, total, o.last) };
    },
  };
  const probeCatalog = (exec: HarnessExec): Promise<HarnessCatalogAnswer> => exec(catalogProbeCommand(launch), questionEnv()).then(stdout => parseCatalogProbe(stdout, deps.login));

  return {
    start,
    attachments: "file",
    ...(attach !== undefined
      ? {
          attach: async (options: AdapterAttachOptions) => {
            const stream = await attach(options.run, { input: true, startedAt: options.startedAt, ...(options.from !== undefined ? { from: options.from } : {}) });
            return stream === "gone"
              ? "gone"
              : follow({
                  stream,
                  localId: options.sessionId,
                  startedAt: options.startedAt,
                  // Read from a later turn's start, the run holds no thread answer to announce the thread by.
                  ...(options.from !== undefined && options.from > 0 ? { from: options.from, opened: { threadId: options.sessionId } } : {}),
                  ...(options.model !== undefined ? { model: options.model } : {}),
                  ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                  ...(options.prompt !== undefined ? { owedTurn: (threadId: string) => turnLineFor({ threadId, prompt: options.prompt!, ...(options.effort !== undefined ? { effort: options.effort } : {}) }) } : {}),
                  onEvent: options.onEvent,
                });
          },
        }
      : {}),
    sessions,
    steers: true,
    reportsEdits: true,
    compacts: COMPACT,
    mcpServers: true,
    waitsForPrompt: true,
    aside,
    revert,
    conversations,
    probeCatalog,
    probeVersion: (exec: HarnessExec) => exec(versionProbeCommand(launch), questionEnv()).then(parseVersion),
    sessionTitle: (threadId, exec) => exec(sessionTitleCommand({ home: deps.home, threadId })).then(parseSessionTitle),
    renameSession: (threadId, title, exec) =>
      exec(renameCommand({ threadId, title, ...launch }), questionEnv()).then(parseRename),
    titleFor: (turn, exec) =>
      exec(
        titleForCommand({
          prompt: titlePrompt(turn.opening, turn.reply),
          ...(turn.model !== undefined ? { model: turn.model } : {}),
          ...launch,
        }),
        questionEnv(),
      ).then(parseTitleFor),
    draftFor: (ask, exec) =>
      exec(
        draftForCommand({
          promptFile: ask.promptFile,
          ...(ask.model !== undefined ? { model: ask.model } : {}),
          ...launch,
        }),
        questionEnv(),
      ).then(parseDraftFor),
    env,
  };
}
