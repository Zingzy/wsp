// SPDX-License-Identifier: AGPL-3.0-only
// A thread keeps the agent and the access its own rows carry. A send into it
// runs on the harness those rows ran on, whatever the request names, and a
// request naming another agent is refused before anything is started: that
// agent would resume a harness session it never wrote, at its own access. An
// access named on such a send is dropped the same way, since a thread's
// access is changed through sessions.access and by no message. A thread the
// send opens takes the request's picks whole, which is where an agent and an
// access are chosen.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, testPlatform } from "./stub-backend.js";

/** A harness that answers at once and keeps every start it was handed, one recorder per agent, so a case reads
 * which agent ran and what it ran at rather than what the request asked for. */
function recording(session: string): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId: session });
        o.onEvent({ type: "turn.done", sessionId: session, result });
        o.onEvent({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: session, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

describe("the agent and the access a send into an existing thread runs on", () => {
  let root: string;
  let claude: ReturnType<typeof recording>;
  let codex: ReturnType<typeof recording>;
  let rt: Runtime;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-keeps-"));
    claude = recording("11111111-1111-4111-8111-111111111111");
    codex = recording("22222222-2222-4222-8222-222222222222");
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
    };
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: claude.adapter, codex: codex.adapter }, local });
  });
  afterEach(async () => {
    await rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A thread opened on one agent at one access, as the person opened the read-only review thread. */
  const openThread = async (harness: "claude" | "codex", permissionMode: string): Promise<{ workspaceId: string; thread: string }> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(ws.id, { prompt: "one", harness, permissionMode });
    await first.finished;
    return { workspaceId: ws.id, thread: first.view().threadId! };
  };

  it("refuses a send naming another agent, in one sentence naming the thread's own, and starts nothing", async () => {
    const { workspaceId, thread } = await openThread("codex", "read-only");
    await expect(rt.sessions.start(workspaceId, { prompt: "two", thread, harness: "claude" })).rejects.toThrow("this thread runs on codex; open a new thread to run claude");
    // The refusal is read before anything is started, so the other agent was never launched and the thread still
    // holds the one turn it ran.
    expect(claude.starts).toEqual([]);
    expect((await rt.sessions.list(workspaceId)).map(s => s.harness)).toEqual(["codex"]);
    // The same refusal on the road that names the harness session instead of the thread, which is what the
    // command line and the MCP door send.
    const resume = codex.starts[0]!.resume ?? "22222222-2222-4222-8222-222222222222";
    await expect(rt.sessions.start(workspaceId, { prompt: "two", resume, harness: "claude" })).rejects.toThrow("this thread runs on codex");
    expect(claude.starts).toEqual([]);
  });

  it("keeps the thread's own access where a send names one, so a read-only thread stays read-only", async () => {
    const { workspaceId, thread } = await openThread("codex", "read-only");
    expect(codex.starts.at(-1)?.permissionMode).toBe("read-only");
    await (await rt.sessions.start(workspaceId, { prompt: "two", thread, permissionMode: "danger-full-access" })).finished;
    expect(codex.starts.at(-1)?.permissionMode).toBe("read-only");
    // And the thread's row says the same, which is what every client folds its access off.
    expect((await rt.sessions.list(workspaceId)).map(s => s.permissionMode)).toEqual(["read-only"]);
    // A send that names the thread's own agent is no refusal: it is the agent the thread runs on.
    await (await rt.sessions.start(workspaceId, { prompt: "three", thread, harness: "codex" })).finished;
    expect(codex.starts).toHaveLength(3);
  });

  it("runs a thread the send opens on the agent and the access that send names, which is where both are picked", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(ws.id, { prompt: "one", harness: "codex", permissionMode: "read-only" });
    await first.finished;
    // A second thread in the same workspace, on another agent at another access: neither the thread beside it nor
    // the agent the project now remembers stands in the way of the picks this start names.
    const other = await rt.sessions.start(ws.id, { prompt: "two", harness: "claude", permissionMode: "plan" });
    await other.finished;
    expect(other.view().threadId).not.toBe(first.view().threadId);
    expect(claude.starts.at(-1)?.permissionMode).toBe("plan");
    expect(codex.starts).toHaveLength(1);
  });
});
