// SPDX-License-Identifier: AGPL-3.0-only
// A machine the provider stopped knowing settles its record to gone through
// one road, whichever call saw the 404: the poll, a nap, a wake's read or the
// sweep. The awake stretch closes there, the idle clock is dropped, the row's
// words name the call and the time, and the host log carries one line. A poll
// that began before the record settled lands nothing. A nap the provider
// refuses in words (Not pausable) is a refusal, not a vanish.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goneRefusal, goneWords, hostLostAnswer, type EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { createRuntime, type RuntimeOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubMachine } from "./stub-backend.js";
import { until } from "./until.js";

const WINDOW = 5 * 60_000;
const POLL = 15_000;
const COST = 60_000;
const T0 = Date.parse("2026-09-07T01:20:00Z");

type Cost = EventUnion & { type: "workspace.cost" };

function testRuntime(extra: Partial<RuntimeOptions> = {}) {
  const backend = stubBackend();
  const fc = fakeClock(T0);
  const rt = createRuntime({
    backend,
    store: memoryStore(),
    adapters: {},
    clock: fc.clock,
    idle: { defaultWindowMs: WINDOW },
    status: { costIntervalMs: COST, pollIntervalMs: POLL, reconcileMinMs: 0, probeTimeoutMs: 5_000 },
    ...extra,
  });
  const statuses: WorkspaceStatus[] = [];
  const costs: Cost[] = [];
  const events: EventUnion[] = [];
  rt.events.on("*", e => {
    events.push(e);
    if (e.type === "workspace.status") statuses.push(e.status);
    if (e.type === "workspace.cost") costs.push(e);
  });
  return { rt, backend, fc, statuses, costs, events };
}

const missing = (message: string) => Object.assign(new Error(message), { kind: "missing", status: 404 });

/** The provider's answer to a pause it will not do: what a 409 from the sandbox api reads as. */
const notPausable = () => Object.assign(new Error("Not pausable"), { kind: "conflict", status: 409 });

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
  openServers.length = 0;
});

/** The edge answers for the machine, not the daemon, and only when the test says: a probe waits in `held` until the test
 * answers it (404) or drops it (a failed reach); either way the poll goes on to ask the provider, in the order the test picks. */
async function edgeHolding(m: StubMachine): Promise<{ held: ServerResponse[]; fromDaemon: boolean; answer: (res: ServerResponse) => void; drop: (res: ServerResponse) => void }> {
  const held: ServerResponse[] = [];
  const server = createServer((_req, res) => void held.push(res));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  openServers.push(server);
  const port = (server.address() as { port: number }).port;
  m.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
  // fromDaemon set, the answer is the daemon's own (426), which sends nobody to the provider.
  const edge = { held, fromDaemon: false, answer: (res: ServerResponse) => void res.writeHead(edge.fromDaemon ? 426 : 404).end(), drop: (res: ServerResponse) => void res.destroy() };
  return edge;
}

const countReads = (m: StubMachine): { n: number } => {
  const state = m.state.bind(m);
  const reads = { n: 0 };
  m.state = async () => {
    reads.n++;
    return state();
  };
  return reads;
};

const goneLines = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map(c => String(c[0])).filter(l => /is gone/.test(l));

