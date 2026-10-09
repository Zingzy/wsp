// SPDX-License-Identifier: AGPL-3.0-only
// Runs of the real Claude adapter fed by hand, with the lines Claude Code 2.1.280 printed (recorded 2026-10-08,
// trimmed to the fields the adapter reads) and the task line and result origin 2.1.295 printed (recorded 2026-10-09).
import { randomBytes } from "node:crypto";
import { MachineUnreached } from "@wsp/engine";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";

export const SID = "e16ed170-8257-4668-879e-fe836341633c";

export const init = JSON.stringify({ type: "system", subtype: "init", cwd: "/work", session_id: SID, tools: ["Bash"], model: "claude-haiku-4-5-20251001", claude_code_version: "2.1.280", capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"] });
export const said = (id: string, text: string, model = "claude-haiku-4-5-20251001"): string =>
  JSON.stringify({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 300 } }, parent_tool_use_id: null, session_id: SID });
export const result = (text: string, turns = 1, origin?: { kind: string }): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 4000, num_turns: turns, result: text, session_id: SID, total_cost_usd: 0.0128, usage: { input_tokens: 10, output_tokens: 300 }, ...(origin !== undefined ? { origin } : {}) });
export const lifecycle = (uuid: string, state: string): string => JSON.stringify({ type: "command_lifecycle", command_uuid: uuid, state, session_id: SID });
export const tasks = (ids: readonly string[]): string =>
  JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: ids.map(id => ({ task_id: id, task_type: "local_bash", description: "pnpm exec vitest run" })), session_id: SID });
export const taskDone = (id: string): string => JSON.stringify({ type: "system", subtype: "task_notification", task_id: id, status: "completed", session_id: SID });

/** What a box's write says when nothing came back after the append, landed or not. */
export const WRITE_LOST = "remote write failed on m1: nothing came back saying WSP_OK, the word the guest prints once the message landed; the machine did not answer";
/** What a box's launch fails with when its posts were sent and the machine never answered again: the class says the
 * computer did not answer. */
export const launchLost = (): Error => new MachineUnreached(12, 61_000, new Error("machine.exec on lab-box was not answered in 35s"));

/** Every run the adapter launches, fed by hand: its opening line, the lines written into it, and its output. An
 * attach after a host restart reads the run's output again from its first line and the lines it took, as the run's log
 * and channel are read back on a machine. A run's next write can lose its answer, after the line landed or before, a
 * write can wait on a gate before it lands, and a run can fail the way a launch on a machine fails once its start has
 * answered, with the error the launch threw. */
export function fedRuns() {
  type Run = { id: string; opening: string; env: Readonly<Record<string, string>>; writes: string[]; log: string[]; loses?: "landed" | "lost"; gate?: Promise<void>; feed: (line: string) => void; end: (code: number | null) => void; fail: (e: string | Error) => void };
  const runs: (Run & { push: (...lines: string[]) => void })[] = [];
  const stream = (run: Pick<Run, "id" | "writes" | "loses" | "gate">, replay: readonly string[], taken?: readonly string[]): { stream: ExecStream; feed: (line: string) => void; end: (code: number | null) => void; fail: (e: string | Error) => void } => {
    const queue = [...replay];
    let wake: (() => void) | null = null;
    let ended = false;
    let failed: Error | undefined;
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
      fail: e => {
        failed = typeof e === "string" ? new Error(e) : e;
        end(null);
      },
      stream: {
        lines: (async function* () {
          for (;;) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            if (failed !== undefined) throw failed;
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
          if (run.gate !== undefined) await run.gate;
          const loses = run.loses;
          delete run.loses;
          if (loses !== "lost") run.writes.push(line);
          if (loses !== undefined) throw new Error(WRITE_LOST);
          return "written";
        },
        closeInput: () => {},
        ...(taken !== undefined ? { taken } : {}),
      },
    };
  };
  const factory = Object.assign(
    (_command: string, o: { env: Readonly<Record<string, string>>; input?: readonly string[] }) => {
      const entry: Run & { push: (...lines: string[]) => void } = {
        id: `/tmp/wsp-run/${randomBytes(6).toString("hex")}`,
        opening: o.input?.[0] ?? "",
        env: o.env,
        writes: [],
        log: [],
        feed: () => {},
        end: () => {},
        fail: () => {},
        push: (...lines: string[]) => lines.forEach(line => (entry.log.push(line), entry.feed(line))),
      };
      const opened = stream(entry, []);
      Object.assign(entry, { feed: opened.feed, end: opened.end, fail: opened.fail });
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
        run.fail = reopened.fail;
        return reopened.stream;
      },
    },
  ) as ExecStreamFactory;
  const runOf = (words: string) => runs.find(r => r.opening.includes(words));
  /** Every run whose opening carries these words, in launch order. */
  const runsOf = (words: string) => runs.filter(r => r.opening.includes(words));
  /** The id the nth message steered into a run went under. */
  const steered = (words: string, n = 0): string => (JSON.parse(runOf(words)!.writes[n]!) as { uuid: string }).uuid;
  return { factory, runs, runOf, runsOf, steered };
}
