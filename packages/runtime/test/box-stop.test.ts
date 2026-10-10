// SPDX-License-Identifier: AGPL-3.0-only
// A Stop on a running turn of a thread in a folder on a computer the person
// joined, with that computer away or not answering: the row settles at once,
// the answer says so, and the end of the thread's cgroup is kept in the state
// file and run there when the computer dials back, across a host restart too.
// A send behind that end waits for it, says so, and a Stop or a delete gives it
// up. The agent is the real Claude adapter over a fake computer on the link.
import { describe, expect, it, vi } from "vitest";
import { cgroupEndScript, sendGivenUpLine, threadCgroup, threadEndAwayLine, threadEndLateLine, threadLeftLine, type EventUnion, type SessionInterruptResult } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { memoryStore, type Store } from "../src/store.js";
import type { PlaceKeyPair } from "../src/places.js";
import { stubBackend } from "./stub-backend.js";
import { ctx, placesOf, relink, sockets } from "./places-fixture.js";
import { report, wiring } from "./place-join.js";
import { box, HETZNER, joined, type Box } from "./box-fixture.js";
import { until } from "./until.js";

const ADAPTERS = { claude: HARNESS_ADAPTERS.claude };
const BACK = report("hetzner", { login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } });
const END = (threadId: string): string => cgroupEndScript(threadCgroup(threadId), { remove: true });

/** What a promise settled to, or that it was still waiting after `ms`. */
const within = <T,>(stop: Promise<T>, ms: number): Promise<T | "still waiting"> =>
  Promise.race([stop, new Promise<"still waiting">(resolve => setTimeout(() => resolve("still waiting"), ms))]);
/** A send's own end: launched, or the words it was refused with. */
const settled = (send: Promise<unknown>): Promise<string> => send.then(() => "launched", (e: unknown) => (e instanceof Error ? e.message : String(e)));

/** A host holding hetzner with a turn of the real Claude adapter running on it. */
async function running() {
  const store = memoryStore();
  const held = await joined({ store, adapters: ADAPTERS });
  const at = await held.rt.workspaces.folderFor({ project: held.project.id });
  const turn = await held.rt.sessions.start(at.workspace.id, { prompt: "work", harness: "claude" });
  await until(() => held.seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED")));
  const threadId = turn.view().threadId!;
  /** hetzner dialling in again, answering as before, and every frame it is sent kept. */
  const back = async (endMs?: Box["endMs"], endFails = false): Promise<Box> => {
    let again!: Box;
    const linked = await relink(held.hostKey, held.placeId, held.pair, BACK, c => {
      again = box(c, HETZNER);
      if (endMs !== undefined) again.endMs = endMs;
      again.endFails = endFails;
    });
    sockets.push(linked.client.ws);
    return again;
  };
  return { ...held, store, workspaceId: at.workspace.id, turn, threadId, back };
}

/** The host stopped and started again on the same state file and key, with the box's link gone with it. */
async function restart(store: Store, hostKey: PlaceKeyPair): Promise<void> {
  for (const ws of sockets.splice(0)) ws.close();
  await ctx.srv!.close();
  await ctx.runtime!.close();
  ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: ADAPTERS, placeLinks: wiring(hostKey) });
  ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
}

const rowOf = async (workspaceId: string, id: string) => (await ctx.runtime!.sessions.list(workspaceId)).find(s => s.id === id)!;
/** A send into the thread, once the host has said it waits: what it settled to. */
async function heldSend(workspaceId: string, threadId: string, requestId: string): Promise<{ send: Promise<string> }> {
  const said: string[] = [];
  const off = ctx.runtime!.events.on("*", e => {
    if (e.type === "session.queued" && e.requestId === requestId) said.push(requestId);
  });
  const send = settled(ctx.runtime!.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: threadId, requestId }));
  await until(() => said.length > 0);
  off();
  return { send };
}
const heldRow = async (workspaceId: string, threadId: string) => (await ctx.runtime!.sessions.list(workspaceId)).find(s => s.threadId === threadId && s.status === "running");

/** The box gone from this host, as its socket closing tells it. */
async function away(placeId: string): Promise<void> {
  for (const ws of sockets.splice(0)) ws.close();
  await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
}

/** That the box ran the thread's end once, and only then took a launch. */
function endedThenLaunched(again: Box, threadId: string): void {
  const cmds = again.execs.map(e => e.cmd);
  expect(cmds.filter(cmd => cmd === END(threadId))).toHaveLength(1);
  expect(again.order.indexOf("end answers")).toBeGreaterThanOrEqual(0);
  expect(again.order.indexOf("end answers")).toBeLessThan(again.order.indexOf("launch"));
}

