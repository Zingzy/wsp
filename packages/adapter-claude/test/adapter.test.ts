import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AdapterEvent, ExecStream, ExecStreamFactory } from "../src/adapter.js";
import { createClaudeAdapter } from "../src/adapter.js";
import { userMessageLine } from "../src/landmines.js";

const FIXTURE_SESSION_ID = "e16ed170-8257-4668-879e-fe836341633c";

function fixtureLines(): string[] {
  const raw = readFileSync(new URL("./fixtures/stream-session.jsonl", import.meta.url), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

interface ScriptedExec {
  factory: ExecStreamFactory;
  calls: { command: string; env: Record<string, string>; input: readonly string[] | undefined }[];
  order: string[];
}

/** Replays scripted stdout lines; in hang mode the stream only ends on kill(). */
function scriptedExec(lines: string[], opts: { exitCode?: number; hang?: boolean } = {}): ScriptedExec {
  const calls: ScriptedExec["calls"] = [];
  const order: string[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const stream: ExecStream = {
      lines: (async function* () {
        yield* lines;
        if (opts.hang) await exited;
        else resolveExit(opts.exitCode ?? 0);
      })(),
      teardown: () => {
        order.push("teardown");
        if (!opts.hang) resolveExit(opts.exitCode ?? 0);
      },
      kill: () => {
        order.push("kill");
        resolveExit(null);
      },
      write: async () => {
        order.push("write");
        return "written" as const;
      },
      closeInput: () => {
        order.push("closeInput");
      },
      exited,
    };
    return stream;
  };
  return { factory, calls, order };
}

/** A stream the test feeds line by line and ends by hand, with every write recorded; beforeWrite runs inside write() before the line lands, gone makes the guest report the process over so no line lands, and slowTeardown leaves the process up after teardown, as a CLI held by background tasks is. */
function manualExec(opts: { beforeWrite?: () => Promise<void>; gone?: boolean; slowTeardown?: boolean } = {}) {
  const calls: ScriptedExec["calls"] = [];
  const writes: string[] = [];
  const order: string[] = [];
  let push: (line: string) => void = () => {};
  let end: (code: number | null) => void = () => {};
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const exited = new Promise<number | null>((resolve) => {
      end = (code) => {
        ended = true;
        resolve(code);
        wake?.();
      };
    });
    push = (line) => {
      queue.push(line);
      wake?.();
    };
    const lines = (async function* () {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    })();
    return {
      lines,
      exited,
      teardown: () => {
        order.push("teardown");
        if (opts.slowTeardown !== true) end(143);
      },
      kill: () => {
        order.push("kill");
        end(null);
      },
      write: async (line) => {
        order.push("write");
        await opts.beforeWrite?.();
        if (opts.gone === true) return "gone";
        writes.push(line);
        return "written";
      },
      closeInput: () => {
        order.push("closeInput");
      },
    };
  };
  return { factory, calls, writes, order, push: (line: string) => push(line), end: (code: number | null) => end(code) };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!check()) throw new Error("condition never held");
}

