// SPDX-License-Identifier: AGPL-3.0-only
// Both fixtures are codex-cli 0.155.1's own output, stderr lines and all, driven through this adapter's own lines:
// app-server-turn.jsonl a signed-in turn in a read-only sandbox that asked to run a command, was allowed and took one
// steer (MCP server names, hook paths and the host scrubbed), no-login-app-server.jsonl a turn under an empty
// CODEX_HOME.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asideWallLine, CODEX_FEWER_TURNS, CODEX_LEGACY_HISTORY, codexKeyRefusedLine, codexMissingEnvLine, codexNotSignedInLine, codexReconnectLine, PERMISSION_ALLOW, PERMISSION_DENY } from "@wsp/protocol";
import type { AdapterEvent, ExecStream, ExecStreamFactory, TurnResult } from "@wsp/protocol";
import { createCodexAdapter, creditsOf, type CodexSession } from "../src/adapter.js";

const THREAD_ID = "01a0e2c1-5d10-7b42-9a6e-3f1c2d4b5a60";
const TURN_ID = "01a0e2c1-5e02-7c11-8d3f-9b2a1c0d4e71";
const RECORDED_THREAD = "01a0e365-72f3-77e3-ba3a-3d18e12e9b95";
const RECORDED_TURN = "01a0e365-73b9-7e10-8045-3ff9e93753f9";
const RECORDED_COMMAND = "exec-267f4a9f-3715-4cb1-b8fc-14f9a57ec2f9";
const NO_LOGIN_THREAD = "01a0e2b2-493b-7c53-ae59-446697cb28db";

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0);
}

const RUN_HANDLE = "/tmp/wsp-run/cd34";

type Json = Record<string, unknown>;
const parse = (line: string): Json => JSON.parse(line) as Json;

/** One app-server process under test: the lines it prints, the lines wsp wrote to it (the launch's seed first), and
 * how it ended. It exits on stdin EOF as the real one does, unless it hangs. */
interface Wire {
  stream: ExecStream;
  written: Json[];
  order: string[];
  closed: boolean;
  push(...lines: string[]): void;
  exit(code: number | null): void;
}

function wire(opts: { exitCode?: number; hang?: boolean; onWrite?: (message: Json, w: Wire) => void } = {}): Wire {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>(resolve => {
    resolveExit = resolve;
  });
  const w: Wire = {
    written: [],
    order: [],
    closed: false,
    push: (...lines) => {
      queue.push(...lines);
      wake?.();
    },
    exit: code => {
      if (done) return;
      done = true;
      wake?.();
      resolveExit(code);
    },
    stream: undefined as unknown as ExecStream,
  };
  w.stream = {
    run: RUN_HANDLE,
    lines: (async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) return;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
        wake = undefined;
      }
    })(),
    teardown: () => {
      w.order.push("teardown");
      if (!opts.hang) w.exit(opts.exitCode ?? 0);
    },
    kill: () => {
      w.order.push("kill");
      w.exit(null);
    },
    write: async line => {
      if (done) return "gone";
      const message = parse(line);
      w.written.push(message);
      opts.onWrite?.(message, w);
      return "written";
    },
    closeInput: () => {
      w.closed = true;
      if (!opts.hang) setTimeout(() => w.exit(opts.exitCode ?? 0), 0);
    },
    exited,
  };
  return w;
}

/** Plays a recorded server: everything up to its answer to the thread request once that request arrives, the rest
 * once a turn starts. */
function server(lines: string[], opts: { exitCode?: number; hang?: boolean } = {}): (seed: readonly string[]) => Wire {
  const split = lines.findIndex(l => l.includes('"id":"wsp-thread"')) + 1;
  const head = lines.slice(0, split);
  const tail = lines.slice(split);
  return seed => {
    const w = wire({
      ...opts,
      onWrite: (message, self) => {
        if (message.method === "thread/start" || message.method === "thread/resume") self.push(...head);
        if (message.method === "turn/start") self.push(...tail);
      },
    });
    for (const line of seed) void w.stream.write(line);
    return w;
  };
}

interface Launch {
  factory: ExecStreamFactory;
  calls: { command: string; env: Record<string, string>; input: readonly string[] | undefined }[];
  wires: Wire[];
}

function launcher(make: (seed: readonly string[]) => Wire): Launch {
  const calls: Launch["calls"] = [];
  const wires: Wire[] = [];
  const factory: ExecStreamFactory = (command, { env, input }) => {
    calls.push({ command, env, input });
    const w = make(input ?? []);
    wires.push(w);
    return w.stream;
  };
  return { factory, calls, wires };
}

function collect(): { events: AdapterEvent[]; onEvent: (e: AdapterEvent) => void } {
  const events: AdapterEvent[] = [];
  return { events, onEvent: e => events.push(e) };
}

const deltasOf = (events: AdapterEvent[]) => events.filter((e): e is Extract<AdapterEvent, { type: "turn.delta" }> => e.type === "turn.delta");

const LOGIN = "codex login --device-auth";
const NOT_SIGNED_IN = codexNotSignedInLine(LOGIN);
const adapterOver = (launch: Launch, extra: { graceMs?: number; stallMs?: number; resultExitMs?: number } = {}) =>
  createCodexAdapter({
    exec: launch.factory,
    home: "/root/.codex",
    login: LOGIN,
    ...(extra.graceMs !== undefined ? { interruptGraceMs: extra.graceMs } : {}),
    ...(extra.stallMs !== undefined ? { reconnectStallMs: extra.stallMs } : {}),
    ...(extra.resultExitMs !== undefined ? { resultExitMs: extra.resultExitMs } : {}),
  });

/** The lines a live server prints up to a running turn, for the cases that drive the rest by hand. */
const opened = (threadId = THREAD_ID): string[] => [
  '{"id":"wsp-initialize","result":{"userAgent":"wsp/0.155.1","codexHome":"/root/.codex","platformFamily":"unix","platformOs":"linux"}}',
  `{"id":"wsp-thread","result":{"thread":{"id":"${threadId}","model":"gpt-5.6-sol","cwd":"/root/app","turns":[]},"model":"gpt-5.6-sol","cwd":"/root/app","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite"}}}`,
];
const turnStarted = `{"method":"turn/started","params":{"threadId":"${THREAD_ID}","turn":{"id":"${TURN_ID}","items":[],"status":"inProgress"}}}`;
const completed = (status: string, extra = "") => `{"method":"turn/completed","params":{"threadId":"${THREAD_ID}","turn":{"id":"${TURN_ID}","items":[],"status":"${status}"${extra}}}}`;
const failedWith = (message: string) => completed("failed", `,"error":${JSON.stringify({ message })}`);
const errorNote = (message: string, willRetry: boolean, details: string | null = null) =>
  `{"method":"error","params":{"error":${JSON.stringify({ message, additionalDetails: details })},"willRetry":${String(willRetry)},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`;
const agentMessage = (id: string, text: string) => `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"${id}","text":${JSON.stringify(text)}},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`;
const reconnecting = errorNote("Reconnecting... 2/5", true, "error sending request");

/** A server that opens the thread and starts the turn, then prints what the case hands it. */
const scripted = (rest: string[], opts: { exitCode?: number; hang?: boolean } = {}) => server([...opened(), turnStarted, ...rest], opts);

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 1));
  expect(check()).toBe(true);
};

describe("a Codex turn's tokens and plan on the app server", () => {
  const usage = (total: [number, number], last: [number, number], window = 258_400) =>
    `{"method":"thread/tokenUsage/updated","params":{"threadId":"${THREAD_ID}","turnId":"${TURN_ID}","tokenUsage":{"total":{"inputTokens":${total[0]},"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":${total[1]},"reasoningOutputTokens":0,"totalTokens":${total[0] + total[1]}},"last":{"inputTokens":${last[0]},"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":${last[1]},"reasoningOutputTokens":0,"totalTokens":${last[0] + last[1]}},"modelContextWindow":${window}}}}`;

  it("counts a resumed thread's turn from where its running total stood, not from the thread's start", async () => {
    const launch = launcher(scripted([usage([50_000, 900], [20_000, 100]), usage([72_000, 1_000], [22_000, 100]), agentMessage("m1", "done"), completed("completed")]));
    const result = await adapterOver(launch).start({ prompt: "again", resume: THREAD_ID, onEvent: () => {} }).finished;
    expect(result.tokens).toEqual({ input: 42_000, cached: 0, cacheWrite: 0, output: 200, reasoning: 0, context: 22_100, window: 258_400 });
  });

  it("says what each model call drew as the server reports it, so the account's draw right now can be read", async () => {
    const { events, onEvent } = collect();
    await adapterOver(launcher(scripted([usage([50_000, 900], [20_000, 100]), usage([72_000, 1_000], [22_000, 100]), agentMessage("m1", "done"), completed("completed")]))).start({ prompt: "again", resume: THREAD_ID, onEvent }).finished;
    expect(events.filter(e => e.type === "turn.usage")).toEqual([
      { type: "turn.usage", sessionId: THREAD_ID, tokens: 20_100 },
      { type: "turn.usage", sessionId: THREAD_ID, tokens: 22_100 },
    ]);
  });

  it("carries the moment the server says it sent each call's figure, so a re-read run files old calls at their own time", async () => {
    const stamped = usage([50_000, 900], [20_000, 100]).replace(/}$/, `,"emittedAtMs":1790521480354}`);
    const { events, onEvent } = collect();
    await adapterOver(launcher(scripted([stamped, agentMessage("m1", "done"), completed("completed")]))).start({ prompt: "again", resume: THREAD_ID, onEvent }).finished;
    expect(events.filter(e => e.type === "turn.usage")).toEqual([{ type: "turn.usage", sessionId: THREAD_ID, tokens: 20_100, at: 1790521480354 }]);
  });

  it("reads the plan the server updates as the turn's steps, the step under way as working", async () => {
    const plan = `{"method":"turn/plan/updated","params":{"threadId":"${THREAD_ID}","turnId":"${TURN_ID}","explanation":null,"plan":[{"step":"read","status":"completed"},{"step":"write","status":"inProgress"},{"step":"ship","status":"pending"}]}}`;
    const { events, onEvent } = collect();
    await adapterOver(launcher(scripted([plan, agentMessage("m1", "done"), completed("completed")]))).start({ prompt: "plan", onEvent }).finished;
    expect(events.filter(e => e.type === "turn.plan")).toEqual([
      { type: "turn.plan", sessionId: THREAD_ID, steps: [{ text: "read", state: "done" }, { text: "write", state: "working" }, { text: "ship", state: "pending" }] },
    ]);
  });
});