describe("the host log of a stop on a box turn", () => {
  it("writes one line per stop naming the thread and its answer, the away sentence the transcript carries too", async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      const { rt, placeId, workspaceId, turn, threadId } = await running();
      await away(placeId);
      expect(await rt.sessions.interrupt(turn.id)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
      expect(await rt.sessions.interrupt(turn.id)).toMatchObject({ outcome: "not-running" });
      expect(await rt.sessions.interrupt("sess_nobody")).toEqual({ outcome: "not-found" });
      expect(lines.filter(line => line.startsWith("stop on thread"))).toEqual([
        `stop on thread ${threadId.slice(0, 8)}: accepted (${threadEndAwayLine("hetzner")})`,
        `stop on thread ${threadId.slice(0, 8)}: not-running`,
        "stop on thread sess_nob: not-found",
      ]);
      const done = (await rt.sessions.history(workspaceId)).filter(e => e.type === "session.done" && e.turnId === turn.turnId);
      expect(done.map(e => (e.type === "session.done" ? e.result : undefined))).toEqual([{ status: "interrupted", error: threadEndAwayLine("hetzner"), unreached: true }]);
    } finally {
      warn.mockRestore();
    }
  }, 15_000);
});

describe("a stop on a running box turn while the box is away", () => {
  it("answers at once when the host reads the box away, settles the row and ends the thread there at its next link", async () => {
    const { rt, store, placeId, workspaceId, turn, threadId, back } = await running();
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);

    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    expect((await rowOf(workspaceId, turn.id)).status).toBe("interrupted");
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });
    // The transcript says stopped too, which is what the app reads the turn by.
    const done = (await rt.sessions.history(workspaceId)).filter(e => e.type === "session.done" && e.turnId === turn.turnId);
    expect(done.map(e => (e.type === "session.done" ? e.result.status : undefined))).toEqual(["interrupted"]);

    const again = await back();
    await until(() => again.execs.some(e => e.cmd === END(threadId)));
    await until(async () => (await store.get("thread-ends", placeId)) === undefined);
  }, 15_000);

  it("holds a send behind the stop until the box is back and has ended the thread, then launches it", async () => {
    const { rt, workspaceId, turn, threadId, placeId, back } = await running();
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });

    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    let launched = false;
    const next = rt.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: threadId, requestId: "req_held" }).then(handle => ((launched = true), handle));
    expect(await within(next.then(() => ({ outcome: "accepted" as const })), 500)).toBe("still waiting");
    expect(launched).toBe(false);
    // The person is told what it waits for, by the request it answers.
    expect(events.filter(e => e.type === "session.queued").map(e => (e.type === "session.queued" ? { requestId: e.requestId, waitsFor: e.waitsFor } : undefined))).toEqual([{ requestId: "req_held", waitsFor: "hetzner" }]);
    // So does its row, for a window opened after that.
    expect((await heldRow(workspaceId, threadId))?.waitsFor).toBe("hetzner");

    const again = await back();
    const launchedRow = await next;
    expect((await rowOf(workspaceId, launchedRow.id)).waitsFor).toBeUndefined();
    await until(() => again.execs.some(e => e.cmd.includes("WSP_LAUNCHED")));
    const cmds = again.execs.map(e => e.cmd);
    expect(cmds.indexOf(END(threadId))).toBeGreaterThanOrEqual(0);
    expect(cmds.indexOf(END(threadId))).toBeLessThan(cmds.findIndex(cmd => cmd.includes("WSP_LAUNCHED")));
  }, 15_000);

  it("tells every send behind the stopped turn that it waits for the box, by name, the one queued before the Stop too", async () => {
    const { rt, placeId, workspaceId, turn, threadId } = await running();
    await away(placeId);
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await heldSend(workspaceId, threadId, "req_before");
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    // Its row says so too, for a window opened after, and is the one a Stop gives up.
    expect((await heldRow(workspaceId, threadId))?.waitsFor).toBe("hetzner");
    await heldSend(workspaceId, threadId, "req_first");
    await heldSend(workspaceId, threadId, "req_second");

    expect(events.filter(e => e.type === "session.queued").map(e => (e.type === "session.queued" ? { requestId: e.requestId, waitsFor: e.waitsFor } : undefined))).toEqual([
      { requestId: "req_before", waitsFor: undefined },
      { requestId: "req_before", waitsFor: "hetzner" },
      { requestId: "req_first", waitsFor: "hetzner" },
      { requestId: "req_second", waitsFor: "hetzner" },
    ]);
  }, 15_000);

  it("hands the row to the next send waiting on the box when a Stop gives the holder up, so a second Stop gives that one up too", async () => {
    const { rt, placeId, workspaceId, turn, threadId } = await running();
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    const { send: first } = await heldSend(workspaceId, threadId, "req_first");
    const { send: second } = await heldSend(workspaceId, threadId, "req_second");
    const firstRow = (await heldRow(workspaceId, threadId))!;

    expect(await within(rt.sessions.interrupt(firstRow.id), 2000)).toEqual({ outcome: "accepted", left: sendGivenUpLine("hetzner") });
    expect(await within(first, 2000)).toBe(sendGivenUpLine("hetzner"));
    await until(async () => (await heldRow(workspaceId, threadId)) !== undefined);
    const secondRow = (await heldRow(workspaceId, threadId))!;
    expect(secondRow.id).not.toBe(firstRow.id);
    expect(secondRow.waitsFor).toBe("hetzner");

    expect(await within(rt.sessions.interrupt(secondRow.id), 2000)).toEqual({ outcome: "accepted", left: sendGivenUpLine("hetzner") });
    expect(await within(second, 2000)).toBe(sendGivenUpLine("hetzner"));
    expect(await heldRow(workspaceId, threadId)).toBeUndefined();
  }, 15_000);

  it("tells a send that waited on the box it waits behind the turn that launched at the box's return", async () => {
    const { rt, placeId, workspaceId, turn, threadId, back } = await running();
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const { send: first } = await heldSend(workspaceId, threadId, "req_first");
    await heldSend(workspaceId, threadId, "req_second");

    const again = await back();
    expect(await within(first, 5000)).toBe("launched");
    await until(() => again.order.includes("launch"));
    await until(() => events.filter(e => e.type === "session.queued" && e.requestId === "req_second").length === 2);
    expect(events.filter(e => e.type === "session.queued").map(e => (e.type === "session.queued" ? { requestId: e.requestId, waitsFor: e.waitsFor } : undefined))).toEqual([
      { requestId: "req_first", waitsFor: "hetzner" },
      { requestId: "req_second", waitsFor: "hetzner" },
      { requestId: "req_second", waitsFor: undefined },
    ]);
  }, 15_000);

  it("leaves a stop on a box that answers as it was: the agent's own stop, then the thread's end there, nothing owed", async () => {
    const { rt, seen, store, placeId, workspaceId, turn, threadId } = await running();
    expect(await rt.sessions.interrupt(turn.id)).toEqual({ outcome: "accepted" });
    const done = (await rt.sessions.history(workspaceId)).filter(e => e.type === "session.done" && e.turnId === turn.turnId);
    expect(done.map(e => (e.type === "session.done" ? e.result.unreached : "none"))).toEqual([undefined]);
    expect(seen.kills.some(cmd => cmd.includes("kill -TERM"))).toBe(true);
    expect(seen.execs.some(e => e.cmd === cgroupEndScript(threadCgroup(threadId)))).toBe(true);
    expect((await rowOf(workspaceId, turn.id)).status).toBe("interrupted");
    expect(await store.get("thread-ends", placeId)).toBeUndefined();
  }, 15_000);

  it("takes the same road when the box stops answering with its socket still open", async () => {
    const { rt, seen, store, placeId, workspaceId, turn, threadId } = await running();
    seen.quiet = true;

    expect(await within(rt.sessions.interrupt(turn.id), 6000)).toEqual({ outcome: "accepted", left: threadEndLateLine("hetzner", 3) });
    expect((await rowOf(workspaceId, turn.id)).status).toBe("interrupted");
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });
  }, 15_000);

  it("reads right after a host restart while the turn runs and the box is away, and ends it there when the box is back", async () => {
    const { store, hostKey, placeId, workspaceId, turn, threadId, back } = await running();
    await restart(store, hostKey);
    const rt = ctx.runtime!;
    expect((await rowOf(workspaceId, turn.id)).status).toBe("running");

    expect(await within(rt.sessions.interrupt(turn.id), 6000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    expect((await rowOf(workspaceId, turn.id)).status).toBe("interrupted");
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });

    const again = await back();
    await until(() => again.execs.some(e => e.cmd === END(threadId)));
    await until(async () => (await store.get("thread-ends", placeId)) === undefined);
  }, 20_000);

  it("holds a send after a host restart until the end the stop owed has run on the box, then launches it", async () => {
    const { rt: first, store, hostKey, placeId, workspaceId, turn, threadId, back } = await running();
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    expect(await within(first.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    await restart(store, hostKey);

    const next = ctx.runtime!.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: threadId });
    expect(await within(next.then(() => ({ outcome: "accepted" as const })), 500)).toBe("still waiting");

    const again = await back();
    await next;
    await until(() => again.execs.some(e => e.cmd.includes("WSP_LAUNCHED")));
    const cmds = again.execs.map(e => e.cmd);
    expect(cmds.indexOf(END(threadId))).toBeGreaterThanOrEqual(0);
    expect(cmds.indexOf(END(threadId))).toBeLessThan(cmds.findIndex(cmd => cmd.includes("WSP_LAUNCHED")));
  }, 20_000);

  it("keeps the first Stop's hold through a second Stop on the stopped turn: the end runs once at the return, then the held send launches", async () => {
    const { rt, placeId, workspaceId, turn, threadId, back } = await running();
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    const { send: next } = await heldSend(workspaceId, threadId, "req_p2");
    expect(await rt.sessions.interrupt(turn.id)).toEqual({ outcome: "not-running" });

    const again = await back();
    expect(await within(next, 5000)).toBe("launched");
    await until(() => again.order.includes("launch"));
    endedThenLaunched(again, threadId);
  }, 15_000);

  it("gives a send held behind the end up when it is stopped, says so, and the thread runs again once the box is back", async () => {
    const { rt, placeId, workspaceId, turn, threadId, back } = await running();
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    const { send: next } = await heldSend(workspaceId, threadId, "req_held");

    expect(await within(rt.sessions.interrupt((await heldRow(workspaceId, threadId))!.id), 2000)).toEqual({ outcome: "accepted", left: sendGivenUpLine("hetzner") });
    expect(await within(next, 2000)).toBe(sendGivenUpLine("hetzner"));
    expect(await heldRow(workspaceId, threadId)).toBeUndefined();

    const again = await back();
    await until(() => again.execs.some(e => e.cmd === END(threadId)));
    expect(await within(settled(rt.sessions.start(workspaceId, { prompt: "again", harness: "claude", thread: threadId })), 5000)).toBe("launched");
    await until(() => again.order.includes("launch"));
    endedThenLaunched(again, threadId);
  }, 15_000);

  it("deletes a thread whose only work is a send held behind the end, and gives that send up", async () => {
    const { rt, store, placeId, workspaceId, turn, threadId } = await running();
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    const { send: next } = await heldSend(workspaceId, threadId, "req_held");

    expect(await within(rt.sessions.delete(threadId), 2000)).toEqual({ workspaceId, threads: 1 });
    expect(await within(next, 2000)).toBe(sendGivenUpLine("hetzner"));
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });
  }, 15_000);

  it("takes a thread off the state file before it frees the send waiting on it, so a send made while another thread's end is out launches", async () => {
    const { rt, seen, placeId, workspaceId, turn, threadId, back } = await running();
    const other = await rt.sessions.start(workspaceId, { prompt: "other", harness: "claude" });
    const otherThread = other.view().threadId!;
    await until(() => seen.execs.filter(e => e.cmd.includes("WSP_LAUNCHED")).length === 2);
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });
    expect(await within(rt.sessions.interrupt(other.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });

    // The other thread's end answers late, so the send below lands while the return is still paying it.
    const again = await back(cmd => (cmd === END(otherThread) ? 60_000 : 0));
    await until(() => again.order.join(",") === "end starts,end answers,end starts");
    expect(await within(settled(rt.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: threadId })), 3000)).toBe("launched");
  }, 15_000);

  it("holds a send that waited behind the running turn through the Stop until the end has answered at the return, however slow the end is", async () => {
    const { rt, placeId, workspaceId, turn, threadId, back } = await running();
    await away(placeId);
    const next = settled(rt.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: threadId }));
    expect(await within(next, 300)).toBe("still waiting");
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });

    // Slower than the stopped turn's own process takes to settle, which the send also waits for.
    const again = await back(() => 9000);
    expect(await within(next, 15_000)).toBe("launched");
    await until(() => again.order.includes("launch"));
    endedThenLaunched(again, threadId);
  }, 30_000);

  it("clears the end it ran at the return whatever survived it, so a send with the box connected launches, and a Stop there names what survived", async () => {
    const { rt, store, placeId, workspaceId, turn, threadId, back } = await running();
    await away(placeId);
    expect(await within(rt.sessions.interrupt(turn.id), 2000)).toEqual({ outcome: "accepted", left: threadEndAwayLine("hetzner") });

    const again = await back(undefined, true);
    await until(() => again.order.includes("end answers"));
    await until(async () => (await store.get("thread-ends", placeId)) === undefined);
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const next = rt.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: threadId });
    expect(await within(settled(next), 3000)).toBe("launched");
    expect(events.some(e => e.type === "session.queued")).toBe(false);

    // With the box connected, a Stop runs the end at once and says what it left; nothing is owed.
    expect(await rt.sessions.interrupt((await next).id)).toEqual({ outcome: "accepted", left: threadLeftLine("hetzner", [4242]) });
    expect(await store.get("thread-ends", placeId)).toBeUndefined();
  }, 15_000);
});
