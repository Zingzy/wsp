// SPDX-License-Identifier: AGPL-3.0-only
// A side question asked beside a thread, through the runtime: answered by the
// adapter of the thread's harness off the thread's latest row, refused in one
// sentence where there is no session to copy or the harness copies none, kept
// nowhere, and shut to a thread's own token and to a paired computer. The
// harness is a fake that answers from memory, so the runtime's own reading is
// what is under test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { ASIDE_NO_SESSION_LINE, BLANK_ASIDE_LINE, HERE_PLACE_ID, HOST_TOKEN_ENV, HOST_URL_ENV, MCP_SERVER_NAME, SCOPED_MCP_ARG, asideUnsupportedLine, deviceHeldRefusal, threadOpRefusal, type AsideQuestion, type ExecStream, type ExecStreamFactory, type TurnResult } from "@wsp/protocol";
import { createRuntime, serveRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime, type RuntimeServer } from "../src/index.js";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, copyingFake, createOn, testPlatform } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

const SESSION = "33333333-3333-4333-8333-333333333333";
const ANSWER = "You are in /root/b and last asked for the second thing.";

/** A harness whose every turn announces the same session, each at a folder and model of its own, and replies at once.
 * `announce: false` dies before it announces any; `aside: false` has no side question. */
function answering(asked: AsideQuestion[], o: { announce?: boolean; aside?: boolean; compacts?: string } = {}): HarnessAdapterFactory {
  let turns = 0;
  return () => ({
    steers: false,
    ...(o.compacts !== undefined ? { compacts: o.compacts } : {}),
    start: ({ onEvent }) => {
      turns += 1;
      const at = turns === 1 ? { cwd: "/root/a", model: "claude-opus-5" } : { cwd: "/root/b", model: "claude-sonnet-5" };
      const result: TurnResult = o.announce === false ? { status: "failed", error: "claude exited with code 1 before it answered" } : { status: "completed", text: "done" };
      const finished = Promise.resolve().then(() => {
        if (o.announce !== false) onEvent({ type: "session.start", sessionId: SESSION, ...at });
        onEvent({ type: "turn.done", sessionId: SESSION, result });
        onEvent({ type: "session.end", sessionId: SESSION, exitCode: o.announce === false ? 1 : 0, sawResult: o.announce !== false });
        return result;
      });
      return { localId: SESSION, finished, interrupt: async () => {} };
    },
    ...(o.aside === false
      ? {}
      : {
          aside: async (q: AsideQuestion) => {
            asked.push(q);
            return { text: ANSWER };
          },
        }),
  });
}

