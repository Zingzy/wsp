// SPDX-License-Identifier: AGPL-3.0-only
// The agent's plan as its adapter reads it: each turn.plan is recorded as the
// turn's session.plan, under the turn and the thread, as the adapter sent it.
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend, tokenGuest } from "./stub-backend.js";

const steps = [
  { text: "read the ticket", state: "done" as const },
  { text: "write the test", state: "working" as const },
];

const planning: HarnessAdapterFactory = () => ({
  steers: false,
  start: options => {
    const sessionId = "sess-plan";
    const result: TurnResult = { status: "completed", text: "done" };
    const finished = (async () => {
      options.onEvent({ type: "session.start", sessionId });
      options.onEvent({ type: "turn.plan", sessionId, steps });
      options.onEvent({ type: "turn.plan", sessionId, text: "# Plan\n\n1. Test first" });
      options.onEvent({ type: "turn.done", sessionId, result });
      options.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

describe("the agent's plan", () => {
  it("is recorded under the turn and the thread, steps and text as the adapter read them", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: planning } });
    const ws = await createOn(rt, { golden: "snap_g", name: "plans" });
    const events: SessionEvent[] = [];
    rt.events.on("*", e => {
      if (e.type === "session.plan" || e.type === "session.start") events.push(e);
    });
    const handle = await rt.sessions.start(ws.id, { prompt: "plan it" });
    await handle.finished;
    const start = events.find(e => e.type === "session.start" && e.prompt === "plan it")!;
    expect(events.filter(e => e.type === "session.plan")).toEqual([
      expect.objectContaining({ type: "session.plan", turnId: start.turnId, threadId: handle.view().threadId, steps }),
      expect.objectContaining({ type: "session.plan", turnId: start.turnId, threadId: handle.view().threadId, text: "# Plan\n\n1. Test first" }),
    ]);
  });
});
