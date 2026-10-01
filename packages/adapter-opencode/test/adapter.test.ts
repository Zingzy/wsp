// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures: model-not-found.jsonl and catalog-probe.txt are what opencode 1.18.18
// printed on this Mac under an empty home with no credential (stdout and stderr
// merged, as a turn's log merges them). turn.jsonl and every inline line below
// are hand-written: no real model turn ran. Their shapes are the run command's
// JSON writer and the part and error schemas in the 1.18.18 binary (text,
// tool_use, step_start, step_finish and error lines; ToolPart, StepFinishPart,
// ProviderAuthError).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createOpenCodeAdapter } from "../src/adapter.js";

const SESSION = "ses_f1d4a1b2cffeQwErTyUiOpAsDf";
const RUN_HANDLE = "/tmp/wsp-run/oc01";
const SIGN_IN_ROAD = "sign this workspace in from the Workspace panel, then send again";

const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0);

interface ScriptedExec {
  factory: ExecStreamFactory;
  calls: { command: string; env: Record<string, string>; input: readonly string[] | undefined }[];
  order: string[];
}

/** Replays scripted log lines; in hang mode the stream only ends once the process is signalled. */
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

const adapterOver = (exec: ScriptedExec, extra: { resultExitMs?: number; interruptGraceMs?: number } = {}) =>
  createOpenCodeAdapter({ exec: exec.factory, baseEnv: { PATH: "/root/.local/bin:/usr/bin" }, signInRefusal: SIGN_IN_ROAD, ...extra });

const line = (type: string, fields: Record<string, unknown>): string => JSON.stringify({ type, timestamp: 1790510000000, sessionID: SESSION, ...fields });

