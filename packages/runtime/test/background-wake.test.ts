// SPDX-License-Identifier: AGPL-3.0-only
// A turn whose agent replied while work it started in the background still ran,
// driven end to end: the runtime, the Claude adapter and a real process on this
// computer, with a stand-in for the CLI that prints the lines Claude Code 2.1.280
// printed in print mode (measured 2026-09-27 on a Linux machine). When the work
// ends the CLI wakes its agent itself: a fresh init, then nothing until the woken
// agent's first message, which a foreground command or a long think keeps off the
// stream for as long as it takes.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, backgroundTasksLine, notifyTail } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";

/** How long the adapter waits on a silent CLI once a held reply's tasks are done; the stand-in's woken agent says
 * nothing for four times as long. */
const WINDOW_MS = 250;

/** The stand-in `claude`: the agent puts the gate in the background and replies, the gate ends, the CLI wakes the
 * agent, and the woken agent runs a foreground command for `silentS` seconds before it replies. `mark` is touched
 * when the wake's init is out, so a case knows the silence has begun. Any other call (the catalog probe, a title)
 * answers nothing. */
function standIn(mark: string, silentS: number): string {
  return `#!/bin/sh
for a; do [ "$prev" = --session-id ] && sid=$a; prev=$a; done
[ -n "$sid" ] || exit 0
read -r _
cat <<EOF
{"type":"system","subtype":"init","cwd":"$PWD","session_id":"$sid","tools":["Bash"],"model":"claude-opus-5-5"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pnpm test","run_in_background":true}}]},"parent_tool_use_id":null,"session_id":"$sid"}
{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"pnpm test"}],"session_id":"$sid"}
{"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_1","description":"pnpm test","is_backgrounded":true,"task_type":"local_bash","session_id":"$sid"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"Command running in background with ID: b1. You will be notified when it completes.","is_error":false}]},"parent_tool_use_id":null,"session_id":"$sid"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_2","type":"message","role":"assistant","content":[{"type":"text","text":"Waiting on the gate."}]},"parent_tool_use_id":null,"session_id":"$sid"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4000,"total_cost_usd":0.1,"result":"Waiting on the gate.","num_turns":2,"result_index":0,"session_id":"$sid","usage":{"input_tokens":4,"output_tokens":90}}
EOF
sleep 0.3
cat <<EOF
{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"$sid"}
{"type":"system","subtype":"task_updated","task_id":"b1","patch":{"status":"completed"},"session_id":"$sid"}
{"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"toolu_1","status":"completed","summary":"Background command completed (exit code 0)","session_id":"$sid"}
{"type":"system","subtype":"init","cwd":"$PWD","session_id":"$sid","tools":["Bash"],"model":"claude-opus-5-5"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_3","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"git push"}}]},"parent_tool_use_id":null,"session_id":"$sid"}
EOF
touch '${mark}'
sleep ${silentS}
cat <<EOF
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"pushed","is_error":false}]},"parent_tool_use_id":null,"session_id":"$sid"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_4","type":"message","role":"assistant","content":[{"type":"text","text":"The gate passed and the branch is pushed."}]},"parent_tool_use_id":null,"session_id":"$sid"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"total_cost_usd":0.3,"result":"The gate passed and the branch is pushed.","num_turns":2,"result_index":1,"origin":{"kind":"task-notification"},"session_id":"$sid","usage":{"input_tokens":4,"output_tokens":30}}
EOF
cat >/dev/null
`;
}

/** The stand-in `claude` for a turn that leaves a server running: the agent starts it in the background and replies,
 * and the process ends with the server still in the set, as a nohup'd node server does that never exits. */
function serverLeftRunning(): string {
  return `#!/bin/sh
for a; do [ "$prev" = --session-id ] && sid=$a; prev=$a; done
[ -n "$sid" ] || exit 0
read -r _
cat <<EOF
{"type":"system","subtype":"init","cwd":"$PWD","session_id":"$sid","tools":["Bash"],"model":"claude-opus-5-5"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"nohup node server.js","run_in_background":true}}]},"parent_tool_use_id":null,"session_id":"$sid"}
{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"nohup node server.js"}],"session_id":"$sid"}
{"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_1","description":"nohup node server.js","is_backgrounded":true,"task_type":"local_bash","session_id":"$sid"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4000,"total_cost_usd":0.1,"result":"The screenshots are in shots/; the preview server is still up on :4173.","num_turns":2,"result_index":0,"session_id":"$sid","usage":{"input_tokens":4,"output_tokens":90}}
EOF
`;
}

describe("a turn whose background work ends and wakes its agent", () => {
  let root: string;
  let rt: Runtime | undefined;
  let mark: string;

  /** A runtime whose claude is the stand-in, its woken agent silent for `silentS` seconds; `idleMs` is the quiet a
   * turn is cut after, the real limit where absent. */
  const runtime = (silentS: number, idleMs?: number, script = standIn(mark, silentS)): Runtime => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeStub(join(bin, "claude"), script);
    const wiring: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o, ...(idleMs !== undefined ? { idleMs } : {}) }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    rt = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: { claude: ctx => createClaudeAdapter({ exec: ctx.execStream, configDir: ctx.home("claude"), baseEnv: ctx.env, resultExitMs: WINDOW_MS }) },
      local: wiring,
    });
    return rt;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-wake-"));
    mark = join(root, "woken");
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("stays working through the woken agent's silence, and the woken agent's reply is the turn's, timed from the launch", async () => {
    const rt = runtime(1);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "run the gate in the background and push when it passes" });
    const replies = async () => (await rt.sessions.history(ws.id)).filter(e => e.type === "session.done");

    await until(() => existsSync(mark), 5_000);
    await new Promise(r => setTimeout(r, WINDOW_MS * 2));
    // The woken agent is at work and has said nothing yet: the thread is working, and no reply is out.
    expect(await replies()).toEqual([]);
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("running");

    const result = await handle.finished;
    expect(result).toMatchObject({ status: "completed", text: "The gate passed and the branch is pushed.", costUsd: 0.3 });
    // The CLI times the woken reply from the wake alone (900ms here); the turn ran from the launch to it: the held
    // reply's 4s, the gate's 0.3s and the woken agent's second.
    expect(result.durationMs).toBeGreaterThanOrEqual(4_000 + 1_000);
    expect(result.durationMs).toBeLessThan(4_000 + 5_000);
    expect(await replies()).toHaveLength(1);
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("completed");
  }, 10_000);

  it("a woken agent the idle rule cuts reads failed with the cut's line, and keeps the words it gave before the wake", async () => {
    const rt = runtime(10, 1_500);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "run the gate in the background and push when it passes" });

    const result = await handle.finished;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^stopped after .* with no output for /);
    expect(result.text).toBe("Waiting on the gate.");
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("failed");
  }, 10_000);

  it("a turn whose process ends with a server it started still running reads done, its last line naming that work", async () => {
    const rt = runtime(0, undefined, serverLeftRunning());
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "start the preview server and take the screenshots" });

    const result = await handle.finished;
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.text?.split("\n")).toEqual(["The screenshots are in shots/; the preview server is still up on :4173.", "", backgroundTasksLine(1)]);
    expect(notifyTail(result)).toBe(backgroundTasksLine(1));
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("completed");
  }, 10_000);
});
