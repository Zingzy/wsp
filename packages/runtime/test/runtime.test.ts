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
