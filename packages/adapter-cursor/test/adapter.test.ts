// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures: no-login.jsonl is what cursor-agent 2026.09.26-dd393fe printed on
// this Mac under an empty home with no credential, exit 1. turn.jsonl and every
// inline line below are hand-written: no real model turn ran. Their shapes are
// cursor.com/docs/cli/reference/output-format (read 2026-09-27), whose example
// sequence turn.jsonl follows, with the three assistant kinds that doc lists for
// --stream-partial-output; the rejected shell result is the case that build's
// headless writer names (src/headless.ts in the bundle).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createCursorAdapter } from "../src/adapter.js";

const CHAT = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
const RUN_HANDLE = "/tmp/wsp-run/cu01";
const SIGN_IN_ROAD = "sign in from a terminal on this Mac, then send again";

const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0);

interface ScriptedExec {
  factory: ExecStreamFactory;
  calls: { command: string; env: Record<string, string>; input: readonly string[] | undefined }[];
  order: string[];
}

function scriptedExec(lines: string[], opts: { exitCode?: number; hang?: boolean } = {}): ScriptedExec {
  const calls: ScriptedExec["calls"] = [];
  const order: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const stream: ExecStream = {
      run: RUN_HANDLE,
      lines: (async function* () {
        yield* lines;
        if (opts.hang) await exited;
        else resolveExit(opts.exitCode ?? 0);
      })(),
      teardown: () => {
        order.push("teardown");
        resolveExit(143);
      },
      kill: () => {
        order.push("kill");
        resolveExit(null);
      },
      write: async () => "written" as const,
      closeInput: () => order.push("closeInput"),
      exited,
    };
    return stream;
  };
  return { factory, calls, order };
}

function collect(): { events: AdapterEvent[]; onEvent: (e: AdapterEvent) => void } {
  const events: AdapterEvent[] = [];
  return { events, onEvent: e => events.push(e) };
}

const adapterOver = (exec: ScriptedExec, extra: { resultExitMs?: number; interruptGraceMs?: number; apiKey?: string; keyEnv?: string } = {}) =>
  createCursorAdapter({ exec: exec.factory, baseEnv: { PATH: "/root/.local/bin:/usr/bin" }, signInRefusal: SIGN_IN_ROAD, ...extra });

