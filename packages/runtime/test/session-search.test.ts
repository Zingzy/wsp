// SPDX-License-Identifier: AGPL-3.0-only
// Searching the words of every thread the host still holds: the person's
// messages and the agent's replies, a reply's pieces read as the one message
// they are, one hit per thread with a snippet around the words, and a thread's
// token reaching its own tree and nothing else, as every other read does.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Caller, ThreadScope, TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

/** A harness whose reply to a prompt is given by the test, streamed in two pieces the way a real one streams. */
function replying(reply: (prompt: string) => string): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      const text = reply(o.prompt);
      const result: TurnResult = { status: "completed", text };
      const cut = Math.floor(text.length / 2);
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, cwd: "/root/app" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(0, cut), messageId: "m1" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(cut), messageId: "m1" });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

describe("searching inside messages", () => {
  it("a word only in a reply finds its thread with a snippet around it, a word in the person's message finds that thread, and case is ignored", async () => {
    const replies: Record<string, string> = {
      "fix the redirect": "Done. The redirect now sends every old path to the canonical host and keeps the query string.",
      "tidy the readme": "Rewrote the install section.",
    };
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: replying(p => replies[p] ?? "ok") } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const redirect = await rt.sessions.start(ws.id, { prompt: "fix the redirect" });
    await redirect.finished;
    const readme = await rt.sessions.start(ws.id, { prompt: "tidy the readme" });
    await readme.finished;

    const { hits } = await rt.sessions.search("CANONICAL");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ workspaceId: ws.id, threadId: redirect.view().threadId });
    expect(hits[0]!.snippet).toContain("canonical host");
    // The words around a hit are its own message's, never the tail of the person's message run into the reply.
    expect((await rt.sessions.search("rewrote")).hits.map(h => h.snippet)).toEqual(["Rewrote the install section."]);

    // The split between the reply's two pieces falls inside no word the search can miss.
    const whole = replies["fix the redirect"]!;
    const across = whole.slice(Math.floor(whole.length / 2) - 4, Math.floor(whole.length / 2) + 4);
    expect((await rt.sessions.search(across)).hits.map(h => h.threadId)).toEqual([redirect.view().threadId]);

    expect((await rt.sessions.search("readme")).hits.map(h => h.threadId)).toEqual([readme.view().threadId]);
    expect((await rt.sessions.search("   ")).hits).toEqual([]);
    expect((await rt.sessions.search("nowhere at all")).hits).toEqual([]);
    await rt.close();
  });

  it("a thread's token finds its own tree's words and nothing another tree on the same workspace said", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: replying(p => `reply to ${p}: zebra`) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a", agents: { spawn: true, maxMachines: 3, maxDepth: 3 } });
    const mine = await rt.sessions.start(ws.id, { prompt: "the person's own" });
    await mine.finished;
    const lead = await rt.sessions.start(ws.id, { prompt: "lead" });
    await lead.finished;
    const rootThread = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId: rootThread, workspaceId: ws.id, rootThreadId: rootThread };
    const child = await rt.sessions.start(ws.id, { prompt: "child" }, asThread(scope));
    await child.finished;
    const elsewhere = await createOn(rt, { golden: "snap_g", name: "b" });
    await (await rt.sessions.start(elsewhere.id, { prompt: "not yours" })).finished;

    const scoped = (await rt.sessions.search("zebra", asThread(scope))).hits.map(h => h.threadId).sort();
    expect(scoped).toEqual([rootThread, child.view().threadId!].sort());
    // The person reads every thread, as they always did.
    expect((await rt.sessions.search("zebra")).hits).toHaveLength(4);
    await rt.close();
  });

  it("answers in under a second over three hundred threads", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: replying(p => `A long reply about ${p}, with enough words in it to look like a real answer from an agent that did some work.`) } });
    const spaces = await Promise.all([0, 1, 2].map(n => createOn(rt, { golden: "snap_g", name: `w${n}` })));
    for (let n = 0; n < 300; n++) await (await rt.sessions.start(spaces[n % 3]!.id, { prompt: `task number ${n}` })).finished;
    await (await rt.sessions.start(spaces[1]!.id, { prompt: "the odd one" })).finished;

    const started = performance.now();
    const { hits } = await rt.sessions.search("about the odd one");
    const took = performance.now() - started;
    expect(hits).toHaveLength(1);
    expect(took).toBeLessThan(1000);
    await rt.close();
  }, 120_000);
});