describe("CodexAdapter over codex app-server", () => {
  it("launches the app server in the folder under CODEX_HOME, seeding initialize and the thread with the picks; the turn follows the thread", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const adapter = adapterOver(launch);
    const session = adapter.start({ prompt: "list the repo", model: "gpt-5.5", effort: "low", permissionMode: "workspace-write", cwd: "/root/app", onEvent: () => {} });
    await session.finished;
    const call = launch.calls[0]!;
    expect(call.command).toBe("cd '/root/app' && codex app-server -c tools.update_plan.enabled='true'");
    expect(call.command).not.toContain("list the repo");
    expect(call.env).toEqual({ CODEX_HOME: "/root/.codex" });
    expect(adapter.env).toEqual({ CODEX_HOME: "/root/.codex" });
    expect(session.command).toBe(call.command);
    expect(call.input?.map(l => parse(l).method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read", "thread/start"]);
    expect(parse(call.input![4]!).params).toEqual({ cwd: "/root/app", model: "gpt-5.5", sandbox: "workspace-write", approvalPolicy: "on-request" });
    const turn = launch.wires[0]!.written.find(m => m.method === "turn/start")!;
    expect(turn.params).toEqual({ threadId: RECORDED_THREAD, input: [{ type: "text", text: "list the repo" }], effort: "low" });
    // The reply is the turn's end, so stdin closes there and the server exits on its own.
    expect(launch.wires[0]!.closed).toBe(true);
  });

  it("takes its prompt late: the server starts and opens the thread at once, and the turn goes once the prompt is due", async () => {
    // The launch's snapshot of the folder is what the prompt waits on, and it took 0.46 to 1.6 s on a one-file repo
    // (measured 2026-10-05); before the server boots in that window, every send paid it in full first.
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const adapter = adapterOver(launch);
    expect(adapter.waitsForPrompt).toBe(true);
    let due!: () => void;
    const session = adapter.start({ prompt: "list the repo", promptAfter: new Promise<void>(r => (due = r)), onEvent: () => {} });
    await until(() => launch.wires[0]!.written.some(m => m.method === "thread/start"));
    await new Promise(r => setTimeout(r, 5));
    expect(launch.wires[0]!.written.some(m => m.method === "turn/start")).toBe(false);
    due();
    expect((await session.finished).status).toBe("completed");
    expect(launch.wires[0]!.written.find(m => m.method === "turn/start")!.params).toMatchObject({ threadId: RECORDED_THREAD, input: [{ type: "text", text: "list the repo" }] });
  });

  it("reads a recorded turn: session.start, the CLI's warning as a note, each item as deltas, the approval, turn.done and session.end", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const { events, onEvent } = collect();
    let session: CodexSession | undefined;
    // Answered as the recording's person answered it: the command ran once it was allowed.
    const answering = (e: AdapterEvent): void => {
      onEvent(e);
      if (e.type === "permission.ask") void session!.answer(e.ask.askId, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "" });
    };
    session = adapterOver(launch).start({ prompt: "Run the shell command `touch hi.txt` in this folder, then reply with one short line.", permissionMode: "read-only", onEvent: answering });
    const result = await session.finished;

    expect(events.map(e => (e.type === "turn.delta" ? `delta:${e.kind}` : e.type))).toEqual([
      "session.start",
      "delta:note",
      "turn.anchor",
      "delta:text",
      "delta:tool_use",
      "permission.ask",
      "permission.close",
      "delta:tool_result",
      "turn.usage",
      "limit",
      "delta:text",
      "turn.usage",
      "limit",
      "turn.done",
      "session.end",
    ]);
    expect(events[0]).toEqual({ type: "session.start", sessionId: RECORDED_THREAD, model: "gpt-5.6-sol", cwd: "/private/tmp/b7-real" });
    const deltas = deltasOf(events);
    expect(deltas[0]!.text).toMatch(/^loading hooks from both /);
    expect(deltas[1]).toMatchObject({ text: "I\u2019ll create `hi.txt` in the current folder.", messageId: "msg_0567d7bf2c7ea0de016ab930865e9087d09774946388412886" });
    expect(deltas[2]).toMatchObject({ toolName: "command_execution", toolUseId: RECORDED_COMMAND, text: JSON.stringify({ command: "/bin/zsh -lc 'touch hi.txt'" }) });
    // The recording's two rolling updates, each a plan window pair on a Plus plan, epoch seconds read as ms.
    expect(events.flatMap(e => (e.type === "limit" ? [e.limit] : [])).at(-1)).toEqual({
      windows: [
        { kind: "session", usedPercent: 9, resetsAt: 1_790_539_090_000 },
        { kind: "week", usedPercent: 5, resetsAt: 1_791_094_756_000 },
      ],
      plan: "plus",
      status: "ok",
    });
    const ask = events.find((e): e is Extract<AdapterEvent, { type: "permission.ask" }> => e.type === "permission.ask")!.ask;
    expect(ask).toMatchObject({ askId: "0", toolName: "command_execution", toolUseId: RECORDED_COMMAND, detail: "Allow me to create hi.txt in the current folder?" });
    expect(JSON.parse(ask.input)).toEqual({ command: "/bin/zsh -lc 'touch hi.txt'", cwd: "/private/tmp/b7-real" });
    expect(launch.wires[0]!.written).toContainEqual({ id: 0, result: { decision: "accept" } });
    // The server's own resolved notice for that request finds nothing open, so the prompt closes once.
    expect(events.filter(e => e.type === "permission.close")).toEqual([{ type: "permission.close", sessionId: RECORDED_THREAD, askId: "0", outcome: "allowed", optionId: PERMISSION_ALLOW }]);
    expect(deltas[3]).toMatchObject({ kind: "tool_result", toolUseId: RECORDED_COMMAND, text: "", isError: false });
    expect(deltas[4]).toMatchObject({ kind: "text", text: "Created hi.txt in this folder." });
    for (const d of deltas) expect(d.sessionId).toBe(RECORDED_THREAD);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Created hi.txt in this folder.");
    // The turn's own counts are the thread's running total less what it stood at before the turn's first call; what
    // the model held is the last call's, and the window is the one the server names.
    expect(result.tokens).toEqual({ input: 41_624, cached: 31_744, cacheWrite: 0, output: 124, reasoning: 31, context: 20_913, window: 258_400 });
    expect(result.model).toBe("gpt-5.6-sol");
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: RECORDED_THREAD, exitCode: 0, sawResult: true });
    expect(session.threadId).toBe(RECORDED_THREAD);
    expect(session.localId).not.toBe(RECORDED_THREAD);
  });

  it("the recorded steer answers with the running turn's id, which is what reads as accepted", () => {
    const answer = fixtureLines("app-server-turn").map(l => (l.startsWith("{") ? parse(l) : {})).find(m => m.id === "wsp-steer-1");
    expect(answer).toEqual({ id: "wsp-steer-1", result: { turnId: RECORDED_TURN } });
  });

  it("file changes, MCP calls and web searches, which that turn made none of, draw as codex exec's calls did", async () => {
    // Written from the 0.155.1 schema's ThreadItem variants, since the recorded turn ran one command and no other tool.
    const item = (phase: "started" | "completed", body: Record<string, unknown>) => `{"method":"item/${phase}","params":{"item":${JSON.stringify(body)},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`;
    const change = { type: "fileChange", id: "call_2", changes: [{ path: "README.md", kind: { type: "update", move_path: null }, diff: "" }, { path: "docs/new.md", kind: { type: "add" }, diff: "" }] };
    const mcp = { type: "mcpToolCall", id: "call_3", server: "wsp", tool: "threads", arguments: { workspace: "first" } };
    const search = { type: "webSearch", id: "ws_1", query: "codex app-server" };
    const launch = launcher(
      scripted([
        item("started", { ...change, status: "inProgress" }),
        item("completed", { ...change, status: "completed" }),
        item("started", { ...mcp, status: "inProgress", result: null, error: null }),
        item("completed", { ...mcp, status: "completed", result: { content: [{ type: "text", text: '{"threads":[]}' }] }, error: null }),
        item("completed", { type: "reasoning", id: "rs_1", summary: ["Listing the repository first."], content: [] }),
        item("started", search),
        item("completed", search),
        completed("completed"),
      ]),
    );
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "x", onEvent }).finished;
    const deltas = deltasOf(events);
    expect(deltas.map(d => [d.kind, d.toolName, d.toolUseId, d.text])).toEqual([
      ["tool_use", "file_change", "call_2", JSON.stringify({ changes: [{ path: "README.md", kind: "update" }, { path: "docs/new.md", kind: "add" }] })],
      ["tool_result", undefined, "call_2", "update README.md\nadd docs/new.md"],
      ["tool_use", "wsp.threads", "call_3", JSON.stringify({ workspace: "first" })],
      ["tool_result", undefined, "call_3", JSON.stringify([{ type: "text", text: '{"threads":[]}' }])],
      ["thinking", undefined, undefined, "Listing the repository first."],
      ["tool_use", "web_search", "ws_1", JSON.stringify({ query: "codex app-server" })],
      ["tool_result", undefined, "ws_1", "codex app-server"],
    ]);
  });

  it("resumes a thread by the id the row holds: the registry key is that id and the seed asks thread/resume", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const adapter = adapterOver(launch);
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "next", resume: RECORDED_THREAD, permissionMode: "read-only", cwd: "/root/app", onEvent });
    await session.finished;
    expect(session.localId).toBe(RECORDED_THREAD);
    expect(adapter.sessions.get(RECORDED_THREAD)).toBe(session);
    expect(parse(launch.calls[0]!.input![4]!)).toEqual({ id: "wsp-thread", method: "thread/resume", params: { threadId: RECORDED_THREAD, cwd: "/root/app", sandbox: "read-only", approvalPolicy: "on-request" } });
    expect(new Set(events.map(e => e.sessionId))).toEqual(new Set([RECORDED_THREAD]));
  });

  it("images ride the turn as local paths, and one with no path on the machine is refused before anything launches", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    await adapterOver(launch).start({ prompt: "what is this?", images: [{ mediaType: "image/png", bytes: "", path: "/root/.wsp/threads/thr_1/images/1.png" }], onEvent: () => {} }).finished;
    expect(launch.wires[0]!.written.find(m => m.method === "turn/start")!.params).toMatchObject({ input: [{ type: "text", text: "what is this?" }, { type: "localImage", path: "/root/.wsp/threads/thr_1/images/1.png" }] });

    const none = launcher(server(fixtureLines("app-server-turn")));
    expect(() => adapterOver(none).start({ prompt: "x", images: [{ mediaType: "image/png", bytes: "aGk=" }], onEvent: () => {} })).toThrow("no path on it");
    expect(() => adapterOver(none).start({ prompt: "x", images: [{ mediaType: "image/png", bytes: "", path: "shot.png" }], onEvent: () => {} })).toThrow("must be one absolute path");
    expect(none.calls).toEqual([]);
  });

  it("refuses a context window, which codex has no setting for", () => {
    expect(() => adapterOver(launcher(server([]))).start({ prompt: "x", contextWindow: "1m", onEvent: () => {} })).toThrow("codex takes no context window");
  });
});

