// SPDX-License-Identifier: AGPL-3.0-only
// Long threads for find in thread, one per project folder so each keeps its own transcript cap: a Claude Code thread
// of 2,000 messages inside the cap whose turns carry the rows a real one does (a Bash call with its description and
// output, an edit, a Thinking row, now and then a subagent, a plan, a long message, a diagram and math), a Codex
// thread with its own command, file change, reasoning and subagent rows, and a Claude Code thread written past the
// 4 MiB cap, whose oldest turns the host drops as it loads, so find says what it cannot reach.
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { ago, copyOn, event, project, projectDest, store, THIS_COMPUTER, tileThread, turn, turnId, workspace } from "../fixture-kit.mjs";

const FILES = ["src/auth/session.ts", "src/auth/refresh.ts", "src/cart/total.ts", "src/links/store.ts", "src/api/redirect.ts", "test/cart.test.ts"];
const TOPICS = ["the refresh token", "the cart total", "the redirect cache", "the link store", "the session cookie", "the rate limiter"];
const ASKS = [
  "Why does {t} break after a deploy? Look at {f} first.",
  "Make {t} survive a restart and add a test for it.",
  "Can you explain what {t} does on a cold start?",
  "Rename the helpers around {t} so they read plainly.",
];
const REPLIES = [
  "**{T}** was read before the config loaded. I moved the read into `init()` in [{f}](./{f}) and added a test:\n\n```ts\nit(\"reads {t} after init\", () => {\n  expect(load()).toBeDefined();\n});\n```\n\nThe suite passes.",
  "Here is what changed for {t}:\n\n- `{f}` keeps one copy instead of three\n- the test now pins the order\n  - and the cold path\n\nRun `pnpm test` to see it pass.",
  "I traced {t} through {f}. It is rebuilt on every request, which is why the latency doubled. Caching it once cut p95 from 180 ms to 40 ms.",
];
const COMMENTARY = ["Reading {f} to see where {t} starts.", "Running the tests around {t} before I change anything.", "Checking who calls {f}."];
const AFTER = ["The tests around {t} pass before the change.", "{F} has two readers of {t}.", "Nothing else touches {t}."];

const fill = (template, i) => {
  const t = TOPICS[i % TOPICS.length];
  const f = FILES[(i * 7) % FILES.length];
  return template.replaceAll("{t}", t).replaceAll("{T}", t.charAt(0).toUpperCase() + t.slice(1)).replaceAll("{F}", f.charAt(0).toUpperCase() + f.slice(1)).replaceAll("{f}", f);
};

const LONG_MESSAGE = Array.from({ length: 14 }, (_, i) => `${i + 1}. Step ${i + 1} of the migration touches the session cookie and the refresh token in a new way.`).join("\n");
const DIAGRAM = "The flow, drawn:\n\n```mermaid\ngraph TD\n  A[refresh token] --> B[session cookie]\n```\n\nand the cost is $O(n \\log n)$ per refresh token.";
const PLAN = "# Plan\n\n1. Move the refresh token read into init\n2. Cache the session cookie once\n3. Pin both with tests";

/** One Claude Code turn of four messages: the prompt, a line of commentary, a Bash call with its description and
 * output, a second line, the reply; every fourth turn a thought and an edit, every 25th a subagent, and a few turns a
 * plan, a long message or a diagram. */
function claudeTurn(thread, ws, i, minutes, out, { bulk = 0 } = {}) {
  const id = `${thread.id}:${i}`;
  const ev = rest => ({ ...event(thread, rest, ws), turnId: turnId(id) });
  const prompt = i === 3 ? LONG_MESSAGE : fill(ASKS[i % ASKS.length], i);
  const reply = i === 5 ? DIAGRAM : fill(REPLIES[i % REPLIES.length], i);
  const file = FILES[(i * 7) % FILES.length];
  out.push(ev({ type: "session.start", at: ago(minutes), prompt, model: "claude-opus-5-5", cwd: projectDest(thread.folder) }));
  if (i % 4 === 0) out.push(ev({ type: "session.delta", at: ago(minutes), kind: "thinking", text: `The ${TOPICS[i % TOPICS.length]} is read in two places.\nOne of them runs before the config.` }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "text", messageId: `${id}:a`, text: fill(COMMENTARY[i % COMMENTARY.length], i) }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "Bash", toolUseId: `${id}:bash`, text: JSON.stringify({ command: `pnpm vitest run ${file} --reporter=dot`, description: `Run the tests for ${file}` }) }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_result", toolUseId: `${id}:bash`, text: `✓ ${file} (12 tests) ${100 + (i % 50)}ms\n${"·".repeat(bulk)}` }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "text", messageId: `${id}:c`, text: fill(AFTER[i % AFTER.length], i) }));
  if (i % 4 === 0) {
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "Edit", toolUseId: `${id}:edit`, text: JSON.stringify({ file_path: `${projectDest(thread.folder)}/${file}`, old_string: "a", new_string: "b" }) }));
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_result", toolUseId: `${id}:edit`, text: "The file has been updated." }));
  }
  if (i % 25 === 0) {
    const call = `${id}:agent`;
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "Agent", toolUseId: call, text: JSON.stringify({ description: `Find every caller of ${file}`, prompt: `List every caller of ${file}.`, subagent_type: "Explore" }) }));
    out.push(ev({ type: "session.subagent", at: ago(minutes), task: `task-${i}`, state: "running", parentToolUseId: call, title: `Find every caller of ${file}` }));
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "text", parentToolUseId: call, text: `Three callers read the refresh token from ${file}.` }));
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "Grep", toolUseId: `${call}:grep`, parentToolUseId: call, text: JSON.stringify({ pattern: "refresh token", path: "src" }) }));
    out.push(ev({ type: "session.subagent", at: ago(minutes), task: `task-${i}`, state: "done", parentToolUseId: call, summary: "Three callers, all in src/auth." }));
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_result", toolUseId: call, text: "Three callers, all in src/auth." }));
  }
  if (i === 8) out.push(ev({ type: "session.plan", at: ago(minutes), text: PLAN }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "text", messageId: `${id}:b`, text: reply }));
  out.push(ev({ type: "session.done", at: ago(minutes), result: { status: "completed", durationMs: 64_000, text: reply } }));
  out.push(ev({ type: "session.end", at: ago(minutes), exitCode: 0, sawResult: true }));
}

