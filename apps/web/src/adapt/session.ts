// SPDX-License-Identifier: AGPL-3.0-only
// Session events into chat view models. Ported from t3code session-logic.ts
// (deriveWorkLogEntries, deriveTimelineEntries; commit 57a66608) against
// @wsp/protocol's SessionEvent. One wsp session run is one turn, keyed by the
// runtime's turnId; events from before the runtime stamped one fall back to
// the session id plus the ordinal of its session.start, since a resumed Claude
// session id repeats across turns. Wire order is the timeline order. createdAt
// is the wire's `at` (ms epoch) as ISO, else the caller's receipt clock, else
// "" for unstamped history.
import { NOTIFY_ME, type SessionEvent, type SessionHarness, type TurnResult } from "@wsp/protocol";
import type {
  ChatMessage,
  ProviderRequestKind,
  TimelineEntry,
  ToolLifecycleItemType,
  TurnState,
  TurnSummary,
  WorkLogEntry,
} from "./view-model.js";

export interface SessionModel {
  readonly turns: ReadonlyArray<TurnSummary>;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly timeline: ReadonlyArray<TimelineEntry>;
  readonly latestTurn: TurnSummary | null;
  readonly running: boolean;
  readonly model: string | null;
  /** What the CLI announced about itself on the last session.start that carried it. */
  readonly harness: SessionHarness | null;
}

export interface DeriveSessionOptions {
  /** Receipt clock for an event without a wire `at`; undefined leaves createdAt empty. */
  readonly at?: (event: SessionEvent, index: number) => string | undefined;
}

type SessionDelta = Extract<SessionEvent, { type: "session.delta" }>;

interface ToolCall {
  readonly entryIndex: number;
  input: string;
}

interface TurnBuild {
  summary: TurnSummary;
  readonly startCount: number;
  ordinal: number;
  /** Index into `timeline` of the assistant message still accepting text, if the tail is one. */
  openMessage: number | null;
  sawText: boolean;
  tools: Map<string, ToolCall>;
  /** Tool calls without an id resolve to the newest open one, as the CLI streams them in order. */
  openAnonymousTool: number | null;
}

