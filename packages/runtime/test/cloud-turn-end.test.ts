// SPDX-License-Identifier: AGPL-3.0-only
// A cloud thread's turn after its agent's final reply, driven end to end: the real Claude adapter, the cloud road's
// machineExecStream and its launch script, run by a real bash on this computer standing for the machine, with a
// stand-in `claude` on PATH that prints what the 2.1.280 CLI prints. Only the commands that touch the run's folder
// reach bash; the rest of the runtime's guest commands get the stub's answers.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult } from "@wsp/engine";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { memoryStore, type Store } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { LINUX_SHELL_PRELUDE } from "./linux-shell.js";
import { until } from "./until.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { backgroundTasksLine, stillRunningLine } from "@wsp/protocol";

/** What the CLI prints for a turn whose agent ran one command and replied, measured on 2.1.280. Past `plain`, the
 * agent replies with a task in the CLI's own set of background tasks, as it reports one it moved there
 * (run_in_background, or a foreground call past its timeout, which the CLI moves to the background itself), and the
 * CLI waits on it with its input still open: in `bg` it never ends, in `quiet` it ends past the idle limit and the CLI
 * does not wake the agent, in `wake` it ends past the idle limit and the CLI wakes the agent, which replies again, and in
 * `steer` a message steered in wakes the agent, whose process then dies before it replies. In `stop` a message steered
 * in wakes the agent, which starts on it and is stopped before it replies, the stop ending the process. In `left` the
 * process ends a second after the reply with the task still in its set, nobody woken. */
const FAKE_CLAUDE = `#!/bin/bash
sid=""
prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
here=$(dirname "$0")
mode=$(cat "$here/mode")
read -r first
say() { printf '%s\\n' "$1"; }
say '{"type":"system","subtype":"init","cwd":"/root","session_id":"'"$sid"'","tools":["Bash"],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions"}'
if [ "$mode" != "plain" ]; then
  say '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bk1","task_type":"local_bash","description":"pnpm exec vitest run"}],"session_id":"'"$sid"'"}'
  say '{"type":"system","subtype":"task_started","task_id":"bk1","tool_use_id":"toolu_1","description":"pnpm exec vitest run","is_backgrounded":true,"task_type":"local_bash","session_id":"'"$sid"'"}'
fi
say '{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Pushed and reported."}],"usage":{"input_tokens":10,"output_tokens":5}},"parent_tool_use_id":null,"session_id":"'"$sid"'"}'
say '{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"num_turns":3,"result":"Pushed and reported.","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5},"session_id":"'"$sid"'"}'
# What the agent left behind, each holding the run's output (the log) open and outliving this process: one in the
# run's process group, as a test worker is, and one in a session of its own, as a server started with setsid is.
# Neither does any work.
sleep 600 &
setsid sleep 601 &
echo $! > "$here/escaped.pid"
# The CLI reads its input until EOF and exits; with a background task in its set it waits on that task first.
if [ "$mode" = "bg" ]; then wait; fi
if [ "$mode" = "steer" ] || [ "$mode" = "stop" ]; then
  read -r steered
  say '{"type":"system","subtype":"init","cwd":"/root","session_id":"'"$sid"'","tools":["Bash"],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions"}'
  [ "$mode" = "steer" ] && exit 1
  say '{"type":"assistant","message":{"id":"msg_3","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Looking at the flaky test."}],"usage":{"input_tokens":4,"output_tokens":5}},"parent_tool_use_id":null,"session_id":"'"$sid"'"}'
  sleep 600
fi
if [ "$mode" = "left" ]; then sleep 1; exit 0; fi
if [ "$mode" = "quiet" ] || [ "$mode" = "wake" ]; then
  sleep 4
  say '{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"'"$sid"'"}'
  say '{"type":"system","subtype":"task_notification","task_id":"bk1","tool_use_id":"toolu_1","status":"completed","summary":"Background command completed (exit code 0)","session_id":"'"$sid"'"}'
fi
if [ "$mode" = "wake" ]; then
  say '{"type":"system","subtype":"init","cwd":"/root","session_id":"'"$sid"'","tools":["Bash"],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions"}'
  say '{"type":"assistant","message":{"id":"msg_2","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"The tests passed."}],"usage":{"input_tokens":4,"output_tokens":5}},"parent_tool_use_id":null,"session_id":"'"$sid"'"}'
  say '{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"num_turns":1,"result":"The tests passed.","total_cost_usd":0.01,"usage":{"input_tokens":4,"output_tokens":5},"session_id":"'"$sid"'"}'
fi
cat > /dev/null
exit 0
`;

