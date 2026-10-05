// SPDX-License-Identifier: AGPL-3.0-only
// The side question on Claude Code: one print-mode run that resumes the
// thread's session as a fork with every tool and hook off, the answer read off its
// result, and the fork's own file removed by a second run once the CLI's has
// ended, whichever way it ended.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asideWallLine } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { asideCommand, forkCleanupCommand } from "../src/aside.js";
import { buildCommand, userMessageLine } from "../src/landmines.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const SESSION = "e16ed170-8257-4668-879e-fe836341633c";
const FORK = "0b7f3a52-6c1d-4e8a-9f2b-3d4c5e6f7a8b";
const CONFIG = "/root/.claude-cfg";

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

interface Call {
  command: string;
  env: Record<string, string>;
  input: readonly string[] | undefined;
}

/** The CLI's run prints `lines`, then ends with `exitCode`, or in hang mode only once it is torn down; any later run
 * (the fork's removal) prints nothing and ends at once. `order` notes each launch and each end. */
function scripted(lines: string[], opts: { exitCode?: number; hang?: boolean } = {}) {
  const calls: Call[] = [];
  const order: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    const first = calls.length === 1;
    order.push(`launch ${calls.length}`);
    let end: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => (end = resolve));
    void exited.then(() => order.push(`exited ${first ? 1 : calls.length}`));
    const stream: ExecStream = {
      lines: (async function* () {
        if (!first) return end(0);
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
      write: async () => "written" as const,
      closeInput: () => void order.push("closeInput"),
      exited,
    };
    return stream;
  };
  return { factory, calls, order };
}

const forkOf = (command: string): string => /--session-id ([0-9a-f-]+)/.exec(command)?.[1] ?? "";

describe("asideCommand", () => {
  it("resumes the thread's session as a fork that keeps everything the thread loaded and runs no tool and no hook, in the thread's folder", () => {
    const line = asideCommand({ session: SESSION, fork: FORK, configDir: CONFIG, cwd: "/root/spoo", model: "claude-opus-5" });
    expect(line.startsWith("cd '/root/spoo' && claude -p ")).toBe(true);
    for (const part of [
      "--input-format stream-json",
      "--output-format stream-json",
      "--verbose",
      "--tools ''",
      "--disallowedTools 'mcp__*'",
      `--settings '{"disableAllHooks":true}'`,
      "--model 'claude-opus-5'",
      `--resume ${SESSION}`,
      "--fork-session",
      `--session-id ${FORK}`,
    ]) expect(line, part).toContain(part);
    // A flag that drops a CLAUDE.md or an MCP server the thread loaded makes the CLI tell the model it is gone, and
    // every answer opened on that notice; nothing that lets a tool run either.
    for (const absent of ["--safe-mode", "--strict-mcp-config", "--bare", "--dangerously-skip-permissions", "--permission-prompt-tool", "--allowed-tools", "--mcp-config ", "--no-session-persistence"]) expect(line, absent).not.toContain(absent);
  });

  it("hands the fork the servers the thread's turns are handed, on the flag a turn takes them on", () => {
    const servers = { wsp: { command: "wsp", args: ["mcp", "--scoped"] } };
    const line = asideCommand({ session: SESSION, fork: FORK, configDir: CONFIG, mcpServers: servers });
    const turn = buildCommand({ resume: SESSION, mcpServers: servers });
    const flag = /--mcp-config '[^']*'/.exec(turn)?.[0];
    expect(flag).toBeDefined();
    expect(line).toContain(flag!);
    expect(line).not.toContain("--strict-mcp-config");
  });

  it("the cleanup refuses a fork id that is not the CLI's shape, so a glob never reaches rm", () => {
    expect(() => forkCleanupCommand({ fork: "*", configDir: CONFIG })).toThrow(/UUID/);
    expect(forkCleanupCommand({ fork: FORK, configDir: CONFIG })).toBe(`rm -rf '/root/.claude-cfg/projects'/*/${FORK}.jsonl '/root/.claude-cfg/projects'/*/${FORK}`);
  });

  it("leaves the model out when the row names none and refuses an id that is not the CLI's shape", () => {
    expect(asideCommand({ session: SESSION, fork: FORK, configDir: CONFIG })).not.toContain("--model");
    expect(asideCommand({ session: SESSION, fork: FORK, configDir: CONFIG }).startsWith("cd ~ && ")).toBe(true);
    expect(() => asideCommand({ session: "../x", fork: FORK, configDir: CONFIG })).toThrow(/UUID/);
    expect(() => asideCommand({ session: SESSION, fork: "*", configDir: CONFIG })).toThrow(/UUID/);
  });

  describe("run by a shell against a stand-in CLI", () => {
    let root: string;
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("the cleanup removes the fork's file and folder and keeps the thread's own; the fork line exits with the CLI's code", () => {
      root = mkdtempSync(join(tmpdir(), "wsp-aside-"));
      const config = join(root, "it's config");
      const project = join(config, "projects", "-root-spoo");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, `${SESSION}.jsonl`), "{}\n");
      const bin = join(root, "bin");
      mkdirSync(bin);
      // The stand-in writes the fork's transcript where the CLI would, prints its result, and exits with a code of its own.
      writeStub(
        join(bin, "claude"),
        `#!/bin/sh\nmkdir -p ${JSON.stringify(join(project, FORK))}\nprintf '{}\\n' > ${JSON.stringify(join(project, `${FORK}.jsonl`))}\nprintf '%s\\n' '{"type":"result"}'\nexit 3\n`,
      );
      const line = asideCommand({ session: SESSION, fork: FORK, configDir: config, cwd: root });
      expect(line).not.toContain("rm ");
      let code = 0;
      let out = "";
      try {
        out = execFileSync("/bin/bash", ["-c", line], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
      } catch (e) {
        code = (e as { status: number }).status;
        out = String((e as { stdout: string }).stdout);
      }
      expect(out.trim()).toBe('{"type":"result"}');
      expect(code).toBe(3);
      expect(existsSync(join(project, `${FORK}.jsonl`))).toBe(true);
      execFileSync("/bin/bash", ["-c", forkCleanupCommand({ fork: FORK, configDir: config })], { env: { PATH: "/usr/bin:/bin" } });
      expect(existsSync(join(project, `${FORK}.jsonl`))).toBe(false);
      expect(existsSync(join(project, FORK))).toBe(false);
      expect(existsSync(join(project, `${SESSION}.jsonl`))).toBe(true);
    });
  });
});

