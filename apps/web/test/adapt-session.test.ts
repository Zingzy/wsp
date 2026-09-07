// SPDX-License-Identifier: AGPL-3.0-only
// Session events into the chat view models: messages, work rows, turn
// summaries and the timeline rows the transplanted MessagesTimeline renders.
import { describe, expect, expectTypeOf, it } from "vitest";
import { fmtDuration, type SessionEvent } from "@wsp/protocol";
import { deriveMessagesTimelineRows, deriveSession, toolGroupSummaryKind, workEntryKind } from "../src/adapt/index.js";
import type { ToolGroupAction, ToolGroupSummaryKind, WorkLogEntry } from "../src/adapt/index.js";
import { CHAT_STREAM, CHAT_TURN } from "./fixtures/chat-stream.js";
import { LIVE_RUN_1, LIVE_SID, sessionEventsOf } from "./fixtures/live-run-1.js";

const scope = { workspaceId: "ws_t", sessionId: "sess_t" };
const start: SessionEvent = { type: "session.start", ...scope, prompt: "do it", model: "claude-opus-5" };
const tool = (toolName: string, input: unknown, toolUseId = "toolu_1"): SessionEvent => ({
  type: "session.delta", ...scope, kind: "tool_use", toolName, toolUseId, text: JSON.stringify(input),
});
const result = (text: string, isError = false, toolUseId = "toolu_1"): SessionEvent => ({
  type: "session.delta", ...scope, kind: "tool_result", toolUseId, text, isError,
});
const done: SessionEvent = { type: "session.done", ...scope, result: { status: "completed", durationMs: 1500, costUsd: 0.01 } };
const end: SessionEvent = { type: "session.end", ...scope, exitCode: 0, sawResult: true };

const liveSession = sessionEventsOf(LIVE_RUN_1);
const liveEvents = liveSession.map(s => s.event);
const liveAt = (_e: SessionEvent, index: number) => liveSession[index]?.at;

describe("deriveSession: a message steered into the running turn", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_s" };
  const events: SessionEvent[] = [
    { type: "session.start", ...scoped, at: 1_000, prompt: "run the long job" },
    { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "Starting." },
    { type: "session.steer", ...scoped, at: 3_000, prompt: "when it ends, say pineapple", requestId: "req_s" },
    { type: "session.delta", ...scoped, at: 4_000, kind: "text", text: "Pineapple." },
  ];

  it("is the person's own message row inside the same turn, in wire order, marked steered", () => {
    const model = deriveSession(events);
    expect(model.turns).toHaveLength(1);
    expect(model.running).toBe(true);
    expect(model.messages.map(m => [m.role, m.text, m.steered ?? false, m.turnId])).toEqual([
      ["user", "run the long job", false, "turn_s"],
      ["assistant", "Starting.", false, "turn_s"],
      ["user", "when it ends, say pineapple", true, "turn_s"],
      ["assistant", "Pineapple.", false, "turn_s"],
    ]);
    expect(model.messages[2]!.createdAt).toBe(new Date(3_000).toISOString());
  });

  it("a settled turn keeps the steered row visible: user rows never fold behind Worked for", () => {
    const settled: SessionEvent[] = [...events, { type: "session.done", ...scoped, at: 5_000, result: { status: "completed", durationMs: 4_000 } }, { type: "session.end", ...scoped, at: 5_100, exitCode: 0, sawResult: true }];
    const model = deriveSession(settled);
    const rows = deriveMessagesTimelineRows({ timelineEntries: model.timeline, turns: model.turns, isWorking: false, activeTurnStartedAt: null });
    const shown = rows.filter(r => r.kind === "message").map(r => (r.kind === "message" ? [r.message.role, r.message.text] : []));
    expect(shown).toEqual([
      ["user", "run the long job"],
      ["user", "when it ends, say pineapple"],
      ["assistant", "Pineapple."],
    ]);
  });
});

