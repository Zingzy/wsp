// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { ago, copyOn, event, project, projectDest, store, THIS_COMPUTER, tileThread, turn, turnId, workspace } from "../fixture-kit.mjs";

/** Five threads on one copy of spoo-landing for the timeline's compaction line and the top bar's meter: a /compact
 * turn whose agent named both figures, one on Codex whose agent named the after figure alone, a first turn still
 * running with what its agent held written as its host closed, a second turn stopped after one call, and a turn on
 * Cursor that failed before its agent said anything. */
const contextMeter = () => {
  const ws = "ws_meter";
  const ev = (thread, n, rest) => ({ ...event(thread, rest, ws), turnId: turnId(`${thread.id}:${n}`) });
  const opened = (thread, n, minutes, prompt) => ev(thread, n, { type: "session.start", at: ago(minutes), prompt, model: thread.model, cwd: projectDest("spoo-landing") });
  const closed = (thread, n, minutes, result) => [ev(thread, n, { type: "session.done", at: ago(minutes), result }), ev(thread, n, { type: "session.end", at: ago(minutes), exitCode: result.status === "completed" ? 0 : null, sawResult: true })];
  const answered = (thread, n, minutes, prompt, reply, tokens) => [
    opened(thread, n, minutes, prompt),
    ev(thread, n, { type: "session.delta", at: ago(minutes - 1), kind: "text", text: reply }),
    ...closed(thread, n, minutes - 2, { status: "completed", durationMs: 96_000, text: reply, tokens }),
  ];
  const compacted = (thread, n, minutes, figures, window) => [
    opened(thread, n, minutes, "/compact"),
    ev(thread, n, { type: "session.compacted", at: ago(minutes - 1), line: 1, ...figures }),
    ...closed(thread, n, minutes - 1, { status: "completed", durationMs: 10_400, text: "", tokens: { input: 0, output: 0, context: figures.after, window } }),
  ];
  const compact = tileThread("compact", "Rename the link store across the app", { model: "claude-opus-5-5" });
  const bare = tileThread("compact-bare", "Split the redirect tests by route", { agent: "codex", model: "gpt-5.6-sol" });
  const running = tileThread("first-running", "Port the cart totals to integer cents", { model: "claude-opus-5-5", status: "running" });
  const stopped = tileThread("stopped", "Find why the cart total test is flaky", { model: "claude-opus-5-5" });
  const failed = tileThread("failed", "Round the tax line once", { agent: "cursor", model: "auto" });
  const events = [
    ...answered(compact, 0, 50, compact.prompt, "Renamed LinkStore to Links across the API, the web app and the shared package; the suite passes.", { input: 61_000, output: 2_400, context: 61_000, window: 200_000 }),
    ...compacted(compact, 1, 45, { before: 61_000, after: 3_410 }, 200_000),
    ...answered(bare, 0, 40, bare.prompt, "Split redirect.test.ts into one file per route; each runs on its own.", { input: 40_200, output: 900, context: 40_200, window: 258_400 }),
    ...compacted(bare, 1, 35, { after: 3_410 }, 258_400),
    opened(running, 0, 20, running.prompt),
    ev(running, 0, { type: "session.delta", at: ago(19), kind: "tool_use", toolName: "Read", toolUseId: "tu_running", text: '{"file_path":"src/cart/total.ts"}' }),
    ev(running, 0, { type: "session.delta", at: ago(19), kind: "tool_result", toolUseId: "tu_running", text: "export function total(lines) { return lines.reduce((sum, l) => sum + round(l.price), 0); }" }),
    ev(running, 0, { type: "session.context", at: ago(18), context: 28_514 }),
    ...answered(stopped, 0, 30, stopped.prompt, "The total rounds per line instead of once at the end.", { input: 40_000, output: 800, context: 40_000, window: 200_000 }),
    opened(stopped, 1, 15, "Move the rounding to the end and pin it with a test"),
    ev(stopped, 1, { type: "session.delta", at: ago(14), kind: "thinking", text: "Read the total before moving the rounding." }),
    ev(stopped, 1, { type: "session.context", at: ago(13), context: 52_300 }),
    ...closed(stopped, 1, 13, { status: "interrupted" }),
    ...closed(failed, 0, 10, { status: "failed", error: "cursor-agent is not signed in on this computer; sign in from a terminal on it, then send again" }),
  ];
  const row = (thread, n, minutes, status) => ({ ...turn({ ...thread, status }, minutes, ws), turnId: turnId(`${thread.id}:${n}`) });
  return store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace(ws, THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-meter", "fix/cart-cents") })],
    sessions: { [ws]: { workspaceId: ws, sessions: [row(compact, 1, 45, "completed"), row(bare, 1, 35, "completed"), row(running, 0, 20, "running"), row(stopped, 1, 15, "interrupted"), row(failed, 0, 10, "failed")], threads: {} } },
    transcripts: { [ws]: { workspaceId: ws, events } },
    readsSince: 60 * 24 * 7,
    preferences: { projectLook: { "pr_spoo-landing": { icon: "folder", hue: "orange" } } },
  });
};

export default { build: contextMeter };
