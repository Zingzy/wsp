// SPDX-License-Identifier: AGPL-3.0-only
// The finished lines a child sends its lead when a message is steered into the child's last words: the runtime and
// the real Claude adapter, fed the lines Claude Code 2.1.280 printed for each case (recorded 2026-10-08, trimmed to the
// fields the adapter reads), and 2.1.295 for a message a woken agent takes at a tool's end (recorded 2026-10-09). A
// turn sends each reply's line once: one held over background work goes as it is given, one held for a steered
// message alone goes at the turn's end, and a slash command's answer is never the reply.
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { stillRunningLine } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fedRuns, init, lifecycle, result, said, taskDone, tasks } from "./fed-runs.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const REPORT = "Built the parser; 40 tests pass.";
const ANSWER = "BANANA";
const LINE = "thread 1234abcd finished (completed): reply with the single word BANANA";
const COST = "Total cost:            $0.0128\nTotal duration (API):  5s";
/** A reply given over running background work, as its line carries it. */
const held = (reply: string): string => `${reply}\n\n${stillRunningLine(1)}`;
/** The end of a turn whose line promised another and had nothing to add under the reply: its outcome alone. */
const OUTCOME = expect.stringMatching(/^thread \w+ finished \(completed[^)]*\)$/);

describe("a child's finished lines into its lead, with a message steered into the child's last words", () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    for (const rt of runtimes.splice(0)) await rt.close();
  });
  const setup = async () => {
    const fed = fedRuns();
    const backend = stubBackend();
    const store = memoryStore();
    const host = (): Runtime => {
      const rt = createRuntime({ backend, store, adapters: { claude: () => createClaudeAdapter({ exec: fed.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 }) } });
      runtimes.push(rt);
      return rt;
    };
    const rt = host();
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead" });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate" });
    await until(() => fed.runOf("orchestrate") !== undefined);
    fed.runOf("orchestrate")!.push(init, said("msg_0", "waiting"), result("waiting"));
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    fed.runOf("orchestrate")!.end(0);
    await lead.finished;
    const leadThread = lead.view().threadId!;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "build the parser", notify: [leadThread] });
    await until(() => fed.runOf("build the parser") !== undefined);
    const run = fed.runOf("build the parser")!;
    run.push(init);
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.start"));
    const steer = async (prompt: string): Promise<string> => {
      expect(await rt.sessions.steer(kid.id, { prompt })).toEqual({ outcome: "accepted" });
      return fed.steered("build the parser", run.writes.length - 1);
    };
    /** The lines the child's turns sent its lead, by their words past the thread's head. */
    const toLead = async (on = rt): Promise<string[]> =>
      (await on.sessions.history(kidWs.id)).flatMap(e => (e.type === "session.notify" && e.notify === leadThread ? [e.text.replace(/^thread \w+ finished \([^)]*\): /, "")] : []));
    /** The child's turn is over on the transcript; its run is ended after, as the CLI exits once its input shuts. */
    const over = async (code: number | null = 0): Promise<void> => {
      await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done"));
      run.end(code);
      await kid.finished;
      await new Promise(r => setTimeout(r, 50));
    };
    /** The host goes down with the child's run still printing, and a second host on the same store reads it again. */
    const restart = async (): Promise<Runtime> => {
      await rt.close();
      const second = host();
      await second.sessions.list(kidWs.id);
      return second;
    };
    const endedOn = async (on: Runtime): Promise<void> => {
      await until(async () => (await on.sessions.history(kidWs.id)).some(e => e.type === "session.end"));
      await new Promise(r => setTimeout(r, 50));
    };
    return { rt, kid, run, steer, toLead, over, restart, endedOn };
  };

  it("a plain steer sends one line, the answer, and not the reply before it", async () => {
    const { run, steer, toLead, over } = await setup();
    const uuid = await steer(LINE);
    run.push(lifecycle(uuid, "queued"), said("msg_1", REPORT), result(REPORT), lifecycle(uuid, "started"), init, said("msg_2", ANSWER), result(ANSWER), lifecycle(uuid, "completed"));
    await over();
    expect(await toLead()).toEqual([ANSWER]);
  });

  it("a process that dies after the answer, before the CLI completes the message, still sends the answer's line", async () => {
    const { kid, run, steer, toLead } = await setup();
    const uuid = await steer(LINE);
    run.push(lifecycle(uuid, "queued"), said("msg_1", REPORT), result(REPORT), lifecycle(uuid, "started"), init, said("msg_2", ANSWER), result(ANSWER));
    await new Promise(r => setTimeout(r, 50));
    run.end(137);
    await kid.finished;
    await new Promise(r => setTimeout(r, 50));
    expect(await toLead()).toEqual([ANSWER]);
  });

  it("a steer into a reply held over background work sends that reply's line once and the answer's once", async () => {
    const { kid, run, steer, toLead } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const uuid = await steer(LINE);
    run.push(lifecycle(uuid, "queued"), lifecycle(uuid, "started"), init, said("msg_2", ANSWER), result(ANSWER), lifecycle(uuid, "completed"), tasks([]));
    await until(async () => (await toLead()).length === 2);
    // The CLI exits with the work done and its agent not woken again: the reply it was holding is the turn's end.
    run.end(0);
    await kid.finished;
    await new Promise(r => setTimeout(r, 50));
    expect(await toLead()).toEqual([held(REPORT), held(ANSWER), OUTCOME]);
  });

  it("the same, with the background work over before the answer: the answer's line goes at the end, once", async () => {
    const { run, steer, toLead, over } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const uuid = await steer(LINE);
    run.push(tasks([]), lifecycle(uuid, "queued"), lifecycle(uuid, "started"), init, said("msg_2", ANSWER), result(ANSWER), lifecycle(uuid, "completed"));
    await over();
    expect(await toLead()).toEqual([held(REPORT), ANSWER]);
  });

  it("a steer the woken agent takes at a tool's end, completed before its result as 2.1.295 prints it, sends the answer's line at the end, once", async () => {
    const { kid, run, steer, toLead, over } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 2));
    await until(async () => (await toLead()).length === 1);
    run.push(tasks([]), taskDone("bk1"), init);
    const uuid = await steer(LINE);
    run.push(lifecycle(uuid, "queued"), lifecycle(uuid, "started"), said("msg_2", ANSWER), lifecycle(uuid, "completed"), result(ANSWER, 2, { kind: "task-notification" }));
    await over();
    expect((await kid.finished).text).toBe(ANSWER);
    expect(await toLead()).toEqual([held(REPORT), ANSWER]);
  });

  it("/cost steered into the child's last words leaves the agent's report as the line, and the cost as a row of its own", async () => {
    const { rt, kid, run, steer, toLead, over } = await setup();
    const uuid = await steer("/cost");
    run.push(lifecycle(uuid, "queued"), said("msg_1", REPORT), result(REPORT), lifecycle(uuid, "started"), init, said("ac793b79", COST, "<synthetic>"), result(COST, 0), lifecycle(uuid, "completed"));
    await over();
    expect((await kid.finished).text).toBe(REPORT);
    expect(await toLead()).toEqual([REPORT]);
    const rows = (await rt.sessions.history(kid.view().workspaceId)).flatMap(e => (e.type === "session.delta" && e.kind === "text" ? [e.text] : []));
    expect(rows).toContain(COST);
  });

  it("/cost steered over a reply already told for its background work sends the reply no second time, only the outcome the line promised", async () => {
    const { kid, run, steer, toLead, over } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const uuid = await steer("/cost");
    run.push(tasks([]), lifecycle(uuid, "queued"), lifecycle(uuid, "started"), init, said("ac793b79", COST, "<synthetic>"), result(COST, 0), lifecycle(uuid, "completed"));
    await over();
    expect((await kid.finished).text).toBe(REPORT);
    expect(await toLead()).toEqual([held(REPORT), OUTCOME]);
  });

  it("a reply told over background work is told once across a host restart that reads its run again from the start, and its end sends the outcome", async () => {
    const { kid, run, toLead, restart, endedOn } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const second = await restart();
    // The work ends and the CLI exits without waking its agent: the reply it held, already told, is the turn's end.
    run.push(tasks([]));
    await new Promise(r => setTimeout(r, 50));
    run.end(0);
    await endedOn(second);
    expect(await toLead(second)).toEqual([held(REPORT), OUTCOME]);
    // The second host read the run to its end: a row the restart had settled would carry no done.
    expect((await second.sessions.history(kid.view().workspaceId)).filter(e => e.type === "session.done").map(e => (e.type === "session.done" ? e.result.text : ""))).toEqual([REPORT]);
  });

  it("a steer whose reply the first host held is answered once on the second, its line sent at the end", async () => {
    const { run, steer, toLead, restart, endedOn } = await setup();
    const uuid = await steer(LINE);
    run.push(lifecycle(uuid, "queued"), said("msg_1", REPORT), result(REPORT));
    await new Promise(r => setTimeout(r, 50));
    expect(await toLead()).toEqual([]);
    const second = await restart();
    run.push(lifecycle(uuid, "started"), init, said("msg_2", ANSWER), result(ANSWER), lifecycle(uuid, "completed"));
    await until(async () => (await toLead(second)).length > 0);
    run.end(0);
    await endedOn(second);
    expect(await toLead(second)).toEqual([ANSWER]);
  });
});