describe("deriveSession: the chat fixture", () => {
  const model = deriveSession(CHAT_STREAM);

  it("folds contiguous text deltas into one assistant message and starts a new one after a tool", () => {
    expect(model.messages.map(m => [m.role, m.text])).toEqual([
      ["assistant", "Creating the server file, then starting it."],
      ["assistant", "Server is live at :3000."],
    ]);
    expect(model.messages.every(m => !m.streaming)).toBe(true);
    expect(model.messages.every(m => m.turnId === CHAT_TURN)).toBe(true);
  });

  it("turns the tool call and its result into one completed command row, thinking into a thinking row", () => {
    expect(model.workEntries).toHaveLength(2);
    const [bash, thinking] = model.workEntries as [WorkLogEntry, WorkLogEntry];
    expect(bash).toMatchObject({
      tone: "tool",
      label: "Bash",
      toolCallId: "toolu_01WspFixBash1",
      itemType: "command_execution",
      command: "node /root/server.js >/dev/null 2>&1 & sleep 0.3 && curl -s http://localhost:3000",
      detail: "Hello, World!",
      toolLifecycleStatus: "completed",
      sourceActivityKind: "tool.completed",
    });
    expect(thinking).toMatchObject({ tone: "thinking", label: "Thinking", detail: "curl returned the greeting, so the server is live.", preview: "curl returned the greeting, so the server is live.", sourceActivityKind: "reasoning" });
  });

  it("keeps the turn running with its reply recorded between session.done and session.end, then settles at the end", () => {
    const replied = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Done." }, done]);
    expect(replied.running).toBe(true);
    expect(replied.latestTurn).toMatchObject({ state: "running", replied: true, durationMs: 1500, costUsd: 0.01 });
    expect(replied.messages.map(m => [m.role, m.text])).toEqual([["user", "do it"], ["assistant", "Done."]]);
    const settled = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Done." }, done, end]);
    expect(settled.running).toBe(false);
    expect(settled.latestTurn).toMatchObject({ state: "completed", replied: true, durationMs: 1500 });
  });

  it("summarises the turn from session.done and clears running on session.end", () => {
    expect(model.turns).toEqual([
      expect.objectContaining({ turnId: CHAT_TURN, state: "completed", durationMs: 10458, costUsd: 0.0187, model: "claude-sonnet-4-5", prompt: null }),
    ]);
    expect(model.running).toBe(false);
    expect(model.latestTurn?.turnId).toBe(CHAT_TURN);
    expect(model.turns[0]).toMatchObject({ startedAt: "2026-09-01T01:31:29.412Z", completedAt: "2026-09-01T01:31:39.870Z" });
  });

  it("keeps wire order in the timeline: text, tool, thinking, text", () => {
    expect(model.timeline.map(e => (e.kind === "message" ? `m:${e.message.role}` : `w:${e.kind === "work" ? e.entry.tone : e.kind}`))).toEqual([
      "m:assistant", "w:tool", "w:thinking", "m:assistant",
    ]);
  });
});

