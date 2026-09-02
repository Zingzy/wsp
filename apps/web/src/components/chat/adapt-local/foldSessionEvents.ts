// SPDX-License-Identifier: AGPL-3.0-only
// Folds wsp session events into the chat view model. One wsp session is one
// turn; a conversation is a chain of sessions resumed through the workspace's
// claudeSessionId, so successive sessions accumulate into one thread. The wire
// carries no timestamps, so `at` is the arrival time and is nudged forward by
// a millisecond when two events share one, which keeps sort order stable.
import type { EventUnion, SessionEvent, TurnResult } from "@wsp/protocol";
import { deriveTimelineEntries } from "./sessionLogic";
import type { ChatMessage, LatestTurn, TimelineEntry, ToolLifecycleItemType, TurnId, WorkLogEntry } from "./types";

export interface ChatThreadState {
  readonly workspaceId: string | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly latestTurn: LatestTurn | null;
  readonly runningTurnId: TurnId | null;
  readonly turnResults: Readonly<Record<TurnId, TurnResult>>;
  readonly model: string | null;
  readonly cwd: string | null;
  readonly lastAt: string | null;
  readonly seq: number;
}

export interface ChatThreadView {
  readonly entries: TimelineEntry[];
  readonly latestTurn: LatestTurn | null;
  readonly runningTurnId: TurnId | null;
  readonly activeTurnStartedAt: string | null;
  /** The latest turn's result once it has one; null while it runs or before any turn. */
  readonly settled: TurnResult | null;
  readonly cwd: string | null;
}

export const emptyChatThread: ChatThreadState = {
  workspaceId: null,
  messages: [],
  workEntries: [],
  latestTurn: null,
  runningTurnId: null,
  turnResults: {},
  model: null,
  cwd: null,
  lastAt: null,
  seq: 0,
};

const SESSION_TYPES: ReadonlySet<string> = new Set(["session.start", "session.delta", "session.done", "session.end"]);

export function isSessionEvent(e: EventUnion): e is SessionEvent {
  return SESSION_TYPES.has(e.type);
}

const PENDING_TURN = "pending";

function stamp(state: ChatThreadState, at: string): { at: string; state: ChatThreadState } {
  const last = state.lastAt;
  let next = at;
  if (last !== null && Date.parse(at) <= Date.parse(last)) {
    next = new Date(Date.parse(last) + 1).toISOString();
  }
  return { at: next, state: { ...state, lastAt: next, seq: state.seq + 1 } };
}

function nextId(state: ChatThreadState, prefix: string): string {
  return `${prefix}:${state.seq}`;
}

export function appendUserTurn(state: ChatThreadState, prompt: string, at: string): ChatThreadState {
  const s = stamp(state, at);
  const message: ChatMessage = {
    id: nextId(s.state, "user"),
    role: "user",
    text: prompt,
    turnId: PENDING_TURN,
    streaming: false,
    createdAt: s.at,
    updatedAt: s.at,
  };
  return { ...s.state, messages: [...s.state.messages, message] };
}

/** A send that failed before the runtime ever emitted events for it. */
export function appendLocalError(state: ChatThreadState, message: string, at: string): ChatThreadState {
  const s = stamp(state, at);
  const entry: WorkLogEntry = {
    id: nextId(s.state, "local-error"),
    createdAt: s.at,
    turnId: null,
    label: message,
    tone: "error",
    sourceActivityKind: "runtime.error",
  };
  return { ...s.state, workEntries: [...s.state.workEntries, entry], runningTurnId: null };
}

export function replaySessionEvents(events: ReadonlyArray<SessionEvent>, at: string): ChatThreadState {
  let state = emptyChatThread;
  for (const e of events) state = applySessionEvent(state, e, at);
  return state;
}

export function applySessionEvent(state: ChatThreadState, e: EventUnion, at: string): ChatThreadState {
  if (!isSessionEvent(e)) return state;
  if (state.workspaceId !== null && e.workspaceId !== state.workspaceId) return state;
  const bound = state.workspaceId === null ? { ...state, workspaceId: e.workspaceId } : state;
  switch (e.type) {
    case "session.start":
      return startTurn(bound, e, at);
    case "session.delta":
      return applyDelta(bound, e, at);
    case "session.done":
      return settleTurn(bound, e.sessionId, e.result, at);
    case "session.end": {
      if (e.sawResult) return { ...bound, runningTurnId: bound.runningTurnId === e.sessionId ? null : bound.runningTurnId };
      if (bound.turnResults[e.sessionId] !== undefined) return bound;
      const error = `session exited without a result (exit code ${e.exitCode ?? "unknown"})`;
      return settleTurn(bound, e.sessionId, { status: "failed", error }, at);
    }
    default: {
      const _exhaustive: never = e;
      return bound;
    }
  }
}

