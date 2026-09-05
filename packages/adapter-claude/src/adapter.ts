// Normalizes `claude -p --output-format stream-json` output into the small
// event set the runtime consumes. Classification logic follows pingdotgg/
// t3code ClaudeAdapter.ts (MIT, see NOTICE); event shapes are the ones
// recorded in solari-poc/RESULTS.md.

import { INTERRUPT_GRACE_MS, buildCommand, buildEnv, newSessionId } from "./landmines.js";

export type DeltaKind = "text" | "thinking" | "tool_use" | "tool_result";
export type TurnStatus = "completed" | "interrupted" | "failed";

export interface TurnResult {
  status: TurnStatus;
  durationMs?: number;
  costUsd?: number;
  usage?: Record<string, unknown>;
  text?: string;
  error?: string;
}

/** What system/init says about the CLI beyond model and tools; a client builds its composer catalog from it. */
export interface SessionHarness {
  slashCommands?: string[];
  permissionMode?: string;
  agents?: string[];
}

export type AdapterEvent =
  | {
      type: "session.start";
      sessionId: string;
      model?: string;
      cwd?: string;
      tools?: string[];
      harness?: SessionHarness;
    }
  | {
      type: "turn.delta";
      sessionId: string;
      kind: DeltaKind;
      text: string;
      toolName?: string;
      toolUseId?: string;
      isError?: boolean;
    }
  | { type: "turn.done"; sessionId: string; result: TurnResult }
  | { type: "session.end"; sessionId: string; exitCode: number | null; sawResult: boolean };

export interface ExecStream {
  readonly lines: AsyncIterable<string>;
  /** Graceful stop: close stdin / SIGTERM. */
  teardown(): void;
  /** SIGKILL. */
  kill(): void;
  readonly exited: Promise<number | null>;
}

export type ExecStreamFactory = (
  command: string,
  options: { env: Record<string, string> },
) => ExecStream;

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
  onEvent: (event: AdapterEvent) => void;
}

export interface ClaudeSession {
  /** Registry key, fixed before spawn (self-generated UUID, or the resume id). */
  readonly localId: string;
  /** The id the CLI reports in system/init; equals localId unless the CLI re-keys. */
  readonly claudeSessionId: string;
  readonly command: string;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
}

export interface AdapterDeps {
  exec: ExecStreamFactory;
  configDir: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  apiKey?: string;
  interruptGraceMs?: number;
}

export interface ClaudeAdapter {
  start(options: StartOptions): ClaudeSession;
  readonly sessions: ReadonlyMap<string, ClaudeSession>;
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

  const start = (options: StartOptions): ClaudeSession => {
    const localId = options.resume ?? newSessionId();
    const command = buildCommand({
      prompt: options.prompt,
      ...(options.resume === undefined ? { sessionId: localId } : { resume: options.resume }),
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      contextWindow: options.contextWindow,
    });
    const env = buildEnv({ base: deps.baseEnv, configDir: deps.configDir, apiKey: deps.apiKey });
    const stream = deps.exec(command, { env });

    let claudeSessionId = localId;
    let sawResult = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) continue;
          for (const normalized of normalizeEvent(event, claudeSessionId)) {
            if (normalized.type === "session.start") claudeSessionId = normalized.sessionId;
            if (normalized.type === "turn.done") {
              sawResult = true;
              turnResult = normalized.result;
            }
            options.onEvent(normalized);
          }
        }
      } catch (cause) {
        // A torn-down transport may throw mid-iteration; treat it as stream end.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      if (turnResult === undefined) {
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : {
              status: "failed",
              error:
                `claude exited with code ${String(exitCode)} before emitting a result` +
                (streamError === undefined ? "" : ` (stream error: ${streamError})`),
            };
        options.onEvent({ type: "turn.done", sessionId: claudeSessionId, result: turnResult });
      }
      options.onEvent({ type: "session.end", sessionId: claudeSessionId, exitCode, sawResult });
      return turnResult;
    })();

    const session: ClaudeSession = {
      localId,
      get claudeSessionId() {
        return claudeSessionId;
      },
      command,
      finished,
      interrupt: async () => {
        // t3code landmine: a graceful interrupt can be acknowledged while
        // background tasks keep the CLI alive. Teardown, then SIGKILL.
        interruptRequested = true;
        stream.teardown();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          stream.exited.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (timedOut) stream.kill();
        await stream.exited;
      },
    };
    sessions.set(localId, session);
    return session;
  };

  return { start, sessions };
}
