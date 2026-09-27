// SPDX-License-Identifier: AGPL-3.0-only
// A thread's read and settled stamps, kept per thread by the host: a window
// showing a thread moves its read stamp, a settle moves both, every window is
// told, the stamps ride every row a listing answers and outlive a restart, and
// a thread that ended before the host kept stamps reads as seen.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foldThreads, threadWordOf, type EventUnion, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

const working: HarnessAdapterFactory = () => ({
  steers: false,
  start: o => {
    const sessionId = randomUUID();
    const result: TurnResult = { status: "completed", text: "all green" };
    const finished = Promise.resolve().then(() => {
      o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
      o.onEvent({ type: "turn.done", sessionId, result });
      o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    });
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

/** A store whose read stamps began long before any turn here, so a turn that ends is one no window has shown. */
async function keptSinceLongAgo() {
  const store = memoryStore();
  await store.put("reads", "since", { at: 1 });
  return store;
}

describe("a thread's read and settled stamps", () => {
  it("a finished turn nobody has shown reads Done, and a read moves its stamp so it reads Idle, on every row of the thread", async () => {
    const store = await keptSinceLongAgo();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const first = await rt.sessions.start(ws.id, { prompt: "build it" });
    await first.finished;
    const threadId = first.view().threadId!;
    await (await rt.sessions.start(ws.id, { prompt: "and test it", thread: threadId })).finished;

    const [unread] = foldThreads(await rt.sessions.list(ws.id));
    expect(unread!.readAt).toBe(1);
    expect(threadWordOf(unread!)).toBe("Done");

    await rt.sessions.read(threadId);

    const rows = await rt.sessions.list(ws.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.readAt)).size).toBe(1);
    expect(rows[0]!.readAt!).toBeGreaterThanOrEqual(rows[1]!.endedAt!);
    expect(threadWordOf(foldThreads(rows)[0]!)).toBe("Idle");
    expect(events.filter(e => e.type === "thread.marked")).toMatchObject([{ type: "thread.marked", workspaceId: ws.id, threadIds: [threadId] }]);
    await rt.close();
  });

  it("a settle stamps each thread settled and read, tells each workspace once, and the stamps outlive a restart", async () => {
    const store = await keptSinceLongAgo();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const a = await rt.sessions.start(ws.id, { prompt: "lead" });
    await a.finished;
    const b = await rt.sessions.start(ws.id, { prompt: "child" });
    await b.finished;
    const ids = [a.view().threadId!, b.view().threadId!];

    await rt.sessions.settle(ids);

    const settled = foldThreads(await rt.sessions.list(ws.id));
    expect(settled.map(t => t.settledAt !== undefined && t.settledAt === t.readAt)).toEqual([true, true]);
    expect(settled.map(threadWordOf)).toEqual(["Idle", "Idle"]);
    expect(events.filter(e => e.type === "thread.marked")).toMatchObject([{ workspaceId: ws.id, threadIds: ids }]);
    await rt.close();

    const again = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const back = foldThreads(await again.sessions.list(ws.id));
    expect(back.map(t => ({ readAt: t.readAt, settledAt: t.settledAt }))).toEqual(settled.map(t => ({ readAt: t.readAt, settledAt: t.settledAt })));
    await again.close();
  });

  it("a thread that ended before the host kept read stamps reads as seen, and a name nothing holds moves nothing", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const done = await rt.sessions.start(ws.id, { prompt: "build it" });
    await done.finished;
    await rt.close();
    // The stamps began after that turn ended: an upgrade onto a state file full of finished threads.
    const ended = foldThreads((await store.get("sessions", ws.id) as { sessions: Parameters<typeof foldThreads>[0] }).sessions)[0]!.endedAt!;
    await store.put("reads", "since", { at: ended + 1 });

    const again = createRuntime({ backend: stubBackend(), store, adapters: { claude: working } });
    const [old] = foldThreads(await again.sessions.list(ws.id));
    expect(threadWordOf(old!)).toBe("Idle");
    // Seen as it ended rather than at the upgrade, so the quiet the fold reads still counts from its end.
    expect(old!.readAt).toBe(ended);
    await expect(again.sessions.settle([done.view().threadId!, "thr_nobody"])).rejects.toMatchObject({ message: "no thread thr_nobo", kind: "not-found" });
    expect(foldThreads(await again.sessions.list(ws.id))[0]).not.toHaveProperty("settledAt");
    await again.close();
  });
});
