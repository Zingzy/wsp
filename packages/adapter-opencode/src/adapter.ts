// SPDX-License-Identifier: AGPL-3.0-only
// Normalizes `opencode run --format json` output into the event set the
// runtime consumes. The shapes are the run command's own in the 1.18.18
// binary: every line is {type, timestamp, sessionID, ...}; a text part is
// printed once it is whole, a tool part once it completed or failed,
// step_finish closes one model step with its reason, tokens and cost, and error
// carries the session's error. The session loop goes on past a step whose
// reason is tool-calls or unknown, and a content-filter step is followed by
// its error, so any other reason is the turn's end.
import { randomUUID } from "node:crypto";
import { INTERRUPT_GRACE_MS, RUN_EXIT_MS, endAfterResult, endRun, refusedTurn } from "@wsp/protocol";
import type { AdapterAttachOptions, AdapterEvent, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, TurnImage, TurnRefusal, TurnResult } from "@wsp/protocol";
import { catalogProbeCommand, parseCatalogProbe } from "./catalog.js";
import { buildCommand, buildEnv } from "./command.js";

export interface OpenCodeStartOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  title?: string;
  /** Each one read off its path on the machine, where the runtime landed it before the start. */
  images?: readonly TurnImage[];
  onEvent: (event: AdapterEvent) => void;
}

export interface OpenCodeSession {
  /** Registry key: the resume id, or one minted here until the first event names the session. */
  readonly localId: string;
  readonly sessionId: string;
  readonly command?: string;
  readonly run?: string;
  readonly pid?: number;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
}

export interface OpenCodeAdapterDeps {
  exec: ExecStreamFactory;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** wsp's half of a turn OpenCode refuses for want of a sign-in. */
  signInRefusal?: string;
  apiKey?: string;
  keyEnv?: string;
  interruptGraceMs?: number;
  resultExitMs?: number;
}

export interface OpenCodeAdapter {
  start(options: OpenCodeStartOptions): OpenCodeSession;
  attach?(options: AdapterAttachOptions): Promise<OpenCodeSession | "gone">;
  readonly sessions: ReadonlyMap<string, OpenCodeSession>;
  /** run reads its message and closes stdin; nothing reaches a running turn. */
  readonly steers: false;
  /** -f reads each file off the machine; an image goes through its Read tool, which hands the model the image. */
  readonly attachments: "file";
  probeCatalog(exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer>;
  readonly env: Readonly<Record<string, string>>;
}

/** The step reasons after which the session loop runs another step. */
const LOOP_GOES_ON = new Set(["tool-calls", "unknown", "content-filter"]);
const STDERR_TAIL_LINES = 10;

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseLine(raw: string): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (!line.startsWith("{")) return undefined;
  try {
    const event = rec(JSON.parse(line));
    return event !== undefined && typeof event["type"] === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

/** What the log line carrying this ref says failed: its logfmt `error="..."` field. */
function loggedError(stderr: readonly string[], ref: string): string | undefined {
  for (const line of stderr) {
    if (!line.includes(`ref=${ref} `)) continue;
    const quoted = /\berror="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
    if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1");
  }
  return undefined;
}

function failureOf(error: Record<string, unknown> | undefined, stderr: readonly string[]): { line: string; cause?: TurnRefusal } {
  const name = str(error?.["name"]);
  const data = rec(error?.["data"]);
  const ref = str(data?.["ref"]);
  const line = (ref === undefined ? undefined : loggedError(stderr, ref)) ?? str(data?.["message"]) ?? name ?? "opencode reported an error";
  const refused = name === "ProviderAuthError" || (name === "APIError" && data?.["statusCode"] === 401);
  return refused ? { line, cause: "sign-in" } : { line };
}

function toolDeltas(part: Record<string, unknown>, sessionId: string): AdapterEvent[] {
  const state = rec(part["state"]);
  const toolUseId = str(part["callID"]) ?? str(part["id"]) ?? "";
  const failed = str(state?.["status"]) === "error";
  return [
    { type: "turn.delta", sessionId, kind: "tool_use", text: JSON.stringify(state?.["input"] ?? {}), toolName: str(part["tool"]) ?? "tool", toolUseId },
    { type: "turn.delta", sessionId, kind: "tool_result", text: str(failed ? state?.["error"] : state?.["output"]) ?? "", toolUseId, isError: failed },
  ];
}

export function createOpenCodeAdapter(deps: OpenCodeAdapterDeps): OpenCodeAdapter {
  const sessions = new Map<string, OpenCodeSession>();
  const env = buildEnv({ base: deps.baseEnv, ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}), ...(deps.keyEnv !== undefined ? { keyEnv: deps.keyEnv } : {}) });
  const graceMs = deps.interruptGraceMs ?? INTERRUPT_GRACE_MS;

