// SPDX-License-Identifier: AGPL-3.0-only
// A Codex turn whose host goes while the launch's snapshot is taken: the real Codex adapter over this computer's
// runs and a stub app server that answers each turn/start with the prompt it read and how many turns it was given.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "@wsp/adapter-codex";
import type { AdapterEvent, ExecStreamFactory, TurnResult } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { localExecStream } from "../src/local-exec.js";
import { sweepStrays } from "./strays.js";
import { until } from "./until.js";

const THREAD = "019fd0aa-0000-7000-8000-000000000001";

/** The server: answers initialize at once and the thread after `threadMs`, each turn/start with one reply naming its
 * text and the count of turns it was handed, and a compaction with one saying so; exits on EOF as codex app-server does. */
const serverScript = (threadMs: number) => `#!${process.execPath}
let turns = 0;
const say = o => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") say({ id: m.id, result: {} });
  if (m.method === "thread/start") setTimeout(() => say({ id: m.id, result: { thread: { id: "${THREAD}", turns: [] } } }), ${threadMs});
  if (m.method === "turn/start") {
    turns += 1;
    const text = m.params.input[0].text;
    say({ id: m.id, result: {} });
    say({ method: "turn/started", params: { threadId: "${THREAD}", turn: { id: "turn-" + turns, items: [], status: "inProgress" } } });
    say({ method: "item/completed", params: { threadId: "${THREAD}", turnId: "turn-" + turns, item: { type: "agentMessage", id: "m" + turns, text: text + " after " + turns + " turn(s)" } } });
    say({ method: "turn/completed", params: { threadId: "${THREAD}", turn: { id: "turn-" + turns, items: [], status: "completed" } } });
  }
  if (m.method === "thread/compact/start") {
    turns += 1;
    say({ id: m.id, result: {} });
    say({ method: "turn/started", params: { threadId: "${THREAD}", turn: { id: "turn-" + turns, items: [], status: "inProgress" } } });
    say({ method: "item/completed", params: { threadId: "${THREAD}", turnId: "turn-" + turns, item: { type: "agentMessage", id: "m" + turns, text: "compacted after " + turns + " turn(s)" } } });
    say({ method: "turn/completed", params: { threadId: "${THREAD}", turn: { id: "turn-" + turns, items: [], status: "completed" } } });
  }
});
rl.on("close", () => process.exit(0));
`;

describe("a Codex turn whose host goes before its prompt is due", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-codex-held-"));
  });
  afterEach(async () => {
    // A case that failed leaves its server waiting on a turn that never comes; every run under the folder ends here.
    await localExecStream({ root, runDir: join(root, "runs") }).sweep!([]);
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  /** One host: this computer's runs read by its own readers, the Codex adapter over them running the stub server. */
  const host = (threadMs: number) => {
    const reading = new Set<() => void>();
    const exec: ExecStreamFactory = localExecStream({ root, runDir: join(root, "runs"), reading, pollMs: 20 });
    const program = writeStub(join(root, "codex"), serverScript(threadMs));
    const adapter = createCodexAdapter({ exec, home: join(root, ".codex"), login: "codex login", launch: { program } });
    return { adapter, goes: () => [...reading].forEach(stop => stop()) };
  };

  /** The next host re-opening the run as the runtime's reattach does, with the row's prompt. */
  const reopened = async (run: string, prompt = "name the files"): Promise<TurnResult> => {
    const { adapter } = host(0);
    const session = await adapter.attach!({ run, sessionId: THREAD, startedAt: Date.now(), prompt, onEvent: () => {} });
    if (session === "gone") throw new Error("the run was gone");
    return session.finished;
  };

  it("goes after the thread answered: the next host hands the held prompt over and the turn runs once", async () => {
    const first = host(0);
    const events: AdapterEvent[] = [];
    const session = first.adapter.start({ prompt: "name the files", cwd: root, promptAfter: new Promise(() => {}), onEvent: e => events.push(e) });
    await until(() => events.some(e => e.type === "session.start"));
    first.goes();
    expect(await reopened(session.run!)).toMatchObject({ status: "completed", text: "name the files after 1 turn(s)" });
  }, 20_000);

  it("goes before it read the thread's answer: the next host writes the turn off the row and it runs once", async () => {
    const first = host(300);
    const session = first.adapter.start({ prompt: "name the files", cwd: root, promptAfter: new Promise(() => {}), onEvent: () => {} });
    first.goes();
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(await reopened(session.run!)).toMatchObject({ status: "completed", text: "name the files after 1 turn(s)" });
  }, 20_000);

  it("goes before it read the thread's answer on a compaction: the next host writes the compaction, not the word as a message", async () => {
    const first = host(300);
    const session = first.adapter.start({ prompt: "/compact", cwd: root, promptAfter: new Promise(() => {}), onEvent: () => {} });
    first.goes();
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(await reopened(session.run!, "/compact")).toMatchObject({ status: "completed", text: "compacted after 1 turn(s)" });
  }, 20_000);

  it("goes after the compaction went: the next host writes no turn after it", async () => {
    const first = host(0);
    const events: AdapterEvent[] = [];
    const session = first.adapter.start({ prompt: "/compact", cwd: root, promptAfter: Promise.resolve(), onEvent: e => events.push(e) });
    await until(() => events.some(e => e.type === "turn.anchor"));
    first.goes();
    expect(await reopened(session.run!, "/compact")).toMatchObject({ status: "completed", text: "compacted after 1 turn(s)" });
  }, 20_000);

  it("goes after the prompt went: the next host writes no second turn", async () => {
    const first = host(0);
    const events: AdapterEvent[] = [];
    const session = first.adapter.start({ prompt: "name the files", cwd: root, promptAfter: Promise.resolve(), onEvent: e => events.push(e) });
    await until(() => events.some(e => e.type === "turn.anchor"));
    first.goes();
    expect(await reopened(session.run!)).toMatchObject({ status: "completed", text: "name the files after 1 turn(s)" });
  }, 20_000);
});
