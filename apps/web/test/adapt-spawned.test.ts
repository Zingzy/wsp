// SPDX-License-Identifier: AGPL-3.0-only
// A call in a lead's transcript that started a child is drawn as that child's row: the run or fork, through the
// tool or the command line, by the thread its answer names, in either shape Claude Code writes that answer; and an
// Agent call by the subagent it launched. A call naming no child of this lead stays a tool row.
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { deriveMessagesTimelineRows, deriveSession, type MessagesTimelineRow } from "../src/adapt/index.js";
import { spawnedThreadOf, type SpawnedChildren } from "../src/adapt/spawned.js";

const scope = { workspaceId: "ws_lead", sessionId: "sess_lead", turnId: "turn_lead" };
const CHILD = "7f3c2a10-5b2e-4c11-9d3a-0a1b2c3d4e5f";
const OTHER = "2b9e6d44-1c3f-4a2b-8e5d-6f7a8b9c0d1e";
const STRANGER = "0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a00";

const start: SessionEvent = { type: "session.start", ...scope, at: 1_000, prompt: "start the builders" };
const call = (id: string, toolName: string, input: unknown): SessionEvent => ({ type: "session.delta", ...scope, at: 2_000, kind: "tool_use", toolName, toolUseId: id, text: JSON.stringify(input) });
// What a real result row carries: no tool name, only the call it answers.
const answer = (id: string, text: string, isError = false): SessionEvent => ({ type: "session.delta", ...scope, at: 3_000, kind: "tool_result", toolUseId: id, text, isError });
const say = (text: string): SessionEvent => ({ type: "session.delta", ...scope, at: 4_000, kind: "text", text });
const done: SessionEvent[] = [
  { type: "session.done", ...scope, at: 5_000, result: { status: "completed" } },
  { type: "session.end", ...scope, at: 5_000, exitCode: 0, sawResult: true },
];

const runJson = (thread: string) => JSON.stringify({ threadId: thread, workspaceId: "ws_lead", harness: "claude", outcome: "started" });
const mcpRun = (id: string, answerText: string): SessionEvent[] => [call(id, "mcp__wsp__run", { project: "lab", message: "build it", notify: "me", detach: true }), answer(id, answerText)];
const cliRun = (id: string, answerText: string): SessionEvent[] => [call(id, "Bash", { command: "wsp run --project lab --notify me --detach 'build it'", description: "Start a builder" }), answer(id, answerText)];

const children = (threads: string[], subagents: string[] = []): SpawnedChildren => ({ lead: "thr_lead", threads: new Set(threads), subagents: new Set(subagents) });

/** The lead's rows as the transcript draws them while its turn still runs, so nothing folds behind Worked for. */
function rows(events: SessionEvent[], known: SpawnedChildren, isWorking = true): MessagesTimelineRow[] {
  const model = deriveSession(events);
  return deriveMessagesTimelineRows({ timelineEntries: model.timeline, turns: model.turns, isWorking, activeTurnStartedAt: null, children: known });
}

/** Whether a call stands as today's tool row: alone, or in the group of calls it folds into. */
const toolRow = (drawn: MessagesTimelineRow[], call: string): boolean =>
  drawn.some(row => (row.kind === "work-toggle" && row.groupId.endsWith(`:${call}`)) || (row.kind === "work" && row.groupedEntries.some(e => e.toolCallId === call)));

const spawnRows = (drawn: MessagesTimelineRow[]) => drawn.flatMap(row => (row.kind === "spawn" ? [row.calls.map(c => ("thread" in c ? c.thread : `subagent:${c.subagent}`))] : []));