describe("a message sent while a Codex turn runs", () => {
  it("steers the running turn by its id and reads accepted off the server's answer", async () => {
    const live = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted);
          if (message.method === "turn/steer") self.push(`{"id":${JSON.stringify(message.id)},"result":{"turnId":"${TURN_ID}"}}`);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const adapter = adapterOver(live);
    expect(adapter.steers).toBe(true);
    const session = adapter.start({ prompt: "count to 40", onEvent: () => {} });
    await until(() => live.wires[0]!.written.some(m => m.method === "turn/start"));
    await new Promise(r => setTimeout(r, 5));
    expect(await session.steer!("stop at 12")).toBe("accepted");
    const steer = live.wires[0]!.written.find(m => m.method === "turn/steer")!;
    expect(steer.params).toEqual({ threadId: THREAD_ID, expectedTurnId: TURN_ID, input: [{ type: "text", text: "stop at 12" }] });
    live.wires[0]!.push(agentMessage("msg_1", "stopped at 12"), completed("completed"));
    expect(await session.finished).toMatchObject({ status: "completed", text: "stopped at 12" });
  });

  it("reads not-running when the server turns the steer down, and before the turn has started", async () => {
    const live = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/steer") self.push(`{"error":{"code":-32600,"message":"no active turn"},"id":${JSON.stringify(message.id)}}`);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const session = adapterOver(live).start({ prompt: "x", onEvent: () => {} });
    expect(await session.steer!("too early")).toBe("not-running");
    expect(live.wires[0]!.written.some(m => m.method === "turn/steer")).toBe(false);
    live.wires[0]!.push(turnStarted);
    await new Promise(r => setTimeout(r, 5));
    expect(await session.steer!("refused")).toBe("not-running");
    live.wires[0]!.push(completed("completed"));
    await session.finished;
    expect(await session.steer!("after the end")).toBe("not-running");
  });
});

describe("an approval Codex asks for", () => {
  const approving = (request: string) =>
    launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start")
            self.push(turnStarted, `{"method":"item/started","params":{"item":{"type":"fileChange","id":"call_9","changes":[{"path":"hi.txt","kind":{"type":"add"},"diff":"+hi\\n"}],"status":"inProgress"},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`, request);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
  const fileAsk = `{"id":0,"method":"item/fileChange/requestApproval","params":{"threadId":"${THREAD_ID}","turnId":"${TURN_ID}","itemId":"call_9","reason":"write outside the sandbox","startedAtMs":1}}`;
  const commandAsk = `{"id":"ask-7","method":"item/commandExecution/requestApproval","params":{"threadId":"${THREAD_ID}","turnId":"${TURN_ID}","itemId":"call_4","command":"rm -rf build","cwd":"/root/app","startedAtMs":1,"proposedExecpolicyAmendment":["rm"]}}`;

  it("raises a file change as a prompt with allow and deny, the change's paths as its input, and answers allow with accept alone", async () => {
    const live = approving(fileAsk);
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "write hi into hi.txt", permissionMode: "read-only", onEvent });
    await until(() => events.some(e => e.type === "permission.ask"));
    const ask = events.find((e): e is Extract<AdapterEvent, { type: "permission.ask" }> => e.type === "permission.ask")!.ask;
    expect(ask).toEqual({
      askId: "0",
      toolName: "file_change",
      toolUseId: "call_9",
      input: JSON.stringify({ changes: [{ path: "hi.txt", kind: "add" }] }),
      detail: "write outside the sandbox",
      options: [
        { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
        { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
      ],
    });
    expect(await session.answer!("0", { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "" })).toBe("answered");
    expect(live.wires[0]!.written.at(-1)).toEqual({ id: 0, result: { decision: "accept" } });
    expect(events.at(-1)).toEqual({ type: "permission.close", sessionId: THREAD_ID, askId: "0", outcome: "allowed", optionId: PERMISSION_ALLOW });
    expect(await session.answer!("0", { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "" })).toBe("gone");
    live.wires[0]!.push(completed("completed"));
    await session.finished;
  });

  it("answers a command's deny with decline under the server's own id, never widening the prompt for the session or writing policy", async () => {
    const live = approving(commandAsk);
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "clean", permissionMode: "workspace-write", onEvent });
    await until(() => events.some(e => e.type === "permission.ask"));
    const ask = events.find((e): e is Extract<AdapterEvent, { type: "permission.ask" }> => e.type === "permission.ask")!.ask;
    expect(ask).toMatchObject({ askId: "ask-7", toolName: "command_execution", toolUseId: "call_4", input: JSON.stringify({ command: "rm -rf build", cwd: "/root/app" }) });
    expect(await session.answer!("ask-7", { optionId: PERMISSION_DENY, outcome: "denied", denyMessage: "not now" })).toBe("answered");
    expect(live.wires[0]!.written.at(-1)).toEqual({ id: "ask-7", result: { decision: "decline" } });
    live.wires[0]!.push(completed("completed"));
    await session.finished;
    const decisions = live.wires[0]!.written.flatMap(m => (m.result !== undefined ? [JSON.stringify(m.result)] : []));
    for (const d of decisions) expect(d).not.toMatch(/acceptForSession|Execpolicy|NetworkPolicy/);
  });

  it("closes a prompt the server resolved itself, and every prompt still open when the process goes", async () => {
    const live = approving(fileAsk);
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "x", onEvent });
    await until(() => events.some(e => e.type === "permission.ask"));
    live.wires[0]!.push(`{"method":"serverRequest/resolved","params":{"threadId":"${THREAD_ID}","requestId":0}}`);
    await until(() => events.some(e => e.type === "permission.close"));
    expect(events.find(e => e.type === "permission.close")).toMatchObject({ askId: "0", outcome: "cancelled" });

    const second = approving(commandAsk);
    const { events: later, onEvent: onLater } = collect();
    const cut = adapterOver(second).start({ prompt: "x", onEvent: onLater });
    await until(() => later.some(e => e.type === "permission.ask"));
    second.wires[0]!.exit(1);
    await cut.finished;
    expect(later.find(e => e.type === "permission.close")).toMatchObject({ askId: "ask-7", outcome: "cancelled" });
    live.wires[0]!.push(completed("completed"));
    await session.finished;
  });

  it("refuses a server request it does not serve with an error, so the turn is not left waiting on it", async () => {
    const live = approving(`{"id":5,"method":"item/tool/requestUserInput","params":{"threadId":"${THREAD_ID}","turnId":"${TURN_ID}","itemId":"call_5","questions":[]}}`);
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "x", onEvent });
    await until(() => live.wires[0]!.written.some(m => m.id === 5));
    expect(live.wires[0]!.written.find(m => m.id === 5)).toEqual({ id: 5, error: { code: -32601, message: "wsp does not answer item/tool/requestUserInput" } });
    expect(events.some(e => e.type === "permission.ask")).toBe(false);
    live.wires[0]!.push(completed("completed"));
    await session.finished;
  });
});

describe("a Codex turn that does not complete", () => {
  it("a turn with no sign-in, as codex-cli 0.155.1 printed it, is the sign-in line with its cause, and the server exits on EOF", async () => {
    const launch = launcher(server(fixtureLines("no-login-app-server")));
    const { events, onEvent } = collect();
    const result = await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(NOT_SIGNED_IN).toBe("Codex is not signed in where this workspace runs; run codex login --device-auth there");
    expect(result).toMatchObject({ status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" });
    expect(events.map(e => e.type)).toEqual(["session.start", "turn.anchor", "turn.delta", "turn.done", "session.end"]);
    expect(events.at(-1)).toEqual({ type: "session.end", sessionId: NO_LOGIN_THREAD, exitCode: 0, sawResult: true });
    expect(launch.wires[0]!.closed).toBe(true);
  });

  it("a failed turn carries the server's own reason where wsp claims no cause for it", async () => {
    const result = await adapterOver(launcher(scripted([errorNote("stream disconnected before completion", false), failedWith("stream disconnected before completion")]))).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "failed", error: "stream disconnected before completion" });
    expect(result.refusal).toBeUndefined();
  });

  it("a 401 on a turn that was handed the vault's key is said as a refused key, with the provider's own reason and no url", async () => {
    const withKey = (launch: Launch) => createCodexAdapter({ exec: launch.factory, home: "/root/.codex", login: LOGIN, apiKey: "sk-x-not-a-key", keyEnv: "OPENAI_API_KEY" });
    const refused = await withKey(launcher(scripted([failedWith("unexpected status 401 Unauthorized: token expired, url: https://api.openai.com/v1/responses, cf-ray: x")]))).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(refused).toMatchObject({ status: "failed", error: codexKeyRefusedLine("OPENAI_API_KEY", "token expired", LOGIN), refusal: "sign-in" });
    const none = await adapterOver(launcher(scripted([failedWith("unexpected status 401 Unauthorized: token expired")]))).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(none).toMatchObject({ status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" });
  });

  it("a provider whose env_key variable is unset fails the turn naming that variable, in the protocol's words", async () => {
    const result = await adapterOver(launcher(scripted([failedWith("Missing environment variable: `FAKE_API_KEY`.")]))).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "failed", error: codexMissingEnvLine("FAKE_API_KEY") });
  });

  it("the last failure seen wins: a 401 in an early retry, then a turn that fails for another reason, names that reason", async () => {
    const result = await adapterOver(launcher(scripted([errorNote("Reconnecting... 1/5", true, "unexpected status 401 Unauthorized: token expired"), agentMessage("msg_1", "partway"), failedWith("Missing environment variable: `LATER_KEY`.")]))).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "failed", error: codexMissingEnvLine("LATER_KEY") });
    expect(result.refusal).toBeUndefined();
  });

  it("a server that turns the thread down fails the turn in its words and sends no turn", async () => {
    const launch = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/resume") self.push('{"id":"wsp-initialize","result":{}}', '{"error":{"code":-32600,"message":"no rollout found for thread id 01a0"},"id":"wsp-thread"}');
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const { events, onEvent } = collect();
    const result = await adapterOver(launch).start({ prompt: "x", resume: THREAD_ID, onEvent }).finished;
    expect(result).toEqual({ status: "failed", error: "codex could not open the thread: no rollout found for thread id 01a0" });
    expect(launch.wires[0]!.written.some(m => m.method === "turn/start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });

  it("a process that dies mid-turn fails under the thread's id with its last stderr lines", async () => {
    const launch = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") {
            self.push(turnStarted, "2026-09-27T00:51:50Z ERROR codex_core: sandbox unavailable");
            setTimeout(() => self.exit(2), 1);
          }
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const { events, onEvent } = collect();
    const result = await adapterOver(launch).start({ prompt: "x", onEvent }).finished;
    expect(result).toEqual({ status: "failed", error: "codex exited with code 2 before its turn ended: 2026-09-27T00:51:50Z ERROR codex_core: sandbox unavailable" });
    expect(events.map(e => [e.type, e.sessionId])).toEqual([["session.start", THREAD_ID], ["turn.anchor", THREAD_ID], ["turn.done", THREAD_ID], ["session.end", THREAD_ID]]);
  });

  it("a transport that ends the turn itself makes its message the turn's error", async () => {
    const failing: ExecStreamFactory = command => ({
      ...wire().stream,
      lines: (async function* () {
        yield command.length > 0 ? opened()[0]! : "";
        throw new Error("turn cut: idle 10m");
      })(),
      exited: Promise.resolve(null),
    });
    const result = await createCodexAdapter({ exec: failing, home: "/root/.codex", login: LOGIN }).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toEqual({ status: "failed", error: "turn cut: idle 10m" });
  });

  it("a provider that never answers: the server retries forever, so the adapter ends the turn in words and kills the process", async () => {
    const launch = launcher(scripted([reconnecting, reconnecting], { hang: true }));
    const { events, onEvent } = collect();
    const result = await adapterOver(launch, { graceMs: 10, stallMs: 20 }).start({ prompt: "x", onEvent }).finished;
    expect(launch.wires[0]!.order).toEqual(["teardown", "kill"]);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^stopped after \d+m \d\ds of Codex reconnecting to its model provider with no answer$/);
    expect(codexReconnectLine(90_000)).toBe("stopped after 1m 30s of Codex reconnecting to its model provider with no answer");
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: null, sawResult: false });
  });

  it("a retry run that recovers into the turn is not cut", async () => {
    const launch = launcher(scripted([reconnecting, agentMessage("msg_1", "back"), completed("completed")]));
    const result = await adapterOver(launch, { graceMs: 10, stallMs: 20 }).start({ prompt: "x", onEvent: () => {} }).finished;
    expect(result).toMatchObject({ status: "completed", text: "back" });
    expect(launch.wires[0]!.order).toEqual([]);
  });
});

