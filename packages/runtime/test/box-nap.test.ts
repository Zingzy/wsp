// SPDX-License-Identifier: AGPL-3.0-only
// A workspace on a computer that keeps no image has no vault at all: its nap
// is the machine's own stop, nothing of that computer's home is read or
// stored, and a wake puts nothing back. The kinds that keep an image nap
// exactly as they did.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BOX_BUDGETS, BOX_WORK_DIR, BoxBackend, BoxMachine, GuestUnusableError, sudoCommand } from "@wsp/engine";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { DAEMON_TOKEN_PATH, DAEMON_UNIT, EXEC_DEADLINE_EXIT, WAKE_STOPPED, WAKE_STOPPED_UP, noCommandsYetLine, sendRefusal, workspaceState, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { droppingPort } from "./held-port.js";
import { createOn, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";

// The daemon link redials on the process's own timers while a wake's budget runs on the test's clock, which the
// pump moves half a second a few turns of the loop at a time: a redial here waits for no time at all, or the budget
// would run out between two dials.
vi.mock("@wsp/protocol", async importOriginal => ({ ...(await importOriginal<typeof import("@wsp/protocol")>()), linkBackoffMs: () => 0 }));

/** A stub whose guest answers what the vault road asks of it: the listing of the home it would archive and the
 * size of the archive it wrote. Every tar and untar is recorded by machine, so a nap that took the vault road is
 * read back here by name rather than guessed at from a blob.
 */
function guestBackend(): { backend: StubBackend; tars: string[]; untars: string[] } {
  const backend = stubBackend();
  const tars: string[] = [];
  const untars: string[] = [];
  backend.execImpl = (m, cmd) => {
    if (cmd.includes(DAEMON_TOKEN_PATH)) return tokenGuest(m, cmd);
    if (cmd.includes("ls -A /root")) return { exitCode: 0, stdout: "notes.md\n", stderr: "" };
    if (cmd.startsWith("wc -c <")) return { exitCode: 0, stdout: "1000\n", stderr: "" };
    if (cmd.includes("tar czf")) tars.push(m.id);
    if (cmd.includes("tar xzf")) untars.push(m.id);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string }) => (init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")))),
  );
  return { backend, tars, untars };
}

/** A daemon on a local socket, as a box's preview route reaches it: it takes the socket at once, holds its answer
 * to the auth frame until `up()` is called, and answers every other frame at once. */
async function slowDaemon(): Promise<{ url: string; up: () => void; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  let answering = false;
  const held: (() => void)[] = [];
  server.on("connection", sock =>
    sock.on("message", raw => {
      const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
      const answer = (): void => sock.send(JSON.stringify({ id, ok: true }));
      if (op === "auth" && !answering) held.push(answer);
      else answer();
    }),
  );
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    up: () => {
      answering = true;
      for (const answer of held.splice(0)) answer();
    },
    close: () =>
      new Promise(resolve => {
        for (const sock of server.clients) sock.terminate();
        server.close(() => resolve());
      }),
  };
}

/** A box's daemon route before the daemon listens, as Boat's edge answers it: every upgrade is refused with a 502
 * until `up()` is called, and from then on a daemon takes the socket and answers every frame at once. */
