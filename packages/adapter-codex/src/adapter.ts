// SPDX-License-Identifier: AGPL-3.0-only
// Normalizes `codex exec --json` output into the event set the runtime
// consumes. The shapes are codex-rs/exec/src/exec_events.rs at rust-v0.153.0:
// thread.started names the thread a resume takes, items start and complete
// under one id each, turn.completed carries usage, turn.failed the error.
import { randomUUID } from "node:crypto";
import { codexMissingEnvLine, codexNotSignedInLine, codexReconnectLine } from "@wsp/protocol";
import type { AdapterEvent, ExecStreamFactory, TurnResult } from "@wsp/protocol";
import { INTERRUPT_GRACE_MS, buildCommand, buildEnv } from "./command.js";

export interface CodexStartOptions {
  prompt: string;
  /** The thread id an earlier turn announced; the CLI reloads that thread. */
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  onEvent: (event: AdapterEvent) => void;
}

export interface CodexSession {
  /** Registry key: the resume id, or one minted here, since the CLI announces its thread id only once it runs. */
  readonly localId: string;
  /** The id thread.started announced, equal to localId until it does. */
  readonly threadId: string;
  readonly command: string;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
}

export interface CodexAdapterDeps {
  exec: ExecStreamFactory;
  /** CODEX_HOME on the machine. */
  home: string;
  /** The catalog's command for signing codex in on a machine, named when a turn fails for want of one. */
  login: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  interruptGraceMs?: number;
  /** How long a run of Reconnecting error events with no turn progress may last before the turn is failed. */
  reconnectStallMs?: number;
}

export interface CodexAdapter {
  start(options: CodexStartOptions): CodexSession;
  readonly sessions: ReadonlyMap<string, CodexSession>;
  /** `codex exec` reads its prompt and closes stdin; nothing reaches a running turn. */
  readonly steers: false;
  readonly env: Readonly<Record<string, string>>;
}

type Item = Record<string, unknown> & { id: string; type: string };