describe("interrupt", () => {
  it("asks the server to interrupt the running turn, which then completes as interrupted and exits on EOF", async () => {
    const live = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted);
          if (message.method === "turn/interrupt") self.push(`{"id":${JSON.stringify(message.id)},"result":{}}`, completed("interrupted"));
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const { events, onEvent } = collect();
    const session = adapterOver(live, { graceMs: 5_000 }).start({ prompt: "loop forever", onEvent });
    await until(() => live.wires[0]!.written.some(m => m.method === "turn/start"));
    await new Promise(r => setTimeout(r, 5));
    await session.interrupt();
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(live.wires[0]!.written.find(m => m.method === "turn/interrupt")!.params).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
    expect(live.wires[0]!.order).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "session.end", exitCode: 0, sawResult: true });
  });

  it("ends the process with its tree when the server does not stop inside the grace window", async () => {
    const launch = launcher(scripted([], { hang: true }));
    const session = adapterOver(launch, { graceMs: 15 }).start({ prompt: "loop forever", onEvent: () => {} });
    await until(() => launch.wires[0]!.written.some(m => m.method === "turn/start"));
    await new Promise(r => setTimeout(r, 5));
    await session.interrupt();
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(launch.wires[0]!.order).toEqual(["teardown", "kill"]);
  });

  it("an interrupt before the server started the turn ends the process at once, with nothing to ask it", async () => {
    const launch = launcher(seed => {
      const w = wire({ hang: true });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const session = adapterOver(launch, { graceMs: 15 }).start({ prompt: "x", onEvent: () => {} });
    await session.interrupt();
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(launch.wires[0]!.written.some(m => m.method === "turn/interrupt")).toBe(false);
    expect(launch.wires[0]!.order).toEqual(["teardown", "kill"]);
  });

  it("a stop before the prompt was handed over sends no turn, then or once the prompt is due", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const { events, onEvent } = collect();
    let due!: () => void;
    const session = adapterOver(launch, { graceMs: 15 }).start({ prompt: "x", promptAfter: new Promise<void>(r => (due = r)), onEvent });
    await until(() => events.some(e => e.type === "session.start"));
    await session.interrupt();
    due();
    expect(await session.finished).toEqual({ status: "interrupted" });
    await new Promise(r => setTimeout(r, 5));
    expect(launch.wires[0]!.written.some(m => m.method === "turn/start")).toBe(false);
  });

  it("an interrupt after the process is gone sends nothing and ends nothing", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const session = adapterOver(launch, { graceMs: 5_000 }).start({ prompt: "x", onEvent: () => {} });
    await session.finished;
    const before = launch.wires[0]!.written.length;
    await session.interrupt();
    expect(launch.wires[0]!.written.length).toBe(before);
    expect(launch.wires[0]!.order).toEqual([]);
  });
});

describe("what ends a Codex turn", () => {
  const statusOf = (type: string) => `{"method":"thread/status/changed","params":{"threadId":"${THREAD_ID}","status":{"type":"${type}"}}}`;
  const running = (onInterrupt?: (self: Wire, id: unknown) => void) =>
    launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted);
          if (message.method === "turn/steer") self.push(`{"id":${JSON.stringify(message.id)},"result":{"turnId":"${TURN_ID}"}}`);
          if (message.method === "turn/interrupt") onInterrupt?.(self, message.id);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
  const pending = async (finished: Promise<unknown>, ms: number): Promise<boolean> => (await Promise.race([finished.then(() => false), new Promise<boolean>(r => setTimeout(() => r(true), ms))]));

  it("only turn/completed: the thread going idle and its last message leave the turn open and a steer accepted", async () => {
    const live = running();
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "x", onEvent });
    await until(() => events.some(e => e.type === "turn.anchor"));
    live.wires[0]!.push(agentMessage("m1", "all done"), statusOf("idle"));
    expect(await pending(session.finished, 50)).toBe(true);
    expect(events.some(e => e.type === "turn.done")).toBe(false);
    expect(await session.steer("one more thing")).toBe("accepted");
    live.wires[0]!.push(completed("completed"));
    expect(await session.finished).toMatchObject({ status: "completed", text: "all done" });
  });

  it("an interrupt's answer is not the turn's end: it stays open until turn/completed says interrupted", async () => {
    const live = running((self, id) => self.push(`{"id":${JSON.stringify(id)},"result":{}}`));
    const { events, onEvent } = collect();
    const session = adapterOver(live, { graceMs: 5_000 }).start({ prompt: "x", onEvent });
    await until(() => events.some(e => e.type === "turn.anchor"));
    const stopping = session.interrupt();
    await until(() => live.wires[0]!.written.some(m => m.method === "turn/interrupt"));
    expect(await pending(session.finished, 50)).toBe(true);
    live.wires[0]!.push(completed("interrupted"));
    await stopping;
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
    expect(live.wires[0]!.order).toEqual([]);
  });
});

