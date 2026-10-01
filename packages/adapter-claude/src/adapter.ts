// Normalizes `claude -p --output-format stream-json` output into the small
// event set the runtime consumes. Classification logic follows pingdotgg/
// t3code ClaudeAdapter.ts (MIT, see NOTICE); event shapes are the ones
// recorded in solari-poc/RESULTS.md.

import { ASIDE_WALL_MS, INTERRUPT_GRACE_MS, PERMISSION_ALLOW, PERMISSION_DENY, RUN_EXIT_MS, asideWallLine, backgroundTasksLine, endAfterResult, endRun, fmtDuration, harnessExitLine, refusedTurn, taskFinishedLine, titlePrompt } from "@wsp/protocol";
import type { AdapterAttachOptions, AdapterEvent, AsideAnswer, AsideQuestion, ExecStream, ExecStreamFactory, HarnessCatalogProbe, McpServerSpec, PermissionAsk, PermissionOutcome, ScreenCommand, SessionAsker, SessionHarness, SessionRenamer, SessionTitleMaker, SessionTitleReader, TurnImage, TurnRefusal, TurnResult, TurnStatus, CommitDrafter, PlanStep, TurnTokens, HarnessLimit, LimitKind, LimitStatus, LimitWindow } from "@wsp/protocol";
import { SKIP_PROMPTS_MODE, controlAllowLine, controlAnswerLine, controlErrorLine, controlLine, modeOptionOn, setModeLine } from "./permissions.js";
import { CLAUDE_SCREEN_COMMANDS, catalogProbeCommand, parseCatalogProbe } from "./catalog.js";
import { asideAnswer, asideCommand, forkCleanupCommand } from "./aside.js";
import { draftForCommand, parseDraftFor, parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "./session-title.js";
import { buildCommand, buildEnv, newSessionId, savedSpendCommand, userMessageLine } from "./landmines.js";
import { shellCwdAfter } from "./shell-cwd.js";

export interface StartOptions {
  prompt: string;
  /** Session id of an earlier run; the CLI reloads its transcript. */
  resume?: string;
  /** The uuid of the message a rewind kept, on the first resume after it: the CLI loads the session up to that
   * message and the turn goes on from there, leaving what came after it behind. */
  resumeAt?: string;
  cwd?: string;
  /** Catalog slugs for --model, --effort and the permission flags; each absent one leaves the CLI's default. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** The model's faster output for this turn. */
  fast?: boolean;
  /** The name the session is opened under; the CLI records it as the person's own, so nothing generated replaces it. */
  title?: string;
  /** Images for this turn, read off their bytes: this CLI takes them inline, so none of them is on the machine. */
  images?: readonly TurnImage[];
  /** MCP servers this turn gets besides the config dir's own, by the name each takes in a config. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  onEvent: (event: AdapterEvent) => void;
}

export type SteerOutcome = "accepted" | "not-running";

/** What answering a permission prompt came to: the CLI took the answer, or the prompt is no longer open (answered
 * already, withdrawn by the CLI, or its turn is over). */
export type AnswerOutcome = "answered" | "gone";

/** What moving a running turn's access came to: the turn is at the new mode, the CLI refused the mode in its own
 * words and this host had no way to stand in for it, or the turn is over and its channel takes nothing. Set covers
 * the mode the CLI takes only at launch: the request comes back refused and the turn runs at that mode anyway,
 * because this host answers its prompts from here on. */
export type AccessOutcome = "set" | "refused" | "gone";

export interface ClaudeSession {
  /** Registry key, fixed before spawn (self-generated UUID, or the resume id). */
  readonly localId: string;
  /** The id the CLI reports in system/init; equals localId unless the CLI re-keys. */
  readonly claudeSessionId: string;
  /** The line the launch ran; absent on a session attached to a run some earlier process launched. */
  readonly command?: string;
  /** What a later host process attaches to this turn by; absent when its run dies with this process. */
  readonly run?: string;
  /** The process this turn leads on the computer the host runs on, where it runs there; absent on a turn running on
   * another machine. */
  readonly pid?: number;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** Writes a user message into the running turn; not-running before system/init and once result was seen or the process is gone. */
  steer(prompt: string): Promise<SteerOutcome>;
  /** Answers a permission prompt this turn raised, by the ask's own id and one of the options it carried; the tool
   * call it blocks runs or is refused as the option says. The caller names the outcome, since only it knows whether
   * this is the person's pick or its own answer for a prompt nobody came to, and denyMessage is what the agent
   * reads as the call's result when the option refuses it. */
  answer(askId: string, answer: { optionId: string; outcome: PermissionOutcome; denyMessage: string }): Promise<AnswerOutcome>;
  /** Puts this running turn into another access mode, from its next tool call on, and puts it to the prompt the turn
   * is stopped on: a mode that asks nobody answers that prompt, and a mode the CLI itself offered on that call
   * answers it as that option. Settles on the CLI's own answer to the request otherwise, so a mode it will not take
   * and this host cannot stand in for comes back refused rather than as a silent no-op. */
  setAccess(mode: string): Promise<AccessOutcome>;
}

export interface AdapterDeps {
  exec: ExecStreamFactory;
  /** Where this CLI keeps its sessions on the machine, read for transcripts and titles: the folder the login's
   * CLAUDE_CONFIG_DIR names, else the CLI's own default under its home. Never exported from here; see buildEnv. */
  configDir: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** The folder under the CLI's projects directory this workspace's sessions and memory are keyed to; absent
   * leaves the CLI keying off the folder each turn runs in. */
  projectDirName?: string;
  apiKey?: string;
  /** The long-lived token the vault holds for this agent; set on every turn's environment. */
  oauthToken?: string;
  interruptGraceMs?: number;
  /** How long the CLI gets to exit on the EOF its result closed the channel with, before its process and its tree
   * are ended for it. The same window it gets to wake its agent in once the background tasks of a held reply are
   * done, for the same reason: it is how long this adapter waits on a CLI that has something left to do. */
  resultExitMs?: number;
  /** wsp's half of a turn this workspace's agent refuses for want of a sign-in, from the one rule every door reads
   * for how it is signed in; it differs between the person's own computer and a machine, which only the caller
   * knows. Absent leaves such a turn carrying the CLI's own sentence alone. */
  signInRefusal?: string;
  /** How long a side question may run before its process is ended; ASIDE_WALL_MS unless a test says otherwise. */
  asideWallMs?: number;
}

export interface ClaudeAdapter {
  start(options: StartOptions): ClaudeSession;
  /** Re-opens a turn this CLI is still running on the machine, by the run handle the launch reported; `gone` is the
   * machine's own answer that it no longer holds the run, and nothing is emitted for one. A machine that answers
   * nothing rejects. Absent when the exec factory's runs die with the process that launched them. */
  attach?(options: AdapterAttachOptions): Promise<ClaudeSession | "gone">;
  readonly sessions: ReadonlyMap<string, ClaudeSession>;
  /** Sessions take a message mid-turn over the stdin channel. */
  readonly steers: true;
  /** A rewind of a Claude Code thread is cut on its next resume, at the message the rewind kept. */
  readonly resumesAt: true;
  /** The CLI's stream-json user message carries image blocks, so an image never lands on the machine. */
  readonly attachments: "inline";
  /** The CLI takes MCP servers on the launch itself (--mcp-config), so a turn gets one whatever the config dir holds. */
  readonly mcpServers: true;
  /** An access picked while a turn runs reaches that turn: over the control channel, and on the prompt it is stopped on. */
  readonly movesAccess: true;
  /** The commands the CLI runs only in its own terminal; the composer keeps them out of its menu and sends none. */
  readonly screenCommands: ReadonlyArray<ScreenCommand>;
  /** Makes the binary describe itself under the same config dir as a session; null when it did not answer. The
   * handshake carries no reason of its own, so this probe has no refusal to hand the footer. */
  probeCatalog(exec: (command: string) => Promise<string>): Promise<HarnessCatalogProbe | null>;
  /** What the CLI's own session file calls a session: its generated title, or the person's rename inside the CLI. */
  sessionTitle: SessionTitleReader;
  /** Names the session in that same file, with the record the CLI's own rename appends. */
  renameSession: SessionRenamer;
  /** Asks the CLI itself, in one print-mode turn, for a name for a thread it has just replied in. */
  titleFor: SessionTitleMaker;
  draftFor: CommitDrafter;
  /** Answers a question on a fork of a session with no tools, the fork's file removed once the answer is read. */
  aside: SessionAsker;
  /** What every session's command is exported with; the one environment a turn on the machine gets. */
  readonly env: Readonly<Record<string, string>>;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strArr(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function harnessOf(init: Record<string, unknown>): SessionHarness | undefined {
  const slashCommands = strArr(init.slash_commands);
  const permissionMode = str(init.permissionMode);
  const agents = strArr(init.agents);
  if (slashCommands === undefined && permissionMode === undefined && agents === undefined) return undefined;
  return {
    ...(slashCommands !== undefined ? { slashCommands } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(agents !== undefined ? { agents } : {}),
  };
}

function parseLine(raw: string): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (!line.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const event = rec(value);
  return event !== undefined && typeof event.type === "string" ? event : undefined;
}

function parseInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function flattenContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => str(rec(block)?.text) ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function resultStatus(event: Record<string, unknown>, errorsText: string): TurnStatus {
  // The CLI stamps user aborts explicitly: "aborted_tools" mid-tool-call,
  // "aborted_streaming" mid-stream (t3code isInterruptedResult). Read before
  // anything else: the person ended this turn, whatever word the CLI settled
  // on for it and whether or not it flagged its own result as an error.
  const terminal = str(event.terminal_reason);
  if (terminal === "aborted_tools" || terminal === "aborted_streaming") return "interrupted";
  // is_error is the CLI's own flag on its own result, and it outranks the subtype: a turn it refused before the
  // agent ran comes back as a success carrying the refusal (measured on 2.1.257 with a home that has no login).
  if (str(event.subtype) === "success") return event.is_error === true ? "failed" : "completed";
  if (errorsText.includes("interrupt") || errorsText.includes("cancel")) return "interrupted";
  if (
    str(event.subtype) === "error_during_execution" &&
    event.is_error === false &&
    (errorsText.includes("request was aborted") || errorsText.includes("aborted"))
  ) {
    return "interrupted";
  }
  return "failed";
}

/** Every token a call's usage says the model read: the fresh input, the part written to the cache and the part read
 * back from it. */
function inputTokens(usage: Record<string, unknown>): number {
  return (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0);
}

/** What the model held after one call, off that call's own usage: what it read and what it wrote. */
function heldTokens(usage: Record<string, unknown>): number {
  return inputTokens(usage) + (num(usage.output_tokens) ?? 0);
}

type ModelUse = NonNullable<TurnResult["models"]>[number];

const MODEL_FIELDS = ["input", "output", "cached", "cacheWrite", "reasoning"] as const;

/** Each model's running totals as Claude Code keeps them, off a result's modelUsage or a saved cost-state line's. input
 * counts the fresh, the written and the cached part, as every turn's tokens do, and thinking is already inside output. */
function modelsOf(raw: unknown): ModelUse[] {
  return Object.entries(rec(raw) ?? {}).flatMap(([model, value]) => {
    const row = rec(value);
    if (row === undefined) return [];
    const cached = num(row.cacheReadInputTokens) ?? 0;
    const cacheWrite = num(row.cacheCreationInputTokens) ?? 0;
    const costUsd = num(row.costUSD);
    const tokens = { input: (num(row.inputTokens) ?? 0) + cached + cacheWrite, output: num(row.outputTokens) ?? 0, cached, cacheWrite, reasoning: num(row.thinkingTokens) ?? 0 };
    return [{ model, tokens, ...(costUsd !== undefined ? { costUsd } : {}) }];
  });
}

/** The turn's tokens off its result: the usage sums the agent's own calls of the turn, and modelUsage keeps each model's
 * running totals for the session, subagents included, with its window. */
function resultTokens(event: Record<string, unknown>): { tokens?: TurnTokens; models?: ModelUse[] } {
  const usage = rec(event.usage);
  const windows = Object.values(rec(event.modelUsage) ?? {}).flatMap(raw => {
    const window = num(rec(raw)?.contextWindow);
    return window !== undefined ? [window] : [];
  });
  const models = event.modelUsage === undefined ? undefined : modelsOf(event.modelUsage);
  const cached = usage === undefined ? undefined : num(usage.cache_read_input_tokens);
  const cacheWrite = usage === undefined ? undefined : num(usage.cache_creation_input_tokens);
  return {
    ...(usage !== undefined
      ? {
          tokens: {
            input: inputTokens(usage),
            output: num(usage.output_tokens) ?? 0,
            ...(cached !== undefined ? { cached } : {}),
            ...(cacheWrite !== undefined ? { cacheWrite } : {}),
            ...(windows.length > 0 ? { window: Math.max(...windows) } : {}),
          },
        }
      : {}),
    ...(models !== undefined ? { models } : {}),
  };
}

/** What a session's file saved of its running totals before the turn: the cost and each model's use. */
interface SavedUse {
  costUsd?: number;
  models: ModelUse[];
}

const spentBy = (m: ModelUse): number => m.tokens.input + m.tokens.output;

/** One model's running totals less where they stood before the turn, or the whole of them where they started again. */
function gained(now: ModelUse, before: ModelUse | undefined): ModelUse {
  if (before === undefined || MODEL_FIELDS.some(k => now.tokens[k] < before.tokens[k])) return now;
  const tokens = { ...now.tokens };
  for (const k of MODEL_FIELDS) tokens[k] -= before.tokens[k];
  const costUsd = now.costUsd === undefined ? undefined : Math.max(0, now.costUsd - (before.costUsd ?? 0));
  return { model: now.model, tokens, ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** The turn's own use: the session's running totals less what its file saved before the turn, the cost and each
 * model's, or the whole of a total that started again under that. The model is the one that did the most of it. */
function ownUse(result: TurnResult, saved: SavedUse | undefined): TurnResult {
  const total = result.costUsd;
  const costUsd = total === undefined || saved?.costUsd === undefined || total < saved.costUsd ? total : total - saved.costUsd;
  const models = result.models?.map(m => gained(m, saved?.models.find(b => b.model === m.model))).filter(m => spentBy(m) > 0);
  const model = models?.reduce<ModelUse | undefined>((best, m) => (best === undefined || spentBy(m) > spentBy(best) ? m : best), undefined)?.model;
  return { ...result, ...(costUsd !== undefined ? { costUsd } : {}), ...(models !== undefined ? { models } : {}), ...(model !== undefined ? { model } : {}) };
}

function normalizeResult(event: Record<string, unknown>, refusal: { road?: string; cause?: TurnRefusal } | undefined): TurnResult {
  const errors = strArr(event.errors) ?? [];
  const result: TurnResult = {
    status: resultStatus(event, errors.join(" ").toLowerCase()),
    durationMs: num(event.duration_ms),
    costUsd: num(event.total_cost_usd),
    ...resultTokens(event),
    text: str(event.result),
    // "[ede_diagnostic] ..." entries are CLI-internal telemetry, hidden from
    // the CLI's own UI too (t3code resultUserFacingError).
    error: errors.find((entry) => !entry.startsWith("[ede_diagnostic]")),
  };
  return event.is_error === true && result.status === "failed" ? refusedTurn(result, refusal) : result;
}

/** What wsp classes a refusal as, by the CLI's own name for what refused the turn; a name no cause claims is a
 * refusal wsp has no road out of and leaves the CLI's sentence to stand alone. Adding a cause is a row here. */
const REFUSAL_CAUSES: Readonly<Record<string, TurnRefusal>> = { authentication_failed: "sign-in" };

/** The CLI writes a line of its own into the stream as an assistant message when a request failed, marked as its own
 * and with no model behind it; it is the turn's error and the result carries it again, so it is no reply of the
 * agent's and never a delta. Answers the cause it named, null where wsp claims none. */
function apiErrorCause(event: Record<string, unknown>): TurnRefusal | null | undefined {
  if (str(event.type) !== "assistant" || event.is_api_error_message !== true) return undefined;
  return REFUSAL_CAUSES[str(event.error) ?? ""] ?? null;
}

/** A success with no text and no token counted: the CLI refused the turn (a resume of a transcript a kill left
 * half-written) and said why on stderr only. */
function answeredNothing(result: TurnResult): boolean {
  if (result.status !== "completed" || (result.text ?? "").trim().length > 0) return false;
  return (result.tokens?.input ?? 0) + (result.tokens?.output ?? 0) === 0;
}

/** The result with what the follow saw beside it: what the model held at the end, and the model the CLI announced
 * where the result named none. */
function withContext(result: TurnResult, context: number | undefined, initModel: string | undefined): TurnResult {
  const model = result.model ?? initModel;
  const tokens = result.tokens === undefined || context === undefined ? result.tokens : { ...result.tokens, context };
  return { ...result, ...(tokens !== undefined ? { tokens } : {}), ...(model !== undefined ? { model } : {}) };
}

/** What the model held after a compaction the CLI ran mid-turn, off its own boundary line. */
function compactedTo(event: Record<string, unknown>): number | undefined {
  if (str(event.type) !== "system" || str(event.subtype) !== "compact_boundary") return undefined;
  return num(rec(event.compact_metadata)?.post_tokens);
}

/** The last lines the process printed that were not stream-json events: the CLI's stderr shares the log. */
const STDERR_TAIL_LINES = 5;

function noOutputError(result: TurnResult, stderrTail: readonly string[]): string {
  const head = `claude answered with no output and no usage after ${fmtDuration(result.durationMs ?? 0)}`;
  return stderrTail.length === 0 ? head : `${head}: ${stderrTail.join("\n")}`;
}

/** The call that launched the subagent this line announces, by the CLI's own handle for that subagent. The CLI names
 * a subagent by that handle on the prompts its run raises, and names the call only here, so a turn keeps the pair. */
function subagentLaunch(event: Record<string, unknown>): { agentId: string; toolUseId: string } | undefined {
  if (str(event.type) !== "system" || str(event.subtype) !== "task_started") return undefined;
  const agentId = str(event.task_id);
  const toolUseId = str(event.tool_use_id);
  return agentId === undefined || toolUseId === undefined ? undefined : { agentId, toolUseId };
}

/** The CLI's own live background tasks (commands and subagents the agent did not wait for), sent whole each time the
 * set changes, each with the CLI's own handle and its one phrase for the command; a CLI from before the signal never
 * sends it, and a turn on such a CLI is never held. A line whose payload is not a set reads as the empty set, which
 * is what it says: nothing of the agent's is running. */
function backgroundTasksOf(event: Record<string, unknown>): { id: string; description: string }[] | undefined {
  if (str(event.type) !== "system" || str(event.subtype) !== "background_tasks_changed") return undefined;
  if (!Array.isArray(event.tasks)) return [];
  return event.tasks.flatMap(raw => {
    const task = rec(raw);
    const id = str(task?.task_id);
    return id === undefined ? [] : [{ id, description: str(task?.description) ?? id }];
  });
}

/** One background task the CLI says is over, with how it ended in its own word. */
function taskFinishedOf(event: Record<string, unknown>): { id: string; status: string } | undefined {
  if (str(event.type) !== "system" || str(event.subtype) !== "task_notification") return undefined;
  const id = str(event.task_id);
  const status = str(event.status);
  return id === undefined || status === undefined ? undefined : { id, status };
}

/** The CLI's answer to a report on work an earlier process of the session started: on a resume after a run that died
 * with a command in the background, it reports that command stopped and answers the report as a turn of its own,
 * empty and in milliseconds, before the message the resume was sent with (measured on 2.1.284). */
function drainedNotice(event: Record<string, unknown>): boolean {
  if (str(event.type) !== "result" || str(rec(event.origin)?.kind) !== "task-notification" || num(event.num_turns) !== 0) return false;
  return answeredNothing(normalizeResult(event, undefined));
}

/** The turn's plan as its calls so far built it. */
interface PlanBook {
  /** The ids of the calls read as the plan, whose results are bookkeeping and draw nothing either. */
  calls: Set<string>;
  /** The list TaskCreate and TaskUpdate keep, in the order its tasks were made, each by the id the CLI gave it. */
  tasks: { id?: string; text: string; state: PlanStep["state"] }[];
  /** A TaskCreate's task by its call, until the call's result names the id the CLI gave it. */
  unnamed: Map<string, number>;
}

const newPlanBook = (): PlanBook => ({ calls: new Set(), tasks: [], unnamed: new Map() });

const stepState = (status: unknown): PlanStep["state"] => (status === "completed" ? "done" : status === "in_progress" ? "working" : "pending");

/** A call the agent keeps its plan in, read into the book: TodoWrite's list whole each time the agent rewrites it,
 * 2.1.283's task list one TaskCreate or TaskUpdate at a time, and the Markdown ExitPlanMode proposes. Undefined for
 * any other call; null for a plan call with nothing new to show, a TaskList or a TaskGet. */
function readPlanCall(name: string | undefined, input: unknown, id: string | undefined, book: PlanBook): { steps: PlanStep[] } | { text: string } | null | undefined {
  const fields = rec(input);
  const listed = (): { steps: PlanStep[] } => ({ steps: book.tasks.map(({ text, state }) => ({ text, state })) });
  switch (name) {
    case "TodoWrite": {
      if (!Array.isArray(fields?.todos)) return undefined;
      const todos = fields.todos.map(rec).filter((t): t is Record<string, unknown> => t !== undefined);
      return { steps: todos.map(t => ({ text: str(t.content) ?? "", state: stepState(t.status) })) };
    }
    case "ExitPlanMode": {
      const plan = str(fields?.plan);
      return plan === undefined ? undefined : { text: plan };
    }
    case "TaskCreate":
      if (id !== undefined) book.unnamed.set(id, book.tasks.length);
      book.tasks.push({ text: str(fields?.subject) ?? "", state: "pending" });
      return listed();
    case "TaskUpdate": {
      const at = book.tasks.findIndex(t => t.id !== undefined && t.id === str(fields?.taskId));
      if (at === -1) return null;
      if (fields?.status === "deleted") book.tasks.splice(at, 1);
      else book.tasks[at] = { ...book.tasks[at]!, ...(fields?.status !== undefined ? { state: stepState(fields.status) } : {}), ...(str(fields?.subject) !== undefined ? { text: str(fields?.subject)! } : {}) };
      return listed();
    }
    case "TaskList":
    case "TaskGet":
      return null;
    default:
      return undefined;
  }
}

function normalizeEvent(event: Record<string, unknown>, fallbackSessionId: string, refusal: { road?: string; cause?: TurnRefusal } | undefined, plans: PlanBook): AdapterEvent[] {
  const sessionId = str(event.session_id) ?? fallbackSessionId;
  // A subagent's lines ride the parent's stream and carry the call that launched it; the parent's own carry null.
  const parent = str(event.parent_tool_use_id);
  const from = parent === undefined ? {} : { parentToolUseId: parent };
  switch (str(event.type)) {
    case "system": {
      if (str(event.subtype) !== "init") return [];
      const harness = harnessOf(event);
      // Claude Code names where its credential came from; any source but none is a key, which has no plan window.
      const keySource = str(event.apiKeySource);
      const keyed: AdapterEvent[] = keySource !== undefined && keySource !== "none" ? [{ type: "limit", sessionId, limit: { windows: [], keyed: true } }] : [];
      return [
        {
          type: "session.start",
          sessionId,
          model: str(event.model),
          cwd: str(event.cwd),
          tools: strArr(event.tools),
          ...(harness !== undefined ? { harness } : {}),
        },
        ...keyed,
      ];
    }
    case "assistant": {
      const message = rec(event.message);
      const blocks = message?.content;
      if (!Array.isArray(blocks)) return [];
      // The blocks of one message share its id, so a reply broken into several of them stays one message and only a
      // message the CLI wrote later opens another.
      const messageId = str(message?.id);
      const said = messageId === undefined ? {} : { messageId };
      const deltas: AdapterEvent[] = [];
      for (const raw of blocks) {
        const block = rec(raw);
        if (block === undefined) continue;
        switch (str(block.type)) {
          case "text":
            deltas.push({ type: "turn.delta", sessionId, kind: "text", text: str(block.text) ?? "", ...said, ...from });
            break;
          case "thinking":
            deltas.push({
              type: "turn.delta",
              sessionId,
              kind: "thinking",
              text: str(block.thinking) ?? "",
              ...from,
            });
            break;
          case "tool_use": {
            const id = str(block.id);
            const plan = parent === undefined ? readPlanCall(str(block.name), block.input, id, plans) : undefined;
            if (plan !== undefined) {
              if (id !== undefined) plans.calls.add(id);
              if (plan !== null) deltas.push({ type: "turn.plan", sessionId, ...plan });
              break;
            }
            deltas.push({
              type: "turn.delta",
              sessionId,
              kind: "tool_use",
              text: JSON.stringify(block.input ?? null),
              toolName: str(block.name),
              toolUseId: str(block.id),
              ...from,
            });
            break;
          }
          default:
            break;
        }
      }
      return deltas;
    }
    case "user": {
      const blocks = rec(event.message)?.content;
      if (!Array.isArray(blocks)) return [];
      const deltas: AdapterEvent[] = [];
      for (const raw of blocks) {
        const block = rec(raw);
        if (block === undefined || str(block.type) !== "tool_result") continue;
        const answered = str(block.tool_use_id);
        if (answered !== undefined && plans.calls.delete(answered)) {
          // A TaskCreate's result is where the CLI names the id its later TaskUpdates take.
          const at = plans.unnamed.get(answered);
          const named = /#(\d+)/.exec(flattenContent(block.content))?.[1];
          if (at !== undefined && named !== undefined && plans.tasks[at] !== undefined) plans.tasks[at]!.id = named;
          plans.unnamed.delete(answered);
          continue;
        }
        deltas.push({
          type: "turn.delta",
          sessionId,
          kind: "tool_result",
          text: flattenContent(block.content),
          toolUseId: str(block.tool_use_id),
          isError: block.is_error === true,
          ...from,
        });
      }
      return deltas;
    }
    case "result":
      return [{ type: "turn.done", sessionId, result: normalizeResult(event, refusal) }];
    case "rate_limit_event": {
      const limit = limitOf(rec(event.rate_limit_info));
      return limit === undefined ? [] : [{ type: "limit", sessionId, limit }];
    }
    default:
      return [];
  }
}

/** Claude Code's name for each window as wsp's kind. The overage buckets are one kind: both are use past the plan. */
const LIMIT_KIND: Record<string, LimitKind> = {
  five_hour: "session",
  seven_day: "week",
  seven_day_opus: "week_opus",
  seven_day_sonnet: "week_sonnet",
  seven_day_overage_included: "overage",
  overage: "overage",
};
const LIMIT_STATUS: Record<string, LimitStatus> = { allowed: "ok", allowed_warning: "warning", rejected: "reached" };

/** A rate_limit_event's reading: every window it tracks under unifiedWindows, else the one window it names at the top
 * level, utilization (a fraction, above 1 when a window ran past its cap) as a percent and resetsAt (epoch seconds) in
 * ms. A reading with no utilization for any window says nothing about the plan and is dropped. Claude Code names no
 * account in it. */
function limitOf(info: Record<string, unknown> | undefined): HarnessLimit | undefined {
  if (info === undefined) return undefined;
  const windows: LimitWindow[] = [];
  const add = (type: string, reading: Record<string, unknown> | undefined): void => {
    const kind = LIMIT_KIND[type];
    const used = num(reading?.utilization);
    if (kind === undefined || used === undefined || windows.some(w => w.kind === kind)) return;
    const resetsAt = num(reading?.resetsAt);
    windows.push({ kind, usedPercent: Math.round(used * 1000) / 10, ...(resetsAt !== undefined ? { resetsAt: resetsAt * 1000 } : {}) });
  };
  for (const [type, reading] of Object.entries(rec(info.unifiedWindows) ?? {})) add(type, rec(reading));
  const top = str(info.rateLimitType);
  if (top !== undefined) add(top, info);
  if (windows.length === 0) return undefined;
  const status = LIMIT_STATUS[str(info.status) ?? ""];
  return { windows, ...(status !== undefined ? { status } : {}) };
}

export function createClaudeAdapter(deps: AdapterDeps): ClaudeAdapter {
  if (!deps.configDir.trim().startsWith("/")) throw new Error(`configDir must be an absolute path, got "${deps.configDir}"`);
  const sessions = new Map<string, ClaudeSession>();
  const env = buildEnv({
    base: deps.baseEnv,
    apiKey: deps.apiKey,
    ...(deps.oauthToken !== undefined ? { oauthToken: deps.oauthToken } : {}),
    ...(deps.projectDirName !== undefined ? { projectDirName: deps.projectDirName } : {}),
  });

  /** wsp's half for a refusal the CLI named a cause for: the road the caller handed this adapter, which is the one
   * rule every door reads for how this workspace is signed in, and the cause the failure is classed by. */
  const refusalOf = (cause: TurnRefusal | null | undefined): { road?: string; cause?: TurnRefusal } | undefined => {
    if (cause === undefined) return undefined;
    const road = cause === "sign-in" ? deps.signInRefusal : undefined;
    return { ...(road !== undefined ? { road } : {}), ...(cause !== null ? { cause } : {}) };
  };

  /** Everything a turn is once its stream exists. The launch and the attach differ only in where the stream came
   * from and in what is already known: an attached turn's CLI announced itself to an earlier host process, so it
   * takes a message from the first byte rather than waiting for an init line it may have printed long ago. */
  const follow = (o: { stream: ExecStream; localId: string; announced: boolean; command?: string; onEvent: (event: AdapterEvent) => void }): ClaudeSession => {
    const { stream, localId, onEvent } = o;

    let claudeSessionId = localId;
    let sawInit = o.announced;
    let sawResult = false;
    let exited = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let emptyResult: TurnResult | undefined;
    const stderrTail: string[] = [];
    let harnessCwd: string | undefined;
    let shellCwd: string | undefined;
    let backgroundTasks = 0;
    /** The reply the agent gave while the CLI still reported work it started running: the turn is not over, so the
     * reply is kept here and delivered once nothing it started is left running. */
    let heldReply: TurnResult | undefined;
    /** When that reply came, so a task finishing after it says how long after. Wall clock here and not the CLI's
     * own: on a turn re-opened after a host restart the run's log is replayed from its first byte, so the figure a
     * finished line carries is measured from the replay and not from the words the person read an hour ago. */
    let heldAt = 0;
    /** The CLI's one phrase for each background task it has reported, by its own handle for it: only the set lines
     * carry it, and the line a finished task gets is written from it. */
    const taskNames = new Map<string, string>();
    const plans = newPlanBook();
    /** What the model held after its last call, the agent's own and never a subagent's: the last reply's usage, or a
     * compaction's figure where one came after it. The result's usage sums the turn, so it cannot say this. */
    let heldContext: number | undefined;
    let initModel: string | undefined;
    /** The session's running totals as its file saved them before this turn, which every result's totals start from. */
    let saved: SavedUse | undefined;
    /** The messages whose call was already reported as drawn: every block of a message repeats the message's usage. */
    const drawn = new Set<string>();
    /** One line per task that finished after the held reply, in the order the CLI reported them. */
    const finishedAfter: string[] = [];
    /** Running while a held reply waits out the CLI's silence: its tasks are done, and this is the window it has to
     * wake its agent in before that reply is the turn's. */
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set when the CLI announces its agent again under a held reply: it woke the agent with the tasks' end (or a
     * message), and that agent's own result is the next word. Nothing times it out: a woken agent running a
     * foreground command, or thinking, prints nothing for as long as that takes (measured on 2.1.280: the init comes
     * with the notification, the agent's first line only once its first block is whole). */
    let woken = false;
    /** What the last error the CLI wrote into the stream itself was for, null where wsp claims no cause for it;
     * undefined until it writes one. */
    let refusalCause: TurnRefusal | null | undefined;
    /** The prompts this turn raised and nobody has answered yet, by the CLI's own request id. The CLI runs nothing
     * while one is open, so an entry here is what the turn is waiting on. */
    const pending = new Map<string, PermissionAsk>();
    /** The control requests this adapter sent that the CLI has not answered yet, by the id it was sent under. It
     * answers every one, and one still open when the channel shuts is settled rather than left waiting. */
    const asked = new Map<string, (outcome: AccessOutcome) => void>();
    let askedSeq = 0;
    /** The call each running subagent was launched by, by the CLI's handle for the subagent. */
    const launchedBy = new Map<string, string>();
    /** Set once this turn is moved to the mode that asks nobody: the CLI takes that one only at launch, so from here
     * every prompt it raises is allowed by this host and none of them reaches a person. */
    let skipsPrompts = false;

    /** Every request still waiting, answered as the caller's outcome; nothing can reach the CLI after this. */
    const settleAsked = (outcome: AccessOutcome): void => {
      for (const settle of [...asked.values()]) settle(outcome);
      asked.clear();
    };

    /** The turn is open to a line on the channel: its CLI has announced itself and has neither replied nor gone. */
    const running = (): boolean => sawInit && !sawResult && !exited && !interruptRequested;

    const closeAsk = (askId: string, outcome: PermissionOutcome, optionId?: string): void => {
      pending.delete(askId);
      onEvent({ type: "permission.close", sessionId: claudeSessionId, askId, outcome, ...(optionId !== undefined ? { optionId } : {}) });
    };

    const exitMs = deps.resultExitMs ?? RUN_EXIT_MS;

    /** Everything the turn's reply being final comes to, wherever the reply came from: the CLI waits for more input
     * after its result and EOF is what lets it exit; the channel is shut, so a request still unanswered will never
     * be and the caller is told now rather than waiting minutes on a CLI that lingers; a CLI that does not go on its
     * own is ended with its tree once the wait passes rather than left for the idle cut. */
    /** The last message of the thread's own agent this turn wrote, by the uuid its session file keys it by: the
     * point a rewind to this turn keeps. A subagent's messages sit on a chain of their own and are left out. */
    let anchor: string | undefined;
    let anchored = false;
    const anchorOnce = (sessionId: string): void => {
      if (anchored || anchor === undefined) return;
      anchored = true;
      onEvent({ type: "turn.anchor", sessionId, anchor });
    };

    const deliver = (result: TurnResult, sessionId = claudeSessionId): void => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = undefined;
      heldReply = undefined;
      sawResult = true;
      stream.closeInput();
      settleAsked("gone");
      void endAfterResult(stream, exitMs, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS).catch(() => {});
      // Held until the process exits, since the CLI writes its reason to stderr after the result.
      if (answeredNothing(result)) {
        emptyResult = result;
        return;
      }
      turnResult = result;
      anchorOnce(sessionId);
      onEvent({ type: "turn.done", sessionId, result });
    };

    /** A held reply with one line under it per task that finished after it: the road where the CLI reported the
     * exits and never woke its agent, so these lines are the turn's own report of them. Where it did wake the agent,
     * that reply is the turn's and none of this is added. `running` is the tasks still going when the process
     * ended, a server the agent started among them, which never exits and so never wakes it: the agent replied and
     * the turn went as it should, so the reply stays done and the last line names that work, the line a thread's row
     * reads. */
    const heldWithFinished = (result: TurnResult, running = 0): TurnResult => {
      const lines = [...finishedAfter, ...(running > 0 && result.status === "completed" ? [backgroundTasksLine(running)] : [])];
      return lines.length === 0 ? result : { ...result, text: [result.text ?? "", "", ...lines].join("\n") };
    };

    /** A reply given after a held one, timed from the turn's launch: the CLI times each result from what started
     * it (the prompt, the wake, a message), so the held reply's figure and the wall time since it are the whole turn.
     * The CLI's own figure is the floor, since a turn re-opened after a host restart replays its log in a moment. */
    const spanned = (result: TurnResult): TurnResult => {
      if (heldReply?.durationMs === undefined) return result;
      return { ...result, durationMs: heldReply.durationMs + Math.max(Date.now() - heldAt, result.durationMs ?? 0) };
    };

    /** The window the CLI gets to wake its agent in once a held reply's tasks are done. Any line it prints starts
     * the window again, since a CLI that is saying something is about to reply; silence through it means the tasks
     * ended with nobody woken, and the words the agent already gave are the turn's. */
    const armSettle = (): void => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (heldReply !== undefined && backgroundTasks === 0) deliver(heldWithFinished(heldReply));
      }, exitMs);
    };

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          // A held reply waiting on nothing but silence: this line is the CLI saying something, so the window it has
          // to wake its agent in starts again.
          if (heldReply !== undefined && backgroundTasks === 0 && !woken) armSettle();
          const event = parseLine(raw);
          if (event === undefined) {
            const text = raw.trim();
            if (text.length > 0 && stderrTail.push(text) > STDERR_TAIL_LINES) stderrTail.shift();
            continue;
          }
          if (event.type === "cost-state") {
            if (str(event.sessionId) === localId) saved = { ...(num(event.totalCostUSD) !== undefined ? { costUsd: num(event.totalCostUSD)! } : {}), models: modelsOf(event.modelUsage) };
            continue;
          }
          if (event.type === "assistant" && typeof event.uuid === "string" && (event.parent_tool_use_id === undefined || event.parent_tool_use_id === null)) anchor = event.uuid;
          const control = controlLine(event);
          if (control !== undefined) {
            switch (control.kind) {
              case "ask": {
                if (skipsPrompts) {
                  void stream.write(controlAllowLine(control.ask));
                  break;
                }
                const parent = control.agentId === undefined ? undefined : launchedBy.get(control.agentId);
                const ask = parent === undefined ? control.ask : { ...control.ask, parentToolUseId: parent };
                pending.set(ask.askId, ask);
                onEvent({ type: "permission.ask", sessionId: claudeSessionId, ask });
                break;
              }
              case "cancel":
                // The CLI withdrew its own question (its turn was interrupted, or another client answered it).
                if (pending.has(control.requestId)) closeAsk(control.requestId, "cancelled");
                break;
              case "unknown":
                // The CLI waits on every control request it sends, so one this adapter cannot serve is refused
                // rather than left open.
                void stream.write(controlErrorLine(control.requestId, control.subtype));
                break;
              case "answer": {
                const settle = asked.get(control.requestId);
                asked.delete(control.requestId);
                settle?.(control.error === undefined ? "set" : "refused");
                break;
              }
            }
            continue;
          }
          const launch = subagentLaunch(event);
          if (launch !== undefined) {
            launchedBy.set(launch.agentId, launch.toolUseId);
            continue;
          }
          const tasks = backgroundTasksOf(event);
          if (tasks !== undefined) {
            for (const task of tasks) taskNames.set(task.id, task.description);
            backgroundTasks = tasks.length;
            // The runtime reads this to know the turn is working while the agent waits, which holds its idle clock.
            onEvent({ type: "turn.tasks", sessionId: claudeSessionId, running: backgroundTasks });
            if (heldReply !== undefined && backgroundTasks === 0 && !woken) armSettle();
            if (backgroundTasks > 0 && settleTimer !== undefined) {
              clearTimeout(settleTimer);
              settleTimer = undefined;
            }
            continue;
          }
          const over = taskFinishedOf(event);
          if (over !== undefined) {
            if (heldReply !== undefined) finishedAfter.push(taskFinishedLine(taskNames.get(over.id) ?? over.id, over.status, Date.now() - heldAt));
            continue;
          }
          // A report's answer with no reply held is not this turn's: the person's message is answered after it.
          if (heldReply === undefined && !sawResult && drainedNotice(event)) continue;
          const compacted = compactedTo(event);
          if (compacted !== undefined) heldContext = compacted;
          const call = str(event.type) === "assistant" && event.is_api_error_message !== true ? rec(event.message) : undefined;
          const callUsage = rec(call?.usage);
          const callId = str(call?.id);
          if (callUsage !== undefined && callId !== undefined && !drawn.has(callId)) {
            drawn.add(callId);
            onEvent({ type: "turn.usage", sessionId: claudeSessionId, tokens: heldTokens(callUsage) });
          }
          const usage = str(event.type) === "assistant" && str(event.parent_tool_use_id) === undefined ? rec(rec(event.message)?.usage) : undefined;
          if (usage !== undefined && event.is_api_error_message !== true) heldContext = heldTokens(usage);
          const cause = apiErrorCause(event);
          if (cause !== undefined) {
            refusalCause = cause;
            continue;
          }
          for (const normalized of normalizeEvent(event, claudeSessionId, refusalOf(refusalCause), plans)) {
            if (normalized.type === "session.start") {
              claudeSessionId = normalized.sessionId;
              initModel = normalized.model ?? initModel;
              sawInit = true;
              harnessCwd = normalized.cwd;
              shellCwd = normalized.cwd;
              if (heldReply !== undefined) {
                woken = true;
                if (settleTimer !== undefined) clearTimeout(settleTimer);
                settleTimer = undefined;
              }
            }
            if (normalized.type === "turn.delta" && normalized.kind === "tool_use" && shellCwd !== undefined && harnessCwd !== undefined) {
              const moved = shellCwdAfter(normalized.toolName, parseInput(normalized.text), shellCwd, harnessCwd);
              if (moved !== undefined) {
                shellCwd = moved;
                normalized.cwd = moved;
              }
            }
            if (normalized.type === "turn.done") {
              // The turn's reply is already out: the tasks ended in silence, the window passed and the held words
              // went as the turn's, and this is the CLI waking its agent after that. One turn is one reply, so it
              // is not delivered a second time; its cost would be added to the row again, its notify line sent
              // again and its reply row written again, and the agent's later words are already in the pane as
              // their own lines.
              if (sawResult) continue;
              woken = false;
              const result = spanned(withContext(ownUse(normalized.result, saved), heldContext, initModel));
              if (backgroundTasks > 0) {
                // The agent replied while the CLI still reports work it started. The turn is not over: ending it
                // here kills that work mid-write and nothing ever says what came of it, so the reply is kept, the
                // channel stays open and the stream goes on being read until nothing of the agent's is running.
                heldReply = result;
                heldAt = Date.now();
                finishedAfter.length = 0;
                continue;
              }
              deliver(result, normalized.sessionId);
              continue;
            }
            onEvent(normalized);
          }
        }
      } catch (cause) {
        // The transport ended the turn itself and its message says why; that message is the turn's error.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = undefined;
      const exitCode = await stream.exited;
      exited = true;
      // The process is gone, so nothing can answer these; the rows say so rather than waiting for an answer that
      // has nowhere to land.
      for (const askId of [...pending.keys()]) closeAsk(askId, "cancelled");
      settleAsked("gone");
      const exitLine = (): string =>
        streamError ?? harnessExitLine("claude", exitCode, env["PATH"], { reached: sawInit, ...(stream.signalled !== undefined ? { signal: stream.signalled } : {}) });
      if (turnResult === undefined && heldReply !== undefined) {
        // The hold ended with the process. The words the agent gave stand, done, with any task still in the set named
        // under them. A woken agent was cut before its own reply, so the turn reads what ended it: the idle rule, the
        // wall, or the process going.
        sawResult = true;
        turnResult = interruptRequested
          ? { ...heldReply, status: "interrupted" }
          : woken
            ? { ...heldReply, status: "failed", error: exitLine() }
            : heldWithFinished(heldReply, backgroundTasks);
        anchorOnce(claudeSessionId);
        onEvent({ type: "turn.done", sessionId: claudeSessionId, result: turnResult });
      }
      if (turnResult === undefined) {
        turnResult =
          emptyResult !== undefined
            ? { ...emptyResult, status: "failed", error: noOutputError(emptyResult, stderrTail) }
            : interruptRequested
              ? { status: "interrupted" }
              : { status: "failed", error: exitLine() };
        anchorOnce(claudeSessionId);
        onEvent({ type: "turn.done", sessionId: claudeSessionId, result: turnResult });
      }
      onEvent({ type: "session.end", sessionId: claudeSessionId, exitCode, sawResult });
      return turnResult;
    })();

    /** Answers a prompt this turn raised: the person's own pick, and this host's for a turn moved to a mode that
     * answers it by itself. A deny message exists only for a deny, which only a person makes. */
    const answerAsk = async (askId: string, o: { optionId: string; outcome: PermissionOutcome; denyMessage?: string }): Promise<AnswerOutcome> => {
      const ask = pending.get(askId);
      if (ask === undefined || exited) return "gone";
      // Taken off the map before the write, so two answers racing on one prompt cannot both reach the CLI, which
      // ignores the second and would leave a second closed row behind it.
      pending.delete(askId);
      const wrote = await stream.write(controlAnswerLine(ask, o.optionId, o.denyMessage ?? ""));
      if (wrote !== "written") return "gone";
      onEvent({ type: "permission.close", sessionId: claudeSessionId, askId, outcome: o.outcome, optionId: o.optionId });
      return "answered";
    };

    const session: ClaudeSession = {
      localId,
      get claudeSessionId() {
        return claudeSessionId;
      },
      ...(o.command !== undefined ? { command: o.command } : {}),
      ...(stream.run !== undefined ? { run: stream.run } : {}),
      ...(stream.pid !== undefined ? { pid: stream.pid } : {}),
      finished,
      steer: async (prompt) => {
        if (!running()) return "not-running";
        const wrote = await stream.write(userMessageLine(prompt, claudeSessionId));
        // The turn may have ended while the write travelled; the line then sits unread and the caller starts a turn.
        return wrote === "written" && running() ? "accepted" : "not-running";
      },
      answer: answerAsk,
      setAccess: async (mode) => {
        if (!running()) return "gone";
        const requestId = `wsp-set-mode-${++askedSeq}`;
        const answered = new Promise<AccessOutcome>((resolve) => asked.set(requestId, resolve));
        const wrote = await stream.write(setModeLine(requestId, mode));
        if (wrote !== "written") {
          asked.delete(requestId);
          return "gone";
        }
        if (mode === SKIP_PROMPTS_MODE) {
          // The CLI will not take this one on a turn already under way, so the turn goes to it here: every prompt it
          // raises from now is allowed by this host, and the ones it is stopped on are allowed now. Its answer to the
          // request is not waited for, since it cannot raise another prompt until the one in front of it is answered.
          skipsPrompts = true;
          for (const askId of [...pending.keys()]) await answerAsk(askId, { optionId: PERMISSION_ALLOW, outcome: "allowed" });
          return "set";
        }
        const outcome = await answered;
        // A prompt already open was raised at the mode the turn was in, so the CLI still holds it there; where the
        // mode the person picked is one the CLI offered on that very call, the pick answers it as well.
        if (outcome === "set") {
          for (const [askId, ask] of [...pending.entries()]) {
            const optionId = modeOptionOn(ask, mode);
            if (optionId !== undefined) await answerAsk(askId, { optionId, outcome: "allowed" });
          }
        }
        return outcome;
      },
      interrupt: async () => {
        interruptRequested = true;
        await endRun(stream, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
      },
    };
    sessions.set(localId, session);
    return session;
  };

  const start = (options: StartOptions): ClaudeSession => {
    const localId = options.resume ?? newSessionId();
    const command = buildCommand({
      ...(options.resume === undefined ? { sessionId: localId } : { resume: options.resume }),
      ...(options.resumeAt !== undefined ? { resumeAt: options.resumeAt } : {}),
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      contextWindow: options.contextWindow,
      ...(options.fast === true ? { fast: true } : {}),
      ...(options.title !== undefined ? { name: options.title } : {}),
      ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    });
    const launch = options.resume === undefined ? command : `${savedSpendCommand({ configDir: deps.configDir, sessionId: options.resume })}${command}`;
    const stream = deps.exec(launch, { env: { ...env }, input: [userMessageLine(options.prompt, localId, options.images)] });
    return follow({ stream, localId, announced: false, command: launch, onEvent: options.onEvent });
  };

  /** Removes the fork's file on the same road, once the side question's own run has ended; a removal that fails leaves
   * the answer standing. */
  const removeFork = async (fork: string): Promise<void> => {
    const cleanup = deps.exec(forkCleanupCommand({ fork, configDir: deps.configDir }), { env: { ...env } });
    for await (const _ of cleanup.lines);
    await cleanup.exited;
  };

  /** One run on the turn's road and environment, read to its end so the answer lands after the fork's file is gone. */
  const aside = async (q: AsideQuestion): Promise<AsideAnswer> => {
    const fork = newSessionId();
    const command = asideCommand({ session: q.session, fork, configDir: deps.configDir, ...(q.cwd !== undefined ? { cwd: q.cwd } : {}), ...(q.model !== undefined ? { model: q.model } : {}) });
    const stream = deps.exec(command, { env: { ...env }, input: [userMessageLine(q.question, fork)] });
    const wallMs = deps.asideWallMs ?? ASIDE_WALL_MS;
    let walled = false;
    const wall = setTimeout(() => {
      walled = true;
      void endRun(stream, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS).catch(() => {});
    }, wallMs);
    let answer: AsideAnswer | { error: string } | undefined;
    const said: string[] = [];
    let code: number | null;
    try {
      for await (const raw of stream.lines) {
        const event = parseLine(raw);
        if (event === undefined) {
          const text = raw.trim();
          if (text.length > 0 && said.push(text) > STDERR_TAIL_LINES) said.shift();
          continue;
        }
        if (event.type !== "result" || answer !== undefined) continue;
        answer = asideAnswer(event);
        stream.closeInput();
        void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS).catch(() => {});
      }
      code = await stream.exited;
    } finally {
      clearTimeout(wall);
      // Every road out, a transport that threw included, waits for the run to end and then removes the fork's file.
      await stream.exited.catch(() => null);
      await removeFork(fork).catch(() => {});
    }
    if (answer !== undefined) {
      if ("error" in answer) throw new Error(answer.error);
      return answer;
    }
    if (walled) throw new Error(asideWallLine(wallMs));
    throw new Error(said.length > 0 ? said.join("\n") : harnessExitLine("claude", code, env["PATH"], { reached: false }));
  };

  const attach = deps.exec.attach?.bind(deps.exec);

  return {
    start,
    ...(attach !== undefined
      ? {
          attach: async (options: AdapterAttachOptions) => {
            const stream = await attach(options.run, { input: true, startedAt: options.startedAt });
            return stream === "gone" ? "gone" : follow({ stream, localId: options.sessionId, announced: true, onEvent: options.onEvent });
          },
        }
      : {}),
    sessions,
    steers: true,
    resumesAt: true,
    movesAccess: true,
    attachments: "inline",
    mcpServers: true,
    screenCommands: CLAUDE_SCREEN_COMMANDS,
    probeCatalog: exec => exec(catalogProbeCommand({ baseEnv: deps.baseEnv })).then(parseCatalogProbe),
    sessionTitle: (sessionId, exec) => exec(sessionTitleCommand({ configDir: deps.configDir, sessionId })).then(parseSessionTitle),
    renameSession: (sessionId, title, exec) => exec(renameCommand({ configDir: deps.configDir, sessionId, title })).then(parseRename),
    titleFor: (turn, exec) =>
      exec(
        titleForCommand({
          prompt: titlePrompt(turn.opening, turn.reply),
          ...(turn.model !== undefined ? { model: turn.model } : {}),
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
        }),
      ).then(parseTitleFor),
    draftFor: (ask, exec) =>
      exec(
        draftForCommand({
          promptFile: ask.promptFile,
          ...(ask.model !== undefined ? { model: ask.model } : {}),
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
        }),
      ).then(parseDraftFor),
    aside,
    env,
  };
}
