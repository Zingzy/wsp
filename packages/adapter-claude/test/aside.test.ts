// SPDX-License-Identifier: AGPL-3.0-only
// The side question on Claude Code: a copy of the thread's session through its
// live end, written beside it and resumed on the thread's own launch with every
// tool refused by a hook, the answer read off its result, and the copy's file
// removed by a last run once the CLI's has ended, whichever way it ended.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ASIDE_TOOL_LINE, asideWallLine, shellQuote } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { ASIDE_HOOKS_ID, asideCommand, asideHooksLine, asidePrompt } from "../src/aside.js";
import { chainReadCommand, chainThrough, chainWriteCommand, copyCleanupCommand, lineRanges, liveEnd, noConversationLine, readChain } from "../src/chain.js";
import { buildCommand, userMessageLine } from "../src/landmines.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const SESSION = "e16ed170-8257-4668-879e-fe836341633c";
const FORK = "0b7f3a52-6c1d-4e8a-9f2b-3d4c5e6f7a8b";
const CONFIG = "/root/.claude-cfg";

/** A thread's session file recorded on 2.1.280 while its turn ran ./check.sh in the foreground: its last line is that
 * Bash call, with no result yet. Only its user and assistant lines are kept, each linked to the one before it, and
 * its ids are made up. */
const MID_TURN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "aside-mid-turn.jsonl"), "utf8").trim().split("\n");

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 2310,
  result: "You are in /root/spoo and last asked why the short links 302 twice.",
  session_id: FORK,
  total_cost_usd: 0.004,
  usage: { input_tokens: 12, cache_read_input_tokens: 18435, output_tokens: 31 },
};

const U1 = "1a2b3c4d-0000-4aaa-8bbb-000000000001";
const U2 = "1a2b3c4d-0000-4aaa-8bbb-000000000002";
/** A finished thread's session file as the copy's read prints it: its line count, then each message line by number. */
const FINISHED = ["2", `1:${JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "hi" }, uuid: U1 })}`, `2:${JSON.stringify({ parentUuid: U1, type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello" }] }, uuid: U2 })}`];

/** A session file as the copy's read prints it. */
const readOf = (file: readonly string[]): string[] => [String(file.length), ...file.map((l, i) => `${i + 1}:${l}`)];

interface Call {
  command: string;
  env: Record<string, string>;
  input: readonly string[] | undefined;
  secret?: { files?: Readonly<Record<string, string>> };
}

/** The copy's read prints `tail` and ends with `tailCode`, and its write ends at once; the CLI's run prints `lines`,
 * then ends with `exitCode`, or in hang mode only once it is torn down; any later run (the copy's removal) prints
 * nothing and ends at once. `order` notes each launch and each end. */
function scripted(lines: string[], opts: { exitCode?: number; hang?: boolean; tail?: string[]; tailCode?: number } = {}) {
  const calls: Call[] = [];
  const order: string[] = [];
  const writes: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input, secret }) => {
    calls.push({ command, env, input, ...(secret !== undefined ? { secret } : {}) });
    const n = calls.length;
    order.push(`launch ${n}`);
    let end: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => (end = resolve));
    void exited.then(() => order.push(`exited ${n}`));
    const stream: ExecStream = {
      lines: (async function* () {
        if (n === 1) {
          yield* opts.tail ?? FINISHED;
          return end(opts.tailCode ?? 0);
        }
        if (n !== 3) return end(0);
        yield* lines;
        if (opts.hang === true) await exited;
        else end(opts.exitCode ?? 0);
      })(),
      teardown: () => {
        order.push("teardown");
        end(143);
      },
      kill: () => {
        order.push("kill");
        end(null);
      },
      write: async line => {
        writes.push(line);
        return "written" as const;
      },
      closeInput: () => void order.push("closeInput"),
      exited,
    };
    return stream;
  };
  return { factory, calls, order, writes };
}

const forkOf = (command: string): string => /--resume ([0-9a-f-]+)$/.exec(command)?.[1] ?? "";

