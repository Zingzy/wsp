// SPDX-License-Identifier: AGPL-3.0-only
// A settle down a tree, as the host does it: a thread settles with everything
// under it, a tree with anything working is left whole and says why, finished
// settles the finished threads under the one named and not it, a restore takes
// back what that settle moved and nothing else, and a thread's own token reaches
// only the threads under it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSION_ALLOW, foldThreads, type Caller, type ThreadScope } from "@wsp/protocol";
import type { Clock } from "../src/clock.js";
import { createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { held, settle } from "./runtime-fixture.js";

/** A lead with three children: one done with a grandchild done under it, one still working, one failed. Turns are
 * held, so each ends only when the case ends it; the lead's turn is 0. */
async function tree(clock?: Clock) {
  const h = held(false);
  const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, ...(clock === undefined ? {} : { clock }) });
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  const as = (threadId: string, rootThreadId: string): Caller => ({ origin: "relayed", by: { kind: "thread", threadId, workspaceId: ws.id, rootThreadId } satisfies ThreadScope });
  const lead = await rt.sessions.start(ws.id, { prompt: "lead the work" });
  const L = lead.view().threadId!;
  const done = await rt.sessions.start(ws.id, { prompt: "build the parser" }, as(L, L));
  const A = done.view().threadId!;
  const grand = await rt.sessions.start(ws.id, { prompt: "write its tests" }, as(A, L));
  const A1 = grand.view().threadId!;
  const busy = await rt.sessions.start(ws.id, { prompt: "build the printer" }, as(L, L));
  const B = busy.view().threadId!;
  const broke = await rt.sessions.start(ws.id, { prompt: "build the linker" }, as(L, L));
  const C = broke.view().threadId!;
  h.end(2, "tests written");
  h.end(1, "parser built");
  h.end(4, "no linker", { status: "failed" });
  h.end(0, "waiting on the children");
  await Promise.all([lead.finished, done.finished, grand.finished, broke.finished]);
  await settle();
  const marks = async () => Object.fromEntries(foldThreads(await rt.sessions.list(ws.id)).map(t => [t.id, t.settledAt !== undefined]));
  return { h, rt, ws, as, L, A, A1, B, C, marks };
}

