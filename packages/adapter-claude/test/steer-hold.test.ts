// SPDX-License-Identifier: AGPL-3.0-only
// A message steered into a Claude turn while its agent writes its last words. The CLI reads it only after its result,
// as a turn of its own, and says so: a CLI that declares msg_lifecycle_v1 at init reports every message written with
// a uuid queued, started and completed or cancelled under that uuid. The lines below were recorded off Claude Code
// 2.1.280 on 2026-10-08 (haiku, a 250-word story with a line steered 2.5 s in), trimmed to the fields the adapter
// reads, with the steers' uuids put in where the CLI printed them.
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { userMessageLine } from "../src/landmines.js";

const SID = "e16ed170-8257-4668-879e-fe836341633c";
const LINE = "thread 1234abcd finished (completed): reply with the single word BANANA";
const PARSER = "thread aaaa1111 finished (completed): built the parser.";
const PRINTER = "thread bbbb2222 finished (completed): built the printer.";

const initDeclaring = (capabilities: readonly string[]): string =>
  JSON.stringify({ type: "system", subtype: "init", cwd: "/work", session_id: SID, tools: ["Bash"], model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions", claude_code_version: "2.1.280", capabilities });
const init = initDeclaring(["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1", "mcp_read_resource_v1", "mcp_tool_ui_meta_v1"]);
/** A CLI that reports its messages and cannot be asked to cancel the ones it queues. */
const initNoCancel = initDeclaring(["interrupt_receipt_v1", "msg_lifecycle_v1"]);
const said = (id: string, text: string): string =>
  JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", id, type: "message", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 300 } }, parent_tool_use_id: null, session_id: SID });
const result = (text: string, ms: number, cost: number): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: ms, result: text, stop_reason: "end_turn", session_id: SID, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 300 } });
/** The result the CLI prints for a turn the interrupt stopped. */
const stopped = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", duration_ms: 812, stop_reason: null, session_id: SID, total_cost_usd: 0.0127 });
const lifecycle = (uuid: string, state: string): string => JSON.stringify({ type: "command_lifecycle", command_uuid: uuid, state, uuid: "0b7f3a52-6c1d-4e8a-9f2b-3d4c5e6f7a8b", session_id: SID });
const STORY = "# The Lighthouse Keeper's Last Watch\n\nOld Thomas had tended the lighthouse for forty-three years.";

/** A stream the test feeds by hand, its writes recorded; `taken` stands for the lines an attach's run channel holds. */
function manualExec(opts: { taken?: string[] } = {}) {
  const writes: string[] = [];
  const order: string[] = [];
  const inputs: (readonly string[] | undefined)[] = [];
  let push: (line: string) => void = () => {};
  let end: (code: number | null) => void = () => {};
  const open = (): ExecStream => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const exited = new Promise<number | null>(resolve => {
      end = code => {
        ended = true;
        resolve(code);
        wake?.();
      };
    });
    push = line => {
      queue.push(line);
      wake?.();
    };
    const lines = (async function* () {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>(resolve => (wake = resolve));
        wake = null;
      }
    })();
    return {
      lines,
      exited,
      run: "/tmp/wsp-run/ab12",
      teardown: () => {
        order.push("teardown");
        end(143);
      },
      kill: () => {
        order.push("kill");
        end(null);
      },
      write: async line => {
        order.push("write");
        writes.push(line);
        return "written";
      },
      closeInput: () => order.push("closeInput"),
      ...(opts.taken !== undefined ? { taken: opts.taken } : {}),
    };
  };
  const factory: ExecStreamFactory = Object.assign(
    (_command: string, o: { input?: readonly string[] }) => {
      inputs.push(o.input);
      return open();
    },
    { attach: async () => open() },
  ) as ExecStreamFactory;
  /** The uuid the nth steer line went out under. */
  const steered = (n = 0): string => (JSON.parse(writes.filter(line => JSON.parse(line).type === "user")[n]!) as { uuid: string }).uuid;
  return { factory, writes, order, inputs, steered, push: (...lines: string[]) => lines.forEach(line => push(line)), end: (code: number | null) => end(code) };
}

function collect() {
  const events: AdapterEvent[] = [];
  const done = () => events.filter(e => e.type === "turn.done");
  return { events, done, onEvent: (e: AdapterEvent) => void events.push(e) };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 2));
  if (!check()) throw new Error("condition never held");
}

const settle = () => new Promise(r => setTimeout(r, 60));

