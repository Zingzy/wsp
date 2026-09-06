// SPDX-License-Identifier: AGPL-3.0-only
// What the verbs and the MCP server are tested against: a captured CliIO, a
// scripted harness that answers every prompt, one whose turn never ends, and
// the guest side of the exec stream over the stub backend.
import { randomUUID } from "node:crypto";
import type { TurnResult } from "@wsp/adapter-claude";
import type { ExecResult } from "@wsp/engine";
import type { HarnessAdapterFactory, HarnessStartOptions } from "@wsp/runtime";
import type { CliIO } from "../src/cli.js";
import type { StubBackend } from "./stub-backend.js";

export const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

export interface Captured extends CliIO {
  lines: string[];
  errors: string[];
  streamed: string;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
export function captured(): Captured {
  const io: Captured = {
    lines: [],
    errors: [],
    streamed: "",
    log: l => io.lines.push(l),
    error: l => io.errors.push(l),
    stream: t => (io.streamed += t),
    ask: noPrompt,
    askSecret: noPrompt,
  };
  return io;
}

/** A harness that answers every prompt with reply(prompt) in two text deltas, or fails the turn when the reply is
 * empty; a resumed start keeps the session id, as the real one does. */
export function scriptedAgent(reply: (prompt: string) => string) {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      const text = reply(o.prompt);
      const result: TurnResult = text === "" ? { status: "failed", error: "the harness died" } : { status: "completed", text };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        if (text !== "") {
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(0, 4) });
          o.onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: "ls", toolName: "Bash" });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(4) });
        }
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

/** A harness whose turn never ends: the session starts and nothing more arrives. */
export function stuckAgent(): HarnessAdapterFactory {
  return () => ({
    start: o => {
      const sessionId = randomUUID();
      queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
      return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });
}

/** The guest side of the exec stream: the launch lands, one poll hands over the log with the exit code; with no exit
 * the command reads as still running. */
export function execGuest(backend: StubBackend, output: string, exit: number | undefined) {
  const base = backend.execImpl;
  backend.execImpl = (m, cmd): Promise<ExecResult> | ExecResult => {
    if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    if (cmd.includes("kill -TERM") || cmd.includes("kill -KILL")) return { exitCode: 0, stdout: "", stderr: "" };
    const sentinel = /(__WSP_EOF_[a-z0-9]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) {
      const from = Number(/tail -c \+(\d+)/.exec(cmd)?.[1] ?? "1") - 1;
      const chunk = Buffer.from(output).subarray(from).toString("base64");
      return { exitCode: 0, stdout: `${chunk}\n${sentinel} ${exit ?? ""} ${exit === undefined ? "up" : "down"}\n`, stderr: "" };
    }
    return base(m, cmd);
  };
}

/** The script the launch carried to the machine, decoded. */
export function launchedScript(backend: StubBackend): string {
  const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
  return Buffer.from(/printf '%s' '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8");
}
