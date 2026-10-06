// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { imageServedWaitLine } from "@wsp/protocol";
import type { EventUnion } from "@wsp/protocol";
import { DISK_SYNC_CMD, type ExecResult } from "@wsp/engine";
import { copyKey, createRuntime, wiredPlace } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { droppingPort } from "./held-port.js";
import { stubBackend, tokenGuest, createOn } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { TOKEN_PATH, TOKEN, withDaemon } from "./runtime-fixture.js";

describe("runtime create stages", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  /** A stub whose forks carry an edge route to the given port and whose guest hands out the daemon token. */
  function edgeBackend(port: number) {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = await create(spec);
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      return m;
    };
    return backend;
  }
  const creating = (events: EventUnion[]) => events.filter(e => e.type === "workspace.creating");

  it("a plain create reports every awaited step in order, names the hostname before the daemon is asked, and announces created last", async () => {
    await withDaemon(async port => {
      const backend = edgeBackend(port);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
      const stages = creating(events);
      expect(stages.map(e => e.stage)).toEqual(["fork-requested", "hostname-set", "preview-route", "daemon-answering", "project-cloned", "ready"]);
      // No line for the machine coming up and no fork's id anywhere: the starting line is the step a person waits
      // through, and the row draws it for the whole boot.
      expect(stages.map(e => e.message)).toEqual([
        "starting task-1 on default",
        "hostname set to task-1",
        "Preview route to the daemon minted.",
        "Daemon answered.",
        // The remote the record keeps, which is what the clone on the machine takes, and where it lands inside.
        expect.stringMatching(/^Cloning https:\/\/github\.com\/wsp\/stub-\d+\.git into \/root\/stub-\d+\.$/),
        "ready",
      ]);
      for (const e of stages) expect(e.message).not.toContain(backend.machines[0]!.id);
      for (const e of stages) expect(e).toMatchObject({ workspaceId: ws.id, name: "task-1", elapsedMs: expect.any(Number) });
      expect(stages.some(e => "notice" in e)).toBe(false);
      const log = backend.machines[0]!.execLog;
      expect(log.indexOf("hostname task-1 && echo task-1 > /etc/hostname")).toBeLessThan(log.findIndex(c => c.includes(TOKEN_PATH)));
      const ready = events.findIndex(e => e.type === "workspace.creating" && e.stage === "ready");
      expect(events.findIndex(e => e.type === "workspace.created")).toBe(ready + 1);
    });
  });

  it("a provider's wait for the image it forks from is a line of the create, under the step it waits in", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const create = backend.create.bind(backend);
    backend.create = async (spec, waiting) => {
      waiting?.(imageServedWaitLine("Solari", 15_000));
      return create(spec);
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await createOn(rt, { golden: "snap_g", name: "waits" });
    const stages = creating(events);
    expect(stages.slice(0, 2).map(e => [e.stage, e.message])).toEqual([
      ["fork-requested", "starting waits on default"],
      ["fork-requested", "waiting for Solari to serve the image; asking again in 15s"],
    ]);
    // Marked, so a surface showing the step folds each ask into it rather than drawing a step per ask.
    expect(stages.map(e => e.waiting)).toEqual([undefined, true, ...stages.slice(2).map(() => undefined)]);
  });

  it("a guest that refuses the hostname gets a verdict in the log, its own words on the line alone, and the create goes on", async () => {
    const backend = stubBackend();
    // The refusal a Linux guest's hostname step answers with where the kernel will not have it.
    backend.execImpl = (m, cmd) => (cmd.startsWith("hostname ") ? { exitCode: 1, stdout: "", stderr: "hostname: sethostname: Operation not permitted\n" } : tokenGuest(m, cmd));
    const rt = createRuntime({ backend, places: wiredPlace("ascii", backend), store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await createOn(rt, { golden: "snap_g", name: "clone-test" });
    warn.mockRestore();
    const stages = creating(events);
    expect(stages[0]!.message).toBe("starting clone-test on ascii");
    const named = stages.find(e => e.stage === "hostname-set")!;
    expect(named.message).toBe("hostname not set; the workspace keeps the machine's own name");
    // The guest's own words are evidence on the line's title, never a second sentence at a person, and never a
    // notice, which every surface draws as a line of its own.
    expect(named.detail).toBe("hostname clone-test on m1 failed: hostname: sethostname: Operation not permitted");
    expect(named).not.toHaveProperty("notice");
    for (const e of stages) {
      expect(e.message).not.toContain("sethostname");
      expect(e.message).not.toContain("m1");
    }
    expect((await rt.workspaces.get(ws.id)).name).toBe("clone-test");
  });

  it("a fork whose daemon never answers still becomes a workspace: the stage says so, with the backend's daemon budget in the fault", async () => {
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    const backend = edgeBackend(port);
    backend.lifecycle.budgets.daemonAnswersMs = 300;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const stages = creating(events);
    expect(stages.map(e => e.stage)).toEqual(["fork-requested", "hostname-set", "preview-route", "daemon-answering", "project-cloned", "ready"]);
    expect(stages[3]).toMatchObject({ message: "Daemon did not answer.", notice: expect.stringMatching(/daemon on m1 did not answer within 300 ms/) });
    expect(backend.machines[0]!.killed).toBe(false);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
  });

  it("a fork whose machine answers for its own daemon is asked over that road, and the route this computer cannot dial decides nothing", async () => {
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    const backend = edgeBackend(port);
    backend.lifecycle.budgets.daemonAnswersMs = 300;
    const create = backend.create.bind(backend);
    let asked = 0;
    backend.create = async spec => {
      const m = await create(spec);
      m.daemonAnswers = async () => {
        asked++;
        return true;
      };
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await createOn(rt, { golden: "snap_g", name: "task-1" });
    const stages = creating(events);
    expect(stages[3]).toMatchObject({ stage: "daemon-answering", message: "Daemon answered." });
    expect("notice" in stages[3]!).toBe(false);
    expect(asked).toBe(1);
  });

  it("a fork with no route at all is still asked: the daemon-answering stage stands without a preview-route stage", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = await create(spec);
      m.daemonAnswers = async () => true;
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await createOn(rt, { golden: "snap_g", name: "task-1" });
    const stages = creating(events);
    expect(backend.machines[0]!.previewUrl).toBeUndefined();
    expect(stages.map(e => e.stage)).toEqual(["fork-requested", "hostname-set", "daemon-answering", "project-cloned", "ready"]);
    expect(stages[2]).toMatchObject({ message: "Daemon answered." });
    expect("notice" in stages[2]!).toBe(false);
  });

  it("a mint that fails is its own line, and the daemon is still asked over the road it has", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = await create(spec);
      m.previewUrl = async () => {
        throw new Error("container publishes no port 7070; only the daemon's own port is published");
      };
      m.daemonAnswers = async () => true;
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await createOn(rt, { golden: "snap_g", name: "task-1" });
    const stages = creating(events);
    expect(stages[2]).toMatchObject({ stage: "preview-route", message: "No preview route to the daemon.", notice: expect.stringMatching(/publishes no port 7070/) });
    expect(stages[3]).toMatchObject({ stage: "daemon-answering", message: "Daemon answered." });
    expect("notice" in stages[3]!).toBe(false);
  });

  it("a create that fails after the fork kills its machine, reports failed with the reason, and lists nothing", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const put = store.put.bind(store);
    store.put = async (collection, id, value) => {
      if (collection === "workspaces") throw new Error("disk full");
      return put(collection, id, value);
    };
    const rt = createRuntime({ backend, store, adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await expect(createOn(rt, { golden: "snap_g", name: "task-1" })).rejects.toThrow("disk full");
    const stages = creating(events);
    // The project goes in before the record is written, so the clone stands and the store's own failure ends it.
    expect(stages.map(e => e.stage)).toEqual(["fork-requested", "hostname-set", "project-cloned", "failed"]);
    expect(stages.at(-1)!.message).toBe("disk full");
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(events.some(e => e.type === "workspace.created")).toBe(false);
  });

  it("until ready the workspace is neither listed nor reachable, so nothing opens a shell under the old hostname", async () => {
    const backend = stubBackend();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    backend.execImpl = async (_m, cmd) => {
      if (cmd.startsWith("hostname ")) await gate;
      return ok;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ids: string[] = [];
    rt.events.on("workspace.creating", e => { if (e.type === "workspace.creating") ids.push(e.workspaceId); });
    const made = createOn(rt, { golden: "snap_g", name: "task-1" });
    await vi.waitFor(() => expect(backend.machines[0]!.execLog.some(c => c.startsWith("hostname "))).toBe(true));
    expect(await rt.workspaces.list()).toEqual([]);
    expect((await rt.status.list()).map(s => s.id)).toEqual([]);
    await expect(rt.workspaces.get(ids[0]!)).rejects.toThrow(/no such workspace/);
    release();
    const ws = await made;
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    expect((await rt.workspaces.get(ws.id)).id).toBe(ws.id);
  });
});

describe("runtime verified wake", () => {

  /** A stub whose guest answers ls/tar/untar/token like a golden fork; tar and untar commands are recorded per machine. */
  function guestBackend() {
    const backend = stubBackend();
    const tars: string[] = [];
    const untars: string[] = [];
    let tgzBytes = 1_000;
    backend.execImpl = (m, cmd) => {
      if (cmd.includes(TOKEN_PATH)) return tokenGuest(m, cmd);
      if (cmd.includes("ls -A /root")) return { exitCode: 0, stdout: "notes.md\n.local\n", stderr: "" };
      if (cmd.startsWith("wc -c <")) return { exitCode: 0, stdout: `${tgzBytes}\n`, stderr: "" };
      if (cmd.includes("tar czf")) tars.push(m.id);
      if (cmd.includes("tar xzf")) untars.push(m.id);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const fetchStub = vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
    );
    vi.stubGlobal("fetch", fetchStub);
    return { backend, tars, untars, setTgzBytes: (n: number) => { tgzBytes = n; } };
  }

  it("resume returns but the daemon never answers: waking, one retry, then the wake fails on the same machine, nothing forked, imported or killed", async () => {
    const { backend, tars, untars } = guestBackend();
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    try {
      const store = memoryStore();
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      const rt = createRuntime({ backend, store, adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));

      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/^the wake of m1 did not finish: attempt 1: daemon on m1 did not answer/);
      const phases = events.filter(e => e.type === "workspace.status").map(e => (e as { status: { phase: string } }).status.phase);
      expect(phases.slice(0, 3)).toEqual(["pausing", "napping", "waking"]);
      expect(m1.resumes).toBe(2);
      expect(m1.killed).toBe(false);
      expect(backend.machines).toHaveLength(1);
      expect(untars).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).machineId).toBe("m1");
      expect(events.some(e => e.type === "workspace.woken")).toBe(false);
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; reason?: string; machineId: string } };
      expect(last.status.phase).toBe("napping");
      expect(last.status.machineId).toBe("m1");
      expect(last.status.reason).toMatch(/attempt 1: daemon on m1 did not answer within 300 ms.*created as \{"cpu":2,"memMb":4096.*attempt 2:.*; the workspace keeps this machine and its disk$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a backend declaring one wake attempt: resume, the check fails, no re-pause, and the wake fails on the same machine", async () => {
    const { backend, untars } = guestBackend();
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      backend.lifecycle.budgets.wakeAttempts = 1;
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      let pauses = 0;
      const pause = m1.pause.bind(m1);
      m1.pause = async () => { pauses++; await pause(); };
      await rt.workspaces.nap(ws.id);
      expect(pauses).toBe(1);
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/daemon on m1 did not answer within 300 ms/);
      // One resume and no re-pause after the nap's own: a provider that bills every start is not asked for a second.
      expect(m1.resumes).toBe(1);
      expect(pauses).toBe(1);
      expect(m1.killed).toBe(false);
      expect(backend.machines).toHaveLength(1);
      expect(untars).toEqual([]);
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      // The fault names the backend's own daemon budget, on a wake as on a fork.
      expect(last.status.reason).toMatch(/^the wake of m1 did not finish: attempt 1: daemon on m1 did not answer within 300 ms/);
      expect(last.status.reason).not.toContain("attempt 2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a machine that answers for its own daemon is asked over that road on a wake, so a route this computer cannot dial never throws the container away", async () => {
    const { backend, untars } = guestBackend();
    try {
      const { port, close: closePort } = await droppingPort();
      onTestFinished(closePort);
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      // The route mints and nothing on this computer answers it: a container's published port on a box belongs to
      // that box's own loopback, and the wake check used to read that silence as a dead guest.
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      let asked = 0;
      m1.daemonAnswers = async () => {
        asked++;
        return true;
      };
      await rt.workspaces.nap(ws.id);
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken).toMatchObject({ machineId: "m1", phase: "running" });
      expect(asked).toBe(1);
      expect(backend.machines).toHaveLength(1);
      expect(m1.killed).toBe(false);
      expect(untars).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a machine whose own answer is no still fails the wake, and the fault names the port nothing listens on", async () => {
    const { backend } = guestBackend();
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.daemonAnswers = async () => false;
      await rt.workspaces.nap(ws.id);
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/nothing listens/);
      expect((await rt.workspaces.get(ws.id)).machineId).toBe("m1");
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      expect(last.status.reason).toContain("nothing listens on the daemon's port inside m1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a machine that cannot be asked at all says what happened, not that a budget ran out", async () => {
    const { backend } = guestBackend();
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.daemonAnswers = async () => {
        throw new Error("container m1 is not running");
      };
      await rt.workspaces.nap(ws.id);
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/could not be asked/);
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      expect(last.status.reason).toContain("could not be asked (container m1 is not running)");
      expect(last.status.reason).not.toContain("did not answer within");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a size mismatch fails the wake before any ping, naming both values", async () => {
    const { backend } = guestBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x", memMb: 4096 });
      const m1 = backend.machines[0]!;
      let minted = 0;
      m1.previewUrl = async () => { minted++; return { url: "ws://127.0.0.1:1", token: "e", expiresAt: Date.now() + 3_600_000 }; };
      await rt.workspaces.nap(ws.id);
      m1.shape = { cpu: 2, memMb: 2048, createdAt: "2026-09-02T19:03:35.000Z" };

      const started = Date.now();
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/memMb 2048 != 4096/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(minted).toBe(0);
      expect((await rt.workspaces.get(ws.id)).machineId).toBe("m1");
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      expect(last.status.reason).toContain("memMb 2048 != 4096");
      expect(last.status.reason).toContain('provider view {"cpu":2,"memMb":2048,"createdAt":"2026-09-02T19:03:35.000Z"}');
      expect(warn.mock.calls.some(c => String(c[0]).includes("2048") && String(c[0]).includes("4096"))).toBe(true);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("syncs the machine's disk before the vault is read off it and the provider pauses it", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const before = m.execLog.length;
    await rt.workspaces.nap(ws.id);
    const log = m.execLog.slice(before);
    const synced = log.indexOf(DISK_SYNC_CMD);
    expect(synced).toBeGreaterThan(-1);
    expect(synced).toBeLessThan(log.findIndex(c => c.includes("tar czf")));
    expect(m.paused).toBe(true);
  });

  it.each([
    ["an exec that throws", (): ExecResult => { throw new Error("socket hang up"); }, "socket hang up"],
    ["a sync that exits 1", (): ExecResult => ({ exitCode: 1, stdout: "", stderr: "sync: Input/output error" }), "it exited 1 and said: sync: Input/output error"],
  ])("%s is one warning naming the nap with the machine's own answer, and the vault is still stored and the machine still paused", async (_shape, answer, said) => {
    const backend = stubBackend();
    const store = memoryStore();
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd === DISK_SYNC_CMD ? answer() : plain(m, cmd));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`disk sync before the nap of ${ws.id} failed: ${said}; napping anyway`]);
      expect(await store.getBlob("vaults", ws.id)).toBeDefined();
      expect(backend.machines[0]!.paused).toBe(true);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    } finally {
      warn.mockRestore();
    }
  });

  it("a healthy wake stays on the same machine even though createdAt moved, imports nothing, and reports the daemon reachable", async () => {
    const { backend, untars } = guestBackend();
    try {
      await withDaemon(async port => {
        const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
        const events: EventUnion[] = [];
        rt.events.on("*", e => events.push(e));
        const ws = await createOn(rt, { golden: "snap_g", name: "x" });
        const m1 = backend.machines[0]!;
        m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
        await rt.workspaces.nap(ws.id);
        m1.shape = { ...m1.shape, createdAt: "2026-09-02T20:11:04.444Z" }; // every Solari resume does this
        const woken = await rt.workspaces.wake(ws.id);
        expect(woken).toMatchObject({ machineId: "m1", phase: "running" });
        expect(m1.resumes).toBe(1);
        expect(m1.killed).toBe(false);
        expect(backend.machines).toHaveLength(1);
        expect(untars).toEqual([]);
        expect(events.find(e => e.type === "workspace.woken")).toMatchObject({ machineId: "m1" });
        const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reach: { state: string }; reason?: string } };
        expect(last.status.reach.state).toBe("reachable");
        expect(last.status.reason).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("every nap replaces the stashed vault; one over the cap is refused with a warning, the previous stays, the record keeps saying it and no status line carries the reason", async () => {
    const { backend, tars, setTgzBytes } = guestBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = memoryStore();
      // The stamp on the record is the runtime's clock, so this test holds one: two naps a millisecond apart under a
      // busy box would otherwise write the same ISO string and the refresh could not be told from a stale write.
      const fc = fakeClock(Date.UTC(2026, 8, 8, 7, 10, 4, 444));
      const rt = createRuntime({ backend, store, adapters: {}, clock: fc.clock, wake: { vaultCapBytes: 5_000 }, vaultCaches: { dirs: ["node_modules", "dist"], files: [".DS_Store"], markers: [".git"] } });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      // This workspace's own last status and its own warnings. Another workspace's line landing in the window would
      // otherwise decide both reads, which is the kind of thing that shows up only when the whole suite runs.
      const napReason = (): string | undefined =>
        (events.filter(e => e.type === "workspace.status" && (e as { status: { id: string } }).status.id === ws.id).at(-1) as { status: { reason?: string } }).status.reason;
      const vaultWarnings = (): string[] => warn.mock.calls.map(c => String(c[0])).filter(l => l.startsWith(`nap vault for ${ws.id}`));
      await rt.workspaces.nap(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect(napReason()).toBeUndefined();
      const stored = "2026-09-08T07:10:04.444Z";
      expect((await rt.workspaces.get(ws.id)).vaultedAt).toBe(stored);
      expect((await rt.workspaces.get(ws.id)).vaultRefused).toBeUndefined();
      const script = backend.machines[0]!.runLog.find(s => s.includes("tar czf"))!;
      expect(script).toContain(`find 'root/notes.md' -mindepth 1 -path '*/.git' -prune -o \\( \\( -type d \\( -name 'node_modules' -o -name 'dist' \\) \\) -o \\( -type f \\( -name '.DS_Store' \\) \\) -o \\( -type d -exec test -f '{}/.git' \\; \\) \\) -prune -print > `);
      expect(script).toMatch(/tar czf '[^']+' --no-recursion --null -T '[^']+\.keep'/);
      await rt.workspaces.wake(ws.id);
      setTgzBytes(6_000);
      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1", "m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect(vaultWarnings()).toEqual([`nap vault for ${ws.id} not stored, previous kept: the export was 6 KB, over the 5 KB cap`]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
      // No status line for it at all: the record says it until a nap stores one, and the pane's own backup line is
      // where a person reads the verdict. A status reason would have taken the row's third line from the spend.
      expect(napReason()).toBeUndefined();
      // The record says it until a nap stores one, which is what the row and the tab read.
      const refused = await rt.workspaces.get(ws.id);
      expect(refused.vaultRefused).toBe("the export was 6 KB, over the 5 KB cap");
      expect(refused.vaultedAt).toBe(stored);
      expect((await store.get("workspaces", ws.id))).toMatchObject({ vaultRefused: "the export was 6 KB, over the 5 KB cap", vaultedAt: stored });
      await rt.workspaces.wake(ws.id);
      setTgzBytes(1_000);
      // Well inside the status poll's interval, so the only thing that moves is the stamp the next stash writes.
      fc.advance(1_000);
      await rt.workspaces.nap(ws.id);
      expect(napReason()).toBeUndefined();
      const fresh = await rt.workspaces.get(ws.id);
      expect(fresh.vaultRefused).toBeUndefined();
      expect(fresh.vaultedAt).toBe("2026-09-08T07:10:05.444Z");
      await rt.workspaces.delete(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rebuild forks the golden, imports the nap-time vault, kills the old machine, keeps the id and name, and pushes status", async () => {
    const { backend, untars } = guestBackend();
    try {
      const store = memoryStore();
      const rt = createRuntime({ backend, store, adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "hello", memMb: 2048 });
      const m1 = backend.machines[0]!;
      await rt.workspaces.nap(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      // The provider resumed it behind our back and handed back a running machine whose guest is dead.
      m1.paused = false;
      const rec = (await store.get("workspaces", ws.id)) as { phase: string };
      expect(rec.phase).toBe("napping");

      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt).toMatchObject({ id: ws.id, name: "hello", machineId: "m2", phase: "running", golden: "snap_g" });
      expect(m1.killed).toBe(true);
      expect(m1.resumes).toBe(0);
      expect(backend.machines[1]!.spec).toMatchObject({ fromSnapshot: "snap_g", memMb: 2048 });
      expect(untars).toEqual(["m2"]);
      expect(events.find(e => e.type === "workspace.upgraded")).toMatchObject({ workspaceId: ws.id, machineId: "m2" });
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; machineId: string; reason?: string } };
      expect(last.status).toMatchObject({ phase: "running", machineId: "m2" });
      expect(last.status.reason).toMatch(/rebuilt.*m1.*m2.*vault/);
      expect((await store.get("workspaces", ws.id)) as object).toMatchObject({ machineId: "m2", phase: "running", firstLife: true });
      expect((await rt.status.list())[0]!.reach.state).not.toBe("zombie");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rebuild of a workspace that never napped imports nothing and says so", async () => {
    const { backend, untars } = guestBackend();
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "fresh" });
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m2");
      expect(backend.machines[0]!.killed).toBe(true);
      expect(untars).toEqual([]);
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      expect(last.status.reason).toMatch(/rebuilt.*m1.*m2.*no vault/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runtime workspace size", () => {
  /** A provider that clamps memory: whatever is asked, the machine it builds has 2048 MB. */
  function clampingBackend() {
    const backend = stubBackend();
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await create(spec)) as (typeof backend.machines)[number];
      m.shape = { ...m.shape, memMb: 2048 };
      return m;
    };
    return backend;
  }

  it("create asks for an explicit size: the pricing default when the caller names none", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "a" });
    await createOn(rt, { golden: "snap_g", name: "b", memMb: 2048 });
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
  });

  it("the size shown and billed is what the provider built, not what was asked, and it survives a restart", async () => {
    const backend = clampingBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, status: { costIntervalMs: 15, pollIntervalMs: 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    expect(backend.machines[0]!.spec.memMb).toBe(4096);
    const built = { cpu: 2, memMb: 2048 };
    const [status] = await rt.status.list();
    expect(status).toMatchObject({ size: built, rateUsdPerHour: backend.pricing.rateUsdPerHour(built) });

    const costs: number[] = [];
    rt.events.on("workspace.cost", e => { if (e.type === "workspace.cost") costs.push(e.rateUsdPerHour); });
    const stop = rt.status.watch();
    while (costs.length === 0) await new Promise(r => setTimeout(r, 5));
    stop();
    expect(costs[0]).toBeCloseTo(backend.pricing.rateUsdPerHour(built), 10);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.status.list())[0]).toMatchObject({ id: ws.id, size: built });
  });

  it("a rebuilt fork asks for the recorded size and records what came back; an upgrade records its new size", async () => {
    const backend = clampingBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("ls -A /root") ? { exitCode: 0, stdout: "notes.md\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
    ));
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("workspace.status", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await rt.workspaces.rebuild(ws.id);
      expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
      const pushed = events.at(-1) as { status: { size: { cpu: number; memMb: number } } };
      expect(pushed.status.size).toEqual({ cpu: 2, memMb: 2048 });

      backend.machines[1]!.previewUrl = undefined;
      await rt.workspaces.upgrade(ws.id);
      expect(backend.machines[2]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
      expect((await rt.status.list())[0]!.size).toEqual({ cpu: 2, memMb: 2048 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a fork inherits the size its golden was sealed at unless the caller overrides it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "s", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 2, memMb: 8192 } };
    await store.put("goldens", copyKey("default", "big"), { head: 1, versions: [version] });
    const rt = createRuntime({ backend, store, adapters: {} });
    await createOn(rt, { golden: "snap_golden-v1", name: "a" });
    await createOn(rt, { golden: "snap_golden-v1", name: "b", memMb: 2048 });
    await createOn(rt, { golden: "snap_elsewhere", name: "c" });
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
    expect(backend.machines[2]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    expect((await rt.status.list()).map(s => s.size.memMb).sort()).toEqual([2048, 4096, 8192]);
  });

  it("seal records the builder's size on the version, as the provider reported it", async () => {
    const backend = clampingBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { setup: "install", smoke: "true", cpu: 2, memMb: 4096 } });
    const b = await rt.golden.prepare();
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    const { version } = await rt.golden.seal(b.id);
    expect(version.size).toEqual({ cpu: 2, memMb: 2048 });
    expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
  });

});