describe("deriveSession: streaming states", () => {
  it("marks the tail assistant message streaming and the open tool call inProgress while the turn runs", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Looking" }, tool("Read", { file_path: "/a.ts" })]);
    expect(m.running).toBe(true);
    expect(m.latestTurn?.state).toBe("running");
    expect(m.messages.map(x => [x.role, x.text, x.streaming])).toEqual([["user", "do it", false], ["assistant", "Looking", false]]);
    expect(m.workEntries[0]).toMatchObject({ toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started", requestKind: "file-read", detail: "/a.ts" });
  });

  it("the newest assistant message in a running turn is streaming", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "Look" }]);
    expect(m.messages.at(-1)?.streaming).toBe(true);
  });

  it("appends streamed tool input chunks for the same toolUseId into one row", () => {
    const m = deriveSession([
      start,
      { type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: '{"command":"ls' },
      { type: "session.delta", ...scope, kind: "tool_use", toolUseId: "t1", text: ' -la"}' },
      result("total 0", false, "t1"),
    ]);
    expect(m.workEntries).toHaveLength(1);
    expect(m.workEntries[0]).toMatchObject({ command: "ls -la", detail: "total 0", toolLifecycleStatus: "completed" });
  });

  it("keeps the Bash tool's description on the row after its output replaces the detail", () => {
    const m = deriveSession([start, tool("Bash", { command: "git status", description: "Show working tree status" }), result("On branch main")]);
    expect(m.workEntries[0]).toMatchObject({ command: "git status", description: "Show working tree status", detail: "On branch main" });
  });

  it("another tool's description field stays a detail and never becomes the row's label", () => {
    const m = deriveSession([start, tool("Task", { description: "scan repo", prompt: "find every caller" }), result("Found 12 files")]);
    expect(m.workEntries[0]).toMatchObject({ detail: "Found 12 files" });
    expect(m.workEntries[0]).not.toHaveProperty("description");
  });

  it("a tool_result with no visible call still renders as a completed row", () => {
    const m = deriveSession([start, result("orphan output", false, "t9")]);
    expect(m.workEntries[0]).toMatchObject({ toolCallId: "t9", label: "tool", detail: "orphan output", toolLifecycleStatus: "completed" });
  });

  it("an error result marks the row failed and carries the error text as detail", () => {
    const m = deriveSession([start, tool("Bash", { command: "false" }), result("exit 1: nope", true)]);
    expect(m.workEntries[0]).toMatchObject({ toolLifecycleStatus: "failed", detail: "exit 1: nope", command: "false" });
  });

  it("uses result.text as the assistant message when no text delta arrived (capped replay)", () => {
    const m = deriveSession([start, { type: "session.done", ...scope, result: { status: "completed", text: "All done." } }, end]);
    expect(m.messages.map(x => [x.role, x.text])).toEqual([["user", "do it"], ["assistant", "All done."]]);
  });

  it("does not repeat result.text when the deltas already carried it", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "text", text: "All done." }, { type: "session.done", ...scope, result: { status: "completed", text: "All done." } }, end]);
    expect(m.messages.filter(x => x.role === "assistant")).toHaveLength(1);
  });

  it.each([
    ["failed result", [start, { type: "session.done", ...scope, result: { status: "failed", error: "boom" } }, end] as SessionEvent[], "error", "boom"],
    ["exit without result", [start, { type: "session.end", ...scope, exitCode: 137, sawResult: false }] as SessionEvent[], "error", "session exited without a result (exit code 137)"],
    ["interrupted", [start, { type: "session.done", ...scope, result: { status: "interrupted" } }, end] as SessionEvent[], "interrupted", null],
  ])("%s: turn state and error row", (_name, events, state, errorLabel) => {
    const m = deriveSession(events);
    expect(m.latestTurn?.state).toBe(state);
    expect(m.running).toBe(false);
    const errors = m.workEntries.filter(w => w.tone === "error");
    if (errorLabel === null) expect(errors).toEqual([]);
    else expect(errors).toEqual([expect.objectContaining({ label: errorLabel, sourceActivityKind: "runtime.error", turnId: "sess_t#1" })]);
  });

  it("a start stamped afterCut puts a notice row under the prompt, so the person knows why context may be missing", () => {
    const m = deriveSession([{ ...start, afterCut: true } as SessionEvent, done, end]);
    const rows = m.workEntries.filter(w => w.sourceActivityKind === "runtime.resume");
    expect(rows.map(w => [w.label, w.tone, w.turnId])).toEqual([["previous turn was cut; resuming", "notice", "sess_t#1"]]);
    expect(m.timeline.slice(0, 2).map(e => e.kind)).toEqual(["message", "work"]);
    expect(deriveSession([start, done, end]).workEntries.filter(w => w.sourceActivityKind === "runtime.resume")).toEqual([]);
  });

  it("createdAt: the wire's at wins, then the caller's clock, then empty", () => {
    const wire = deriveSession(CHAT_STREAM, { at: () => "1999-01-01T00:00:00Z" });
    expect(wire.messages[0]?.createdAt).toBe("2026-09-01T01:31:30.612Z");
    expect(wire.messages[0]?.updatedAt).toBe("2026-09-01T01:31:30.862Z");
    const unstamped = CHAT_STREAM.map(({ at: _at, ...e }) => e as SessionEvent);
    const clock = deriveSession(unstamped, { at: (_e, i) => `2026-09-01T00:00:0${i}Z` });
    expect(clock.messages[0]?.createdAt).toBe("2026-09-01T00:00:01Z");
    expect(clock.turns[0]).toMatchObject({ startedAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T00:00:07Z" });
    expect(deriveSession(unstamped).messages[0]?.createdAt).toBe("");
  });

  it("turn id: the wire's turnId wins; without one the session id plus start ordinal stands in", () => {
    const unkeyed = CHAT_STREAM.map(({ turnId: _t, ...e }) => e as SessionEvent);
    expect(deriveSession(unkeyed).turns.map(t => t.turnId)).toEqual(["sess_0001#1"]);
    expect(deriveSession([...unkeyed, ...unkeyed]).turns.map(t => t.turnId)).toEqual(["sess_0001#1", "sess_0001#2"]);
  });

  it("a delta whose turnId never started here opens its own turn (history cut mid-turn)", () => {
    const m = deriveSession([
      { type: "session.delta", ...scope, turnId: "turn_x", kind: "text", text: "tail of an older turn" },
      { type: "session.done", ...scope, turnId: "turn_x", result: { status: "completed", durationMs: 5 } },
      { ...start, turnId: "turn_y" },
    ]);
    expect(m.turns.map(t => [t.turnId, t.state])).toEqual([["turn_x", "completed"], ["turn_y", "running"]]);
    expect(m.messages.map(x => [x.turnId, x.role])).toEqual([["turn_x", "assistant"], ["turn_y", "user"]]);
  });

  it("a fence-only tool result carries no detail", () => {
    const m = deriveSession([start, tool("Bash", { command: "cat x" }), result("```")]);
    expect(m.workEntries[0]?.detail).toBeUndefined();
    expect(m.workEntries[0]?.toolLifecycleStatus).toBe("completed");
  });
});