describe("asideCommand", () => {
  it("launches the copy as the thread's turns launch, with its hooks off", () => {
    const servers = { wsp: { command: "wsp", args: ["mcp", "--scoped"] } };
    const memoryDir = `${CONFIG}/projects/-root-spoo/memory`;
    const picks = { cwd: "/root/spoo", model: "claude-opus-5", effort: "high", contextWindow: "1m", mcpServers: servers, memoryDir };
    const turn = buildCommand({ resume: SESSION, ...picks });
    const line = asideCommand({ fork: FORK, ...picks });
    expect(line.startsWith("cd '/root/spoo' && claude -p ")).toBe(true);
    // Every flag that shapes the request the model is sent: the model and its window, the effort, the servers whose
    // tools head the prompt, and the slate's brief at the end of the system prompt.
    for (const flag of [/--model '[^']*'/, /--effort '[^']*'/, /--mcp-config '[^']*'/, /--append-system-prompt '[^']*'/]) {
      const part = flag.exec(turn)?.[0];
      expect(part, String(flag)).toBeDefined();
      expect(line, String(flag)).toContain(part!);
    }
    for (const part of [
      "--input-format stream-json",
      "--output-format stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode 'default' --permission-prompt-tool stdio",
      `--settings '{"autoMemoryDirectory":"${memoryDir}","disableAllHooks":true}'`,
    ]) expect(line, part).toContain(part);
    expect(line.endsWith(`--max-turns 2 --resume ${FORK}`)).toBe(true);
    // A tool list the turn did not have is a prompt the cache has never seen, and the copy pays the whole thread again.
    for (const absent of ["--tools", "--disallowedTools", "--allowed-tools", "--dangerously-skip-permissions", "--fork-session", "--session-id", "--strict-mcp-config", "--safe-mode", "--bare", "--no-session-persistence", "--resume-session-at"]) expect(line, absent).not.toContain(absent);
  });

  it("keeps the copy's hooks off where the person's launch words name a settings file, which would replace its flag", () => {
    const launch = { args: ["--debug", "--settings", "/root/my-settings.json"] };
    const line = asideCommand({ fork: FORK, launch });
    expect(line).toContain(`--settings '{"disableAllHooks":true}'`);
    expect(line).not.toContain("my-settings.json");
    expect(line).toContain("claude -p '--debug' --input-format");
    // A turn keeps the person's file, as the CLI reads it.
    expect(buildCommand({ resume: SESSION, launch })).toContain("'--settings' '/root/my-settings.json'");
    expect(asideCommand({ fork: FORK, launch: { args: ["--settings=/root/my-settings.json"] } })).not.toContain("my-settings.json");
  });

  it("hands the copy the servers the thread's turns are handed, on the flag a turn takes them on", () => {
    const servers = { wsp: { command: "wsp", args: ["mcp", "--scoped"] } };
    const line = asideCommand({ fork: FORK, mcpServers: servers });
    const turn = buildCommand({ resume: SESSION, mcpServers: servers });
    const flag = /--mcp-config '[^']*'/.exec(turn)?.[0];
    expect(flag).toBeDefined();
    expect(line).toContain(flag!);
  });

  it("leaves the model out when the row names none and refuses a copy id that is not the CLI's shape", () => {
    expect(asideCommand({ fork: FORK })).not.toContain("--model");
    expect(asideCommand({ fork: FORK }).startsWith("cd ~ && ")).toBe(true);
    expect(() => asideCommand({ fork: "*" })).toThrow(/UUID/);
  });
});

