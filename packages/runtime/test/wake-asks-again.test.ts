// SPDX-License-Identifier: AGPL-3.0-only
// A wake the provider never takes: the resume is cut off at its cap and the row
// says so there, the host asks again on its own once a cadence, the person can
// stop it from the row, and a resume the provider finally takes ends the wake
// with the machine running. The provider here is a backend whose resume answers
// nothing at all, which is what Solari's did for every paused machine on the
// account on 2026-09-10.
import { describe, expect, it, vi } from "vitest";
import { needsRebuild, RESUME_CAP_MS, RESUME_UNANSWERED, WAKE_ASKS_AGAIN, WAKE_ASK_EVERY_MS, WAKE_STOPPED, wakeAskingAgainLine, wakeGaveUpLine, type EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { createRuntime, type RuntimeOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { abortedCall, cappedCall, stubBackend, type StubMachine } from "./stub-backend.js";
import { until } from "./until.js";

/** The cadence between asks, shaped like the shipped one and short enough to count in whole ticks. The cap is the
 * engine's own and no longer the runtime's, so the fake provider is the one that fires it, when the test says so. */
const EVERY = 60;
/** The head of the line a run that gave up ends with; the test steps the clock in whole cadences, so the span it
 * names is not exact. */
const GAVE_UP = /^the provider answered none of \d+ resume requests over /;

function rig(wake: RuntimeOptions["wake"]) {
  const backend = stubBackend();
  const store = memoryStore();
  const fc = fakeClock();
  const rt = createRuntime({ backend, store, adapters: {}, clock: fc.clock, wake: { askEveryMs: EVERY, ...wake } });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e));
  const rows = (): WorkspaceStatus[] => events.filter(e => e.type === "workspace.status").map(e => (e.type === "workspace.status" ? e.status : null)!);
  return { backend, store, fc, rt, events, rows };
}

/** The provider as the probe found it: the resume is taken and never answered, until the engine's cap cuts it off or
 * the caller's own stop does. `cap()` fires the cap on whatever call is in flight, which is what the engine's
 * AbortSignal.timeout does on the real road; `takes` lets a later call land at once. */
function deafResume(machine: StubMachine) {
  const state = { calls: 0, takes: false, cap: () => {} };
  machine.resume = async (signal?: AbortSignal) => {
    state.calls++;
    if (state.takes) {
      machine.paused = false;
      return;
    }
    return new Promise<never>((_resolve, reject) => {
      state.cap = () => reject(cappedCall(`resume of ${machine.id}`));
      signal?.addEventListener("abort", () => reject(abortedCall(`resume of ${machine.id}`)), { once: true });
    });
  };
  return state;
}

/** Fires the cap on the call in flight and moves the clock a cadence, over and over until cond holds, so the test
 * never advances past a timer the runtime has not scheduled yet; fake time costs nothing, so a step taken early is
 * simply taken again. */
