// SPDX-License-Identifier: AGPL-3.0-only
// A window that read the rows once and then folds in every pushed row, as the app's store does, holds what a fresh
// listing answers after every step a thread takes: any difference is a row the app shows stale until it reconnects.
import { describe, expect, it } from "vitest";
import { foldThreads, PERMISSION_ALLOW, PERMISSION_DENY, withPushedRow, type AdapterEvent, type PermissionAsk, type SessionView, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn } from "./stub-backend.js";

const settle = (ms = 40) => new Promise<void>(r => setTimeout(r, ms));

const askOf = (n: number): PermissionAsk => ({
  askId: `ask_${n}`,
  toolName: "Read",
  toolUseId: `toolu_read_${n}`,
  input: '{"file_path":"/root/hello.txt"}',
  detail: "hello.txt",
  options: [
    { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
    { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
  ],
});

interface Turn { sessionId: string; prompt: string; emit: (e: AdapterEvent) => void; end: (r?: Partial<TurnResult>) => void }

const harnessTitles = new Map<string, string>();

function driven(turns: Turn[]): HarnessAdapterFactory {
  let opened = 0;
  return () => ({
    steers: false,
    sessionTitle: async (id: string) => harnessTitles.get(id) ?? null,
    renameSession: async () => ({ kind: "written" as const }),
    titleFor: async () => "a made title",
    start: ({ onEvent, resume, prompt }) => {
      if (prompt.startsWith("boom")) throw new Error("the agent would not start");
      const sessionId = resume ?? `11111111-1111-4111-8111-${String(++opened).padStart(12, "0")}`;
      let settleIt: ((result: TurnResult) => void) | undefined;
      const finished = new Promise<TurnResult>(resolve => {
        settleIt = result => {
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      onEvent({ type: "session.start", sessionId, cwd: "/root", model: "claude-sonnet-4-5" });
      turns.push({ sessionId, prompt, emit: onEvent, end: r => settleIt?.({ status: "completed", text: "done", ...r }) });
      return {
        localId: sessionId,
        finished,
        interrupt: async () => settleIt?.({ status: "interrupted" }),
        answer: async (askId: string, o: { optionId: string }) => {
          onEvent({ type: "permission.close", sessionId, askId, outcome: o.optionId === PERMISSION_ALLOW ? "allowed" : "denied", optionId: o.optionId });
          return "answered" as const;
        },
      };
    },
  });
}

describe("pushed rows against a fresh listing", () => {
  it("every step leaves the mirror equal to a listing", async () => {
    const turns: Turn[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: driven(turns) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    let mirror: SessionView[] = await rt.sessions.list(ws.id);
    rt.events.on("*", e => {
      if (e.type === "session.row" && e.workspaceId === ws.id) mirror = withPushedRow(mirror, e);
    });
    const diffs: string[] = [];
    const threadDiffs: string[] = [];
    const check = async (label: string, ms = 60): Promise<void> => {
      await settle(ms);
      const fresh = await rt.sessions.list(ws.id);
      await settle(10);
      const byId = new Map(mirror.map(r => [r.id, r]));
      for (const f of fresh) {
        const m = byId.get(f.id);
        if (m === undefined) {
          diffs.push(`${label}: row ${f.id.slice(0, 8)} (${f.prompt?.slice(0, 20)}) listed, not in the mirror`);
          continue;
        }
        for (const k of new Set([...Object.keys(f), ...Object.keys(m)])) {
          const a = JSON.stringify((f as Record<string, unknown>)[k]);
          const b = JSON.stringify((m as Record<string, unknown>)[k]);
          if (a !== b) diffs.push(`${label}: row ${f.id.slice(0, 8)} (${f.prompt?.slice(0, 20)}) .${k} listed ${a?.slice(0, 400)} mirror ${b?.slice(0, 400)}`);
        }
        byId.delete(f.id);
      }
      for (const [id, m] of byId) diffs.push(`${label}: row ${id.slice(0, 8)} (${m.prompt?.slice(0, 20)}) in the mirror, not listed`);
      const fm = new Map(foldThreads(mirror).map(t => [t.id, t]));
      for (const t of foldThreads(fresh)) {
        const m = fm.get(t.id);
        if (m === undefined) { threadDiffs.push(`${label}: thread ${t.id.slice(0, 8)} listed, not folded from the mirror`); continue; }
        for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
          const a = JSON.stringify((t as Record<string, unknown>)[k]);
          const b = JSON.stringify((m as Record<string, unknown>)[k]);
          if (a !== b) threadDiffs.push(`${label}: thread ${t.id.slice(0, 8)} (${t.title?.slice(0, 20)}) .${k} listed ${a?.slice(0, 70)} mirror ${b?.slice(0, 70)}`);
        }
      }
    };

    // 1. a thread starts and ends
    const a = await rt.sessions.start(ws.id, { prompt: "first thread" });
    const A = a.view().threadId!;
    await check("A start");
    turns.at(-1)!.end();
    await a.finished;
    await check("A end", 120);

    // 2. a second turn in the same thread
    const a2 = await rt.sessions.start(ws.id, { prompt: "go on", thread: A });
    await check("A turn 2 start");
    // subagents on that turn
    turns.at(-1)!.emit({ type: "subagent", sessionId: turns.at(-1)!.sessionId, task: "t1", state: "running", parentToolUseId: "toolu_t1", title: "count", depth: 1 });
    await check("A subagent start");
    turns.at(-1)!.emit({ type: "subagent", sessionId: turns.at(-1)!.sessionId, task: "t1", state: "done", parentToolUseId: "toolu_t1", summary: "counted" });
    await check("A subagent end");
    // a permission prompt on that turn
    turns.at(-1)!.emit({ type: "permission.ask", sessionId: turns.at(-1)!.sessionId, ask: askOf(1) });
    await check("A asks");
    await rt.sessions.answer(a2.view().id, { askId: "ask_1", optionId: PERMISSION_ALLOW });
    await check("A answered");
    turns.at(-1)!.end({ costUsd: 0.5 });
    await a2.finished;
    await check("A turn 2 end", 120);

    // 3. marks
    await rt.sessions.read(A);
    await check("A read");
    await rt.sessions.mark([A], { pinned: true });
    await check("A pinned");
    await rt.sessions.mark([A], { folded: true });
    await check("A folded");
    await rt.sessions.mark([A], { snoozedUntil: Date.now() + 60_000 });
    await check("A snoozed");
    await rt.sessions.mark([A], { snoozedUntil: null });
    await check("A unsnoozed");
    await rt.sessions.settle([A]);
    await check("A settled");
    await rt.sessions.restore([A]);
    await check("A restored");

    // 4. rename and access
    const renamed = await rt.sessions.rename(a2.view().id, "named by hand");
    await check(`A renamed (${renamed.outcome})`);

    // 5. a follower stopped behind another thread's prompt, prompt first then the call
    const b = await rt.sessions.start(ws.id, { prompt: "target thread" });
    const B = b.view().threadId!;
    const bTurn = turns.at(-1)!;
    const c = await rt.sessions.start(ws.id, { prompt: "caller thread" });
    const cTurn = turns.at(-1)!;
    await check("B and C start");
    bTurn.emit({ type: "permission.ask", sessionId: bTurn.sessionId, ask: askOf(2) });
    await check("B asks");
    cTurn.emit({ type: "turn.delta", sessionId: cTurn.sessionId, kind: "tool_use", text: JSON.stringify({ threads: [B], timeout: 60 }), toolName: "mcp__wsp__threads_wait", toolUseId: "toolu_wait" });
    await check("C follows B while B asks");
    await rt.sessions.answer(b.view().id, { askId: "ask_2", optionId: PERMISSION_DENY });
    await check("B answered");
    bTurn.end();
    await b.finished;
    await check("B end", 120);
    cTurn.emit({ type: "turn.delta", sessionId: cTurn.sessionId, kind: "tool_result", text: "ok", toolUseId: "toolu_wait" });
    await check("C wait returns");

    // 6. a prompt that ends with its turn interrupted, never answered
    const d = await rt.sessions.start(ws.id, { prompt: "interrupted while asking" });
    const dTurn = turns.at(-1)!;
    cTurn.emit({ type: "turn.delta", sessionId: cTurn.sessionId, kind: "tool_use", text: JSON.stringify({ threads: [d.view().threadId], timeout: 60 }), toolName: "mcp__wsp__threads_wait", toolUseId: "toolu_wait2" });
    dTurn.emit({ type: "permission.ask", sessionId: dTurn.sessionId, ask: askOf(3) });
    await check("D asks, C behind it");
    await rt.sessions.interrupt(d.view().id);
    await d.finished;
    await check("D interrupted while asking", 150);
    cTurn.emit({ type: "turn.delta", sessionId: cTurn.sessionId, kind: "tool_result", text: "ok", toolUseId: "toolu_wait2" });
    await check("C second wait returns");
    cTurn.end();
    await c.finished;
    await check("C end", 120);

    // 7. a start that never runs
    await rt.sessions.start(ws.id, { prompt: "boom never runs" }).then(h => h.finished).catch(() => undefined);
    await check("boom start", 150);

    // 8. a limit on a turn's result
    const e = await rt.sessions.start(ws.id, { prompt: "hits the limit" });
    turns.at(-1)!.end({ status: "failed", limit: { resetsAt: Date.now() + 3_600_000 } } as Partial<TurnResult>);
    await e.finished;
    await check("E limit end", 150);

    // 9. a restart of a settled thread
    await rt.sessions.settle([B]);
    await check("B settled");
    const r = await rt.sessions.start(ws.id, { prompt: "restart of B", replaces: B }).catch((x: unknown) => x as Error);
    await check(`restart of settled B (${r instanceof Error ? r.message.slice(0, 60) : "started"})`, 150);
    if (!(r instanceof Error)) {
      turns.at(-1)!.end();
      await r.finished;
      await check("restart end", 150);
    }
    // a restart of a thread not settled
    const f = await rt.sessions.start(ws.id, { prompt: "to be replaced" });
    turns.at(-1)!.end({ status: "interrupted" } as Partial<TurnResult>);
    await f.finished;
    await check("F end", 120);
    const f2 = await rt.sessions.start(ws.id, { prompt: "restart of F", replaces: f.view().threadId! }).catch((x: unknown) => x as Error);
    await check(`restart of unsettled F (${f2 instanceof Error ? f2.message.slice(0, 60) : "started"})`, 150);
    if (!(f2 instanceof Error)) {
      turns.at(-1)!.end();
      await f2.finished;
      await check("restart F end", 150);
    }

    await rt.close();
    expect(diffs).toEqual([]);
    expect(threadDiffs).toEqual([]);
  }, 60_000);
});