async function lateDaemon(): Promise<{ url: string; up: () => void; dials: () => number; close: () => Promise<void> }> {
  const daemon = new WebSocketServer({ noServer: true });
  daemon.on("connection", sock => sock.on("message", raw => sock.send(JSON.stringify({ id: (JSON.parse(String(raw)) as { id: number }).id, ok: true }))));
  const edge = createServer((_req, res) => res.writeHead(502).end());
  let listening = false;
  let dials = 0;
  edge.on("upgrade", (req, socket, head) => {
    dials++;
    if (listening) daemon.handleUpgrade(req, socket, head, sock => daemon.emit("connection", sock, req));
    else socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${(edge.address() as AddressInfo).port}`,
    up: () => void (listening = true),
    dials: () => dials,
    close: () =>
      new Promise(resolve => {
        for (const sock of daemon.clients) sock.terminate();
        daemon.close();
        edge.closeAllConnections();
        edge.close(() => resolve());
      }),
  };
}

/** Every command every machine of this backend was asked, oldest first. */
const commands = (backend: StubBackend): string[] => backend.machines.flatMap(m => m.execLog);

describe("the nap of a workspace on a computer that keeps no image", () => {
  const imageless = (): { backend: StubBackend; tars: string[]; untars: string[]; store: Store } => {
    const made = guestBackend();
    // What such a computer says about itself: a workspace on it is a copy of the computer, and the pause of one is
    // the stop of its machine on that computer's own disk.
    made.backend.capabilities.images = false;
    made.backend.capabilities.pauseMode = "disk";
    return { ...made, store: memoryStore() };
  };

  it("pauses the machine and reads nothing of the computer's home: no listing, no archive, no stored vault, and the record says nothing about a backup", async () => {
    const { backend, tars, untars, store } = imageless();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { name: "x" });
      const m = backend.machines[0]!;
      // What the create left on the machine, so what the nap itself sends is read on its own.
      const sent = { execs: m.execLog.length, runs: m.runLog.length };
      const napped = await rt.workspaces.nap(ws.id);
      expect(napped.phase).toBe("napping");
      expect(m.paused).toBe(true);
      // The pause costs the machine nothing: no command and no script, which is where the tens of seconds went.
      expect({ execs: m.execLog.length, runs: m.runLog.length }).toEqual(sent);
      // The two commands the vault road runs on the machine: the breadcrumb it appends to that computer's home and
      // the listing it enumerates from. Neither is sent.
      expect(commands(backend).some(c => c.includes(".wsp-upgraded"))).toBe(false);
      expect(commands(backend).some(c => c.includes("ls -A /root"))).toBe(false);
      expect(tars).toEqual([]);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
      const record = await rt.workspaces.get(ws.id);
      expect(record.vaultedAt).toBeUndefined();
      expect(record.vaultRefused).toBeUndefined();
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.phase).toBe("running");
      expect(backend.machines[0]!.resumes).toBe(1);
      expect(untars).toEqual([]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("drops what a nap before this rule wrote on the record about a backup, so no row reads a refusal about a vault the workspace never had", async () => {
    const { backend, store } = imageless();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { name: "x" });
      // The record as spoo's own was after one nap over the cap: the stamp and the refusal a vault road wrote.
      const held = (await store.get("workspaces", ws.id)) as Record<string, unknown>;
      await store.put("workspaces", ws.id, { ...held, vaultedAt: "2026-09-17T00:00:00.000Z", vaultRefused: "the export was 580 MB, over the 200 MB cap" });
      await rt.close();
      const back = createRuntime({ backend, store, adapters: {} });
      try {
        const read = await back.workspaces.get(ws.id);
        expect(read.vaultRefused).toBeUndefined();
        expect(read.vaultedAt).toBeUndefined();
      } finally {
        await back.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a wake that runs out its attempts fails on the same machine, and nothing is carried anywhere", async () => {
    const { backend, untars, store } = imageless();
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      backend.lifecycle.budgets.wakeAttempts = 1;
      const ws = await createOn(rt, { name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      await rt.workspaces.nap(ws.id);
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/daemon on m1 did not answer/);
      expect((await rt.workspaces.get(ws.id)).machineId).toBe("m1");
      expect(backend.machines).toHaveLength(1);
      expect(m1.killed).toBe(false);
      expect(untars).toEqual([]);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  /** A napped workspace whose machine is reached the way a Boat box is, by its preview route: the daemon behind it
   * takes the socket at once and answers its auth frame only once `daemon.up()` is called, so the wait is on the
   * link, as it is on a box whose disk is still streaming in. The clock is the runtime's, stepped by `pump`. */
  async function boatWake(made: () => Promise<{ url: string; up: () => void; close: () => Promise<void> }> = slowDaemon) {
    const { backend, store } = imageless();
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, clock });
    backend.lifecycle.budgets = { ...BOX_BUDGETS };
    const daemon = await made();
    const ws = await createOn(rt, { name: "x" });
    const m1 = backend.machines[0]!;
    m1.previewUrl = async () => ({ url: daemon.url, token: "e", expiresAt: Date.now() + 3_600_000 });
    await rt.workspaces.nap(ws.id);
    /** Steps the clock half a second at a time, turning the loop between steps so the socket's frames are read,
     * until `done` holds or twenty minutes have passed. */
    const pump = async (done: () => boolean, each: () => void = () => {}): Promise<void> => {
      for (let spent = 0; !done() && spent < 20 * 60_000; spent += 500) {
        for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
        advance(500);
        each();
      }
    };
    const close = async (): Promise<void> => {
      await rt.close();
      await daemon.close();
      vi.unstubAllGlobals();
    };
    return { rt, ws, m1, backend, clock, daemon, pump, close };
  }

  it("a Boat wake whose daemon answers two and a half minutes after the box is up succeeds on the first send, on the same machine", async () => {
    // Five wakes on the dev host (2026-09-27) had no daemon answer 120 s after the box read ready; the one kept after
    // its failure, bx_eva5rxgz, served on the next send.
    const t = await boatWake();
    try {
      const began = t.clock.now();
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      await t.pump(() => done, () => (t.clock.now() - began >= 150_000 ? t.daemon.up() : undefined));
      await expect(waking).resolves.toMatchObject({ machineId: "m1", phase: "running" });
      expect(t.backend.machines).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a Boat wake whose daemon starts listening seven minutes after the box is up succeeds on the first send, on the same machine", async () => {
    // Two wakes on the dev host (2026-09-29) had their daemon listening 8 and 12 minutes after boot: Boat starts the
    // restored services only once its restore is done, and nothing Boat's API says tells that moment apart.
    const late = await lateDaemon();
    const t = await boatWake(async () => late);
    try {
      const began = t.clock.now();
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      // What the row reads a minute past the old cut, which the app words as waking with the time it has taken.
      let atSix: Promise<string> | undefined;
      await t.pump(
        () => done,
        () => {
          if (atSix === undefined && t.clock.now() - began >= 6 * 60_000) atSix = t.rt.workspaces.get(t.ws.id).then(w => w.phase);
          if (t.clock.now() - began >= 7 * 60_000) late.up();
        },
      );
      await expect(waking).resolves.toMatchObject({ machineId: "m1", phase: "running" });
      expect(await atSix).toBe("waking");
      expect(t.clock.now() - began).toBeGreaterThanOrEqual(7 * 60_000);
      expect(late.dials()).toBeGreaterThan(1);
      expect(t.backend.machines).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  /** A Boat wake whose daemon's unit is enabled and never started, as Boat left bx_z4284vcx (2026-09-29): the edge
   * refuses every upgrade until the host runs the unit's start over the machine's exec road. */
  async function unstartedWake() {
    const late = await lateDaemon();
    const t = await boatWake(async () => late);
    t.m1.startDaemon = () => t.m1.exec(`systemctl start ${DAEMON_UNIT}`);
    const base = t.backend.execImpl;
    t.backend.execImpl = (m, cmd) => {
      if (cmd === `systemctl start ${DAEMON_UNIT}`) late.up();
      return base(m, cmd);
    };
    const starts = (): number => t.m1.execLog.filter(c => c === `systemctl start ${DAEMON_UNIT}`).length;
    return { ...t, late, starts };
  }

  it("a Boat wake whose daemon was never started starts it through the machine's exec a minute in, and succeeds on the first send", async () => {
    const t = await unstartedWake();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const began = t.clock.now();
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      await t.pump(() => done);
      await expect(waking).resolves.toMatchObject({ machineId: "m1", phase: "running" });
      expect(t.starts()).toBe(1);
      expect(t.clock.now() - began).toBeGreaterThanOrEqual(60_000);
      // The link redials on real timers, so how much of the test's clock passes before it lands varies; the bound is
      // what matters, long before the fifteen minute cut.
      expect(t.clock.now() - began).toBeLessThan(5 * 60_000);
      expect(warned.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringMatching(/^daemon on m1 \(workspace ws_\w+\) had not answered 60 s into the wait, so wsp started it \(exit 0\)$/));
      expect(t.backend.machines).toHaveLength(1);
    } finally {
      warned.mockRestore();
      await t.close();
    }
  });

  it.each([
    { how: "throws", first: () => Promise.reject(new Error("Request timeout after 69998ms")), said: ", and the start failed \\(Request timeout after 69998ms\\)" },
    { how: "runs out its timeout", first: () => Promise.resolve({ exitCode: EXEC_DEADLINE_EXIT, stdout: "", stderr: "" }), said: ` \\(exit ${EXEC_DEADLINE_EXIT}\\)` },
  ])("asks for the start again a minute after one that $how, so a start lost on a box still streaming its disk is not the last", async ({ first, said: failed }) => {
    const t = await unstartedWake();
    const asked = t.m1.startDaemon!;
    let tries = 0;
    t.m1.startDaemon = () => (++tries === 1 ? first() : asked());
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const began = t.clock.now();
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      await t.pump(() => done);
      await expect(waking).resolves.toMatchObject({ machineId: "m1", phase: "running" });
      expect(tries).toBe(2);
      expect(t.starts()).toBe(1);
      expect(t.clock.now() - began).toBeGreaterThanOrEqual(2 * 60_000);
      expect(t.clock.now() - began).toBeLessThan(5 * 60_000);
      const said = warned.mock.calls.map(c => String(c[0]));
      expect(said).toContainEqual(expect.stringMatching(new RegExp(`^daemon on m1 \\(workspace ws_\\w+\\) had not answered 60 s into the wait, so wsp started it${failed}$`)));
      expect(said).toContainEqual(expect.stringMatching(/^daemon on m1 \(workspace ws_\w+\) had not answered 120 s into the wait, so wsp started it \(exit 0\)$/));
    } finally {
      warned.mockRestore();
      await t.close();
    }
  });

  it("starts nothing on a machine whose daemon answered, even once the minute has passed", async () => {
    const t = await unstartedWake();
    try {
      t.late.up();
      const began = t.clock.now();
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      await t.pump(() => done);
      await expect(waking).resolves.toMatchObject({ machineId: "m1", phase: "running" });
      expect(t.clock.now() - began).toBeLessThan(60_000);
      // A start armed by the wait and never cleared would fire here.
      await t.pump(() => t.clock.now() - began >= 2 * 60_000);
      expect(t.starts()).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("a Boat wake whose daemon never answers fails once its fifteen minutes are out, saying so, and keeps the machine", async () => {
    const t = await boatWake();
    try {
      const began = t.clock.now();
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      await t.pump(() => done);
      await expect(waking).rejects.toThrow(/the wake of m1 did not finish: attempt 1: daemon on m1 did not answer within 900000 ms \(daemon link timed out after \d+ ms\).*the workspace keeps this machine and its disk/);
      expect(t.clock.now() - began).toBeGreaterThanOrEqual(15 * 60_000);
      expect(t.clock.now() - began).toBeLessThan(16 * 60_000);
      expect((await t.rt.workspaces.get(t.ws.id)).machineId).toBe("m1");
      expect(t.m1.killed).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("a stop pulled ten seconds into a Boat wake whose daemon has not answered lets go at once, not when the fifteen minutes are out", async () => {
    const t = await boatWake();
    try {
      let done = false;
      const waking = t.rt.workspaces.wake(t.ws.id).finally(() => (done = true));
      waking.catch(() => {});
      const began = t.clock.now();
      await t.pump(() => t.clock.now() - began >= 10_000);
      const pulled = t.clock.now();
      let stopped = false;
      const stopping = t.rt.workspaces.stopWake(t.ws.id).finally(() => (stopped = true));
      await t.pump(() => stopped);
      await stopping;
      expect(t.clock.now() - pulled).toBeLessThanOrEqual(1_000);
      await expect(waking).rejects.toThrow(WAKE_STOPPED);
      expect(done).toBe(true);
      expect((await t.rt.workspaces.get(t.ws.id)).machineId).toBe("m1");
    } finally {
      await t.close();
    }
  });

  it("leaves a computer that keeps an image exactly as it was: every nap stashes the vault, a failed wake keeps the machine, and the rebuild reads the vault", async () => {
    const { backend, tars, untars } = guestBackend();
    const store = memoryStore();
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      backend.lifecycle.budgets.wakeAttempts = 1;
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect((await rt.workspaces.get(ws.id)).vaultedAt).toBeDefined();
      await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/daemon on m1 did not answer/);
      expect(untars).toEqual([]);
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m2");
      expect(untars).toEqual(["m2"]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("the nap and rebuild of a workspace whose pause keeps the disk", () => {
  // A box keeps its image and its pause is a stop that snapshots the disk; a wake resumes that disk, so the nap
  // reads nothing of the home. The vault is taken off the running machine only where it is read: a rebuild.
  const boxlike = (): { backend: StubBackend; tars: string[]; untars: string[]; store: Store } => {
    const made = guestBackend();
    made.backend.capabilities.pauseMode = "disk";
    return { ...made, store: memoryStore() };
  };

  it("naps with no export: it syncs the disk, reads no home, writes no archive, and stores no vault", async () => {
    const { backend, tars, untars, store } = boxlike();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const m = backend.machines[0]!;
      const napped = await rt.workspaces.nap(ws.id);
      expect(napped.phase).toBe("napping");
      expect(m.paused).toBe(true);
      // The disk is still flushed before the stop snapshots it, but nothing of the home is read or archived.
      expect(commands(backend).some(c => c.startsWith("sync &&"))).toBe(true);
      expect(commands(backend).some(c => c.includes(".wsp-upgraded"))).toBe(false);
      expect(commands(backend).some(c => c.includes("ls -A /root"))).toBe(false);
      expect(tars).toEqual([]);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
      const record = await rt.workspaces.get(ws.id);
      expect(record.vaultedAt).toBeUndefined();
      expect(record.vaultRefused).toBeUndefined();
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.phase).toBe("running");
      expect(backend.machines[0]!.resumes).toBe(1);
      expect(untars).toEqual([]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("a rebuild takes the vault off the running machine and carries it onto the replacement", async () => {
    const { backend, tars, untars, store } = boxlike();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      await rt.workspaces.wake(ws.id);
      expect(tars).toEqual([]);
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m2");
      // The archive was read off the running machine at the rebuild, not at any nap, and landed on the fork.
      expect(tars).toEqual(["m1"]);
      expect(untars).toEqual(["m2"]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("a rebuild whose home is over the cap says so before it touches the machine, and replaces it without a backup", async () => {
    const { backend, tars, untars, store } = boxlike();
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.startsWith("wc -c <") ? { exitCode: 0, stdout: `${300 * 1024 * 1024}\n`, stderr: "" } : base(m, cmd));
    const rt = createRuntime({ backend, store, adapters: {} });
    const overCap: number[] = [];
    const warned = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      if (/over the .* cap/.test(String(args[0]))) overCap.push(backend.machines.length);
    });
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m2");
      // The over-cap line was said while only the old machine stood, before the replacement was forked.
      expect(overCap).toEqual([1]);
      expect(warned.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringMatching(/300 MB.*over the 200 MB cap/));
      // The home was read off the running machine, and nothing was carried onto the fork.
      expect(tars).toEqual(["m1"]);
      expect(untars).toEqual([]);
    } finally {
      warned.mockRestore();
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("a rebuild of a napped workspace wakes it and takes the vault off the woken machine, not the one a nap stored", async () => {
    const { backend, tars, untars, store } = boxlike();
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual([]);
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m2");
      // The napped machine was resumed so the vault came off it live, then the fork carried it.
      expect(backend.machines[0]!.resumes).toBe(1);
      expect(tars).toEqual(["m1"]);
      expect(untars).toEqual(["m2"]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });

  it("a rebuild refuses in one line when a napped workspace cannot be woken, and keeps the machine", async () => {
    const { backend, tars, untars, store } = boxlike();
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    const rt = createRuntime({ backend, store, adapters: {} });
    try {
      backend.lifecycle.budgets.daemonAnswersMs = 300;
      backend.lifecycle.budgets.wakeAttempts = 1;
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      await rt.workspaces.nap(ws.id);
      await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(/could not be woken to back up before the rebuild/);
      // Nothing was replaced or read off the machine: the workspace keeps m1 and its disk.
      expect(backend.machines).toHaveLength(1);
      expect(backend.machines[0]!.killed).toBe(false);
      expect(tars).toEqual([]);
      expect(untars).toEqual([]);
    } finally {
      await rt.close();
      vi.unstubAllGlobals();
    }
  });
});

/** A Boat box as the provider's API shows it to a host that finds it running: its state is whatever `state()` says,
 * and every command is refused with box_restoring until the box's own clock reaches `restoredAt`, as a box does while
 * its disk streams in behind a ready reading. The backend's sleeps move that clock and cost nothing. A test can hold
 * the answer to one command until it lets go (an abort of the call ends the wait the way a cut connection does),
 * delete the box, or have the provider's agent fail every command. A stop archives the box, which then refuses every
 * command as not running, and a resume calls `resumed` and takes the archive off. A test can also hold the answer to
 * the next read of the box. */
function restoringBox(id: string, o: { state: () => string; restoredAt: number; resumed?: () => void }) {
  const clock = { at: 0, now: () => clock.at, sleep: async (ms: number) => void (clock.at += ms) };
  const box = {
    clock,
    commands: [] as boolean[],
    proofs: 0,
    deleted: false,
    agentFails: false,
    noWorkDir: false,
    restoredAt: o.restoredAt,
    hold: undefined as Promise<void> | undefined,
    archived: false,
    readHold: undefined as Promise<void> | undefined,
    readHeld: false,
  };
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  const missing = (): Response => reply(404, { ok: false, status: 404, code: "not_found", message: "Box not found." });
  const fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/box\/v1/, "");
    const method = init?.method ?? "GET";
    if (path === "/limits") return reply(200, { ok: true, accessTier: "paid" });
    if (method === "DELETE" && path === `/boxes/${id}`) {
      box.deleted = true;
      return reply(202, { ok: true, operation: { id: "bdop_x" } });
    }
    if (method === "POST" && path === `/boxes/${id}/stop`) {
      box.archived = true;
      return reply(202, { ok: true });
    }
    if (method === "POST" && path === `/boxes/${id}/resume`) {
      box.archived = false;
      o.resumed?.();
      return reply(202, { ok: true });
    }
    if (method === "GET" && path === `/boxes/${id}` && box.readHold !== undefined) {
      const held = box.readHold;
      box.readHold = undefined;
      box.readHeld = true;
      await held;
    }
    if (method === "GET" && path === `/boxes/${id}`) return box.deleted ? missing() : reply(200, { ok: true, box: { id, state: box.archived ? "archived" : o.state() } });
    if (method === "POST" && path === `/boxes/${id}/commands`) {
      const held = box.hold;
      if (held !== undefined && (JSON.parse(String(init?.body)) as { command: string }).command === sudoCommand("true")) {
        box.hold = undefined;
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), { once: true });
          void held.then(resolve);
        });
      }
      if (box.deleted) return missing();
      if (box.archived) return reply(409, { ok: false, status: 409, code: "box_not_running", message: "Box is not running." });
      if (box.noWorkDir) return reply(400, { ok: false, status: 400, code: "invalid_cwd", message: "cwd must be an existing directory." });
      if (box.agentFails) return reply(500, { ok: false, status: 500, code: "internal_error", message: "Cannot read properties of undefined (reading 'on')" });
      const restoring = clock.at < box.restoredAt;
      box.commands.push(restoring);
      return restoring
        ? reply(409, { ok: false, status: 409, code: "box_restoring", message: "Box is restoring." })
        : reply(200, { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false });
    }
    return missing();
  };
  const backend = new BoxBackend({ apiKey: "box_x", fetch, clock, budgets: { pollMs: 10, restoreMs: 100 } });
  const machine = new BoxMachine(backend, id, "sandbox");
  const prove = machine.proveRoad.bind(machine);
  machine.proveRoad = (signal?: AbortSignal) => {
    box.proofs++;
    return prove(signal);
  };
  /** Holds the answer to the proof's next ask, the one command it sends, until the returned call lets it go. */
  const holdNext = (): (() => void) => {
    let release!: () => void;
    box.hold = new Promise<void>(resolve => (release = resolve));
    return () => release();
  };
  return Object.assign(box, { machine, holdNext });
}

/** A harness whose turn runs until the test ends; each launch notes whether the box had taken a command by then. */
function launches(box: () => { commands: boolean[] }) {
  const proven: boolean[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: true,
    start: ({ onEvent }) => {
      proven.push(box().commands.at(-1) === false);
      onEvent({ type: "session.start", sessionId: "c1" } as AdapterEvent);
      return { localId: "s1", finished: new Promise<TurnResult>(() => {}), interrupt: async () => {}, steer: async () => "accepted" as const };
    },
  });
  return { factory, proven };
}

describe("a wake that finds a Boat box already running", () => {
  /** A workspace whose host restarted with its record left `left`, and whose box the new host reaches through the
   * provider's API: archived until `ready` is called, or ready from the start. */
  async function restarted(left: "napping" | "waking", restoredAt: number) {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(first, { golden: "snap_g", name: "x" });
    await first.close();
    await store.put("workspaces", ws.id, { ...((await store.get("workspaces", ws.id)) as object), phase: left });
    let state = left === "napping" ? "archived" : "ready";
    const box = restoringBox(ws.machineId, { state: () => state, restoredAt, resumed: () => void (state = "ready") });
    const get = backend.get.bind(backend);
    backend.get = async id => (id === ws.machineId ? box.machine : get(id));
    const launched = launches(() => box);
    const host = () => createRuntime({ backend, store, adapters: { claude: launched.factory }, goneConfirmMs: 0, killConfirm: { graceMs: 0, pollMs: 0 } });
    const rt = host();
    const phases: string[] = [];
    rt.events.on("workspace.status", e => e.type === "workspace.status" && e.status.id === ws.id && phases.push(e.status.phase));
    onTestFinished(() => rt.close());
    return { rt, ws, box, phases, store, host, launched, ready: () => void (state = "ready") };
  }

  const ROADS = [
    { road: "a napping record whose box the wake finds running", left: "napping" },
    { road: "a record a restart found running over a box that was waking", left: "waking" },
  ] as const;

  for (const { road, left } of ROADS) {
    it(`${road}: the wake waits, reading waking, until the box takes commands`, async () => {
      const t = await restarted(left, 30);
      t.ready();
      const woken = await t.rt.workspaces.wake(t.ws.id);
      expect(woken.phase).toBe("running");
      // The box answered box_restoring while the wake waited, and took a command before the wake answered.
      expect(t.box.commands.at(-1)).toBe(false);
      expect(t.box.commands).toContain(true);
      expect(t.phases).toContain("waking");
      expect(t.phases.at(-1)).toBe("running");
    });

    it(`${road}: a box still restoring at the deadline fails the wake with a line that says so, and the next wake waits again`, async () => {
      const t = await restarted(left, 1_000);
      t.ready();
      await expect(t.rt.workspaces.wake(t.ws.id)).rejects.toThrow(noCommandsYetLine("x", "Box is restoring."));
      expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("running");
      t.box.clock.at = 1_000;
      expect((await t.rt.workspaces.wake(t.ws.id)).phase).toBe("running");
      expect(t.box.commands.at(-1)).toBe(false);
    });
  }

  it("a delete between two of the proof's asks sticks: nothing is written back, and a host started on the state lists no such workspace", async () => {
    const t = await restarted("napping", Number.POSITIVE_INFINITY);
    t.ready();
    const release = t.box.holdNext();
    const waking = t.rt.workspaces.wake(t.ws.id);
    waking.catch(() => {});
    await until(() => t.box.hold === undefined);
    await t.rt.workspaces.delete(t.ws.id);
    expect(await t.store.get("workspaces", t.ws.id)).toBeUndefined();
    release();
    await expect(waking).rejects.toThrow();
    expect(await t.store.get("workspaces", t.ws.id)).toBeUndefined();
    const next = t.host();
    onTestFinished(() => next.close());
    expect((await next.workspaces.list()).map(w => w.id)).not.toContain(t.ws.id);
  });

  it("the row's stop ends the proof within a second, leaves the record running, and the next wake proves again", async () => {
    const t = await restarted("napping", 0);
    t.ready();
    const release = t.box.holdNext();
    const waking = t.rt.workspaces.wake(t.ws.id);
    waking.catch(() => {});
    await until(() => t.box.hold === undefined);
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("waking");
    const stop = t.rt.workspaces.stopWake(t.ws.id).then(() => "stopped");
    const answer = await Promise.race([stop, new Promise(resolve => setTimeout(() => resolve("still waiting after a second"), 1_000))]);
    release();
    expect(answer).toBe("stopped");
    await expect(waking).rejects.toThrow(WAKE_STOPPED_UP);
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("running");
    const proofs = t.box.proofs;
    expect((await t.rt.workspaces.wake(t.ws.id)).phase).toBe("running");
    expect(t.box.proofs).toBe(proofs + 1);
  });

  it("a box whose agent fails during the proof fails the wake with that failure, not a line to wait", async () => {
    const t = await restarted("napping", 0);
    t.ready();
    t.box.agentFails = true;
    const failed = await t.rt.workspaces.wake(t.ws.id).then(() => undefined, (e: unknown) => e);
    expect(failed).toBeInstanceOf(GuestUnusableError);
    expect((failed as Error).message).not.toContain("wake it again");
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("running");
  });

  it("a box whose work folder is gone fails the wake naming the folder and the box, and the rebuild it names replaces the box", async () => {
    const t = await restarted("napping", 0);
    t.ready();
    t.box.noWorkDir = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const failed = await t.rt.workspaces.wake(t.ws.id).then(() => undefined, (e: unknown) => e as Error);
    expect(failed?.message).toBe(
      `Boat left ${t.ws.machineId} running but nothing on it can run: ${BOX_WORK_DIR} is missing, and Boat runs every command there (it said: cwd must be an existing directory.); a wake cannot make it again, so a rebuild is the way out, and work not pushed is lost with the old disk`,
    );
    const rebuilt = await t.rt.workspaces.rebuild(t.ws.id);
    expect(rebuilt.phase).toBe("running");
    expect(rebuilt.machineId).not.toBe(t.ws.machineId);
  });

  it("a send to a box whose work folder is gone fails with the same line the wake gives", async () => {
    const t = await restarted("waking", 0);
    t.ready();
    t.box.noWorkDir = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const failed = await t.rt.sessions.start(t.ws.id, { prompt: "go" }).then(() => undefined, (e: unknown) => e as Error);
    expect(failed?.message).toBe(
      `Boat left ${t.ws.machineId} running but nothing on it can run: ${BOX_WORK_DIR} is missing, and Boat runs every command there (it said: cwd must be an existing directory.); a wake cannot make it again, so a rebuild is the way out, and work not pushed is lost with the old disk`,
    );
  });

  it("a box the provider no longer has during the proof takes the gone road", async () => {
    const t = await restarted("napping", 0);
    t.ready();
    const release = t.box.holdNext();
    const waking = t.rt.workspaces.wake(t.ws.id);
    waking.catch(() => {});
    await until(() => t.box.hold === undefined);
    t.box.deleted = true;
    release();
    const failed = await waking.then(() => undefined, (e: unknown) => e as Error);
    expect(failed?.message).not.toContain("wake it again");
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("gone");
  });

  it("a start from the app on a machine not yet proven proves it first, reading waking, and then launches", async () => {
    const t = await restarted("waking", 30);
    await t.rt.sessions.start(t.ws.id, { prompt: "go" });
    expect(t.launched.proven).toEqual([true]);
    expect(t.phases).toContain("waking");
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("running");
  });

  it("two wakes at once share one proof", async () => {
    const t = await restarted("waking", 30);
    await t.rt.workspaces.get(t.ws.id);
    // Both wakes read the machine before either starts its proof, as two callers a moment apart do.
    const read = t.box.machine.state.bind(t.box.machine);
    let arrived = 0;
    let both_read!: () => void;
    const barrier = new Promise<void>(resolve => (both_read = resolve));
    t.box.machine.state = async () => {
      if (++arrived === 2) both_read();
      if (arrived <= 2) await barrier;
      return read();
    };
    const release = t.box.holdNext();
    const answered: string[] = [];
    const both = Promise.all([t.rt.workspaces.wake(t.ws.id), t.rt.workspaces.wake(t.ws.id)].map(w => w.then(v => (answered.push(v.phase), v))));
    await until(() => t.box.hold === undefined);
    await new Promise(r => setTimeout(r, 50));
    // Neither wake answers while the proof's ask is held.
    expect(answered).toEqual([]);
    release();
    expect((await both).map(w => w.phase)).toEqual(["running", "running"]);
    expect(t.box.proofs).toBe(1);
  });

  it("a wake after a proven launch proves nothing, and a steer is not refused", async () => {
    const t = await restarted("waking", 0);
    const handle = await t.rt.sessions.start(t.ws.id, { prompt: "go" });
    const proofs = t.box.proofs;
    const release = t.box.holdNext();
    const waking = t.rt.workspaces.wake(t.ws.id);
    waking.catch(() => {});
    await new Promise(r => setTimeout(r, 20));
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("running");
    await expect(t.rt.sessions.steer(handle.id, { prompt: "and this" })).resolves.toMatchObject({ outcome: expect.any(String) });
    release();
    await waking;
    expect(t.box.proofs).toBe(proofs);
  });

  it("a nap drops the mark: a send on the napping record is refused as paused, runs no proof and leaves it napping", async () => {
    const t = await restarted("waking", 0);
    await t.rt.workspaces.nap(t.ws.id);
    expect(t.box.archived).toBe(true);
    const proofs = t.box.proofs;
    await expect(t.rt.sessions.start(t.ws.id, { prompt: "go" })).rejects.toThrow(sendRefusal(workspaceState({ phase: "napping" }), undefined, "x")!);
    expect(t.box.proofs).toBe(proofs);
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("napping");
    expect(((await t.store.get("workspaces", t.ws.id)) as { phase: string }).phase).toBe("napping");
  });

  it("a delete that ends while the proof's 404 is confirmed sticks: nothing is written back, and a host started on the state lists no such workspace", async () => {
    const t = await restarted("napping", 0);
    t.ready();
    const release = t.box.holdNext();
    const waking = t.rt.workspaces.wake(t.ws.id);
    waking.catch(() => {});
    await until(() => t.box.hold === undefined);
    t.box.deleted = true;
    let letRead!: () => void;
    t.box.readHold = new Promise<void>(resolve => (letRead = resolve));
    release();
    await until(() => t.box.readHeld);
    await t.rt.workspaces.delete(t.ws.id);
    expect(await t.store.get("workspaces", t.ws.id)).toBeUndefined();
    letRead();
    await expect(waking).rejects.toThrow();
    expect(await t.store.get("workspaces", t.ws.id)).toBeUndefined();
    const next = t.host();
    onTestFinished(() => next.close());
    expect((await next.workspaces.list()).map(w => w.id)).not.toContain(t.ws.id);
  });

  it("a stop that lands before the proof's first ask ends the wake with the stop's own line", async () => {
    const t = await restarted("napping", 0);
    t.ready();
    const put = t.store.put.bind(t.store);
    let letPut!: () => void;
    let held = false;
    const gate = new Promise<void>(resolve => (letPut = resolve));
    t.store.put = (async (table: string, key: string, value: unknown) => {
      if (!held && table === "workspaces" && (value as { phase?: string }).phase === "waking") {
        held = true;
        await gate;
      }
      return put(table, key, value as never);
    }) as typeof t.store.put;
    const said = t.rt.workspaces.wake(t.ws.id).then(() => "woke", (e: Error) => e.message);
    await until(() => held);
    const stopping = t.rt.workspaces.stopWake(t.ws.id);
    letPut();
    await stopping;
    expect(await said).toBe(WAKE_STOPPED_UP);
    expect((await t.rt.workspaces.get(t.ws.id)).phase).toBe("running");
  });

  it("a resumed box still restoring at the deadline fails the wake with the same line as one found running", async () => {
    const t = await restarted("napping", Number.POSITIVE_INFINITY);
    await expect(t.rt.workspaces.wake(t.ws.id)).rejects.toThrow(noCommandsYetLine("x", "Box is restoring."));
  });
});
