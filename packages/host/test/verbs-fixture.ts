// SPDX-License-Identifier: AGPL-3.0-only
// What the verbs and the MCP server are tested against: a captured CliIO, a
// scripted harness that answers every prompt, one whose turn never ends, and
// the guest side of the exec stream over the stub backend.
import { randomUUID } from "node:crypto";
import type { TurnResult } from "@wsp/adapter-claude";
import { tarOf, type ExecResult } from "@wsp/engine";
import type { HarnessAdapterFactory, HarnessStartOptions, ProjectBundler } from "@wsp/runtime";
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
    steers: false,
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

/** A harness that answers every prompt with reply(prompt) and then never says its session ended: the done lands, the
 * end does not. What a real turn looks like from the client between the reply and the runtime's late exit read. */
export function doneOnlyAgent(reply: (prompt: string) => string) {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: reply(o.prompt) };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: result.text ?? "" });
        o.onEvent({ type: "turn.done", sessionId, result });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

/** A harness whose every turn runs until the test releases it with the reply text; a resumed start keeps the session
 * id, and with steers the turn takes a message mid-way. */
export function heldAgent(steers: boolean) {
  const starts: HarnessStartOptions[] = [];
  const steered: string[] = [];
  const turns: { sessionId: string; onEvent: HarnessStartOptions["onEvent"]; finish: (r: TurnResult) => void }[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      let finish!: (r: TurnResult) => void;
      const finished = new Promise<TurnResult>(r => (finish = r));
      turns.push({ sessionId, onEvent: o.onEvent, finish });
      queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {},
        ...(steers
          ? {
              steer: async (prompt: string) => {
                steered.push(prompt);
                return "accepted" as const;
              },
            }
          : {}),
      };
    },
  });
  const release = (turn: number, text: string): void => {
    const t = turns[turn]!;
    t.onEvent({ type: "turn.delta", sessionId: t.sessionId, kind: "text", text });
    t.onEvent({ type: "turn.done", sessionId: t.sessionId, result: { status: "completed", text } });
    t.onEvent({ type: "session.end", sessionId: t.sessionId, exitCode: 0, sawResult: true });
    t.finish({ status: "completed", text });
  };
  return { adapter, starts, steered, release };
}

/** A harness whose turn never ends: the session starts and nothing more arrives. */
export function stuckAgent(): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
      return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });
}

/** The provider's answer to a command on a paused machine, word for word. */
export const NOT_RUNNING = "Sandbox is not running";

/** The guest side of the exec stream: the launch lands, one poll hands over the log with the exit code; with no exit
 * the command reads as still running. A paused machine refuses every command as the provider does. */
export function execGuest(backend: StubBackend, output: string, exit: number | undefined) {
  const base = backend.execImpl;
  backend.execImpl = (m, cmd): Promise<ExecResult> | ExecResult => {
    if (m.paused) throw new Error(NOT_RUNNING);
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

/** A folder of one file landing on the machine, the way the app's import hands it to the runtime. */
export const projectBundler = (): ProjectBundler => ({
  plan: async () => ({ source: "/Users/dev/proj", repo: true, files: 1, bytes: 20, secrets: [], excluded: [], skipped: [], agents: [] }),
  pack: async () => ({ tar: tarOf([{ path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]), files: 1, bytes: 20, cut: [], rewritten: [] }),
  packState: async () => {
    throw new Error("no agent state here");
  },
});

export const EXPORT_SOURCE = "/root/work/proj";
/** The one Claude Code session on the machine for the folder, as the export brings it down. */
export const EXPORT_SESSION = (cwd: string): string => `{"type":"user","cwd":"${cwd}","sessionId":"S1"}\n`;

/** The guest side of an export: the folder is there, its archive and the Claude Code state root come down for the
 * paths the machine packs them at, and only that root exists among the agents' homes. */
export function exportGuest(backend: StubBackend): { sources: string[] } {
  const base = backend.execImpl;
  const tars = new Map<string, Buffer>();
  const sources: string[] = [];
  backend.downloads = path => tars.get(path) ?? tarOf([]);
  backend.execImpl = (m, cmd): Promise<ExecResult> | ExecResult => {
    const probed = /^test -d '([^']+)'/.exec(cmd)?.[1];
    if (probed !== undefined) {
      sources.push(probed);
      return { exitCode: 0, stdout: "yes\n", stderr: "" };
    }
    if (cmd.startsWith("for p in ")) return { exitCode: 0, stdout: cmd.includes("'/root/.claude-cfg/projects'") ? "/root/.claude-cfg/projects\n" : "", stderr: "" };
    const out = /tar czf '([^']+)'/.exec(cmd)?.[1];
    if (out !== undefined && cmd.includes("find .")) {
      tars.set(out, tarOf([{ path: "./src/index.ts", mode: 0o644, content: "export const a = 1;\n" }, { path: "./.env", mode: 0o600, content: "TOKEN=x\n" }]));
      return { exitCode: 0, stdout: "node_modules\n", stderr: "" };
    }
    if (out !== undefined) {
      tars.set(out, tarOf([{ path: "root/.claude-cfg/projects/-root-work-proj/S1.jsonl", mode: 0o644, content: EXPORT_SESSION(EXPORT_SOURCE) }]));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const sized = /^wc -c < '([^']+)'/.exec(cmd)?.[1];
    if (sized !== undefined) return { exitCode: 0, stdout: `${tars.get(sized)?.length ?? 0}\n`, stderr: "" };
    return base(m, cmd);
  };
  return { sources };
}

/** The script the launch carried to the machine, decoded. */
export function launchedScript(backend: StubBackend): string {
  const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
  return Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8");
}
