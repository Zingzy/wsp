// SPDX-License-Identifier: AGPL-3.0-only
// Normalizes `cursor-agent -p --output-format stream-json --stream-partial-output`
// output into the event set the runtime consumes, as cursor.com/docs/cli/
// reference/output-format documents it and cursor-cli 2026.09.26-dd393fe
// writes it (src/headless.ts): system init names the chat, assistant lines
// carry text, tool_call started and completed carry one call under the
// tool's own key, result ends the turn. A failure prints no event at all: its
// sentence goes to stderr and the process exits non-zero.
import { randomUUID } from "node:crypto";
import { INTERRUPT_GRACE_MS, RUN_EXIT_MS, endAfterResult, endRun, refusedTurn } from "@wsp/protocol";
import type { AdapterAttachOptions, AdapterEvent, AgentLaunch, ExecStream, ExecStreamFactory, TurnResult } from "@wsp/protocol";
import { buildCommand, buildEnv } from "./command.js";

export interface CursorStartOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  onEvent: (event: AdapterEvent) => void;
}

export interface CursorSession {
  /** Registry key: the resume id, or one minted here until init names the chat. */
  readonly localId: string;
  readonly sessionId: string;
  readonly command?: string;
  readonly run?: string;
  readonly pid?: number;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
}

export interface CursorAdapterDeps {
  exec: ExecStreamFactory;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** wsp's half of a turn the CLI refuses for want of a credential. */
  signInRefusal?: string;
  apiKey?: string;
  keyEnv?: string;
  interruptGraceMs?: number;
  resultExitMs?: number;
  /** The program the person runs in place of cursor-agent on this computer, and the words every turn's launch adds. */
  launch?: AgentLaunch;
}

/** No image flag and no control channel are documented, so it declares no attachments and no answer: a turn with an
 * image is refused in Cursor's name before anything runs, and a prompt the CLI would raise is never relayed. */
export interface CursorAdapter {
  start(options: CursorStartOptions): CursorSession;
  attach?(options: AdapterAttachOptions): Promise<CursorSession | "gone">;
  readonly sessions: ReadonlyMap<string, CursorSession>;
  readonly steers: false;
  readonly env: Readonly<Record<string, string>>;
}

/** What the CLI prints, on stderr and nowhere else, when it holds no credential (measured on 2026.09.26-dd393fe). */
const NO_CREDENTIAL = /^Error: Authentication required\b/;
const STDERR_TAIL_LINES = 5;

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
    return event !== undefined && typeof event["type"] === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

function textOf(event: Record<string, unknown>): string {
  const content = rec(event["message"])?.["content"];
  return Array.isArray(content) ? content.map(c => str(rec(c)?.["text"]) ?? "").join("") : "";
}

/** With --stream-partial-output only a line stamped with a time and naming no model call is new text; the other two
 * kinds repeat what was streamed, before a tool call and at the turn's end (the output-format doc's own table). */
const isStreamedText = (event: Record<string, unknown>): boolean => event["timestamp_ms"] !== undefined && event["model_call_id"] === undefined;

/** The call under the one key its tool names: `readToolCall` and its kin, or `function` with a name of its own. */
function callOf(event: Record<string, unknown>): { name: string; input: string; body: Record<string, unknown> } | undefined {
  const call = rec(event["tool_call"]);
  const key = call === undefined ? undefined : Object.keys(call)[0];
  const body = key === undefined ? undefined : rec(call?.[key]);
  if (key === undefined || body === undefined) return undefined;
  if (key === "function") return { name: str(body["name"]) ?? key, input: str(body["arguments"]) ?? "{}", body };
  return { name: key.replace(/ToolCall$/, ""), input: JSON.stringify(body["args"] ?? {}), body };
}

/** A result is one case: success with what the tool gave back, or the case that says why it gave nothing. */
function resultOf(body: Record<string, unknown>): { text: string; isError: boolean } {
  const result = rec(body["result"]) ?? {};
  const [kind, value] = Object.entries(result)[0] ?? ["success", undefined];
  const fields = rec(value);
  if (kind === "success") return { text: str(fields?.["content"]) ?? str(fields?.["stdout"]) ?? JSON.stringify(value ?? {}), isError: false };
  const why = str(fields?.["reason"]) ?? str(fields?.["error"]) ?? str(fields?.["stderr"]) ?? (value === undefined ? undefined : JSON.stringify(value));
  return { text: why === undefined ? kind : `${kind}: ${why}`, isError: true };
}

