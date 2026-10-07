// SPDX-License-Identifier: AGPL-3.0-only
// Agents that serve one turn after another from one process, as Claude Code on stream-json and Codex's app server
// do: each reply names the process that gave it, the turn count that process is at and the turn token in its
// environment, so a case reads which process served a turn without finding any pid by name. A message starting
// "hang" opens a turn that runs until it is interrupted ("hang deaf" ignores the interrupt, "hang talk" first says
// two messages with a call and its result between them), and one containing
// "later" waits for the file STUB_GATE names before the agent says anything at all. The Claude stub takes
// STUB_EXIT_MS to exit once its input closes, as a CLI running its exit hooks does. It appends each message to its
// session file under STUB_SESSIONS where that is set, answers the title question with STUB_TITLE after STUB_TITLE_MS,
// and on "leave a child" starts a command that outlives the tool that started it, its pid to STUB_HEARD.
import { TURN_TOKEN_ENV } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";

const COMMON = `
const fs = require("node:fs");
const say = o => process.stdout.write(JSON.stringify(o) + "\\n");
const heard = text => process.env.STUB_HEARD && fs.appendFileSync(process.env.STUB_HEARD, text + "\\n");
const gated = (text, go) => {
  if (!text.includes("later") || !process.env.STUB_GATE) return go();
  const poll = setInterval(() => {
    if (!fs.existsSync(process.env.STUB_GATE)) return;
    clearInterval(poll);
    go();
  }, 20);
};
const signed = (text, turns) => text + " from " + process.pid + " turn " + turns + " token " + (process.env[${JSON.stringify(TURN_TOKEN_ENV)}] || "none");
`;

/** Claude Code on stream-json: an init line for every message, then its reply and a result whose cost runs on across
 * the process's turns, as the CLI's own totals do. */
export function claudeKeeper(path: string): string {
  return writeStub(
    path,
    `#!${process.execPath}
const args = process.argv.slice(2);
let sid = "";
for (let i = 0; i < args.length; i++) if (args[i] === "--session-id" || args[i] === "--resume") sid = args[i + 1];
if (!sid && args.includes("--safe-mode") && process.env.STUB_TITLE) {
  setTimeout(() => { console.log(JSON.stringify({ type: "result", is_error: false, result: process.env.STUB_TITLE })); process.exit(0); }, Number(process.env.STUB_TITLE_MS || 0));
  return;
}
if (!sid) { console.log("2.1.289 (Claude Code)"); process.exit(0); }
${COMMON}
let cost = 0;
let turns = 0;
let hanging = false;
let deaf = false;
let background;
const result = (text, extra) => say({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, result: text, session_id: sid, total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
const endBackground = () => {
  if (background === undefined) return;
  say({ type: "system", subtype: "task_notification", task_id: background, status: "stopped", summary: "Wait 75 seconds", session_id: sid });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: sid });
  background = undefined;
};
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.type === "control_request" && m.request.subtype === "stop_task") {
    heard("stop_task " + m.request.task_id);
    say({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    if (m.request.task_id === background) endBackground();
    return;
  }
  if (m.type === "control_request" && m.request.subtype === "interrupt") {
    say({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    if (!hanging || deaf) return;
    hanging = false;
    result("", { subtype: "error_during_execution", terminal_reason: "aborted_streaming" });
    // The CLI stops a background command of an interrupted turn on its own only seconds later.
    if (background !== undefined) setTimeout(endBackground, 3000);
    return;
  }
  if (m.type !== "user") return;
  const text = m.message.content.at(-1).text;
  heard(text);
  if (process.env.STUB_SESSIONS) fs.appendFileSync(require("node:path").join(process.env.STUB_SESSIONS, sid + ".jsonl"), JSON.stringify({ type: "user", text }) + "\\n");
  gated(text, () => {
    say({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), model: "claude-sonnet-4-5", tools: [], permissionMode: "default", slash_commands: [], apiKeySource: "none" });
    turns += 1;
    if (text.startsWith("hang")) {
      hanging = true;
      deaf = text === "hang deaf";
      if (text === "hang background") {
        background = "bg" + turns;
        say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: background, description: "Wait 75 seconds" }], session_id: sid });
      }
      if (text === "hang talk") {
        const own = (id, block) => say({ type: "assistant", session_id: sid, parent_tool_use_id: null, uuid: id + block.type, message: { id, role: "assistant", content: [block] } });
        own("talk1", { type: "text", text: "alpha" });
        own("talk1", { type: "tool_use", id: "call1", name: "Bash", input: { command: "echo one" } });
        say({ type: "user", session_id: sid, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "one", is_error: false }] } });
        own("talk2", { type: "text", text: "beta" });
      }
      return;
    }
    if (text === "leave a child") heard("child " + require("node:child_process").execSync("sh -c 'sleep 30 > /dev/null 2>&1 & echo $!'", { encoding: "utf8" }).trim());
    cost += 0.25;
    const said = signed(text, turns);
    say({ type: "assistant", session_id: sid, parent_tool_use_id: null, uuid: "a" + turns, message: { id: "msg" + turns, role: "assistant", content: [{ type: "text", text: said }] } });
    result(said);
  });
}).on("close", () => setTimeout(() => process.exit(0), Number(process.env.STUB_EXIT_MS || 0)));
`,
  );
}