/** One command on the stand-in machine, as the daemon's exec runs it: bash -c, the bytes on stdin, answered once the
 * command exited and both its pipes closed. */
function bash(cmd: string, path: string, shim?: string, stdin?: Uint8Array): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn("bash", ["-c", cmd], { env: { ...process.env, PATH: path, ...(shim !== undefined ? { BASH_ENV: shim } : {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += String(d)));
    child.stderr.on("data", d => (stderr += String(d)));
    child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin === undefined ? undefined : Buffer.from(stdin));
  });
}

describe("a cloud turn after its agent's final reply", () => {
  let dir: string;
  let bin: string;
  let runDir: string;
  let store: Store;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-cloud-end-"));
    bin = join(dir, "bin");
    runDir = join(dir, "run");
    mkdirSync(bin);
    mkdirSync(runDir);
    writeStub(join(bin, "claude"), FAKE_CLAUDE);
    const backend = stubBackend();
    const answer = backend.execImpl;
    const path = process.env["PATH"] ?? "/usr/bin:/bin";
    // Read by every bash the run starts, and gives this computer the machine's setsid. The machine's project folder is not on this computer, so the launch's cd lands
    // in the test's own folder; and the launch exports the turn's own PATH, so the stand-in is named by a function,
    // which wins over any claude on that PATH.
    const shim = join(dir, "env.sh");
    writeFileSync(shim, `${LINUX_SHELL_PRELUDE}cd() { builtin cd ${dir}; }\nclaude() { ${join(bin, "claude")} "$@"; }\n`);
    backend.execImpl = (m, cmd, stdin) => (cmd.includes(runDir) ? bash(cmd, path, shim, stdin) : answer(m, cmd, stdin));
    store = memoryStore();
    // The idle limit short, so a turn nothing holds is cut in seconds, as it is at TURN_IDLE_MS on a real machine.
    rt = createRuntime({ backend, store, adapters: { claude: HARNESS_ADAPTERS.claude }, machineExec: { pollMs: 100, idleMs: 3_000, runDir } });
  });

  afterEach(async () => {
    await rt.close();
    // A run the closed runtime let go of is still on the stand-in machine: its group goes here, as a sweep would take it.
    await bash(`for f in ${runDir}/*.pid; do kill -KILL -- -$(cat "$f") 2>/dev/null; done; kill -KILL $(cat ${bin}/escaped.pid) 2>/dev/null; true`, "/usr/bin:/bin");
    rmSync(dir, { recursive: true, force: true });
  });

  const turn = async (mode: "plain" | "bg" | "quiet" | "wake" | "steer" | "stop" | "left") => {
    writeFileSync(join(bin, "mode"), mode);
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    const handle = await rt.sessions.start(ws.id, { prompt: "build the ticket", notify: ["me"] });
    return { ws, handle, threadId: handle.view().threadId! };
  };
  const notified = async (wsId: string, threadId: string) => (await rt.sessions.history(wsId)).filter(e => e.type === "session.notify" && e.threadId === threadId);
  const lines = async (wsId: string, threadId: string) => (await notified(wsId, threadId)).map(e => (e.type === "session.notify" ? e.text : ""));
  /** Past the idle limit, which cuts a turn nothing holds. */
  const pastIdle = (): Promise<void> => new Promise(r => setTimeout(r, 4_000));

  it("with a child it left holding the run's output open, the agent's exit ends the turn: completed, and the finished line goes out", async () => {
    const { ws, handle, threadId } = await turn("plain");
    await until(async () => (await notified(ws.id, threadId)).length === 1, 15_000);
    await handle.finished;
    expect(handle.view().status).toBe("completed");
  }, 30_000);

  it("with the CLI still reporting a background task that never ends, the reply's finished line goes out within seconds and the task holds the turn", async () => {
    const { ws, handle, threadId } = await turn("bg");
    const at = Date.now();
    await until(async () => (await notified(ws.id, threadId)).length === 1, 5_000);
    const tookMs = Date.now() - at;
    await pastIdle();
    expect({ tookMs: tookMs < 3_000, status: handle.view().status, lines: await lines(ws.id, threadId) }).toEqual({ tookMs: true, status: "running", lines: [expect.stringMatching(/finished \(completed[^)]*\): 1 background task still running; another line comes when this turn ends$/)] });
  }, 30_000);

  it("woken by its task after the held reply, the agent's new reply sends a second line, and the end sends no third", async () => {
    const { ws, handle, threadId } = await turn("wake");
    await until(async () => (await notified(ws.id, threadId)).length === 1, 5_000);
    expect(handle.view().status).toBe("running");
    await handle.finished;
    expect({ status: handle.view().status, lines: await lines(ws.id, threadId) }).toEqual({
      status: "completed",
      lines: [expect.stringContaining(stillRunningLine(1)), expect.stringMatching(/finished \(completed[^)]*\): The tests passed\.$/)],
    });
  }, 30_000);

  it("with its task ended and the agent not woken, the end sends a second line saying how the task ended, and not the reply's words again", async () => {
    const { ws, handle, threadId } = await turn("quiet");
    await until(async () => (await notified(ws.id, threadId)).length === 1, 5_000);
    await handle.finished;
    expect({ status: handle.view().status, lines: await lines(ws.id, threadId) }).toEqual({
      status: "completed",
      lines: [expect.stringContaining(stillRunningLine(1)), expect.stringMatching(/finished \(completed[^)]*\): `pnpm exec vitest run` completed, [\d.]+m?s after the reply$/)],
    });
  }, 30_000);

  it("ended with its task still running and nobody woken, the end sends a second line saying the task was left running", async () => {
    const { ws, handle, threadId } = await turn("left");
    await handle.finished;
    expect({ status: handle.view().status, lines: await lines(ws.id, threadId) }).toEqual({
      status: "completed",
      lines: [expect.stringContaining(stillRunningLine(1)), expect.stringMatching(new RegExp(`finished \\(completed[^)]*\\): ${backgroundTasksLine(1)}$`))],
    });
  }, 30_000);

  it("a message steered into the held turn wakes the agent, and when it is cut before replying, its failed line goes out", async () => {
    const { ws, handle, threadId } = await turn("steer");
    await until(async () => (await notified(ws.id, threadId)).length === 1, 5_000);
    const steered = await rt.sessions.start(ws.id, { prompt: "also fix the flaky test", thread: threadId });
    expect(steered.outcome).toBe("steered");
    await handle.finished;
    expect({ status: handle.view().status, lines: await lines(ws.id, threadId) }).toEqual({
      status: "failed",
      lines: [expect.stringContaining(stillRunningLine(1)), expect.stringContaining("finished (failed")],
    });
  }, 30_000);

  it("stopped well after the held reply's line, with nothing woken, the lead is told the stop once, timed to the stop, and not the reply's words again", async () => {
    const { ws, handle, threadId } = await turn("bg");
    await until(async () => (await notified(ws.id, threadId)).length === 1, 5_000);
    await new Promise(r => setTimeout(r, 3_000));
    expect((await rt.sessions.interrupt(handle.id)).outcome).toBe("accepted");
    const told = await lines(ws.id, threadId);
    expect({ status: handle.view().status, lines: told }).toEqual({
      status: "interrupted",
      lines: [expect.stringContaining(`finished (completed, 1.2s, $0.01): ${stillRunningLine(1)}`), expect.stringMatching(/finished \(interrupted, [\d.]+s, \$0\.01\)$/)],
    });
    // The CLI timed the reply at 1.2 s; the stop came at least 3 s after the reply's line went.
    expect(Number(/interrupted, ([\d.]+)s/.exec(told[1]!)![1])).toBeGreaterThanOrEqual(4.2);
  }, 30_000);

  it("stopped after a steer woke the agent under the held reply, before it replied, the lead is told the stop once and not the reply's words again", async () => {
    const { ws, handle, threadId } = await turn("stop");
    await until(async () => (await notified(ws.id, threadId)).length === 1, 5_000);
    expect((await rt.sessions.start(ws.id, { prompt: "also fix the flaky test", thread: threadId })).outcome).toBe("steered");
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.delta" && e.text === "Looking at the flaky test."), 5_000);
    expect((await rt.sessions.interrupt(handle.id)).outcome).toBe("accepted");
    expect({ status: handle.view().status, lines: await lines(ws.id, threadId) }).toEqual({
      status: "interrupted",
      lines: [expect.stringContaining(stillRunningLine(1)), expect.stringMatching(/finished \(interrupted[^)]*\)$/)],
    });
  }, 30_000);
});