function collect(): { events: AdapterEvent[]; onEvent: (e: AdapterEvent) => void } {
  const events: AdapterEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe("ClaudeAdapter over the recorded fixture", () => {
  it("launches with the picked model, effort and permission mode", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", model: "claude-opus-5", effort: "low", permissionMode: "plan", onEvent: () => {} });
    await session.finished;
    expect(exec.calls[0]?.command).toContain("--model 'claude-opus-5'");
    expect(exec.calls[0]?.command).toContain("--effort 'low'");
    expect(exec.calls[0]?.command).toContain("--permission-mode 'plan'");
  });

  it("probes the catalog through the exec it is handed, under the session's config dir, and reads the answer", async () => {
    const adapter = createClaudeAdapter({ exec: scriptedExec([]).factory, configDir: "/root/.claude-cfg" });
    const ran: string[] = [];
    const probe = await adapter.probeCatalog(async command => {
      ran.push(command);
      return readFileSync(new URL("./fixtures/catalog-probe.txt", import.meta.url), "utf8");
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain("CLAUDE_CONFIG_DIR='/root/.claude-cfg'");
    expect(probe?.version).toBe("2.1.257");
    expect(probe?.models.map(m => m.slug)).toContain("claude-opus-5");
    expect(await adapter.probeCatalog(async () => "garbage\n")).toBeNull();
  });

  it("normalizes the stream into session.start / turn.delta / turn.done / session.end", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "write a hello world server", onEvent });
    const result = await session.finished;

    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "turn.delta",
      "turn.delta",
      "turn.delta",
      "turn.delta",
      "turn.delta",
      "turn.done",
      "session.end",
    ]);

    const start = events[0];
    if (start?.type !== "session.start") throw new Error("expected session.start");
    expect(start.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(start.model).toBe("claude-sonnet-4-5");
    expect(start.cwd).toBe("/root");
    expect(start.tools).toContain("Bash");

    const deltas = events.filter((e) => e.type === "turn.delta");
    expect(deltas.map((d) => d.kind)).toEqual([
      "text",
      "tool_use",
      "tool_result",
      "thinking",
      "text",
    ]);
    const toolUse = deltas[1];
    expect(toolUse?.toolName).toBe("Bash");
    expect(toolUse?.toolUseId).toBe("toolu_01WspFixBash1");
    expect(toolUse?.text).toContain("curl -s http://localhost:3000");
    const toolResult = deltas[2];
    expect(toolResult?.text).toBe("Hello, World!");
    expect(toolResult?.isError).toBe(false);
    expect(deltas[3]?.text).toContain("server is live");

    expect(result.status).toBe("completed");
    expect(result.durationMs).toBe(10458);
    expect(result.costUsd).toBe(0.0187);
    expect(result.text).toBe("Server is live at :3000 and answered: Hello, World!");

    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.exitCode).toBe(0);
    expect(end.sawResult).toBe(true);
    expect(session.claudeSessionId).toBe(FIXTURE_SESSION_ID);
  });

  it("forwards system/init's slash_commands, permissionMode and agents as harness", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    await adapter.start({ prompt: "write a hello world server", onEvent }).finished;

    const start = events[0];
    if (start?.type !== "session.start") throw new Error("expected session.start");
    expect(start.harness).toEqual({
      slashCommands: ["compact", "context", "cost", "init", "review"],
      permissionMode: "bypassPermissions",
      agents: ["general-purpose"],
    });
  });

  it("leaves harness unset when system/init carries none of its fields", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init]);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    await adapter.start({ prompt: "x", onEvent }).finished;

    const start = events[0];
    if (start?.type !== "session.start") throw new Error("expected session.start");
    expect(start.harness).toBeUndefined();
    expect("harness" in start).toBe(false);
  });

  it("spawns with the landmine-safe command and env", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({
      exec: exec.factory,
      configDir: "/root/.claude-cfg",
      baseEnv: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/usr/bin", HOME: "/Users/z" },
    });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "say ok", onEvent });
    await session.finished;

    const call = exec.calls[0];
    if (!call) throw new Error("exec never called");
    expect(call.command).toContain("--output-format stream-json");
    expect(call.command).toContain("--input-format stream-json");
    expect(call.command).toContain("--verbose");
    expect(call.command).toContain("--dangerously-skip-permissions");
    expect(call.command).toContain(`--session-id ${session.localId}`);
    // The prompt is the first line of the stdin channel, seeded at launch; the shell never sees it.
    expect(call.command).not.toContain("</dev/null");
    expect(call.command).not.toContain("say ok");
    expect(call.input).toEqual([userMessageLine("say ok", session.localId)]);
    expect(call.env.CLAUDECODE).toBeUndefined();
    expect(call.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(call.env.CLAUDE_CONFIG_DIR).toBe("/root/.claude-cfg");
    expect(call.env.HOME).toBe("/Users/z");
  });

  it("starts claude in the guest home unless a cwd is named", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    await adapter.start({ prompt: "say ok", onEvent }).finished;
    await adapter.start({ prompt: "say ok", cwd: "/root/app", onEvent }).finished;

    expect(exec.calls[0]?.command.startsWith("cd ~ && claude -p")).toBe(true);
    expect(exec.calls[1]?.command.startsWith("cd '/root/app' && claude -p")).toBe(true);
  });

  it("self-generates the session UUID and registers the session before any output", () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "say ok", onEvent });

    expect(session.localId).toMatch(/^[0-9a-f-]{36}$/);
    expect(adapter.sessions.get(session.localId)).toBe(session);
  });

  it("resumes with the prior session id as the registry key", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "next turn", resume: FIXTURE_SESSION_ID, onEvent });
    await session.finished;

    expect(session.localId).toBe(FIXTURE_SESSION_ID);
    expect(exec.calls[0]?.command).toContain(`--resume ${FIXTURE_SESSION_ID}`);
  });
});

