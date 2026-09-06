// SPDX-License-Identifier: AGPL-3.0-only
// Row labels and dialog helpers for the workspace sidebar, all pure. The
// adapter names the state; this file turns it into the words and classes a
// row shows.
import { agentName } from "@wsp/catalog";
import type { ReachState, SessionOrigin, WorkspacePhase, WorkspaceStatus } from "@wsp/protocol";
import type { SidebarThreadSnapshot, StatusIndicatorTone } from "../adapt/index.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { formatWorkingDurationLabel, type ThreadStatusPill } from "./Sidebar.logic.js";

/** Countdown to the runtime's auto-nap while the workspace runs; "active" when nothing is scheduled. */
export function idleCountdownLabel(status: WorkspaceStatus | null, nowMs: number): string | null {
  if (!status || status.phase !== "running") return null;
  if (status.idleAt === undefined) return "active";
  const remaining = status.idleAt - nowMs;
  if (remaining < 60_000) return "naps soon";
  return `naps in ${formatWorkingDurationLabel(remaining)}`;
}

/** Slow is the only reach state the indicator does not already carry as a label. */
export function reachNote(reach: ReachState | null): string | null {
  return reach === "slow" ? "edge slow" : null;
}

/** The machine row's second line. What the runtime is doing to the machine's daemon takes the whole line while it
 * is doing anything: it is the one thing on the row a person may be waiting on, and it leaves as soon as it lands. */
export function workspaceMetaLine(daemonNote: string | undefined, parts: ReadonlyArray<string | null>): string {
  return daemonNote ?? parts.filter((p): p is string => p !== null).join(" · ");
}

export function costLabel(input: {
  readonly phase: WorkspacePhase;
  readonly rateUsdPerHour: number | null;
  readonly accruedUsd: number | null;
}): string | null {
  const parts: string[] = [];
  if (input.phase === "running" && input.rateUsdPerHour !== null) parts.push(`$${input.rateUsdPerHour.toFixed(3)}/hr`);
  if (input.accruedUsd !== null) parts.push(`$${input.accruedUsd.toFixed(4)} today`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

const PLAIN = { colorClass: "text-muted-foreground/70", dotClass: "bg-muted-foreground/60" };

const OPENER_WORD: Record<SessionOrigin, string> = { person: "you", cli: "cli", agent: "agent" };

/** Who opened the thread: you, the command line on this computer, or a local agent. */
export function openerWord(startedBy: SessionOrigin): string {
  return OPENER_WORD[startedBy];
}

/** The agent inside the thread and who opened it, as the row's hover text reads it. */
export function provenanceLabel(thread: Pick<SidebarThreadSnapshot, "harness" | "startedBy">): string {
  return `${agentName(thread.harness)} · ${openerWord(thread.startedBy)}`;
}

/** The pill keys on the session's status and wears the adapter's word: a running thread and one that did not settle carry one, the resting states none. */
export function threadPill(thread: Pick<SidebarThreadSnapshot, "status" | "indicator">): ThreadStatusPill | null {
  if (!thread.indicator) return null;
  switch (thread.status) {
    case "running":
      return { label: thread.indicator.label, ...PLAIN, pulse: thread.indicator.pulse };
    case "failed":
      return { label: thread.indicator.label, ...PLAIN, pulse: false };
    case "completed":
    case "interrupted":
      return null;
    default: {
      const _exhaustive: never = thread.status;
      return null;
    }
  }
}

export function dotClassForTone(tone: StatusIndicatorTone): string {
  switch (tone) {
    case "running":
      return "bg-success";
    case "paused":
      return "border border-muted-foreground/60 bg-transparent";
    case "neutral":
      return "bg-muted-foreground/60";
    default: {
      const _exhaustive: never = tone;
      return "";
    }
  }
}

export function textClassForTone(tone: StatusIndicatorTone): string {
  switch (tone) {
    case "running":
      return "text-success-foreground";
    case "paused":
    case "neutral":
      return "text-muted-foreground/70";
    default: {
      const _exhaustive: never = tone;
      return "";
    }
  }
}

/** t3code's row label: "just now" reads "now", "3m ago" reads "3m". */
export function compactTimeLabel(iso: string | null): string {
  if (iso === null) return "";
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export function defaultWorkspaceName(existing: ReadonlyArray<string>): string {
  const taken = new Set(existing);
  for (let n = 1; ; n++) {
    const candidate = `workspace-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