describe("the adapter's aside", () => {
  const adapter = (factory: ExecStreamFactory, extra: { asideWallMs?: number } = {}) =>
    createClaudeAdapter({ exec: factory, configDir: CONFIG, baseEnv: { PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "cli" }, oauthToken: "sk-ant-oat-x", projectDirName: "-root-spoo", resultExitMs: 5, interruptGraceMs: 5, ...extra });

  it("runs the fork line on the turn's road with the turn's environment and the question as the one user line, and answers the result", async () => {
    const exec = scripted([
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK, cwd: "/root/spoo", tools: [] }),
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "You are in /root/spoo" }] }, session_id: FORK }),
      JSON.stringify(RESULT),
    ]);
    const servers = { wsp: { command: "wsp", args: ["mcp"] } };
    const answer = await adapter(exec.factory).aside!({ session: SESSION, question: "which folder, and what did I last ask?", cwd: "/root/spoo", model: "claude-opus-5", mcpServers: servers });
    expect(answer).toEqual({ text: RESULT.result, usage: RESULT.usage });
    const call = exec.calls[0]!;
    const fork = forkOf(call.command);
    expect(fork).toMatch(/^[0-9a-f-]{36}$/);
    expect(fork).not.toBe(SESSION);
    expect(call.command).toBe(asideCommand({ session: SESSION, fork, configDir: CONFIG, cwd: "/root/spoo", model: "claude-opus-5", mcpServers: servers }));
    // The turn's own environment: the login it signs in with and the folder key the thread's session is stored under.
    expect(call.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x", CLAUDE_CODE_PROJECT_DIR_NAME: "-root-spoo", PATH: "/bin" });
    expect(call.env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    expect(call.input).toEqual([userMessageLine("which folder, and what did I last ask?", fork)]);
    expect(exec.order).toContain("closeInput");
    // The fork's file goes by a second run on the same road and environment, once the CLI's own run has ended.
    expect(exec.calls[1]).toMatchObject({ command: forkCleanupCommand({ fork, configDir: CONFIG }), input: undefined });
    expect(exec.calls[1]!.env).toMatchObject({ PATH: "/bin" });
    expect(exec.order.indexOf("exited 1")).toBeLessThan(exec.order.indexOf("launch 2"));
    expect(exec.calls).toHaveLength(2);
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

  it("rejects with what the CLI printed when it exits with no result, and still removes the fork's file", async () => {
    const exec = scripted(["No conversation found with session ID: e16ed170-8257-4668-879e-fe836341633c"], { exitCode: 1 });
    await expect(adapter(exec.factory).aside!({ session: SESSION, question: "hi" })).rejects.toThrow("No conversation found with session ID");
    expect(exec.calls[1]!.command).toBe(forkCleanupCommand({ fork: forkOf(exec.calls[0]!.command), configDir: CONFIG }));
  });

  it("ends a CLI that says nothing for the whole wall and says so", async () => {
    const exec = scripted([], { hang: true });
    await expect(adapter(exec.factory, { asideWallMs: 20 }).aside!({ session: SESSION, question: "hi" })).rejects.toThrow(asideWallLine(20));
    expect(exec.order.slice(0, 2)).toEqual(["launch 1", "teardown"]);
    // The kill took the CLI's shell with it, so the fork's file goes by a run of its own once that one has ended.
    const fork = forkOf(exec.calls[0]!.command);
    expect(exec.calls[1]!.command).toBe(forkCleanupCommand({ fork, configDir: CONFIG }));
    expect(exec.order.indexOf("exited 1")).toBeLessThan(exec.order.indexOf("launch 2"));
  });
});