describe("a 404 settles the record gone through one road", () => {
  it("from the status poll: the stretch closes with a cost tick at that instant, the idle clock is dropped, the words name the poll and the time, one log line, and a poll that began before lands nothing", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const reads = countReads(m);
      const pause = vi.spyOn(m, "pause");
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => reads.n >= 1);
        fc.advance(COST);
        const polls = COST / POLL;
        await until(() => edge.held.length >= polls);
        // All but one of the polls the advance fired land now; the last stays in flight across the kill.
        for (const res of edge.held.splice(0, polls - 1)) edge.answer(res);
        await until(() => costs.some(c => c.awakeMs === COST) && reads.n >= polls);
        expect(costs.at(-1)).toMatchObject({ phase: "running", awakeMs: COST });
        expect(costs.at(-1)!.rateUsdPerHour).toBeCloseTo(0.11);

        m.killed = true;
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 2);
        edge.answer(edge.held.pop()!);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone" && costs.at(-1)!.phase === "gone");

        const record = await rt.workspaces.get(ws.id);
        expect(record.gone).toBe(goneWords("m1", { by: "status poll", at: seenAt }));
        expect(record.gone).toBe("machine m1 is gone at the provider: the status poll found it gone at 2026-09-07T01:21:15Z");
        const pushed = statuses.at(-1)!;
        expect(pushed).toMatchObject({ id: ws.id, phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: record.gone });
        expect(pushed.idleAt).toBeUndefined();
        expect((await rt.status.list())[0]!.idleAt).toBeUndefined();
        // The tick at the gone instant: the stretch ends at the last proof the machine was awake, and no rate follows.
        expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, awakeMs: COST, at: new Date(seenAt).toISOString() });
        const accrued = costs.at(-1)!.accruedUsd;
        fc.advance(COST);
        await until(() => costs.at(-1)!.at === new Date(fc.clock.now()).toISOString());
        expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, awakeMs: COST, accruedUsd: accrued });
        // The poll left in flight lands now, a minute on: its reach failed, it asks the provider and hears gone, and
        // the row it built on the running record it read is dropped, so nothing after the gone row says running.
        const rows = statuses.length;
        expect(reads.n).toBe(polls + 1);
        edge.drop(edge.held.shift()!);
        await until(() => reads.n >= polls + 2);
        await new Promise(r => setImmediate(r));
        expect(statuses.slice(rows)).toEqual([]);
        expect(edge.held.length).toBe(0);
        expect(goneLines(warn)).toEqual([`workspace ${ws.id} is gone: ${record.gone}`]);
        fc.advance(WINDOW * 2);
        expect(pause).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("from an idle nap: gone, not a refusal; no window re-armed, the words name the pause and quote the 404, the stretch closes, one log line", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      let calls = 0;
      m.pause = async () => {
        calls++;
        m.killed = true;
        throw missing("Sandbox not found");
      };
      fc.advance(WINDOW);
      const seenAt = fc.clock.now();
      await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone" && costs.at(-1)!.phase === "gone");

      const record = await rt.workspaces.get(ws.id);
      expect(record.gone).toBe(goneWords("m1", { by: "pause", at: seenAt, answer: "404 Sandbox not found" }));
      expect(record.gone).toBe("machine m1 is gone at the provider: the pause found it gone at 2026-09-07T01:25:00Z (404 Sandbox not found)");
      expect(statuses.map(s => s.phase)).toEqual(["pausing", "gone"]);
      expect(statuses.at(-1)).toMatchObject({ machineState: "gone", reach: { state: "gone" }, reason: record.gone });
      expect(statuses.at(-1)!.idleAt).toBeUndefined();
      expect((await rt.status.list())[0]!.idleAt).toBeUndefined();
      expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, at: new Date(seenAt).toISOString() });
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`workspace ${ws.id} is gone: ${record.gone}`]);
      fc.advance(WINDOW * 2);
      await new Promise(r => setImmediate(r));
      expect(calls).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("from a nap asked for: the caller hears the provider's error and the record is gone", async () => {
    const { rt, backend } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      backend.machines[0]!.pause = async () => {
        throw missing("Sandbox not found");
      };
      await expect(rt.workspaces.nap(ws.id)).rejects.toThrow("Sandbox not found");
      const record = await rt.workspaces.get(ws.id);
      expect(record.phase).toBe("gone");
      expect(record.gone).toMatch(/^machine m1 is gone at the provider: the pause found it gone at .* \(404 Sandbox not found\)$/);
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(goneRefusal("wake", record.gone));
    } finally {
      warn.mockRestore();
    }
  });

  it("from a wake's read of a record that says running: gone, and the wake is refused with the gone sentence", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.killed = true;
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow("Workspace machine is gone; rebuild it to wake");
      const record = await rt.workspaces.get(ws.id);
      expect(record.phase).toBe("gone");
      expect(record.gone).toMatch(/^machine m1 is gone at the provider: the wake found it gone at \S+Z$/);
      expect(statuses.at(-1)).toMatchObject({ phase: "gone", reason: record.gone });
      expect(m.resumes).toBe(0);
      expect(goneLines(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("from the sweep: a recorded machine the listing lacks is read once; gone settles the record, a machine still there is left alone", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const b = await rt.workspaces.create({ golden: "snap_g", name: "b" });
      const c = await rt.workspaces.create({ golden: "snap_g", name: "c" });
      const [ma, mb, mc] = backend.machines as [StubMachine, StubMachine, StubMachine];
      ma.killed = true;
      // The listing lags: b is missing from it but the provider still has it; c answers 404 in words to the read.
      const list = backend.list.bind(backend);
      backend.list = async labels => (await list(labels)).filter(r => r.id !== mb.id && r.id !== mc.id);
      const readsB = countReads(mb);
      mc.state = async () => {
        throw missing("Sandbox not found");
      };
      await rt.reap();

      expect((await rt.workspaces.get(a.id)).gone).toMatch(/^machine m1 is gone at the provider: the sweep found it gone at \S+Z$/);
      expect((await rt.workspaces.get(b.id)).phase).toBe("running");
      expect(readsB.n).toBe(1);
      expect((await rt.workspaces.get(c.id)).gone).toMatch(/^machine m3 is gone at the provider: the sweep found it gone at \S+Z \(404 Sandbox not found\)$/);
      expect(statuses.filter(s => s.phase === "gone").map(s => s.id).sort()).toEqual([a.id, c.id].sort());
      expect(goneLines(warn)).toHaveLength(2);
      // A second sweep asks nothing about a record already gone.
      const readsA = countReads(ma);
      await rt.reap();
      expect(readsA.n).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the host's metrics as the early warning", () => {
  /** How many times the provider was asked for the machine's state and for the host's metrics. */
  const countAsks = (m: StubMachine): { state: number; metrics: number } => {
    const asks = { state: 0, metrics: 0 };
    const state = m.state.bind(m);
    const metrics = m.metrics.bind(m);
    m.state = async () => {
      asks.state++;
      return state();
    };
    m.metrics = async () => {
      asks.metrics++;
      return metrics();
    };
    return asks;
  };
  const doubtLines = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map(c => String(c[0])).filter(l => /^host metrics for/.test(l));
  /** One status pass over the edge the test controls: the pass is awaited, so what it asked is known when it returns. */
  const pass = async (rt: ReturnType<typeof testRuntime>["rt"], edge: Awaited<ReturnType<typeof edgeHolding>>, reconcile: "always" | "on-failure"): Promise<WorkspaceStatus> => {
    const rows = rt.status.list({ reconcile });
    await until(() => edge.held.length >= 1);
    edge.answer(edge.held.shift()!);
    return (await rows)[0]!;
  };

  it("a metrics 404 with the daemon's probe missed on the same pass settles the record gone through the poll's road, with words that name the metrics read, and the idle window is dropped", async () => {
    const { rt, backend, fc, statuses, costs } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const asks = countAsks(m);
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.state >= 1 && asks.metrics >= 1);
        expect((await rt.workspaces.get(ws.id)).phase).toBe("running");

        m.hostLost = true;
        fc.advance(POLL);
        const seenAt = fc.clock.now();
        await until(() => edge.held.length >= 1);
        edge.drop(edge.held.shift()!);
        await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone" && costs.at(-1)!.phase === "gone");

        const record = await rt.workspaces.get(ws.id);
        // The gateway's own record never moved: the state read said running both times.
        expect(m.killed).toBe(false);
        expect(record.gone).toBe(goneWords("m1", { by: "status poll", at: seenAt, answer: hostLostAnswer("404 host no longer knows this VM") }));
        expect(record.gone).toBe("machine m1 is gone at the provider: the status poll found it gone at 2026-09-07T01:20:15Z (metrics 404 host no longer knows this VM; the state read still said running)");
        expect(statuses.at(-1)).toMatchObject({ id: ws.id, phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: record.gone });
        expect(statuses.at(-1)!.idleAt).toBeUndefined();
        expect((await rt.status.list())[0]!.idleAt).toBeUndefined();
        expect(costs.at(-1)).toMatchObject({ phase: "gone", rateUsdPerHour: 0, at: new Date(seenAt).toISOString() });
        expect(goneLines(warn)).toEqual([`workspace ${ws.id} is gone: ${record.gone}`]);
        expect(doubtLines(warn)).toEqual([]);
        expect(asks).toEqual({ state: 2, metrics: 2 });
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("a metrics 404 while the daemon answers on the same pass is one logged line and nothing else, on an explicit refresh too", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      edge.fromDaemon = true;
      const asks = countAsks(m);
      m.hostLost = true;

      const first = await pass(rt, edge, "always");
      expect(first).toMatchObject({ phase: "running", machineState: "running", reach: { state: "reachable" } });
      expect(first.reason).toBeUndefined();
      expect(asks).toEqual({ state: 1, metrics: 1 });
      expect(doubtLines(warn)).toEqual([`host metrics for m1 (workspace ${ws.id}) answered 404 host no longer knows this VM while the guest answered; the record stays running until the guest misses too`]);

      const second = await pass(rt, edge, "always");
      expect(second).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
      expect(asks).toEqual({ state: 2, metrics: 2 });
      expect(doubtLines(warn)).toHaveLength(1);
      expect(goneLines(warn)).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      expect(statuses.filter(s => s.machineState === "gone")).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("the edge speaking for the machine is not the daemon missing: a metrics 404 there leaves the record running while the guest still answers exec", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const asks = countAsks(m);
      m.hostLost = true;
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => doubtLines(warn).length === 1);
        fc.advance(POLL);
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.state >= 2);
      } finally {
        stop();
      }
      // A full pass after the poll's: anything the poll settled has landed by now.
      const row = await pass(rt, edge, "on-failure");
      expect(row).toMatchObject({ phase: "running", machineState: "running" });
      expect(asks).toEqual({ state: 3, metrics: 3 });
      expect(doubtLines(warn)).toHaveLength(1);
      expect(goneLines(warn)).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      expect(statuses.filter(s => s.machineState === "gone")).toEqual([]);
      expect(await m.exec("echo ok")).toMatchObject({ exitCode: 0 });

      // The guest missing on a later pass is the second witness the 404 was waiting for.
      const gone = rt.status.list({ reconcile: "on-failure" });
      await until(() => edge.held.length >= 1);
      edge.drop(edge.held.shift()!);
      expect((await gone)[0]).toMatchObject({ machineState: "gone", reach: { state: "gone" } });
    } finally {
      warn.mockRestore();
    }
  });

  it("a metrics read that fails any other way changes nothing, and metrics ride only the passes that ask the provider", async () => {
    const { rt, backend, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const edge = await edgeHolding(m);
      const metrics = m.metrics.bind(m);
      const asks = countAsks(m);
      let failing = true;
      m.metrics = async () => {
        asks.metrics++;
        if (failing) throw Object.assign(new Error("Bad Gateway"), { kind: "transient", status: 502 });
        return metrics();
      };
      const stop = rt.status.watch();
      try {
        await until(() => edge.held.length >= 1);
        edge.answer(edge.held.shift()!);
        await until(() => asks.metrics >= 1 && statuses.length >= 1);
        expect(asks).toEqual({ state: 1, metrics: 1 });
        expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
        expect(statuses.at(-1)).toMatchObject({ phase: "running", machineState: "running" });
        expect(warn.mock.calls).toEqual([]);
      } finally {
        stop();
      }

      // The guest answers the next passes itself: the provider is not asked, so neither are its metrics.
      failing = false;
      edge.fromDaemon = true;
      expect(await pass(rt, edge, "on-failure")).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
      expect(await pass(rt, edge, "on-failure")).toMatchObject({ machineState: "running", reach: { state: "reachable" } });
      expect(asks).toEqual({ state: 1, metrics: 1 });
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a nap the provider refuses in words", () => {
  it("Not pausable is a refusal: one full window from the answer, the words on the row, the log names the provider's answer, and the record stays running", async () => {
    const { rt, backend, fc, statuses } = testRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      const pause = m.pause.bind(m);
      let calls = 0;
      let refusing = true;
      m.pause = async () => {
        calls++;
        if (refusing) throw notPausable();
        await pause();
      };
      fc.advance(WINDOW);
      const answered = fc.clock.now();
      await until(() => statuses.some(s => s.phase === "running" && s.idleAt === answered + WINDOW));
      expect(calls).toBe(1);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
      const last = statuses.at(-1)!;
      expect(last).toMatchObject({ phase: "running", machineState: "running", reason: "Not pausable", idleAt: answered + WINDOW });
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`idle nap of ${ws.id} was answered with 409 Not pausable; a full 5 min window starts over`]);
      fc.advance(WINDOW - 1);
      await new Promise(r => setImmediate(r));
      expect(calls).toBe(1);
      refusing = false;
      fc.advance(1);
      await until(async () => (await rt.workspaces.get(ws.id)).phase === "napping");
      expect(calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});