describe("a settle down a tree", () => {
  it("settles the thread named and everything under it, says so with each title, and a second settle leaves it as already settled", async () => {
    const { h, rt, L, A, A1, B, C, marks } = await tree();
    expect(await rt.sessions.settle([A])).toEqual({ settled: [{ threadId: A, title: "build the parser" }, { threadId: A1, title: "write its tests" }], left: [] });
    expect(await marks()).toEqual({ [L]: false, [A]: true, [A1]: true, [B]: false, [C]: false });
    expect(await rt.sessions.settle([A])).toEqual({ settled: [], left: [{ threadId: A, why: "already settled" }] });
    h.end(3, "printer built");
    await rt.close();
  });

  it("leaves a tree with a working thread in it whole, saying so, and settles it once nothing in it works", async () => {
    const { h, rt, L, A, A1, B, C, marks } = await tree();
    expect(await rt.sessions.settle([L])).toEqual({ settled: [], left: [{ threadId: L, why: "still working: stop it first" }] });
    expect(Object.values(await marks())).not.toContain(true);
    h.end(3, "printer built");
    await settle();
    const { settled, left } = await rt.sessions.settle([L]);
    expect(left).toEqual([]);
    expect(settled.map(s => s.threadId).sort()).toEqual([L, A, A1, B, C].sort());
    expect(settled[0]).toEqual({ threadId: L, title: "lead the work" });
    await rt.close();
  });

  it("finished settles every finished thread under the one named and not it: the working and the failed stay", async () => {
    const { h, rt, L, A, A1, B, C, marks } = await tree();
    const { settled, left } = await rt.sessions.settle([L], undefined, { finished: true });
    expect(settled.map(s => s.threadId).sort()).toEqual([A, A1].sort());
    expect(left).toEqual([]);
    expect(await marks()).toEqual({ [L]: false, [A]: true, [A1]: true, [B]: false, [C]: false });
    h.end(3, "printer built");
    await rt.close();
  });

  it("finished leaves a finished thread with work under it, saying so, and settles the finished threads under that work's lead", async () => {
    const { h, rt, ws, as, L, A, A1, B, C, marks } = await tree();
    const probe = await rt.sessions.start(ws.id, { prompt: "probe the parser" }, as(A, L));
    const P = probe.view().threadId!;
    await settle();
    expect(await rt.sessions.settle([L], undefined, { finished: true })).toEqual({ settled: [{ threadId: A1, title: "write its tests" }], left: [{ threadId: A, why: "still working: stop it first" }] });
    expect(await marks()).toEqual({ [L]: false, [A]: false, [A1]: true, [B]: false, [C]: false, [P]: false });
    h.end(3, "printer built");
    h.end(5, "probed");
    await rt.close();
  });

  it("leaves a tree with a thread in it asking the person, saying so", async () => {
    const { h, rt, ws, L, A, B } = await tree();
    const asking = (await rt.sessions.list(ws.id)).find(r => r.threadId === B)!;
    const options = [{ id: PERMISSION_ALLOW, label: "Allow", effect: "allow" as const }];
    h.starts[3]!.onEvent({ type: "permission.ask", sessionId: asking.claudeSessionId!, ask: { askId: "ask_1", toolName: "Bash", toolUseId: "toolu_1", input: '{"command":"pnpm test"}', options } });
    await settle();
    expect(foldThreads(await rt.sessions.list(ws.id)).find(t => t.id === B)?.asking).toBeDefined();
    expect(await rt.sessions.settle([L, B])).toEqual({ settled: [], left: [{ threadId: L, why: "still working: stop it first" }, { threadId: B, why: "still working: stop it first" }] });
    expect((await rt.sessions.settle([A])).left).toEqual([]);
    h.end(3, "printer built");
    await rt.close();
  });

  it("a restore takes back what the settle moved and leaves a thread folded by quiet time where it is", async () => {
    const fc = fakeClock();
    const { h, rt, L, A, A1, B, C, marks } = await tree(fc.clock);
    fc.advance(1000);
    await rt.sessions.read(A1);
    fc.advance(3 * 60 * 60 * 1000);
    expect(await rt.sessions.settle([A])).toEqual({ settled: [{ threadId: A, title: "build the parser" }], left: [] });
    expect(await rt.sessions.restore([A])).toEqual({ restored: [{ threadId: A, title: "build the parser" }] });
    expect(await marks()).toEqual({ [L]: false, [A]: false, [A1]: false, [B]: false, [C]: false });
    h.end(3, "printer built");
    await rt.close();
  });

  it("a restore leaves a thread settled by an earlier settle where it is, and Undo's ids take back exactly what the answer named", async () => {
    const { h, rt, L, A, A1, B, C, marks } = await tree();
    await rt.sessions.settle([A1]);
    expect((await rt.sessions.settle([A])).settled.map(s => s.threadId)).toEqual([A]);
    expect(await rt.sessions.restore([A])).toEqual({ restored: [{ threadId: A, title: "build the parser" }] });
    expect(await marks()).toEqual({ [L]: false, [A]: false, [A1]: true, [B]: false, [C]: false });
    h.end(3, "printer built");
    await settle();
    const all = await rt.sessions.settle([L]);
    expect(all.settled.map(s => s.threadId).sort()).toEqual([L, A, B, C].sort());
    expect((await rt.sessions.restore(all.settled.map(s => s.threadId))).restored.map(s => s.threadId).sort()).toEqual([L, A, B, C].sort());
    expect(await marks()).toEqual({ [L]: false, [A]: false, [A1]: true, [B]: false, [C]: false });
    await rt.close();
  });

  it("a restore of a thread named by a settle with finished takes back the finished threads that settle moved, and none settled before it", async () => {
    const { h, rt, L, A, A1, B, C, marks } = await tree();
    await rt.sessions.settle([A1]);
    const told: string[][] = [];
    rt.events.on("thread.marked", e => { if (e.type === "thread.marked") told.push([...e.threadIds]); });
    expect((await rt.sessions.settle([L], undefined, { finished: true })).settled.map(s => s.threadId)).toEqual([A]);
    // What it moved and the thread it named are written together, so the workspace is told once.
    expect(told).toEqual([[A, L]]);
    expect(await rt.sessions.restore([L])).toEqual({ restored: [{ threadId: A, title: "build the parser" }] });
    expect(await marks()).toEqual({ [L]: false, [A]: false, [A1]: true, [B]: false, [C]: false });
    h.end(3, "printer built");
    await rt.close();
  });

  it("a restore brings the named thread and its tree back, and only what was settled", async () => {
    const { h, rt, L, A, A1, B, C, marks } = await tree();
    await rt.sessions.settle([A]);
    expect(await rt.sessions.restore([A])).toEqual({ restored: [{ threadId: A, title: "build the parser" }, { threadId: A1, title: "write its tests" }] });
    expect(await marks()).toEqual({ [L]: false, [A]: false, [A1]: false, [B]: false, [C]: false });
    expect(await rt.sessions.restore([L])).toEqual({ restored: [] });
    h.end(3, "printer built");
    await rt.close();
  });

  it("a thread's own token settles and restores the threads under it, and is refused for its lead and a thread beside it, naming the thread", async () => {
    const { h, rt, L, A, A1, B, marks } = await tree();
    const asA = { origin: "relayed", by: { kind: "thread", threadId: A, workspaceId: (await rt.sessions.list()).find(r => r.threadId === A)!.workspaceId, rootThreadId: L } } satisfies Caller;
    expect(await rt.sessions.settle([A1], asA)).toEqual({ settled: [{ threadId: A1, title: "write its tests" }], left: [] });
    expect(await rt.sessions.restore([A1], asA)).toEqual({ restored: [{ threadId: A1, title: "write its tests" }] });
    expect((await rt.sessions.settle([A], asA, { finished: true })).settled.map(s => s.threadId)).toEqual([A1]);
    await expect(rt.sessions.settle([L], asA)).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${L.slice(0, 8)}`) });
    await expect(rt.sessions.settle([B], asA)).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${B.slice(0, 8)}`) });
    await expect(rt.sessions.restore([L], asA)).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`thread ${L.slice(0, 8)}`) });
    // A refused list moves nothing, the thread the token reaches included.
    await expect(rt.sessions.settle([A, B], asA)).rejects.toMatchObject({ kind: "usage" });
    expect((await marks())[A]).toBe(false);
    h.end(3, "printer built");
    await rt.close();
  });

  it("a subagent's id is refused, a subagent settling with its thread's turn, and a name nothing holds is not found", async () => {
    const { h, rt, ws, B } = await tree();
    const busy = (await rt.sessions.list(ws.id)).find(r => r.threadId === B)!;
    h.starts[3]!.onEvent({ type: "subagent", sessionId: busy.claudeSessionId!, task: "task_count", state: "running", parentToolUseId: "toolu_count", title: "count", depth: 1 });
    await settle();
    await expect(rt.sessions.settle(["task_count"])).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("a subagent settles with its lead's turn") });
    await expect(rt.sessions.settle(["thr_nobody"])).rejects.toMatchObject({ kind: "not-found", message: "no thread thr_nobo" });
    h.end(3, "printer built");
    await rt.close();
  });

  it("reads whether a thread is settled now in one place, which the settle, the restore and a slate's timers share", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const readers = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(path => path.endsWith(".ts") && readFileSync(join(src, path), "utf8").includes("threadSettled("));
    expect(readers).toEqual([join("machines", "boot.ts")]);
  });
});
