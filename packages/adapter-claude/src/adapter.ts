// Normalizes `claude -p --output-format stream-json` output into the small
// event set the runtime consumes. Classification logic follows pingdotgg/
// t3code ClaudeAdapter.ts (MIT, see NOTICE); event shapes are the ones
// recorded in solari-poc/RESULTS.md.

import { catalogProbeCommand, parseCatalogProbe, type ClaudeCatalogProbe } from "./catalog.js";
import { INTERRUPT_GRACE_MS, buildCommand, buildEnv, newSessionId, userMessageLine } from "./landmines.js";
import { shellCwdAfter } from "./shell-cwd.js";

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
      /** The agent's tool shell folder after this tool_use, present only when the call moved it. */
      cwd?: string;
    }
  | { type: "turn.done"; sessionId: string; result: TurnResult }
  | { type: "session.end"; sessionId: string; exitCode: number | null; sawResult: boolean };

export interface ExecStream {
  readonly lines: AsyncIterable<string>;
  /** Graceful stop: SIGTERM. */
  teardown(): void;
  /** SIGKILL. */
  kill(): void;
  /** Appends one line to the process's stdin channel, or answers gone when the process already ended where it runs;
   * rejects once the stream ended or when it was started without one. */
  write(line: string): Promise<"written" | "gone">;
  /** Ends the stdin channel: the process reads EOF. Nothing after the stream ended. */
  closeInput(): void;
  readonly exited: Promise<number | null>;
}

export type ExecStreamFactory = (
  command: string,
  options: {
    env: Record<string, string>;
    /** Present, the process's stdin is a line channel seeded with these lines; absent, the process gets no channel. */
    input?: readonly string[];
  },
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

export type SteerOutcome = "accepted" | "not-running";

export interface ClaudeSession {
  /** Registry key, fixed before spawn (self-generated UUID, or the resume id). */
  readonly localId: string;
  /** The id the CLI reports in system/init; equals localId unless the CLI re-keys. */
  readonly claudeSessionId: string;
  readonly command: string;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** Writes a user message into the running turn; not-running before system/init and once result was seen or the process is gone. */
  steer(prompt: string): Promise<SteerOutcome>;
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
  /** Sessions take a message mid-turn over the stdin channel. */
  readonly steers: true;
  /** Makes the binary describe itself under the same config dir as a session; null when it did not answer. */
  probeCatalog(exec: (command: string) => Promise<string>): Promise<ClaudeCatalogProbe | null>;
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

  const start = (options: StartOptions): ClaudeSession => {
    const localId = options.resume ?? newSessionId();
    const command = buildCommand({
      ...(options.resume === undefined ? { sessionId: localId } : { resume: options.resume }),
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      contextWindow: options.contextWindow,
    });
    const stream = deps.exec(command, { env: { ...env }, input: [userMessageLine(options.prompt, localId)] });

    let claudeSessionId = localId;
    let sawInit = false;
    let sawResult = false;
    let exited = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let harnessCwd: string | undefined;
    let shellCwd: string | undefined;

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) continue;
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
              turnResult = normalized.result;
              // The CLI waits for more input after its result; EOF is what lets it exit.
              stream.closeInput();
            }
            options.onEvent(normalized);
          }
        }
      } catch (cause) {
        // The transport ended the turn itself and its message says why; that message is the turn's error.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      exited = true;
      if (turnResult === undefined) {
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : {
              status: "failed",
              error: streamError ?? `claude exited with code ${String(exitCode)} before emitting a result`,
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
      steer: async (prompt) => {
        const running = (): boolean => sawInit && !sawResult && !exited && !interruptRequested;
        if (!running()) return "not-running";
        const wrote = await stream.write(userMessageLine(prompt, claudeSessionId));
        // The turn may have ended while the write travelled; the line then sits unread and the caller starts a turn.
        return wrote === "written" && running() ? "accepted" : "not-running";
      },
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

  return { start, sessions, steers: true, probeCatalog: exec => exec(catalogProbeCommand({ configDir: deps.configDir })).then(parseCatalogProbe), env };
}
