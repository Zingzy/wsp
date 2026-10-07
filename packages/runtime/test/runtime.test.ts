import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { gunzipSync } from "node:zlib";
import { catalogProbeCommand, createClaudeAdapter, parseCatalogProbe } from "@wsp/adapter-claude";
import { diskFullLine, execFailedLine, imageServedWaitLine, machineUnreachableLine, projectNeedsReaddLine, STATE_SHAPE, type StateShape } from "@wsp/protocol";
import { HOST_TOKEN_ENV, DAEMON_RESTART_FAILED, DAEMON_RESTARTING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, NO_SUCH_TURN, NOTIFY_ME, PERMISSION_ALLOW, RUN_GONE_LINE, SessionEvent, TURN_TOKEN_ENV, foldThreads, notifyLine, stillWorkingLine, threadMessages, threadReplyRows, threadResult, threadWordOf, type AdapterEvent, type ExecStream, type EventUnion, type PermissionAsk, type RecipeDigest, type SessionView, type TurnResult, type WorkspaceStatus } from "@wsp/protocol";
import { BUILDER_IDLE_MS, DISK_SYNC_CMD, DISK_USE_CMD, ExecFailedError, GuestUnusableError, KILL_ASKS, MachineUnreachableError, TOOLS_PATH, type ExecResult, type GoldenDelta, type GoldenImport } from "@wsp/engine";
import { AGENTS_BIN, DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { DAEMON_TOKEN_NONE, DAEMON_TOKEN_SET, daemonTokenFor, rotateDaemonTokenScript } from "../src/daemon-token.js";
import { writeDaemonRootsScript } from "../src/daemon-roots.js";
import { harnessCatalog } from "../src/harness-catalog.js";
import { copyKey, CATALOG_TTL_MS, DAEMON_REVIVE_AGAIN_MS, GRACE_MS, GUEST_LOGIN_ENV, PORT_PROBE_BODY_CAP, TOOL_RESULT_KEPT, TRANSCRIPT_BYTES, TRANSCRIPT_FLUSH_MS, TRANSCRIPTS_HELD, createRuntime, wiredPlace, type GoldenExec, type HarnessAdapterContext, type HarnessAdapterFactory, type HarnessSession, type HarnessStartOptions } from "../src/runtime.js";
import { POLL_INTERVAL_MS } from "../src/status.js";
import { machineExecStream } from "../src/machine-exec.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { tarRead } from "../../engine/test/tar-read.js";
import { droppingPort } from "./held-port.js";
import { until } from "./until.js";
import { wsRequest } from "./ws-client.js";
import { answersGoneOnce, missesFirstDelete, ownedStore, stubBackend, tokenGuest, type StubBackend, type StubMachine, createOn, projectOn } from "./stub-backend.js";
import { scriptGuest } from "./script-guest.js";
import { fakeClock } from "./fake-clock.js";
import { WebSocketServer } from "ws";
import { CLAUDE_PIN, setupRan, TOKEN_PATH, TOKEN, helloingDaemon, helloOf, withDaemon, held, settle } from "./runtime-fixture.js";

/** A stub whose guest answers the memory line as told, and whose daemon notes the exec count when first asked. */
function guestCounting(answer: () => { exitCode: number; stdout: string; stderr: string }): { backend: StubBackend; askedAt: Map<string, number> } {
  const backend = stubBackend();
  const guest = backend.execImpl;
  backend.execImpl = (m, cmd) => (cmd.includes("/proc/meminfo") ? answer() : guest(m, cmd));
  const askedAt = new Map<string, number>();
  const create = backend.create.bind(backend);
  backend.create = async spec => {
    const m = (await create(spec)) as StubMachine;
    m.daemonAnswers = async () => {
      if (!askedAt.has(m.id)) askedAt.set(m.id, m.execLog.length);
      return true;
    };
    return m;
  };
  return { backend, askedAt };
}
const counted = (kb: number) => () => ({ exitCode: 0, stdout: `memkb ${kb}\n`, stderr: "" });
const memoryReads = (m: StubMachine): number[] => m.execLog.flatMap((c, i) => (c.includes("MemTotal") ? [i] : []));

describe("runtime", () => {
  it("creates a workspace from a golden manifest and emits protocol events", async () => {
    const events: string[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    rt.events.on("*", e => events.push(e.type));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    expect(ws.id).toBeTruthy();
    expect(events).toContain("workspace.created");
    await rt.workspaces.nap(ws.id);
    expect(events).toContain("workspace.napped");
  });

  it("a create whose fork the provider refused is reached by its name and cleared with delete, which every client hears", async () => {
    const backend = stubBackend();
    backend.create = async () => {
      throw Object.assign(new Error("Snapshot not found"), { kind: "missing", status: 404 });
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const said: { type: string; workspaceId?: string; stage?: string }[] = [];
    rt.events.on("*", e => said.push(e as (typeof said)[number]));
    const failing = async (): Promise<string> => {
      await expect(createOn(rt, { golden: "snap_g", name: "fleet check" })).rejects.toThrow("Snapshot not found");
      return said.filter(e => e.type === "workspace.creating" && e.stage === "failed").at(-1)!.workspaceId!;
    };
    const first = await failing();
    expect(rt.workspaces.creating()).toEqual([expect.objectContaining({ workspaceId: first, name: "fleet check", stage: "failed", message: "Snapshot not found" })]);
    // Asked again under the name, the older failure goes, from the runtime and from every client's rows.
    const id = await failing();
    expect(said).toContainEqual(expect.objectContaining({ type: "workspace.deleted", workspaceId: first }));
    expect(rt.workspaces.creating().map(e => e.workspaceId)).toEqual([id]);
    // A workspace the host does not hold is the caller's word gone wrong, so its refusal reads as usage.
    await expect(rt.workspaces.delete(first)).rejects.toMatchObject({ message: `no such workspace: ${first}`, kind: "not-found" });
    expect(await rt.workspaces.resolve("fleet check")).toMatchObject({ id, name: "fleet check", machineId: "", phase: "gone", gone: "Snapshot not found" });
    await rt.workspaces.delete(id);
    expect(said.at(-1)).toMatchObject({ type: "workspace.deleted", workspaceId: id });
    expect(rt.workspaces.creating()).toEqual([]);
    await expect(rt.workspaces.resolve("fleet check")).rejects.toThrow(/no workspace/);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a create that asks for an offered size forks the machine at it and the record and the rate follow; one off the list is refused with the list before any machine is forked", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    const [status] = await rt.status.list();
    expect(status).toMatchObject({ id: ws.id, size: { cpu: 2, memMb: 8192 } });
    expect(status!.rateUsdPerHour).toBeCloseTo(0.15, 10);

    await expect(createOn(rt, { golden: "snap_g", name: "odd", cpu: 8, memMb: 16384 })).rejects.toMatchObject({
      kind: "invalid",
      message: "8x16 is not a size this provider offers; the sizes are 2x2 ($0.09/hr), 2x4 ($0.11/hr), 2x8 ($0.15/hr), 4x8 ($0.22/hr). Ask for one of those instead.",
    });
    expect(backend.machines).toHaveLength(1);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["big"]);

    // No size asked: the golden's own, whether or not the provider offers it today.
    const plain = await createOn(rt, { golden: "snap_g", name: "plain" });
    expect((await rt.status.list()).find(s => s.id === plain.id)!.size).toEqual({ cpu: 2, memMb: 4096 });
  });

  it("a fork's row and rate carry the memory its guest counts, read once after the daemon answers, while the shape stays the provider's view and a wake reads no fault", async () => {
    const { backend, askedAt } = guestCounting(counted(4_128_768));
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      const got = { cpu: 2, memMb: 4096 };
      const line = "asked for 2\u00a0vCPU,\u00a08\u00a0GB; the machine has 2\u00a0vCPU,\u00a04\u00a0GB";
      expect(ws.notice).toBe(line);
      expect(await store.get("workspaces", ws.id)).toMatchObject({ size: got, shape: { cpu: 2, memMb: 8192 } });
      const [status] = await rt.status.list();
      expect(status).toMatchObject({ size: got, rateUsdPerHour: backend.pricing.rateUsdPerHour(got) });
      const m = backend.machines[0]!;
      expect(memoryReads(m)).toHaveLength(1);
      expect(memoryReads(m)[0]).toBeGreaterThanOrEqual(askedAt.get(m.id)!);
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual([`workspace ${ws.id}: ${line}`]);

      // The provider's view still says 8192 on the wake, and that is what the record's shape is held against.
      await rt.workspaces.nap(ws.id);
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.phase).toBe("running");
      expect([backend.machines.length, m.resumes]).toEqual([1, 1]);
      expect(warn.mock.calls.filter(c => String(c[0]).includes("wake check"))).toEqual([]);
      expect(memoryReads(m)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    [8_060_000, 8192, undefined],
    [6_144_000, 6000, "asked for 2\u00a0vCPU,\u00a08\u00a0GB; the machine has 2\u00a0vCPU,\u00a05.9\u00a0GB"],
    [8_388_608, 8192, undefined],
  ])("a guest counting %i kB of an asked 8 GB is recorded at %i MB: an offered size within a sixteenth of the count, else the count itself", async (kb, memMb, notice) => {
    const { backend } = guestCounting(counted(kb));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      expect(memoryReads(backend.machines[0]!)).toHaveLength(1);
      expect((await rt.status.list())[0]!.size).toEqual({ cpu: 2, memMb });
      expect(ws.notice).toBe(notice);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["exits non-zero", () => ({ exitCode: 1, stdout: "", stderr: "awk: not found" })],
    ["is not answered", () => {
      throw Object.assign(new Error("exec answered 502"), { status: 502 });
    }],
  ])("a guest whose memory read %s keeps the size the fork wrote, says nothing on the create, warns one line and wakes with no fault", async (_how, answer) => {
    const { backend } = guestCounting(answer);
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      expect(ws).not.toHaveProperty("notice");
      expect(await store.get("workspaces", ws.id)).toMatchObject({ size: { cpu: 2, memMb: 8192 }, shape: { cpu: 2, memMb: 8192 } });
      const said = warn.mock.calls.map(c => String(c[0]));
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(new RegExp(`^workspace ${ws.id}: memory not read on m1 \\(.+\\); the row keeps 2x8$`));
      await rt.workspaces.nap(ws.id);
      expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
      expect([backend.machines.length, backend.machines[0]!.resumes]).toEqual([1, 1]);
      expect(warn.mock.calls.filter(c => String(c[0]).includes("wake check"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["a rebuild", async (rt: ReturnType<typeof createRuntime>, _backend: StubBackend, id: string) => {
      await rt.workspaces.rebuild(id);
    }],
    ["an upgrade", async (rt: ReturnType<typeof createRuntime>, _backend: StubBackend, id: string) => {
      await rt.workspaces.upgrade(id);
    }],
  ])("%s asks the provider for the size its view holds and writes the guest's count on the row again", async (_road, replace) => {
    const { backend } = guestCounting(counted(4_128_768));
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      await replace(rt, backend, ws.id);
      const fresh = backend.machines[1]!;
      expect(fresh.spec).toMatchObject({ cpu: 2, memMb: 8192 });
      expect(memoryReads(fresh)).toHaveLength(1);
      expect(await store.get("workspaces", ws.id)).toMatchObject({ machineId: fresh.id, size: { cpu: 2, memMb: 4096 }, shape: { cpu: 2, memMb: 8192 } });
      expect((await rt.status.list())[0]!.size).toEqual({ cpu: 2, memMb: 4096 });
    } finally {
      warn.mockRestore();
    }
  });

  it("a record with no view of its machine's size asks the provider for the size on its row", async () => {
    const { backend } = guestCounting(counted(4_128_768));
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = await create(spec);
      (m as { describe?: unknown }).describe = undefined;
      return m;
    };
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      expect(await store.get("workspaces", ws.id)).not.toHaveProperty("shape");
      await rt.workspaces.rebuild(ws.id);
      expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    } finally {
      warn.mockRestore();
    }
  });

  it("a create whose daemon did not answer asks the guest nothing of its memory and says so in one line", async () => {
    const { backend } = guestCounting(counted(4_128_768));
    backend.lifecycle.budgets.daemonAnswersMs = 300;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await create(spec)) as StubMachine;
      m.daemonAnswers = async () => false;
      return m;
    };
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      expect(memoryReads(backend.machines[0]!)).toEqual([]);
      expect(ws).not.toHaveProperty("notice");
      expect(await store.get("workspaces", ws.id)).toMatchObject({ size: { cpu: 2, memMb: 8192 } });
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.includes("memory"))).toEqual([`workspace ${ws.id}: memory not read: the daemon did not answer`]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a guest counting more than the largest size offered is recorded and priced at that size", async () => {
    const { backend } = guestCounting(counted(20_000_000));
    backend.capabilities.sizes = [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }];
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
      const [status] = await rt.status.list();
      expect(status!.size).toEqual({ cpu: 2, memMb: 8192 });
      expect(status!.rateUsdPerHour).toBeCloseTo(0.15, 10);
      expect(ws).not.toHaveProperty("notice");
    } finally {
      warn.mockRestore();
    }
  });

  it("the created line names the image's size where no size was asked, and the size asked where one was", async () => {
    const { backend } = guestCounting(counted(4_128_768));
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "s", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 2, memMb: 8192 } };
    await store.put("goldens", copyKey("default", "big"), { head: 1, versions: [version] });
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const inherited = await createOn(rt, { golden: "snap_golden-v1", name: "a" });
      expect(inherited.notice).toBe("the image's size is 2 vCPU, 8 GB; the machine has 2 vCPU, 4 GB");
      const asked = await createOn(rt, { golden: "snap_golden-v1", name: "b", cpu: 2, memMb: 8192 });
      expect(asked.notice).toBe("asked for 2 vCPU, 8 GB; the machine has 2 vCPU, 4 GB");
    } finally {
      warn.mockRestore();
    }
  });

  it("same behavior over the wire: serveRuntime round-trips create via WS", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const res = await wsRequest(srv.port, "t", { op: "workspaces.create", project: (await projectOn(rt)).id, golden: "snap_g", name: "x" });
    expect(res["ok"]).toBe(true);
    await srv.close();
  });

  it("every fork carries HOME, USER and the golden's PATH in its envs, under the workspace's own", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    // IS_SANDBOX is a machine's fact, a cloud fork's here and an ssh machine's in its own test: it is what lets
    // --dangerously-skip-permissions run as root there, and this computer never carries it.
    expect(GUEST_LOGIN_ENV).toEqual({ HOME: "/root", USER: "root", PATH: TOOLS_PATH, IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1" });
    await createOn(rt, { golden: "snap_g", name: "plain" });
    await createOn(rt, { golden: "snap_g", name: "own", envs: { FOO: "1", HOME: "/home/dev" } });
    expect(backend.machines[0]!.spec.envs).toEqual(GUEST_LOGIN_ENV);
    expect(backend.machines[1]!.spec.envs).toEqual({ HOME: "/home/dev", USER: "root", PATH: TOOLS_PATH, IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", FOO: "1" });
  });

  it("a fork of a version whose seal read npm's own folder carries it first on its PATH, and so does every turn there, a host restarted between them included", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const npmBin = "/opt/nvm/versions/node/v24.18.1/bin";
    const version = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "s", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, npmBin };
    await store.put("goldens", copyKey("default", "big"), { head: 1, versions: [version] });
    const contexts: HarnessAdapterContext[] = [];
    const scripted: HarnessAdapterFactory = ctx => {
      contexts.push(ctx);
      return {
        steers: false,
        start: ({ onEvent }) => {
          const sessionId = "22222222-2222-4222-8222-222222222222";
          const result: TurnResult = { status: "completed", text: "done" };
          const finished = (async () => {
            for (const e of [{ type: "session.start", sessionId }, { type: "turn.done", sessionId, result }, { type: "session.end", sessionId, exitCode: 0, sawResult: true }] as AdapterEvent[]) onEvent(e);
            return result;
          })();
          return { localId: sessionId, finished, interrupt: async () => {} };
        },
      };
    };
    const rt = createRuntime({ backend, store, adapters: { claude: scripted } });
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "x" });
    expect(backend.machines[0]!.spec.envs?.["PATH"]).toBe(`${AGENTS_BIN}:${npmBin}:${TOOLS_PATH}`);
    await (await rt.sessions.start(ws.id, { prompt: "hi" })).finished;
    const again = createRuntime({ backend, store, adapters: { claude: scripted } });
    await (await again.sessions.start(ws.id, { prompt: "again" })).finished;
    expect(contexts.length).toBeGreaterThan(1);
    for (const ctx of contexts) expect(ctx.env["PATH"]).toBe(`${AGENTS_BIN}:${npmBin}:${TOOLS_PATH}`);
    // A version that read none keeps the tools PATH as it is.
    const plain = await createOn(rt, { golden: "snap_g", name: "plain" });
    expect(backend.machines.at(-1)!.spec.envs?.["PATH"]).toBe(TOOLS_PATH);
    expect(plain.id).not.toBe(ws.id);
  });

  it("wake after the paused machine vanished settles it gone and forks nothing; the rebuild that follows forks the golden with the workspace's envs", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goneConfirmMs: 0 });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const ws = await createOn(rt, { golden: "snap_g", name: "x", envs: { FOO: "1" } });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true; // paused machine vanished overnight
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/^x's machine is gone with its disk/);
    expect(backend.machines).toHaveLength(1);
    expect(events.some(e => e.type === "workspace.woken")).toBe(false);
    expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "gone", machineId: "m1" });
    const rebuilt = await rt.workspaces.rebuild(ws.id);
    expect(rebuilt.machineId).toBe("m2");
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_g");
    expect(backend.machines[1]!.spec.envs).toEqual({ ...GUEST_LOGIN_ENV, FOO: "1" });
  });

  it("persists workspaces in the store and rehydrates them (phase survives)", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt1, { golden: "snap_g", name: "x" });
    await rt1.workspaces.nap(ws.id);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    const listed = await rt2.workspaces.list();
    expect(listed.map(w => w.id)).toContain(ws.id);
    expect(listed.find(w => w.id === ws.id)?.phase).toBe("napping");
    const woken = await rt2.workspaces.wake(ws.id); // must resume, not no-op
    expect(woken.phase).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
  });

  it("runs a harness session and fans adapter events out as session.* protocol events", async () => {
    const backend = stubBackend();
    const contexts: HarnessAdapterContext[] = [];
    const scripted: HarnessAdapterFactory = ctx => {
      contexts.push(ctx);
      return {
      steers: false,
      start: ({ onEvent }) => {
        const sessionId = "11111111-1111-4111-8111-111111111111";
        const result: TurnResult = { status: "completed", text: "done" };
        const finished = (async () => {
          const feed: AdapterEvent[] = [
            { type: "session.start", sessionId, model: "claude-sonnet-4-5" },
            { type: "turn.delta", sessionId, kind: "text", text: "hi" },
            { type: "turn.done", sessionId, result },
            { type: "session.end", sessionId, exitCode: 0, sawResult: true },
          ];
          for (const e of feed) onEvent(e);
          return result;
        })();
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
      };
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: scripted } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const session = await rt.sessions.start(ws.id, { prompt: "say hi" });
    const result = await session.finished;
    expect(result.status).toBe("completed");
    // The adapter is handed the machine's login environment: who the guest runs as, the golden's PATH, so a launch served by a bare-PATH exec still finds the binary, and the variable that points this harness at its store on the guest.
    // Every context, not the first alone: a turn is not the only road that asks a harness something on the machine.
    // A turn's own launch carries two things over that login, the token naming its turn and the token its thread drives
    // this host with; no other road carries either.
    expect(contexts.length).toBeGreaterThan(0);
    const project = (await rt.projects.list())[0]!;
    // The key the record was written with is handed to the adapter beside that environment and never in it: the
    // CLI's own strip drops an inherited one, and the adapter sets the key it was told after it.
    expect(project.memoryKey).toMatch(/^-root-/);
    expect(contexts.every(ctx => ctx.projectKey === project.memoryKey)).toBe(true);
    for (const ctx of contexts) {
      const { [TURN_TOKEN_ENV]: token, [HOST_TOKEN_ENV]: scoped, ...login } = ctx.env;
      expect(login).toEqual({ ...GUEST_LOGIN_ENV, CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
      if (token !== undefined) expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(scoped !== undefined).toBe(token !== undefined);
    }
    expect(contexts.filter(c => c.env[TURN_TOKEN_ENV] !== undefined)).toHaveLength(1);
    const types = events.map(e => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("session.delta");
    expect(types).toContain("session.done");
    expect(types).toContain("session.end");
    for (const e of events) {
      if (e.type.startsWith("session.")) expect((e as { workspaceId: string }).workspaceId).toBe(ws.id);
    }
    expect((await rt.sessions.list())[0]?.status).toBe("completed");
    // the workspace remembers the claude session id so later sends can --resume it
    expect((await rt.workspaces.get(ws.id)).claudeSessionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("delete kills the machine and reap sweeps only unclaimed wsp machines", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    // a stray wsp-labeled machine nothing claims, old enough to reap
    await backend.create({
      kind: "sandbox",
      labels: { wsp: "1", createdAt: new Date(Date.now() - 3_600_000).toISOString() },
    });
    expect(await rt.reap()).toEqual({ reaped: [expect.objectContaining({ id: "m2", builder: false, reason: "orphan" })], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
    await rt.workspaces.delete(ws.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a delete the provider answers and never acts on keeps the record, fails naming the machine, and says so in the row's reason and the host's log", async () => {
    const backend = stubBackend();
    const made = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await made(spec)) as StubMachine;
      m.kill = async () => {};
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, killConfirm: { graceMs: 20, pollMs: 1 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const said = "x's machine m1 is still running after three asks; run wsp delete again or delete it at the provider";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(rt.workspaces.delete(ws.id)).rejects.toMatchObject({ kind: "machineAlive", message: said });
      expect(warn.mock.calls.map(c => c[0])).toContain(said);
    } finally {
      warn.mockRestore();
    }
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    expect((await rt.status.list()).find(s => s.id === ws.id)?.reason).toBe(said);
    expect((await backend.list()).map(m => m.id)).toEqual(["m1"]);
  });

  it("a kept machine's delete sentence leaves the row's reason when the next delete fails another way or a wake runs", async () => {
    const backend = stubBackend();
    const made = backend.create.bind(backend);
    let kill = async (): Promise<void> => {};
    backend.create = async spec => {
      const m = (await made(spec)) as StubMachine;
      m.kill = () => kill();
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, killConfirm: { graceMs: 20, pollMs: 1 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    const said = "x's machine m1 is still running after three asks; run wsp delete again or delete it at the provider";
    const reason = async (): Promise<string | undefined> => (await rt.status.list()).find(s => s.id === ws.id)?.reason;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(rt.workspaces.delete(ws.id)).rejects.toMatchObject({ message: said });
      kill = async () => {
        throw new Error("link down");
      };
      await expect(rt.workspaces.delete(ws.id)).rejects.toThrow("link down");
      expect(await reason()).toBeUndefined();
      kill = async () => {};
      await expect(rt.workspaces.delete(ws.id)).rejects.toMatchObject({ message: said });
      expect(await reason()).toBe(said);
      // The sentence was about a running machine: the paused row does not carry it, and the log still does.
      await rt.workspaces.nap(ws.id);
      expect(await reason()).toBeUndefined();
      expect(warn.mock.calls.map(c => c[0])).toContain(said);
      await rt.workspaces.wake(ws.id);
      expect(await reason()).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("a paused machine the provider keeps says still paused on its napping row until a wake starts", async () => {
    const backend = stubBackend();
    const made = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await made(spec)) as StubMachine;
      m.kill = async () => {};
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, killConfirm: { graceMs: 20, pollMs: 1 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await rt.workspaces.nap(ws.id);
    const said = "x's machine m1 is still paused after three asks; run wsp delete again or delete it at the provider";
    const row = async (): Promise<WorkspaceStatus | undefined> => (await rt.status.list()).find(s => s.id === ws.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(rt.workspaces.delete(ws.id)).rejects.toMatchObject({ kind: "machineAlive", message: said });
      expect(await row()).toMatchObject({ phase: "napping", reason: said });
      await rt.workspaces.wake(ws.id);
      expect((await row())?.reason).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("a delete the provider takes on the second ask drops the record, and a machine already missing at the first read drops it after one ask", async () => {
    const backend = stubBackend();
    const made = backend.create.bind(backend);
    const asks = new Map<string, number>();
    backend.create = async spec => {
      const m = (await made(spec)) as StubMachine;
      const kill = m.kill.bind(m);
      m.kill = async () => {
        asks.set(m.id, (asks.get(m.id) ?? 0) + 1);
        if (m.id === "m2") {
          m.killed = true;
          throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
        }
        if (asks.get(m.id)! > 1) await kill();
      };
      return m;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, killConfirm: { graceMs: 20, pollMs: 1 } });
    const late = await createOn(rt, { golden: "snap_g", name: "late" });
    const missing = await createOn(rt, { golden: "snap_g", name: "missing" });
    await rt.workspaces.delete(late.id);
    expect(asks.get("m1")).toBe(2);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([missing.id]);
    await rt.workspaces.delete(missing.id);
    expect(asks.get("m2")).toBe(1);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(await backend.list()).toEqual([]);
  });
});
