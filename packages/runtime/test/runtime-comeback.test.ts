// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execDetached, type ExecResult } from "@wsp/engine";

/** The detached launch starts its run under setsid, which macOS lacks; detached runs only start on Linux machines. */
const noSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status !== 0;
import { DAEMON_VERSION, PERMISSION_ALLOW, RUN_GONE_LINE, TURN_TOKEN_ENV, foldThreads, threadWordOf, type AdapterEvent, type Caller, type ExecStream, type SessionView, type TurnResult } from "@wsp/protocol";
import { TRANSCRIPTS_HELD, createRuntime, type HarnessAdapterFactory, type HarnessSession, type ProjectLander, type Runtime } from "../src/runtime.js";
import { TRANSCRIPT_CAP } from "../src/types/internal.js";
import { memoryStore, type Store } from "../src/store.js";
import { until } from "./until.js";
import { stubBackend, tokenGuest, type StubBackend, createOn } from "./stub-backend.js";
import { scriptGuest } from "./script-guest.js";
import { TOKEN, helloingDaemon } from "./runtime-fixture.js";

describe("a turn the host comes back to", () => {
  /** A harness whose run lives on the machine, not in this process: every event it emits is a line of the run's log,
   * and an attach replays that log from its first line before the rest of it arrives, which is what reading the
   * guest's own log from byte zero does. Forgetting a run is the machine having swept it. */
  /** `namedAtLaunch`: the harness names its session at the launch and a resume keeps it, as Claude Code does, so a
   * later turn of the thread takes over the row of the one before. */
  const machineRuns = ({ namedAtLaunch }: { namedAtLaunch?: true } = {}) => {
    const named = namedAtLaunch === true;
    interface Run {
      log: AdapterEvent[];
      sessionId: string;
      localId: string;
      live?: (event: AdapterEvent) => void;
      settle?: (result: TurnResult) => void;
      result?: TurnResult;
    }
    const runs = new Map<string, Run>();
    let minted = 0;
    /** Set, nothing on the machine answers the question the attach asks, and the run is neither there nor gone. */
    let unreachable: Error | undefined;
    const deliver = (run: Run, event: AdapterEvent): void => {
      if (event.type === "turn.done") run.result = event.result;
      run.live?.(event);
      if (event.type === "session.end") run.settle?.(run.result ?? { status: "failed" });
    };
    const emit = (handle: string, event: AdapterEvent): void => {
      const run = runs.get(handle)!;
      run.log.push(event);
      deliver(run, event);
    };
    const open = (run: Run, handle: string, onEvent: (event: AdapterEvent) => void, localId: string): HarnessSession => {
      let settle!: (result: TurnResult) => void;
      const finished = new Promise<TurnResult>(resolve => {
        settle = resolve;
      });
      run.settle = settle;
      run.live = onEvent;
      return { localId, run: handle, finished, interrupt: async () => {} };
    };
    const asked: string[] = [];
    /** The message and effort each attach was handed, in order. */
    const reopenedWith: { prompt?: string; effort?: string }[] = [];
    /** The launch environment of each turn this fixture started, in order; an attach after a restart adds none. */
    const envs: Readonly<Record<string, string>>[] = [];
    /** The message each turn this fixture started was handed, in order. */
    const prompts: string[] = [];
    const adapter: HarnessAdapterFactory = ctx => ({
      steers: false,
      // Answering nothing leaves the row on its seed, so the only thing that can stop a second question after the
      // restart is the start row the turn already wrote.
      titleFor: async turn => {
        asked.push(turn.opening);
        return null;
      },
      start: o => {
        envs.push({ ...ctx.env });
        prompts.push(o.prompt);
        // The shape a handle the guest's run directory reports has to have to be one of this host's.
        const handle = `/tmp/wsp-run/${(++minted).toString(16).padStart(12, "0")}`;
        // The CLI keys the session by its own id, not by the one the launch minted, so the row and the harness
        // session are two different ids across the restart.
        const sessionId = o.resume ?? `sess-${minted}`;
        const run: Run = { log: [], sessionId, localId: named ? sessionId : `local-${minted}` };
        runs.set(handle, run);
        const session = open(run, handle, o.onEvent, run.localId);
        queueMicrotask(() => emit(handle, { type: "session.start", sessionId: run.sessionId, model: "claude-sonnet-4-5", cwd: o.cwd ?? "/root/work" }));
        return session;
      },
      attach: async o => {
        if (unreachable !== undefined) throw unreachable;
        reopenedWith.push({ prompt: o.prompt, effort: o.effort });
        const run = runs.get(o.run);
        // A machine that answered and no longer holds the run: no reader, and nothing is ever emitted for it.
        if (run === undefined) return "gone";
        const session = open(run, o.run, o.onEvent, o.sessionId);
        const replayed = [...run.log];
        queueMicrotask(() => {
          for (const event of replayed) deliver(run, event);
        });
        return session;
      },
    });
    return {
      adapter,
      emit,
      envs,
      prompts,
      handles: () => [...runs.keys()],
      sweep: (handle: string) => runs.delete(handle),
      unreach: (e: Error) => (unreachable = e),
      asked: () => [...asked],
      reopened: () => [...reopenedWith],
    };
  };

  /** A workspace with one turn running on the machine, the host stopped under it, and what that turn's run is. */
  const hostWentDown = async (h: ReturnType<typeof machineRuns>, store: Store, backend: StubBackend): Promise<{ workspaceId: string; run: string }> => {
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "reading the ticket" });
    await rt.close();
    return { workspaceId: ws.id, run };
  };

  it("a run re-read after a restart files each call by its age against the run's newest stamp, so a call made long before stays out", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    // The machine's clock means nothing to this host: only the twenty minutes between the run's two calls do.
    const stamp = 1_000_000;
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "limit", sessionId: "sess-1", limit: { windows: [{ kind: "session", usedPercent: 10 }] } });
    h.emit(run, { type: "turn.usage", sessionId: "sess-1", tokens: 30_000, at: stamp });
    h.emit(run, { type: "turn.usage", sessionId: "sess-1", tokens: 1_500, at: stamp + 20 * 60_000 });
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    await until(async () => (await rt2.usage.accounts()).accounts.some(a => a.burn !== undefined));
    expect((await rt2.usage.accounts()).accounts.flatMap(a => (a.burn !== undefined ? [a.burn] : []))).toEqual([{ tokensPerMinute: 100, threads: 1 }]);
    await rt2.close();
  });

  it("a thread's later turn re-opened after a restart is handed its own message, not the one that opened the thread", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns({ namedAtLaunch: true });
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "build it", effort: "low" });
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
    h.emit(h.handles()[0]!, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "built" } });
    h.emit(h.handles()[0]!, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await first.finished;
    await rt.sessions.start(ws.id, { prompt: "now test it", thread: first.view().threadId!, effort: "high" });
    await until(() => h.handles().length === 2);
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => [s.status, s.prompt])).toEqual([["running", "build it"]]);
    expect(h.reopened()).toEqual([{ prompt: "now test it", effort: "high" }]);
    await rt2.close();
  });

  it("a run re-opened on a machine the restart found running off a provider read alone proves the machine takes commands: the next wake proves nothing", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId } = await hostWentDown(h, store, backend);
    // The host went down while a wake waited on this machine, which the provider runs.
    await store.put("workspaces", workspaceId, { ...((await store.get("workspaces", workspaceId)) as object), phase: "waking" });
    let proofs = 0;
    backend.machines[0]!.proveRoad = async () => void proofs++;
    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    expect(h.reopened()).toHaveLength(1);
    expect((await rt2.workspaces.wake(workspaceId)).phase).toBe("running");
    expect(proofs).toBe(0);
    await rt2.close();
  });

  it("the run outlives the host: the row keeps its run, stays running across the restart and completes with its reply", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    const stored = (await store.get("sessions", workspaceId)) as { sessions: { status: string; run?: string }[] };
    expect(stored.sessions.map(s => [s.status, s.run])).toEqual([["running", run]]);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    // A harness that hands the message over after its process starts may not have handed it yet when the host went.
    expect(h.reopened().map(r => r.prompt)).toEqual(["build it"]);
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "wrote the fix" });
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "completed");
    const history = await rt2.sessions.history(workspaceId);
    // the line the old host already wrote is read past, so the replay costs the transcript nothing
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.done", "session.end"]);
    expect(history.filter(e => e.type === "session.delta").map(e => e.text)).toEqual(["reading the ticket", "wrote the fix"]);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: 0, sawResult: true });
    // The name goes out under the one start row the turn writes, so the host that re-opened the run asks nothing:
    // its own asked-set is empty and the row is still on its seed, and the start row is what stands in for both.
    expect(h.asked()).toEqual(["build it"]);
    expect((await rt2.sessions.list(workspaceId))[0]!.harnessTitle).toBeUndefined();
    await rt2.close();
  });

  it("more running turns than the host holds transcripts, re-opened together, each read past what it already wrote", async () => {
    // Every turn is re-opened at once, and each open lets the oldest held transcript go: a turn that looked its
    // transcript up again found nothing and wrote its start and its lines a second time.
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const spaces = [];
    for (let n = 0; n < TRANSCRIPTS_HELD + 2; n++) {
      const ws = await createOn(rt, { golden: "snap_g", name: `w${n}` });
      await rt.sessions.start(ws.id, { prompt: "build it" });
      await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
      spaces.push(ws);
    }
    const runs = h.handles();
    runs.forEach((run, n) => h.emit(run, { type: "turn.delta", sessionId: `sess-${n + 1}`, kind: "text", text: `reading ticket ${n}` }));
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await rt2.workspaces.list();
    runs.forEach((run, n) => {
      h.emit(run, { type: "turn.done", sessionId: `sess-${n + 1}`, result: { status: "completed", text: "done" } });
      h.emit(run, { type: "session.end", sessionId: `sess-${n + 1}`, exitCode: 0, sawResult: true });
    });
    for (const ws of spaces) await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    for (const [n, ws] of spaces.entries()) {
      const history = await rt2.sessions.history(ws.id);
      expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
      expect(history.filter(e => e.type === "session.delta").map(e => e.text)).toEqual([`reading ticket ${n}`]);
    }
    await rt2.close();
  });

  it("a host that comes back to a turn still running on an old daemon says in its log that the update waits for the turn, and deploys once it ends", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const h = machineRuns();
    const daemon = await helloingDaemon(DAEMON_VERSION - 1);
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    try {
      const { workspaceId, run } = await hostWentDown(h, store, backend);
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      const deployed: string[] = [];
      const recipe = { setup: "true", smoke: "true", deployDaemon: async (m: { id: string }) => void deployed.push(m.id) };
      const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter }, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
      const waits = `daemon on m1 (workspace ${workspaceId}): update waits for the running turn`;
      await until(() => warned.includes(waits));
      await new Promise(r => setTimeout(r, 100));
      expect(deployed).toEqual([]);

      h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
      h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);
      expect(warned.filter(l => l.startsWith("daemon on"))).toEqual([waits]);
      await rt2.close();
    } finally {
      warn.mockRestore();
      await daemon.close();
    }
  });

  it("waits out the running turn on a store whose sessions listing answers last, since the sync starts after the rows are in", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const h = machineRuns();
    const daemon = await helloingDaemon(DAEMON_VERSION - 1);
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    try {
      const { workspaceId, run } = await hostWentDown(h, store, backend);
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      const deployed: string[] = [];
      let rowsIn = (): void => {};
      // A deploy is what releases the held listing, so a host that starts the sync before the rows are in reaches
      // this read with its deploy already done rather than with a wait nobody can time.
      const held = new Promise<void>(resolve => (rowsIn = resolve));
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async (m: { id: string }) => {
          deployed.push(m.id);
          rowsIn();
        },
      };
      const late: Store = {
        ...store,
        list: async collection => {
          if (collection === "sessions") await held;
          return store.list(collection);
        },
      };
      const rt2 = createRuntime({ backend, store: late, adapters: { claude: h.adapter }, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      const listing = rt2.sessions.list(workspaceId);
      const rows = setTimeout(rowsIn, 300);
      expect((await listing).map(s => s.status)).toEqual(["running"]);
      clearTimeout(rows);
      // Nothing was deployed while the rows were still coming in, because no sync had started.
      expect(deployed).toEqual([]);
      const waits = `daemon on m1 (workspace ${workspaceId}): update waits for the running turn`;
      await until(() => warned.includes(waits));
      expect(deployed).toEqual([]);

      h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
      h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);
      expect(warned.filter(l => l.startsWith("daemon on"))).toEqual([waits]);
      await rt2.close();
    } finally {
      warn.mockRestore();
      await daemon.close();
    }
  });

  it("hands no deploy to a machine that napped while the update waited for its turn, and leaves no note on its row", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const h = machineRuns();
    const daemon = await helloingDaemon(DAEMON_VERSION - 1);
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    try {
      const { workspaceId } = await hostWentDown(h, store, backend);
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      const deployed: string[] = [];
      const recipe = { setup: "true", smoke: "true", deployDaemon: async (m: { id: string }) => void deployed.push(m.id) };
      const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter }, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
      const waits = `daemon on m1 (workspace ${workspaceId}): update waits for the running turn`;
      await until(() => warned.includes(waits));
      // The nap moves the phase before it ends the turn the update is waiting on, so the wait comes back to a
      // machine the provider has paused.
      await rt2.workspaces.nap(workspaceId);
      await new Promise(r => setTimeout(r, 100));
      expect(deployed).toEqual([]);
      expect((await rt2.workspaces.get(workspaceId)).daemonNote).toBeUndefined();
      expect(warned.filter(l => l.startsWith("daemon on"))).toEqual([waits]);
      await rt2.close();
    } finally {
      warn.mockRestore();
      await daemon.close();
    }
  });

  it("a turn cut on the way back takes its open prompt with it, so no settled thread is left reading as waiting on a person", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    h.emit(run, { type: "permission.ask", sessionId: "sess-1", ask: { askId: "ask_1", toolName: "Write", detail: "out.txt", input: '{"file_path":"/root/out.txt"}', options: [{ id: PERMISSION_ALLOW, label: "Allow", effect: "allow" }] } });
    await until(async () => ((await store.get("sessions", workspaceId)) as { sessions: SessionView[] }).sessions[0]!.asking !== undefined);

    // The host comes back with no adapter for the harness, so the run cannot be re-opened and the turn is cut.
    const rt2 = createRuntime({ backend, store, adapters: {} });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "failed");
    const [row] = await rt2.sessions.list(workspaceId);
    expect(row!.asking).toBeUndefined();
    expect(threadWordOf(foldThreads([row!])[0]!)).toBe("Failed");
    await rt2.close();
  });

  /** What the machine answers when a connecting host asks which runs it holds, and what it was told to end. */
  const guestRuns = (backend: StubBackend, claims: readonly string[]) => {
    const reaps: string[] = [];
    backend.execImpl = (_m, cmd) => {
      if (cmd.includes("printf '%s\\n' \"$d\"")) return { exitCode: 0, stdout: `${claims.map(base => `${base}.d`).join("\n")}\n`, stderr: "" };
      if (cmd.includes("kill -TERM")) reaps.push(cmd);
      return { exitCode: 0, stdout: cmd.includes("echo WSP_CTX") ? "WSP_CTX\nWSP_CTX_END\n" : "", stderr: "" };
    };
    return { reaps };
  };

  it("a host that connects ends the runs on the machine that no thread of its own holds, and leaves the one it re-opened", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    const orphan = "/tmp/wsp-run/aabbccddeeff";
    const guest = guestRuns(backend, [run, orphan]);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);

    await until(async () => guest.reaps.length > 0);
    expect(guest.reaps).toHaveLength(1);
    expect(guest.reaps[0]).toContain(`rm -rf '${orphan}'.*`);
    expect(guest.reaps[0]).not.toContain(run);
    await rt2.close();
  });

  /** Two workspaces left by a host that went down; `slow` stands for a machine still restoring, whose answer to the
   * question of which runs it holds the test lets out by hand, naming one run nobody here keeps. */
  const slowListing = async (backend: StubBackend, store: Store, h: ReturnType<typeof machineRuns>, o: { thread?: true } = {}) => {
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const slow = await createOn(rt1, { golden: "snap_g", name: "slow" });
    const other = await createOn(rt1, { golden: "snap_g", name: "other" });
    const thread = o.thread === true ? await threadOn(rt1, slow.id, h) : undefined;
    await rt1.close();
    const orphan = "/tmp/wsp-run/aabbccddeeff";
    let answer!: () => void;
    const answered = new Promise<void>(resolve => (answer = resolve));
    backend.execImpl = async (m, cmd) => {
      if (m.id === slow.machineId && cmd.includes("printf '%s\\n' \"$d\"")) {
        await answered;
        return { exitCode: 0, stdout: `${orphan}.d\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: cmd.includes("echo WSP_CTX") ? "WSP_CTX\nWSP_CTX_END\n" : cmd.includes("mkdir") ? "WSP_LAUNCHED\n" : cmd.includes("echo yes || echo no") ? "yes\n" : "", stderr: "" };
    };
    const log = (): readonly string[] => backend.machines.find(m => m.id === slow.machineId)!.execLog;
    const reapAt = (): number => log().findIndex(cmd => cmd.includes("kill -TERM") && cmd.includes(orphan));
    return { slow, other, answer, log, reapAt, thread };
  };

  it("a machine that has not answered which runs it holds holds its own verbs, and no verb on another workspace waits on it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { slow, other, answer, reapAt } = await slowListing(backend, store, h);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    let slowAnswered = false;
    void rt2.workspaces.get(slow.id).then(() => (slowAnswered = true));
    expect((await rt2.workspaces.get(other.id)).name).toBe("other");
    expect(await rt2.sessions.list(other.id)).toEqual([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(slowAnswered).toBe(false);

    answer();
    await until(async () => slowAnswered);
    expect(reapAt()).toBeGreaterThan(-1);
    await rt2.close();
  });

  it("a machine whose running turn has not answered the re-open holds no verb on another workspace", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId } = await hostWentDown(h, store, backend);
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const other = await createOn(rt1, { golden: "snap_g", name: "other" });
    await rt1.close();
    let answer!: () => void;
    const answered = new Promise<void>(resolve => (answer = resolve));
    const held: HarnessAdapterFactory = ctx => {
      const inner = h.adapter(ctx);
      return { ...inner, attach: async o => (await answered, inner.attach!(o)) };
    };

    const before = h.reopened().length;
    const rt2 = createRuntime({ backend, store, adapters: { claude: held } });
    expect((await rt2.workspaces.get(other.id)).name).toBe("other");
    expect(await rt2.sessions.list(other.id)).toEqual([]);
    expect(h.reopened()).toHaveLength(before);

    answer();
    await until(async () => h.reopened().length === before + 1);
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    await rt2.close();
  });

  it("a listing of every thread does not wait to title a row on a machine whose turns the host is still re-opening", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId } = await hostWentDown(h, store, backend);
    let answer!: () => void;
    const answered = new Promise<void>(resolve => (answer = resolve));
    // A machine still restoring answers neither the re-open nor a read of the agent's own store until it is back.
    const held: HarnessAdapterFactory = ctx => {
      const inner = h.adapter(ctx);
      return {
        ...inner,
        attach: async o => (await answered, inner.attach!(o)),
        sessionTitle: async (_id, exec) => (await answered, await exec("true"), null),
      };
    };

    const rt2 = createRuntime({ backend, store, adapters: { claude: held } });
    expect((await rt2.sessions.list()).map(s => [s.workspaceId, s.status])).toEqual([[workspaceId, "running"]]);
    answer();
    await rt2.close();
  });

  /** A finished thread on a workspace, and that thread as a caller. */
  const threadOn = async (rt: ReturnType<typeof createRuntime>, workspaceId: string, h: ReturnType<typeof machineRuns>) => {
    const started = await rt.sessions.start(workspaceId, { prompt: "build it" });
    const threadId = started.view().threadId!;
    const run = h.handles().at(-1)!;
    await until(async () => (await rt.sessions.history(workspaceId)).some(e => e.type === "session.start"));
    h.emit(run, { type: "turn.done", sessionId: `sess-${h.handles().length}`, result: { status: "completed", text: "done" } });
    h.emit(run, { type: "session.end", sessionId: `sess-${h.handles().length}`, exitCode: 0, sawResult: true });
    await started.finished;
    const caller: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId, rootThreadId: threadId } };
    return { threadId, caller };
  };

  it("a thread's send into a thread on a machine whose runs are being swept starts nothing there until the sweep is done", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { slow, answer, thread } = await slowListing(backend, store, h, { thread: true });
    const { threadId, caller } = thread!;
    const before = h.envs.length;

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const sent = rt2.sessions.start(slow.id, { prompt: "and the tests", thread: threadId }, caller);
    await rt2.workspaces.list();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.envs).toHaveLength(before);

    answer();
    await sent;
    expect(h.envs).toHaveLength(before + 1);
    await rt2.close();
  });

  it("a press on a box slate whose machine's runs are being swept runs nothing there until the sweep is done", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { slow, answer, log, reapAt, thread } = await slowListing(backend, store, h, { thread: true });
    const { threadId, caller } = thread!;
    const runs = backend.machines.find(m => m.id === slow.machineId)!.runLog;
    const before = runs.length;

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await rt2.slates.write({ text: `<slate title="Held"><value name="go" start={0} />
  <run name="box" cmd="echo ran" timeout={20} />
  <when change={$go} do={start($box)} />
  <column><output run={$box} /></column>
</slate>` }, caller);
    await rt2.slates.state({ threadId, values: { $go: 1 } }, caller);
    for (const ask of (await rt2.slates.get(threadId))!.asks) await rt2.slates.approve({ threadId, key: ask.key, scope: "thread" });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(runs.slice(before)).toEqual([]);

    answer();
    await until(() => runs.length > before, 3000);
    expect(log().lastIndexOf(runs[before]!)).toBeGreaterThan(reapAt());
    await rt2.close();
  });

  it("an export on a machine whose runs are being swept starts no run there until the sweep is done", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { slow, answer, log, reapAt } = await slowListing(backend, store, h);
    const lander: ProjectLander = {
      caches: { dirs: [], files: [], markers: [] },
      probe: async () => undefined,
      land: async () => ({ files: 0, bytes: 0, agents: [] }),
    };

    const runs = backend.machines.find(m => m.id === slow.machineId)!.runLog;
    const before = runs.length;
    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const exported = rt2.projects.export({ workspaceId: slow.id, source: "/root/work/proj", dest: "/Users/dev/code/proj", lander }).catch(() => undefined);
    await rt2.workspaces.list();
    await new Promise(resolve => setImmediate(resolve));
    expect(runs.slice(before)).toEqual([]);

    answer();
    await exported;
    expect(runs.length).toBeGreaterThan(before);
    expect(log().lastIndexOf(runs[before]!)).toBeGreaterThan(reapAt());
    await rt2.close();
  });

  it.skipIf(noSetsid)("a command run detached on a machine whose runs are being swept finishes, and the sweep does not end it", async () => {
    // Real bash in a private folder: the sweep lists and reaps that folder alone, never the machine's own run folder.
    const dir = mkdtempSync(join(tmpdir(), "wsp-sweep-"));
    const runDir = join(dir, "wsp-run");
    mkdirSync(runDir);
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const slow = await createOn(rt1, { golden: "snap_g", name: "slow" });
    await rt1.close();
    const machine = backend.machines.find(m => m.id === slow.machineId)!;
    const stubbed = machine.exec.bind(machine);
    let answer!: () => void;
    const answered = new Promise<void>(resolve => (answer = resolve));
    const bash = (cmd: string): Promise<ExecResult> =>
      new Promise(resolve => execFile("bash", ["-c", cmd], { cwd: dir }, (e, stdout, stderr) => resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout, stderr })));
    machine.exec = async (cmd, o) => {
      // As a box runs an exec given longer than its inline span.
      if (cmd.includes("echo finished")) return execDetached(machine, cmd, { deadlineMs: o?.timeoutMs ?? 60_000, pollMs: 50 }, runDir);
      if (!cmd.includes(runDir)) return stubbed(cmd, o);
      if (cmd.includes("printf '%s\\n' \"$d\"")) await answered;
      return bash(cmd);
    };

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter }, machineExec: { runDir } });
    try {
      const ran = rt2.workspaces.exec(slow.id, "sleep 1; echo finished", { timeoutMs: 600_000 });
      // The listing goes out once the command is up where nothing holds it back, and after a wait where something does.
      await until(() => readdirSync(runDir).some(name => name.endsWith(".d")), 1000).catch(() => undefined);
      answer();
      expect(await ran).toMatchObject({ exitCode: 0, stdout: "finished\n" });
    } finally {
      await rt2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A machine whose daemon port answers 502, so the reach poll puts the daemon back, and whose run listing the test
   * lets out by hand. `runDir` makes the machine's runs real: `run` goes through execDetached into that folder on
   * this computer's bash, and the listing and the reap run there too. */
  const daemonDown = async (o: { runDir?: string } = {}) => {
    const server = createServer((_req, res) => res.writeHead(502).end());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const deploys: { listingAnswered: boolean; result?: ExecResult }[] = [];
    let listingAnswered = false;
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { run: (script: string, o: { deadlineMs: number }) => Promise<ExecResult> }) => {
        const deploy: (typeof deploys)[number] = { listingAnswered };
        deploys.push(deploy);
        deploy.result = await machine.run("sleep 1; echo deployed", { deadlineMs: 180_000 });
      },
    };
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe });
    const slow = await createOn(rt1, { golden: "snap_g", name: "slow" });
    await rt1.close();
    deploys.length = 0;
    let answer!: () => void;
    const answered = new Promise<void>(resolve => (answer = resolve));
    const listing = (cmd: string): boolean => cmd.includes("printf '%s\\n' \"$d\"");
    const machine = backend.machines.find(m => m.id === slow.machineId)!;
    machine.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    if (o.runDir === undefined) {
      backend.execImpl = async (m, cmd) => {
        if (m.id === slow.machineId && listing(cmd)) {
          await answered;
          listingAnswered = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return tokenGuest(m, cmd);
      };
    } else {
      const runDir = o.runDir;
      const stubbed = machine.exec.bind(machine);
      const bash = (cmd: string): Promise<ExecResult> =>
        new Promise(resolve => execFile("bash", ["-c", cmd], (e, stdout, stderr) => resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout, stderr })));
      machine.run = (script, ro) => execDetached(machine, script, { deadlineMs: ro.deadlineMs, pollMs: 50 }, runDir);
      machine.exec = async (cmd, eo) => {
        if (!cmd.includes(runDir)) return stubbed(cmd, eo);
        if (listing(cmd)) {
          await answered;
          listingAnswered = true;
        }
        return bash(cmd);
      };
    }
    const rt2 = createRuntime({
      backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe,
      status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 },
      ...(o.runDir !== undefined ? { machineExec: { runDir: o.runDir } } : {}),
    });
    const stop = rt2.status.watch();
    const end = async (): Promise<void> => {
      stop();
      await rt2.close();
      server.close();
    };
    return { deploys, answer, end };
  };

  it("the reach poll puts no daemon back on a machine whose run listing is still out", async () => {
    const { deploys, answer, end } = await daemonDown();
    try {
      // Long enough for the poll at 5 ms to see the port answer nothing twice and deploy, where nothing holds it back.
      await until(() => deploys.length > 0, 1000).catch(() => undefined);
      expect(deploys).toEqual([]);
      answer();
      await until(() => deploys.length > 0, 3000);
      expect(deploys[0]!.listingAnswered).toBe(true);
    } finally {
      await end();
    }
  }, 20_000);

  it.skipIf(noSetsid)("a daemon the reach poll puts back on a machine whose runs are being swept is deployed, not ended by the sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-sweep-"));
    const runDir = join(dir, "wsp-run");
    mkdirSync(runDir);
    const { deploys, answer, end } = await daemonDown({ runDir });
    try {
      // The listing goes out once the deploy's claim is up where nothing holds it back, and after a wait where something does.
      await until(() => readdirSync(runDir).some(name => name.endsWith(".d")), 1000).catch(() => undefined);
      answer();
      await until(() => deploys[0]?.result !== undefined, 5000);
      expect(deploys[0]!.result).toMatchObject({ exitCode: 0, stdout: "deployed\n" });
    } finally {
      await end();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("a run whose row this host could not re-open is ended on the machine, not left holding it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    const guest = guestRuns(backend, [run]);

    // No adapter for the row's harness: the turn reads as one the restart cut, and nothing here reads its run again.
    const rt2 = createRuntime({ backend, store, adapters: {} });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "failed");

    expect(guest.reaps).toHaveLength(1);
    expect(guest.reaps[0]).toContain(`rm -rf '${run}'.*`);
    await rt2.close();
  });

  it("a run the machine no longer holds ends the turn on those words, and a second restart does not end it again", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    h.sweep(run);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "failed");
    const history = await rt2.sessions.history(workspaceId);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: null, sawResult: false, reason: RUN_GONE_LINE });
    await rt2.close();

    const rt3 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt3.sessions.history(workspaceId)).filter(e => e.type === "session.end")).toHaveLength(1);
    await rt3.close();
  });

  it("a machine that answers nothing about the run leaves the turn running, kills nothing, and the poll that finds the machine gone is what settles it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    h.unreach(new Error("gateway said 502"));

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    // Nothing was told about the turn either way: no end row, and the run is still there to be read next time.
    expect((await rt2.sessions.history(workspaceId)).some(e => e.type === "session.end")).toBe(false);
    expect(h.handles()).toContain(run);
    // The machine really is away, and the road that watches machines can still settle a row this host never opened.
    const [ws] = await rt2.workspaces.list();
    await rt2.workspaces.delete(ws!.id);
    await until(async () => (await rt2.sessions.list(workspaceId)).every(s => s.status !== "running"));
    await rt2.close();
  });

  it("a turn whose reply is already written settles completed when the run is gone at boot, and tells its parent nothing more", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it", notify: ["me"] });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    await rt1.close();
    h.sweep(run);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const rows = await rt2.sessions.list(ws.id);
    expect(rows.map(s => s.status)).toEqual(["completed"]);
    const history = await rt2.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    expect(history.at(-1)).toMatchObject({ type: "session.end", sawResult: true, reason: RUN_GONE_LINE });
    await rt2.close();
  });

  it("a turn longer than the transcript cap replays without writing a line twice: the count comes off the last row's stamp, not off how many rows survive", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    const printed = 5200;
    for (let i = 0; i < printed; i++) h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: `line ${i}` });
    // A non-delta row is what flushes the transcript, so the capped store is what the next host reads.
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    const before = (await rt1.sessions.history(ws.id)).filter(e => e.type === "session.delta");
    expect(before.length).toBeLessThan(printed);
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await rt2.sessions.list(ws.id);
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    const deltas = (await rt2.sessions.history(ws.id)).filter(e => e.type === "session.delta");
    expect(new Set(deltas.map(e => e.text)).size).toBe(deltas.length);
    expect(deltas.at(-1)).toMatchObject({ text: `line ${printed - 1}`, line: printed });
    await rt2.close();
  });

  it("a turn the host restart did not end keeps its token: the coordinator thread still names itself with me after the restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    const turn = await rt1.sessions.start(ws.id, { prompt: "coordinate the builders" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const threadId = turn.view().threadId!;
    const token = h.envs[0]![TURN_TOKEN_ENV]!;
    // The row the next host reads carries it beside the run, since the process it is in outlives this host.
    const stored = (await store.get("sessions", ws.id)) as { sessions: { status: string; turnToken?: string }[] };
    expect(stored.sessions.map(s => [s.status, s.turnToken])).toEqual([["running", token]]);
    await rt1.close();

    // The host came back and re-opened the run, so that turn is still working with the same variable in its process.
    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    const kid = await rt2.sessions.start(ws.id, { prompt: "build it", notify: ["me"], turnToken: token, startedBy: "agent" });
    expect(kid.view().threadId).not.toBe(threadId);
    const kidRun = h.handles()[1]!;
    h.emit(kidRun, { type: "turn.done", sessionId: "sess-2", result: { status: "completed", text: "done" } });
    h.emit(kidRun, { type: "session.end", sessionId: "sess-2", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    expect((await rt2.sessions.history(ws.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kid.view().threadId, notify: threadId });
    await rt2.close();
  });

  it("a turn the host restart did not end keeps the device its launch carried, and hands it back at its own exit", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a", agents: { spawn: true, maxMachines: 3, maxDepth: 1 } });
    await rt1.sessions.start(ws.id, { prompt: "coordinate the builders" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const device = (await rt1.devices.list())[0]!;
    // The row the next host reads carries the device beside the run, for the same reason it carries the token: the
    // process out there still holds both, and only the row knows which device to take away when that turn ends.
    const stored = (await store.get("sessions", ws.id)) as { sessions: { status: string; scopeDeviceId?: string }[] };
    expect(stored.sessions.map(s => [s.status, s.scopeDeviceId])).toEqual([["running", device.id]]);
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    // The load's sweep spares a device whose thread is running, so the re-opened turn is what hands it back.
    expect((await rt2.devices.list()).map(d => d.id)).toEqual([device.id]);
    const run = h.handles()[0]!;
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.devices.list()).length === 0);
    expect(await rt2.devices.list()).toEqual([]);
    await rt2.close();
  });

  it("a host with no adapter for the harness cannot re-open the run, so the turn reads as one the restart cut", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId } = await hostWentDown(h, store, backend);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["failed"]);
    expect((await rt2.sessions.history(workspaceId)).at(-1)).toMatchObject({ type: "session.end", reason: "host restarted while the agent was working" });
    await rt2.close();
  });

  it("a turn whose reply landed before the restart has its line recorded once, not again on the replay", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it", notify: ["me"] });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    // the reply landed and the harness process had not exited when the host went down
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    expect((await rt1.sessions.list(ws.id))[0]).toMatchObject({ status: "running" });
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    expect((await rt2.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    await rt2.close();
  });

  it("a reply held over background work has its line sent once, not again on the replay, and the held end sends none", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it", notify: ["me"] });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    const reply: TurnResult = { status: "completed", text: "Pushed; the tests run in the background." };
    h.emit(run, { type: "turn.tasks", sessionId: "sess-1", running: 1, replied: reply });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: reply, held: true });
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    expect((await rt2.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    await rt2.close();
  });

  /** A turn told to `notify`, its agent's reply held over a background task and its line sent: the runtime and the run. */
  const heldLineSent = async (h: ReturnType<typeof machineRuns>, store: Store, backend: StubBackend, notify: string[] = ["me"]) => {
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "build it", notify });
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles().at(-1)!;
    h.emit(run, { type: "turn.tasks", sessionId: "sess-1", running: 1, replied: { status: "completed", text: "Pushed; CI runs in the background." } });
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    return { rt, ws, run };
  };
  const notifies = async (rt: Runtime, workspaceId: string) => (await rt.sessions.history(workspaceId)).flatMap(e => (e.type === "session.notify" ? [e.text] : []));

  it("a held reply's line and the woken agent's line into a napping lead both outlive a host restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const lead = await createOn(rt1, { golden: "snap_g", name: "lead" });
    const kidWs = await createOn(rt1, { golden: "snap_g", name: "kid" });
    const leadTurn = await rt1.sessions.start(lead.id, { prompt: "orchestrate" });
    await until(async () => (await rt1.sessions.history(lead.id)).some(e => e.type === "session.start"));
    const leadRun = h.handles()[0]!;
    h.emit(leadRun, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "waiting" } });
    h.emit(leadRun, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await leadTurn.finished;
    await rt1.workspaces.nap(lead.id);
    await rt1.sessions.start(kidWs.id, { prompt: "build it", notify: [leadTurn.view().threadId!] });
    await until(async () => (await rt1.sessions.history(kidWs.id)).some(e => e.type === "session.start"));
    const kidRun = h.handles()[1]!;
    h.emit(kidRun, { type: "turn.tasks", sessionId: "sess-2", running: 1, replied: { status: "completed", text: "first reply: pushed, CI in the background" } });
    h.emit(kidRun, { type: "session.start", sessionId: "sess-2" });
    h.emit(kidRun, { type: "turn.done", sessionId: "sess-2", result: { status: "completed", text: "second reply: CI passed" } });
    h.emit(kidRun, { type: "session.end", sessionId: "sess-2", exitCode: 0, sawResult: true });
    await until(async () => (await rt1.sessions.list(kidWs.id))[0]!.status === "completed");
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await rt2.sessions.list(lead.id);
    await rt2.workspaces.wake(lead.id);
    await until(() => h.prompts.length === 3);
    h.emit(h.handles()[2]!, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "read it" } });
    h.emit(h.handles()[2]!, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(() => h.prompts.length === 4).catch(() => {});
    expect(h.prompts.slice(2).map(p => p.replace(/^thread \w+ finished \(completed\): /, "")).sort()).toEqual(["first reply: pushed, CI in the background", "second reply: CI passed"]);
    await rt2.close();
  });

  it("a woken agent's own end goes out after a held reply's line, and the woken reply only once on a replay", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { rt: rt1, ws, run } = await heldLineSent(h, store, backend);
    h.emit(run, { type: "session.start", sessionId: "sess-1" });
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "CI passed." } });
    await until(async () => (await notifies(rt1, ws.id)).length === 2);
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    expect((await notifies(rt2, ws.id)).map(t => t.replace(/^thread \w+ finished \(completed\): /, ""))).toEqual(["Pushed; CI runs in the background.", "CI passed."]);
    await rt2.close();
  });

  it("a stop after a restart, the agent woken under the held reply and not replied, tells the stop alone: the replay names the words already told", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { rt: rt1, ws, run } = await heldLineSent(h, store, backend);
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "session.start", sessionId: "sess-1" });
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "interrupted", text: "Pushed; CI runs in the background." } });
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: null, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "interrupted");
    expect((await notifies(rt2, ws.id)).map(t => t.replace(/^thread \w+ /, ""))).toEqual(["finished (completed): Pushed; CI runs in the background.", "finished (interrupted)"]);
    await rt2.close();
  });

  it("a held reply's line is not sent again by a restarted host whose transcript the cap trimmed past that line", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { rt: rt1, ws, run } = await heldLineSent(h, store, backend);
    for (let i = 0; i < TRANSCRIPT_CAP + 100; i++) h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: `working ${i}` });
    await until(async () => (await notifies(rt1, ws.id)).length === 0);
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const told: string[] = [];
    rt2.events.on("session.notify", e => told.push((e as { text: string }).text));
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "Pushed; CI runs in the background." }, held: true });
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    expect(told).toEqual([]);
    await rt2.close();
  });

  it("a host cut after a held reply's line sends no second line: a nap, and a restart that finds the run gone", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const napped = await heldLineSent(h, store, backend);
    await napped.rt.workspaces.nap(napped.ws.id);
    await until(async () => (await napped.rt.sessions.list(napped.ws.id))[0]!.status !== "running");
    expect(await notifies(napped.rt, napped.ws.id)).toHaveLength(1);
    await napped.rt.close();

    const store2 = memoryStore();
    const gone = await heldLineSent(h, store2, backend);
    await gone.rt.close();
    h.sweep(gone.run);
    const rt2 = createRuntime({ backend, store: store2, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(gone.ws.id)).map(s => s.status)).not.toContain("running");
    expect((await rt2.sessions.history(gone.ws.id)).map(e => e.type)).toEqual(["session.start", "session.notify", "session.end"]);
    await rt2.close();
  });

  it("a host cut after the agent was woken under a held reply sends the cut's line", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { rt, ws, run } = await heldLineSent(h, store, backend);
    h.emit(run, { type: "session.start", sessionId: "sess-1" });
    await rt.workspaces.nap(ws.id);
    await until(async () => (await notifies(rt, ws.id)).length === 2);
    expect((await notifies(rt, ws.id))[1]).toContain("finished (failed)");
    await rt.close();
  });
});

describe("a host that comes back to a turn still running on a machine", () => {
  /** An adapter whose turn is the machine's own run, launched and re-opened through the wiring's exec stream:
   * the poll that reads that run is the timer this case is about. */
  const pollingAdapter = (): HarnessAdapterFactory => ctx => {
    const session = (stream: ExecStream, sessionId: string, onEvent: (event: AdapterEvent) => void): HarnessSession => {
      const finished = (async () => {
        onEvent({ type: "session.start", sessionId });
        for await (const line of stream.lines) void line;
        const result: TurnResult = { status: "completed", text: "done" };
        onEvent({ type: "turn.done", sessionId, result });
        return result;
      })();
      return { localId: sessionId, finished, ...(stream.run !== undefined ? { run: stream.run } : {}), interrupt: async () => {} };
    };
    return {
      steers: false,
      start: o => session(ctx.execStream("claude -p hi", { env: {} }), "66666666-6666-4666-8666-666666666666", o.onEvent),
      attach: async o => {
        const opened = await ctx.execStream.attach!(o.run, { input: false, startedAt: o.startedAt });
        return opened === "gone" ? "gone" : session(opened, o.sessionId, o.onEvent);
      },
    };
  };

  it("lets go of the poll that reads it when it closes, so nothing it opened holds this process open", async () => {
    // Counted, not named: the runner holds timers of its own, and what this case is about is the one this runtime
    // adds; one the first host left may run out meanwhile. The list goes into the failure so a run that drifts says
    // what it was holding.
    const held = (): string[] => process.getActiveResourcesInfo().filter(kind => kind === "Timeout");
    const backend = stubBackend();
    const store = memoryStore();
    scriptGuest(backend, [], tokenGuest);
    const first = createRuntime({ backend, store, adapters: { claude: pollingAdapter() } });
    const ws = await createOn(first, { golden: "snap_g", name: "a" });
    await first.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => ((await store.get("sessions", ws.id)) as { sessions: { run?: string }[] } | undefined)?.sessions[0]?.run !== undefined);
    await first.close();

    const before = held().length;
    const log = backend.machines[0]!.execLog;
    const polled = log.length;
    const again = createRuntime({ backend, store, adapters: { claude: pollingAdapter() } });
    expect((await again.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    // The re-opened run is being read: its poll has reached the machine.
    await vi.waitFor(() => expect(log.slice(polled).some(cmd => cmd.includes("__WSP_EOF_"))).toBe(true));
    await again.close();
    expect(held().length, `left open: ${process.getActiveResourcesInfo().join(", ")}`).toBeLessThanOrEqual(before);
  }, 20_000);
});