/** Runs each command in /bin/sh with its input lines on stdin, stdout and stderr read as one stream of lines. */
function shellExec(env: Record<string, string>): ExecStreamFactory {
  return (command, options) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { ...env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    // A command that never reads its stdin closes it under the lines still being written.
    child.stdin.on("error", () => {});
    for (const line of options.input ?? []) child.stdin.write(`${line}\n`);
    const chunks: string[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
    const exited = new Promise<number | null>(resolve => child.on("close", code => resolve(code)));
    if (options.input === undefined) child.stdin.end();
    return {
      lines: (async function* () {
        await exited;
        yield* chunks.join("").split("\n").filter(l => l !== "");
      })(),
      teardown: () => child.kill("SIGTERM"),
      kill: () => child.kill("SIGKILL"),
      write: async () => "gone",
      closeInput: () => child.stdin.end(),
      exited,
    };
  };
}

describe("run by a shell against a stand-in CLI", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A config dir holding the thread's session file, and a stand-in claude that answers with the words "Remember"
   * opens in the copy it was resumed on, which it finds by the id after its last flag. */
  const setUp = (file: readonly string[]) => {
    root = mkdtempSync(join(tmpdir(), "wsp-aside-"));
    const config = join(root, "it's config");
    const project = join(config, "projects", "-root-spoo");
    mkdirSync(project, { recursive: true });
    const thread = `${file.join("\n")}\n`;
    writeFileSync(join(project, `${SESSION}.jsonl`), thread);
    const bin = join(root, "bin");
    mkdirSync(bin);
    // The stand-in finds the copy it was resumed on by the id after its last flag, and answers with what it holds.
    const copy = `${shellQuote(project)}/"$last".jsonl`;
    writeStub(
      join(bin, "claude"),
      `#!/bin/sh\nfor a; do last="$a"; done\nsaid=$(grep -o 'Remember [A-Z]*' ${copy} | tr '\\n' ' ')\nlines=$(wc -l < ${copy})\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"%s| %s lines"}\\n' "$said" $lines\n`,
    );
    const adapter = createClaudeAdapter({ exec: shellExec({ PATH: `${bin}:/usr/bin:/bin` }), configDir: config, baseEnv: { PATH: `${bin}:/usr/bin:/bin` }, resultExitMs: 5, interruptGraceMs: 5 });
    return { project, thread, adapter, cwd: root };
  };

  it("asks the recorded mid-turn thread on a copy cut before its running call, and removes only the copy", async () => {
    const { project, thread, adapter, cwd } = setUp(MID_TURN);
    const answer = await adapter.aside!({ session: SESSION, question: "btw what's the status?", cwd });
    // The last message's three lines (its thinking, its words, its Bash call) stay out of the copy.
    expect(answer.text.endsWith(`| ${MID_TURN.length - 3} lines`)).toBe(true);
    expect(readdirSync(project)).toEqual([`${SESSION}.jsonl`]);
    expect(readFileSync(join(project, `${SESSION}.jsonl`), "utf8")).toBe(thread);
  });

  it("answers from the live conversation of a thread whose session file holds a branch a rewind left behind", async () => {
    const id = (n: number): string => `1a2b3c4d-0000-4aaa-8bbb-${String(n).padStart(12, "0")}`;
    const line = (n: number, parent: number | null, type: string, text: string) => JSON.stringify({ parentUuid: parent === null ? null : id(parent), type, message: { role: type, ...(type === "assistant" ? { id: `msg_${n}` } : {}), content: [{ type: "text", text }] }, uuid: id(n) });
    // ALPHA, BETA, then a rewind to ALPHA's reply and OMEGA hung off it: BETA's turn is still in the file, after which
    // the last-prompt line points at the live end as 2.1.296 writes it.
    const rewound = [line(1, null, "user", "Remember ALPHA."), line(2, 1, "assistant", "OK"), line(3, 2, "user", "Remember BETA."), line(4, 3, "assistant", "OK"), line(5, 2, "user", "Remember OMEGA."), line(6, 5, "assistant", "OK"), JSON.stringify({ type: "last-prompt", leafUuid: id(6) })];
    const { adapter, cwd } = setUp(rewound);
    const answer = await adapter.aside!({ session: SESSION, question: "which code words?", cwd });
    expect(answer.text).toBe("Remember ALPHA Remember OMEGA | 4 lines");
  });
});