describe("deriveSession: tool classification", () => {
  it.each([
    ["Bash", { command: "pnpm test" }, { itemType: "command_execution", command: "pnpm test" }],
    ["Read", { file_path: "/x/a.ts" }, { requestKind: "file-read", detail: "/x/a.ts" }],
    ["Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" }, { itemType: "file_change", changedFiles: ["/x/a.ts"] }],
    ["Write", { file_path: "/x/b.ts", content: "..." }, { itemType: "file_change", changedFiles: ["/x/b.ts"] }],
    ["Grep", { pattern: "foo", path: "src" }, { toolTitle: "Grep", detail: "foo" }],
    ["Glob", { pattern: "**/*.ts" }, { toolTitle: "Glob", detail: "**/*.ts" }],
    ["WebSearch", { query: "vitest snapshots" }, { itemType: "web_search", detail: "vitest snapshots" }],
    ["WebFetch", { url: "https://example.com" }, { itemType: "web_search", detail: "https://example.com" }],
    ["Task", { description: "scan repo", prompt: "..." }, { itemType: "collab_agent_tool_call", detail: "scan repo" }],
    ["mcp__gh__issue", { number: 5 }, { itemType: "mcp_tool_call" }],
  ])("%s", (toolName, input, expected) => {
    const m = deriveSession([start, tool(toolName, input)]);
    expect(m.workEntries[0]).toMatchObject({ label: toolName, ...expected });
  });

  it.each([
    ["command_execution", { command: "pnpm test" }, { itemType: "command_execution", command: "pnpm test" }],
    ["file_change", { changes: [{ kind: "edit", path: "src/a.ts" }, { kind: "add", path: "src/b.ts" }] }, { itemType: "file_change", changedFiles: ["src/a.ts", "src/b.ts"] }],
    ["web_search", { query: "vitest snapshots" }, { itemType: "web_search", detail: "vitest snapshots" }],
  ])("a Codex turn's %s row reads as the same kind of call the Claude name reads as", (toolName, input, expected) => {
    const m = deriveSession([start, tool(toolName, input)]);
    expect(m.workEntries[0]).toMatchObject({ label: toolName, ...expected });
  });

  it("keeps unparsable tool input as the detail", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: "{not json" }]);
    expect(m.workEntries[0]).toMatchObject({ detail: "{not json" });
    expect(m.workEntries[0]?.command).toBeUndefined();
  });
});

describe("deriveSession: live run 1", () => {
  const m = deriveSession(liveEvents, { at: liveAt });

  it("one resumed Claude session id becomes four turns, keyed by start ordinal", () => {
    expect(m.turns.map(t => t.turnId)).toEqual([1, 2, 3, 4].map(n => `${LIVE_SID}#${n}`));
    expect(m.turns.map(t => t.prompt)).toEqual(["hello", "build a simple chat app, run it locally, use npm", "/model", "anyways can you make it more beautiful, use shadcn"]);
    expect(m.turns.map(t => t.durationMs)).toEqual([2772, 101515, 114, 862399]);
    expect(m.turns.map(t => t.state)).toEqual(["completed", "completed", "completed", "completed"]);
  });

  it("a stream with no deltas yields user messages only, and the model sticks from the last start that named one", () => {
    expect(m.messages.map(x => x.role)).toEqual(["user", "user", "user", "user"]);
    expect(m.workEntries).toEqual([]);
    expect(m.model).toBe("claude-opus-5");
    expect(m.running).toBe(false);
  });

  it("turn timing comes from the stamped start and done events", () => {
    expect(m.turns[1]).toMatchObject({ startedAt: liveSession[3]?.at, completedAt: liveSession[4]?.at });
  });
});