describe("interrupt policy (teardown, then SIGKILL)", () => {
  it("escalates to kill when teardown does not end the process, and reports the turn interrupted", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init], { hang: true });
    const adapter = createClaudeAdapter({
      exec: exec.factory,
      configDir: "/root/.claude-cfg",
      interruptGraceMs: 15,
    });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "loop forever", onEvent });
    await session.interrupt();
    const result = await session.finished;

    expect(exec.order).toEqual(["teardown", "kill"]);
    expect(result.status).toBe("interrupted");
    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.sawResult).toBe(false);
    expect(end.exitCode).toBeNull();
  });

  it("does not kill when teardown ends the process within the grace window", async () => {
    const exec = scriptedExec(fixtureLines());
    const adapter = createClaudeAdapter({
      exec: exec.factory,
      configDir: "/root/.claude-cfg",
      interruptGraceMs: 5_000,
    });
    const { onEvent } = collect();

    const session = adapter.start({ prompt: "say ok", onEvent });
    await session.finished;
    await session.interrupt();

    expect(exec.order).toEqual(["closeInput", "teardown"]);
  });
});

describe("steer over the stdin channel", () => {
  const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
  const result = `{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":5,"session_id":"${FIXTURE_SESSION_ID}"}`;

  it("declares that its sessions take a message mid-turn", () => {
    expect(createClaudeAdapter({ exec: manualExec().factory, configDir: "/root/.claude-cfg" }).steers).toBe(true);
  });

  it("before system/init answers not-running and writes nothing", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent: () => {} });
    expect(await session.steer("also this")).toBe("not-running");
    expect(exec.writes).toEqual([]);
    exec.end(0);
    await session.finished;
  });

  it("between init and result writes one user line under the CLI's session id and answers accepted", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    expect(await session.steer("also this")).toBe("accepted");
    expect(exec.writes).toEqual([userMessageLine("also this", FIXTURE_SESSION_ID)]);
    expect(exec.order).toEqual(["write"]);
    exec.push(result);
    exec.end(0);
    expect((await session.finished).status).toBe("completed");
  });

  it("after result answers not-running, and result closed the channel once", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    exec.push(result);
    await until(() => events.some((e) => e.type === "turn.done"));
    expect(exec.order).toEqual(["closeInput"]);
    expect(await session.steer("too late")).toBe("not-running");
    expect(exec.writes).toEqual([]);
    exec.end(0);
    await session.finished;
    expect(exec.order).toEqual(["closeInput"]);
  });

  it("after the process exited without a result answers not-running", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent: () => {} });
    exec.push(init);
    exec.end(1);
    await session.finished;
    expect(await session.steer("too late")).toBe("not-running");
    expect(exec.writes).toEqual([]);
  });

  it("when the guest says the process is already gone, before the poll saw it, answers not-running and no line landed", async () => {
    const exec = manualExec({ gone: true });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    expect(await session.steer("after exit")).toBe("not-running");
    expect(exec.order).toEqual(["write"]);
    expect(exec.writes).toEqual([]);
    exec.end(1);
    expect((await session.finished).status).toBe("failed");
  });

  it("once interrupt was asked answers not-running and writes nothing, before the process is seen to exit", async () => {
    const exec = manualExec({ slowTeardown: true });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", interruptGraceMs: 30 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    const interrupting = session.interrupt();
    expect(exec.order).toEqual(["teardown"]);
    expect(await session.steer("into a stopping turn")).toBe("not-running");
    expect(exec.writes).toEqual([]);
    await interrupting;
    expect(exec.order).toEqual(["teardown", "kill"]);
    expect((await session.finished).status).toBe("interrupted");
  });

  it("a write that lands after the turn ended answers not-running: the line sits unread and the caller starts a turn instead", async () => {
    const { events, onEvent } = collect();
    let turnEnds: () => void = () => {};
    const exec = manualExec({
      beforeWrite: async () => {
        turnEnds();
        await until(() => events.some((e) => e.type === "turn.done"));
      },
    });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some((e) => e.type === "session.start"));
    turnEnds = () => exec.push(result);
    expect(await session.steer("racing")).toBe("not-running");
    expect(exec.writes).toHaveLength(1);
    exec.end(0);
    await session.finished;
  });
});

