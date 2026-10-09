// SPDX-License-Identifier: AGPL-3.0-only
// What a thread's listing says of how its turns ended, all the way through the
// runtime: the last line of a reply on the row and the thread, a failure's
// reason in its place, cleared by the next turn that completes, the reason a
// cut turn and a failed launch leave, and the fold mark kept on the thread's
// record across a host restart. The harness here is a fake the test ends one
// way or another, so the runtime's own bookkeeping is what is under test.
import { describe, expect, it } from "vitest";
import { LISTED_LINE_CHARS, NO_RESULT_LINE, foldThreads, type SessionView, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { RESTARTED_REASON } from "../src/types/internal.js";
import { createOn, stubBackend, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";

/** A running fake turn the test ends: with a result, or with an exit that brought none. */
interface Turn {
  end: (result: TurnResult) => void;
  die: () => void;
}

/** A harness whose turns end however the test says, and whose next start throws where `refuse` names a reason, the
 * launch that never reaches an agent. */
function endedByHand() {
  const turns: Turn[] = [];
  let refuse: string | undefined;
  let minted = 0;
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      if (refuse !== undefined) throw new Error(refuse);
      const session = o.resume ?? `sess-${++minted}`;
      let settle!: (result: TurnResult) => void;
      const finished = new Promise<TurnResult>(resolve => (settle = resolve));
      queueMicrotask(() => o.onEvent({ type: "session.start", sessionId: session, cwd: "/root/work" }));
      turns.push({
        end: result => {
          o.onEvent({ type: "turn.done", sessionId: session, result });
          o.onEvent({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
          settle(result);
        },
        die: () => {
          o.onEvent({ type: "session.end", sessionId: session, exitCode: 1, sawResult: false });
          settle({ status: "failed" });
        },
      });
      return { localId: session, finished, interrupt: async () => {} };
    },
  });
  return { adapter, turns, refuseWith: (why: string | undefined) => void (refuse = why) };
}

async function begin(h: ReturnType<typeof endedByHand>, store: Store = memoryStore(), backend: StubBackend = stubBackend()) {
  const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  await rt.sessions.start(ws.id, { prompt: "build it" });
  await until(() => h.turns.length === 1);
  await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
  return { rt, ws, store, backend };
}

const latest = async (rt: Runtime, workspaceId: string): Promise<SessionView> => (await rt.sessions.list(workspaceId)).at(-1)!;
const settledAs = (rt: Runtime, workspaceId: string, status: SessionView["status"]): Promise<void> => until(async () => (await latest(rt, workspaceId)).status === status);

describe("how a thread's turns ended, on its listing", () => {
  it("a turn that completes leaves its reply's last line on its row and its thread, cut at 200 characters", async () => {
    const h = endedByHand();
    const { rt, ws } = await begin(h);
    const last = `${"done ".repeat(60)}and pushed.`;
    h.turns[0]!.end({ status: "completed", text: `Read the ticket.\n\n${last}\n` });
    await settledAs(rt, ws.id, "completed");
    const row = await latest(rt, ws.id);
    expect(row.lastLine!.length).toBeLessThanOrEqual(LISTED_LINE_CHARS);
    expect(last.startsWith(row.lastLine!.slice(0, -1))).toBe(true);
    expect(row).not.toHaveProperty("failure");
    expect(foldThreads(await rt.sessions.list(ws.id))[0]).toMatchObject({ lastLine: row.lastLine });
    await rt.close();
  });

  it("a turn that ends failed leaves its reason, and the next turn that completes clears it", async () => {
    const h = endedByHand();
    const { rt, ws } = await begin(h);
    h.turns[0]!.end({ status: "failed", error: "API Error: 529 overloaded\nretry in a minute" });
    await settledAs(rt, ws.id, "failed");
    expect(foldThreads(await rt.sessions.list(ws.id))[0]).toMatchObject({ status: "failed", failure: "API Error: 529 overloaded" });
    expect(await latest(rt, ws.id)).not.toHaveProperty("lastLine");

    const thread = foldThreads(await rt.sessions.list(ws.id))[0]!;
    await rt.sessions.start(ws.id, { prompt: "again", thread: thread.id });
    await until(() => h.turns.length === 2);
    h.turns[1]!.end({ status: "completed", text: "Fixed it." });
    await settledAs(rt, ws.id, "completed");
    const after = foldThreads(await rt.sessions.list(ws.id))[0]!;
    expect(after).toMatchObject({ lastLine: "Fixed it." });
    expect(after).not.toHaveProperty("failure");
    await rt.close();
  });

  it("a turn whose agent exited with no result says so as its failure", async () => {
    const h = endedByHand();
    const { rt, ws } = await begin(h);
    h.turns[0]!.die();
    await settledAs(rt, ws.id, "failed");
    expect(await latest(rt, ws.id)).toMatchObject({ failure: NO_RESULT_LINE });
    await rt.close();
  });

  it("a turn cut by a host restart carries the cut's reason as its failure", async () => {
    const h = endedByHand();
    const store = memoryStore();
    const backend = stubBackend();
    const { rt, ws } = await begin(h, store, backend);
    await rt.close();
    // The fake's turn names no run on its machine, so the next host has nothing to re-open and cuts it.
    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await settledAs(rt2, ws.id, "failed");
    expect(foldThreads(await rt2.sessions.list(ws.id))[0]).toMatchObject({ failure: RESTARTED_REASON });
    await rt2.close();
  });

  it("a send its sender hears refused, or whose agent fails to start while the sender waits, writes no failure on the thread", async () => {
    const h = endedByHand();
    const { rt, ws } = await begin(h);
    h.turns[0]!.end({ status: "completed", text: "Built it." });
    await settledAs(rt, ws.id, "completed");
    const thread = foldThreads(await rt.sessions.list(ws.id))[0]!;
    await expect(rt.sessions.start(ws.id, { prompt: "again", thread: thread.id, effort: "galactic" })).rejects.toThrow("galactic");
    h.refuseWith("claude: command not found\nexit 127");
    await expect(rt.sessions.start(ws.id, { prompt: "again", thread: thread.id })).rejects.toThrow("command not found");
    const after = foldThreads(await rt.sessions.list(ws.id))[0]!;
    expect(after).toMatchObject({ status: "completed", lastLine: "Built it." });
    expect(after).not.toHaveProperty("failure");
    await rt.close();
  });

  it("a folded thread lists its fold and keeps it across a host restart, and opening it clears the mark", async () => {
    const h = endedByHand();
    const store = memoryStore();
    const backend = stubBackend();
    const { rt, ws } = await begin(h, store, backend);
    h.turns[0]!.end({ status: "completed", text: "ok" });
    await settledAs(rt, ws.id, "completed");
    const thread = foldThreads(await rt.sessions.list(ws.id))[0]!;
    await rt.sessions.mark([thread.id], { folded: true }, undefined);
    const folded = foldThreads(await rt.sessions.list(ws.id))[0]!;
    expect(folded.foldedAt).toEqual(expect.any(Number));
    expect((await latest(rt, ws.id)).foldedAt).toBe(folded.foldedAt);
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect(foldThreads(await rt2.sessions.list(ws.id))[0]!.foldedAt).toBe(folded.foldedAt);
    await rt2.sessions.mark([thread.id], { folded: false }, undefined);
    expect(foldThreads(await rt2.sessions.list(ws.id))[0]).not.toHaveProperty("foldedAt");
    await rt2.close();
  });
});
