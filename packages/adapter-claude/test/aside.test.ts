// SPDX-License-Identifier: AGPL-3.0-only
// The side question on Claude Code: the tail of the thread's session file read
// to find where a copy must end, the copy written beside it and resumed on the
// thread's own launch with every tool refused by a hook, the answer read off
// its result, and the copy's file removed by a last run once the CLI's has
// ended, whichever way it ended.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ASIDE_TOOL_LINE, asideWallLine } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { ASIDE_HOOKS_ID, asideCommand, asideCut, asideHooksLine, asidePrompt, asideTailCommand, forkCleanupCommand, noConversationLine } from "../src/aside.js";
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

/** A finished thread's session file as the tail read prints it: its line count, then the lines. */
const FINISHED = ["2", JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello" }] } })];

interface Call {
  command: string;
  env: Record<string, string>;
  input: readonly string[] | undefined;
}

/** The tail read prints `tail` and ends with `tailCode`; the CLI's run prints `lines`, then ends with `exitCode`, or in
 * hang mode only once it is torn down; any later run (the copy's removal) prints nothing and ends at once. `order`
 * notes each launch and each end. */
function scripted(lines: string[], opts: { exitCode?: number; hang?: boolean; tail?: string[]; tailCode?: number } = {}) {
  const calls: Call[] = [];
  const order: string[] = [];
  const writes: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
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
        if (n !== 2) return end(0);
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
  it("copies the thread's session up to the cut and launches the copy as the thread's turns launch, with its hooks off", () => {
    const servers = { wsp: { command: "wsp", args: ["mcp", "--scoped"] } };
    const memoryDir = `${CONFIG}/projects/-root-spoo/memory`;
    const picks = { cwd: "/root/spoo", model: "claude-opus-5", effort: "high", contextWindow: "1m", mcpServers: servers, memoryDir };
    const turn = buildCommand({ resume: SESSION, ...picks });
    const line = asideCommand({ session: SESSION, fork: FORK, keep: 12, configDir: CONFIG, ...picks });
    expect(line).toContain(`head -n 12 "$src" > "\${src%/*}/${FORK}.jsonl" && cd '/root/spoo' && claude -p `);
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
    for (const absent of ["--tools", "--disallowedTools", "--allowed-tools", "--dangerously-skip-permissions", "--fork-session", "--session-id", "--strict-mcp-config", "--safe-mode", "--bare", "--no-session-persistence"]) expect(line, absent).not.toContain(absent);
  });

  it("keeps the copy's hooks off where the person's launch words name a settings file, which would replace its flag", () => {
    const launch = { args: ["--debug", "--settings", "/root/my-settings.json"] };
    const line = asideCommand({ session: SESSION, fork: FORK, keep: 3, configDir: CONFIG, launch });
    expect(line).toContain(`--settings '{"disableAllHooks":true}'`);
    expect(line).not.toContain("my-settings.json");
    expect(line).toContain("claude -p '--debug' --input-format");
    // A turn keeps the person's file, as the CLI reads it.
    expect(buildCommand({ resume: SESSION, launch })).toContain("'--settings' '/root/my-settings.json'");
    expect(asideCommand({ session: SESSION, fork: FORK, keep: 3, configDir: CONFIG, launch: { args: ["--settings=/root/my-settings.json"] } })).not.toContain("my-settings.json");
  });

  it("hands the copy the servers the thread's turns are handed, on the flag a turn takes them on", () => {
    const servers = { wsp: { command: "wsp", args: ["mcp", "--scoped"] } };
    const line = asideCommand({ session: SESSION, fork: FORK, keep: 0, configDir: CONFIG, mcpServers: servers });
    const turn = buildCommand({ resume: SESSION, mcpServers: servers });
    const flag = /--mcp-config '[^']*'/.exec(turn)?.[0];
    expect(flag).toBeDefined();
    expect(line).toContain(flag!);
  });

  it("the cleanup refuses a copy id that is not the CLI's shape, so a glob never reaches rm", () => {
    expect(() => forkCleanupCommand({ fork: "*", configDir: CONFIG })).toThrow(/UUID/);
    expect(forkCleanupCommand({ fork: FORK, configDir: CONFIG })).toBe(`rm -rf '/root/.claude-cfg/projects'/*/${FORK}.jsonl '/root/.claude-cfg/projects'/*/${FORK}`);
  });

  it("leaves the model out when the row names none and refuses an id or a count that is not the shape it must be", () => {
    expect(asideCommand({ session: SESSION, fork: FORK, keep: 0, configDir: CONFIG })).not.toContain("--model");
    expect(asideCommand({ session: SESSION, fork: FORK, keep: 0, configDir: CONFIG })).toContain(" && cd ~ && ");
    expect(() => asideCommand({ session: "../x", fork: FORK, keep: 0, configDir: CONFIG })).toThrow(/UUID/);
    expect(() => asideCommand({ session: SESSION, fork: "*", keep: 0, configDir: CONFIG })).toThrow(/UUID/);
    expect(() => asideCommand({ session: SESSION, fork: FORK, keep: -1, configDir: CONFIG })).toThrow(/whole number/);
    expect(() => asideTailCommand({ session: "*", configDir: CONFIG })).toThrow(/UUID/);
  });
});