export function deriveSession(events: ReadonlyArray<SessionEvent>, options: DeriveSessionOptions = {}): SessionModel {
  const timeline: TimelineEntry[] = [];
  const turns: TurnSummary[] = [];
  const startsBySession = new Map<string, number>();
  let turn: TurnBuild | null = null;
  let model: string | null = null;
  let harness: SessionHarness | null = null;

  const push = (entry: TimelineEntry): number => {
    timeline.push(entry);
    return timeline.length - 1;
  };
  const replace = (index: number, entry: TimelineEntry): void => {
    timeline[index] = entry;
  };
  const message = (index: number): ChatMessage | undefined => {
    const entry = timeline[index];
    return entry?.kind === "message" ? entry.message : undefined;
  };
  const work = (index: number): WorkLogEntry | undefined => {
    const entry = timeline[index];
    return entry?.kind === "work" ? entry.entry : undefined;
  };
  const closeOpenMessage = (t: TurnBuild): void => {
    if (t.openMessage === null) return;
    const m = message(t.openMessage);
    if (m && m.streaming) replace(t.openMessage, messageEntry({ ...m, streaming: false }));
    t.openMessage = null;
  };
  const addWork = (t: TurnBuild, entry: Omit<WorkLogEntry, "id" | "turnId">, at: string): number => {
    t.ordinal += 1;
    const full: WorkLogEntry = { ...entry, id: `${t.summary.turnId}:w${t.ordinal}`, turnId: t.summary.turnId };
    return push({ id: full.id, kind: "work", createdAt: at, entry: full });
  };
  const addMessage = (t: TurnBuild, role: ChatMessage["role"], text: string, at: string, streaming: boolean, steered = false): number => {
    t.ordinal += 1;
    const m: ChatMessage = { id: `${t.summary.turnId}:m${t.ordinal}`, role, text, turnId: t.summary.turnId, streaming, createdAt: at, updatedAt: at, ...(steered ? { steered } : {}) };
    return push(messageEntry(m));
  };
  const finishTurn = (t: TurnBuild, result: TurnResult, at: string): void => {
    closeOpenMessage(t);
    for (const call of t.tools.values()) {
      const w = work(call.entryIndex);
      if (w && w.toolLifecycleStatus === "inProgress") {
        replace(call.entryIndex, workEntry({ ...w, toolLifecycleStatus: "stopped" }, timeline[call.entryIndex]!.createdAt));
      }
    }
    if (result.status === "completed" && !t.sawText && result.text !== undefined && result.text.length > 0) {
      addMessage(t, "assistant", result.text, at, false);
    }
    if (result.status === "failed") {
      const label = result.error ?? "session failed";
      addWork(t, { createdAt: at, label, tone: "error", sourceActivityKind: "runtime.error" }, at);
    }
    t.summary = {
      ...t.summary,
      state: turnState(result.status),
      durationMs: result.durationMs ?? null,
      costUsd: result.costUsd ?? null,
      error: result.error ?? null,
      completedAt: at || null,
    };
    turns[turns.length - 1] = t.summary;
  };

  const openTurn = (event: SessionEvent, turnId: string, count: number, at: string): TurnBuild => {
    const start = event.type === "session.start" ? event : null;
    const summary: TurnSummary = {
      turnId,
      sessionId: event.sessionId,
      state: "running",
      prompt: start?.prompt ?? null,
      model: start?.model ?? null,
      durationMs: null,
      costUsd: null,
      error: null,
      startedAt: at || null,
      completedAt: null,
    };
    turns.push(summary);
    return { summary, startCount: count, ordinal: 0, openMessage: null, sawText: false, tools: new Map(), openAnonymousTool: null };
  };
  /** A delta, done or end whose turn never started here (history capped mid-turn) still needs a turn to hang on. */
  const turnFor = (event: SessionEvent, at: string): TurnBuild => {
    if (turn !== null && (event.turnId === undefined || event.turnId === turn.summary.turnId)) return turn;
    if (turn !== null && turn.summary.state === "running") finishTurn(turn, { status: "failed", error: "session restarted before it finished" }, at);
    turn = openTurn(event, event.turnId ?? `${event.sessionId}#0`, 0, at);
    return turn;
  };

  for (const [index, event] of events.entries()) {
    const at = event.at !== undefined ? new Date(event.at).toISOString() : options.at?.(event, index) ?? "";
    switch (event.type) {
      case "session.start": {
        if (turn && turn.summary.state === "running") {
          finishTurn(turn, { status: "failed", error: "session restarted before it finished" }, at);
        }
        const count = (startsBySession.get(event.sessionId) ?? 0) + 1;
        startsBySession.set(event.sessionId, count);
        model = event.model ?? model;
        harness = event.harness ?? harness;
        turn = openTurn(event, event.turnId ?? `${event.sessionId}#${count}`, count, at);
        if (event.prompt !== undefined) addMessage(turn, "user", event.prompt, at, false);
        continue;
      }
      case "session.delta": {
        applyDelta(turnFor(event, at), event, at);
        continue;
      }
      case "session.steer": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        addMessage(t, "user", event.prompt, at, false, true);
        continue;
      }
      case "session.notify": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        const label = event.notify === NOTIFY_ME ? "told you" : `told thread ${event.notify.slice(0, 8)}`;
        addWork(t, { createdAt: at, label, detail: event.text, tone: "info", sourceActivityKind: "runtime.notify" }, at);
        continue;
      }
      case "session.done": {
        finishTurn(turnFor(event, at), event.result, at);
        continue;
      }
      case "session.end": {
        const t = turnFor(event, at);
        if (t.summary.state === "running") {
          const error = event.reason ?? (event.sawResult
            ? "session exited without a result"
            : `session exited without a result (exit code ${event.exitCode ?? "unknown"})`);
          finishTurn(t, { status: "failed", error }, at);
        }
        continue;
      }
      default: {
        const _exhaustive: never = event;
        continue;
      }
    }
  }

  function applyDelta(t: TurnBuild, e: SessionDelta, at: string): void {
    switch (e.kind) {
      case "text": {
        const open = t.openMessage !== null ? message(t.openMessage) : undefined;
        if (t.openMessage !== null && open) {
          replace(t.openMessage, messageEntry({ ...open, text: open.text + e.text, updatedAt: at || open.updatedAt }));
        } else {
          t.openMessage = addMessage(t, "assistant", e.text, at, true);
        }
        t.sawText = true;
        return;
      }
      case "thinking": {
        closeOpenMessage(t);
        const last = timeline[timeline.length - 1];
        if (last?.kind === "work" && last.entry.tone === "thinking" && last.entry.turnId === t.summary.turnId) {
          replace(timeline.length - 1, workEntry(thinkingEntry(last.entry, (last.entry.detail ?? "") + e.text), last.createdAt));
          return;
        }
        addWork(t, thinkingEntry({ createdAt: at, label: "Thinking", tone: "thinking", sourceActivityKind: "reasoning" }, e.text), at);
        return;
      }
      case "tool_use": {
        closeOpenMessage(t);
        const key = e.toolUseId ?? (t.openAnonymousTool !== null ? `anon:${t.openAnonymousTool}` : undefined);
        const existing = key !== undefined ? t.tools.get(key) : undefined;
        const existingEntry = existing ? work(existing.entryIndex) : undefined;
        if (existing && existingEntry && existingEntry.toolLifecycleStatus === "inProgress") {
          existing.input += e.text;
          replace(existing.entryIndex, workEntry(describeToolCall(existingEntry, e.toolName ?? existingEntry.label, existing.input), timeline[existing.entryIndex]!.createdAt));
          return;
        }
        const toolName = e.toolName ?? "tool";
        const base: WorkLogEntry = {
          id: "", turnId: null, createdAt: at, label: toolName, toolTitle: toolName, tone: "tool",
          toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started",
          ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
        };
        const index = addWork(t, describeToolCall(base, toolName, e.text), at);
        const registryKey = e.toolUseId ?? `anon:${index}`;
        t.tools.set(registryKey, { entryIndex: index, input: e.text });
        if (e.toolUseId === undefined) t.openAnonymousTool = index;
        return;
      }
      case "tool_result": {
        closeOpenMessage(t);
        const key = e.toolUseId ?? (t.openAnonymousTool !== null ? `anon:${t.openAnonymousTool}` : undefined);
        const call = key !== undefined ? t.tools.get(key) : undefined;
        const entry = call ? work(call.entryIndex) : undefined;
        const orphanOutput = summarizeOutput(e.text);
        if (!call || !entry) {
          addWork(t, {
            createdAt: at, label: e.toolName ?? "tool", toolTitle: e.toolName ?? "tool", tone: "tool",
            ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
            toolLifecycleStatus: e.isError ? "failed" : "completed", sourceActivityKind: "tool.completed",
            ...(orphanOutput !== undefined ? { detail: orphanOutput } : {}),
          }, at);
          return;
        }
        const failed = e.isError === true || entry.toolLifecycleStatus === "failed";
        const output = summarizeOutput(e.text);
        replace(call.entryIndex, workEntry({
          ...entry,
          toolLifecycleStatus: failed ? "failed" : "completed",
          sourceActivityKind: "tool.completed",
          ...(output !== undefined ? { detail: output } : {}),
        }, timeline[call.entryIndex]!.createdAt));
        if (e.toolUseId === undefined) t.openAnonymousTool = null;
        return;
      }
      default: {
        const _exhaustive: never = e.kind;
        return;
      }
    }
  }

  const running = turn !== null && turn.summary.state === "running";
  const messages: ChatMessage[] = [];
  const workEntries: WorkLogEntry[] = [];
  for (const entry of timeline) {
    if (entry.kind === "message") messages.push(entry.message);
    else if (entry.kind === "work") workEntries.push(entry.entry);
  }
  return { turns, messages, workEntries, timeline, latestTurn: turns[turns.length - 1] ?? null, running, model, harness };
}