describe("spawnedThreadOf: the thread a start's answer names", () => {
  it("reads the run tool's JSON, the fork tool's turn and the text line Claude Code writes behind its flag", () => {
    expect(spawnedThreadOf("mcp__wsp__run", undefined, runJson(CHILD))).toBe(CHILD);
    expect(spawnedThreadOf("mcp__wsp__fork", undefined, JSON.stringify({ workspace: { id: "ws_fork" }, turn: { threadId: CHILD, outcome: "started" } }))).toBe(CHILD);
    expect(spawnedThreadOf("mcp__wsp__run", undefined, `thread ${CHILD} on lab in ~/lab`)).toBe(CHILD);
    expect(spawnedThreadOf("mcp__wsp__run", undefined, `thread ${CHILD} in ~/lab\nheld: acme's laptop is running 6 of 6 threads`)).toBe(CHILD);
  });

  it("reads the command line's text and its --json result line, in a chain of commands", () => {
    expect(spawnedThreadOf("Bash", "cd ~/lab && wsp run --detach 'build it'", `thread ${CHILD} on lab in ~/lab  (a prefix of the id is enough)`)).toBe(CHILD);
    expect(spawnedThreadOf("Bash", "wsp fork lab --json", `{"workspace":{"id":"ws_f"}}\n${JSON.stringify({ workspace: { id: "ws_f" }, turn: { threadId: CHILD } })}`)).toBe(CHILD);
  });

  it("reads a Codex lead's answer, which its adapter writes as the JSON of the MCP content blocks", () => {
    // packages/adapter-codex/src/adapter.ts writes an MCP call's result as JSON.stringify(result.content).
    expect(spawnedThreadOf("mcp__wsp__run", undefined, `[{"type":"text","text":"thread ${CHILD} on lab in ~/lab"}]`)).toBe(CHILD);
    expect(spawnedThreadOf("mcp__wsp__fork", undefined, JSON.stringify([{ type: "text", text: JSON.stringify({ workspace: { id: "ws_fork" }, turn: { threadId: CHILD } }) }]))).toBe(CHILD);
  });

  it("reads wsp at any path and inside a shell's -c script, and not the words of a quoted string", () => {
    const said = `thread ${CHILD} in ~/lab`;
    expect(spawnedThreadOf("Bash", "~/.local/bin/wsp run --detach 'build it'", said)).toBe(CHILD);
    expect(spawnedThreadOf("command_execution", `/bin/bash -lc 'cd ~/lab && wsp run --detach "build it"'`, said)).toBe(CHILD);
    expect(spawnedThreadOf("Bash", 'git commit -m "docs: wsp run takes --detach"', said)).toBeUndefined();
    expect(spawnedThreadOf("Bash", "echo 'wsp fork lab'", said)).toBeUndefined();
  });

  it("reads nothing off a call that starts no thread, or a start that answered with none", () => {
    expect(spawnedThreadOf("Bash", "echo thread", `thread ${CHILD} in ~/lab`)).toBeUndefined();
    expect(spawnedThreadOf("mcp__wsp__threads", undefined, runJson(CHILD))).toBeUndefined();
    expect(spawnedThreadOf("mcp__wsp__fork", undefined, JSON.stringify({ workspace: { id: "ws_fork" } }))).toBeUndefined();
  });
});