/** The last lines the process printed that were not events: codex's stderr shares the log with its stdout. */
const STDERR_TAIL_LINES = 5;
/** A provider that wants an OpenAI login gets a 401, retried in error events, then the process dies. */
const UNAUTHORIZED = /401 Unauthorized/;
/** A provider whose env_key variable is unset: the CLI names the variable and fails the turn at once. */
const MISSING_ENV = /Missing environment variable: `([^`]+)`/;
/** A provider that refuses connections: the CLI prints this forever, whatever its retry settings say. */
const RECONNECTING = /^Reconnecting\.\.\./;
const RECONNECT_STALL_MS = 90_000;

/** The words for a failure the CLI reported in its own; undefined when its message stands as it is. */
function failureWords(message: string, login: string): string | undefined {
  if (UNAUTHORIZED.test(message)) return codexNotSignedInLine(login);
  const missing = MISSING_ENV.exec(message);
  return missing === null ? undefined : codexMissingEnvLine(missing[1]!);
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLine(raw: string): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (!line.startsWith("{")) return undefined;
  try {
    const event = rec(JSON.parse(line));
    return event !== undefined && typeof event.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

function itemOf(event: Record<string, unknown>): Item | undefined {
  const item = rec(event.item);
  const id = str(item?.id);
  const type = str(item?.type);
  return item !== undefined && id !== undefined && type !== undefined ? ({ ...item, id, type } as Item) : undefined;
}

const changeLines = (changes: unknown): string =>
  Array.isArray(changes)
    ? changes
        .map(rec)
        .filter((c): c is Record<string, unknown> => c !== undefined)
        .map(c => `${str(c.kind) ?? "change"} ${str(c.path) ?? ""}`.trim())
        .join("\n")
    : "";

/** Each item as the deltas a timeline draws: a call when it starts (or lands whole), its result when it completes. */
function itemDeltas(phase: string, item: Item, sessionId: string): AdapterEvent[] {
  const done = phase === "item.completed";
  const delta = (fields: Omit<Extract<AdapterEvent, { type: "turn.delta" }>, "type" | "sessionId">): AdapterEvent => ({ type: "turn.delta", sessionId, ...fields });
  switch (item.type) {
    case "agent_message":
      return done ? [delta({ kind: "text", text: str(item.text) ?? "" })] : [];
    case "reasoning":
      return done ? [delta({ kind: "thinking", text: str(item.text) ?? "" })] : [];
    case "command_execution": {
      if (phase === "item.started") return [delta({ kind: "tool_use", text: JSON.stringify({ command: str(item.command) ?? "" }), toolName: item.type, toolUseId: item.id })];
      if (!done) return [];
      return [delta({ kind: "tool_result", text: str(item.aggregated_output) ?? "", toolUseId: item.id, isError: str(item.status) !== "completed" })];
    }
    case "file_change":
      return done
        ? [
            delta({ kind: "tool_use", text: JSON.stringify({ changes: item.changes ?? [] }), toolName: item.type, toolUseId: item.id }),
            delta({ kind: "tool_result", text: changeLines(item.changes), toolUseId: item.id, isError: str(item.status) !== "completed" }),
          ]
        : [];
    case "mcp_tool_call": {
      const name = `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`;
      if (phase === "item.started") return [delta({ kind: "tool_use", text: JSON.stringify(item.arguments ?? {}), toolName: name, toolUseId: item.id })];
      if (!done) return [];
      const failed = str(item.status) !== "completed";
      const text = failed ? (str(rec(item.error)?.message) ?? "") : JSON.stringify(rec(item.result)?.content ?? []);
      return [delta({ kind: "tool_result", text, toolUseId: item.id, isError: failed })];
    }
    case "web_search":
      return done
        ? [
            delta({ kind: "tool_use", text: JSON.stringify({ query: str(item.query) ?? "" }), toolName: item.type, toolUseId: item.id }),
            delta({ kind: "tool_result", text: str(item.query) ?? "", toolUseId: item.id, isError: false }),
          ]
        : [];
    case "error":
      return done ? [delta({ kind: "tool_result", text: str(item.message) ?? "", toolName: item.type, toolUseId: item.id, isError: true })] : [];
    default:
      return [];
  }
}

export function createCodexAdapter(deps: CodexAdapterDeps): CodexAdapter {
  const sessions = new Map<string, CodexSession>();
  const env = buildEnv({ base: deps.baseEnv, home: deps.home });

  const start = (options: CodexStartOptions): CodexSession => {
    if (options.contextWindow !== undefined) throw new Error("codex takes no context window");
    const localId = options.resume ?? randomUUID();
    const command = buildCommand({
      prompt: options.prompt,
      resume: options.resume,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
    });
    const stream = deps.exec(command, { env: { ...env } });
    const startedAt = Date.now();

    let threadId = localId;
    let sawResult = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let lastText: string | undefined;
    /** The words for the last failure the stream showed, if any: a 401, a missing env var, or the reconnect loop. */
    let words: string | undefined;
    /** The last top-level error event: what the CLI said last when it dies without a turn.failed. */
    let lastError: string | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalledAt: number | undefined;
    const stderrTail: string[] = [];

    const emit = (event: AdapterEvent): void => options.onEvent(event);

    /** SIGTERM, then SIGKILL once the grace window passes without an exit. */
    const escalate = async (): Promise<void> => {
      stream.teardown();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        stream.exited.then(() => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(true), deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) stream.kill();
      await stream.exited;
    };
    const progress = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
      stalledAt = undefined;
    };
    /** Armed by the first Reconnecting line after the last progress; a run that outlives it ends the turn in words. */
    const reconnecting = (): void => {
      if (stallTimer !== undefined) return;
      stalledAt = Date.now();
      stallTimer = setTimeout(() => {
        words = codexReconnectLine(Date.now() - (stalledAt ?? startedAt));
        void escalate();
      }, deps.reconnectStallMs ?? RECONNECT_STALL_MS);
    };

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) {
            const text = raw.trim();
            words = failureWords(text, deps.login) ?? words;
            if (text.length > 0 && stderrTail.push(text) > STDERR_TAIL_LINES) stderrTail.shift();
            continue;
          }
          const type = str(event.type);
          if (type !== "error") progress();
          switch (type) {
            case "thread.started": {
              threadId = str(event.thread_id) ?? threadId;
              emit({ type: "session.start", sessionId: threadId, ...(options.model !== undefined ? { model: options.model } : {}), ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
              break;
            }
            case "item.started":
            case "item.updated":
            case "item.completed": {
              const item = itemOf(event);
              if (item === undefined) break;
              if (type === "item.completed" && item.type === "agent_message") lastText = str(item.text);
              for (const delta of itemDeltas(type, item, threadId)) emit(delta);
              break;
            }
            case "turn.completed": {
              sawResult = true;
              turnResult = { status: "completed", durationMs: Date.now() - startedAt, ...(lastText !== undefined ? { text: lastText } : {}), ...(rec(event.usage) !== undefined ? { usage: rec(event.usage) } : {}) };
              emit({ type: "turn.done", sessionId: threadId, result: turnResult });
              break;
            }
            case "turn.failed": {
              sawResult = true;
              const message = str(rec(event.error)?.message) ?? "codex reported a failed turn";
              words = failureWords(message, deps.login) ?? words;
              turnResult = { status: "failed", durationMs: Date.now() - startedAt, error: words ?? message };
              emit({ type: "turn.done", sessionId: threadId, result: turnResult });
              break;
            }
            case "error": {
              const message = str(event.message) ?? "";
              lastError = message;
              words = failureWords(message, deps.login) ?? words;
              if (RECONNECTING.test(message)) reconnecting();
              break;
            }
            default:
              break;
          }
        }
      } catch (cause) {
        // The transport ended the turn itself and its message says why; that message is the turn's error.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      progress();
      if (turnResult === undefined) {
        const reason = lastError ?? (stderrTail.length === 0 ? undefined : stderrTail.join("\n"));
        const died = `codex exited with code ${String(exitCode)} before its turn ended${reason === undefined ? "" : `: ${reason}`}`;
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : words !== undefined
            ? { status: "failed", error: words }
            : { status: "failed", error: streamError ?? died };
        emit({ type: "turn.done", sessionId: threadId, result: turnResult });
      }
      emit({ type: "session.end", sessionId: threadId, exitCode, sawResult });
      return turnResult;
    })();

    const session: CodexSession = {
      localId,
      get threadId() {
        return threadId;
      },
      command,
      finished,
      interrupt: async () => {
        interruptRequested = true;
        await escalate();
      },
    };
    sessions.set(localId, session);
    return session;
  };

  return { start, sessions, steers: false, env };
}