function startTurn(state: ChatThreadState, e: Extract<SessionEvent, { type: "session.start" }>, at: string): ChatThreadState {
  const s = stamp(state, at);
  let messages = s.state.messages;
  const pending = messages.findLast(m => m.role === "user" && m.turnId === PENDING_TURN);
  if (pending !== undefined && (e.prompt === undefined || pending.text === e.prompt)) {
    messages = messages.map(m => (m === pending ? { ...m, turnId: e.sessionId } : m));
  } else if (e.prompt !== undefined) {
    messages = [
      ...messages,
      { id: nextId(s.state, "user"), role: "user", text: e.prompt, turnId: e.sessionId, streaming: false, createdAt: s.at, updatedAt: s.at },
    ];
  }
  return {
    ...s.state,
    messages,
    model: e.model ?? s.state.model,
    cwd: e.cwd ?? s.state.cwd,
    runningTurnId: e.sessionId,
    latestTurn: {
      turnId: e.sessionId,
      state: "running",
      requestedAt: s.at,
      startedAt: s.at,
      completedAt: null,
      assistantMessageId: null,
    },
  };
}

const TOOL_ITEM_TYPES: Readonly<Record<string, ToolLifecycleItemType>> = {
  Bash: "command_execution",
  Edit: "file_change",
  MultiEdit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  WebSearch: "web_search",
  WebFetch: "web_search",
  Task: "collab_agent_tool_call",
};

