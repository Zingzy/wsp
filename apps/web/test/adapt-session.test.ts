// SPDX-License-Identifier: AGPL-3.0-only
// Session events into the chat view models: messages, work rows, turn
// summaries and the timeline rows the transplanted MessagesTimeline renders.
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { deriveMessagesTimelineRows, deriveSession, formatDuration } from "../src/adapt/index.js";
import type { WorkLogEntry } from "../src/adapt/index.js";
import { CHAT_STREAM } from "./fixtures/chat-stream.js";
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

describe("deriveSession: the chat fixture", () => {
  const model = deriveSession(CHAT_STREAM);

  it("folds contiguous text deltas into one assistant message and starts a new one after a tool", () => {
    expect(model.messages.map(m => [m.role, m.text])).toEqual([
      ["assistant", "Creating the server file, then starting it."],
      ["assistant", "Server is live at :3000."],
    ]);
    expect(model.messages.every(m => !m.streaming)).toBe(true);
    expect(model.messages.every(m => m.turnId === "sess_0001#1")).toBe(true);
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
    expect(thinking).toMatchObject({ tone: "thinking", label: "Thinking", detail: "curl returned the greeting, so the server is live.", sourceActivityKind: "reasoning" });
  });

  it("summarises the turn from session.done and clears running on session.end", () => {
    expect(model.turns).toEqual([
      expect.objectContaining({ turnId: "sess_0001#1", state: "completed", durationMs: 10458, costUsd: 0.0187, model: "claude-sonnet-4-5", prompt: null }),
    ]);
    expect(model.running).toBe(false);
    expect(model.latestTurn?.turnId).toBe("sess_0001#1");
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

  it("keeps the assistant message streaming only while it is the newest thing in a running turn", () => {
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

  it("stamps createdAt from the caller's clock and leaves it empty when there is none", () => {
    const stamped = deriveSession(CHAT_STREAM, { at: (_e, i) => `2026-09-01T00:00:0${i}Z` });
    expect(stamped.messages[0]?.createdAt).toBe("2026-09-01T00:00:01Z");
    expect(stamped.messages[0]?.updatedAt).toBe("2026-09-01T00:00:02Z");
    expect(stamped.turns[0]).toMatchObject({ startedAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T00:00:07Z" });
    expect(deriveSession(CHAT_STREAM).messages[0]?.createdAt).toBe("");
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
    expect(r[0]).toMatchObject({ kind: "turn-fold", turnId: "sess_0001#1", label: "Worked for 10s", expanded: false });
    expect(r[1]).toMatchObject({ kind: "message", showAssistantMeta: true, assistantCopyStreaming: false });
  });

  it("expanding the fold shows every entry: first message, the tool group toggle, the last message", () => {
    const r = rows(CHAT_STREAM, { expandedTurnIds: new Set(["sess_0001#1"]) });
    expect(r.map(x => x.kind)).toEqual(["turn-fold", "message", "work-toggle", "message"]);
    expect(r[2]).toMatchObject({ kind: "work-toggle", summary: "Ran 1 command", summaryKind: "command", hiddenCount: 1, hasFailure: false });
    expect(r[1]).toMatchObject({ kind: "message", showAssistantMeta: false });
  });

  it("expanding the tool group appends the detail row with the thinking entry included", () => {
    const r = rows(CHAT_STREAM, { expandedTurnIds: new Set(["sess_0001#1"]), expandedWorkGroupIds: new Set(["work-group:tool:sess_0001#1:toolu_01WspFixBash1"]) });
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
    expect(rows(CHAT_STREAM, { expandedTurnIds: new Set(["sess_0001#1"]) })).toMatchSnapshot();
  });

  it("snapshot: live run 1", () => {
    const m = deriveSession(liveEvents, { at: liveAt });
    expect(deriveMessagesTimelineRows({ timelineEntries: m.timeline, turns: m.turns, isWorking: m.running, activeTurnStartedAt: null })).toMatchSnapshot();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "1ms"], [7, "7ms"], [999, "999ms"], [1500, "1.5s"], [9960, "10s"], [10458, "10s"], [59_400, "59s"], [60_000, "1m"], [101_515, "1m 42s"], [862_399, "14m 22s"], [-5, "0ms"], [4000, "4.0s"],
  ])("%d ms -> %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
});