  const follow = (o: { stream: ExecStream; localId: string; startedAt: number; command?: string; model?: string; cwd?: string; onEvent: (event: AdapterEvent) => void }): OpenCodeSession => {
    const { stream, onEvent: emit } = o;
    let sessionId = o.localId;
    let announced = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let lastText: string | undefined;
    let failure: { line: string; cause?: TurnRefusal } | undefined;
    let costUsd = 0;
    const usage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const stderr: string[] = [];

    const failed = (f: { line: string; cause?: TurnRefusal }): TurnResult => {
      const result: TurnResult = { status: "failed", error: f.line };
      return f.cause === undefined ? result : refusedTurn(result, { cause: f.cause, ...(deps.signInRefusal !== undefined ? { road: deps.signInRefusal } : {}) });
    };
    const addStep = (part: Record<string, unknown>): void => {
      const tokens = rec(part["tokens"]);
      const cache = rec(tokens?.["cache"]);
      costUsd += num(part["cost"]);
      usage.input += num(tokens?.["input"]);
      usage.output += num(tokens?.["output"]);
      usage.reasoning += num(tokens?.["reasoning"]);
      usage.cache.read += num(cache?.["read"]);
      usage.cache.write += num(cache?.["write"]);
    };
    const completed = (): TurnResult => ({ status: "completed", durationMs: Date.now() - o.startedAt, costUsd, usage: { ...usage, cache: { ...usage.cache } }, ...(lastText !== undefined ? { text: lastText } : {}) });

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) {
            const text = raw.trim();
            if (text.length > 0 && stderr.push(text) > STDERR_TAIL_LINES) stderr.shift();
            continue;
          }
          const id = str(event["sessionID"]);
          if (!announced && id !== undefined) {
            announced = true;
            sessionId = id;
            emit({ type: "session.start", sessionId, ...(o.model !== undefined ? { model: o.model } : {}), ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) });
          }
          const part = rec(event["part"]);
          switch (event["type"]) {
            case "text": {
              const text = str(part?.["text"]) ?? "";
              if (text.trim().length === 0) break;
              lastText = text;
              const messageId = str(part?.["messageID"]);
              emit({ type: "turn.delta", sessionId, kind: "text", text, ...(messageId !== undefined ? { messageId } : {}) });
              break;
            }
            case "tool_use":
              if (part !== undefined) for (const delta of toolDeltas(part, sessionId)) emit(delta);
              break;
            case "step_finish": {
              if (part === undefined) break;
              addStep(part);
              if (turnResult !== undefined || failure !== undefined || LOOP_GOES_ON.has(str(part["reason"]) ?? "unknown")) break;
              turnResult = completed();
              emit({ type: "turn.done", sessionId, result: turnResult });
              void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, graceMs).catch(() => {});
              break;
            }
            case "error":
              failure ??= failureOf(rec(event["error"]), stderr);
              break;
            default:
              break;
          }
        }
      } catch (cause) {
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      const sawResult = turnResult !== undefined;
      if (turnResult === undefined) {
        const said = stderr.length === 0 ? "" : `: ${stderr.join("\n")}`;
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : failure !== undefined
            ? failed(failure)
            : exitCode === 0 && announced
              ? completed()
              : { status: "failed", error: streamError ?? `opencode exited with code ${String(exitCode)} before its turn ended${said}` };
        emit({ type: "turn.done", sessionId, result: turnResult });
      }
      emit({ type: "session.end", sessionId, exitCode, sawResult });
      return turnResult;
    })();

    const session: OpenCodeSession = {
      localId: o.localId,
      get sessionId() {
        return sessionId;
      },
      ...(o.command !== undefined ? { command: o.command } : {}),
      ...(stream.run !== undefined ? { run: stream.run } : {}),
      ...(stream.pid !== undefined ? { pid: stream.pid } : {}),
      finished,
      interrupt: async () => {
        interruptRequested = true;
        await endRun(stream, graceMs);
      },
    };
    sessions.set(o.localId, session);
    return session;
  };

  const imagePathOf = (image: TurnImage): string => {
    if (image.path === undefined) throw new Error("opencode reads images off the machine's disk; this one has no path on it");
    return image.path;
  };

  const start = (options: OpenCodeStartOptions): OpenCodeSession => {
    if (options.contextWindow !== undefined) throw new Error("opencode takes no context window");
    const command = buildCommand({
      prompt: options.prompt,
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.images !== undefined ? { images: options.images.map(imagePathOf) } : {}),
    });
    return follow({
      stream: deps.exec(command, { env: { ...env } }),
      localId: options.resume ?? randomUUID(),
      startedAt: Date.now(),
      command,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      onEvent: options.onEvent,
    });
  };

  const attach = deps.exec.attach?.bind(deps.exec);

  return {
    start,
    ...(attach !== undefined
      ? {
          attach: async (options: AdapterAttachOptions) => {
            const stream = await attach(options.run, { input: false });
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
    steers: false,
    attachments: "file",
    probeCatalog: exec => exec(catalogProbeCommand({ ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}) })).then(parseCatalogProbe),
    env,
  };
}