function parseToolInput(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Claude Code tool inputs: the fields the row label, command and changed-files chrome read. */
function toolEntryFields(toolName: string, input: Record<string, unknown> | null, rawText: string): Partial<WorkLogEntry> {
  const filePath = str(input?.file_path) ?? str(input?.path) ?? str(input?.notebook_path);
  switch (toolName) {
    case "Bash":
      return { command: str(input?.command) ?? rawText, detail: str(input?.description) };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return filePath !== undefined ? { changedFiles: [filePath], detail: filePath } : { detail: rawText };
    case "Read":
      return { detail: filePath ?? rawText, requestKind: "file-read" };
    case "Glob":
    case "Grep":
      return { detail: str(input?.pattern) ?? rawText };
    case "WebFetch":
      return { detail: str(input?.url) ?? rawText };
    case "WebSearch":
      return { detail: str(input?.query) ?? rawText };
    case "Task":
      return { detail: str(input?.description) ?? rawText, agentRole: str(input?.subagent_type) };
    default:
      return { detail: input === null ? rawText : JSON.stringify(input, null, 2) };
  }
}

function applyDelta(state: ChatThreadState, e: Extract<SessionEvent, { type: "session.delta" }>, at: string): ChatThreadState {
  const s = stamp(state, at);
  const turnId = e.sessionId;
  switch (e.kind) {
    case "text": {
      const messages = [...s.state.messages];
      const index = messages.findLastIndex(m => m.role === "assistant" && m.turnId === turnId);
      if (index >= 0) {
        const current = messages[index]!;
        const lastWork = s.state.workEntries.at(-1);
        const toolSinceText = lastWork !== undefined && lastWork.turnId === turnId && lastWork.createdAt > current.updatedAt;
        const sep = toolSinceText && current.text.length > 0 && !current.text.endsWith("\n") ? "\n\n" : "";
        messages[index] = { ...current, text: `${current.text}${sep}${e.text}`, updatedAt: s.at };
        return { ...s.state, messages };
      }
      const id = nextId(s.state, "assistant");
      messages.push({ id, role: "assistant", text: e.text, turnId, streaming: true, createdAt: s.at, updatedAt: s.at });
      const latestTurn = s.state.latestTurn?.turnId === turnId ? { ...s.state.latestTurn, assistantMessageId: id } : s.state.latestTurn;
      return { ...s.state, messages, latestTurn };
    }
    case "thinking": {
      const entries = [...s.state.workEntries];
      const last = entries.at(-1);
      if (last !== undefined && last.tone === "thinking" && last.turnId === turnId) {
        entries[entries.length - 1] = { ...last, detail: `${last.detail ?? ""}${e.text}` };
        return { ...s.state, workEntries: entries };
      }
      entries.push({ id: nextId(s.state, "thinking"), createdAt: s.at, turnId, label: "Thinking", detail: e.text, tone: "thinking", sourceActivityKind: "reasoning" });
      return { ...s.state, workEntries: entries };
    }
    case "tool_use": {
      const toolName = e.toolName ?? "tool";
      const input = parseToolInput(e.text);
      const itemType = TOOL_ITEM_TYPES[toolName];
      const entry: WorkLogEntry = {
        id: nextId(s.state, "tool"),
        createdAt: s.at,
        turnId,
        label: toolName,
        toolTitle: toolName,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        sourceActivityKind: "tool.started",
        ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
        ...(itemType !== undefined ? { itemType } : {}),
        ...(input !== null ? { toolData: input } : {}),
        ...stripUndefined(toolEntryFields(toolName, input, e.text)),
      };
      return { ...s.state, workEntries: [...s.state.workEntries, entry] };
    }
    case "tool_result": {
      const entries = [...s.state.workEntries];
      const index = e.toolUseId === undefined ? -1 : entries.findLastIndex(w => w.toolCallId === e.toolUseId);
      const status = e.isError === true ? "failed" : "completed";
      if (index < 0) {
        entries.push({
          id: nextId(s.state, "tool-result"),
          createdAt: s.at,
          turnId,
          label: "Tool result",
          detail: e.text,
          tone: "tool",
          toolLifecycleStatus: status,
          sourceActivityKind: "tool.completed",
        });
        return { ...s.state, workEntries: entries };
      }
      const current = entries[index]!;
      entries[index] = {
        ...current,
        ...(e.text.length > 0 ? { detail: e.text } : {}),
        toolLifecycleStatus: status,
        sourceActivityKind: "tool.completed",
      };
      return { ...s.state, workEntries: entries };
    }
    default: {
      const _exhaustive: never = e.kind;
      return s.state;
    }
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function settleTurn(state: ChatThreadState, turnId: TurnId, result: TurnResult, at: string): ChatThreadState {
  const s = stamp(state, at);
  let messages = s.state.messages.map(m => (m.role === "assistant" && m.turnId === turnId ? { ...m, streaming: false, updatedAt: s.at } : m));
  const hasAssistant = messages.some(m => m.role === "assistant" && m.turnId === turnId);
  if (!hasAssistant && result.text !== undefined && result.text.length > 0) {
    messages = [...messages, { id: nextId(s.state, "assistant"), role: "assistant", text: result.text, turnId, streaming: false, createdAt: s.at, updatedAt: s.at }];
  }
  let workEntries = s.state.workEntries.map(w =>
    w.turnId === turnId && w.toolLifecycleStatus === "inProgress" ? { ...w, toolLifecycleStatus: "stopped" as const } : w,
  );
  if (result.error !== undefined && result.error.length > 0) {
    workEntries = [...workEntries, { id: nextId(s.state, "turn-error"), createdAt: s.at, turnId, label: result.error, tone: "error", sourceActivityKind: "runtime.error" }];
  }
  const turnState: LatestTurn["state"] = result.status === "completed" ? "completed" : result.status === "interrupted" ? "interrupted" : "error";
  const latestTurn: LatestTurn =
    s.state.latestTurn?.turnId === turnId
      ? { ...s.state.latestTurn, state: turnState, completedAt: s.at }
      : { turnId, state: turnState, requestedAt: s.at, startedAt: s.at, completedAt: s.at, assistantMessageId: null };
  return {
    ...s.state,
    messages,
    workEntries,
    latestTurn,
    runningTurnId: s.state.runningTurnId === turnId ? null : s.state.runningTurnId,
    turnResults: { ...s.state.turnResults, [turnId]: result },
  };
}

export function deriveChatThread(state: ChatThreadState): ChatThreadView {
  const latestTurn = state.latestTurn;
  const settled = latestTurn !== null && latestTurn.state !== "running" ? (state.turnResults[latestTurn.turnId] ?? null) : null;
  return {
    entries: deriveTimelineEntries(state.messages, [], state.workEntries),
    latestTurn,
    runningTurnId: state.runningTurnId,
    activeTurnStartedAt: state.runningTurnId !== null && latestTurn?.turnId === state.runningTurnId ? latestTurn.startedAt : null,
    settled,
    cwd: state.cwd,
  };
}