describe("asideCut", () => {
  it("ends the copy before the message whose call has no result, and names that call", () => {
    const cut = asideCut(MID_TURN.length, MID_TURN);
    // The last message's three lines (its thinking, its words, its Bash call) go; the result before them stays last.
    expect(cut.keep).toBe(MID_TURN.length - 3);
    expect((JSON.parse(MID_TURN[cut.keep - 1]!) as { message: { content: { type: string }[] } }).message.content[0]!.type).toBe("tool_result");
    expect(cut.running).toHaveLength(1);
    expect(cut.running[0]).toMatch(/^Bash \{"command":"\.\/check\.sh"/);
    // Read as a tail of a longer file, the count is the file's.
    expect(asideCut(100 + MID_TURN.length, MID_TURN).keep).toBe(100 + MID_TURN.length - 3);
  });

  it("keeps the whole file where every call has its result, or where the tail holds no assistant line", () => {
    expect(asideCut(MID_TURN.length - 3, MID_TURN.slice(0, -3))).toEqual({ keep: MID_TURN.length - 3, running: [] });
    expect(asideCut(2, FINISHED.slice(1))).toEqual({ keep: 2, running: [] });
    expect(asideCut(7, ["not json", JSON.stringify({ type: "user" })])).toEqual({ keep: 7, running: [] });
  });
});

describe("run by a shell against a stand-in CLI", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies the recorded mid-turn session byte for byte up to the cut, leaving no call without its result, and removes only the copy", () => {
    root = mkdtempSync(join(tmpdir(), "wsp-aside-"));
    const config = join(root, "it's config");
    const project = join(config, "projects", "-root-spoo");
    mkdirSync(project, { recursive: true });
    const thread = `${MID_TURN.join("\n")}\n`;
    writeFileSync(join(project, `${SESSION}.jsonl`), thread);
    const bin = join(root, "bin");
    mkdirSync(bin);
    // The stand-in prints its result and exits with a code of its own.
    writeStub(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' '{"type":"result"}'\nexit 3\n`);
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    const read = execFileSync("/bin/bash", ["-c", asideTailCommand({ session: SESSION, configDir: config })], { env, encoding: "utf8" }).trim().split("\n");
    expect(read[0]).toBe(String(MID_TURN.length));
    expect(read.slice(1)).toHaveLength(MID_TURN.length);
    const { keep } = asideCut(Number(read[0]), read.slice(1));
    expect(asideCut(Number(read[0]), read.slice(1))).toEqual(asideCut(MID_TURN.length, MID_TURN));
    const line = asideCommand({ session: SESSION, fork: FORK, keep, configDir: config, cwd: root });
    let code = 0;
    let out = "";
    try {
      out = execFileSync("/bin/bash", ["-c", line], { env, encoding: "utf8" });
    } catch (e) {
      code = (e as { status: number }).status;
      out = String((e as { stdout: string }).stdout);
    }
    expect(out.trim()).toBe('{"type":"result"}');
    expect(code).toBe(3);
    const copy = readFileSync(join(project, `${FORK}.jsonl`), "utf8");
    expect(thread.startsWith(copy)).toBe(true);
    // Resumed with a call that has no result, 2.1.280 wrote "[Request interrupted by user for tool use]" as its result,
    // and every answer said the call was interrupted; the copy holds no such call for the CLI to answer.
    const events = copy.trim().split("\n").map(l => JSON.parse(l) as { type: string; message: { content: { type: string; id?: string; tool_use_id?: string }[] } });
    const blocks = events.flatMap(e => (Array.isArray(e.message.content) ? e.message.content : []));
    const calls = blocks.filter(b => b.type === "tool_use").map(b => b.id);
    const results = new Set(blocks.filter(b => b.type === "tool_result").map(b => b.tool_use_id));
    expect(calls.filter(id => !results.has(id))).toEqual([]);
    execFileSync("/bin/bash", ["-c", forkCleanupCommand({ fork: FORK, configDir: config })], { env });
    expect(existsSync(join(project, `${FORK}.jsonl`))).toBe(false);
    expect(readFileSync(join(project, `${SESSION}.jsonl`), "utf8")).toBe(thread);
  });

  it("the tail read of a long thread carries kilobytes, its long strings printed empty, and cuts where the whole file would", () => {
    root = mkdtempSync(join(tmpdir(), "wsp-aside-"));
    const project = join(root, "projects", "-root-spoo");
    mkdirSync(project, { recursive: true });
    const body = `say \\"hi\\" ${"x".repeat(1 << 20)}`;
    const bigResult = (n: number) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_r${n}`, content: body }] } });
    const lines = [...Array.from({ length: 200 }, (_, n) => MID_TURN[n % 4]!), bigResult(1), bigResult(2), ...MID_TURN];
    writeFileSync(join(project, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
    expect(lines.join("\n").length).toBeGreaterThan(2 << 20);
    const out = execFileSync("/bin/bash", ["-c", asideTailCommand({ session: SESSION, configDir: root })], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", maxBuffer: 64 << 20 });
    expect(out.length).toBeLessThan(64 << 10);
    const read = out.trim().split("\n");
    expect(read[0]).toBe(String(lines.length));
    for (const line of read.slice(1)) JSON.parse(line);
    expect(asideCut(Number(read[0]), read.slice(1))).toEqual(asideCut(lines.length, lines));
    expect(asideCut(Number(read[0]), read.slice(1)).keep).toBe(lines.length - 3);
  });

  it("the tail read says the CLI's own words for a session its store does not hold", () => {
    root = mkdtempSync(join(tmpdir(), "wsp-aside-"));
    let said = "";
    try {
      execFileSync("/bin/bash", ["-c", asideTailCommand({ session: SESSION, configDir: root })], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      said = String((e as { stderr: string }).stderr).trim();
    }
    expect(said).toBe(noConversationLine(SESSION));
  });
});

describe("the adapter's aside", () => {
  const adapter = (factory: ExecStreamFactory, extra: { asideWallMs?: number } = {}) =>
    createClaudeAdapter({ exec: factory, configDir: CONFIG, baseEnv: { PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "cli" }, oauthToken: "sk-ant-oat-x", projectDirName: "-root-spoo", resultExitMs: 5, interruptGraceMs: 5, ...extra });

  it("reads the session's tail and runs the copy on the turn's road with the turn's environment, the question its one user line", async () => {
    const exec = scripted([
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK, cwd: "/root/spoo", tools: [] }),
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "You are in /root/spoo" }] }, session_id: FORK }),
      JSON.stringify(RESULT),
    ]);
    const servers = { wsp: { command: "wsp", args: ["mcp"] } };
    const answer = await adapter(exec.factory).aside!({ session: SESSION, question: "which folder, and what did I last ask?", cwd: "/root/spoo", model: "claude-opus-5", mcpServers: servers });
    expect(answer).toEqual({ text: RESULT.result, usage: RESULT.usage });
    // The tail of the thread's session file, read first on the same road, says where the copy ends.
    expect(exec.calls[0]).toMatchObject({ command: asideTailCommand({ session: SESSION, configDir: CONFIG }), input: undefined });
    const call = exec.calls[1]!;
    const fork = forkOf(call.command);
    expect(fork).toMatch(/^[0-9a-f-]{36}$/);
    expect(fork).not.toBe(SESSION);
    expect(call.command).toBe(asideCommand({ session: SESSION, fork, keep: 2, configDir: CONFIG, cwd: "/root/spoo", model: "claude-opus-5", mcpServers: servers, memoryDir: `${CONFIG}/projects/-root-spoo/memory` }));
    // The copy reads the memory the thread's turns read, in the one settings flag that turns its hooks off.
    expect(call.command).toContain(`--settings '{"autoMemoryDirectory":"${CONFIG}/projects/-root-spoo/memory","disableAllHooks":true}'`);
    // The turn's own environment: the login it signs in with and the folder key the thread's session is stored under.
    expect(call.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x", CLAUDE_CODE_PROJECT_DIR_NAME: "-root-spoo", PATH: "/bin" });
    expect(call.env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    // The hook that refuses every tool goes first, so it stands before the question is read.
    expect(call.input).toEqual([asideHooksLine(), userMessageLine(asidePrompt("which folder, and what did I last ask?"), fork)]);
    expect(exec.order).toContain("closeInput");
    // The copy's file goes by a last run on the same road and environment, once the CLI's own run has ended.
    expect(exec.calls[2]).toMatchObject({ command: forkCleanupCommand({ fork, configDir: CONFIG }), input: undefined });
    expect(exec.calls[2]!.env).toMatchObject({ PATH: "/bin" });
    expect(exec.order.indexOf("exited 1")).toBeLessThan(exec.order.indexOf("launch 2"));
    expect(exec.order.indexOf("exited 2")).toBeLessThan(exec.order.indexOf("launch 3"));
    expect(exec.calls).toHaveLength(3);
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
    expect(exec.calls[2]!.command).toBe(forkCleanupCommand({ fork: forkOf(exec.calls[1]!.command), configDir: CONFIG }));
  });

  it("rejects with the tail read's own line where the thread's session file is not there, and runs nothing more", async () => {
    const exec = scripted([JSON.stringify(RESULT)], { tail: [noConversationLine(SESSION)], tailCode: 1 });
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "hi" })).rejects.toThrow(noConversationLine(SESSION));
    expect(exec.calls).toHaveLength(1);
  });

  it("ends a CLI that says nothing for the whole wall and says so", async () => {
    const exec = scripted([], { hang: true });
    await expect(adapter(exec.factory, { asideWallMs: 20 }).aside!({ session: SESSION, question: "hi" })).rejects.toThrow(asideWallLine(20));
    expect(exec.order.slice(2, 4)).toEqual(["launch 2", "teardown"]);
    // The kill took the CLI's shell with it, so the copy's file goes by a run of its own once that one has ended.
    const fork = forkOf(exec.calls[1]!.command);
    expect(exec.calls[2]!.command).toBe(forkCleanupCommand({ fork, configDir: CONFIG }));
    expect(exec.order.indexOf("exited 2")).toBeLessThan(exec.order.indexOf("launch 3"));
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
    const exec = scripted([JSON.stringify(RESULT)], { tail: [String(MID_TURN.length), ...MID_TURN] });
    await adapter(exec.factory).aside!({ session: SESSION, question: "btw what's the status?" });
    const { keep, running } = asideCut(MID_TURN.length, MID_TURN);
    expect(exec.calls[1]!.command).toContain(`head -n ${keep} "$src"`);
    const line = JSON.parse(exec.calls[1]!.input![1]!) as { message: { content: { type: string; text: string }[] } };
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
