// SPDX-License-Identifier: AGPL-3.0-only
// The two agents the flows drive, as each one's real command line meets the host: Claude Code over its stream-json
// channel, kept between turns, and Codex as an app server. Each acts on the words of the message it is sent, so a
// flow says what the turn does in the message it types:
//   fail     the turn ends failed with FLOW_WORDS.failed
//   limit    the turn ends failed with the agent's usage limit words, FLOW_WORDS.limit
//   hang     says FLOW_WORDS.working, then waits until the case writes the gate file the message names after it
//   ask      asks to run a command twice, waits on each answer, and says what each answer was
//   silent   says nothing at all, not even its start, until it is stopped
// and anything else is answered with FLOW_WORDS.reply and the message.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";

export const FLOW_WORDS = {
  reply: "done:",
  working: "reading the code first",
  failed: "The stand-in failed on purpose.",
  limit: "You've hit your usage limit. Upgrade to Pro or try again at Oct 10th, 2026 1:04 PM.",
  /** What a turn that asked says once both answers came back: allowed then denied, in the order they were given. */
  answered: (first: string, second: string): string => `the first call was ${first}, the second ${second}`,
} as const;

/** The gate a hanging turn waits on: the message carries `hang <name>` and the case writes the file to let it go. */
export const gateIn = (dir: string, name: string): string => join(dir, "gates", name);

/** Where each stand-in session writes its pid as it starts, which is how a case stops every turn it caused. */
export const pidsIn = (dir: string): string => join(dir, "agents.pids");

/** What both stand-ins share: the words, the gate folder and how a message's own words pick what the turn does. */
const common = (dir: string): string => `
const fs = require("node:fs");
const path = require("node:path");
const WORDS = ${JSON.stringify({ ...FLOW_WORDS, answered: undefined })};
const answered = ${FLOW_WORDS.answered.toString()};
const GATES = ${JSON.stringify(join(dir, "gates"))};
const live = () => fs.appendFileSync(${JSON.stringify(pidsIn(dir))}, process.pid + "\\n");
const say = o => process.stdout.write(JSON.stringify(o) + "\\n");
const gateOf = text => (/\\bhang (\\S+)/.exec(text) || [])[1];
const waitGate = (name, done) => {
  const file = path.join(GATES, name);
  const poll = setInterval(() => { if (fs.existsSync(file)) { clearInterval(poll); done(); } }, 50);
  return () => clearInterval(poll);
};
const lines = handle => {
  let buf = "";
  process.stdin.on("data", d => {
    buf += d;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim() !== "") handle(JSON.parse(line)); }
  });
  process.stdin.on("end", () => process.exit(0));
};
`;

/** Claude Code: a version line for the catalog's probe, else a session that reads one user message per turn off stdin
 * and answers it, a control_request it raised answered down the same channel, an interrupt ending the turn. */
const claudeScript = (dir: string): string => `#!${process.execPath}
${common(dir)}
const argv = process.argv.slice(2);
const at = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const sid = at("--session-id") || at("--resume");
if (sid === undefined) { console.log("2.1.290 (Claude Code)"); process.exit(0); }
live();
const mode = at("--permission-mode") || "bypassPermissions";
let n = 0, turn;
const message = text => say({ type: "assistant", message: { id: "msg_" + ++n, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: sid, uuid: "u" + n });
const result = (o) => { if (turn && turn.stopGate) turn.stopGate(); turn = undefined; say({ type: "result", duration_ms: 10, num_turns: 1, session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: "r" + ++n, ...o }); };
const reply = text => { message(text); result({ subtype: "success", is_error: false, result: text }); };
const ask = id => say({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "touch " + id }, description: "touch " + id, tool_use_id: "toolu_" + id } });
let inited = false;
lines(m => {
  if (m.type === "control_request" && m.request && m.request.subtype === "interrupt") {
    say({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    if (turn) result({ subtype: "error_during_execution", is_error: false, terminal_reason: "aborted_streaming", errors: ["request was aborted"] });
    return;
  }
  if (m.type === "control_request") { say({ type: "control_response", response: { subtype: "success", request_id: m.request_id } }); return; }
  if (m.type === "control_response") {
    if (!turn || !turn.asks) return;
    const r = m.response || {};
    turn.answers.push(r.response && r.response.behavior === "allow" ? "allowed" : "denied");
    if (turn.answers.length === 1) ask("ask_2");
    else reply(answered(turn.answers[0], turn.answers[1]));
    return;
  }
  if (m.type !== "user") return;
  const text = (m.message.content.find(c => c.type === "text") || {}).text || "";
  if (/\\bsilent\\b/.test(text)) return;
  if (!inited) { inited = true; say({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: [], mcp_servers: [], model: "claude-sonnet-5", permissionMode: mode, slash_commands: [], apiKeySource: "none", uuid: "init" }); }
  turn = { answers: [] };
  if (/\\bfail\\b/.test(text)) { message("trying"); result({ subtype: "error_during_execution", is_error: true, errors: [WORDS.failed] }); return; }
  if (/\\blimit\\b/.test(text)) { result({ subtype: "success", is_error: true, result: WORDS.limit }); return; }
  if (/\\bask\\b/.test(text)) { turn.asks = true; message("I need to run a command"); ask("ask_1"); return; }
  const gate = gateOf(text);
  if (gate !== undefined) { message(WORDS.working); const t = turn; t.stopGate = waitGate(gate, () => { if (turn === t) reply(WORDS.reply + " " + text); }); return; }
  reply(WORDS.reply + " " + text);
});
`;

