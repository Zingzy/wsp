// SPDX-License-Identifier: AGPL-3.0-only
// A workspace on a computer that keeps no image has no vault at all: its nap
// is the machine's own stop, nothing of that computer's home is read or
// stored, and a wake puts nothing back. The kinds that keep an image nap
// exactly as they did.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BOX_BUDGETS } from "@wsp/engine";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { DAEMON_TOKEN_PATH, DAEMON_UNIT, EXEC_DEADLINE_EXIT, WAKE_STOPPED } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { droppingPort } from "./held-port.js";
import { createOn, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";

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
