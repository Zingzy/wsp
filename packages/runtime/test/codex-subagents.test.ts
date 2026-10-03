// SPDX-License-Identifier: AGPL-3.0-only
// A Codex turn's subagents through the runtime: the real Codex adapter over a
// scripted app server, its child threads written as session.subagent rows and
// listed under the thread, the lead's reply held while a child runs, and one
// child stopped by itself. The server's lines take the shape of T3 Code's
// recorded multi-agent wire (codexMultiAgentWire.json, codex-cli 0.145.0, MIT):
// each child thread prints its own turn on the lead's stdout under its own id.
import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { foldThreads, type ExecStream, type ExecStreamFactory } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const LEAD = "019fcfd6-17bb-72f0-ae12-a1f2dee6e3e5";
const LEAD_TURN = "019fcfd6-1806-7de1-8564-de69fd55bffb";
const CHILD = "019fcfd6-2883-77e0-9013-4410ede70371";
const CHILD_TURN = "019fcfd6-28bf-7e00-a873-4554526dc845";

type Json = Record<string, unknown>;

/** One app server process: what it prints, what wsp wrote to it, and an exit on stdin EOF as the real one makes. */
interface Server {
  push(...lines: unknown[]): void;
  written: Json[];
}

function scriptedServers(onWrite: (message: Json, server: Server) => void): { exec: ExecStreamFactory; servers: Server[] } {
  const servers: Server[] = [];
  const exec: ExecStreamFactory = (_command, { input }) => {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => (exit = resolve));
    const end = (code: number | null): void => {
      if (done) return;
      done = true;
      wake?.();
      exit(code);
    };
    const server: Server = {
      written: [],
      push: (...lines) => {
        queue.push(...lines.map(l => JSON.stringify(l)));
        wake?.();
      },
    };
    servers.push(server);
    const stream: ExecStream = {
      lines: (async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>(resolve => (wake = resolve));
          wake = undefined;
        }
      })(),
      write: async line => {
        if (done) return "gone";
        const message = JSON.parse(line) as Json;
        server.written.push(message);
        onWrite(message, server);
        return "written";
      },
      closeInput: () => void setTimeout(() => end(0), 0),
      teardown: () => end(0),
      kill: () => end(null),
      exited,
    };
    for (const line of input ?? []) void stream.write(line);
    return stream;
  };
  return { exec, servers };
}

const turnStarted = (threadId: string, turnId: string) => ({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null } } });
const turnCompleted = (threadId: string, turnId: string, status: string) => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status, error: null } } });
const message = (threadId: string, turnId: string, id: string, text: string) => ({ method: "item/completed", params: { item: { type: "agentMessage", id, text }, threadId, turnId } });
const spawned = (child: string, call: string) => ({
  method: "item/completed",
  params: { item: { type: "subAgentActivity", id: call, kind: "started", agentThreadId: child, agentPath: "/root/alpha" }, threadId: LEAD, turnId: LEAD_TURN, completedAtMs: 1785898346687 },
});
const usage = (threadId: string, turnId: string, last: number) => ({
  method: "thread/tokenUsage/updated",
  params: { threadId, turnId, tokenUsage: { total: { inputTokens: last, outputTokens: 0 }, last: { inputTokens: last, outputTokens: 0 }, modelContextWindow: 258_400 } },
});

/** A lead that spawns one child each turn and ends its own turn without waiting on it. */
function codexServer() {
  return scriptedServers((m, server) => {
    if (m.method === "thread/start" || m.method === "thread/resume") {
      server.push({ id: "wsp-initialize", result: {} }, { id: "wsp-thread", result: { thread: { id: LEAD, historyMode: "paginated", turns: [] }, model: "gpt-5.6-luna", cwd: "/root/work" } });
    }
    if (m.method === "turn/start") server.push(turnStarted(LEAD, LEAD_TURN), spawned(CHILD, "call_S2JP"), turnStarted(CHILD, CHILD_TURN), usage(CHILD, CHILD_TURN, 20_756));
    if (m.method === "turn/interrupt") {
      const params = m.params as Json;
      server.push({ id: m.id, result: {} }, turnCompleted(String(params.threadId), String(params.turnId), "interrupted"));
    }
  });
}