/** Codex: a version line, else an app server whose thread id is its own and never wsp's, as the real one's is. A
 * command's approval is a request of the server's, answered by id; turn/interrupt completes the turn interrupted. */
const codexScript = (dir: string): string => `#!${process.execPath}
${common(dir)}
if (process.argv[2] !== "app-server") { console.log("codex-cli 0.155.1"); process.exit(0); }
live();
const thread = "019fd0aa-0000-7000-8000-" + String(process.pid).padStart(12, "0");
let turns = 0, turn, asked = 0;
const item = (t, text) => say({ method: "item/completed", params: { threadId: thread, turnId: t.id, item: { type: "agentMessage", id: "m" + ++asked + t.id, text } } });
const complete = (t, status, error) => {
  if (turn !== t) return;
  if (t.stopGate) t.stopGate();
  turn = undefined;
  if (error) say({ method: "error", params: { threadId: thread, turnId: t.id, willRetry: false, error: { message: error } } });
  say({ method: "turn/completed", params: { threadId: thread, turn: { id: t.id, items: [], status, ...(error ? { error: { message: error } } : {}) } } });
};
const reply = (t, text) => { item(t, text); complete(t, "completed"); };
const ask = t => { const id = "approval-" + t.id + "-" + (t.answers.length + 1); t.waiting = id; say({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: t.id, itemId: "cmd-" + id, command: "touch " + id, cwd: process.cwd() } }); };
lines(m => {
  if (m.method === undefined && m.id !== undefined) {
    if (!turn || turn.waiting !== m.id) return;
    turn.answers.push(m.result && m.result.decision === "accept" ? "allowed" : "denied");
    if (turn.answers.length === 1) ask(turn);
    else reply(turn, answered(turn.answers[0], turn.answers[1]));
    return;
  }
  if (m.method === "thread/start" || m.method === "thread/resume") { say({ id: m.id, result: { thread: { id: thread, turns: [] }, model: "gpt-5.6-sol", cwd: process.cwd() } }); return; }
  if (m.method === "turn/interrupt") { say({ id: m.id, result: {} }); if (turn) complete(turn, "interrupted"); return; }
  if (m.method === "turn/start") {
    const text = m.params.input.map(i => i.text || "").join(" ");
    const t = { id: "turn-" + ++turns, answers: [] };
    turn = t;
    say({ id: m.id, result: { turn: { id: t.id, items: [], status: "inProgress" } } });
    say({ method: "turn/started", params: { threadId: thread, turn: { id: t.id, items: [], status: "inProgress" } } });
    if (/\\bfail\\b/.test(text)) { complete(t, "failed", WORDS.failed); return; }
    if (/\\blimit\\b/.test(text)) { complete(t, "failed", WORDS.limit); return; }
    if (/\\bask\\b/.test(text)) { item(t, "I need to run a command"); ask(t); return; }
    const gate = gateOf(text);
    if (gate !== undefined) { item(t, WORDS.working); t.stopGate = waitGate(gate, () => reply(t, WORDS.reply + " " + text)); return; }
    reply(t, WORDS.reply + " " + text);
    return;
  }
  if (m.id !== undefined) say({ id: m.id, result: {} });
});
`;

/** Both agents in `dir/bin`, the folder a flow's PATH starts with, and the gate folder beside it. */
export function writeFlowAgents(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeStub(join(bin, "claude"), claudeScript(dir));
  writeStub(join(bin, "codex"), codexScript(dir));
  return bin;
}