describe("the adapter's aside", () => {
  const adapter = (factory: ExecStreamFactory, extra: { asideWallMs?: number } = {}) =>
    createClaudeAdapter({ exec: factory, configDir: CONFIG, baseEnv: { PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "cli" }, oauthToken: "sk-ant-oat-x", projectDirName: "-root-spoo", resultExitMs: 5, interruptGraceMs: 5, ...extra });

  it("copies the session through its live end and runs the copy on the turn's road with the turn's environment, the question its one user line", async () => {
    const exec = scripted([
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK, cwd: "/root/spoo", tools: [] }),
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "You are in /root/spoo" }] }, session_id: FORK }),
      JSON.stringify(RESULT),
    ]);
    const servers = { wsp: { command: "wsp", args: ["mcp"] } };
    const answer = await adapter(exec.factory).aside!({ session: SESSION, question: "which folder, and what did I last ask?", cwd: "/root/spoo", model: "claude-opus-5", mcpServers: servers });
    expect(answer).toEqual({ text: RESULT.result, usage: RESULT.usage });
    // The thread's session file, read first on the same road, says where the copy ends, and the write takes its lines.
    expect(exec.calls[0]).toMatchObject({ command: chainReadCommand({ session: SESSION, configDir: CONFIG }), input: undefined });
    const call = exec.calls[2]!;
    const fork = forkOf(call.command);
    expect(fork).toMatch(/^[0-9a-f-]{36}$/);
    expect(fork).not.toBe(SESSION);
    expect(exec.calls[1]).toMatchObject({ command: chainWriteCommand({ session: SESSION, fork, configDir: CONFIG, count: 2 }), input: ["1-2"] });
    expect(call.command).toBe(asideCommand({ fork, cwd: "/root/spoo", model: "claude-opus-5", mcpServers: servers, memoryDir: `${CONFIG}/projects/-root-spoo/memory` }));
    // The copy reads the memory the thread's turns read, in the one settings flag that turns its hooks off.
    expect(call.command).toContain(`--settings '{"autoMemoryDirectory":"${CONFIG}/projects/-root-spoo/memory","disableAllHooks":true}'`);
    // The turn's own environment: the login it signs in with and the folder key the thread's session is stored under.
    expect(call.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x", CLAUDE_CODE_PROJECT_DIR_NAME: "-root-spoo", PATH: "/bin" });
    expect(call.env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    // The hook that refuses every tool goes first, so it stands before the question is read.
    expect(call.input).toEqual([asideHooksLine(), userMessageLine(asidePrompt("which folder, and what did I last ask?"), fork)]);
    // No line carries the uuid a steer goes out under: the copy holds no reply for the CLI's word on a message.
    for (const line of call.input!) expect(JSON.parse(line)).not.toHaveProperty("uuid");
    expect(exec.order).toContain("closeInput");
    // The copy's file goes by a last run on the same road and environment, once the CLI's own run has ended.
    expect(exec.calls[3]).toMatchObject({ command: copyCleanupCommand({ fork, configDir: CONFIG }), input: undefined });
    expect(exec.calls[3]!.env).toMatchObject({ PATH: "/bin" });
    expect(exec.order.indexOf("exited 1")).toBeLessThan(exec.order.indexOf("launch 2"));
    expect(exec.order.indexOf("exited 2")).toBeLessThan(exec.order.indexOf("launch 3"));
    expect(exec.order.indexOf("exited 3")).toBeLessThan(exec.order.indexOf("launch 4"));
    expect(exec.calls).toHaveLength(4);
  });

  it("hands the copy each server's value the thread's turns get, in a file of the run's on the flag a turn takes it on", async () => {
    const exec = scripted([JSON.stringify(RESULT)]);
    const entries = { tracker: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_TESTONLY" } } };
    await adapter(exec.factory).aside!({ session: SESSION, question: "what did I last ask?", cwd: "/root/spoo", serverValues: { entries } });
    const call = exec.calls[2]!;
    expect(call.secret).toEqual({ files: { WSP_MCP_VALUES: JSON.stringify({ mcpServers: entries }) } });
    expect(call.command).toContain('--mcp-config "$WSP_MCP_VALUES"');
    expect(call.command).not.toContain("lin_TESTONLY");
    expect(JSON.stringify(call.env)).not.toContain("lin_TESTONLY");
    // The copy's read, its write and its removal carry none.
    expect([exec.calls[0]!, exec.calls[1]!, exec.calls[3]!].map(c => c.secret)).toEqual([undefined, undefined, undefined]);
  });

  it("hands each piece of the answer on as the CLI writes it, and still answers the whole result", async () => {
    // The partial message lines 2.1.289 prints under --include-partial-messages, a thinking piece among them.
    const delta = (index: number, delta: Record<string, unknown>) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index, delta }, session_id: FORK, parent_tool_use_id: null });
    const exec = scripted([
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK, tools: [] }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } }, session_id: FORK }),
      delta(0, { type: "thinking_delta", thinking: "the folder" }),
      delta(1, { type: "text_delta", text: "You are in " }),
      delta(1, { type: "text_delta", text: "/root/spoo" }),
      JSON.stringify(RESULT),
    ]);
    const pieces: string[] = [];
    const answer = await adapter(exec.factory).aside!({ session: SESSION, question: "which folder?", onText: text => pieces.push(text) });
    expect(pieces).toEqual(["You are in ", "/root/spoo"]);
    expect(answer.text).toBe(RESULT.result);
  });

  it("answers with the question's result, past the empty one a resume gives a background command the thread left running", async () => {
    // As 2.1.289 printed it, forking a thread whose last turn ended with a command still running in the background.
    const exec = scripted([
      JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b1we0t1su", status: "stopped", summary: "Background shell command didn't finish before the previous session ended", session_id: FORK }),
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK, tools: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 174, result: "", origin: { kind: "task-notification" }, session_id: FORK, usage: { input_tokens: 0, output_tokens: 0 } }),
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK, tools: [] }),
      JSON.stringify({ ...RESULT, num_turns: 1 }),
    ]);
    const answer = await adapter(exec.factory).aside!({ session: SESSION, question: "what is going on?" });
    expect(answer.text).toBe(RESULT.result);
    expect(exec.order.indexOf("closeInput")).toBeGreaterThan(-1);
  });

  it("rejects with the CLI's own words when its result is an error", async () => {
    const exec = scripted([JSON.stringify({ ...RESULT, subtype: "success", is_error: true, result: "Not logged in · Please run /login" })]);
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "hi" })).rejects.toThrow("Not logged in · Please run /login");
  });

  it("rejects with what the CLI printed when it exits with no result, and still removes the copy's file", async () => {
    const exec = scripted([noConversationLine(SESSION)], { exitCode: 1 });
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "hi" })).rejects.toThrow("No conversation found with session ID");
    expect(exec.calls[3]!.command).toBe(copyCleanupCommand({ fork: forkOf(exec.calls[2]!.command), configDir: CONFIG }));
  });

  it("rejects with the copy's read's own line where the thread's session file is not there, and runs nothing more", async () => {
    const exec = scripted([JSON.stringify(RESULT)], { tail: [noConversationLine(SESSION)], tailCode: 1 });
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "hi" })).rejects.toThrow(noConversationLine(SESSION));
    expect(exec.calls).toHaveLength(1);
  });

  it("ends a CLI that says nothing for the whole wall and says so", async () => {
    const exec = scripted([], { hang: true });
    await expect(adapter(exec.factory, { asideWallMs: 20 }).aside!({ session: SESSION, question: "hi" })).rejects.toThrow(asideWallLine(20));
    expect(exec.order.indexOf("launch 3")).toBeLessThan(exec.order.indexOf("teardown"));
    // The kill took the CLI's shell with it, so the copy's file goes by a run of its own once that one has ended.
    const fork = forkOf(exec.calls[2]!.command);
    expect(exec.calls[3]!.command).toBe(copyCleanupCommand({ fork, configDir: CONFIG }));
    expect(exec.order.indexOf("exited 3")).toBeLessThan(exec.order.indexOf("launch 4"));
  });

  it("registers a PreToolUse hook on the control channel and refuses every call through it, ahead of any allow rule or mode", async () => {
    const init = JSON.parse(asideHooksLine()) as { type: string; request_id: string; request: { subtype: string; hooks: Record<string, { matcher: unknown; hookCallbackIds: string[] }[]> } };
    expect(init).toMatchObject({ type: "control_request", request_id: ASIDE_HOOKS_ID, request: { subtype: "initialize" } });
    const callbacks = init.request.hooks["PreToolUse"]!;
    expect(callbacks).toEqual([{ matcher: null, hookCallbackIds: [expect.any(String)] }]);
    // As 2.1.280 printed them: the answer to the hook's registration, a call to the hook for a Bash call the model
    // tried, and a prompt for a call that reached the permission check anyway.
    const exec = scripted([
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: ASIDE_HOOKS_ID, response: { commands: [] } } }),
      JSON.stringify({ type: "control_request", request_id: "h1", request: { subtype: "hook_callback", callback_id: callbacks[0]!.hookCallbackIds[0], input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch x" } } } }),
      JSON.stringify({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "a" }, tool_use_id: "toolu_1" } }),
      JSON.stringify(RESULT),
    ]);
    await adapter(exec.factory).aside!({ session: SESSION, question: "touch x for me?" });
    expect(exec.writes.map(line => JSON.parse(line) as unknown)).toEqual([
      { type: "control_response", response: { subtype: "success", request_id: "h1", response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/side question/) } } } },
      { type: "control_response", response: { subtype: "success", request_id: "p1", response: { behavior: "deny", message: expect.stringMatching(/side question/) } } },
    ]);
  });

  it("asks about the recorded mid-turn thread on a copy cut before its running call, and says that call is still running", async () => {
    const exec = scripted([JSON.stringify(RESULT)], { tail: readOf(MID_TURN) });
    await adapter(exec.factory).aside!({ session: SESSION, question: "btw what's the status?" });
    const { lines } = readChain(readOf(MID_TURN));
    const { anchor, running } = liveEnd(lines)!;
    expect(exec.calls[1]!.input).toEqual([lineRanges(chainThrough(lines, anchor))]);
    const line = JSON.parse(exec.calls[2]!.input![1]!) as { message: { content: { type: string; text: string }[] } };
    const asked = line.message.content.map(block => block.text).join("");
    expect(asked).toBe(asidePrompt("btw what's the status?", running));
    expect(asked.endsWith("btw what's the status?")).toBe(true);
    // The words the CLI adds on opening the copy, named so the model reads them as that and not as the person.
    expect(asked).toContain("not interrupted");
    expect(asked).toContain('"Continue from where you left off."');
    expect(asked).toContain('"No response requested."');
    expect(asked).toContain("didn't finish before the previous session ended");
    // A background agent's notice reads status failed, "was running when the previous Claude Code process exited" and
    // its state lost; named so it reads as the copy opening and not the agent failing.
    expect(asked).toContain("a background command or a background agent");
    expect(asked).toContain("(stopped, failed or another)");
    expect(asked).toContain("was running when the previous Claude Code process exited");
    expect(asked).toContain("its state was lost");
    expect(asked).toContain("did not fail, stop or get cut off");
    expect(asked).toContain("do not mention these lines, a notification or this copy unless the person asks about them by name");
    expect(asked).toContain('the thread is running right now, whose result has not come back yet: Bash {"command":"./check.sh"');
  });

  it("says in one line that the answer reached for a tool, where the CLI stopped it at the turn cap", async () => {
    const exec = scripted([JSON.stringify({ ...RESULT, subtype: "error_max_turns", is_error: true, result: undefined, num_turns: 3 })]);
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "run the tests?" })).rejects.toThrow(ASIDE_TOOL_LINE);
  });

  it("rejects with the last line the CLI printed when it exits with no result, one line for the panel", async () => {
    const exec = scripted(["Warning: something about the shell", "Error: Invalid API key · Please run /login"], { exitCode: 1 });
    const failed = await adapter(exec.factory).aside!({ session: SESSION, question: "hi" }).catch((e: unknown) => e as Error);
    expect((failed as Error).message).toBe("Error: Invalid API key · Please run /login");
  });

  it("ends the run and says why where the CLI refuses the hook, since without it a call could run", async () => {
    const exec = scripted(
      [JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: ASIDE_HOOKS_ID, error: "Unsupported control request subtype: initialize" } })],
      { hang: true },
    );
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "hi" })).rejects.toThrow("Unsupported control request subtype: initialize");
    expect(exec.order).toContain("teardown");
  });
});