async function begin() {
  const { exec, servers } = codexServer();
  const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { codex: () => createCodexAdapter({ exec, home: "/root/.codex", login: "codex login" }) } });
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  const handle = await rt.sessions.start(ws.id, { prompt: "spawn one agent and end your turn", harness: "codex" });
  await until(() => servers.at(-1)?.written.some(m => m.method === "turn/start") === true);
  return { rt, ws, handle, servers };
}

const rows = async (rt: Awaited<ReturnType<typeof begin>>["rt"], workspaceId: string) => (await rt.sessions.history(workspaceId)).filter(e => e.type === "session.subagent");

describe("a Codex turn's subagents through the runtime", () => {
  it("writes the child's start and end as rows, holds the lead's reply until the child ends, and keeps the child under the thread", async () => {
    const { rt, ws, servers } = await begin();
    await until(async () => (await rt.sessions.list(ws.id))[0]?.subagents?.length === 1);
    expect((await rt.sessions.list(ws.id))[0]!.subagents).toEqual([{ id: CHILD, title: "alpha", state: "running", parentToolUseId: "call_S2JP", depth: 1, startedAt: expect.any(Number) }]);

    servers[0]!.push(message(LEAD, LEAD_TURN, "lead_m1", "spawned it"), turnCompleted(LEAD, LEAD_TURN, "completed"));
    await new Promise(r => setTimeout(r, 20));
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("running");

    servers[0]!.push(message(CHILD, CHILD_TURN, "child_m1", "slept and done"), turnCompleted(CHILD, CHILD_TURN, "completed"));
    await until(async () => (await rt.sessions.list(ws.id))[0]!.status === "completed");
    const [row] = await rt.sessions.list(ws.id);
    expect(row!.subagents?.map(c => [c.id, c.state])).toEqual([[CHILD, "done"]]);
    expect(foldThreads(await rt.sessions.list(ws.id))[0]!.subagents?.map(c => [c.id, c.state])).toEqual([[CHILD, "done"]]);
    expect((await rt.sessions.history(ws.id)).find(e => e.type === "session.done")).toMatchObject({ result: { status: "completed", text: "spawned it" } });
    const said = await rows(rt, ws.id);
    expect(said.map(e => [e.task, e.state])).toEqual([[CHILD, "running"], [CHILD, "done"]]);
    expect(said[1]).toMatchObject({ parentToolUseId: "call_S2JP", summary: "slept and done" });
    await rt.close();
  });

  it("stops one child by itself through the adapter's turn/interrupt on the child's thread, the lead running on", async () => {
    const { rt, ws, handle, servers } = await begin();
    await until(async () => (await rt.sessions.list(ws.id))[0]?.subagents?.length === 1);
    expect(await rt.sessions.interrupt(handle.id, undefined, CHILD)).toEqual({ outcome: "accepted" });
    expect(servers[0]!.written.filter(m => m.method === "turn/interrupt").map(m => m.params)).toEqual([{ threadId: CHILD, turnId: CHILD_TURN }]);
    await until(async () => (await rt.sessions.list(ws.id))[0]!.subagents?.[0]?.state === "stopped");
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("running");

    servers[0]!.push(message(LEAD, LEAD_TURN, "lead_m1", "the child was stopped"), turnCompleted(LEAD, LEAD_TURN, "completed"));
    await until(async () => (await rt.sessions.list(ws.id))[0]!.status === "completed");
    expect((await rows(rt, ws.id)).map(e => [e.task, e.state])).toEqual([[CHILD, "running"], [CHILD, "stopped"]]);
    await rt.close();
  });
});