describe("OpenCodeAdapter over an opencode run --format json turn", () => {
  it("launches the run line with the picks under the login environment, the prompt on the heredoc and no stdin channel", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const adapter = adapterOver(exec);
    const session = adapter.start({ prompt: "list the three largest files", cwd: "/root/app", model: "anthropic/claude-sonnet-4-5", effort: "high", permissionMode: "auto", onEvent: () => {} });
    await session.finished;
    const call = exec.calls[0]!;
    expect(call.command.startsWith("cd '/root/app' && opencode run --format json")).toBe(true);
    expect(call.command).toContain("-m anthropic/claude-sonnet-4-5 --variant high --auto <<'WSP_PROMPT_END'\nlist the three largest files\nWSP_PROMPT_END");
    expect(call.input).toBeUndefined();
    expect(call.env).toEqual({ PATH: "/root/.local/bin:/usr/bin" });
    expect(session.command).toBe(call.command);
    expect(session.run).toBe(RUN_HANDLE);
    expect(adapter.steers).toBe(false);
    expect(adapter.attachments).toBe("file");
    expect("mcpServers" in adapter).toBe(false);
  });

  it("normalizes a turn into session.start, text and tool deltas, turn.done at the last step and session.end", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const { events, onEvent } = collect();
    const session = adapterOver(exec).start({ prompt: "go", cwd: "/root/app", model: "anthropic/claude-sonnet-4-5", onEvent });
    const result = await session.finished;
    expect(session.sessionId).toBe(SESSION);
    expect(events.map(e => (e.type === "turn.delta" ? `delta:${e.kind}` : e.type))).toEqual(["session.start", "delta:text", "delta:tool_use", "delta:tool_result", "delta:text", "turn.done", "session.end"]);
    expect(events[0]).toEqual({ type: "session.start", sessionId: SESSION, model: "anthropic/claude-sonnet-4-5", cwd: "/root/app" });
    expect(events[1]).toEqual({ type: "turn.delta", sessionId: SESSION, kind: "text", text: "I will list the files by size.", messageId: "msg_f1d4a1b2c001" });
    expect(events[2]).toEqual({ type: "turn.delta", sessionId: SESSION, kind: "tool_use", text: JSON.stringify({ command: "ls -S | head -3", description: "Lists the three largest files" }), toolName: "bash", toolUseId: "call_f1d4ls01" });
    expect(events[3]).toEqual({ type: "turn.delta", sessionId: SESSION, kind: "tool_result", text: "pnpm-lock.yaml\nREADME.md\npackage.json\n", toolUseId: "call_f1d4ls01", isError: false });
    expect(result).toMatchObject({ status: "completed", text: "The three largest are pnpm-lock.yaml, README.md and package.json.", costUsd: 0.002 });
    // Every step's input side summed, cache reads and writes in; what the model held is the last step's whole count.
    expect(result.tokens).toEqual({ input: 3300, cached: 1000, cacheWrite: 0, output: 190, reasoning: 50, context: 2340 });
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
  });

  it("a tool part that failed is an error result carrying the tool's own error", async () => {
    const failed = line("tool_use", { part: { id: "prt_1", sessionID: SESSION, messageID: "msg_1", type: "tool", callID: "call_rd", tool: "read", state: { status: "error", input: { filePath: "/nope" }, error: "File not found: /nope", time: { start: 1, end: 2 } } } });
    const { events, onEvent } = collect();
    await adapterOver(scriptedExec([failed])).start({ prompt: "go", onEvent }).finished;
    expect(events).toContainEqual({ type: "turn.delta", sessionId: SESSION, kind: "tool_result", text: "File not found: /nope", toolUseId: "call_rd", isError: true });
  });

  it("the turn ends at the step whose reason ends the loop, and a process that lingers past it is ended", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"), { hang: true });
    const { events, onEvent } = collect();
    const result = await adapterOver(exec, { resultExitMs: 5, interruptGraceMs: 5 }).start({ prompt: "go", onEvent }).finished;
    expect(result.status).toBe("completed");
    expect(exec.order).toContain("teardown");
    expect(events.filter(e => e.type === "turn.done")).toHaveLength(1);
  });

  it("a step that asked for tools does not end the turn: the process exiting after it with no last step still reads the last text", async () => {
    const lines = fixture("turn.jsonl").slice(0, 4);
    const result = await adapterOver(scriptedExec(lines)).start({ prompt: "go", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "completed", text: "I will list the files by size." });
  });

  it("an unknown model fails the turn in the log's own words, not the stream's server-error placeholder", async () => {
    const { events, onEvent } = collect();
    const result = await adapterOver(scriptedExec(fixture("model-not-found.jsonl"), { exitCode: 1 })).start({ prompt: "say hi", onEvent }).finished;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("ProviderModelNotFoundError: Model not found: anthropic/claude-sonnet-4-5. Did you mean: claude-sonnet-4-5, claude-sonnet-4-5-20250929?");
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: 1, sawResult: false });
  });

  it("a provider that refuses the credential is a sign-in refusal, with wsp's road beside OpenCode's words", async () => {
    const refused = line("error", { error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } } });
    const result = await adapterOver(scriptedExec([refused], { exitCode: 1 })).start({ prompt: "go", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: `Invalid API key; ${SIGN_IN_ROAD}`, refusal: "sign-in" });
    const unauthorized = line("error", { error: { name: "APIError", data: { message: "Unauthorized", statusCode: 401, isRetryable: false } } });
    expect(await adapterOver(scriptedExec([unauthorized], { exitCode: 1 })).start({ prompt: "go", onEvent: () => {} }).finished).toMatchObject({ refusal: "sign-in" });
  });

  it("a process that dies before any event fails the turn with what it printed", async () => {
    const result = await adapterOver(scriptedExec(["bash: opencode: command not found"], { exitCode: 127 })).start({ prompt: "go", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: "opencode exited with code 127 before its turn ended: bash: opencode: command not found" });
  });

  it("interrupt ends the process and the turn reads interrupted", async () => {
    const exec = scriptedExec([line("step_start", { part: { id: "p", sessionID: SESSION, messageID: "m", type: "step-start" } })], { hang: true });
    const { events, onEvent } = collect();
    const session = adapterOver(exec, { interruptGraceMs: 5 }).start({ prompt: "go", onEvent });
    await new Promise(resolve => setTimeout(resolve, 5));
    await session.interrupt();
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(exec.order[0]).toBe("teardown");
    expect(events.at(-1)).toMatchObject({ type: "session.end", sessionId: SESSION, sawResult: false });
  });

  it("an attach re-opens the run with no channel and takes the model and folder off the row", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const attached: { run: string; input: boolean }[] = [];
    exec.factory.attach = async (run, options) => {
      attached.push({ run, input: options.input });
      return exec.factory("", { env: {} });
    };
    const { events, onEvent } = collect();
    const session = await adapterOver(exec).attach!({ run: RUN_HANDLE, sessionId: SESSION, startedAt: 1, model: "anthropic/claude-sonnet-4-5", cwd: "/root/app", onEvent });
    if (session === "gone") throw new Error("the run was there");
    expect(session.command).toBeUndefined();
    expect((await session.finished).status).toBe("completed");
    expect(attached).toEqual([{ run: RUN_HANDLE, input: false }]);
    expect(events[0]).toMatchObject({ type: "session.start", sessionId: SESSION, model: "anthropic/claude-sonnet-4-5", cwd: "/root/app" });
  });

  it("an image reaches the line as a file on the machine, and one with no path is refused before anything runs", () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const adapter = adapterOver(exec);
    adapter.start({ prompt: "what is this", images: [{ mediaType: "image/png", bytes: "", path: "/root/.wsp/images/t/a.png" }], onEvent: () => {} });
    expect(exec.calls[0]!.command).toContain("-f '/root/.wsp/images/t/a.png'");
    expect(() => adapter.start({ prompt: "x", images: [{ mediaType: "image/png", bytes: "AAAA" }], onEvent: () => {} })).toThrow(/no path/);
  });
});

