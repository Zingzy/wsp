// SPDX-License-Identifier: AGPL-3.0-only
// A turn that raises a permission prompt, on a stream the test drives line by
// line: the prompt reaches the caller as an event, the answer goes back down
// the same stdin channel the CLI reads, the row closes once and only once, and
// a prompt whose process dies with it closes as cancelled rather than waiting.
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { PERMISSION_ALLOW, PERMISSION_DENY } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";

const SESSION = "6bb3cdb1-97af-4ad0-96ff-35160ba2bd0b";
const ASK = "d9aa99d3-be4e-4a2b-8766-1b9494cde4f6";

const initLine = JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "claude-sonnet-5", cwd: "/root", permissionMode: "default" });
const askLine = JSON.stringify({
  type: "control_request",
  request_id: ASK,
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    input: { file_path: "/root/out.txt", content: "hi" },
    description: "out.txt",
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    tool_use_id: "toolu_1",
  },
});
const resultLine = JSON.stringify({ type: "result", subtype: "success", session_id: SESSION, result: "Done.", usage: { output_tokens: 3 }, total_cost_usd: 0.01 });

/** A stream the test feeds: `push` sends the CLI's next line, `end` exits the process, and `stdin` is every line the
 * adapter wrote back, which is where an answer to a prompt has to land. */
function driven(): { factory: ExecStreamFactory; push: (line: string) => void; end: (code?: number) => void; stdin: string[]; gone: () => void } {
  const stdin: string[] = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let writable = true;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>(resolve => {
    resolveExit = resolve;
  });
  const factory: ExecStreamFactory = (_command, { input }) => {
    // The launch seeds the channel with its user message, as the real factory does; the answer follows it.
    for (const line of input ?? []) stdin.push(line);
    const stream: ExecStream = {
      lines: (async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      })(),
      teardown: () => {},
      kill: () => {},
      write: async line => {
        if (!writable) return "gone";
        stdin.push(line);
        return "written";
      },
      closeInput: () => {},
      exited,
    };
    return stream;
  };
  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    factory,
    stdin,
    push: line => {
      queue.push(line);
      nudge();
    },
    end: (code = 0) => {
      done = true;
      resolveExit(code);
      nudge();
    },
    gone: () => {
      writable = false;
    },
  };
}

function start(): { events: AdapterEvent[]; session: ReturnType<ReturnType<typeof createClaudeAdapter>["start"]>; io: ReturnType<typeof driven> } {
  const io = driven();
  const adapter = createClaudeAdapter({ exec: io.factory, configDir: "/root/.claude-cfg" });
  const events: AdapterEvent[] = [];
  const session = adapter.start({ prompt: "write it", permissionMode: "default", onEvent: e => events.push(e) });
  return { events, session, io };
}

/** Waits for the adapter's reader to drain what it was fed; the stream is a generator, so one tick per line. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

const asks = (events: readonly AdapterEvent[]) => events.filter(e => e.type === "permission.ask");
const closes = (events: readonly AdapterEvent[]) => events.filter(e => e.type === "permission.close");

describe("a turn that raises a permission prompt", () => {
  it("relays the prompt, writes the answer down the CLI's own channel and closes the row once", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();

    const ask = asks(events);
    expect(ask).toHaveLength(1);
    expect(ask[0]).toMatchObject({ type: "permission.ask", sessionId: SESSION, ask: { askId: ASK, toolName: "Write", detail: "out.txt", toolUseId: "toolu_1" } });
    expect(closes(events)).toHaveLength(0);
    // The launch's own user message is the first line on the channel; the answer is what follows it.
    expect(io.stdin).toHaveLength(1);

    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("answered");
    expect(JSON.parse(io.stdin[1]!)).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: ASK, response: { behavior: "allow" } } });
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "allowed", optionId: PERMISSION_ALLOW }]);

    // A second answer has nothing to answer: the row is closed and the CLI would ignore the line.
    expect(await session.answer(ASK, { optionId: PERMISSION_DENY, outcome: "denied", denyMessage: "no" })).toBe("gone");
    expect(io.stdin).toHaveLength(2);
    expect(closes(events)).toHaveLength(1);

    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a deny carries the words the agent reads as the call's result", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(await session.answer(ASK, { optionId: PERMISSION_DENY, outcome: "denied", denyMessage: "the person denied this in the chat" })).toBe("answered");
    expect(JSON.parse(io.stdin[1]!).response.response).toEqual({ behavior: "deny", message: "the person denied this in the chat" });
    expect(closes(events)[0]).toMatchObject({ outcome: "denied", optionId: PERMISSION_DENY });
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("the runtime's own answer for a prompt nobody came to closes the row as unanswered", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(await session.answer(ASK, { optionId: PERMISSION_DENY, outcome: "unanswered", denyMessage: "nobody answered" })).toBe("answered");
    expect(closes(events)[0]).toMatchObject({ outcome: "unanswered", optionId: PERMISSION_DENY });
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a prompt the CLI withdraws closes as cancelled, and answering it afterwards answers nothing", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    io.push(JSON.stringify({ type: "control_cancel_request", request_id: ASK }));
    await settle();
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "cancelled" }]);
    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("gone");
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a prompt whose process ends under it closes as cancelled rather than waiting for an answer", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    expect(closes(events)).toHaveLength(0);
    io.gone();
    io.end(null as unknown as number);
    await session.finished.catch(() => {});
    expect(closes(events)).toEqual([{ type: "permission.close", sessionId: SESSION, askId: ASK, outcome: "cancelled" }]);
    expect(await session.answer(ASK, { optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: "unused" })).toBe("gone");
  });

  it("refuses an option the prompt never offered without writing anything to the CLI", async () => {
    const { session, io } = start();
    io.push(initLine);
    io.push(askLine);
    await settle();
    await expect(session.answer(ASK, { optionId: "mode:bypassPermissions", outcome: "allowed", denyMessage: "unused" })).rejects.toThrow(/not an option/);
    expect(io.stdin).toHaveLength(1);
    io.push(resultLine);
    io.end();
    await session.finished;
  });

  it("a control request of another subtype is refused down the channel, so the CLI stops waiting on it", async () => {
    const { events, session, io } = start();
    io.push(initLine);
    io.push(JSON.stringify({ type: "control_request", request_id: "req_h", request: { subtype: "hook_callback" } }));
    await settle();
    expect(asks(events)).toHaveLength(0);
    expect(JSON.parse(io.stdin[1]!)).toEqual({ type: "control_response", response: { subtype: "error", request_id: "req_h", error: "wsp answers no hook_callback control request" } });
    io.push(resultLine);
    io.end();
    await session.finished;
  });
});