describe("deriveMessagesTimelineRows", () => {
  const rows = (events: ReadonlyArray<SessionEvent>, extra: Partial<Parameters<typeof deriveMessagesTimelineRows>[0]> = {}) => {
    const m = deriveSession(events);
    return deriveMessagesTimelineRows({ timelineEntries: m.timeline, turns: m.turns, isWorking: m.running, activeTurnStartedAt: null, ...extra });
  };

  it("settled turn: work folds behind 'Worked for' and only the terminal assistant message shows meta", () => {
    const r = rows(CHAT_STREAM);
    expect(r.map(x => x.kind)).toEqual(["turn-fold", "message"]);
    expect(r[0]).toMatchObject({ kind: "turn-fold", turnId: CHAT_TURN, label: "Worked for 10s", expanded: false });
    expect(r[1]).toMatchObject({ kind: "message", showAssistantMeta: true, assistantCopyStreaming: false });
  });

  it("the cut row and the notify row hide behind the fold like any work, and stand alone as notice rows when it opens", () => {
    const scoped = { ...scope, turnId: "turn_c" };
    const events: SessionEvent[] = [
      { type: "session.start", ...scoped, at: 1_000, prompt: "carry on", afterCut: true },
      { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "picking up where it stopped" },
      { type: "session.notify", ...scoped, at: 2_500, notify: "me", text: "thread thread_c finished (completed, 1.5s): picking up" },
      { type: "session.done", ...scoped, at: 3_000, result: { status: "completed", durationMs: 1500, text: "picking up where it stopped" } },
      { type: "session.end", ...scoped, at: 3_100, exitCode: 0, sawResult: true },
    ];
    expect(rows(events).map(x => x.kind)).toEqual(["message", "turn-fold", "message"]);
    const open = rows(events, { expandedTurnIds: new Set(["turn_c"]) });
    expect(open.map(x => x.kind)).toEqual(["message", "turn-fold", "work", "message", "work"]);
    const notices = open.filter(x => x.kind === "work").map(x => x.kind === "work" && x.groupedEntries.map(e => [e.tone, e.sourceActivityKind]));
    expect(notices).toEqual([[["notice", "runtime.resume"]], [["notice", "runtime.notify"]]]);
    expect(open[1]).toMatchObject({ kind: "turn-fold", label: "Worked for 1.5s" });
  });

  it("expanding the fold shows every entry: first message, the tool group toggle, the last message", () => {
    const r = rows(CHAT_STREAM, { expandedTurnIds: new Set([CHAT_TURN]) });
    expect(r.map(x => x.kind)).toEqual(["turn-fold", "message", "work-toggle", "message"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Ran 1 command", summaryKind: "command", hiddenCount: 2, hasFailure: false });
    expect(r[1]).toMatchObject({ kind: "message", showAssistantMeta: false });
  });

  it("reasoning rows carry a one-line preview and the full text, and a reasoning-only group reads Thinking", () => {
    const m = deriveSession([start, { type: "session.delta", ...scope, kind: "thinking", text: "first line of thought\nsecond line" }, { type: "session.delta", ...scope, kind: "thinking", text: " continues" }, done, end]);
    expect(m.workEntries[0]).toMatchObject({ tone: "thinking", preview: "first line of thought", detail: "first line of thought\nsecond line continues" });
    const r = rows([start, { type: "session.delta", ...scope, kind: "thinking", text: "quiet reasoning" }, done, end], { expandedTurnIds: new Set(["sess_t#1"]) });
    expect(r.map(x => x.kind)).toEqual(["message", "turn-fold", "work-toggle"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Thinking", summaryKind: "agent-tool", hiddenCount: 1 });
  });

  it("an empty reasoning marker stays neutral and out of the group", () => {
    const r = rows([start, { type: "session.delta", ...scope, kind: "thinking", text: "" }, tool("Bash", { command: "ls" }), result("ok"), done, end], { expandedTurnIds: new Set(["sess_t#1"]) });
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Ran 1 command", hiddenCount: 1 });
  });

  it("the live row names the reasoning when it came after the last tool", () => {
    const r = rows([start, tool("Bash", { command: "ls" }), result("ok"), { type: "session.delta", ...scope, kind: "thinking", text: "weighing the output" }]);
    const live = r.find(x => x.kind === "work-live");
    expect(live?.kind === "work-live" && live.entry.tone).toBe("thinking");
    expect(live?.kind === "work-live" && live.groupedEntries.map(e => e.tone)).toEqual(["tool", "thinking"]);
  });

  it("expanding the tool group appends the detail row with the thinking entry included", () => {
    const r = rows(CHAT_STREAM, { expandedTurnIds: new Set([CHAT_TURN]), expandedWorkGroupIds: new Set([`work-group:tool:${CHAT_TURN}:toolu_01WspFixBash1`]) });
    const detail = r.find(x => x.kind === "work");
    expect(detail).toMatchObject({ kind: "work", isExpandedToolGroup: true });
    expect(detail?.kind === "work" && detail.groupedEntries.map(e => e.tone)).toEqual(["tool", "thinking"]);
  });

  it("running turn: user message, working row, then a live row for the in-progress tool", () => {
    const r = rows([start, { type: "session.delta", ...scope, kind: "text", text: "On it." }, tool("Bash", { command: "pnpm test" })]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "message", "work-live"]);
    expect(r[3]).toMatchObject({ kind: "work-live", active: true, id: "live-activity-row" });
    expect(r[3]?.kind === "work-live" && r[3].entry.command).toBe("pnpm test");
  });

  it("running turn with nothing produced yet shows the working and thinking rows", () => {
    const r = rows([start]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "thinking"]);
  });

  it("a failed tool at the tail of a running turn is withheld until the turn reacts; the thinking row shows", () => {
    const r = rows([start, tool("Bash", { command: "false" }), result("exit 1", true)]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "thinking"]);
  });

  it("a failed tool followed by text is grouped with hasFailure", () => {
    const r = rows([start, tool("Bash", { command: "false" }), result("exit 1", true), { type: "session.delta", ...scope, kind: "text", text: "Retrying" }]);
    expect(r.map(x => x.kind)).toEqual(["message", "working", "work-toggle", "message", "thinking"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", hasFailure: true, summary: "Ran 1 command" });
  });

  it("an interrupted turn is labelled as stopped by the user", () => {
    const r = rows([start, tool("Bash", { command: "sleep 9" }), result("", false), { type: "session.done", ...scope, result: { status: "interrupted", durationMs: 4000 } }, end]);
    expect(r[1]).toMatchObject({ kind: "turn-fold", label: "You stopped after 4.0s" });
  });

  it("error rows never fold or group", () => {
    const r = rows([start, tool("Bash", { command: "x" }), result("ok"), { type: "session.done", ...scope, result: { status: "failed", error: "boom", durationMs: 100 } }, end]);
    expect(r.map(x => x.kind)).toEqual(["message", "turn-fold", "work"]);
    expect(r[2]?.kind === "work" && r[2].groupedEntries[0]?.tone).toBe("error");
  });

  it("snapshot: the chat fixture, settled and expanded", () => {
    expect(rows(CHAT_STREAM)).toMatchSnapshot();
    expect(rows(CHAT_STREAM, { expandedTurnIds: new Set([CHAT_TURN]) })).toMatchSnapshot();
  });

  it("snapshot: live run 1", () => {
    const m = deriveSession(liveEvents, { at: liveAt });
    expect(deriveMessagesTimelineRows({ timelineEntries: m.timeline, turns: m.turns, isWorking: m.running, activeTurnStartedAt: null })).toMatchSnapshot();
  });
});

describe("the turn's duration comes from the protocol's one formatter", () => {
  it.each([
    [0, "1ms"], [7, "7ms"], [999, "999ms"], [1500, "1.5s"], [9960, "10s"], [10458, "10s"], [59_400, "59s"], [60_000, "1m"], [101_515, "1m 42s"], [862_399, "14m 22s"], [-5, "0ms"], [4000, "4.0s"],
  ])("%d ms -> %s", (ms, text) => expect(fmtDuration(ms)).toBe(text));
});

describe("workEntryKind: the one rule a tool-like row's kind is read by", () => {
  const row = (extra: Partial<WorkLogEntry>): WorkLogEntry =>
    ({ id: "w", createdAt: "", turnId: "turn_k", label: "row", tone: "tool", sourceActivityKind: "tool.completed", ...extra });

  it.each<[string, Partial<WorkLogEntry>, ToolGroupSummaryKind | null]>([
    ["a file read", { requestKind: "file-read" }, "read"],
    ["a file change", { itemType: "file_change", changedFiles: ["/x/a.ts"] }, "edit"],
    ["a command", { itemType: "command_execution", command: "pnpm test" }, "command"],
    ["a code search", { toolTitle: "Grep" }, "code-search"],
    ["a web search", { itemType: "web_search" }, "search"],
    ["an MCP call", { itemType: "mcp_tool_call" }, "other"],
    ["a dynamic tool call", { itemType: "dynamic_tool_call" }, "dynamic-tool"],
    ["a subagent call", { itemType: "collab_agent_tool_call" }, "agent-tool"],
    ["a plain tool call with no item type, whose tone must say", {}, null],
    ["reasoning, whose tone must say", { tone: "thinking", detail: "weighing the options" }, null],
    ["a notice that is tool-like, whose tone must say", { tone: "notice", requestKind: "mcp-elicitation" }, null],
  ])("%s", (_name, extra, kind) => {
    expect(workEntryKind(row(extra))).toBe(kind);
  });

  it("a group's kind is its rows' one kind, the tone standing in where no item type does, and mixed otherwise", () => {
    expect(toolGroupSummaryKind([row({ itemType: "mcp_tool_call" })])).toBe("other");
    expect(toolGroupSummaryKind([row({ itemType: "dynamic_tool_call" }), row({ itemType: "dynamic_tool_call" })])).toBe("dynamic-tool");
    expect(toolGroupSummaryKind([row({ itemType: "collab_agent_tool_call" })])).toBe("agent-tool");
    expect(toolGroupSummaryKind([row({})])).toBe("tone-tool");
    expect(toolGroupSummaryKind([row({ tone: "thinking" })])).toBe("agent-tool");
    expect(toolGroupSummaryKind([row({ tone: "notice", requestKind: "mcp-elicitation" })])).toBe("other");
    expect(toolGroupSummaryKind([row({ itemType: "mcp_tool_call" }), row({ itemType: "dynamic_tool_call" })])).toBe("mixed");
    expect(toolGroupSummaryKind([row({ itemType: "mcp_tool_call" }), row({ tone: "thinking" })])).toBe("mixed");
    expect(toolGroupSummaryKind([row({ itemType: "command_execution", command: "ls" }), row({ tone: "thinking" })])).toBe("command");
  });

  it("every action a summary can name comes from a fact the adapter reads off the wire", () => {
    expectTypeOf<ToolGroupAction>().toEqualTypeOf<"read" | "edit" | "command" | "code-search" | "search" | "other" | "update">();
  });
});

describe("deriveSession: a thread's end told where its start said", () => {
  const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_n", threadId: "thread_child_0001" };
  const line = "thread thread_c finished (completed, 8m 12s, $1.94): all green";
  const events = (notify: string): SessionEvent[] => [
    { type: "session.start", ...scoped, at: 1_000, prompt: "build it" },
    { type: "session.delta", ...scoped, at: 2_000, kind: "text", text: "all green" },
    { type: "session.notify", ...scoped, at: 2_999, notify, text: line },
    { type: "session.done", ...scoped, at: 3_000, result: { status: "completed", durationMs: 492_000, costUsd: 1.94, text: "all green" } },
    { type: "session.end", ...scoped, at: 3_100, exitCode: 0, sawResult: true },
  ];

  it("is one notice work row in the turn naming the thread told, with the line as its detail", () => {
    const model = deriveSession(events("thread_parent_0001"));
    const rows = model.workEntries.filter(w => w.sourceActivityKind === "runtime.notify");
    expect(rows.map(w => [w.label, w.detail, w.tone, w.turnId])).toEqual([["told thread thread_p", line, "notice", "turn_n"]]);
    expect(model.turns[0]).toMatchObject({ state: "completed", durationMs: 492_000, costUsd: 1.94 });
  });

  it("names the person when the start said me", () => {
    const model = deriveSession(events("me"));
    expect(model.workEntries.filter(w => w.sourceActivityKind === "runtime.notify").map(w => w.label)).toEqual(["told you"]);
  });
});