describe("a message steered while the agent writes its last words", () => {
  it("is answered in the same turn, which ends the moment the CLI completes it and not at the first reply", async () => {
    const exec = manualExec();
    // The silence window is far past the test, so only the CLI's own word on the message can end the turn.
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "Write a 250-word story about a lighthouse.", onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    expect(await session.steer(LINE)).toBe("accepted");
    const uuid = exec.steered();
    exec.push(lifecycle(uuid, "queued"), said("msg_1", STORY), result(STORY, 5164, 0.01280775), lifecycle(uuid, "started"), init, said("msg_2", "BANANA"), result("BANANA", 3700, 0.0170532));
    await settle();
    expect(done()).toEqual([]);
    expect(exec.order).toEqual(["write"]);

    exec.push(lifecycle(uuid, "completed"));
    await until(() => done().length === 1);
    expect(exec.order).toEqual(["write", "closeInput"]);
    exec.end(0);
    const answer = await session.finished;
    expect(answer).toMatchObject({ status: "completed", text: "BANANA" });
    expect(answer.costUsd).toBeCloseTo(0.0170532);
    expect(done()).toHaveLength(1);
    expect(events.some(e => e.type === "turn.unread")).toBe(false);
    // A reply held for a steered message alone is told nowhere early, so the turn's end is its one line.
    expect(events.some(e => e.type === "turn.tasks" && e.replied !== undefined)).toBe(false);
    expect(done()[0]).not.toHaveProperty("held");
  });

  it("two messages at once, which the CLI takes as one turn, are both answered before the turn ends", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "Write a 250-word story about a lighthouse.", onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await Promise.all([session.steer(PARSER), session.steer(PRINTER)]);
    const [parser, printer] = [exec.steered(0), exec.steered(1)];
    exec.push(
      lifecycle(parser, "queued"),
      lifecycle(printer, "queued"),
      said("msg_1", STORY),
      result(STORY, 5503, 0.012894),
      lifecycle(parser, "started"),
      lifecycle(printer, "started"),
      init,
      said("msg_2", "Thanks for the update! Both the parser and printer are built."),
      result("Thanks for the update! Both the parser and printer are built.", 2986, 0.01694495),
      lifecycle(parser, "completed"),
    );
    await settle();
    expect(done()).toEqual([]);

    exec.push(lifecycle(printer, "completed"));
    await until(() => done().length === 1);
    exec.end(0);
    expect(await session.finished).toMatchObject({ status: "completed", text: "Thanks for the update! Both the parser and printer are built." });
    expect(done()).toHaveLength(1);
  });

  it("a slash command steered then, which the CLI answers in milliseconds with no call, ends the turn on the agent's reply and not on its own words", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "Write a 250-word story about a lighthouse.", onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer("/cost");
    const uuid = exec.steered();
    const cost = "Total cost:            $0.0128\nTotal duration (API):  5s";
    exec.push(
      lifecycle(uuid, "queued"),
      said("msg_1", STORY),
      result(STORY, 5465, 0.01283775),
      lifecycle(uuid, "started"),
      init,
      JSON.stringify({ type: "assistant", message: { id: "ac793b79-283a-458a-80cc-a046634e400f", model: "<synthetic>", role: "assistant", type: "message", content: [{ type: "text", text: cost }] }, parent_tool_use_id: null, session_id: SID }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_api_ms: 0, num_turns: 0, result: cost, stop_reason: null, session_id: SID, total_cost_usd: 0.01283775 }),
      lifecycle(uuid, "completed"),
    );
    await until(() => done().length === 1);
    exec.end(0);
    // The command's words are a row of their own in the pane; the reply a lead reads is the agent's.
    expect(await session.finished).toMatchObject({ status: "completed", text: STORY });
    expect(events.some(e => e.type === "turn.delta" && e.kind === "text" && e.text === cost)).toBe(true);
    expect(done()[0]).not.toHaveProperty("held");
  });

  it("a message the agent took at a tool's end is answered by the turn's own result, which ends it", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "Run sleep 4 && echo done, then say what it printed.", onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer("Also tell me the number seven.");
    const uuid = exec.steered();
    exec.push(
      lifecycle(uuid, "queued"),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "done", is_error: false }] }, parent_tool_use_id: null, session_id: SID }),
      lifecycle(uuid, "started"),
      said("msg_2", "The command printed done. Seven."),
      result("The command printed done. Seven.", 6100, 0.02),
      lifecycle(uuid, "completed"),
    );
    await until(() => done().length === 1);
    exec.end(0);
    expect(await session.finished).toMatchObject({ status: "completed", text: "The command printed done. Seven." });
    expect(events.some(e => e.type === "turn.unread")).toBe(false);
  });

  it("on a CLI that declares no reports on its messages, the turn ends at its reply as it always has", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(initDeclaring([]));
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer(LINE);
    exec.push(result(STORY, 5164, 0.0128));
    await until(() => done().length === 1);
    expect(exec.order).toEqual(["write", "closeInput"]);
    exec.end(0);
    expect(await session.finished).toMatchObject({ status: "completed", text: STORY });
    // Nothing says it went unread: a CLI that reports nothing may have read it at any call's end.
    expect(events.some(e => e.type === "turn.unread")).toBe(false);
  });
});