const THREAD = "019fd0aa-0000-7000-8000-00000000c0de";

/** codex app-server: one thread, each turn/start answered with a reply, turn/interrupt completing the open turn as
 * interrupted. "hang command" starts a real command in a process group of its own, which turn/interrupt leaves running
 * and the server's exit ends, as codex-cli 0.155.1 was seen to do; its pid goes to STUB_HEARD. */
export function codexKeeper(path: string): string {
  return writeStub(
    path,
    `#!${process.execPath}
if (process.argv[2] !== "app-server") process.exit(2);
${COMMON}
let turns = 0;
let open;
let command;
const quit = () => {
  if (command !== undefined) process.kill(-command.pid, "SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", quit);
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") say({ id: m.id, result: {} });
  if (m.method === "account/read" || m.method === "account/rateLimits/read") say({ id: m.id, error: { code: -32600, message: "no account here" } });
  if (m.method === "thread/start" || m.method === "thread/resume") say({ id: m.id, result: { thread: { id: "${THREAD}", turns: [] }, model: "gpt-5.5" } });
  if (m.method === "turn/interrupt") {
    say({ id: m.id, result: {} });
    if (open !== undefined && m.params.turnId === open && !process.env.STUB_DEAF) {
      say({ method: "turn/completed", params: { threadId: "${THREAD}", turn: { id: open, items: [], status: "interrupted" } } });
      open = undefined;
    }
  }
  if (m.method === "turn/start") {
    const text = m.params.input[0].text;
    heard(text);
    say({ id: m.id, result: {} });
    gated(text, () => {
      turns += 1;
      const id = "turn-" + turns;
      say({ method: "turn/started", params: { threadId: "${THREAD}", turn: { id, items: [], status: "inProgress" } } });
      if (text.startsWith("hang")) {
        open = id;
        if (text === "hang command") {
          command = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
          heard("command " + command.pid);
          say({ method: "item/started", params: { threadId: "${THREAD}", turnId: id, item: { type: "commandExecution", id: "c" + turns, command: "sleep 30", status: "inProgress" } } });
        }
        return;
      }
      say({ method: "item/completed", params: { threadId: "${THREAD}", turnId: id, item: { type: "agentMessage", id: "m" + turns, text: signed(text, turns) } } });
      say({ method: "turn/completed", params: { threadId: "${THREAD}", turn: { id, items: [], status: "completed" } } });
    });
  }
}).on("close", quit);
`,
  );
}

/** The process a reply names, read back off its words. */
export const pidOf = (text: string | undefined): number => Number(/ from (\d+) /.exec(text ?? "")?.[1] ?? NaN);
export const tokenOf = (text: string | undefined): string => / token (\S+)$/.exec(text ?? "")?.[1] ?? "";