describe("a subagent's frames on its lead's stream", () => {
  // The shape of T3 Code's recorded multi-agent wire (codexMultiAgentWire.json, codex-cli 0.145.0, MIT): a child
  // thread's own turn/started, token usage, items and turn/completed arrive on the lead's stdout under the child's id.
  const CHILD = "019fcfd6-2883-77e0-9013-4410ede70371";
  const CHILD_TURN = "019fcfd6-28bf-7e00-a873-4554526dc845";
  const usageOf = (threadId: string, turnId: string, total: number, last: number) =>
    `{"method":"thread/tokenUsage/updated","params":{"threadId":"${threadId}","turnId":"${turnId}","tokenUsage":{"total":{"inputTokens":${total},"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":${total}},"last":{"inputTokens":${last},"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":${last}},"modelContextWindow":${threadId === THREAD_ID ? 258_400 : 128_000}}}}`;
  const childFrames = [
    `{"method":"thread/status/changed","params":{"threadId":"${CHILD}","status":{"type":"idle"}}}`,
    `{"method":"item/completed","params":{"item":{"type":"subAgentActivity","id":"call_S2JP","kind":"started","agentThreadId":"${CHILD}","agentPath":"/root/alpha"},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}","completedAtMs":1785898346687}}`,
    `{"method":"thread/status/changed","params":{"threadId":"${CHILD}","status":{"type":"active","activeFlags":[]}}}`,
    `{"method":"turn/started","params":{"threadId":"${CHILD}","turn":{"id":"${CHILD_TURN}","items":[],"itemsView":"notLoaded","status":"inProgress","error":null}}}`,
    usageOf(CHILD, CHILD_TURN, 20_756, 20_756),
    `{"method":"turn/plan/updated","params":{"threadId":"${CHILD}","turnId":"${CHILD_TURN}","explanation":null,"plan":[{"step":"child step","status":"inProgress"}]}}`,
    `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"child_m1","text":"child says done"},"threadId":"${CHILD}","turnId":"${CHILD_TURN}"}}`,
  ];
  const childAsk = `{"id":11,"method":"item/commandExecution/requestApproval","params":{"threadId":"${CHILD}","turnId":"${CHILD_TURN}","itemId":"call_c1","command":"ls","cwd":"/root/app","startedAtMs":1}}`;
  const childCompleted = `{"method":"turn/completed","params":{"threadId":"${CHILD}","turn":{"id":"${CHILD_TURN}","items":[],"status":"completed","error":null}}}`;

  const leading = () =>
    launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted, usageOf(THREAD_ID, TURN_ID, 18_261, 18_261), ...childFrames, childAsk);
          if (message.method === "turn/steer") self.push(`{"id":${JSON.stringify(message.id)},"result":{"turnId":"${TURN_ID}"}}`);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });

  it("never lets a child's turn set, end or rename the lead's: the steer names the lead's turn and the lead's completion ends it", async () => {
    const live = leading();
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "permission.ask"));
    expect(await session.steer("and say when")).toBe("accepted");
    expect(live.wires[0]!.written.find(m => m.method === "turn/steer")!.params).toMatchObject({ threadId: THREAD_ID, expectedTurnId: TURN_ID });

    live.wires[0]!.push(childCompleted);
    await new Promise(r => setTimeout(r, 10));
    expect(events.some(e => e.type === "turn.done")).toBe(false);
    expect(live.wires[0]!.closed).toBe(false);

    live.wires[0]!.push(agentMessage("lead_m1", "the lead's reply"), usageOf(THREAD_ID, TURN_ID, 36_576, 18_315), completed("completed"));
    const result = await session.finished;
    expect(result).toMatchObject({ status: "completed", text: "the lead's reply" });
    // The child's one call counts in the turn's tokens; what the lead's model held and its window stay the lead's.
    expect(result.tokens).toMatchObject({ input: 36_576 + 20_756, context: 18_315, window: 258_400 });
    expect(events.filter(e => e.type === "turn.anchor")).toEqual([{ type: "turn.anchor", sessionId: THREAD_ID, anchor: TURN_ID }]);
    expect(events.some(e => e.type === "turn.plan")).toBe(false);
    expect(deltasOf(events).map(d => d.text)).not.toContain("child says done");
  });

  it("an interrupt names the lead's turn after a child's turn started", async () => {
    const live = leading();
    const { events, onEvent } = collect();
    const session = adapterOver(live, { graceMs: 15 }).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "permission.ask"));
    await session.interrupt();
    const interrupts = live.wires[0]!.written.filter(m => m.method === "turn/interrupt").map(m => m.params);
    expect(interrupts).toContainEqual({ threadId: THREAD_ID, turnId: TURN_ID });
    expect(interrupts).not.toContainEqual({ threadId: THREAD_ID, turnId: CHILD_TURN });
  });
  const SPAWN = "call_spawn_1";
  const spawnItem = (phase: "started" | "completed") =>
    `{"method":"item/${phase}","params":{"item":{"type":"collabAgentToolCall","id":"${SPAWN}","tool":"spawnAgent","status":"${phase === "started" ? "inProgress" : "completed"}","senderThreadId":"${THREAD_ID}","receiverThreadIds":${phase === "started" ? "[]" : `["${CHILD}"]`},"prompt":"Sleep 20 s and say done.\\nEnd without waiting.","model":null,"reasoningEffort":null,"agentsStates":{}},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`;
  const childStarted = `{"method":"turn/started","params":{"threadId":"${CHILD}","turn":{"id":"${CHILD_TURN}","items":[],"status":"inProgress","error":null}}}`;
  const childEnded = (status: string, extra = "") => `{"method":"turn/completed","params":{"threadId":"${CHILD}","turn":{"id":"${CHILD_TURN}","items":[],"status":"${status}","error":null${extra}}}}`;
  const childSays = (text: string) => `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"child_m2","text":${JSON.stringify(text)}},"threadId":"${CHILD}","turnId":"${CHILD_TURN}"}}`;
  const activity = (kind: string, path = "/root/alpha") =>
    `{"method":"item/completed","params":{"item":{"type":"subAgentActivity","id":"${SPAWN}","kind":"${kind}","agentThreadId":"${CHILD}","agentPath":"${path}"},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`;

  /** A lead that spawns one child and ends its own turn without waiting, as the person asked it to. */
  const spawning = (o: { interrupts?: boolean; hang?: boolean } = {}) =>
    launcher(seed => {
      const w = wire({
        ...(o.hang === true ? { hang: true } : {}),
        onWrite: (message, self) => {
          const params = message.params as Json | undefined;
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted, spawnItem("started"), spawnItem("completed"), activity("started"), childStarted, usageOf(CHILD, CHILD_TURN, 900, 900));
          if (message.method === "turn/interrupt" && o.interrupts === true) {
            self.push(`{"id":${JSON.stringify(message.id)},"result":{}}`);
            self.push(params?.threadId === CHILD ? childEnded("interrupted") : completed("interrupted"));
          }
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
  const subagents = (events: AdapterEvent[]) => events.filter((e): e is Extract<AdapterEvent, { type: "subagent" }> => e.type === "subagent");
  const tasks = (events: AdapterEvent[]) => events.flatMap(e => (e.type === "turn.tasks" ? [e.running] : []));

  it("holds the lead's reply while its child runs: no turn.done, stdin open, one task, and the child's start named off its spawn", async () => {
    const live = spawning();
    const { events, onEvent } = collect();
    const session = adapterOver(live, { resultExitMs: 15, graceMs: 15 }).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    live.wires[0]!.push(agentMessage("lead_m1", "spawned it"), usageOf(THREAD_ID, TURN_ID, 18_000, 18_000), completed("completed"));
    await new Promise(r => setTimeout(r, 40));
    expect(events.some(e => e.type === "turn.done")).toBe(false);
    expect(live.wires[0]!.closed).toBe(false);
    expect(live.wires[0]!.order).toEqual([]);
    expect(tasks(events).at(-1)).toBe(1);
    expect(subagents(events)[0]).toEqual({
      type: "subagent",
      sessionId: THREAD_ID,
      task: CHILD,
      state: "running",
      parentToolUseId: SPAWN,
      title: "Sleep 20 s and say done.",
    });
    expect(subagents(events).at(-1)).toMatchObject({ task: CHILD, state: "running", depth: 1 });
    expect(deltasOf(events).filter(d => d.toolUseId === SPAWN)).toEqual([
      { type: "turn.delta", sessionId: THREAD_ID, kind: "tool_use", text: JSON.stringify({ prompt: "Sleep 20 s and say done.\nEnd without waiting." }), toolName: "spawn_agent", toolUseId: SPAWN },
      { type: "turn.delta", sessionId: THREAD_ID, kind: "tool_result", text: "", toolUseId: SPAWN, isError: false },
    ]);

    live.wires[0]!.push(childSays("done"), childEnded("completed"));
    const result = await session.finished;
    expect(subagents(events).at(-1)).toEqual({ type: "subagent", sessionId: THREAD_ID, task: CHILD, state: "done", parentToolUseId: SPAWN, summary: "done" });
    expect(result).toMatchObject({ status: "completed", text: "spawned it" });
    expect(result.tokens).toMatchObject({ input: 18_900, context: 18_000, window: 258_400 });
    expect(tasks(events).at(-1)).toBe(0);
    expect(live.wires[0]!.closed).toBe(true);
    expect(events.filter(e => e.type === "turn.usage").map(e => (e as { tokens: number }).tokens)).toEqual([900, 18_000]);
  });

  it("a child whose turn failed reads failed, and one a server's activity says completed reads done", async () => {
    const live = spawning();
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    live.wires[0]!.push(completed("completed"), childEnded("failed", ',"error":{"message":"stream disconnected"}'));
    await session.finished;
    expect(subagents(events).at(-1)).toMatchObject({ task: CHILD, state: "failed" });

    const other = spawning();
    const { events: later, onEvent: onLater } = collect();
    const next = adapterOver(other).start({ prompt: "spawn one agent", onEvent: onLater });
    await until(() => later.some(e => e.type === "subagent"));
    other.wires[0]!.push(completed("completed"), activity("completed"));
    await next.finished;
    expect(subagents(later).at(-1)).toMatchObject({ task: CHILD, state: "done" });
  });

  it("a child known only from its spawn holds the reply but not the idle clock, until its own turn starts", async () => {
    const live = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted, spawnItem("completed"), completed("completed"));
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "x", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    await new Promise(r => setTimeout(r, 10));
    expect(events.some(e => e.type === "turn.done")).toBe(false);
    expect(tasks(events)).toEqual([]);
    live.wires[0]!.push(childStarted);
    await until(() => tasks(events).at(-1) === 1);
    live.wires[0]!.push(childEnded("completed"));
    expect((await session.finished).status).toBe("completed");
    expect(tasks(events)).toEqual([1, 0]);
  });

  it("a spawn the server failed names no child, so nothing holds the lead", async () => {
    const failedSpawn = spawnItem("completed").replace('"status":"completed"', '"status":"failed"');
    const live = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted, failedSpawn, agentMessage("lead_m1", "could not spawn"), completed("completed"));
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const { events, onEvent } = collect();
    expect(await adapterOver(live).start({ prompt: "x", onEvent }).finished).toMatchObject({ status: "completed", text: "could not spawn" });
    expect(subagents(events)).toEqual([]);
    expect(deltasOf(events).filter(d => d.toolUseId === SPAWN)).toEqual([{ type: "turn.delta", sessionId: THREAD_ID, kind: "tool_result", text: "", toolUseId: SPAWN, isError: true }]);
  });

  it("knows a child whose only sign is its own turn starting, and holds the lead for it", async () => {
    const live = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/start") self.push(...opened());
          if (message.method === "turn/start") self.push(turnStarted, childStarted, completed("completed"));
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "x", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    expect(subagents(events)[0]).toEqual({ type: "subagent", sessionId: THREAD_ID, task: CHILD, state: "running", parentToolUseId: CHILD });
    await new Promise(r => setTimeout(r, 10));
    expect(events.some(e => e.type === "turn.done")).toBe(false);
    live.wires[0]!.push(childEnded("completed"));
    expect((await session.finished).status).toBe("completed");
  });

  it("a stop with a child running interrupts the child first, then the lead, and the child reads stopped", async () => {
    const live = spawning({ interrupts: true });
    const { events, onEvent } = collect();
    const session = adapterOver(live, { graceMs: 5_000 }).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    await session.interrupt();
    const interrupts = live.wires[0]!.written.filter(m => m.method === "turn/interrupt").map(m => m.params);
    expect(interrupts).toEqual([
      { threadId: CHILD, turnId: CHILD_TURN },
      { threadId: THREAD_ID, turnId: TURN_ID },
    ]);
    expect(await session.finished).toEqual({ status: "interrupted" });
    expect(subagents(events).at(-1)).toMatchObject({ task: CHILD, state: "stopped" });
    expect(live.wires[0]!.order).toEqual([]);
  });

  it("a stop after the lead's reply interrupts the child alone, and the held reply stands", async () => {
    const live = spawning({ interrupts: true });
    const { events, onEvent } = collect();
    const session = adapterOver(live, { graceMs: 5_000 }).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    live.wires[0]!.push(agentMessage("lead_m1", "spawned it"), completed("completed"));
    await new Promise(r => setTimeout(r, 10));
    await session.interrupt();
    expect(live.wires[0]!.written.filter(m => m.method === "turn/interrupt").map(m => m.params)).toEqual([{ threadId: CHILD, turnId: CHILD_TURN }]);
    expect(await session.finished).toMatchObject({ status: "completed", text: "spawned it" });
    expect(subagents(events).at(-1)).toMatchObject({ state: "stopped" });
  });

  it("a child's approval reaches the person as an ask named by the child's spawn", async () => {
    const live = leading();
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "permission.ask"));
    const ask = events.find((e): e is Extract<AdapterEvent, { type: "permission.ask" }> => e.type === "permission.ask")!;
    expect(ask).toMatchObject({ sessionId: THREAD_ID, ask: { askId: "11", toolName: "command_execution", parentToolUseId: "call_S2JP" } });
    expect(await session.answer(ask.ask.askId, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "" })).toBe("answered");
    expect(live.wires[0]!.written).toContainEqual({ id: 11, result: { decision: "accept" } });
    live.wires[0]!.push(childCompleted, completed("completed"));
    await session.finished;
  });

  it("stops one child alone by its thread id, the lead running on, and its interrupted end reads stopped", async () => {
    const live = spawning({ interrupts: true });
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    expect(await session.stopTask("no-such-thread")).toEqual({ outcome: "not-running" });
    expect(await session.stopTask(CHILD)).toEqual({ outcome: "accepted" });
    expect(live.wires[0]!.written.filter(m => m.method === "turn/interrupt").map(m => m.params)).toEqual([{ threadId: CHILD, turnId: CHILD_TURN }]);
    await until(() => subagents(events).at(-1)?.state === "stopped");
    expect(events.some(e => e.type === "turn.done")).toBe(false);
    expect(await session.stopTask(CHILD)).toEqual({ outcome: "not-running" });
    live.wires[0]!.push(completed("completed"));
    expect((await session.finished).status).toBe("completed");
  });

  it("a process that goes with a child still running ends the child too: stopped under a stop, failed otherwise", async () => {
    const live = spawning();
    const { events, onEvent } = collect();
    const session = adapterOver(live).start({ prompt: "spawn one agent", onEvent });
    await until(() => events.some(e => e.type === "subagent"));
    live.wires[0]!.push(agentMessage("lead_m1", "spawned it"), completed("completed"));
    await new Promise(r => setTimeout(r, 10));
    live.wires[0]!.exit(1);
    expect(await session.finished).toMatchObject({ status: "completed", text: "spawned it" });
    expect(live.wires[0]!.order).toEqual([]);
    expect(subagents(events).at(-1)).toMatchObject({ task: CHILD, state: "failed" });
    expect(events.map(e => e.type).slice(-4)).toEqual(["subagent", "turn.tasks", "turn.done", "session.end"]);

    const stuck = spawning({ hang: true });
    const { events: stopped, onEvent: onStopped } = collect();
    const cut = adapterOver(stuck, { graceMs: 15 }).start({ prompt: "spawn one agent", onEvent: onStopped });
    await until(() => stopped.some(e => e.type === "subagent"));
    await cut.interrupt();
    expect(await cut.finished).toEqual({ status: "interrupted" });
    expect(stuck.wires[0]!.order).toEqual(["teardown", "kill"]);
    expect(subagents(stopped).at(-1)).toMatchObject({ task: CHILD, state: "stopped" });
  });
});