async function tick(fc: ReturnType<typeof fakeClock>, cap: () => void, cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("the runtime did not get there in time");
    cap();
    await new Promise(r => setTimeout(r, 5));
    fc.advance(EVERY);
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The wake's outcome as a value, watched from the instant it starts so a rejection is never left unheld while the
 * test moves the clock; `ended` says when the clock has been moved far enough for the wake to be over. */
function watch(waking: Promise<unknown>): { outcome: Promise<string>; ended: () => boolean } {
  let over = false;
  const outcome = waking.then(() => "woke", (e: unknown) => (e instanceof Error ? e.message : String(e))).finally(() => { over = true; });
  return { outcome, ended: () => over };
}

describe("a wake the provider does not answer", () => {
  it("says the provider has not answered and that the machine is being read, as soon as the resume runs its cap out", async () => {
    const { backend, fc, rt, rows } = rig({ deadlineMs: 6 * 60_000, asksAgain: 1 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const began = fc.clock.now();
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      // The engine's cap is the only timer on the call, so the provider's own is what fires here and the runtime's
      // clock has not moved: the row speaks on the call, never on the wake's six-minute deadline.
      deaf.cap();
      await until(() => rows().some(r => r.reason === RESUME_UNANSWERED));
      expect(fc.clock.now()).toBe(began);
      expect(rows().find(r => r.reason === RESUME_UNANSWERED)!.phase).toBe("waking");
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
      expect(deaf.calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks again on its own once a cadence, counting the asks on the row, and stops at the count it was given", async () => {
    const { backend, fc, rt, rows } = rig({ asksAgain: 3 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
    } finally {
      warn.mockRestore();
    }
    // One ask of the person's and three of the host's, and the row counted each of the host's own.
    expect(deaf.calls).toBe(4);
    // The numbers ride, so the row and the Machine tab each read them at the length they have room for.
    expect([...new Set(rows().map(r => r.wakeAsk).filter(a => a !== undefined).map(a => `${a.ask}/${a.of}`))]).toEqual(["1/3", "2/3", "3/3"]);
    expect(wakeAskingAgainLine(3, 3)).toBe("waking, asking again (3 of 3)");
    expect(wakeAskingAgainLine(3, 3, "short")).toBe("asking 3/3");
    // The row is a paused workspace again, with the provider's silence as its last word.
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(rows().at(-1)!.phase).toBe("napping");
    expect(rows().at(-1)!.reason).toMatch(GAVE_UP);
  });

  it("reads before it asks again, sends no second resume at one that came up, and still checks the guest and ends first life", async () => {
    const { backend, fc, rt, store, rows } = rig({ asksAgain: 30 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    expect(await store.get("workspaces", ws.id)).toMatchObject({ firstLife: true });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    const deaf = deafResume(m);
    // The wake check reads the machine's shape; counting that read is how a wake that skipped the check is caught.
    let shapeReads = 0;
    const describe = m.describe!.bind(m);
    m.describe = async () => {
      shapeReads++;
      return describe();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let woken;
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      deaf.cap();
      await until(() => rows().some(r => r.wakeAsk?.ask === 1));
      // The call that hung at the provider goes through while the host waits out its cadence, as the probe measured
      // a pause doing: no answer in 30 s, the machine moved 40 s later.
      m.paused = false;
      await tick(fc, () => deaf.cap(), watched.ended);
      woken = await watched.outcome;
    } finally {
      warn.mockRestore();
    }
    expect(woken).toBe("woke");
    expect(deaf.calls).toBe(1);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    // The same road as a resume whose call answered: the guest was checked, and a machine that has been resumed is
    // out of first life, which is the fence the snapshot rule stands on.
    expect(shapeReads).toBe(1);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ firstLife: false });
  });

  it("leaves the rebuild road on the record when the asking runs out, and a wake that lands takes it away", async () => {
    const { backend, fc, rt, store, rows } = rig({ asksAgain: 2 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const m = backend.machines[0]!;
    const deaf = deafResume(m);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await tick(fc, () => deaf.cap(), watched.ended);
      expect(await watched.outcome).toMatch(GAVE_UP);
    } finally {
      warn.mockRestore();
    }
    const left = await rt.workspaces.get(ws.id);
    // One ask of the person's and two of the host's, and the record keeps the whole sentence: what the provider did,
    // where the work is, and the road to a machine now.
    expect(left.wakeRefused).toContain("none of 3 resume requests");
    expect(left.wakeRefused).toContain("the work on this machine's disk stays with the provider");
    expect(left.wakeRefused).toContain("a rebuild starts a new machine from the image");
    expect(rows().at(-1)!.reason).toBe(left.wakeRefused);
    expect(rows().at(-1)!.wakeAsk).toBeUndefined();
    // The row offers the rebuild, which before this only a gone or zombie machine did, and the wake beside it.
    expect(needsRebuild({ phase: left.phase, machineState: "paused", reach: "napping", wakeRefused: left.wakeRefused })).toBe(true);
    expect(needsRebuild({ phase: left.phase, machineState: "paused", reach: "napping" })).toBe(false);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ wakeRefused: left.wakeRefused });
    // Every poll after it carries the road too: a row built from the record alone still offers the rebuild.
    expect((await rt.status.list())[0]).toMatchObject({ phase: "napping", reason: left.wakeRefused });
    // The provider comes back: the wake lands and the road goes with the fault that made it.
    m.resume = async () => { m.paused = false; };
    expect((await rt.workspaces.wake(ws.id)).wakeRefused).toBeUndefined();
    expect((await store.get("workspaces", ws.id) as { wakeRefused?: string }).wakeRefused).toBeUndefined();
    expect((await rt.status.list())[0]!.reason).toBeUndefined();
  });

  it("stops when the person stops it from the row, while the host waits to ask again", async () => {
    const { backend, fc, rt, store, rows } = rig({ asksAgain: 30 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const waking = rt.workspaces.wake(ws.id);
      await until(() => deaf.calls === 1);
      deaf.cap();
      await until(() => rows().some(r => r.wakeAsk?.ask === 1));
      const left = await rt.workspaces.stopWake(ws.id);
      expect(left.phase).toBe("napping");
      await expect(waking).rejects.toThrow(WAKE_STOPPED);
    } finally {
      warn.mockRestore();
    }
    expect(deaf.calls).toBe(1);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
    expect(rows().at(-1)).toMatchObject({ phase: "napping", reason: WAKE_STOPPED });
    // Nothing asks again after the stop: the cadence's timer is spent with no call behind it.
    fc.advance(EVERY * 5);
    await new Promise(r => setTimeout(r, 20));
    expect(deaf.calls).toBe(1);
  });

  it("stops while the host is on a call by ending it, and a cap that fires after says nothing on the paused row", async () => {
    const { backend, fc, rt, rows } = rig({ asksAgain: 30 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const waking = rt.workspaces.wake(ws.id);
    await until(() => deaf.calls === 1);
    // The call is nowhere near its cap; the stop is what ends it, so nothing goes on running behind the wake.
    await rt.workspaces.stopWake(ws.id);
    await expect(waking).rejects.toThrow(WAKE_STOPPED);
    expect(deaf.calls).toBe(1);
    expect(rows().at(-1)).toMatchObject({ phase: "napping", reason: WAKE_STOPPED });
    // The provider's cap fires on the call the stop already ended, and the whole cadence passes: a settled stop wins,
    // so no poll of a paused row ever says the machine is being read about.
    deaf.cap();
    fc.advance(EVERY * 3);
    await new Promise(r => setTimeout(r, 20));
    expect(rows().at(-1)).toMatchObject({ phase: "napping", reason: WAKE_STOPPED });
    const polled = (await rt.status.list())[0]!;
    expect(polled.phase).toBe("napping");
    expect([polled.reason, polled.wakeAsk]).toEqual([undefined, undefined]);
    expect(deaf.calls).toBe(1);
  });

  it("a resume the provider finally takes ends the wake with the machine running, however many asks it took", async () => {
    const { backend, fc, rt, events } = rig({ asksAgain: 30 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let woken;
    try {
      const waking = rt.workspaces.wake(ws.id);
      await until(() => deaf.calls === 1);
      deaf.takes = true;
      await tick(fc, () => deaf.cap(), () => deaf.calls === 2);
      woken = await waking;
    } finally {
      warn.mockRestore();
    }
    expect(woken.phase).toBe("running");
    expect(deaf.calls).toBe(2);
    expect(events.filter(e => e.type === "workspace.woken").map(e => e.type === "workspace.woken" && e.workspaceId)).toEqual([ws.id]);
  });

  it("keeps the line on every status the poll builds, so the row does not fall silent between two asks", async () => {
    const { backend, fc, rt } = rig({ asksAgain: 30 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    await rt.workspaces.nap(ws.id);
    const deaf = deafResume(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watched = watch(rt.workspaces.wake(ws.id));
      await until(() => deaf.calls === 1);
      deaf.cap();
      await until(async () => (await rt.status.list()).some(r => r.wakeAsk?.ask === 1));
      // A poll builds its rows from the record alone, so this is the row a client that missed the push would draw.
      expect((await rt.status.list())[0]).toMatchObject({ phase: "waking", wakeAsk: { ask: 1, of: 30 } });
      await rt.workspaces.stopWake(ws.id);
      await watched.outcome;
      // The wake is over, so the ask goes with it and the row keeps only what the poll can see for itself.
      expect((await rt.status.list())[0]!.wakeAsk).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("a stop asked of a workspace with no wake in flight answers with the record as it stands", async () => {
    const { rt } = rig({});
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    expect((await rt.workspaces.stopWake(ws.id)).phase).toBe("running");
  });

  it("ships a cap of half a minute and half an hour of asking", () => {
    expect(RESUME_CAP_MS).toBe(30_000);
    expect(WAKE_ASK_EVERY_MS).toBe(60_000);
    expect(WAKE_ASKS_AGAIN).toBe(30);
    expect(wakeGaveUpLine(31, WAKE_ASKS_AGAIN * WAKE_ASK_EVERY_MS)).toContain("none of 31 resume requests over 30m");
  });
});
