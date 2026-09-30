// SPDX-License-Identifier: AGPL-3.0-only
// A reply's shell block run where it stands, as the thread keeps it: the run's
// start and end recorded on the thread so every window and a reload draw the
// same block, its output kept to the tail, and a run that ended staying ended
// whichever window reports it again.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUN_OUTPUT_MAX_CHARS, type Caller, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

function replying(text: string): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      const result: TurnResult = { status: "completed", text };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text, messageId: "m1" });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

const runsOf = (events: readonly SessionEvent[]): Extract<SessionEvent, { type: "session.run" }>[] => events.flatMap(e => (e.type === "session.run" ? [e] : []));

describe("a reply's block run where it stands", () => {
  it("is recorded on the thread from its start to its end, and every window hears each step", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: replying("Stop them:\n\n```sh\nkill 60082 60083\n```") } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "stop the servers" });
    await handle.finished;
    const { threadId, id: turnId } = handle.view();
    const heard: SessionEvent[] = [];
    rt.events.on("*", e => {
      if (e.type === "session.run") heard.push(e);
    });
    const block = `${turnId}:m0@12`;
    const started = await rt.sessions.run({ threadId: threadId!, turnId: turnId!, runId: "run-1", block, command: "kill 60082 60083", state: "running", ptyId: "pty_7" });
    expect(started).toMatchObject({ type: "session.run", workspaceId: ws.id, threadId, turnId, runId: "run-1", block, command: "kill 60082 60083", state: "running", ptyId: "pty_7" });
    const ended = await rt.sessions.run({ threadId: threadId!, turnId: turnId!, runId: "run-1", block, command: "kill 60082 60083", state: "exited", exitCode: 1, output: "kill: 60082: No such process" });
    expect(ended).toMatchObject({ state: "exited", exitCode: 1, output: "kill: 60082: No such process" });
    expect(heard.map(e => (e.type === "session.run" ? e.state : ""))).toEqual(["running", "exited"]);
    // The thread's own history carries both, so a reload folds the same block.
    expect(runsOf(await rt.sessions.history(ws.id)).map(e => [e.runId, e.state])).toEqual([
      ["run-1", "running"],
      ["run-1", "exited"],
    ]);
    await rt.close();
  });

  it("keeps a long output's tail, and a run that ended stays as it ended when another window reports it again", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: replying("```sh\nyes\n```") } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    await handle.finished;
    const { threadId, id: turnId } = handle.view();
    const base = { threadId: threadId!, turnId: turnId!, runId: "run-2", block: `${turnId}:m0@0`, command: "yes" };
    const long = Array.from({ length: 40_000 }, (_, i) => `y ${i}`).join("\n");
    const ended = await rt.sessions.run({ ...base, state: "exited", exitCode: 130, output: long });
    expect(ended.output!.length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_CHARS);
    expect(ended.output!.endsWith("y 39999")).toBe(true);
    const again = await rt.sessions.run({ ...base, state: "lost" });
    expect(again).toMatchObject({ state: "exited", exitCode: 130 });
    expect(runsOf(await rt.sessions.history(ws.id))).toHaveLength(1);
    await rt.close();
  });

  it("is refused for a thread this host does not hold, and to a thread's own token", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: replying("ok") } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    await handle.finished;
    const { threadId, id: turnId } = handle.view();
    const run = { turnId: turnId!, runId: "r", block: "b", command: "ls", state: "running" as const };
    await expect(rt.sessions.run({ ...run, threadId: "nope" })).rejects.toThrow(/no thread/);
    const thread: Caller = { origin: "relayed", by: { kind: "thread", threadId: threadId!, workspaceId: ws.id, rootThreadId: threadId! } };
    await expect(rt.sessions.run({ ...run, threadId: threadId! }, thread)).rejects.toThrow();
    await rt.close();
  });
});