describe("a recorded Codex turn whose lead spawned an agent and ended first", () => {
  // codex-cli 0.155.1 on gpt-5.6-luna at effort low, recorded through a throwaway host: the lead's turn/completed comes
  // before its child's. MCP startup, hook and stderr lines are left out; the account, paths and warnings are scrubbed.
  const LEAD = "01a100dc-e1f0-7183-94f1-048611cff500";
  const CHILD = "01a100dd-0379-7f91-bd7d-76a0d1bcb962";

  it("holds the lead's reply until the child's own turn completes, and says the child's start and end once each", async () => {
    const launch = launcher(server(fixtureLines("app-server-subagent")));
    const { events, onEvent } = collect();
    const result = await adapterOver(launch).start({ prompt: "spawn one agent and end your turn", onEvent }).finished;
    const said = events.filter((e): e is Extract<AdapterEvent, { type: "subagent" }> => e.type === "subagent");
    expect(said).toEqual([
      { type: "subagent", sessionId: LEAD, task: CHILD, state: "running", parentToolUseId: "exec-c2242f64-3c99-4c9b-be0d-2132497b24ef", title: "Reply with the single word done and nothing else." },
      { type: "subagent", sessionId: LEAD, task: CHILD, state: "done", parentToolUseId: "exec-c2242f64-3c99-4c9b-be0d-2132497b24ef", summary: "done" },
    ]);
    const at = (type: string) => events.findIndex(e => e.type === type);
    expect(at("turn.done")).toBeGreaterThan(events.lastIndexOf(said[1]!));
    expect(events.flatMap(e => (e.type === "turn.tasks" ? [e.running] : []))).toEqual([1, 0]);
    expect(result).toMatchObject({ status: "completed", text: "spawned", tokens: { input: 77_535 + 19_515, window: 258_400 } });
    expect(deltasOf(events).map(d => d.text)).not.toContain("done");
    expect(deltasOf(events).filter(d => d.toolUseId === said[0]!.parentToolUseId).map(d => [d.kind, d.toolName, d.text])).toEqual([
      ["tool_use", "spawn_agent", JSON.stringify({ prompt: "Reply with the single word done and nothing else." })],
      ["tool_result", undefined, ""],
    ]);
    expect(launch.wires[0]!.closed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "session.end", sessionId: LEAD, sawResult: true });
  });
});

describe("a turn a later host attaches to", () => {
  it("re-opens the run with its channel, replays the log, and writes nothing in answer to what the replay shows", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    const attached: { run: string; input: boolean }[] = [];
    const replay = wire();
    replay.push(...fixtureLines("app-server-turn"));
    replay.exit(0);
    launch.factory.attach = async (run, options) => {
      attached.push({ run, input: options.input });
      return replay.stream;
    };
    const adapter = adapterOver(launch);
    expect(adapter.start({ prompt: "go", onEvent: () => {} }).run).toBe(RUN_HANDLE);
    const { events, onEvent } = collect();
    const session = (await adapter.attach!({ run: RUN_HANDLE, sessionId: RECORDED_THREAD, startedAt: 1, model: "gpt-5.5", cwd: "/root/app", onEvent })) as CodexSession;
    const result = await session.finished;
    expect(attached).toEqual([{ run: RUN_HANDLE, input: true }]);
    expect(session.command).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(replay.written).toEqual([]);
    expect(events[0]).toMatchObject({ type: "session.start", sessionId: RECORDED_THREAD, model: "gpt-5.5", cwd: "/root/app" });
    expect(events.slice(-2)).toMatchObject([{ type: "turn.done" }, { type: "session.end", exitCode: 0, sawResult: true }]);
  });
});

