// SPDX-License-Identifier: AGPL-3.0-only
// A restart: a thread started with replaces names the thread it replaces, the host settles that one once the new
// one's first turn starts, and both rows list the link, through a host restart too. A working thread, a thread
// outside a token's tree and a send into a thread that has run are refused before anything starts.
import { describe, expect, it } from "vitest";
import { foldThreads, type Caller, type ThreadScope } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { held, settle } from "./runtime-fixture.js";

/** A lead with two children, the first stuck working and the second done; turns are held, so each ends only when the
 * case ends it. The lead's turn is 0, the stuck child's 1, the done child's 2. */
async function lead(store = memoryStore(), backend = stubBackend()) {
  const h = held(false);
  const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  const as = (threadId: string, rootThreadId: string): Caller => ({ origin: "relayed", by: { kind: "thread", threadId, workspaceId: ws.id, rootThreadId } satisfies ThreadScope });
  const L = (await rt.sessions.start(ws.id, { prompt: "lead the work" })).view().threadId!;
  const stuck = await rt.sessions.start(ws.id, { prompt: "build the parser", title: "Landing fix: security fixes" }, as(L, L));
  const A = stuck.view().threadId!;
  const done = await rt.sessions.start(ws.id, { prompt: "build the printer" }, as(L, L));
  const B = done.view().threadId!;
  h.end(2, "printer built");
  h.end(0, "waiting on the children");
  await settle();
  const threads = async (r = rt) => Object.fromEntries(foldThreads(await r.sessions.list(ws.id)).map(t => [t.id, t]));
  return { h, rt, ws, as, L, A, B, stuck, threads };
}