describe("CursorAdapter over an agent -p stream-json turn", () => {
  it("launches the print line with the key in the environment and none on the line, and no stdin channel", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const adapter = adapterOver(exec, { apiKey: "key_x", keyEnv: "CURSOR_API_KEY" });
    const session = adapter.start({ prompt: "summarize the readme", cwd: "/root/app", model: "sonnet-4.5", permissionMode: "force", onEvent: () => {} });
    await session.finished;
    const call = exec.calls[0]!;
    expect(call.command.startsWith("cd '/root/app' && cursor-agent -p --output-format stream-json --stream-partial-output --trust --workspace '/root/app' --model 'sonnet-4.5' --force <<'WSP_PROMPT_END'")).toBe(true);
    expect(call.command).not.toContain("key_x");
    expect(call.env).toEqual({ PATH: "/root/.local/bin:/usr/bin", CURSOR_API_KEY: "key_x" });
    expect(call.input).toBeUndefined();
    expect(session.command).toBe(call.command);
    expect(adapter.steers).toBe(false);
    expect("attachments" in adapter).toBe(false);
    expect("mcpServers" in adapter).toBe(false);
  });

  it("normalizes a turn: session.start off init, only the streamed text and never its two buffered repeats, tool deltas and turn.done at the result", async () => {
    const { events, onEvent } = collect();
    const session = adapterOver(scriptedExec(fixture("turn.jsonl"))).start({ prompt: "go", cwd: "/root/app", model: "sonnet-4.5", onEvent });
    const result = await session.finished;
    expect(session.sessionId).toBe(CHAT);
    expect(events.map(e => (e.type === "turn.delta" ? `delta:${e.kind}` : e.type))).toEqual(["session.start", "delta:text", "delta:text", "delta:tool_use", "delta:tool_result", "delta:text", "turn.done", "session.end"]);
    expect(events[0]).toEqual({ type: "session.start", sessionId: CHAT, model: "sonnet-4.5", cwd: "/root/app" });
    expect(events.filter(e => e.type === "turn.delta" && e.kind === "text").map(e => (e as { text: string }).text).join("")).toBe("I will read the README.It is a sample project.");
    expect(events[3]).toEqual({ type: "turn.delta", sessionId: CHAT, kind: "tool_use", text: JSON.stringify({ path: "README.md" }), toolName: "read", toolUseId: "toolu_vrtx_01Nn" });
    expect(events[4]).toEqual({ type: "turn.delta", sessionId: CHAT, kind: "tool_result", text: "# Project\n\nThis is a sample project.", toolUseId: "toolu_vrtx_01Nn", isError: false });
    // The reply is the text after the last tool call; the result's own field runs every segment together unspaced.
    expect(result).toEqual({ status: "completed", durationMs: 5234, text: "It is a sample project.", usage: { inputTokens: 1200, outputTokens: 40 } });
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: CHAT, exitCode: 0, sawResult: true });
  });

  it("a tool the CLI refused is an error result in its own words, and a function call keeps its own name", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: CHAT }),
      JSON.stringify({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "rm -rf build" } } }, session_id: CHAT }),
      JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { args: { command: "rm -rf build" }, result: { rejected: { reason: "not allowed without --force" } } } }, session_id: CHAT }),
      JSON.stringify({ type: "tool_call", subtype: "started", call_id: "c2", tool_call: { function: { name: "web_search", arguments: '{"q":"x"}' } }, session_id: CHAT }),
    ];
    const { events, onEvent } = collect();
    await adapterOver(scriptedExec(lines)).start({ prompt: "go", onEvent }).finished;
    expect(events).toContainEqual({ type: "turn.delta", sessionId: CHAT, kind: "tool_use", text: JSON.stringify({ command: "rm -rf build" }), toolName: "shell", toolUseId: "c1" });
    expect(events).toContainEqual({ type: "turn.delta", sessionId: CHAT, kind: "tool_result", text: "rejected: not allowed without --force", toolUseId: "c1", isError: true });
    expect(events).toContainEqual({ type: "turn.delta", sessionId: CHAT, kind: "tool_use", text: '{"q":"x"}', toolName: "web_search", toolUseId: "c2" });
  });

  it("no credential is a sign-in refusal, the CLI's sentence first and wsp's road beside it", async () => {
    const { events, onEvent } = collect();
    const result = await adapterOver(scriptedExec(fixture("no-login.jsonl"), { exitCode: 1 })).start({ prompt: "say hi", onEvent }).finished;
    expect(result).toEqual({ status: "failed", error: `Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.; ${SIGN_IN_ROAD}`, refusal: "sign-in" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: 1, sawResult: false });
  });

  it("a process that dies before its result fails the turn with what it printed last", async () => {
    const result = await adapterOver(scriptedExec([JSON.stringify({ type: "system", subtype: "init", session_id: CHAT }), "Error: Cannot use this model: nope. Available models: gpt-5, sonnet-4.5"], { exitCode: 1 })).start({ prompt: "go", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: "cursor-agent exited with code 1 before its turn ended: Error: Cannot use this model: nope. Available models: gpt-5, sonnet-4.5" });
  });

  it("a result marked as an error fails the turn with its own text", async () => {
    const lines = [JSON.stringify({ type: "result", subtype: "error", is_error: true, duration_ms: 9, result: "the model refused", session_id: CHAT })];
    expect(await adapterOver(scriptedExec(lines)).start({ prompt: "go", onEvent: () => {} }).finished).toEqual({ status: "failed", durationMs: 9, error: "the model refused" });
  });

  it("a process that lingers past its result is ended", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"), { hang: true });
    const result = await adapterOver(exec, { resultExitMs: 5, interruptGraceMs: 5 }).start({ prompt: "go", onEvent: () => {} }).finished;
    expect(result.status).toBe("completed");
    expect(exec.order).toContain("teardown");
  });

  it("interrupt ends the process and the turn reads interrupted", async () => {
    const exec = scriptedExec([JSON.stringify({ type: "system", subtype: "init", session_id: CHAT })], { hang: true });
    const session = adapterOver(exec, { interruptGraceMs: 5 }).start({ prompt: "go", onEvent: () => {} });
    await new Promise(resolve => setTimeout(resolve, 5));
    await session.interrupt();
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(exec.order[0]).toBe("teardown");
  });

  it("an attach re-opens the run with no channel", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const attached: { run: string; input: boolean }[] = [];
    exec.factory.attach = async (run, options) => {
      attached.push({ run, input: options.input });
      return exec.factory("", { env: {} });
    };
    const { events, onEvent } = collect();
    const session = await adapterOver(exec).attach!({ run: RUN_HANDLE, sessionId: CHAT, startedAt: 1, model: "sonnet-4.5", cwd: "/root/app", onEvent });
    if (session === "gone") throw new Error("the run was there");
    expect((await session.finished).status).toBe("completed");
    expect(attached).toEqual([{ run: RUN_HANDLE, input: false }]);
    expect(events[0]).toMatchObject({ type: "session.start", sessionId: CHAT, model: "sonnet-4.5", cwd: "/root/app" });
  });
});
