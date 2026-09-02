// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/session-logic.ts at 57a66608 (MIT).
// The pure helpers the timeline reads off a WorkLogEntry; the derive functions
// that fed them upstream are replaced by foldSessionEvents.ts here.
import {
  isToolLifecycleItemType,
  type ChatMessage,
  type ProposedPlan,
  type TimelineEntry,
  type WorkLogEntry,
} from "./types";

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("file not found")) return true;
  if (t.includes("no files found")) return true;
  if (t.includes("enoent") || t.includes("no such file or directory") || t.includes("no such file")) return true;
  if (t.includes("cannot find path") && t.includes("because it does not exist")) return true;
  if (t.includes("commandnotfoundexception")) return true;
  if (t.includes("is not recognized as the name of a cmdlet")) return true;
  if (t.includes("is not recognized") && t.includes("the term '")) return true;
  if (t.includes("a parameter cannot be found that matches parameter name")) return true;
  if (t.includes("command not found")) return true;
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) return true;
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) return true;
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) return true;
  return false;
}

function workEntryIndicatesToolFailureFromOutput(entry: WorkLogEntry, includeCommand: boolean): boolean {
  if (entry.tone === "error") return true;
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") return true;
  if (!workLogEntryIsToolLike(entry)) return false;
  const parts: string[] = [];
  if (entry.detail) parts.push(entry.detail);
  if (includeCommand && entry.command) parts.push(entry.command);
  const blob = parts.join("\n");
  if (blob.length === 0) return false;
  return toolDetailTextLooksLikeFailure(blob);
}

/** True when a tool failed, including providers that put error output in `command`. */
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** True when the rendered result indicates failure. The command itself is user intent, not output. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/** Severe failures keep the red treatment ordinary tool failures lost: runtime
 *  errors and `*.failed` activities mean the turn or a core side effect broke,
 *  not that a command exited nonzero. */
export function workEntrySignalsSevereFailure(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "runtime.error" || entry.sourceActivityKind?.endsWith(".failed") === true;
}

/** Tool/command row completed without failure (blue check affordance). */
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) return false;
  if (workEntryIndicatesToolFailure(entry)) return false;
  if (entry.tone === "thinking") return false;
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") return false;
  if (ls === "inProgress") return false;
  if (ls === "stopped") return false;
  return true;
}

/** Tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.). */
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  // Spawn CTA rows derive from in-progress task rows mid-run; the neutral filter must not hide them.
  if (entry.agentSpawn !== undefined) return false;
  if (!workLogEntryIsToolLike(entry)) return false;
  if (workEntryIndicatesToolFailure(entry)) return false;
  if (workEntryIndicatesToolSuccess(entry)) return false;
  return true;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    // 9.95s+ rounds up to the next bucket: render "10s", not "10.0s".
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) return null;
  return formatDuration(endedAt - startedAt);
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map(message => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map(proposedPlan => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map(entry => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