/** One Codex turn: a reasoning summary, a command, a file change, a subagent every 20th turn, the reply. */
function codexTurn(thread, ws, i, minutes, out) {
  const id = `${thread.id}:${i}`;
  const ev = rest => ({ ...event(thread, rest, ws), turnId: turnId(id) });
  const file = FILES[(i * 5) % FILES.length];
  const reply = fill(REPLIES[(i + 1) % REPLIES.length], i);
  out.push(ev({ type: "session.start", at: ago(minutes), prompt: fill(ASKS[(i + 2) % ASKS.length], i), model: "gpt-5.5", harness: "codex", cwd: projectDest(thread.folder) }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "thinking", text: `Reasoning about the ${TOPICS[(i + 3) % TOPICS.length]} in ${file}.` }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "command_execution", toolUseId: `${id}:cmd`, text: JSON.stringify({ command: `rg -n "refresh token" ${file}` }) }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_result", toolUseId: `${id}:cmd`, text: `${file}:12: const refreshToken = read();` }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "file_change", toolUseId: `${id}:patch`, text: JSON.stringify({ changes: [{ kind: "edit", path: file }] }) }));
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_result", toolUseId: `${id}:patch`, text: "applied" }));
  if (i % 20 === 0) {
    const call = `${id}:spawn`;
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_use", toolName: "spawn_agent", toolUseId: call, text: JSON.stringify({ prompt: `Check the cache keys in ${file}` }) }));
    out.push(ev({ type: "session.subagent", at: ago(minutes), task: `codex-${i}`, state: "running", parentToolUseId: call, title: `Check the cache keys in ${file}` }));
    out.push(ev({ type: "session.subagent", at: ago(minutes), task: `codex-${i}`, state: "done", parentToolUseId: call, summary: "The refresh token cache key is per user." }));
    out.push(ev({ type: "session.delta", at: ago(minutes), kind: "tool_result", toolUseId: call, text: "The refresh token cache key is per user." }));
  }
  out.push(ev({ type: "session.delta", at: ago(minutes), kind: "text", text: reply }));
  out.push(ev({ type: "session.done", at: ago(minutes), result: { status: "completed", durationMs: 41_000, text: reply } }));
  out.push(ev({ type: "session.end", at: ago(minutes), exitCode: 0, sawResult: true }));
}

const thread = (id, title, folder, over = {}) => ({ ...tileThread(id, title, over), folder });

const findFixture = () => {
  const claude = thread("find-claude", "Move the refresh token read into init", "spoo-auth", { model: "claude-opus-5-5" });
  const codex = thread("find-codex", "Key the redirect cache per user", "spoo-api", { agent: "codex", model: "gpt-5.5" });
  const capped = thread("find-capped", "Pin the cart total with tests", "spoo-landing", { model: "claude-opus-5-5" });
  const runs = [
    { thread: claude, ws: "ws_find", turns: 500, write: claudeTurn },
    { thread: codex, ws: "ws_find_codex", turns: 240, write: codexTurn },
    // Past both caps, so the host drops this thread's oldest turns as it loads it.
    { thread: capped, ws: "ws_find_capped", turns: 500, write: (t, ws, i, m, out) => claudeTurn(t, ws, i, m, out, { bulk: 5000 }) },
  ];
  const transcripts = {};
  const sessions = {};
  for (const { thread: t, ws, turns, write } of runs) {
    const events = [];
    for (let i = 0; i < turns; i++) write(t, ws, i, (turns - i) * 3 + 10, events);
    transcripts[ws] = { workspaceId: ws, events };
    const last = turns - 1;
    sessions[ws] = { workspaceId: ws, sessions: [{ ...turn(t, 13, ws), turnId: turnId(`${t.id}:${last}`), cwd: projectDest(t.folder), model: t.model }], threads: {} };
  }
  return store({
    projects: [project("spoo-auth", HERE, 60 * 40), project("spoo-api", HERE, 60 * 30), project("spoo-landing", HERE, 60 * 20)],
    workspaces: [
      workspace("ws_find", THIS_COMPUTER, { machineId: "local-find", project: "pr_spoo-auth", worktree: copyOn("spoo-auth-find", "fix/refresh-init") }),
      workspace("ws_find_codex", THIS_COMPUTER, { machineId: "local-find-codex", project: "pr_spoo-api", worktree: copyOn("spoo-api-find", "fix/redirect-keys") }),
      workspace("ws_find_capped", THIS_COMPUTER, { machineId: "local-find-capped", project: "pr_spoo-landing", worktree: copyOn("spoo-landing-find", "fix/cart-tests") }),
    ],
    sessions,
    transcripts,
    readsSince: 60 * 24 * 7,
  });
};

export default { build: findFixture };