// A stop that waited out the interrupt's grace, past a minute here, would run this file's cases past their timeout,
// so each stop below answering at all is the proof it answered at once.
describe("a steered message the CLI never took up", () => {
  it("is told unread before the turn's end when the process dies with it queued", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 40 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer(LINE);
    exec.push(lifecycle(exec.steered(), "queued"));
    exec.end(137);
    expect((await session.finished).status).toBe("failed");
    const told = events.filter(e => e.type === "turn.unread" || e.type === "turn.done").map(e => e.type);
    expect(told).toEqual(["turn.unread", "turn.done"]);
    expect(events.find(e => e.type === "turn.unread")).toEqual({ type: "turn.unread", sessionId: expect.any(String), ids: [exec.steered()] });
  });

  it("a stop with one still queued asks the CLI to cancel it, answers at once, tells it unread and keeps the process", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000, interruptGraceMs: 60_000 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", keep: true, onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer(LINE);
    const uuid = exec.steered();
    exec.push(lifecycle(uuid, "queued"));
    const stopping = session.interrupt();
    await until(() => exec.writes.some(line => line.includes('"interrupt"')));
    expect(JSON.parse(exec.writes.find(line => line.includes('"interrupt"'))!)).toMatchObject({ request: { subtype: "interrupt", cancel_queued: true } });
    exec.push(lifecycle(uuid, "cancelled"), JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "wsp-interrupt-1", response: { still_queued: [], cancelled: [uuid] } } }), stopped);
    await stopping;
    expect(await session.finished).toMatchObject({ status: "interrupted" });
    expect(events.find(e => e.type === "turn.unread")).toEqual({ type: "turn.unread", sessionId: expect.any(String), ids: [exec.steered()] });
    expect(exec.order).not.toContain("teardown");
    expect(session.kept?.()).toBeDefined();
  });

  it("a stop with one still queued on a CLI that cannot cancel it answers at once, tells it unread, and the process goes rather than answer it to nobody", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000, interruptGraceMs: 60_000 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", keep: true, onEvent });
    exec.push(initNoCancel);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer(LINE);
    const uuid = exec.steered();
    exec.push(lifecycle(uuid, "queued"));
    const stopping = session.interrupt();
    await until(() => exec.writes.some(line => line.includes('"interrupt"')));
    exec.push(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "wsp-interrupt-1", response: { still_queued: [uuid] } } }), stopped);
    await stopping;
    expect(await session.finished).toMatchObject({ status: "interrupted" });
    expect(events.find(e => e.type === "turn.unread")).toEqual({ type: "turn.unread", sessionId: expect.any(String), ids: [exec.steered()] });
    expect(exec.order).toContain("teardown");
    expect(session.kept?.()).toBeUndefined();
  });

  it("a stop of a reply held for a message the CLI has not taken up answers at once with the held words, the message cancelled", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000, interruptGraceMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "go", keep: true, onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer(LINE);
    const uuid = exec.steered();
    exec.push(lifecycle(uuid, "queued"), said("msg_1", STORY), result(STORY, 5164, 0.0128));
    await settle();
    expect(done()).toEqual([]);
    const stopping = session.interrupt();
    await until(() => exec.writes.some(line => line.includes('"interrupt"')));
    exec.push(lifecycle(uuid, "cancelled"), JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "wsp-interrupt-1", response: { still_queued: [], cancelled: [uuid] } } }));
    await stopping;
    expect(await session.finished).toMatchObject({ status: "interrupted", text: STORY });
    expect(events.find(e => e.type === "turn.unread")).toEqual({ type: "turn.unread", sessionId: expect.any(String), ids: [exec.steered()] });
    expect(session.kept?.()).toBeDefined();
  });

  it("the same stop on a CLI that cannot cancel answers at once with the held words, and the process goes", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000, interruptGraceMs: 60_000 });
    const { events, done, onEvent } = collect();
    const session = adapter.start({ prompt: "go", keep: true, onEvent });
    exec.push(initNoCancel);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer(LINE);
    exec.push(lifecycle(exec.steered(), "queued"), said("msg_1", STORY), result(STORY, 5164, 0.0128));
    await settle();
    expect(done()).toEqual([]);
    await session.interrupt();
    expect(await session.finished).toMatchObject({ status: "interrupted", text: STORY });
    expect(events.find(e => e.type === "turn.unread")).toEqual({ type: "turn.unread", sessionId: expect.any(String), ids: [exec.steered()] });
    expect(exec.order).toContain("teardown");
  });

  it("a stop while the CLI answers a steered message answers at once and keeps the process, since nothing is left queued", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000, interruptGraceMs: 60_000 });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", keep: true, onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer("Now write a 300-word poem about the sea.");
    const uuid = exec.steered();
    exec.push(lifecycle(uuid, "queued"), said("msg_1", STORY), result(STORY, 5374, 0.0127), lifecycle(uuid, "started"), init);
    await settle();
    const stopping = session.interrupt();
    await until(() => exec.writes.some(line => line.includes('"interrupt"')));
    exec.push(said("msg_2", "# The Sea's Language"), stopped, lifecycle(uuid, "cancelled"));
    await stopping;
    // The stopped answer's result says nothing, so the words the agent gave before it are the turn's.
    expect(await session.finished).toMatchObject({ status: "interrupted", text: STORY });
    expect(events.some(e => e.type === "turn.unread")).toBe(false);
    expect(exec.order).not.toContain("teardown");
    expect(session.kept?.()).toBeDefined();
  });
});