describe("result classification", () => {
  function resultRun(resultLine: string): Promise<{ events: AdapterEvent[]; result: import("../src/adapter.js").TurnResult }> {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init, resultLine]);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "x", onEvent });
    return session.finished.then((result) => ({ events, result }));
  }

  it("maps aborted_streaming to interrupted", async () => {
    const { result } = await resultRun(
      `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","errors":["[ede_diagnostic] stream abort trace"],"duration_ms":812,"session_id":"${FIXTURE_SESSION_ID}"}`,
    );
    expect(result.status).toBe("interrupted");
    expect(result.error).toBeUndefined();
  });

  it("maps other execution errors to failed and hides [ede_diagnostic] noise", async () => {
    const { result } = await resultRun(
      `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["[ede_diagnostic] internal","MCP server exploded"],"duration_ms":900,"session_id":"${FIXTURE_SESSION_ID}"}`,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("MCP server exploded");
  });

  it("fails the turn when the process dies without a result event", async () => {
    const init = `{"type":"system","subtype":"init","session_id":"${FIXTURE_SESSION_ID}"}`;
    const exec = scriptedExec([init], { exitCode: 1 });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "x", onEvent });
    const result = await session.finished;

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 1/);
    const end = events.at(-1);
    if (end?.type !== "session.end") throw new Error("expected session.end");
    expect(end.sawResult).toBe(false);
  });

  it("skips lines that are not stream-json events", async () => {
    const lines = [
      "not json at all",
      "42",
      '{"type":123}',
      `{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":5,"session_id":"${FIXTURE_SESSION_ID}"}`,
    ];
    const exec = scriptedExec(lines);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();

    const session = adapter.start({ prompt: "x", onEvent });
    const result = await session.finished;

    expect(result.status).toBe("completed");
    expect(events.map((e) => e.type)).toEqual(["turn.done", "session.end"]);
  });
});

describe("ClaudeAdapter follows the agent's tool shell", () => {
  const SID = "e16ed170-8257-4668-879e-fe836341633c";
  const init = JSON.stringify({ type: "system", subtype: "init", cwd: "/root", session_id: SID, tools: ["Bash", "Write"], model: "claude-sonnet-4-5" });
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const toolResult = (id: string) =>
    JSON.stringify({ type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1, result: "done", session_id: SID });

  async function run(lines: string[]) {
    const exec = scriptedExec(lines);
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    await adapter.start({ prompt: "go", onEvent }).finished;
    return events.filter((e) => e.type === "turn.delta").map((e) => (e.type === "turn.delta" ? [e.kind, e.toolName, e.cwd] : []));
  }

  it("stamps the shell's folder on the tool_use that moves it, and nothing else", async () => {
    const deltas = await run([
      init,
      toolUse("t1", "Bash", { command: "ls" }),
      toolResult("t1"),
      toolUse("t2", "Bash", { command: "cd /root/2048 && npm test" }),
      toolResult("t2"),
      toolUse("t3", "Write", { file_path: "/root/2048/src/game.js", content: "" }),
      toolResult("t3"),
      toolUse("t4", "Bash", { command: "cd /root/2048" }),
      toolResult("t4"),
      result,
    ]);
    expect(deltas).toEqual([
      ["tool_use", "Bash", undefined],
      ["tool_result", undefined, undefined],
      ["tool_use", "Bash", "/root/2048"],
      ["tool_result", undefined, undefined],
      ["tool_use", "Write", undefined],
      ["tool_result", undefined, undefined],
      ["tool_use", "Bash", undefined],
      ["tool_result", undefined, undefined],
    ]);
  });

  it("takes a Write under the harness folder as the shell's folder when no cd came first", async () => {
    const deltas = await run([
      init,
      toolUse("t1", "Write", { file_path: "/root/2048/index.html", content: "" }),
      toolResult("t1"),
      toolUse("t2", "Edit", { file_path: "/root/2048/style.css", old_string: "a", new_string: "b" }),
      toolResult("t2"),
      toolUse("t3", "Write", { file_path: "/etc/motd", content: "" }),
      toolResult("t3"),
      result,
    ]);
    expect(deltas.filter(([kind]) => kind === "tool_use")).toEqual([
      ["tool_use", "Write", "/root/2048"],
      ["tool_use", "Edit", undefined],
      ["tool_use", "Write", undefined],
    ]);
  });
});