describe("what opencode reports about itself", () => {
  it("reads its version and each model with the variants it offers off `opencode models --verbose`", async () => {
    const commands: string[] = [];
    const probe = await adapterOver(scriptedExec([])).probeCatalog(async command => {
      commands.push(command);
      return fixture("catalog-probe.txt").join("\n");
    });
    expect(commands[0]).toBe("cd ~ && export PATH='/root/.local/bin:/usr/bin'; opencode --version; echo __WSP_CATALOG_SEP__; opencode models --verbose");
    expect(probe).toEqual({
      version: "1.18.18",
      models: [
        { slug: "opencode/big-pickle", label: "Big Pickle", efforts: [], contextWindows: [], isDefault: false },
        { slug: "opencode/ling-3.0-flash-fin-free", label: "Ling 3.0 Flash Fin Free", efforts: ["low", "medium", "high"], contextWindows: [], isDefault: false },
      ],
      efforts: ["low", "medium", "high"],
      permissionModes: ["auto"],
    });
  });

  it("answers nothing when the binary printed no model", async () => {
    const adapter = adapterOver(scriptedExec([]));
    expect(await adapter.probeCatalog(async () => "bash: opencode: command not found\n")).toBeNull();
    expect(await adapter.probeCatalog(async () => "1.18.18\n__WSP_CATALOG_SEP__\n")).toBeNull();
  });
});

describe("a person's setup for OpenCode on a computer", () => {
  it("runs the program in place of opencode on a turn and a probe, the launch words on the turn alone", async () => {
    const exec = scriptedExec(fixture("turn.jsonl"));
    const adapter = createOpenCodeAdapter({ exec: exec.factory, launch: { program: "/opt/oc", args: ["--port", "0"] } });
    await adapter.start({ prompt: "hi", onEvent: () => {} }).finished;
    expect(exec.calls[0]!.command).toContain(`'/opt/oc' run '--port' '0' --format json`);
    const asked: string[] = [];
    await adapter.probeCatalog(async command => {
      asked.push(command);
      return "";
    });
    expect(asked[0]).toContain(`'/opt/oc' --version`);
    expect(asked[0]).toContain(`'/opt/oc' models --verbose`);
    expect(asked[0]).not.toContain("--port");
  });
});