describe("a turn re-opened after a host restart while its reply waits on a steered message", () => {
  it("waits on the messages its run's channel took after the turn's opening, and is answered in the same turn", async () => {
    const earlier = userMessageLine("an earlier turn's steer", SID, [], "11111111-1111-4111-8111-111111111111");
    const uuid = "33333333-3333-4333-8333-333333333333";
    const exec = manualExec({ taken: [userMessageLine("first", SID), earlier, userMessageLine("Write a story.", SID), userMessageLine(LINE, SID, [], uuid)] });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 });
    const { done, onEvent } = collect();
    const session = await adapter.attach!({ run: "/tmp/wsp-run/ab12", sessionId: SID, startedAt: 1, onEvent });
    if (session === "gone") throw new Error("gone");
    // The log replayed from its first byte: the reply the first host was holding, and the CLI starting on the line.
    exec.push(init, lifecycle(uuid, "queued"), said("msg_1", STORY), result(STORY, 5164, 0.0128), lifecycle(uuid, "started"), init);
    await settle();
    expect(done()).toEqual([]);
    expect(exec.order).toEqual([]);

    exec.push(said("msg_2", "BANANA"), result("BANANA", 3700, 0.017), lifecycle(uuid, "completed"));
    await until(() => done().length === 1);
    exec.end(0);
    expect(await session.finished).toMatchObject({ status: "completed", text: "BANANA" });
  });

  it("tells unread a message its run's channel took that the CLI never queued, when the process is gone", async () => {
    const exec = manualExec({ taken: [userMessageLine("Write a story.", SID), userMessageLine(LINE, SID, [], "33333333-3333-4333-8333-333333333333")] });
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg", resultExitMs: 40 });
    const { events, onEvent } = collect();
    const session = await adapter.attach!({ run: "/tmp/wsp-run/ab12", sessionId: SID, startedAt: 1, onEvent });
    if (session === "gone") throw new Error("gone");
    // The CLI printed nothing about the message, so only what its init declares says it never read it.
    exec.push(init, said("msg_1", STORY), result(STORY, 5164, 0.0128));
    exec.end(143);
    await session.finished;
    expect(events.find(e => e.type === "turn.unread")).toEqual({ type: "turn.unread", sessionId: expect.any(String), ids: ["33333333-3333-4333-8333-333333333333"] });
  });
});

describe("what tells the CLI which message is which", () => {
  it("every steer goes out under a uuid of its own, which the turn's opening line does not carry", async () => {
    const exec = manualExec();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/root/.claude-cfg" });
    const { events, onEvent } = collect();
    const session = adapter.start({ prompt: "go", onEvent });
    exec.push(init);
    await until(() => events.some(e => e.type === "session.start"));
    await session.steer("one");
    await session.steer("two");
    const [one, two] = [exec.steered(0), exec.steered(1)];
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(two).not.toBe(one);
    expect(exec.writes).toEqual([userMessageLine("one", SID, [], one), userMessageLine("two", SID, [], two)]);
    // The runtime names the id, which the turn's unread messages are told by.
    await session.steer("three", "a7d1c2e3-0000-4000-8000-000000000003");
    expect(exec.steered(2)).toBe("a7d1c2e3-0000-4000-8000-000000000003");
    expect(JSON.parse(exec.inputs[0]![0]!)).not.toHaveProperty("uuid");
    exec.end(0);
    await session.finished;
  });
});