describe("a call that started a child of this lead is that child's row", () => {
  it("maps a run through the MCP tool, answered in JSON, to its child", () => {
    expect(spawnRows(rows([start, ...mcpRun("tu_1", runJson(CHILD)), say("One builder is out.")], children([CHILD])))).toEqual([[CHILD]]);
  });

  it("maps a run through the MCP tool, answered with the text line, to its child", () => {
    expect(spawnRows(rows([start, ...mcpRun("tu_1", `thread ${CHILD} on lab in ~/lab`), say("One builder is out.")], children([CHILD])))).toEqual([[CHILD]]);
  });

  it("maps wsp run on the command line to its child", () => {
    expect(spawnRows(rows([start, ...cliRun("tu_1", `thread ${CHILD} on lab in ~/lab  (a prefix of the id is enough)`), say("One builder is out.")], children([CHILD])))).toEqual([[CHILD]]);
  });

  it("maps a Codex lead's run through the MCP tool, answered as its content blocks, to its child", () => {
    const codex = [call("call_1", "mcp__wsp__run", { project: "lab", message: "build it", detach: true }), answer("call_1", `[{"type":"text","text":"thread ${CHILD} on lab in ~/lab"}]`)];
    expect(spawnRows(rows([start, ...codex, say("One builder is out.")], children([CHILD])))).toEqual([[CHILD]]);
  });

  it("maps an Agent call to the subagent it launched, before its first line and once its lines are in", () => {
    const agent = call("tu_agent", "Agent", { description: "Read the open tickets", prompt: "Read them", subagent_type: "Explore" });
    expect(spawnRows(rows([start, agent], children([], ["tu_agent"])))).toEqual([["subagent:tu_agent"]]);
    const lines: SessionEvent[] = [
      agent,
      { type: "session.subagent", ...scope, at: 2_000, task: "task_1", state: "running", parentToolUseId: "tu_agent", title: "Read the open tickets" },
      { type: "session.delta", ...scope, at: 2_500, kind: "text", text: "Listing them.", parentToolUseId: "tu_agent" },
    ];
    expect(spawnRows(rows([start, ...lines], children([], ["tu_agent"])))).toEqual([["subagent:tu_agent"]]);
  });

  it("draws the calls one turn makes in a row as one list, and a reply between them splits it", () => {
    const three = [...mcpRun("tu_1", runJson(CHILD)), ...cliRun("tu_2", `thread ${OTHER} in ~/lab`)];
    expect(spawnRows(rows([start, ...three, say("Two are out.")], children([CHILD, OTHER])))).toEqual([[CHILD, OTHER]]);
    expect(spawnRows(rows([start, ...mcpRun("tu_1", runJson(CHILD)), say("One is out."), ...mcpRun("tu_2", runJson(OTHER)), say("Two.")], children([CHILD, OTHER])))).toEqual([[CHILD], [OTHER]]);
  });

  it("keeps a start at the running turn's end as the child's row, not folded into the live tool row", () => {
    const read = [call("tu_r", "Read", { file_path: "a.ts" }), answer("tu_r", "12 lines")];
    expect(spawnRows(rows([start, ...read, ...mcpRun("tu_1", runJson(CHILD))], children([CHILD])))).toEqual([[CHILD]]);
  });

  it("folds with its turn once the turn is over, as every call does", () => {
    expect(spawnRows(rows([start, ...mcpRun("tu_1", runJson(CHILD)), say("One is out."), ...done], children([CHILD]), false))).toEqual([]);
  });
});

describe("a call naming no child of this lead stays a tool row", () => {
  it("leaves a run whose thread is not this lead's child, or has left the listing, as its tool row", () => {
    const drawn = rows([start, ...mcpRun("tu_1", runJson(STRANGER)), say("Out.")], children([CHILD]));
    expect(spawnRows(drawn)).toEqual([]);
    expect(toolRow(drawn, "tu_1")).toBe(true);
  });

  it("leaves a refused run its error row", () => {
    const drawn = rows([start, call("tu_1", "mcp__wsp__run", { project: "lab", message: "x" }), answer("tu_1", "acme's laptop is running 6 of 6 threads", true), say("Held.")], children([CHILD]));
    expect(spawnRows(drawn)).toEqual([]);
    expect(drawn.some(row => row.kind === "work" && row.groupedEntries.some(e => e.tone === "error"))).toBe(true);
  });

  it("leaves a subagent with no child row its fold", () => {
    const lines: SessionEvent[] = [
      call("tu_agent", "Agent", { description: "Read", prompt: "Read", subagent_type: "Explore" }),
      { type: "session.delta", ...scope, at: 2_500, kind: "text", text: "Listing them.", parentToolUseId: "tu_agent" },
    ];
    const drawn = rows([start, ...lines], children([]));
    expect(spawnRows(drawn)).toEqual([]);
    expect(drawn.some(row => row.kind === "subagent")).toBe(true);
  });
});