describe("a restart that names the thread it replaces", () => {
  it("records the link both ways, settles the replaced thread once the restart starts, and keeps both across a host restart", async () => {
    const store = memoryStore();
    const backend = stubBackend();
    const { h, rt, ws, as, L, A, stuck, threads } = await lead(store, backend);
    h.end(1, "", { status: "interrupted" });
    await stuck.finished;
    await settle();
    expect((await threads())[A]!.settledAt).toBeUndefined();
    const again = await rt.sessions.start(ws.id, { prompt: "build the parser", title: "Landing fix: security fixes", replaces: A }, as(L, L));
    const A2 = again.view().threadId!;
    await settle();
    const now = await threads();
    expect(now[A2]).toMatchObject({ replaces: A, status: "running", parentThreadId: L });
    expect(now[A2]!.settledAt).toBeUndefined();
    expect(now[A]).toMatchObject({ replacedBy: A2, status: "interrupted", settledAt: expect.any(Number) });
    const rows = await rt.sessions.list(ws.id);
    expect(rows.find(r => r.threadId === A2)).toMatchObject({ replaces: A });
    expect(rows.find(r => r.threadId === A)).toMatchObject({ replacedBy: A2 });
    h.end(3, "parser built");
    await again.finished;
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const kept = await threads(rt2);
    expect(kept[A2]).toMatchObject({ replaces: A });
    expect(kept[A]).toMatchObject({ replacedBy: A2, settledAt: expect.any(Number) });
    await rt2.close();
  });

  it("replaces a failed thread the same way", async () => {
    const { h, rt, ws, as, L, A, stuck, threads } = await lead();
    h.end(1, "", { status: "failed", error: "no parser" });
    await stuck.finished;
    await settle();
    const again = await rt.sessions.start(ws.id, { prompt: "build the parser", replaces: A }, as(L, L));
    await settle();
    expect((await threads())[A]).toMatchObject({ status: "failed", replacedBy: again.view().threadId, settledAt: expect.any(Number) });
    h.end(3, "parser built");
    await rt.close();
  });

  it("is refused for a working thread, saying stop it first, and starts nothing", async () => {
    const { h, rt, ws, as, L, A, threads } = await lead();
    const before = Object.keys(await threads()).length;
    await expect(rt.sessions.start(ws.id, { prompt: "build the parser", replaces: A }, as(L, L))).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${A.slice(0, 8)} is still working`) });
    expect(Object.keys(await threads())).toHaveLength(before);
    expect((await threads())[A]).not.toHaveProperty("replacedBy");
    h.end(1, "parser built");
    await rt.close();
  });

  it("is refused outside a thread's own tree, naming the thread, and for a name nothing holds", async () => {
    const { h, rt, ws, as, L, A, B, stuck, threads } = await lead();
    h.end(1, "", { status: "interrupted" });
    await stuck.finished;
    await settle();
    await expect(rt.sessions.start(ws.id, { prompt: "build the parser", replaces: A }, as(B, L))).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${A.slice(0, 8)} is not under this thread`) });
    await expect(rt.sessions.start(ws.id, { prompt: "lead again", replaces: L }, as(A, L))).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${L.slice(0, 8)}`) });
    await expect(rt.sessions.start(ws.id, { prompt: "build it", replaces: "thr_nobody" }, as(L, L))).rejects.toMatchObject({ kind: "not-found", message: "no thread thr_nobo" });
    expect((await threads())[A]!.settledAt).toBeUndefined();
    h.end(1, "parser built");
    await rt.close();
  });

  it("is refused on a send into a thread that has run, which replaces nothing", async () => {
    const { h, rt, ws, A, B, stuck } = await lead();
    h.end(1, "", { status: "interrupted" });
    await stuck.finished;
    await settle();
    await expect(rt.sessions.start(ws.id, { prompt: "and the parser", thread: B, replaces: A })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("a restart opens a thread") });
    await rt.close();
  });

  it("is refused for a thread that already has a restart, naming that restart, so the chain stays one line", async () => {
    const { h, rt, ws, as, L, A, stuck, threads } = await lead();
    h.end(1, "", { status: "interrupted" });
    await stuck.finished;
    await settle();
    const again = await rt.sessions.start(ws.id, { prompt: "build the parser", replaces: A }, as(L, L));
    const A2 = again.view().threadId!;
    h.end(3, "", { status: "interrupted" });
    await again.finished;
    await settle();
    await expect(rt.sessions.start(ws.id, { prompt: "build the parser", replaces: A }, as(L, L))).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${A.slice(0, 8)} was restarted as ${A2.slice(0, 8)}`) });
    await expect(rt.sessions.replaceable(A, as(L, L))).rejects.toMatchObject({ kind: "usage" });
    const now = await threads();
    expect(now[A]).toMatchObject({ replacedBy: A2 });
    expect(Object.values(now).filter(t => t.replaces === A).map(t => t.id)).toEqual([A2]);
    await rt.close();
  });

  it("answers its refusals as a read of its own, which a verb makes before it forks or wakes a machine", async () => {
    const { h, rt, as, L, A, B, stuck } = await lead();
    await expect(rt.sessions.replaceable(A, as(L, L))).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${A.slice(0, 8)} is still working`) });
    h.end(1, "", { status: "interrupted" });
    await stuck.finished;
    await settle();
    await expect(rt.sessions.replaceable(A, as(B, L))).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${A.slice(0, 8)} is not under this thread`) });
    await expect(rt.sessions.replaceable("thr_nobody", as(L, L))).rejects.toMatchObject({ kind: "not-found" });
    await expect(rt.sessions.replaceable(A, as(L, L))).resolves.toBeUndefined();
    await expect(rt.sessions.replaceable(A, undefined)).resolves.toBeUndefined();
    await rt.close();
  });

  it("started by the person for a child, stands under that child's lead, where the child stood", async () => {
    const { h, rt, ws, L, A, stuck, threads } = await lead();
    h.end(1, "", { status: "interrupted" });
    await stuck.finished;
    await settle();
    const again = await rt.sessions.start(ws.id, { prompt: "build the parser", replaces: A });
    await settle();
    expect((await threads())[again.view().threadId!]).toMatchObject({ replaces: A, parentThreadId: L, rootThreadId: L });
    h.end(3, "parser built");
    await again.finished;
    await rt.close();
  });
});
