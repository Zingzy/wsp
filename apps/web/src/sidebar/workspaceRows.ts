// SPDX-License-Identifier: AGPL-3.0-only
// Row labels and dialog helpers for the workspace sidebar, all pure. The
// adapter names the state; this file turns it into the words and classes a
// row shows.
import { agentName } from "@wsp/catalog";
import { MACHINE_OS_WORD, fmtSize, isBilling, outOfMemoryRowLine, workspaceState, type MemoryReading, type ReachState, type SessionOrigin, type WorkspaceState, type WorkspaceStatus } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot, StatusIndicatorTone } from "../adapt/index.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { formatWorkingDurationLabel, type ThreadStatusPill } from "./Sidebar.logic.js";

export const NEW_THREAD_SHORTCUT = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new");
export const NEW_THREAD_TITLE = NEW_THREAD_SHORTCUT ? `New thread (${NEW_THREAD_SHORTCUT})` : "New thread";

/** What the countdown reads while the runtime has no nap scheduled for a billing machine. */
export const NO_NAP_SCHEDULED = "active";

/** Countdown to the runtime's auto-nap while the machine bills; "active" when nothing is scheduled. */
export function idleCountdownLabel(status: WorkspaceStatus | null, nowMs: number): string | null {
  if (!status || !isBilling(workspaceState({ phase: status.phase, machineState: status.machineState, reach: status.reach.state }))) return null;
  if (status.idleAt === undefined) return NO_NAP_SCHEDULED;
  const remaining = status.idleAt - nowMs;
  if (remaining < 60_000) return "naps soon";
  return `naps in ${formatWorkingDurationLabel(remaining)}`;
}

/** Slow is the only reach state the indicator does not already carry as a label. */
export function reachNote(reach: ReachState | null): string | null {
  return reach === "slow" ? "edge slow" : null;
}

export interface WorkspaceMetaInput {
  readonly project: Pick<SidebarProjectSnapshot, "state" | "status" | "workspace" | "reach">;
  /** The meter's last tick for this workspace; null before the first. */
  readonly cost: { readonly rateUsdPerHour: number; readonly accruedUsd: number } | null;
  /** The last memory sample from a machine whose link then dropped. */
  readonly outOfMemory: MemoryReading | undefined;
  readonly nowMs: number;
}

/** The machine row's second line, one string in one order: what it cost today, the rate while it bills, the edge
 * note, the nap countdown last. The cost always leads, an honest zero before the meter's first tick, so no row draws
 * a blank line. The width cuts it from the right; nothing here decides what to leave out. What the runtime is doing
 * to the machine's daemon, or a drop with memory near full, takes the whole line while it lasts: it is the one thing
 * on the row a person may be waiting on. */
export function workspaceMetaLine({ project, cost, outOfMemory, nowMs }: WorkspaceMetaInput): string {
  const note = project.status !== null ? project.status.daemonNote : project.workspace.daemonNote;
  if (note !== undefined) return note;
  if (outOfMemory !== undefined) return outOfMemoryRowLine(outOfMemory);
  return [
    accruedTodayLabel(cost?.accruedUsd ?? 0),
    isBilling(project.state) ? rateLabel(cost?.rateUsdPerHour ?? project.status?.rateUsdPerHour ?? null) : null,
    reachNote(project.reach),
    idleCountdownLabel(project.status, nowMs),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** What a workspace has cost since the meter's midnight, in cents; the sidebar row and the switcher card read the one rule. */
export function accruedTodayLabel(accruedUsd: number | null): string | null {
  return accruedUsd === null ? null : `$${accruedUsd.toFixed(2)} today`;
}

/** The awake rate as every sidebar surface prints it, to the tenth of a cent; null before the meter's first tick. */
export const rateLabel = (rateUsdPerHour: number | null): string | null => (rateUsdPerHour === null ? null : `$${rateUsdPerHour.toFixed(3)}/hr`);

/** The Spaces header's lines under the name, in the ticket's order: what the machine is, what it costs, when it
 * naps. The machine line names the size the status carries and the OS word; the cost line leads with the same
 * honest zero the row's line does and adds the rate only while the machine bills; the nap line is there only when
 * the runtime scheduled one, so a header never says "active" at a person. */
export function spaceHeaderLines({ project, cost, nowMs }: Omit<WorkspaceMetaInput, "outOfMemory">): string[] {
  const nap = idleCountdownLabel(project.status, nowMs);
  return [
    [project.status === null ? null : fmtSize(project.status.size), MACHINE_OS_WORD].filter((part): part is string => part !== null).join(" · "),
    [accruedTodayLabel(cost?.accruedUsd ?? 0), isBilling(project.state) ? rateLabel(cost?.rateUsdPerHour ?? project.status?.rateUsdPerHour ?? null) : null]
      .filter((part): part is string => part !== null)
      .join(" · "),
    ...(nap === null || nap === NO_NAP_SCHEDULED ? [] : [nap]),
  ];
}

/** The word in the row's state slot: nothing while running, since the dot says it; the state's word otherwise. */
export function stateSlotWord(project: Pick<SidebarProjectSnapshot, "state" | "indicator">): string {
  return project.state === "running" ? "" : project.indicator.label;
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
