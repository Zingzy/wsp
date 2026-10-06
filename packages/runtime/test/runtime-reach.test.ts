// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFailedLine, machineUnreachableLine } from "@wsp/protocol";
import { DAEMON_RESTART_FAILED, DAEMON_RESTARTING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, type TurnResult, type WorkspaceStatus } from "@wsp/protocol";
import { ExecFailedError, MachineUnreachableError } from "@wsp/engine";
import { DAEMON_TOKEN_NONE, DAEMON_TOKEN_SET, daemonTokenFor, rotateDaemonTokenScript } from "../src/daemon-token.js";
import { writeDaemonRootsScript } from "../src/daemon-roots.js";
import { DAEMON_REVIVE_AGAIN_MS, PORT_PROBE_BODY_CAP, createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { POLL_INTERVAL_MS } from "../src/status.js";
import { memoryStore } from "../src/store.js";
import { until } from "./until.js";
import { stubBackend, tokenGuest, type StubMachine, createOn } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { TOKEN_PATH, TOKEN, helloingDaemon, helloOf } from "./runtime-fixture.js";

describe("runtime daemon reach", () => {
  it("hands back the preview route plus the token it minted, written to the guest once and never in the url", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: expect.stringMatching(/^[0-9a-f]+$/) });
    await rt.workspaces.daemonReach(ws.id);
    expect(minted).toBe(1);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(reach.daemonToken!)]);
  });

  it("mints a token per machine, hex so the write needs no quoting, unless a seed is given", async () => {
    const written: string[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        const m = /^WSP_DAEMON_TOKEN='([^']*)'$/m.exec(cmd);
        if (m) written.push(m[1]!);
        return { exitCode: 0, stdout: DAEMON_TOKEN_SET, stderr: "" };
      };
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
      tokens.push((await rt.workspaces.daemonReach(ws.id)).daemonToken!);
    }
    expect(tokens[0]).toMatch(/^[0-9a-f]{48}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{48}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(written).toEqual(tokens);
    expect(() => createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: "it's not hex" })).toThrow(/hex/);
  });

  it("gives two machines of one runtime two tokens, each its own on its own reach view, and writes a machine no second one", async () => {
    const backend = stubBackend();
    const written: string[] = [];
    backend.execImpl = (_m, cmd) => {
      const named = /^WSP_DAEMON_TOKEN='([^']*)'$/m.exec(cmd);
      if (named) written.push(named[1]!);
      return { exitCode: 0, stdout: DAEMON_TOKEN_SET, stderr: "" };
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const one = await createOn(rt, { golden: "snap_g", name: "a" });
    const two = await createOn(rt, { golden: "snap_g", name: "b" });
    for (const m of backend.machines) m.previewUrl = async (port: number) => ({ url: `https://${m.id}-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });

    const first = (await rt.workspaces.daemonReach(one.id)).daemonToken!;
    const second = (await rt.workspaces.daemonReach(two.id)).daemonToken!;
    // The token read off one box opens no other machine this host rotated onto.
    expect(first).not.toBe(second);
    expect(written).toEqual([first, second]);
    // A machine keeps the token it was written; a second ask writes nothing and hands back the same one.
    expect((await rt.workspaces.daemonReach(one.id)).daemonToken).toBe(first);
    expect(written).toEqual([first, second]);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(first)]);
    expect(backend.machines[1]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(second)]);
    await rt.close();
  });

  it("derives each machine's token from the seed a caller pinned, so two runtimes on one seed write one machine one token", async () => {
    const reachOf = async (): Promise<string> => {
      const backend = stubBackend();
      backend.execImpl = tokenGuest;
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      backend.machines[0]!.previewUrl = async (port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
      const token = (await rt.workspaces.daemonReach(ws.id)).daemonToken!;
      await rt.close();
      return token;
    };
    expect(await reachOf()).toBe(daemonTokenFor(TOKEN, "m1"));
    expect(await reachOf()).toBe(daemonTokenFor(TOKEN, "m1"));
  });

  it("omits the daemon token when the guest has none and refuses backends without preview urls", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes(TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_NONE}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("without preview URLs");

    backend.machines[0]!.previewUrl = async () => ({ url: "https://m1-7070.preview.example/?pt_token=e", token: "e", expiresAt: Date.now() + 3_600_000 });
    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach.daemonToken).toBeUndefined();
    expect("daemonToken" in reach).toBe(false);
  });

  it("updateDaemon runs the recipe's deploy on the running machine, then writes this runtime's token again so the next reach opens the new daemon", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { id: string; exec(cmd: string): Promise<unknown> }) => {
        deployed.push(machine.id);
        await machine.exec("DEPLOY_DAEMON");
        return "daemon on node v22";
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 50 });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    m.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const token = (await rt.workspaces.daemonReach(ws.id)).daemonToken!;
    const before = m.execLog.length;

    await rt.workspaces.updateDaemon(ws.id);
    expect(deployed).toEqual(["m1"]);
    // The deploy started the daemon on its own token; the rotation after it is what makes this machine's token open it.
    const after = m.execLog.slice(before);
    expect(after).toEqual(["DEPLOY_DAEMON", rotateDaemonTokenScript(token)]);
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe(token);
    expect(m.execLog.length).toBe(before + 2);

    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.updateDaemon(ws.id)).rejects.toThrow("wake a before updating its daemon");
    expect(deployed).toEqual(["m1"]);
  });

  it("replaces a daemon older than this wsp by itself: the runtime connects to a machine it adopts, reads the hello and deploys, with nothing asking it to", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1);
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(before, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      const deployed: string[] = [];
      let release!: () => void;
      const held = new Promise<void>(r => (release = r));
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async (machine: { id: string }) => {
          deployed.push(machine.id);
          await held;
          daemon.announce(DAEMON_VERSION);
        },
      };
      // The host starting again over the same store, on a machine that is already running: the one case a person
      // hits after an upgrade, and the one nothing else in the runtime reaches.
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      const pushed: WorkspaceStatus[] = [];
      rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
      await rt.workspaces.list();
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);

      // The row says what is being done while it is being done, and the status carrying it still carries the nap
      // countdown: a client replaces the whole status, so a line that dropped it would blank the row.
      await until(async () => (await rt.workspaces.get(ws.id)).daemonNote === DAEMON_UPDATING);
      const updating = pushed.filter(st => st.daemonNote === DAEMON_UPDATING);
      expect(updating).toHaveLength(1);
      expect(updating[0]!.idleAt).toBeGreaterThan(Date.now());

      release();
      await until(async () => (await rt.workspaces.get(ws.id)).daemonNote === undefined);
      expect(pushed.at(-1)!.daemonNote).toBeUndefined();
      expect(pushed.at(-1)!.idleAt).toBeGreaterThan(Date.now());
    } finally {
      await daemon.close();
    }
  });

  it("a deploy that fails leaves the old daemon serving, says so on the row once and no longer, and logs the reason", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1);
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(before, { golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      let atDeploy = -1;
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async () => {
          atDeploy = m.execLog.length;
          throw new Error("daemon deploy failed: NPM_FAIL");
        },
      };
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      const pushed: WorkspaceStatus[] = [];
      rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
      const warned: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
      try {
        await rt.workspaces.list();
        await until(() => pushed.some(st => st.daemonNote === DAEMON_UPDATE_FAILED));
      } finally {
        warn.mockRestore();
      }
      // The row said it once. It is not on the workspace any more, so the next poll shows the rate and the
      // countdown again rather than a failure nobody here can act on.
      expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
      expect(pushed.filter(st => st.daemonNote === DAEMON_UPDATE_FAILED)).toHaveLength(1);
      // The reason npm gave is in this host's log and nowhere a person reads.
      expect(warned.some(l => l.includes("daemon deploy failed: NPM_FAIL") && l.includes("m1"))).toBe(true);
      expect(pushed.every(st => st.daemonNote === undefined || !st.daemonNote.includes("NPM_FAIL"))).toBe(true);
      // Nothing reached the machine after the deploy threw, the token was not rotated away from the daemon that
      // holds it, and that daemon still answers with the version it always did.
      expect(m.execLog.slice(atDeploy)).toEqual([]);
      expect(await helloOf(daemon.port)).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  it("waits out a running turn before replacing the daemon, since the deploy ends what the turn runs under", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1, true);
    let finish!: (r: TurnResult) => void;
    const held: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const sessionId = "55555555-5555-4555-8555-555555555555";
        queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
        return {
          localId: sessionId,
          finished: new Promise<TurnResult>(r => {
            finish = result => {
              o.onEvent({ type: "turn.done", sessionId, result });
              o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
              r(result);
            };
          }),
          interrupt: async () => {},
        };
      },
    });
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(before, { golden: "snap_g", name: "a" });
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      const deployed: string[] = [];
      const recipe = { setup: "true", smoke: "true", deployDaemon: async (m: { id: string }) => void deployed.push(m.id) };
      const rt = createRuntime({ backend, store, adapters: { claude: held }, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 5_000 });
      await rt.workspaces.list();
      // A turn opens while the runtime is still waiting on the machine's hello: the update it is about to run holds.
      await rt.sessions.start(ws.id, { prompt: "go" });
      await until(async () => (await rt.sessions.list())[0]?.status === "running");
      daemon.release();
      await new Promise(r => setTimeout(r, 200));
      expect(deployed).toEqual([]);

      finish({ status: "completed", text: "done" });
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);
    } finally {
      finish?.({ status: "completed", text: "" });
      await daemon.close();
    }
  });

  it("a start that gives up before its turn reached the machine lets the daemon update through: its end says the turn stopped running", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const daemon = await helloingDaemon(1, true);
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const refusing: HarnessAdapterFactory = () => ({
      steers: false,
      probeCatalog: async () => (await probed, null),
      start: () => {
        throw new Error("the harness would not launch");
      },
    });
    try {
      const store = memoryStore();
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(before, { golden: "snap_g", name: "a" });
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      const deployed: string[] = [];
      const recipe = { setup: "true", smoke: "true", deployDaemon: async (m: { id: string }) => void deployed.push(m.id) };
      const rt = createRuntime({ backend, store, adapters: { claude: refusing }, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 5_000 });
      await rt.workspaces.list();
      const giving = rt.sessions.start(ws.id, { prompt: "go" });
      await until(async () => (await rt.sessions.list())[0]?.status === "running");
      // The update now waits out the turn this start is opening, as it waits out one already running.
      daemon.release();
      await new Promise(r => setTimeout(r, 200));
      expect(deployed).toEqual([]);

      letProbe();
      await expect(giving).rejects.toThrow("the harness would not launch");
      await until(() => deployed.length === 1);
      expect(await rt.sessions.list()).toEqual([]);
      await rt.close();
    } finally {
      await daemon.close();
    }
  });

  it("writes the folder the record's project names on every connect, and again after the update, so it is browsable without a second import", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1);
    let roots = "";
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await createOn(before, { golden: "snap_g", name: "a" });
      roots = writeDaemonRootsScript([ws.project.path]);
      const m = backend.machines[0]!;
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      let atDeploy = -1;
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async () => {
          atDeploy = m.execLog.length;
          daemon.announce(DAEMON_VERSION);
        },
      };
      const from = m.execLog.length;
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      await rt.workspaces.list();
      await until(() => m.execLog.slice(from).filter(cmd => cmd === roots).length === 2);
      // Once before the daemon is asked anything, so the first files op lands; once after the daemon was replaced.
      expect(m.execLog.slice(from, atDeploy).filter(cmd => cmd === roots)).toEqual([roots]);
      expect(m.execLog.slice(atDeploy).filter(cmd => cmd === roots)).toEqual([roots]);
    } finally {
      await daemon.close();
    }
  });

  const openServers: Server[] = [];
  afterEach(async () => {
    await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
    openServers.length = 0;
  });

  /** A preview edge in front of a machine whose daemon port answers nothing: the shape a dead daemon has on the
   * wire (a prompt 502), and 426 once `up` is set, which is the daemon answering again. */
  async function daemonPort(up: () => boolean): Promise<{ server: Server; port: number; hits: () => number }> {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(up() ? 426 : 502).end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    return { server, port: (server.address() as AddressInfo).port, hits: () => hits };
  }

  it("puts the daemon back on a running machine whose port answers nothing, with nothing asking it to", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    // Answers once, then dies: the first silence is a window, and only the second is a daemon that is gone.
    let probes = 0;
    let back = false;
    const edge = await daemonPort(() => ++probes === 1 || back);
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { id: string }) => {
        deployed.push(machine.id);
        back = true;
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const pushed: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));

    const stop = rt.status.watch();
    try {
      await until(() => deployed.length === 1);
      // One silence is a window a restart sits inside; the deploy waits for the second.
      expect(edge.hits()).toBeGreaterThanOrEqual(3);
      await until(() => pushed.at(-1)?.reach.state === "reachable");
    } finally {
      stop();
    }
    expect(deployed).toEqual(["m1"]);
    // The row said what was being done while it was being done, and says nothing once the daemon answers again.
    expect(pushed.filter(st => st.daemonNote === DAEMON_RESTARTING).length).toBeGreaterThanOrEqual(1);
    expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
    // The redeploy went through the same road the verb takes, so this machine's own token opens the new daemon.
    expect(backend.machines[0]!.execLog).toContain(rotateDaemonTokenScript(daemonTokenFor(TOKEN, "m1")));
  });

  it("leaves a machine alone whose daemon answers again on the next poll: one silence is not a dead daemon", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    let probes = 0;
    // Every other probe answers; the run of silences never reaches two.
    const edge = await daemonPort(() => ++probes % 2 === 1);
    const deployed: string[] = [];
    const recipe = { setup: "true", smoke: "true", deployDaemon: async (machine: { id: string }) => void deployed.push(machine.id) };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    await createOn(rt, { golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const stop = rt.status.watch();
    try {
      await until(() => edge.hits() >= 10);
    } finally {
      stop();
    }
    expect(deployed).toEqual([]);
  });

  it("a redeploy that fails says so on the row once, logs the reason, holds the row at no-daemon, and is tried again a cooldown later", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const fc = fakeClock();
    const edge = await daemonPort(() => false);
    const deployed: number[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async () => {
        deployed.push(fc.clock.now());
        throw new Error("daemon deploy failed: NPM_FAIL");
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, clock: fc.clock, goldenRecipe: recipe, status: { costIntervalMs: 24 * 3_600_000, reconcileMinMs: 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: fc.clock.now() + 3_600_000 });
    const pushed: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    /** One poll tick, waited out: the timer runs on the fake clock, the probe and the deploy on real promises. */
    const poll = async (): Promise<void> => {
      const before = edge.hits();
      fc.advance(POLL_INTERVAL_MS);
      await until(() => edge.hits() > before);
      await new Promise(r => setTimeout(r, 30));
    };
    const stop = rt.status.watch();
    try {
      await poll();
      await poll();
      await until(() => deployed.length === 1);
      await until(() => pushed.some(st => st.daemonNote === DAEMON_RESTART_FAILED));
      // Ten more polls, three minutes of them, all inside the cooldown: the machine is left alone.
      for (let i = 0; i < 10; i++) await poll();
      expect(deployed).toHaveLength(1);
      // The row a client is left looking at says the machine's daemon is dead, not that the machine answers: a
      // push made while the deploy ran must not paint over what the poll measured, or the poll's own word after it
      // reads as a repeat and never reaches the bus.
      expect(pushed.at(-1)!.reach.state).toBe("no-daemon");
      expect(pushed.at(-1)!.daemonNote).toBeUndefined();
      // Past the cooldown, it tries again on its own.
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await until(() => deployed.length === 2);
    } finally {
      stop();
      warn.mockRestore();
    }
    expect(deployed[1]! - deployed[0]!).toBeGreaterThanOrEqual(DAEMON_REVIVE_AGAIN_MS);
    // Neither line about the daemon claims the machine answers. The runtime has no probe of its own between
    // polls, so a push carries what the poll measured rather than what a running machine's kind would claim.
    const aboutTheDaemon = pushed.filter(st => st.daemonNote === DAEMON_RESTARTING || st.daemonNote === DAEMON_RESTART_FAILED);
    expect(aboutTheDaemon.length).toBeGreaterThanOrEqual(3);
    expect(aboutTheDaemon.every(st => st.reach.state === "no-daemon")).toBe(true);
    // The row said it and stopped saying it; the npm log is in this host's log and nowhere a person reads.
    expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
    expect(warned.some(l => l.includes("not restarted") && l.includes("NPM_FAIL") && l.includes("m1"))).toBe(true);
    expect(pushed.every(st => st.daemonNote === undefined || !st.daemonNote.includes("NPM_FAIL"))).toBe(true);
  });

  /** A fork a host before this one made, whose daemon is the one on this port, and the host starting again over the
   * same store on a fake clock with a deploy that brings the daemon to this wsp's version. */
  async function restartOnto(daemon: Awaited<ReturnType<typeof helloingDaemon>>, deploys: boolean, served = false) {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const fc = fakeClock();
    const ws = await createOn(createRuntime({ backend, store, adapters: {} }), { golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${daemon.port}/`, token: "e", expiresAt: Date.now() + 3_600_000 });
    if (served) backend.machines[0]!.daemonFrame = async () => ({ ok: true });
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (m: { id: string }) => {
        deployed.push(m.id);
        daemon.announce(DAEMON_VERSION);
      },
    };
    const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, clock: fc.clock, ...(deploys ? { goldenRecipe: recipe } : {}), daemonHelloTimeoutMs: 100, status: { costIntervalMs: 24 * 3_600_000, reconcileMinMs: 60_000 } });
    /** One poll tick, waited out: the timer runs on the fake clock, the probe and the sync on real promises. */
    const poll = async (): Promise<void> => {
      const before = daemon.hits();
      fc.advance(POLL_INTERVAL_MS);
      await until(() => daemon.hits() > before);
      await new Promise(r => setTimeout(r, 150));
    };
    return { rt, ws, fc, deployed, poll, unread: `daemon on m1 (workspace ${ws.id}): version not read within 0.1 s; asking again at the next reach probe` };
  }

  it("a sync whose version read answers nothing says so in the log, and asks again at the first probe past the revive window that finds the machine answering", async () => {
    const daemon = await helloingDaemon(DAEMON_VERSION - 1, true);
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    const said = (): string[] => warned.filter(l => l.startsWith("daemon on"));
    let stop = (): void => {};
    try {
      const { rt, ws, fc, deployed, poll, unread } = await restartOnto(daemon, true);
      await rt.workspaces.list();
      await until(() => said().length === 1);
      expect(said()).toEqual([unread]);
      expect([deployed, daemon.dials()]).toEqual([[], 1]);

      // Probes inside the window find the machine answering and ask it nothing.
      stop = rt.status.watch();
      await poll();
      await poll();
      expect([deployed, daemon.dials(), said()]).toEqual([[], 1, [unread]]);

      // Past it, the probe that finds the machine answering runs the sync again, and this time the hello lands.
      daemon.release();
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);
      await until(async () => (await rt.workspaces.get(ws.id)).daemonNote === undefined);

      // The read that answered took the mark off: a later window asks nothing more.
      const dialled = daemon.dials();
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await poll();
      expect([deployed, daemon.dials(), said()]).toEqual([["m1"], dialled, [unread]]);
    } finally {
      stop();
      warn.mockRestore();
      await daemon.close();
    }
  });

  it("a version read that answers nothing again says so again, one that answers current deploys nothing and asks no more, and a host with no deploy road or a workspace its computer serves neither dials nor warns", async () => {
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    const said = (): string[] => warned.filter(l => l.startsWith("daemon on"));
    const stops: (() => void)[] = [];
    const daemon = await helloingDaemon(DAEMON_VERSION, true);
    const bare = await helloingDaemon(DAEMON_VERSION - 1, true);
    const boxed = await helloingDaemon(DAEMON_VERSION - 1, true);
    try {
      const { rt, fc, deployed, poll, unread } = await restartOnto(daemon, true);
      await rt.workspaces.list();
      await until(() => said().length === 1);
      stops.push(rt.status.watch());
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await until(() => said().length === 2);
      expect([said(), daemon.dials()]).toEqual([[unread, unread], 2]);

      daemon.release();
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await until(() => daemon.dials() === 3);
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await poll();
      expect([deployed, daemon.dials(), said()]).toEqual([[], 3, [unread, unread]]);

      // A host wired without the bundle has nothing to ask a version for.
      warned.length = 0;
      const without = await restartOnto(bare, false);
      await without.rt.workspaces.list();
      stops.push(without.rt.status.watch());
      without.fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await without.poll();
      await without.poll();
      expect([bare.dials(), said()]).toEqual([0, []]);

      // Nor is anything asked inside a workspace whose computer serves its daemon.
      const box = await restartOnto(boxed, true, true);
      await box.rt.workspaces.list();
      stops.push(box.rt.status.watch());
      box.fc.advance(DAEMON_REVIVE_AGAIN_MS + POLL_INTERVAL_MS);
      await new Promise(r => setTimeout(r, 300));
      expect([boxed.dials(), said(), box.deployed]).toEqual([0, [], []]);
    } finally {
      for (const stop of stops) stop();
      warn.mockRestore();
      await daemon.close();
      await bare.close();
      await boxed.close();
    }
  });

  it("puts this wsp's daemon on a fresh fork inside its own create, where the image carries an older one, and says nothing about a workspace that is not there yet", async () => {
    const daemon = await helloingDaemon(DAEMON_VERSION - 1);
    const deployed: string[] = [];
    const warned: string[] = [];
    let cloneStarted = (): void => {};
    let deployEnded = (): void => {};
    // The clone the create runs is held until the deploy has landed, and the deploy waits for the clone to be
    // asked, so the deploy provably runs while the record is still creating rather than early by timing. A sync
    // refused at the verb's door releases the clone too, so a red run ends rather than hanging on the hold.
    const cloneAsked = new Promise<void>(resolve => (cloneStarted = resolve));
    const deployDone = new Promise<void>(resolve => (deployEnded = resolve));
    const warn = vi.spyOn(console, "warn").mockImplementation(line => {
      warned.push(String(line));
      if (String(line).includes("not updated")) deployEnded();
    });
    try {
      const backend = stubBackend();
      backend.execImpl = async (m, cmd) => {
        if (cmd.includes("clone")) {
          cloneStarted();
          await deployDone;
        }
        return tokenGuest(m, cmd);
      };
      const create = backend.create.bind(backend);
      backend.create = async spec => {
        const m = await create(spec);
        m.previewUrl = async () => ({ url: `http://127.0.0.1:${daemon.port}/`, token: "e", expiresAt: Date.now() + 3_600_000 });
        return m;
      };
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async (m: { id: string }) => {
          await cloneAsked;
          deployed.push(m.id);
          daemon.announce(DAEMON_VERSION);
          deployEnded();
        },
      };
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      expect(deployed).toEqual(["m1"]);
      // Nothing about the daemon reached the log: no refusal for a workspace the verb's door cannot see yet.
      expect(warned.filter(l => l.startsWith("daemon on"))).toEqual([]);
      expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
      await rt.close();
    } finally {
      warn.mockRestore();
      await daemon.close();
    }
  });

  it("a machine replaced under the record starts its own attempt instead of inheriting the old machine's cooldown", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const edge = await daemonPort(() => false);
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { id: string }) => {
        deployed.push(machine.id);
        throw new Error("daemon deploy failed: NPM_FAIL");
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 100, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const edgeOn = (m: StubMachine): void => {
      m.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    };
    edgeOn(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = rt.status.watch();
    try {
      await until(() => deployed.length === 1);
      await rt.workspaces.rebuild(ws.id);
      edgeOn(backend.machines[1]!);
      // Well inside the cooldown the first machine earned: the entry is that machine's, and this is another one.
      await until(() => deployed.length === 2, 5_000);
    } finally {
      stop();
      await rt.close();
      warn.mockRestore();
    }
    expect(deployed).toEqual(["m1", "m2"]);
  });

  it("leaves a dead daemon alone on a backend that mints no upload URL, since the deploy has no road to the machine", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    backend.capabilities.signedUrls = false;
    const edge = await daemonPort(() => false);
    const deployed: string[] = [];
    const recipe = { setup: "true", smoke: "true", deployDaemon: async (machine: { id: string }) => void deployed.push(machine.id) };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    await createOn(rt, { golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const stop = rt.status.watch();
    try {
      await until(() => edge.hits() >= 10);
    } finally {
      stop();
    }
    expect(deployed).toEqual([]);
  });

  it("updateDaemon refuses on a runtime whose recipe carries no deploy", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await expect(rt.workspaces.updateDaemon(ws.id)).rejects.toThrow("cannot deploy a daemon");
    await expect(rt.workspaces.updateDaemon("ws_nobody")).rejects.toThrow("no such workspace");
  });

  it("writes a token again after a rebuild replaces the machine, the new machine's own", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const mint = async (port: number) => ({ url: `https://x-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
    backend.machines[0]!.previewUrl = mint;
    const gone = (await rt.workspaces.daemonReach(ws.id)).daemonToken!;

    await rt.workspaces.rebuild(ws.id);
    backend.machines[1]!.previewUrl = mint;
    const fresh = (await rt.workspaces.daemonReach(ws.id)).daemonToken!;
    expect(fresh).not.toBe(gone);
    expect(backend.machines[1]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(fresh)]);
  });

  describe("a machine the provider answers it cannot reach", () => {
    const LINE = machineUnreachableLine("Sandbox is not reachable");
    /** What `wsp workspaces --json` asks the runtime for. */
    const TABLE = { reconcile: "on-failure", zombieProbe: false, reader: "table" } as const;

    /** A fork whose daemon answers over its route while the provider refuses every command on the machines in
     * `refusing` with `refusal`, and answers none on those in `hanging`. */
    async function refusedFork(o: { up?: () => boolean; recipe?: { setup: string; smoke: string; deployDaemon: (m: { id: string }) => Promise<void> }; refusal?: (machineId: string) => MachineUnreachableError } = {}) {
      const backend = stubBackend();
      const refusing = new Set<string>();
      const hanging = new Set<string>();
      const refusal = o.refusal ?? (id => new MachineUnreachableError(id, "Sandbox is not reachable", 502, LINE));
      backend.execImpl = (m, cmd) => {
        if (refusing.has(m.id)) throw refusal(m.id);
        if (hanging.has(m.id)) return new Promise<never>(() => {});
        return tokenGuest(m, cmd);
      };
      const fc = fakeClock();
      const edge = await daemonPort(o.up ?? (() => true));
      const store = memoryStore();
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, clock: fc.clock, ...(o.recipe !== undefined ? { goldenRecipe: o.recipe } : {}), status: { costIntervalMs: 24 * 3_600_000, reconcileMinMs: 60_000 } });
      const ws = await createOn(rt, { golden: "snap_g", name: "far" });
      const routed = (m: StubMachine): void => {
        m.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: fc.clock.now() + 3_600_000 });
      };
      routed(backend.machines[0]!);
      // The route's token is read once and kept, as on a fork a host has dialled before the provider lost it.
      await rt.workspaces.daemonReach(ws.id);
      const pushed: WorkspaceStatus[] = [];
      rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
      /** One poll tick, waited out: the timer runs on the fake clock, the probe and the heal on real promises. */
      const ticked = async (tick: () => void): Promise<void> => {
        const before = edge.hits();
        tick();
        await until(() => edge.hits() > before);
        await new Promise(r => setTimeout(r, 30));
      };
      const poll = (): Promise<void> => ticked(() => fc.advance(POLL_INTERVAL_MS));
      /** The watch polls once at once; that tick is waited out too, so each poll after it is one tick. */
      const watch = async (): Promise<() => void> => {
        let stop = (): void => {};
        await ticked(() => {
          stop = rt.status.watch();
        });
        return stop;
      };
      const probes = (m: StubMachine): number => m.execLog.filter(c => c === "echo ok").length;
      return { backend, store, rt, ws, fc, refusing, hanging, routed, pushed, poll, watch, probes };
    }

    it("puts the provider's sentence on the row the moment an exec is refused, and the table reads the same", async () => {
      const { backend, rt, ws, refusing, pushed } = await refusedFork();
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(LINE);
      expect(pushed.at(-1)).toMatchObject({ id: ws.id, machineState: "running", reach: { state: "unreachable" }, reason: LINE });
      const row = (await rt.status.list(TABLE))[0]!;
      expect(row).toMatchObject({ id: ws.id, machineState: "running", reach: { state: "unreachable" }, reason: LINE });
      expect(row.reach.url).toContain("127.0.0.1");
      expect(backend.machines[0]!.execLog.filter(c => c === "echo ok").length).toBeLessThanOrEqual(1);
    });

    it("heals at the next tick when the tracker's own probe answers through the machine, and the row reads the probe again", async () => {
      const { backend, rt, ws, refusing, pushed, poll, watch, probes } = await refusedFork();
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(LINE);
      refusing.delete("m1");
      const before = pushed.length;
      const stop = await watch();
      try {
        expect(probes(backend.machines[0]!)).toBe(1);
        await poll();
      } finally {
        stop();
      }
      // The answer pushes nothing and the tick it healed under drops the row it built marked: the next tick speaks once.
      expect(pushed.slice(before).map(st => `${st.reach.state} ${st.reason ?? "-"}`)).toEqual(["reachable -"]);
      expect(probes(backend.machines[0]!)).toBe(1);
    });

    it("puts the second answer's sentence on the row when the provider cannot run commands on the machine, and the table reads the same", async () => {
      const EXEC_LINE = execFailedLine("exec failed");
      const { rt, ws, refusing, pushed } = await refusedFork({ refusal: id => new ExecFailedError(id, "exec failed", 502) });
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(EXEC_LINE);
      expect(pushed.at(-1)).toMatchObject({ id: ws.id, machineState: "running", reach: { state: "unreachable" }, reason: EXEC_LINE });
      const row = (await rt.status.list(TABLE))[0]!;
      expect(row).toMatchObject({ id: ws.id, machineState: "running", reach: { state: "unreachable" }, reason: EXEC_LINE });
      expect(row.reach.url).toContain("127.0.0.1");
    });

    it("heals the second answer at the next tick as it heals the first", async () => {
      const { backend, rt, ws, refusing, pushed, poll, watch, probes } = await refusedFork({ refusal: id => new ExecFailedError(id, "exec failed", 502) });
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(execFailedLine("exec failed"));
      refusing.delete("m1");
      const before = pushed.length;
      const stop = await watch();
      try {
        expect(probes(backend.machines[0]!)).toBe(1);
        await poll();
      } finally {
        stop();
      }
      expect(pushed.slice(before).map(st => `${st.reach.state} ${st.reason ?? "-"}`)).toEqual(["reachable -"]);
      expect(probes(backend.machines[0]!)).toBe(1);
    });

    it("a refusal that lands while a tick is being built is not painted over by the row that tick built before it", async () => {
      let rt!: ReturnType<typeof createRuntime>;
      let id = "";
      let refusing!: Set<string>;
      let asked = 0;
      // The provider starts refusing while the first tick's reach probe is out, after that tick read its records.
      const fork = await refusedFork({
        up: () => {
          if (++asked === 1) {
            refusing.add("m1");
            void rt.workspaces.exec(id, "true").catch(() => {});
          }
          return true;
        },
      });
      ({ rt, refusing } = fork);
      id = fork.ws.id;
      const said = (): string[] => fork.pushed.map(st => `${st.reach.state} ${st.reason ?? "-"}`);
      const stop = await fork.watch();
      try {
        expect(said()).toEqual([`unreachable ${LINE}`]);
        await fork.poll();
      } finally {
        stop();
      }
      expect(said()).toEqual([`unreachable ${LINE}`, `unreachable ${LINE}`]);
    });

    it("probes a machine the provider keeps refusing once per tick, and the row keeps its word", async () => {
      const { backend, rt, ws, refusing, pushed, poll, watch, probes } = await refusedFork();
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(LINE);
      const stop = await watch();
      try {
        expect(probes(backend.machines[0]!)).toBe(1);
        for (let i = 2; i <= 4; i++) {
          await poll();
          expect(probes(backend.machines[0]!)).toBe(i);
        }
      } finally {
        stop();
      }
      expect(pushed.at(-1)).toMatchObject({ id: ws.id, reach: { state: "unreachable" }, reason: LINE });
    });

    it("leaves a marked machine whose daemon reads dead alone: no deploy over the refused exec, no restart line, no flash", async () => {
      const deployed: string[] = [];
      let rt!: ReturnType<typeof createRuntime>;
      let id = "";
      let refusing!: Set<string>;
      let asked = 0;
      // The provider starts refusing while the tick's own reach probe is out, so the probe's no-daemon reaches the revive with the mark standing.
      const fork = await refusedFork({
        up: () => {
          if (++asked === 1) {
            refusing.add("m1");
            void rt.workspaces.exec(id, "true").catch(() => {});
          }
          return false;
        },
        recipe: { setup: "true", smoke: "true", deployDaemon: async m => void deployed.push(m.id) },
      });
      ({ rt, refusing } = fork);
      id = fork.ws.id;
      const warned: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
      const stop = await fork.watch();
      try {
        // Long enough for a revive's deploy, its roots write and its flash to have run on real promises.
        await new Promise(r => setTimeout(r, 150));
        expect(deployed).toEqual([]);
        expect(warned.filter(l => l.includes("not restarted"))).toEqual([]);
        expect(fork.pushed.filter(st => st.daemonNote === DAEMON_RESTART_FAILED || st.daemonNote === DAEMON_RESTARTING)).toEqual([]);
        await fork.poll();
        expect(fork.pushed.at(-1)).toMatchObject({ reach: { state: "unreachable" }, reason: LINE });
      } finally {
        stop();
        warn.mockRestore();
      }
    });

    it("a rebuild that puts another machine under the record drops the mark", async () => {
      const { backend, rt, ws, refusing, routed } = await refusedFork();
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(LINE);
      await rt.workspaces.rebuild(ws.id);
      routed(backend.machines[1]!);
      const row = (await rt.status.list(TABLE))[0]!;
      expect(row.machineId).toBe("m2");
      expect(row.reach.state).toBe("reachable");
      expect(row.reason).toBeUndefined();
    });

    it("a workspace forgotten leaves no mark behind for the same machine should the sweep record it again", async () => {
      const { backend, store, rt, ws, refusing, hanging } = await refusedFork();
      const m1 = backend.machines[0]!;
      refusing.add("m1");
      await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow(LINE);
      const stamp = await store.get("workspace-names", ws.id);
      m1.killed = true;
      await rt.workspaces.forget(ws.id);
      m1.killed = false;
      // The stamp the sweep names a machine's workspace from, as a store the machine outlived still holds it.
      await store.put("workspace-names", ws.id, stamp);
      // Neither a refusal nor an answer from here on: only what the forget left can put the sentence back.
      refusing.delete("m1");
      hanging.add("m1");
      m1.spec.labels!["createdAt"] = new Date(Date.now() - 2 * 60_000).toISOString();
      expect((await rt.reap()).adopted).toMatchObject([{ id: "m1", workspaceId: ws.id }]);
      const row = (await rt.status.list(TABLE))[0]!;
      expect(row).toMatchObject({ id: ws.id, machineId: "m1" });
      expect(row.reach.state).toBe("reachable");
      expect(row.reason).not.toBe(LINE);
    });
  });
});

describe("runtime port reach", () => {
  it("mints a guest port's route once while fresh, caches per port, and never reads or carries the daemon token", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const minted: number[] = [];
    backend.machines[0]!.previewUrl = async port => {
      minted.push(port);
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    // Nothing listens on 3000 in this fixture: a typed-in port still mints, the tab decides what to show.
    const reach = await rt.workspaces.portReach(ws.id, 3000);
    expect(reach).toEqual({ url: "https://m1-3000.preview.example/?pt_token=edge", expiresAt: expect.any(Number) });
    await rt.workspaces.portReach(ws.id, 3000);
    await rt.workspaces.portReach(ws.id, 5173);
    expect(minted).toEqual([3000, 5173]);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toHaveLength(0);
  });

  it("rejects an unknown workspace", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    await expect(rt.workspaces.portReach("ws_nobody", 3000)).rejects.toThrow(/no such workspace/);
  });
});

const VITE_BLOCKED = "Blocked request. This host (m1-5173.preview.example) is not allowed. To allow this host, add it to server.allowedHosts";

/** A guest port as the preview edge would relay it: one answer for every request, closed by the test. */
async function guestPort(statusCode: number, body: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => res.writeHead(statusCode, { "content-type": "text/plain" }).end(body));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}/?pt_token=edge` };
}

describe("runtime port probe", () => {
  const closing: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      closing.map(s => {
        s.closeAllConnections();
        return new Promise<void>(r => s.close(() => r()));
      }),
    );
    closing.length = 0;
  });

  it("fetches the port's minted route once and reports the status and body a frame cannot read", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const guest = await guestPort(403, VITE_BLOCKED);
    closing.push(guest.server);
    const minted: number[] = [];
    backend.machines[0]!.previewUrl = async port => {
      minted.push(port);
      return { url: guest.url, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    expect(await rt.workspaces.portProbe(ws.id, 5173)).toEqual({ status: 403, body: VITE_BLOCKED });
    expect(minted).toEqual([5173]);
  });

  it("cuts the body at the cap so a page never rides the reply whole", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const guest = await guestPort(200, "<html>".padEnd(PORT_PROBE_BODY_CAP + 500, "x"));
    closing.push(guest.server);
    backend.machines[0]!.previewUrl = async () => ({ url: guest.url, token: "edge", expiresAt: Date.now() + 3_600_000 });

    const probe = await rt.workspaces.portProbe(ws.id, 3000);
    expect(probe.status).toBe(200);
    expect(probe.body).toHaveLength(PORT_PROBE_BODY_CAP);
  });

  it("never follows a redirect: a 302 on the route is the frame's business, not a refetch without the token", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url?.startsWith("/app")) res.writeHead(401).end("edge: no token");
      else res.writeHead(302, { location: "/app" }).end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    closing.push(server);
    const addr = server.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${guestPort}/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 });

    expect((await rt.workspaces.portProbe(ws.id, 3000)).status).toBe(302);
    expect(seen).toEqual(["/?pt_token=edge"]);
  });

  it("reads the body only up to the cap: a response that never ends still answers with its first bytes", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>".padEnd(PORT_PROBE_BODY_CAP + 500, "x"));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    closing.push(server);
    const addr = server.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${guestPort}/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 });

    const probe = await rt.workspaces.portProbe(ws.id, 3000);
    expect(probe.status).toBe(200);
    expect(probe.body).toHaveLength(PORT_PROBE_BODY_CAP);
    expect(probe.body.startsWith("<html>")).toBe(true);
  });

  it("a 401 drops the port's cached route and mints a fresh one, so the next portReach carries the new token", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const server = createServer((req, res) => {
      if (req.url?.endsWith("pt_token=t1")) res.writeHead(401).end("token expired");
      else res.writeHead(200).end("<!doctype html>");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    closing.push(server);
    const addr = server.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    let mints = 0;
    backend.machines[0]!.previewUrl = async () => {
      mints++;
      return { url: `http://127.0.0.1:${guestPort}/?pt_token=t${mints}`, token: `t${mints}`, expiresAt: Date.now() + 3_600_000 };
    };

    expect((await rt.workspaces.portReach(ws.id, 3000)).url).toContain("pt_token=t1");
    expect((await rt.workspaces.portProbe(ws.id, 3000)).status).toBe(401);
    expect(mints).toBe(2);
    expect((await rt.workspaces.portReach(ws.id, 3000)).url).toContain("pt_token=t2");
    expect(mints).toBe(2);
    expect((await rt.workspaces.portProbe(ws.id, 3000)).status).toBe(200);
    expect(mints).toBe(2);
  });

  it("rejects when the route cannot be fetched at all, and rejects an unknown workspace", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const guest = await guestPort(200, "");
    await new Promise<void>(r => guest.server.close(() => r()));
    backend.machines[0]!.previewUrl = async () => ({ url: guest.url, token: "edge", expiresAt: Date.now() + 3_600_000 });

    await expect(rt.workspaces.portProbe(ws.id, 3000)).rejects.toThrow();
    await expect(rt.workspaces.portProbe("ws_nobody", 3000)).rejects.toThrow(/no such workspace/);
  });
});
