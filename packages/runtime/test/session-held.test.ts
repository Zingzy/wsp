// SPDX-License-Identifier: AGPL-3.0-only
// A thread is in the listing from the moment its start holds its row, and every subscriber hears so then, before the
// harness has announced its session: a window draws a thread the command line started without waiting on its launch.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EventUnion, TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

describe("a held thread", () => {
  it("is said to every subscriber with its row already listed, before the harness announces anything", async () => {
    let release: () => void = () => {};
    const slow: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "done" };
        const finished = new Promise<void>(r => (release = r)).then(() => {
          o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: slow } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const said: EventUnion[] = [];
    const listed: unknown[] = [];
    rt.events.on("*", e => {
      if (e.type !== "session.held" && e.type !== "session.start") return;
      said.push(e);
      if (e.type === "session.held") void rt.sessions.list(ws.id).then(rows => listed.push(...rows.map(r => r.threadId)));
    });
    const started = await rt.sessions.start(ws.id, { prompt: "fix it", requestId: "req_1" });
    await new Promise(r => setTimeout(r, 20));
    expect(said.map(e => e.type)).toEqual(["session.held"]);
    const held = said[0] as Extract<EventUnion, { type: "session.held" }>;
    expect(held.workspaceId).toBe(ws.id);
    // The send it answers, so the client that minted the id drops its own tile for it and no other.
    expect(held.requestId).toBe("req_1");
    expect(listed).toContain(held.threadId);
    release();
    await started.finished;
    expect(said.map(e => e.type)).toEqual(["session.held", "session.start"]);
    await rt.close();
  });
});
