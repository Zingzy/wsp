// Normalizes `claude -p --output-format stream-json` output into the small
// event set the runtime consumes. Classification logic follows pingdotgg/
// t3code ClaudeAdapter.ts (MIT, see NOTICE); event shapes are the ones
// recorded in solari-poc/RESULTS.md.

import { PERMISSION_DENY, RUN_EXIT_MS, backgroundTasksLine, endAfterResult, endRun, fmtDuration, harnessExitLine, titlePrompt } from "@wsp/protocol";
import type { AdapterAttachOptions, AdapterEvent, ExecStream, ExecStreamFactory, HarnessCatalogProbe, McpServerSpec, PermissionAsk, PermissionOutcome, ScreenCommand, SessionHarness, SessionRenamer, SessionTitleMaker, SessionTitleReader, TurnImage, TurnResult, TurnStatus } from "@wsp/protocol";
import { controlAnswerLine, controlErrorLine, controlLine, setModeLine } from "./permissions.js";
import { CLAUDE_SCREEN_COMMANDS, catalogProbeCommand, parseCatalogProbe } from "./catalog.js";
import { parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "./session-title.js";
import { INTERRUPT_GRACE_MS, buildCommand, buildEnv, newSessionId, userMessageLine } from "./landmines.js";
import { shellCwdAfter } from "./shell-cwd.js";

export interface StartOptions {
  prompt: string;
  /** Session id of an earlier run; the CLI reloads its transcript. */
  resume?: string;
  cwd?: string;
  /** Catalog slugs for --model, --effort and the permission flags; each absent one leaves the CLI's default. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
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

/** What moving a running turn's access came to: the CLI took it and its next tool call runs at the new mode, it
 * refused the mode in its own words, or the turn is over and its channel takes nothing. */
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
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** Writes a user message into the running turn; not-running before system/init and once result was seen or the process is gone. */
  steer(prompt: string): Promise<SteerOutcome>;
  /** Answers a permission prompt this turn raised, by the ask's own id and one of the options it carried; the tool
   * call it blocks runs or is refused as the option says. The caller names the outcome, since only it knows whether
   * this is the person's pick or its own answer for a prompt nobody came to, and denyMessage is what the agent
   * reads as the call's result when the option refuses it. */
  answer(askId: string, answer: { optionId: string; outcome: PermissionOutcome; denyMessage: string }): Promise<AnswerOutcome>;
  /** Puts this running turn into another access mode, from its next tool call on; settles on the CLI's own answer to
   * the request, so a mode it will not take comes back refused rather than as a silent no-op. */
  setAccess(mode: string): Promise<AccessOutcome>;
}

export interface AdapterDeps {
  exec: ExecStreamFactory;
  configDir: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  apiKey?: string;
  interruptGraceMs?: number;
  /** How long the CLI gets to exit on the EOF its result closed the channel with, before its process and its tree
   * are ended for it. */
  resultExitMs?: number;
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
  /** The CLI's stream-json user message carries image blocks, so an image never lands on the machine. */
  readonly attachments: "inline";
  /** The CLI takes MCP servers on the launch itself (--mcp-config), so a turn gets one whatever the config dir holds. */
  readonly mcpServers: true;
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
  if (str(event.subtype) === "success") return "completed";
  // The CLI stamps user aborts explicitly: "aborted_tools" mid-tool-call,
  // "aborted_streaming" mid-stream (t3code isInterruptedResult).
  const terminal = str(event.terminal_reason);
  if (terminal === "aborted_tools" || terminal === "aborted_streaming") return "interrupted";
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

function normalizeResult(event: Record<string, unknown>): TurnResult {
  const errors = strArr(event.errors) ?? [];
  return {
    status: resultStatus(event, errors.join(" ").toLowerCase()),
    durationMs: num(event.duration_ms),
    costUsd: num(event.total_cost_usd),
    usage: rec(event.usage),
    text: str(event.result),
    // "[ede_diagnostic] ..." entries are CLI-internal telemetry, hidden from
    // the CLI's own UI too (t3code resultUserFacingError).
    error: errors.find((entry) => !entry.startsWith("[ede_diagnostic]")),
  };
}

/** A success with no text and no token in its usage: the CLI refused the turn (a resume of a transcript a kill left
 * half-written) and said why on stderr only. */
function answeredNothing(result: TurnResult): boolean {
  if (result.status !== "completed" || (result.text ?? "").trim().length > 0) return false;
  return !Object.entries(result.usage ?? {}).some(([key, value]) => key.endsWith("_tokens") && (num(value) ?? 0) > 0);
}

/** The last lines the process printed that were not stream-json events: the CLI's stderr shares the log. */
const STDERR_TAIL_LINES = 5;

function noOutputError(result: TurnResult, stderrTail: readonly string[]): string {
  const head = `claude answered with no output and no usage after ${fmtDuration(result.durationMs ?? 0)}`;
  return stderrTail.length === 0 ? head : `${head}: ${stderrTail.join("\n")}`;
}

/** The CLI's own count of its live background tasks (commands and subagents the agent did not wait for), sent whole
 * each time the set changes; a CLI from before the signal never sends it, and its turns are never flagged. */
function backgroundTasksOf(event: Record<string, unknown>): number | undefined {
  if (str(event.type) !== "system" || str(event.subtype) !== "background_tasks_changed") return undefined;
  return Array.isArray(event.tasks) ? event.tasks.length : 0;
}

/** A success that arrived while the agent's background tasks still ran is a turn that ended before its work did: the
 * CLI kills those tasks on exit and no completion ever reaches the thread. The reply stays; the error says why. */
function endedEarly(result: TurnResult, backgroundTasks: number): TurnResult {
  if (result.status !== "completed" || backgroundTasks === 0) return result;
  return { ...result, status: "failed", error: backgroundTasksLine(backgroundTasks) };
}

function normalizeEvent(event: Record<string, unknown>, fallbackSessionId: string): AdapterEvent[] {
  const sessionId = str(event.session_id) ?? fallbackSessionId;
  switch (str(event.type)) {
    case "system": {
      if (str(event.subtype) !== "init") return [];
      const harness = harnessOf(event);
      return [
        {
          type: "session.start",
          sessionId,
          model: str(event.model),
          cwd: str(event.cwd),
          tools: strArr(event.tools),
          ...(harness !== undefined ? { harness } : {}),
        },
      ];
    }
    case "assistant": {
      const blocks = rec(event.message)?.content;
      if (!Array.isArray(blocks)) return [];
      const deltas: AdapterEvent[] = [];
      for (const raw of blocks) {
        const block = rec(raw);
        if (block === undefined) continue;
        switch (str(block.type)) {
          case "text":
            deltas.push({ type: "turn.delta", sessionId, kind: "text", text: str(block.text) ?? "" });
            break;
          case "thinking":
            deltas.push({
              type: "turn.delta",
              sessionId,
              kind: "thinking",
              text: str(block.thinking) ?? "",
            });
            break;
          case "tool_use":
            deltas.push({
              type: "turn.delta",
              sessionId,
              kind: "tool_use",
              text: JSON.stringify(block.input ?? null),
              toolName: str(block.name),
              toolUseId: str(block.id),
            });
            break;
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
        deltas.push({
          type: "turn.delta",
          sessionId,
          kind: "tool_result",
          text: flattenContent(block.content),
          toolUseId: str(block.tool_use_id),
          isError: block.is_error === true,
        });
      }
      return deltas;
    }
    case "result":
      return [{ type: "turn.done", sessionId, result: normalizeResult(event) }];
    default:
      return [];
  }
}

export function createClaudeAdapter(deps: AdapterDeps): ClaudeAdapter {
  const sessions = new Map<string, ClaudeSession>();
  const env = buildEnv({ base: deps.baseEnv, configDir: deps.configDir, apiKey: deps.apiKey });

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
    /** The prompts this turn raised and nobody has answered yet, by the CLI's own request id. The CLI runs nothing
     * while one is open, so an entry here is what the turn is waiting on. */
    const pending = new Map<string, PermissionAsk>();
    /** The control requests this adapter sent that the CLI has not answered yet, by the id it was sent under. It
     * answers every one, and one still open when the channel shuts is settled rather than left waiting. */
    const asked = new Map<string, (outcome: AccessOutcome) => void>();
    let askedSeq = 0;

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

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) {
            const text = raw.trim();
            if (text.length > 0 && stderrTail.push(text) > STDERR_TAIL_LINES) stderrTail.shift();
            continue;
          }
          const control = controlLine(event);
          if (control !== undefined) {
            switch (control.kind) {
              case "ask":
                pending.set(control.ask.askId, control.ask);
                onEvent({ type: "permission.ask", sessionId: claudeSessionId, ask: control.ask });
                break;
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
          const tasks = backgroundTasksOf(event);
          if (tasks !== undefined) {
            backgroundTasks = tasks;
            continue;
          }
          for (const normalized of normalizeEvent(event, claudeSessionId)) {
            if (normalized.type === "session.start") {
              claudeSessionId = normalized.sessionId;
              sawInit = true;
              harnessCwd = normalized.cwd;
              shellCwd = normalized.cwd;
            }
            if (normalized.type === "turn.delta" && normalized.kind === "tool_use" && shellCwd !== undefined && harnessCwd !== undefined) {
              const moved = shellCwdAfter(normalized.toolName, parseInput(normalized.text), shellCwd, harnessCwd);
              if (moved !== undefined) {
                shellCwd = moved;
                normalized.cwd = moved;
              }
            }
            if (normalized.type === "turn.done") {
              sawResult = true;
              // The CLI waits for more input after its result; EOF is what lets it exit, and a CLI that does not go
              // on its own is ended with its tree once the wait passes rather than left for the idle cut.
              stream.closeInput();
              // The channel is shut, so a request still unanswered will never be: the caller is told now rather
              // than waiting on the process to go, which is minutes on a harness that lingers.
              settleAsked("gone");
              void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS).catch(() => {});
              normalized.result = endedEarly(normalized.result, backgroundTasks);
              // Held until the process exits, since the CLI writes its reason to stderr after the result.
              if (answeredNothing(normalized.result)) {
                emptyResult = normalized.result;
                continue;
              }
              turnResult = normalized.result;
            }
            onEvent(normalized);
          }
        }
      } catch (cause) {
        // The transport ended the turn itself and its message says why; that message is the turn's error.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      exited = true;
      // The process is gone, so nothing can answer these; the rows say so rather than waiting for an answer that
      // has nowhere to land.
      for (const askId of [...pending.keys()]) closeAsk(askId, "cancelled");
      settleAsked("gone");
      if (turnResult === undefined) {
        turnResult =
          emptyResult !== undefined
            ? { ...emptyResult, status: "failed", error: noOutputError(emptyResult, stderrTail) }
            : interruptRequested
              ? { status: "interrupted" }
              : {
                  status: "failed",
                  error: streamError ?? harnessExitLine("claude", exitCode, env["PATH"]),
                };
        onEvent({ type: "turn.done", sessionId: claudeSessionId, result: turnResult });
      }
      onEvent({ type: "session.end", sessionId: claudeSessionId, exitCode, sawResult });
      return turnResult;
    })();

    const session: ClaudeSession = {
      localId,
      get claudeSessionId() {
        return claudeSessionId;
      },
      ...(o.command !== undefined ? { command: o.command } : {}),
      ...(stream.run !== undefined ? { run: stream.run } : {}),
      finished,
      steer: async (prompt) => {
        if (!running()) return "not-running";
        const wrote = await stream.write(userMessageLine(prompt, claudeSessionId));
        // The turn may have ended while the write travelled; the line then sits unread and the caller starts a turn.
        return wrote === "written" && running() ? "accepted" : "not-running";
      },
      answer: async (askId, { optionId, outcome, denyMessage }) => {
        const ask = pending.get(askId);
        if (ask === undefined || exited) return "gone";
        // Taken off the map before the write, so two answers racing on one prompt cannot both reach the CLI, which
        // ignores the second and would leave a second closed row behind it.
        pending.delete(askId);
        const wrote = await stream.write(controlAnswerLine(ask, optionId, denyMessage));
        if (wrote !== "written") return "gone";
        onEvent({ type: "permission.close", sessionId: claudeSessionId, askId, outcome, optionId });
        return "answered";
      },
      setAccess: async (mode) => {
        if (!running()) return "gone";
        const requestId = `wsp-set-mode-${++askedSeq}`;
        const answered = new Promise<AccessOutcome>((resolve) => asked.set(requestId, resolve));
        const wrote = await stream.write(setModeLine(requestId, mode));
        if (wrote !== "written") {
          asked.delete(requestId);
          return "gone";
        }
        return answered;
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
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      contextWindow: options.contextWindow,
      ...(options.title !== undefined ? { name: options.title } : {}),
      ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    });
    const stream = deps.exec(command, { env: { ...env }, input: [userMessageLine(options.prompt, localId, options.images)] });
    return follow({ stream, localId, announced: false, command, onEvent: options.onEvent });
  };

  const attach = deps.exec.attach?.bind(deps.exec);

  return {
    start,
    ...(attach !== undefined
      ? {
          attach: async (options: AdapterAttachOptions) => {
            const stream = await attach(options.run, { input: true });
            return stream === "gone" ? "gone" : follow({ stream, localId: options.sessionId, announced: true, onEvent: options.onEvent });
          },
        }
      : {}),
    sessions,
    steers: true,
    attachments: "inline",
    mcpServers: true,
    screenCommands: CLAUDE_SCREEN_COMMANDS,
    probeCatalog: exec => exec(catalogProbeCommand({ configDir: deps.configDir, baseEnv: deps.baseEnv })).then(parseCatalogProbe),
    sessionTitle: (sessionId, exec) => exec(sessionTitleCommand({ configDir: deps.configDir, sessionId })).then(parseSessionTitle),
    renameSession: (sessionId, title, exec) => exec(renameCommand({ configDir: deps.configDir, sessionId, title })).then(parseRename),
    titleFor: (turn, exec) =>
      exec(
        titleForCommand({
          configDir: deps.configDir,
          prompt: titlePrompt(turn.opening, turn.reply),
          ...(turn.model !== undefined ? { model: turn.model } : {}),
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
        }),
      ).then(parseTitleFor),
    env,
  };
}
