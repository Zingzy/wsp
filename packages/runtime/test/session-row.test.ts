// SPDX-License-Identifier: AGPL-3.0-only
// A row that moves goes out as that one row: a thread's start, end, prompt or mark pushes the row a listing would
// answer for it, and nothing reads the workspace's whole list again. A builder's project holds 400 threads whose
// rows each repeat an 11 KB brief, and one listing of it was 2.2 MB, read again for every start and end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_ALLOW, PERMISSION_DENY, type EventUnion, type PermissionAsk, type SessionRowEvent, type TurnResult } from "@wsp/protocol";
import { realClock } from "../src/clock.js";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn } from "./stub-backend.js";

const BRIEF = "Build the ticket. ".repeat(600);

/** The computer's name, read for every pushed row, fails while `left` counts down. */
const hostnameFails = vi.hoisted(() => ({ left: 0 }));
vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>();
  const hostname = (): string => {
    if (hostnameFails.left > 0 && hostnameFails.left--) throw new Error("the places table did not read");
    return os.hostname();
  };
  return { ...os, hostname, default: { ...os, hostname } };
});

const ASK: PermissionAsk = {
  askId: "ask_1",
  toolName: "Read",
  toolUseId: "toolu_read",
  input: '{"file_path":"/root/hello.txt"}',
  detail: "hello.txt",
  options: [
    { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
    { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
  ],
};

interface Turn {
  calls: (toolUseId: string, toolName: string, input: string) => void;
  answers: (toolUseId: string) => void;
  raise: () => void;
  reply: () => void;
}

/** Every turn is the test's to drive, except while `quick` holds, when each replies as soon as it starts. The harness
 * calls a session what `titles` names it. */
function drivenAdapter(turns: Turn[], quick: { on: boolean }, titles: Map<string, string>): HarnessAdapterFactory {
  let opened = 0;
  return () => ({
    steers: false,
    sessionTitle: async (id: string) => titles.get(id) ?? null,
    start: ({ onEvent, resume }) => {
      const sessionId = resume ?? `11111111-1111-4111-8111-${String(++opened).padStart(12, "0")}`;
      let settle: ((result: TurnResult) => void) | undefined;
      const finished = new Promise<TurnResult>(resolve => {
        settle = result => {
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      onEvent({ type: "session.start", sessionId, cwd: "/root" });
      const turn: Turn = {
        calls: (toolUseId, toolName, input) => onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: input, toolName, toolUseId }),
        answers: toolUseId => onEvent({ type: "turn.delta", sessionId, kind: "tool_result", text: "ok", toolUseId }),
        raise: () => onEvent({ type: "permission.ask", sessionId, ask: ASK }),
        reply: () => settle?.({ status: "completed", text: "done" }),
      };
      turns.push(turn);
      if (quick.on) queueMicrotask(turn.reply);
      return {
        localId: sessionId,
        finished,
        interrupt: async () => settle?.({ status: "interrupted" }),
        answer: async (askId, o) => {
          onEvent({ type: "permission.close", sessionId, askId, outcome: o.outcome, optionId: o.optionId });
          return "answered";
        },
      };
    },
  });
}

describe("a row that moves", () => {
  let turns: Turn[];
  let quick: { on: boolean };
  let rt: Runtime;
  let heard: EventUnion[];
  let lists: number;
  let titles: Map<string, string>;
  let skew: { ms: number };

  beforeEach(() => {
    turns = [];
    quick = { on: false };
    heard = [];
    titles = new Map();
    skew = { ms: 0 };
    const clock = { now: () => Date.now() + skew.ms, schedule: realClock.schedule };
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: drivenAdapter(turns, quick, titles) }, clock });
    rt.events.on("*", e => void heard.push(e));
    lists = 0;
    const list = rt.sessions.list.bind(rt.sessions);
    rt.sessions.list = (...a) => (lists++, list(...a));
  });
  afterEach(async () => {
    await rt.close();
  });

  const rowsOf = (from: number, threadId: string): SessionRowEvent[] =>
    heard.slice(from).filter((e): e is SessionRowEvent & { seq: number } => e.type === "session.row" && e.threadId === threadId);

  it("in a workspace of 400 threads, a turn's start and end each push that thread's one row, the end under 5 KB", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    quick.on = true;
    const threadIds: string[] = [];
    for (let k = 0; k < 400; k++) {
      const handle = await rt.sessions.start(ws.id, { prompt: `${k} ${BRIEF}` });
      await handle.finished;
      threadIds.push(handle.view().threadId!);
    }
    quick.on = false;
    const listed = await rt.sessions.list(ws.id);
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeGreaterThan(2_000_000);
    lists = 0;

    const threadId = threadIds.at(-1)!;
    const from = heard.length;
    const handle = await rt.sessions.start(ws.id, { prompt: "go on", thread: threadId });
    await vi.waitFor(() => expect(rowsOf(from, threadId).some(e => e.row?.status === "running" && e.row.claudeSessionId !== undefined)).toBe(true));
    const ending = heard.length;
    turns.at(-1)!.reply();
    await handle.finished;
    await vi.waitFor(() => expect(rowsOf(ending, threadId).at(-1)?.row?.status).toBe("completed"));

    const ended = rowsOf(ending, threadId).at(-1)!;
    expect(ended.id).toBe(handle.view().id);
    expect(ended.row).toMatchObject({ id: handle.view().id, threadId, workspaceId: ws.id, status: "completed", harness: "claude" });
    // Every row of the thread repeats its 11 KB brief, which the window was told with the row's first push.
    expect(ended.row).not.toHaveProperty("prompt");
    const sent = heard.slice(ending).reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
    expect(sent).toBeLessThan(5_000);
    expect(lists).toBe(0);
  }, 60_000);

  it("carries a row's opening prompt on the first push under each id, and drops the id a launch left", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: BRIEF });
    const threadId = handle.view().threadId!;
    await vi.waitFor(() => expect(rowsOf(0, threadId).length).toBeGreaterThan(0));
    turns[0]!.reply();
    await handle.finished;
    await vi.waitFor(() => expect(rowsOf(0, threadId).at(-1)?.row?.status).toBe("completed"));
    const pushed = rowsOf(0, threadId);
    const ids = [...new Set(pushed.map(e => e.id))];
    for (const id of ids) {
      const [first, ...rest] = pushed.filter(e => e.id === id && e.row !== undefined);
      expect(first?.row?.prompt).toBe(BRIEF);
      expect(rest.every(e => e.row!.prompt === undefined)).toBe(true);
    }
    // The row lives under the harness's session id once the turn is up, and every other id it went by is dropped.
    expect(ids.filter(id => id !== handle.view().id).map(id => pushed.filter(e => e.id === id).at(-1)?.row)).toEqual(ids.slice(1).map(() => undefined));
  });

  it("pushes a prompt's own row and the row of a thread stopped behind it, and both again when it is answered", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const caller = await rt.sessions.start(ws.id, { prompt: "ask the other one" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const target = await rt.sessions.start(ws.id, { prompt: "read the file" });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const callerThread = caller.view().threadId!;
    const targetThread = target.view().threadId!;
    turns[0]!.calls("toolu_wait", "mcp__wsp__threads_wait", JSON.stringify({ threads: [targetThread], timeout: 60 }));

    const asked = heard.length;
    turns[1]!.raise();
    await vi.waitFor(() => expect(rowsOf(asked, callerThread).at(-1)?.row?.waitingOn?.threadId).toBe(targetThread));
    expect(rowsOf(asked, targetThread).at(-1)?.row?.asking).toBeDefined();

    const answered = heard.length;
    await rt.sessions.answer(target.view().id, { askId: ASK.askId, optionId: PERMISSION_ALLOW });
    await vi.waitFor(() => expect(rowsOf(answered, callerThread).at(-1)?.row).toBeDefined());
    expect(rowsOf(answered, callerThread).at(-1)!.row).not.toHaveProperty("waitingOn");
    await vi.waitFor(() => expect(rowsOf(answered, targetThread).at(-1)?.row).toBeDefined());
    expect(rowsOf(answered, targetThread).at(-1)!.row).not.toHaveProperty("asking");

    turns[1]!.reply();
    turns[0]!.answers("toolu_wait");
    turns[0]!.reply();
    await Promise.all([caller.finished, target.finished]);
    expect(lists).toBe(0);
  });

  it("pushes the row a read mark moved", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    quick.on = true;
    const handle = await rt.sessions.start(ws.id, { prompt: "one" });
    await handle.finished;
    const threadId = handle.view().threadId!;
    const from = heard.length;
    await rt.sessions.read(threadId);
    await vi.waitFor(() => expect(rowsOf(from, threadId).at(-1)?.row?.readAt).toBeGreaterThanOrEqual(handle.view().endedAt!));
  });

  it("pushes every row a failed batch held with the next one", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    quick.on = true;
    const one = await rt.sessions.start(ws.id, { prompt: "one" });
    await one.finished;
    const two = await rt.sessions.start(ws.id, { prompt: "two" });
    await two.finished;
    const [first, second] = [one.view().threadId!, two.view().threadId!];
    // The pushes the ends left are all out before the read that fails.
    await new Promise(r => setTimeout(r, 100));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const from = heard.length;
    hostnameFails.left = 1;
    await rt.sessions.read(first);
    await vi.waitFor(() => expect(warned).toHaveBeenCalledWith("a moved row was not pushed: the places table did not read"));
    await new Promise(r => setTimeout(r, 50));
    expect(heard.slice(from).filter(e => e.type === "session.row")).toEqual([]);
    await rt.sessions.read(second);
    await vi.waitFor(() => expect(rowsOf(from, second)).toHaveLength(1));
    expect(rowsOf(from, first).at(-1)?.row?.readAt).toBeGreaterThanOrEqual(one.view().endedAt!);
    warned.mockRestore();
  });

  it("pushes a thread's row once a rename made in the harness is read, which the next row to move asks for", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    quick.on = true;
    const one = await rt.sessions.start(ws.id, { prompt: "one" });
    await one.finished;
    const two = await rt.sessions.start(ws.id, { prompt: "two" });
    await two.finished;
    const threadId = one.view().threadId!;
    titles.set(one.view().claudeSessionId!, "named in the harness");
    skew.ms = 60_000;
    const from = heard.length;
    await rt.sessions.read(two.view().threadId!);
    await vi.waitFor(() => expect(rowsOf(from, threadId).at(-1)?.row?.harnessTitle).toBe("named in the harness"));
    expect(lists).toBe(0);
  });

  it("pushes the row of a settled thread a restart replaces, naming the restart", async () => {
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    quick.on = true;
    const old = await rt.sessions.start(ws.id, { prompt: "the first try" });
    await old.finished;
    const replaced = old.view().threadId!;
    await rt.sessions.settle([replaced]);
    const from = heard.length;
    const restart = await rt.sessions.start(ws.id, { prompt: "the second try", replaces: replaced });
    await restart.finished;
    await vi.waitFor(() => expect(rowsOf(from, replaced).at(-1)?.row?.replacedBy).toBe(restart.view().threadId));
    expect(lists).toBe(0);
  });
});