describe("runtime workspace screen", () => {
  /** A provider whose forks boot as desktop machines: every machine it builds streams a display. */
  function desktopBackend() {
    const backend = stubBackend();
    const create = backend.create.bind(backend);
    backend.create = spec => create({ ...spec, kind: "desktop" });
    return backend;
  }

  it("a desktop machine's stream rides the view and the status; a sandbox carries no screen", async () => {
    const desktop = desktopBackend();
    const rt = createRuntime({ backend: desktop, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    expect(ws.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });
    expect((await rt.workspaces.get(ws.id)).screen).toEqual({ streamUrl: "wss://stub/stream/m1" });
    expect((await rt.status.list())[0]!.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });

    const headless = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const sandbox = await createOn(headless, { golden: "snap_g", name: "b" });
    expect(sandbox).not.toHaveProperty("screen");
    expect((await headless.status.list())[0]).not.toHaveProperty("screen");
  });

  it("the stream survives a restart and a wake on the same machine; a rebuild refreshes it from the new machine", async () => {
    const backend = desktopBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.workspaces.nap(ws.id);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.workspaces.get(ws.id)).screen).toEqual({ streamUrl: "wss://stub/stream/m1" });
    const woken = await rt2.workspaces.wake(ws.id);
    expect(woken.machineId).toBe("m1");
    expect(woken.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });

    const pushed: EventUnion[] = [];
    rt2.events.on("workspace.status", e => pushed.push(e));
    const rebuilt = await rt2.workspaces.rebuild(ws.id);
    expect(rebuilt.machineId).toBe("m2");
    expect(rebuilt.screen).toEqual({ streamUrl: "wss://stub/stream/m2" });
    const last = pushed.at(-1) as { status: { screen?: { streamUrl: string } } };
    expect(last.status.screen).toEqual({ streamUrl: "wss://stub/stream/m2" });
    expect((await store.get("workspaces", ws.id) as { screen?: unknown }).screen).toEqual({ streamUrl: "wss://stub/stream/m2" });
  });
});