export function createCursorAdapter(deps: CursorAdapterDeps): CursorAdapter {
  const sessions = new Map<string, CursorSession>();
  const env = buildEnv({ base: deps.baseEnv, ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}), ...(deps.keyEnv !== undefined ? { keyEnv: deps.keyEnv } : {}) });
  const graceMs = deps.interruptGraceMs ?? INTERRUPT_GRACE_MS;

  const follow = (o: { stream: ExecStream; localId: string; command?: string; model?: string; cwd?: string; onEvent: (event: AdapterEvent) => void }): CursorSession => {
    const { stream, onEvent: emit } = o;
    let sessionId = o.localId;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    /** The text since the last tool call: the reply, where the result's own field runs every segment together. */
    let segment = "";
    let noCredential: string | undefined;
    const stderr: string[] = [];

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) {
            const text = raw.trim();
            if (NO_CREDENTIAL.test(text)) noCredential = text;
            if (text.length > 0 && stderr.push(text) > STDERR_TAIL_LINES) stderr.shift();
            continue;
          }
          switch (event["type"]) {
            case "system": {
              if (event["subtype"] !== "init") break;
              sessionId = str(event["session_id"]) ?? sessionId;
              emit({ type: "session.start", sessionId, ...(o.model !== undefined ? { model: o.model } : {}), ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) });
              break;
            }
            case "assistant": {
              const text = textOf(event);
              if (!isStreamedText(event) || text.length === 0) break;
              segment += text;
              emit({ type: "turn.delta", sessionId, kind: "text", text });
              break;
            }
            case "tool_call": {
              const call = callOf(event);
              const toolUseId = str(event["call_id"]) ?? "";
              if (call === undefined) break;
              if (event["subtype"] === "started") {
                segment = "";
                emit({ type: "turn.delta", sessionId, kind: "tool_use", text: call.input, toolName: call.name, toolUseId });
              } else if (event["subtype"] === "completed") {
                emit({ type: "turn.delta", sessionId, kind: "tool_result", toolUseId, ...resultOf(call.body) });
              }
              break;
            }
            case "result": {
              if (turnResult !== undefined) break;
              const durationMs = typeof event["duration_ms"] === "number" ? event["duration_ms"] : undefined;
              const said = str(event["result"]) ?? "";
              const usage = rec(event["usage"]);
              const tokens = usage === undefined ? undefined : { input: typeof usage["inputTokens"] === "number" ? usage["inputTokens"] : 0, output: typeof usage["outputTokens"] === "number" ? usage["outputTokens"] : 0 };
              turnResult =
                event["is_error"] === true
                  ? { status: "failed", ...(durationMs !== undefined ? { durationMs } : {}), error: said || "cursor reported a failed turn" }
                  : { status: "completed", ...(durationMs !== undefined ? { durationMs } : {}), text: segment || said, ...(tokens !== undefined ? { tokens } : {}) };
              emit({ type: "turn.done", sessionId, result: turnResult });
              void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, graceMs).catch(() => {});
              break;
            }
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
          : noCredential !== undefined
            ? refusedTurn({ status: "failed", error: noCredential }, { cause: "sign-in", ...(deps.signInRefusal !== undefined ? { road: deps.signInRefusal } : {}) })
            : { status: "failed", error: streamError ?? `cursor-agent exited with code ${String(exitCode)} before its turn ended${said}` };
        emit({ type: "turn.done", sessionId, result: turnResult });
      }
      emit({ type: "session.end", sessionId, exitCode, sawResult });
      return turnResult;
    })();

    const session: CursorSession = {
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

  const start = (options: CursorStartOptions): CursorSession => {
    if (options.contextWindow !== undefined) throw new Error("cursor takes no context window");
    if (options.effort !== undefined) throw new Error("cursor takes its effort inside the model name, not as its own pick");
    const command = buildCommand({
      prompt: options.prompt,
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      ...(deps.launch !== undefined ? { launch: deps.launch } : {}),
    });
    return follow({
      stream: deps.exec(command, { env: { ...env } }),
      localId: options.resume ?? randomUUID(),
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
            const stream = await attach(options.run, { input: false, startedAt: options.startedAt });
            return stream === "gone"
              ? "gone"
              : follow({
                  stream,
                  localId: options.sessionId,
                  ...(options.model !== undefined ? { model: options.model } : {}),
                  ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                  onEvent: options.onEvent,
                });
          },
        }
      : {}),
    sessions,
    steers: false,
    env,
  };
}
