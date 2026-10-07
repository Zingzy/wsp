// SPDX-License-Identifier: AGPL-3.0-only
// A thread keeps the model, effort and context window its turns ran on. A
// start into it that names none of them, from wsp send, a child's report back
// or any other caller, runs on the thread's own latest picks rather than the
// agent's own default; anything the start names still wins. The window the
// agent announces inside the model id is read back as the window.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, copyingFake, createOn, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";

/** A harness that answers at once and keeps every start it was handed. Each turn announces the model it was asked
 * for, with the window as a suffix where it rode one, the way claude's init names "claude-opus-5-5[1m]". */
function recording(mark: string): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = `${String(starts.length).padStart(8, "0")}-${mark}-4111-8111-111111111111`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const announced = o.model === undefined ? undefined : o.contextWindow === "1m" ? `${o.model}[1m]` : o.model;
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, ...(announced !== undefined ? { model: announced } : {}) });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

const picksOf = (o: HarnessStartOptions | undefined): Record<string, string | undefined> => ({ model: o?.model, effort: o?.effort, contextWindow: o?.contextWindow });

describe("the model, effort and window a start into a thread runs on", () => {
  let root: string;
  let claude: ReturnType<typeof recording>;
  let codex: ReturnType<typeof recording>;
  let rt: Runtime;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-picks-"));
    claude = recording("1111");
    codex = recording("2222");
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: claude.adapter, codex: codex.adapter }, local });
  });
  afterEach(async () => {
    await rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  const openThread = async (o: { harness: "claude" | "codex"; model: string; effort: string; contextWindow?: string }): Promise<{ workspaceId: string; thread: string }> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(ws.id, { prompt: "one", ...o });
    await first.finished;
    return { workspaceId: ws.id, thread: first.view().threadId! };
  };

  it("a send naming none runs on the thread's model, effort and window, the window read back off the announced model", async () => {
    const { workspaceId, thread } = await openThread({ harness: "claude", model: "claude-fable-5-1", effort: "low", contextWindow: "1m" });
    expect((await rt.sessions.list(workspaceId)).at(-1)?.model).toBe("claude-fable-5-1[1m]");
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-fable-5-1", effort: "low", contextWindow: "1m" });
    // The third start reads the second's row, which is where the thread's latest picks now are.
    await (await rt.sessions.start(workspaceId, { prompt: "three", thread })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-fable-5-1", effort: "low", contextWindow: "1m" });
  });

  it("what a send names wins, and the effort it leaves out stays where the new model takes it", async () => {
    const { workspaceId, thread } = await openThread({ harness: "claude", model: "claude-fable-5-1", effort: "low", contextWindow: "1m" });
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread, effort: "max" })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-fable-5-1", effort: "max", contextWindow: "1m" });
    // Sonnet 5 takes the effort but offers no window, so the window does not ride with it.
    await (await rt.sessions.start(workspaceId, { prompt: "three", thread, model: "claude-sonnet-5" })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-sonnet-5", effort: "max", contextWindow: undefined });
    await (await rt.sessions.start(workspaceId, { prompt: "four", thread })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-sonnet-5", effort: "max", contextWindow: undefined });
  });

  it("a codex thread keeps its model and effort the same way", async () => {
    const { workspaceId, thread } = await openThread({ harness: "codex", model: "gpt-5.5", effort: "high" });
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread })).finished;
    expect(picksOf(codex.starts.at(-1))).toEqual({ model: "gpt-5.5", effort: "high", contextWindow: undefined });
  });

  it("a child's report back runs its parent's turn on the parent's own picks", async () => {
    const { workspaceId, thread } = await openThread({ harness: "codex", model: "gpt-5.5", effort: "high" });
    const child = await rt.sessions.start(workspaceId, { prompt: "build it", harness: "claude", notify: [thread] });
    await child.finished;
    await until(() => codex.starts.length === 2);
    expect(codex.starts.at(-1)?.prompt).toContain("finished");
    expect(picksOf(codex.starts.at(-1))).toEqual({ model: "gpt-5.5", effort: "high", contextWindow: undefined });
  });

  it("a thread whose rows fell off the index still sends on its model, effort and window, read off its transcript", async () => {
    const { workspaceId, thread } = await openThread({ harness: "claude", model: "claude-fable-5-1", effort: "low", contextWindow: "1m" });
    // Two hundred other threads in the same folder push the thread's one row off the workspace's 200-row index, on
    // other picks, so a value read off the wrong turn shows.
    for (let i = 0; i < 200; i++) await (await rt.sessions.start(workspaceId, { prompt: `other ${i}`, harness: "claude", model: "claude-sonnet-5", effort: "max" })).finished;
    expect((await rt.sessions.list(workspaceId)).some(s => s.threadId === thread)).toBe(false);
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-fable-5-1", effort: "low", contextWindow: "1m" });
  }, 60_000);

  it("a model the catalog dropped since the thread's last turn is left out rather than refused, and the thread's effort still rides", async () => {
    await rt.preferences.set({ agentDefaults: { claude: { models: { custom: ["claude-opus-6-preview"] } } } });
    const { workspaceId, thread } = await openThread({ harness: "claude", model: "claude-opus-6-preview", effort: "low" });
    await rt.preferences.set({ agentDefaults: { claude: { models: { custom: [] } } } });
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: undefined, effort: "low", contextWindow: undefined });
  });

  it("a thread's first turn still opens on the catalog's marks", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
    expect(picksOf(claude.starts.at(-1))).toEqual({ model: "claude-opus-5-5", effort: "high", contextWindow: undefined });
  });
});
