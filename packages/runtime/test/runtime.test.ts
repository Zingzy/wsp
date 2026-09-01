import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import type { EventUnion } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { wsRequest } from "./ws-client.js";
import { stubBackend } from "./stub-backend.js";

describe("runtime", () => {
  it("creates a workspace from a golden manifest and emits protocol events", async () => {
    const events: string[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    rt.events.on("*", e => events.push(e.type));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    expect(ws.id).toBeTruthy();
    expect(events).toContain("workspace.created");
    await rt.workspaces.nap(ws.id);
    expect(events).toContain("workspace.napped");
  });

  it("same behavior over the wire: serveRuntime round-trips create via WS", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const res = await wsRequest(srv.port, "t", { op: "workspaces.create", golden: "snap_g", name: "x" });
    expect(res["ok"]).toBe(true);
    await srv.close();
  });

  it("wake after the paused machine vanished resurrects a fresh golden fork", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x", envs: { FOO: "1" } });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true; // paused machine vanished overnight
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.machineId).toBe("m2");
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_g");
    expect(backend.machines[1]!.spec.envs).toEqual({ FOO: "1" });
    const wokeEvent = events.find(e => e.type === "workspace.woken");
    expect(wokeEvent).toMatchObject({ machineId: "m2", resurrected: true });
  });

  it("persists workspaces in the store and rehydrates them (phase survives)", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "x" });
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
    const scripted: HarnessAdapterFactory = () => ({
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
        return { localId: sessionId, claudeSessionId: sessionId, finished };
      },
    });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: scripted } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const session = await rt.sessions.start(ws.id, { prompt: "say hi" });
    const result = await session.finished;
    expect(result.status).toBe("completed");
    const types = events.map(e => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("session.delta");
    expect(types).toContain("session.done");
    expect(types).toContain("session.end");
    for (const e of events) {
      if (e.type.startsWith("session.")) expect((e as { workspaceId: string }).workspaceId).toBe(ws.id);
    }
    expect(rt.sessions.list()[0]?.status).toBe("completed");
    // the workspace remembers the claude session id so later sends can --resume it
    expect((await rt.workspaces.get(ws.id)).claudeSessionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("delete kills the machine and reap sweeps only unclaimed wsp machines", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    // a stray wsp-labeled machine nothing claims, old enough to reap
    await backend.create({
      kind: "sandbox",
      labels: { wsp: "1", createdAt: new Date(Date.now() - 3_600_000).toISOString() },
    });
    const reaped = await rt.reap();
    expect(reaped).toEqual(["m2"]);
    expect(backend.machines[0]!.killed).toBe(false);
    await rt.workspaces.delete(ws.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });
});

describe("runtime session history", () => {
  const scripted = (text: string): HarnessAdapterFactory => () => ({
    start: ({ onEvent }) => {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const result: TurnResult = { status: "completed", text };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId, model: "claude-sonnet-4-5" },
          { type: "turn.delta", sessionId, kind: "text", text },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) onEvent(e);
        return result;
      })();
      return { localId: sessionId, claudeSessionId: sessionId, finished };
    },
  });

  it("replays a workspace's session events with the prompt on session.start, surviving a restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: scripted("hello") } });
    const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await rt.workspaces.create({ golden: "snap_g", name: "b" });
    await (await rt.sessions.start(a.id, { prompt: "say hello" })).finished;

    const history = await rt.sessions.history(a.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(history[0]).toMatchObject({ type: "session.start", workspaceId: a.id, prompt: "say hello" });
    expect(await rt.sessions.history(b.id)).toEqual([]);

    // a fresh runtime over the same store still has it; deleting the workspace drops it
    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect(await rt2.sessions.history(a.id)).toEqual(history);
    await rt2.workspaces.delete(a.id);
    await expect(rt2.sessions.history(a.id)).rejects.toThrow("no such workspace");
    expect(await store.list("transcripts")).toEqual([]);
  });

  it("persists turn boundaries in order even when an earlier put finishes last", async () => {
    const inner = memoryStore();
    let puts = 0;
    const store = {
      ...inner,
      put: async (collection: string, id: string, value: unknown) => {
        // the first transcript write is slow, the ones behind it are instant
        const delay = collection === "transcripts" && puts++ === 0 ? 40 : 0;
        await new Promise(r => setTimeout(r, delay));
        await inner.put(collection, id, value);
      },
    };
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: scripted("x") } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    // The chain drains on its own clock; poll for it instead of guessing a sleep.
    const read = async () => ((await inner.get("transcripts", ws.id)) as { events: { type: string }[] } | undefined)?.events ?? [];
    const deadline = Date.now() + 2000;
    while ((await read()).length < 4 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect((await read()).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
  });

  it("caps the persisted transcript so a chatty workspace cannot grow the store without bound", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: scripted("x") } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    for (let i = 0; i < 1300; i++) await (await rt.sessions.start(ws.id, { prompt: `t${i}` })).finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.length).toBeLessThanOrEqual(5000);
    expect(history[history.length - 1]).toMatchObject({ type: "session.end" });
    expect(history.some(e => e.type === "session.start" && e.prompt === "t1299")).toBe(true);
    expect(history.some(e => e.type === "session.start" && e.prompt === "t0")).toBe(false);
  });
});