describe("runtime fork kind", () => {
  const version = (kind?: "sandbox" | "desktop") => ({
    version: 1,
    snapshotId: "snap_golden-v1",
    baseTemplate: "base",
    ...(kind !== undefined ? { kind } : {}),
    setupSha: "sha1",
    createdAt: "2026-08-11T00:00:00.000Z",
    smoke: { cmd: "true", exitCode: 0 },
  });

  it("forks a desktop golden as kind desktop on create, rebuild and upgrade, carrying the stream on the view", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version("desktop")] });
    const rt = createRuntime({ backend, store, adapters: {} });

    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "a" });
    expect(backend.machines[0]!.spec.kind).toBe("desktop");
    expect(ws.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });

    const rebuilt = await rt.workspaces.rebuild(ws.id);
    expect(backend.machines[1]!.spec.kind).toBe("desktop");
    expect(rebuilt.screen).toEqual({ streamUrl: "wss://stub/stream/m2" });

    const upgraded = await rt.workspaces.upgrade(ws.id);
    expect(backend.machines[2]!.spec.kind).toBe("desktop");
    expect(upgraded.screen).toEqual({ streamUrl: "wss://stub/stream/m3" });
  });

  it("a manifest sealed before versions recorded a kind still forks sandbox", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version()] });
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "a" });
    expect(backend.machines[0]!.spec.kind).toBe("sandbox");
    expect(ws.screen).toBeUndefined();
  });
});

describe("nap vault against the stub backend", () => {
  it("stores a real tar from the stub download URL without warning", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      expect(warn).not.toHaveBeenCalled();
      const vault = await store.getBlob("vaults", ws.id);
      expect(vault).toBeDefined();
      expect(gunzipSync(vault!).equals(Buffer.alloc(1024))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once, keeps the previous vault and leaves the napping status clean when the download URL cannot be fetched", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store, adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      const first = await store.getBlob("vaults", ws.id);
      await rt.workspaces.wake(ws.id);

      backend.machines[0]!.downloadUrl = async () => "http://127.0.0.1:1/nothing-listens-here";
      await rt.workspaces.nap(ws.id);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(`nap vault for ${ws.id} not stored, previous kept: fetch failed`);
      expect(await store.getBlob("vaults", ws.id)).toEqual(first);
      // What the fetch answered stays on the record and off every status: a sentence here would have taken the
      // row's third line from the spend for a note about a step already taken.
      const last = (events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; reason?: string } }).status;
      expect(last).toMatchObject({ phase: "napping" });
      expect(last.reason).toBeUndefined();
      expect((await rt.workspaces.get(ws.id)).vaultRefused).toBe("fetch failed");
    } finally {
      warn.mockRestore();
    }
  });
});
