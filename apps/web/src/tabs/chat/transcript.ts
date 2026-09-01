// SPDX-License-Identifier: AGPL-3.0-only
// Pure transcript state for the chat tab: folds session.* events into
// render-ready items. One wsp session is one turn; a conversation is a chain
// of sessions resumed via the workspace's claudeSessionId, so items from
// successive sessions accumulate into one list.
import type { EventUnion, TurnResult } from "@wsp/protocol";

type Ev<T extends EventUnion["type"]> = Extract<EventUnion, { type: T }>;
export type SessionEvent = Ev<"session.start" | "session.delta" | "session.done" | "session.end">;

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolUseId: string | null; toolName: string; input: string; result: string | null; isError: boolean }
  | { kind: "done"; result: TurnResult };

export interface Transcript {
  items: TranscriptItem[];
  running: boolean;
  model: string | null;
}

export const emptyTranscript: Transcript = { items: [], running: false, model: null };

const SESSION_TYPES: ReadonlySet<string> = new Set(["session.start", "session.delta", "session.done", "session.end"]);

export function isSessionEvent(e: EventUnion): e is SessionEvent {
  return SESSION_TYPES.has(e.type);
}

export function appendUserTurn(t: Transcript, text: string): Transcript {
  return { ...t, items: [...t.items, { kind: "user", text }] };
}

/** A send that failed before the runtime ever emitted events for it. */
export function appendLocalError(t: Transcript, message: string): Transcript {
  return { ...t, items: [...t.items, { kind: "done", result: { status: "failed", error: message } }] };
}

export function applySessionEvent(t: Transcript, e: EventUnion, workspaceId: string): Transcript {
  if (!isSessionEvent(e) || e.workspaceId !== workspaceId) return t;
  switch (e.type) {
    case "session.start":
      return { ...t, running: true, model: e.model ?? t.model };
    case "session.delta":
      return { ...t, items: applyDelta(t.items, e) };
    case "session.done":
      return { ...t, running: false, items: [...t.items, { kind: "done", result: e.result }] };
    case "session.end": {
      if (e.sawResult) return { ...t, running: false };
      const error = `session exited without a result (exit code ${e.exitCode ?? "unknown"})`;
      return { ...t, running: false, items: [...t.items, { kind: "done", result: { status: "failed", error } }] };
    }
    default: {
      const _exhaustive: never = e;
      return t;
    }
  }
}

function applyDelta(items: TranscriptItem[], e: Ev<"session.delta">): TranscriptItem[] {
  const last = items[items.length - 1];
  switch (e.kind) {
    case "text":
    case "thinking": {
      if (last && last.kind === e.kind) return [...items.slice(0, -1), { ...last, text: last.text + e.text }];
      return [...items, { kind: e.kind, text: e.text }];
    }
    case "tool_use": {
      const id = e.toolUseId ?? null;
      // Streaming input for the tool call already at the tail keeps appending.
      if (last && last.kind === "tool" && last.result === null && last.toolUseId === id)
        return [...items.slice(0, -1), { ...last, input: last.input + e.text, toolName: e.toolName ?? last.toolName }];
      return [...items, { kind: "tool", toolUseId: id, toolName: e.toolName ?? "tool", input: e.text, result: null, isError: false }];
    }
    case "tool_result": {
      const id = e.toolUseId ?? null;
      const idx = findToolIndex(items, id);
      const tool = idx >= 0 ? items[idx] : undefined;
      if (!tool || tool.kind !== "tool") {
        // Result with no visible call (e.g. attached mid-stream): still shown.
        return [...items, { kind: "tool", toolUseId: id, toolName: e.toolName ?? "tool", input: "", result: e.text, isError: e.isError ?? false }];
      }
      const merged: TranscriptItem = { ...tool, result: (tool.result ?? "") + e.text, isError: tool.isError || (e.isError ?? false) };
      return [...items.slice(0, idx), merged, ...items.slice(idx + 1)];
    }
    default: {
      const _exhaustive: never = e.kind;
      return items;
    }
  }
}

function findToolIndex(items: TranscriptItem[], toolUseId: string | null): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it || it.kind !== "tool") continue;
    if (toolUseId !== null ? it.toolUseId === toolUseId : it.result === null) return i;
  }
  return -1;
}
