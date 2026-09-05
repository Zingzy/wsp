// SPDX-License-Identifier: AGPL-3.0-only
// Row labels and dialog helpers for the workspace sidebar, all pure. The
// adapter names the state; this file turns it into the words and classes a
// row shows.
import type { ReachState, WorkspacePhase, WorkspaceStatus } from "@wsp/protocol";
import type { StatusIndicator, StatusIndicatorTone } from "../adapt/index.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { DisconnectedError, RequestError } from "../protocol/client.js";
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

const ZINC = { colorClass: "text-muted-foreground/70", dotClass: "bg-zinc-400 dark:bg-zinc-500" };

/** Idle is the unlabeled resting state; Working and Ended carry a pill, zinc like everything that is not running. */
export function pillFromIndicator(indicator: StatusIndicator | null): ThreadStatusPill | null {
  if (!indicator) return null;
  switch (indicator.label) {
    case "Working":
      return { label: "Working", ...ZINC, pulse: indicator.pulse };
    case "Ended":
      return { label: "Ended", ...ZINC, pulse: false };
    default:
      return null;
  }
}

export function dotClassForTone(tone: StatusIndicatorTone): string {
  switch (tone) {
    case "running":
      return "bg-emerald-500 dark:bg-emerald-300/90";
    case "paused":
      return "border border-zinc-400 bg-transparent dark:border-zinc-500";
    case "neutral":
      return "bg-zinc-400 dark:bg-zinc-500";
    default: {
      const _exhaustive: never = tone;
      return "";
    }
  }
}

export function textClassForTone(tone: StatusIndicatorTone): string {
  switch (tone) {
    case "running":
      return "text-emerald-600 dark:text-emerald-300/90";
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

export interface CreateRefusal {
  readonly title: string;
  readonly detail: string;
}

export function explainCreateRefusal(error: unknown): CreateRefusal {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RequestError && error.kind === "concurrency") {
    return {
      title: "The provider refused: machine cap reached",
      detail: `Your machine provider runs a fixed number of machines at once and every slot is taken. A builder kept after a save and not in use is stopped first to make room; pause or delete a workspace to free one, then try again. (${message})`,
    };
  }
  if (error instanceof DisconnectedError) {
    return { title: "Not connected to the runtime", detail: message };
  }
  return { title: "Could not create the workspace", detail: message };
}
