// SPDX-License-Identifier: AGPL-3.0-only
// The JSON-RPC lines wsp writes to `codex app-server` on its stdin and reads
// back off its stdout, one object per line, as codex-cli 0.155.1's own schema
// (`codex app-server generate-json-schema`) spells them. The server leaves the
// jsonrpc field off every message it prints and takes messages without one.
import type { AccessParams } from "./command.js";

/** The ids of the requests a turn sends once each; a steer is numbered, since a turn may take several. */
export const REQUEST = { initialize: "wsp-initialize", thread: "wsp-thread", turn: "wsp-turn", interrupt: "wsp-interrupt", revert: "wsp-revert" } as const;

/** A request id as the server sends one: a string or an integer, echoed back as it came. */
export type RequestId = string | number;

const line = (message: Record<string, unknown>): string => JSON.stringify(message);

/** Only the fields the turn named, so a server default stands wherever wsp picked nothing. */
const named = (fields: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
};

export function initializeLine(): string {
  return line({ id: REQUEST.initialize, method: "initialize", params: { clientInfo: { name: "wsp", title: "wsp", version: "1" } } });
}

export const INITIALIZED_LINE = line({ method: "initialized" });

export interface ThreadOptions {
  cwd?: string;
  model?: string;
  /** The model's faster output, on a model the catalog marks as offering it. */
  serviceTier?: "fast";
  access: AccessParams;
}

export function threadStartLine(o: ThreadOptions): string {
  return line({ id: REQUEST.thread, method: "thread/start", params: { ...named({ cwd: o.cwd, model: o.model, serviceTier: o.serviceTier }), ...o.access } });
}

export function threadResumeLine(o: ThreadOptions & { threadId: string }): string {
  return line({ id: REQUEST.thread, method: "thread/resume", params: { threadId: o.threadId, ...named({ cwd: o.cwd, model: o.model, serviceTier: o.serviceTier }), ...o.access } });
}

/** A copy of the thread that is never written to disk, in a read-only sandbox that asks nobody: what a side question
 * runs on, since no turn takes its tools off. */
export function threadForkLine(o: { threadId: string; cwd?: string; model?: string; developerInstructions: string }): string {
  return line({
    id: REQUEST.thread,
    method: "thread/fork",
    params: { threadId: o.threadId, ephemeral: true, sandbox: "read-only", approvalPolicy: "never", ...named({ cwd: o.cwd, model: o.model }), developerInstructions: o.developerInstructions },
  });
}

/** The thread's persisted history cut to the turns before one: that turn and every later one leave it. Files are
 * not the server's to touch here. */
export function threadRevertLine(o: { threadId: string; beforeTurnId: string }): string {
  return line({ id: REQUEST.revert, method: "thread/revert", params: { threadId: o.threadId, beforeTurnId: o.beforeTurnId } });
}

const textInput = (text: string) => ({ type: "text", text });

export function turnStartLine(o: { threadId: string; text: string; images?: readonly string[]; effort?: string }): string {
  const input = [textInput(o.text), ...(o.images ?? []).map(path => ({ type: "localImage", path }))];
  return line({ id: REQUEST.turn, method: "turn/start", params: { threadId: o.threadId, input, ...named({ effort: o.effort }) } });
}

export function turnSteerLine(id: string, o: { threadId: string; turnId: string; text: string }): string {
  return line({ id, method: "turn/steer", params: { threadId: o.threadId, expectedTurnId: o.turnId, input: [textInput(o.text)] } });
}

export function turnInterruptLine(o: { threadId: string; turnId: string }): string {
  return line({ id: REQUEST.interrupt, method: "turn/interrupt", params: { threadId: o.threadId, turnId: o.turnId } });
}

/** accept and decline are the only decisions wsp sends: acceptForSession would let one click pass every later prompt
 * like it, and an execpolicy amendment writes policy into the person's config. */
export function decisionLine(id: RequestId, decision: "accept" | "decline"): string {
  return line({ id, result: { decision } });
}

/** The server waits on every request it sends, so one wsp does not serve is answered with an error. */
export function refuseRequestLine(id: RequestId, method: string): string {
  return line({ id, error: { code: -32601, message: `wsp does not answer ${method}` } });
}

export type RpcMessage =
  | { kind: "response"; id: RequestId; result: unknown }
  | { kind: "error"; id: RequestId; message: string }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "request"; id: RequestId; method: string; params: Record<string, unknown> };

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const isId = (value: unknown): value is RequestId => typeof value === "string" || typeof value === "number";

/** One line of the process's output as a message, or nothing where it is not one: codex's stderr shares the log. */
export function readMessage(raw: string): RpcMessage | undefined {
  const text = raw.trim();
  if (!text.startsWith("{")) return undefined;
  let message: Record<string, unknown> | undefined;
  try {
    message = rec(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (message === undefined) return undefined;
  const method = typeof message.method === "string" ? message.method : undefined;
  const params = rec(message.params) ?? {};
  if (method !== undefined) return isId(message.id) ? { kind: "request", id: message.id, method, params } : { kind: "notification", method, params };
  if (!isId(message.id)) return undefined;
  const error = rec(message.error);
  if (error !== undefined) return { kind: "error", id: message.id, message: typeof error.message === "string" ? error.message : "codex refused the request without saying why" };
  return "result" in message ? { kind: "response", id: message.id, result: message.result } : undefined;
}