describe("the process a finished turn leaves", () => {
  it("a server that does not go after its turn completed is ended with its tree, and the turn still reads as its reply", async () => {
    const launch = launcher(scripted([agentMessage("msg_1", "done"), completed("completed")], { hang: true }));
    const { events, onEvent } = collect();
    const result = await adapterOver(launch, { graceMs: 15, resultExitMs: 15 }).start({ prompt: "x", onEvent }).finished;
    expect(launch.wires[0]!.order).toEqual(["teardown", "kill"]);
    expect(result).toMatchObject({ status: "completed", text: "done" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", sawResult: true });
  });

  it("a server that exits on EOF is left alone", async () => {
    const launch = launcher(server(fixtureLines("app-server-turn")));
    expect((await adapterOver(launch, { graceMs: 15, resultExitMs: 15 }).start({ prompt: "x", onEvent: () => {} }).finished).status).toBe("completed");
    await new Promise(r => setTimeout(r, 60));
    expect(launch.wires[0]!.order).toEqual([]);
  });
});

describe("a side question on a Codex thread", () => {
  const FORK = "01a0e2d0-0000-7000-8000-000000000001";
  const forking = (onTurn: (self: Wire) => void, opts: { hang?: boolean } = {}) =>
    launcher(seed => {
      const w = wire({
        ...opts,
        onWrite: (message, self) => {
          // 0.155.1 refuses an ephemeral fork that would hand back the thread's whole history, in these words.
          if (message.method === "thread/fork" && (message.params as Json).excludeTurns !== true)
            self.push('{"id":"wsp-initialize","result":{}}', '{"error":{"code":-32600,"message":"ephemeral paginated thread/fork requires `excludeTurns: true`"},"id":"wsp-thread"}');
          else if (message.method === "thread/fork")
            self.push('{"id":"wsp-initialize","result":{}}', `{"id":"wsp-thread","result":{"thread":{"id":"${FORK}","ephemeral":true,"forkedFromId":"${THREAD_ID}"},"model":"gpt-5.6-sol"}}`);
          if (message.method === "turn/start") onTurn(self);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });

  it("forks the thread ephemeral and read-only on its own server, asks the question on the fork, and reads the answer", async () => {
    const launch = forking(self =>
      self.push(
        `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"You are in /root/app; you last asked me to count."},"threadId":"${FORK}","turnId":"t1"}}`,
        `{"method":"thread/tokenUsage/updated","params":{"threadId":"${FORK}","turnId":"t1","tokenUsage":{"last":{"inputTokens":900,"cachedInputTokens":880,"outputTokens":12,"reasoningOutputTokens":0,"totalTokens":912},"total":{}}}}`,
        `{"method":"turn/completed","params":{"threadId":"${FORK}","turn":{"id":"t1","items":[],"status":"completed"}}}`,
      ),
    );
    const adapter = adapterOver(launch);
    const answer = await adapter.aside!({ session: THREAD_ID, question: "which folder are you in?", cwd: "/root/app", model: "gpt-5.5" });
    expect(answer).toEqual({ text: "You are in /root/app; you last asked me to count.", usage: { input: 900, cached: 880, output: 12, reasoning: 0, context: 912 } });
    const call = launch.calls[0]!;
    expect(call.command).toBe("cd '/root/app' && codex app-server -c tools.update_plan.enabled='true'");
    // A side question is no turn of the account's: it asks neither the account nor its limits.
    expect(call.input?.map(l => parse(l).method)).toEqual(["initialize", "initialized", "thread/fork"]);
    const fork = parse(call.input!.at(-1)!);
    expect(fork.method).toBe("thread/fork");
    expect(fork.params).toMatchObject({ threadId: THREAD_ID, ephemeral: true, sandbox: "read-only", approvalPolicy: "never", model: "gpt-5.5" });
    expect(String((fork.params as Json).developerInstructions)).toContain("Run nothing");
    const turn = launch.wires[0]!.written.find(m => m.method === "turn/start")!;
    expect(turn.params).toEqual({ threadId: FORK, input: [{ type: "text", text: "which folder are you in?" }] });
    expect(launch.wires[0]!.closed).toBe(true);
  });

  it("refuses every approval the fork asks for, so a side question never runs anything", async () => {
    const launch = forking(self =>
      self.push(
        `{"id":3,"method":"item/commandExecution/requestApproval","params":{"threadId":"${FORK}","turnId":"t1","itemId":"c1","command":"ls","startedAtMs":1}}`,
        `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"I would rather not run that."},"threadId":"${FORK}","turnId":"t1"}}`,
        `{"method":"turn/completed","params":{"threadId":"${FORK}","turn":{"id":"t1","items":[],"status":"completed"}}}`,
      ),
    );
    const answer = await adapterOver(launch).aside!({ session: THREAD_ID, question: "list the files" });
    expect(answer.text).toBe("I would rather not run that.");
    expect(launch.wires[0]!.written.find(m => m.id === 3)).toEqual({ id: 3, result: { decision: "decline" } });
  });

  it("ends a fork that answers nothing for the whole wall with its tree, and says so", async () => {
    const launch = forking(() => {}, { hang: true });
    const adapter = createCodexAdapter({ exec: launch.factory, home: "/root/.codex", login: LOGIN, asideWallMs: 20, interruptGraceMs: 10 });
    await expect(adapter.aside({ session: THREAD_ID, question: "still there?" })).rejects.toThrow(asideWallLine(20));
    expect(launch.wires[0]!.order).toEqual(["teardown", "kill"]);
  });

  it("a turn is held to no wall of the side question's", async () => {
    const launch = launcher(scripted([], { hang: true }));
    const session = createCodexAdapter({ exec: launch.factory, home: "/root/.codex", login: LOGIN, asideWallMs: 20, interruptGraceMs: 10 }).start({ prompt: "x", onEvent: () => {} });
    await new Promise(r => setTimeout(r, 60));
    expect(launch.wires[0]!.order).toEqual([]);
    await session.interrupt();
  });

  it("rejects in the server's words when the fork fails, and in the sign-in line when it failed for want of one", async () => {
    const refused = launcher(seed => {
      const w = wire({ onWrite: (m, self) => void (m.method === "thread/fork" && self.push('{"error":{"code":-32600,"message":"no rollout found for thread id"},"id":"wsp-thread"}')) });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    await expect(adapterOver(refused).aside!({ session: THREAD_ID, question: "x" })).rejects.toThrow("codex could not open the thread: no rollout found for thread id");
    const unsigned = forking(self => self.push(`{"method":"turn/completed","params":{"threadId":"${FORK}","turn":{"id":"t1","items":[],"status":"failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}}}`));
    await expect(adapterOver(unsigned).aside!({ session: THREAD_ID, question: "x" })).rejects.toThrow(NOT_SIGNED_IN);
  });
});

describe("what a rewind needs of a Codex turn", () => {
  it("names the turn by the id the server gave it at turn/started, once", async () => {
    const launch = launcher(scripted([agentMessage("msg_1", "done"), completed("completed")]));
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "x", onEvent }).finished;
    expect(events.filter(e => e.type === "turn.anchor")).toEqual([{ type: "turn.anchor", sessionId: THREAD_ID, anchor: TURN_ID }]);
  });

  it("on a thread an older Codex made, names each turn's anchor with why its history cannot be cut", async () => {
    const legacy = server([opened()[0]!, opened()[1]!.replace('"turns":[]', '"turns":[],"historyMode":"legacy"'), turnStarted, agentMessage("msg_1", "done"), completed("completed")]);
    const { events, onEvent } = collect();
    await adapterOver(launcher(legacy)).start({ prompt: "x", resume: THREAD_ID, onEvent }).finished;
    expect(events.filter(e => e.type === "turn.anchor")).toEqual([{ type: "turn.anchor", sessionId: THREAD_ID, anchor: TURN_ID, kept: CODEX_LEGACY_HISTORY }]);
  });

  it("reads the history mode off this thread's own announcement alone, never a later thread's", async () => {
    const other = `{"method":"thread/started","params":{"thread":{"id":"01a0e2c1-0000-7000-8000-00000000c41d","historyMode":"legacy"}}}`;
    const { events, onEvent } = collect();
    await adapterOver(launcher(server([...opened(), other, turnStarted, agentMessage("msg_1", "done"), completed("completed")]))).start({ prompt: "x", onEvent }).finished;
    expect(events.filter(e => e.type === "turn.anchor")).toEqual([{ type: "turn.anchor", sessionId: THREAD_ID, anchor: TURN_ID }]);
  });

  it("cuts the thread's history before a turn on its own short server run, resuming the thread and asking thread/revert", async () => {
    const launch = launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          if (message.method === "thread/resume") self.push('{"id":"wsp-initialize","result":{}}', `{"id":"wsp-thread","result":{"thread":{"id":"${THREAD_ID}"},"model":"gpt-5.6-sol"}}`);
          if (message.method === "thread/revert") self.push(`{"id":"wsp-revert","result":{"thread":{"id":"${THREAD_ID}","turns":[]}}}`);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
    expect(await adapterOver(launch).revert({ session: THREAD_ID, beforeTurn: TURN_ID, cwd: "/root/app" })).toBeUndefined();
    expect(launch.calls[0]!.command).toBe("cd '/root/app' && codex app-server -c tools.update_plan.enabled='true'");
    expect(parse(launch.calls[0]!.input!.at(-1)!)).toMatchObject({ method: "thread/resume", params: { threadId: THREAD_ID } });
    expect(launch.wires[0]!.written.find(m => m.method === "thread/revert")).toEqual({ id: "wsp-revert", method: "thread/revert", params: { threadId: THREAD_ID, beforeTurnId: TURN_ID } });
    expect(launch.wires[0]!.written.some(m => m.method === "turn/start")).toBe(false);
    expect(launch.wires[0]!.closed).toBe(true);
  });

  /** A server whose thread answers in the history mode given, with its turns newest first in pages of the size
   * given, and the answer to thread/revert given. */
  const history = (o: { mode?: string; turns?: string[]; pageSize?: number; repeatCursor?: boolean; revert?: string }) =>
    launcher(seed => {
      const w = wire({
        onWrite: (message, self) => {
          const params = message.params as Json;
          if (message.method === "thread/resume")
            self.push(`{"id":"wsp-thread","result":{"thread":{"id":"${THREAD_ID}"${o.mode !== undefined ? `,"historyMode":"${o.mode}"` : ""},"turns":[]},"model":"gpt-5.6-sol"}}`);
          if (message.method === "thread/turns/list") {
            const from = params.cursor === null ? 0 : Number(params.cursor);
            const size = Math.min(Number(params.limit), o.pageSize ?? 100);
            const data = (o.turns ?? []).slice(from, from + size).map(id => ({ id, items: [], itemsView: "summary", status: "completed" }));
            const next = o.repeatCursor === true ? "0" : from + size < (o.turns ?? []).length ? String(from + size) : null;
            self.push(JSON.stringify({ id: message.id, result: { data, nextCursor: next, backwardsCursor: null } }));
          }
          if (message.method === "thread/revert") self.push(o.revert ?? `{"id":"wsp-revert","result":{"thread":{"id":"${THREAD_ID}","turns":[]}}}`);
        },
      });
      for (const line of seed) void w.stream.write(line);
      return w;
    });
  const listed = (launch: Launch) => launch.wires[0]!.written.filter(m => m.method === "thread/turns/list").map(m => m.params);
  const done = (text: string): { result: TurnResult } => ({ result: { status: "completed", text } });
  const NEWEST_FIRST = ["t9", "t8", "t7", "t6", "t5"];

  it("rejects in the server's words when it will not cut, so the rewind is refused whole", async () => {
    const launch = history({ mode: "paginated", revert: `{"error":{"code":-32603,"message":"timed out shutting down thread ${THREAD_ID} before revert"},"id":"wsp-revert"}` });
    await expect(adapterOver(launch).revert({ session: THREAD_ID, beforeTurn: TURN_ID })).rejects.toThrow(`codex would not cut the thread: timed out shutting down thread ${THREAD_ID} before revert`);
  });

  it("without the turn's id finds the boundary by count in the thread's turns, newest first across pages", async () => {
    const launch = history({ mode: "paginated", turns: NEWEST_FIRST, pageSize: 2 });
    expect(await adapterOver(launch).revert({ session: THREAD_ID, turns: [done("a"), done("b"), done("c")] })).toBeUndefined();
    expect(listed(launch)).toEqual([
      { threadId: THREAD_ID, cursor: null, limit: 3, sortDirection: "desc", itemsView: "summary" },
      { threadId: THREAD_ID, cursor: "2", limit: 1, sortDirection: "desc", itemsView: "summary" },
    ]);
    expect(launch.wires[0]!.written.find(m => m.method === "thread/revert")!.params).toEqual({ threadId: THREAD_ID, beforeTurnId: "t7" });
  });

  it("counts only the cut turns the server opened: not one refused for a sign-in, nor one the adapter failed before the server took it", async () => {
    const launch = history({ mode: "paginated", turns: NEWEST_FIRST });
    const refused: TurnResult = { status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" };
    const unopened: TurnResult = { status: "failed", error: "codex could not open the thread: no rollout found for thread id 01a0" };
    await adapterOver(launch).revert({ session: THREAD_ID, turns: [{ result: refused }, done("a"), { result: unopened }, {}, { result: { status: "interrupted" } }] });
    expect(listed(launch).map(p => (p as Json).limit)).toEqual([3]);
    expect(launch.wires[0]!.written.find(m => m.method === "thread/revert")!.params).toEqual({ threadId: THREAD_ID, beforeTurnId: "t7" });
  });

  it("counts a cut turn that kept the server's own id as opened, whatever its result says", async () => {
    const launch = history({ mode: "paginated", turns: NEWEST_FIRST });
    const refused: TurnResult = { status: "failed", error: NOT_SIGNED_IN, refusal: "sign-in" };
    await adapterOver(launch).revert({ session: THREAD_ID, turns: [{ result: refused }, { anchor: "t8", result: refused }, done("a")] });
    expect(listed(launch).map(p => (p as Json).limit)).toEqual([2]);
    expect(launch.wires[0]!.written.find(m => m.method === "thread/revert")!.params).toEqual({ threadId: THREAD_ID, beforeTurnId: "t8" });
  });

  it("refuses when the server lists fewer turns than the rewind would cut, and cuts nothing", async () => {
    const launch = history({ mode: "paginated", turns: ["t2", "t1"], pageSize: 1 });
    await expect(adapterOver(launch).revert({ session: THREAD_ID, turns: [done("a"), done("b"), done("c")] })).rejects.toThrow(CODEX_FEWER_TURNS);
    expect(listed(launch).map(p => (p as Json).limit)).toEqual([3, 2]);
    expect(launch.wires[0]!.written.some(m => m.method === "thread/revert")).toBe(false);
  });

  it("refuses a server that hands back a page it already gave, before asking any cut", async () => {
    const launch = history({ mode: "paginated", turns: NEWEST_FIRST, pageSize: 1, repeatCursor: true });
    await expect(adapterOver(launch).revert({ session: THREAD_ID, turns: [done("a"), done("b"), done("c")] })).rejects.toThrow("codex could not list the thread's turns: it handed back a page it already gave");
    expect(launch.wires[0]!.written.some(m => m.method === "thread/revert")).toBe(false);
  });

  it("a thread an older Codex made answers kept, by its history mode before any request and by the server's own refusal after one", async () => {
    const legacy = history({ mode: "legacy", turns: NEWEST_FIRST });
    expect(await adapterOver(legacy).revert({ session: THREAD_ID, beforeTurn: TURN_ID })).toEqual({ kept: CODEX_LEGACY_HISTORY });
    expect(legacy.wires[0]!.written.some(m => m.method === "thread/revert" || m.method === "thread/turns/list")).toBe(false);
    expect(legacy.wires[0]!.closed).toBe(true);

    const unsaid = history({ turns: NEWEST_FIRST, revert: '{"error":{"code":-32600,"message":"thread/revert only supports paginated threads"},"id":"wsp-revert"}' });
    expect(await adapterOver(unsaid).revert({ session: THREAD_ID, turns: [done("a")] })).toEqual({ kept: CODEX_LEGACY_HISTORY });
  });
});

describe("a Codex account's plan limits on the app server", () => {
  // Shapes from `codex app-server generate-ts` on codex-cli 0.157.1: GetAccountResponse, GetAccountRateLimitsResponse,
  // AccountRateLimitsUpdatedNotification.
  const account = (value: Json | null) => JSON.stringify({ id: "wsp-account", result: { account: value, requiresOpenaiAuth: true } });
  const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({ usedPercent, windowDurationMins, resetsAt });
  const snapshot = (o: { primary?: Json | null; secondary?: Json | null; planType?: string | null; reached?: string | null }) => ({
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: o.primary ?? null,
    secondary: o.secondary ?? null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: o.planType ?? null,
    rateLimitReachedType: o.reached ?? null,
  });
  const rateLimits = (s: Json, accountId: string | null = "acct_7f3a") =>
    JSON.stringify({ id: "wsp-rate-limits", result: { ordinaryUsageAllowed: true, rateLimits: s, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId, rateLimitUpsell: null } });
  const updated = (s: Json) => JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: s } });
  const limitsOf = (events: AdapterEvent[]) => events.flatMap(e => (e.type === "limit" ? [e.limit] : []));

  it("asks the account and its limits once as the turn opens, and reads the windows by their length with the plan and the account", async () => {
    const launch = launcher(
      scripted([
        account({ type: "chatgpt", email: "dev@example.com", planType: "plus" }),
        rateLimits(snapshot({ primary: window(34.5, 300, 1_790_700_000), secondary: window(12, 10_080, 1_791_200_000), planType: "plus" })),
        agentMessage("m1", "done"),
        completed("completed"),
      ]),
    );
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    const seed = (launch.calls[0]!.input ?? []).map(line => (JSON.parse(line) as Json).method);
    expect(seed).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read", "thread/start"]);
    expect(limitsOf(events)).toEqual([
      {
        windows: [
          { kind: "session", usedPercent: 34.5, resetsAt: 1_790_700_000_000 },
          { kind: "week", usedPercent: 12, resetsAt: 1_791_200_000_000 },
        ],
        plan: "plus",
        status: "ok",
        account: { id: "acct_7f3a", label: "dev@example.com" },
      },
    ]);
  });

  it("merges a rolling update into the last reading, a window it leaves out kept and a reached limit said", async () => {
    const launch = launcher(
      scripted([
        account({ type: "chatgpt", email: "dev@example.com", planType: "plus" }),
        rateLimits(snapshot({ primary: window(34.5, 300, 1_790_700_000), secondary: window(12, 10_080, 1_791_200_000), planType: "plus" })),
        updated(snapshot({ primary: window(100, 300, 1_790_700_000), reached: "rate_limit_reached" })),
        completed("completed"),
      ]),
    );
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(limitsOf(events).at(-1)).toEqual({
      windows: [
        { kind: "session", usedPercent: 100, resetsAt: 1_790_700_000_000 },
        { kind: "week", usedPercent: 12, resetsAt: 1_791_200_000_000 },
      ],
      plan: "plus",
      status: "reached",
      account: { id: "acct_7f3a", label: "dev@example.com" },
    });
  });

  it("reads a window longer than a week as the month", async () => {
    const launch = launcher(scripted([rateLimits(snapshot({ primary: window(5, 43_200, 1_792_000_000) }), null), completed("completed")]));
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(limitsOf(events)).toEqual([{ windows: [{ kind: "month", usedPercent: 5, resetsAt: 1_792_000_000_000 }], status: "ok" }]);
  });

  it("says a sign-in by API key has no plan window", async () => {
    const launch = launcher(scripted([account({ type: "apiKey" }), completed("completed")]));
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(limitsOf(events)).toEqual([{ windows: [], keyed: true }]);
  });

  const banked = (credits: Json | null) => ({ availableCount: 2, credits });
  const read = (s: Json, extra: Json) => JSON.stringify({ id: "wsp-rate-limits", result: { ordinaryUsageAllowed: true, rateLimits: s, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: "acct_7f3a", rateLimitUpsell: null, ...extra } });

  it("asks for each banked reset in full on a turn the runtime says is due for it, and for the count alone otherwise", async () => {
    const paramsOf = async (limitDetails?: boolean) => {
      const launch = launcher(scripted([completed("completed")]));
      await adapterOver(launch).start({ prompt: "hi", onEvent: () => {}, ...(limitDetails !== undefined ? { limitDetails } : {}) }).finished;
      return (launch.calls[0]!.input ?? []).map(line => JSON.parse(line) as Json).find(m => m.method === "account/rateLimits/read")?.params;
    };
    expect(await paramsOf(true)).toEqual({});
    expect(await paramsOf()).toEqual({ excludeResetCreditDetails: true });
  });

  it("reads how many resets the plan has banked off the turn's read, where the details were left out", async () => {
    const launch = launcher(scripted([read(snapshot({ primary: window(34.5, 300, 1_790_700_000) }), { rateLimitResetCredits: banked(null) }), completed("completed")]));
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(limitsOf(events).map(l => l.credits)).toEqual([{ count: 2 }]);
  });

  it("keeps the banked resets off a rolling update, which never carries them, so the last read stands", async () => {
    const launch = launcher(
      scripted([read(snapshot({ primary: window(34.5, 300, 1_790_700_000) }), { rateLimitResetCredits: banked(null) }), updated(snapshot({ primary: window(40, 300, 1_790_700_000) })), completed("completed")]),
    );
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(limitsOf(events).map(l => "credits" in l)).toEqual([true, false]);
  });

  it("reads the windows off the codex bucket where the answer names buckets, and merges no update for another bucket", async () => {
    const other = { ...snapshot({ primary: window(90, 300, 1_790_700_000) }), limitId: "codex_other" };
    const launch = launcher(
      scripted([
        read(snapshot({ primary: window(70, 300, 1_790_700_000) }), { rateLimitsByLimitId: { codex: snapshot({ primary: window(10, 300, 1_790_700_000) }), codex_other: other } }),
        updated(other),
        completed("completed"),
      ]),
    );
    const { events, onEvent } = collect();
    await adapterOver(launch).start({ prompt: "hi", onEvent }).finished;
    expect(limitsOf(events).map(l => l.windows.map(w => w.usedPercent))).toEqual([[10]]);
  });
});

describe("creditsOf", () => {
  const credit = (o: Json = {}) => ({ id: "rc_1", resetType: "codexRateLimits", status: "available", grantedAt: 1_790_000_000, expiresAt: 1_792_000_000, title: null, description: null, ...o });

  it("reads nothing where the answer has no reset field, as a codex older than resets answers", () => {
    expect(creditsOf({ rateLimits: {} })).toBeUndefined();
    expect(creditsOf({ rateLimitResetCredits: null })).toBeUndefined();
  });

  it("reads the count alone where the details are null or not a list", () => {
    expect(creditsOf({ rateLimitResetCredits: { availableCount: 2, credits: null } })).toEqual({ count: 2 });
    expect(creditsOf({ rateLimitResetCredits: { availableCount: 2, credits: "two" } })).toEqual({ count: 2 });
  });

  it("reads each credit's id, status and expiry, seconds made ms, and an empty list as details read with none left", () => {
    expect(creditsOf({ rateLimitResetCredits: { availableCount: 2, credits: [credit(), credit({ id: "rc_2", expiresAt: null })] } })).toEqual({
      count: 2,
      credits: [
        { id: "rc_1", status: "available", expiresAt: 1_792_000_000_000 },
        { id: "rc_2", status: "available" },
      ],
    });
    expect(creditsOf({ rateLimitResetCredits: { availableCount: 0, credits: [] } })).toEqual({ count: 0, credits: [] });
  });

  it("fails closed: a count that is not a whole number at or above zero reads the whole field absent", () => {
    for (const availableCount of [1.5, -1, "2", null, Number.NaN]) expect(creditsOf({ rateLimitResetCredits: { availableCount, credits: [credit()] } }), String(availableCount)).toBeUndefined();
  });

  it("never reads a credit of another kind, or one in a state it does not know, as available, and skips one with no id", () => {
    const read = creditsOf({ rateLimitResetCredits: { availableCount: 3, credits: [credit({ resetType: "unknown" }), credit({ id: "rc_2", status: "pending" }), credit({ id: undefined }), credit({ id: "rc_4", status: "redeeming" })] } });
    expect(read?.credits?.map(c => [c.id, c.status])).toEqual([
      ["rc_1", "unknown"],
      ["rc_2", "unknown"],
      ["rc_4", "redeeming"],
    ]);
  });
});
