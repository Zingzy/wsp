// SPDX-License-Identifier: AGPL-3.0-only
// A thread's read and settled stamps, kept per thread by the host: a window
// showing a thread moves its read stamp, a settle moves both, every window is
// told, the stamps ride every row a listing answers and outlive a restart, and
// a thread that ended before the host kept stamps reads as seen. A pin, a
// placement in a section and a snooze are kept the same way, and a snooze that
// passes brings its thread back reading Done.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foldThreads, threadNeedsYou, threadWordOf, type EventUnion, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
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

/** A clock a minute ahead of the wall clock the turns' ends are stamped with, so a stamp it takes lands after them. */
const aheadClock = () => fakeClock(Date.now() + 60_000);

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

  it("a pin and a placement ride every row of the thread, move nothing else and outlive a restart; clearing them drops them", async () => {
    const store = await keptSinceLongAgo();
    const { clock } = aheadClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const done = await rt.sessions.start(ws.id, { prompt: "build it" });
    await done.finished;
    const threadId = done.view().threadId!;
    const placed = { name: "working" as const, whileState: `completed:${done.view().id}` };

    await rt.sessions.mark([threadId], { pinned: true, section: placed });

    const [pinned] = foldThreads(await rt.sessions.list(ws.id));
    expect(pinned).toMatchObject({ pinnedAt: clock.now(), section: placed });
    // Neither is a showing: the finish nobody opened still reads Done.
    expect(threadWordOf(pinned!)).toBe("Done");
    expect(events.filter(e => e.type === "thread.marked")).toMatchObject([{ workspaceId: ws.id, threadIds: [threadId] }]);
    await rt.close();

    const again = createRuntime({ backend: stubBackend(), store, adapters: { claude: working }, clock });
    expect(foldThreads(await again.sessions.list(ws.id))[0]).toMatchObject({ pinnedAt: pinned!.pinnedAt, section: placed });
    await again.sessions.mark([threadId], { pinned: false, section: null });
    const [cleared] = foldThreads(await again.sessions.list(ws.id));
    expect(cleared).not.toHaveProperty("pinnedAt");
    expect(cleared).not.toHaveProperty("section");
    await again.close();
  });

  it("a snooze reads the thread as seen and hidden until its time, then every window hears it and it reads Done until shown", async () => {
    const store = await keptSinceLongAgo();
    const { clock, advance } = aheadClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const done = await rt.sessions.start(ws.id, { prompt: "build it" });
    await done.finished;
    const threadId = done.view().threadId!;
    const until = clock.now() + 60 * 60_000;

    await rt.sessions.mark([threadId], { snoozedUntil: until });

    const [hidden] = foldThreads(await rt.sessions.list(ws.id));
    expect(hidden).toMatchObject({ snoozedUntil: until });
    expect(hidden).not.toHaveProperty("wokeAt");
    // Snoozing a finish is looking at it: it reads Idle while it is away, and it needs nobody.
    expect(threadWordOf(hidden!)).toBe("Idle");
    expect(threadNeedsYou(hidden!)).toBe(false);

    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    advance(60 * 60_000 - 1);
    expect(events.filter(e => e.type === "thread.marked")).toEqual([]);
    advance(1);
    expect(events.filter(e => e.type === "thread.marked")).toMatchObject([{ workspaceId: ws.id, threadIds: [threadId] }]);

    const [back] = foldThreads(await rt.sessions.list(ws.id));
    expect(back).not.toHaveProperty("snoozedUntil");
    expect(back).toMatchObject({ wokeAt: until });
    expect(threadWordOf(back!)).toBe("Done");
    expect(threadNeedsYou(back!)).toBe(true);

    await rt.sessions.read(threadId);
    expect(threadWordOf(foldThreads(await rt.sessions.list(ws.id))[0]!)).toBe("Idle");
    await rt.close();
  });

  it("a snooze still standing when the host starts again brings its thread back on time", async () => {
    const store = await keptSinceLongAgo();
    const { clock, advance } = aheadClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const done = await rt.sessions.start(ws.id, { prompt: "build it" });
    await done.finished;
    const threadId = done.view().threadId!;
    await rt.sessions.mark([threadId], { snoozedUntil: clock.now() + 60_000 });
    await rt.close();

    const again = createRuntime({ backend: stubBackend(), store, adapters: { claude: working }, clock });
    await again.workspaces.list();
    const events: EventUnion[] = [];
    again.events.on("*", e => events.push(e));
    advance(60_000);
    expect(events.filter(e => e.type === "thread.marked")).toMatchObject([{ workspaceId: ws.id, threadIds: [threadId] }]);
    expect(threadWordOf(foldThreads(await again.sessions.list(ws.id))[0]!)).toBe("Done");
    await again.close();
  });

  it("a restore takes a settled thread back out of the fold as just read, so the quiet counts from now", async () => {
    const store = await keptSinceLongAgo();
    const { clock, advance } = aheadClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: working }, clock });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const done = await rt.sessions.start(ws.id, { prompt: "build it" });
    await done.finished;
    const threadId = done.view().threadId!;
    await rt.sessions.settle([threadId]);
    advance(5 * 60 * 60_000);

    await rt.sessions.restore([threadId]);

    const [restored] = foldThreads(await rt.sessions.list(ws.id));
    expect(restored).not.toHaveProperty("settledAt");
    expect(restored!.readAt).toBe(clock.now());
    await rt.close();
  });

  it("a mark naming a thread the caller cannot reach moves nothing", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: await keptSinceLongAgo(), adapters: { claude: working } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const done = await rt.sessions.start(ws.id, { prompt: "build it" });
    await done.finished;
    await expect(rt.sessions.mark([done.view().threadId!, "thr_nobody"], { pinned: true })).rejects.toMatchObject({ kind: "not-found" });
    await expect(rt.sessions.restore(["thr_nobody"])).rejects.toMatchObject({ kind: "not-found" });
    expect(foldThreads(await rt.sessions.list(ws.id))[0]).not.toHaveProperty("pinnedAt");
    await rt.close();
  });
});