/** Reasoning renders as one collapsed line (preview) that opens onto the text (detail). */
function thinkingEntry<T extends Omit<WorkLogEntry, "id" | "turnId" | "detail" | "preview">>(base: T, text: string): T & Pick<WorkLogEntry, "detail" | "preview"> {
  const preview = summarizeOutput(text);
  return { ...base, detail: text, ...(preview !== undefined ? { preview } : {}) };
}

function messageEntry(m: ChatMessage): TimelineEntry {
  return { id: m.id, kind: "message", createdAt: m.createdAt, message: m };
}

function workEntry(w: WorkLogEntry, createdAt: string): TimelineEntry {
  return { id: w.id, kind: "work", createdAt, entry: w };
}

function turnState(status: TurnResult["status"]): TurnState {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    default: {
      const _exhaustive: never = status;
      return "error";
    }
  }
}

// --- Claude Code tool inputs into work-row fields -----------------------------------

const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CODE_SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);
const WEB_TOOLS: ReadonlySet<string> = new Set(["WebSearch", "WebFetch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Fills label, command, detail, changedFiles and the kind fields from a tool name and its (possibly partial) JSON input. */
function describeToolCall(base: WorkLogEntry, toolName: string, inputText: string): WorkLogEntry {
  const input = parseInput(inputText);
  const entry: WorkLogEntry = {
    ...base,
    label: toolName,
    toolTitle: toolName,
    ...(input === null && inputText.length > 0 ? { detail: inputText } : {}),
  };
  const kind = toolKind(toolName);
  const withKind: WorkLogEntry = {
    ...entry,
    ...(kind.itemType !== undefined ? { itemType: kind.itemType } : {}),
    ...(kind.requestKind !== undefined ? { requestKind: kind.requestKind } : {}),
  };
  if (input === null) return withKind;
  const filePath = str(input["file_path"]) ?? str(input["notebook_path"]);
  const command = str(input["command"]);
  const description = str(input["description"]);
  const detail = filePath ?? str(input["pattern"]) ?? str(input["query"]) ?? str(input["url"]) ?? description ?? str(input["prompt"]);
  const shell = toolName === "Bash"
    ? { ...(command !== undefined ? { command } : {}), ...(description !== undefined ? { description } : {}) }
    : {};
  return {
    ...withKind,
    ...shell,
    ...(filePath !== undefined && FILE_CHANGE_TOOLS.has(toolName) ? { changedFiles: [filePath] } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function toolKind(toolName: string): { itemType?: ToolLifecycleItemType; requestKind?: ProviderRequestKind } {
  if (toolName === "Bash") return { itemType: "command_execution", requestKind: "command" };
  if (toolName === "Read") return { requestKind: "file-read" };
  if (FILE_CHANGE_TOOLS.has(toolName)) return { itemType: "file_change", requestKind: "file-change" };
  if (WEB_TOOLS.has(toolName)) return { itemType: "web_search" };
  if (toolName === "Task") return { itemType: "collab_agent_tool_call" };
  if (toolName.startsWith("mcp__")) return { itemType: "mcp_tool_call" };
  return {};
}

export function isCodeSearchTool(toolName: string | undefined): boolean {
  return toolName !== undefined && CODE_SEARCH_TOOLS.has(toolName);
}

function compactLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(line => line.length > 0);
}

/** The line a row shows for a command: its first non-empty line, whole; the row's width cuts it. */
export function commandFirstLine(command: string): string {
  return compactLines(command)[0] ?? command.trim();
}

/** First non-empty line, cut to 84 characters like t3code's inline preview; fence-only output has nothing to show. */
export function summarizeOutput(text: string): string | undefined {
  const lines = compactLines(text);
  const first = lines.find(line => line !== "```");
  if (first === undefined) return lines.length > 1 ? `${lines.length} lines` : undefined;
  return first.length <= 84 ? first : `${first.slice(0, 83).trimEnd()}…`;
}