describe("runtime daemon reach", () => {
  const TOKEN_CMD = "cat /root/.wsp-daemon-token";

  it("hands back the preview route plus the daemon token read once off the guest", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = (_m, cmd) =>
      cmd === TOKEN_CMD ? { exitCode: 0, stdout: "guest-token\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: "guest-token" });
    await rt.workspaces.daemonReach(ws.id);
    expect(minted).toBe(1);
    expect(backend.machines[0]!.execLog.filter(c => c === TOKEN_CMD)).toHaveLength(1);
  });

  it("omits the daemon token when the guest has none and refuses backends without preview urls", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd === TOKEN_CMD ? { exitCode: 1, stdout: "", stderr: "No such file" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("without preview URLs");

    backend.machines[0]!.previewUrl = async () => ({ url: "https://m1-7070.preview.example/?pt_token=e", token: "e", expiresAt: Date.now() + 3_600_000 });
    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach.daemonToken).toBeUndefined();
    expect("daemonToken" in reach).toBe(false);
  });

  it("re-reads the token after a resurrect replaces the machine", async () => {
    const backend = stubBackend();
    backend.execImpl = (m, cmd) => (cmd === TOKEN_CMD ? { exitCode: 0, stdout: `tok-${m.id}`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const mint = async (port: number) => ({ url: `https://x-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
    backend.machines[0]!.previewUrl = mint;
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe("tok-m1");

    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    await rt.workspaces.wake(ws.id);
    backend.machines[1]!.previewUrl = mint;
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe("tok-m2");
  });
});

describe("runtime golden builders", () => {
  const recipe = { setup: "install", smoke: "true" };

  it("reap kills a builder left behind by a crashed wizard, whatever its age, and keeps this process's own", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const stale = await crashed.golden.prepare({ name: "default" });

    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const own = await rt.golden.prepare({ name: "default" });
    expect((await rt.golden.builders()).map(b => b.id).sort()).toEqual([stale.id, own.id].sort());

    const reaped = await rt.reap();
    expect(reaped).toEqual([stale.id]);
    expect(backend.machines.find(m => m.id === stale.id)!.killed).toBe(true);
    expect(backend.machines.find(m => m.id === own.id)!.killed).toBe(false);
    expect((await rt.golden.builders()).map(b => b.id)).toEqual([own.id]);
    expect(await store.list("builders")).toHaveLength(1);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a builder whose machine already vanished is forgotten on hydrate", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const b = await crashed.golden.prepare();
    await backend.machines[0]!.kill();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    expect(await rt.golden.builders()).toEqual([]);
    expect(await store.get("builders", b.id)).toBeUndefined();
  });

  it("a failed seal forgets the builder and writes no manifest", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd === "true" ? { exitCode: 1, stdout: "", stderr: "broken" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const stages: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") stages.push(e.stage); });
    const b = await rt.golden.prepare();
    await expect(rt.golden.seal(b.id)).rejects.toThrow(/smoke failed/);
    expect(stages.at(-1)).toBe("failed");
    expect(backend.machines.every(m => m.killed)).toBe(true);
    expect(await rt.golden.builders()).toEqual([]);
    expect(await rt.golden.get()).toBeUndefined();
  });
});

describe("runtime upgrade vault", () => {
  it("vaults user files (skipping golden-provided dirs) onto the fresh fork", async () => {
    const backend = stubBackend();
    const tarCmds: string[] = [];
    const untarCmds: string[] = [];
    backend.execImpl = (m, cmd) => {
      if (cmd.includes("ls -A /root")) {
        return { exitCode: 0, stdout: "notes.md\n.local\n.claude-cfg\n.npm\n.wsp-upgraded\n", stderr: "" };
      }
      if (cmd.includes("tar czf")) tarCmds.push(`${m.id}:${cmd}`);
      if (cmd.includes("tar xzf")) untarCmds.push(`${m.id}:${cmd}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
      ),
    );
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      const upgraded = await rt.workspaces.upgrade(ws.id, { cpu: 4 });
      expect(upgraded.machineId).toBe("m2");
      expect(backend.machines[1]!.spec.cpu).toBe(4);
      const tar = tarCmds.find(c => c.startsWith("m1:"));
      expect(tar).toContain("'root/notes.md'");
      expect(tar).toContain("'root/.claude-cfg'");
      expect(tar).not.toContain(".local");
      expect(tar).not.toContain(".npm");
      expect(untarCmds.some(c => c.startsWith("m2:"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
