// SPDX-License-Identifier: AGPL-3.0-only
// The finished lines a child sends its lead when a message is steered into the child's last words: the runtime and
// the real Claude adapter, fed the lines Claude Code 2.1.280 printed for each case (recorded 2026-10-08, trimmed to the
// fields the adapter reads). A turn sends each reply's line once: one held over background work goes as it is given,
// one held for a steered message alone goes at the turn's end, and a slash command's answer is never the reply.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const SID = "e16ed170-8257-4668-879e-fe836341633c";
const REPORT = "Built the parser; 40 tests pass.";
const ANSWER = "BANANA";
const LINE = "thread 1234abcd finished (completed): reply with the single word BANANA";

const init = JSON.stringify({ type: "system", subtype: "init", cwd: "/work", session_id: SID, tools: ["Bash"], model: "claude-haiku-4-5-20251001", claude_code_version: "2.1.280", capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"] });
const said = (id: string, text: string, model = "claude-haiku-4-5-20251001"): string =>
  JSON.stringify({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 300 } }, parent_tool_use_id: null, session_id: SID });
const result = (text: string, turns = 1): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 4000, num_turns: turns, result: text, session_id: SID, total_cost_usd: 0.0128, usage: { input_tokens: 10, output_tokens: 300 } });
const lifecycle = (uuid: string, state: string): string => JSON.stringify({ type: "command_lifecycle", command_uuid: uuid, state, session_id: SID });
const tasks = (ids: readonly string[]): string =>
  JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: ids.map(id => ({ task_id: id, task_type: "local_bash", description: "pnpm exec vitest run" })), session_id: SID });
const COST = "Total cost:            $0.0128\nTotal duration (API):  5s";

/** Every run the adapter launches, fed by hand: its opening line, the lines written into it, and its output. An
 * attach after a host restart reads the run's output again from its first line and the lines it took, as the run's log
 * and channel are read back on a machine. */
function fedRuns() {
  type Run = { id: string; opening: string; writes: string[]; log: string[]; feed: (line: string) => void; end: (code: number | null) => void };
  const runs: (Run & { push: (...lines: string[]) => void })[] = [];
  const stream = (run: Pick<Run, "id" | "writes">, replay: readonly string[], taken?: readonly string[]): { stream: ExecStream; feed: (line: string) => void; end: (code: number | null) => void } => {
    const queue = [...replay];
    let wake: (() => void) | null = null;
    let ended = false;
    let end: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      end = code => {
        ended = true;
        resolve(code);
        wake?.();
      };
    });
    const feed = (line: string): void => {
      queue.push(line);
      wake?.();
    };
    return {
      feed,
      end: code => end(code),
      stream: {
        lines: (async function* () {
          for (;;) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            if (ended) return;
            await new Promise<void>(resolve => (wake = resolve));
            wake = null;
          }
        })(),
        exited,
        run: run.id,
        teardown: () => end(143),
        kill: () => end(null),
        write: async line => {
          run.writes.push(line);
          return "written";
        },
        closeInput: () => {},
        ...(taken !== undefined ? { taken } : {}),
      },
    };
  };
  const factory = Object.assign(
    (_command: string, o: { input?: readonly string[] }) => {
      const run = { id: `/tmp/wsp-run/${randomBytes(6).toString("hex")}`, opening: o.input?.[0] ?? "", writes: [] as string[], log: [] as string[] };
      const opened = stream(run, []);
      const entry = { ...run, feed: opened.feed, end: opened.end, push: (...lines: string[]) => lines.forEach(line => (entry.log.push(line), entry.feed(line))) };
      runs.push(entry);
      return opened.stream;
    },
    {
      attach: async (id: string) => {
        const run = runs.find(r => r.id === id);
        if (run === undefined) return "gone" as const;
        const reopened = stream(run, run.log, [run.opening, ...run.writes]);
        run.feed = reopened.feed;
        run.end = reopened.end;
        return reopened.stream;
      },
    },
  ) as ExecStreamFactory;
  const runOf = (words: string) => runs.find(r => r.opening.includes(words));
  /** The id the nth message steered into a run went under. */
  const steered = (words: string, n = 0): string => (JSON.parse(runOf(words)!.writes[n]!) as { uuid: string }).uuid;
  return { factory, runs, runOf, steered };
}

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
    expect(await toLead()).toEqual([REPORT, ANSWER]);
  });

  it("the same, with the background work over before the answer: the answer's line goes at the end, once", async () => {
    const { run, steer, toLead, over } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const uuid = await steer(LINE);
    run.push(tasks([]), lifecycle(uuid, "queued"), lifecycle(uuid, "started"), init, said("msg_2", ANSWER), result(ANSWER), lifecycle(uuid, "completed"));
    await over();
    expect(await toLead()).toEqual([REPORT, ANSWER]);
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

  it("/cost steered over a reply already told for its background work sends no second line", async () => {
    const { kid, run, steer, toLead, over } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const uuid = await steer("/cost");
    run.push(tasks([]), lifecycle(uuid, "queued"), lifecycle(uuid, "started"), init, said("ac793b79", COST, "<synthetic>"), result(COST, 0), lifecycle(uuid, "completed"));
    await over();
    expect((await kid.finished).text).toBe(REPORT);
    expect(await toLead()).toEqual([REPORT]);
  });

  it("a reply told over background work is told once across a host restart that reads its run again from the start", async () => {
    const { kid, run, toLead, restart, endedOn } = await setup();
    run.push(tasks(["bk1"]), said("msg_1", REPORT), result(REPORT, 3));
    await until(async () => (await toLead()).length === 1);
    const second = await restart();
    // The work ends and the CLI exits without waking its agent: the reply it held, already told, is the turn's end.
    run.push(tasks([]));
    await new Promise(r => setTimeout(r, 50));
    run.end(0);
    await endedOn(second);
    expect(await toLead(second)).toEqual([REPORT]);
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