describe("a side question beside a thread", () => {
  let root: string;
  let asked: AsideQuestion[];
  let localWiring: LocalWiring;
  let rt: Runtime;
  let srv: RuntimeServer | undefined;
  const clients: WsClient[] = [];

  const runtime = (adapter: HarnessAdapterFactory): Runtime => createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local: localWiring });

  /** A thread of two finished turns on the one local workspace; answers the first turn's row id and the workspace. */
  const twoTurns = async (): Promise<{ first: string; workspaceId: string }> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(ws.id, { prompt: "the first thing" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { prompt: "the second thing", thread: first.view().threadId })).finished;
    return { first: first.id, workspaceId: ws.id };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-aside-"));
    asked = [];
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await srv?.close();
    srv = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("is answered by the thread's harness off its latest row, and nothing of it is kept", async () => {
    rt = runtime(answering(asked));
    const { first, workspaceId } = await twoTurns();
    const history = await rt.sessions.history(workspaceId);
    const rows = await rt.sessions.list(workspaceId);

    expect(await rt.sessions.aside(first, "what did I last ask?")).toEqual({ text: ANSWER });
    // The row named is the thread's first; the question goes at the latest one's folder and model.
    expect(asked).toEqual([{ session: SESSION, question: "what did I last ask?", cwd: "/root/b", model: "claude-sonnet-5" }]);
    expect(await rt.sessions.history(workspaceId)).toEqual(history);
    expect(await rt.sessions.list(workspaceId)).toEqual(rows);
  });

  it("hands the side question the wsp server and the host pair a turn of the thread gets, and takes the token back once it is answered", async () => {
    const wspMcp = { command: "node", args: ["/opt/wsp/dist/bin.js", "mcp"] };
    const seen: { question: AsideQuestion; env: Readonly<Record<string, string>>; devices: number }[] = [];
    const factory: HarnessAdapterFactory = ctx => ({
      ...answering(asked)(ctx),
      mcpServers: true,
      asideServers: true,
      aside: async (q: AsideQuestion) => {
        seen.push({ question: q, env: { ...ctx.env }, devices: (await rt.devices.list()).length });
        return { text: ANSWER };
      },
    });
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, local: localWiring, agents: { here: { url: "http://127.0.0.1:4801" }, wspMcp } });
    const { first } = await twoTurns();
    // The turns' own tokens are taken back as their processes end, so what stands now is the side question's alone.
    await expect.poll(async () => (await rt.devices.list()).length).toBe(0);

    expect(await rt.sessions.aside(first, "what did I last ask?")).toEqual({ text: ANSWER });
    // The copy resumes a session that announced the wsp server's instructions; a fork without that server is told
    // it disconnected, and the answer opens on it.
    expect(seen[0]!.question.mcpServers).toEqual({ [MCP_SERVER_NAME]: { ...wspMcp, args: [...wspMcp.args, SCOPED_MCP_ARG] } });
    // The scoped server refuses to start without the pair, which would read as the same disconnection.
    expect(seen[0]!.env[HOST_URL_ENV]).toBe("http://127.0.0.1:4801");
    expect(seen[0]!.env[HOST_TOKEN_ENV]).toMatch(/\S/);
    expect(seen[0]!.devices).toBe(1);
    expect(await rt.devices.list()).toEqual([]);
  });

  it("hands a Codex side question no token: its fork loads no server to dial with one, and it can run read-only commands", async () => {
    const wspMcp = { command: "node", args: ["/opt/wsp/dist/bin.js", "mcp"] };
    const launched: { env: Record<string, string>; devices: Promise<number> }[] = [];
    // The real Codex adapter, its declarations and its side question as they ship; only the turn is a fake, and the
    // side question's app server answers nothing, so the ask rejects once its environment is read.
    const silent: ExecStreamFactory = (_command, { env }) => {
      launched.push({ env: { ...env }, devices: rt.devices.list().then(d => d.length) });
      const stream: ExecStream = { lines: (async function* () {})(), teardown: () => {}, kill: () => {}, write: async () => "written" as const, closeInput: () => {}, exited: Promise.resolve(1) };
      return stream;
    };
    const codex: HarnessAdapterFactory = ctx => ({ ...HARNESS_ADAPTERS.codex({ ...ctx, execStream: silent }), start: answering(asked)(ctx).start });
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { codex }, local: localWiring, agents: { here: { url: "http://127.0.0.1:4801" }, wspMcp } });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const turn = await rt.sessions.start(ws.id, { prompt: "the first thing", harness: "codex" });
    await turn.finished;
    await expect.poll(async () => (await rt.devices.list()).length).toBe(0);

    await expect(rt.sessions.aside(turn.id, "what did I last ask?")).rejects.toThrow();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.env[HOST_TOKEN_ENV]).toBeUndefined();
    expect(launched[0]!.env[HOST_URL_ENV]).toBeUndefined();
    expect(await launched[0]!.devices).toBe(0);
  });

  it("tells the composer the harness takes one, and not for a harness without it", async () => {
    rt = runtime(answering(asked));
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")?.asides).toBe(true);
    const bare = runtime(answering(asked, { aside: false }));
    const other = await createOn(bare, { on: HERE_PLACE_ID, name: "mac-2" });
    expect((await bare.harnesses.list(other.id)).find(c => c.harness === "claude")?.asides).toBe(false);
  });

  it("tells the composer the message that compacts the harness's thread, the adapter's own, and nothing where it has none", async () => {
    rt = runtime(answering(asked, { compacts: "/compact" }));
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")?.compacts).toBe("/compact");
    const bare = runtime(answering(asked));
    const other = await createOn(bare, { on: HERE_PLACE_ID, name: "mac-2" });
    expect((await bare.harnesses.list(other.id)).find(c => c.harness === "claude")?.compacts).toBeUndefined();
  });

  it("refuses a thread whose harness never announced a session, a harness with no side question, and no words", async () => {
    rt = runtime(answering(asked, { announce: false }));
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const dead = await rt.sessions.start(ws.id, { prompt: "hi" });
    await dead.finished;
    await expect(rt.sessions.aside(dead.id, "anyone there?")).rejects.toThrow(ASIDE_NO_SESSION_LINE);

    rt = runtime(answering(asked, { aside: false }));
    const { first } = await twoTurns();
    await expect(rt.sessions.aside(first, "anyone there?")).rejects.toThrow(asideUnsupportedLine("claude"));

    rt = runtime(answering(asked));
    const again = await twoTurns();
    await expect(rt.sessions.aside(again.first, "   ")).rejects.toThrow(BLANK_ASIDE_LINE);
    await expect(rt.sessions.aside("sess_nothing", "hi")).rejects.toMatchObject({ kind: "not-found" });
    expect(asked).toEqual([]);
  });

  it("is refused under a thread's own token and to a paired computer, and answered for the person's own window", async () => {
    rt = runtime(answering(asked));
    const { first } = await twoTurns();
    srv = await serveRuntime(rt, { port: 0, authToken: "t", devices: rt.devices });
    const connect = async (token: string): Promise<WsClient> => {
      const c = await WsClient.connect(srv!.port, { token });
      clients.push(c);
      return c;
    };
    const thread = (await rt.devices.mint("thread t1", { kind: "thread", threadId: "t1", workspaceId: "w1", rootThreadId: "t1" }, Date.now())).deviceToken;
    expect(await (await connect(thread)).request("sessions.aside", { sessionId: first, question: "what did I ask?" })).toMatchObject({ ok: false, error: threadOpRefusal("sessions.aside", "t1") });
    const paired = (await rt.devices.admit("phone", Date.now())).deviceToken;
    expect(await (await connect(paired)).request("sessions.aside", { sessionId: first, question: "what did I ask?" })).toMatchObject({ ok: false, error: deviceHeldRefusal("sessions.aside") });
    expect(asked).toEqual([]);

    expect(await (await connect("t")).request("sessions.aside", { sessionId: first, question: "what did I ask?" })).toMatchObject({ ok: true, text: ANSWER });
    expect(asked).toHaveLength(1);
  });
});
