// SPDX-License-Identifier: AGPL-3.0-only
// Row labels and dialog helpers for the workspace sidebar, all pure. The
// adapter names the state; this file turns it into the words and classes a
// row shows.
import { agentName } from "@wsp/catalog";
import { MACHINE_OS_WORD, fmtSize, isBilling, kindWords, outOfMemoryRowLine, workspaceKind, workspaceState, type MemoryReading, type ReachState, type SessionOrigin, type WorkspaceState, type WorkspaceStatus } from "@wsp/protocol";
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

/** The row's line for a daemon that is not there, and which of the two facts it is: no-daemon is a machine that
 * answers with nothing on the daemon's port, unsupported one with no daemon road at all. Nothing for every other
 * reach. A daemon that died is said on every kind, since a driven kind's state word reads Unreachable for it,
 * which is also what a machine gone dark reads, and only one of the two is a helper wsp puts back by itself while
 * the machine is fine. A machine with no road to a daemon at all is said only where the row has no state word to
 * spend on it: nothing wsp drives is built without the road, so a driven row saying it would be saying something
 * that cannot be true of it. */
export function daemonGoneLine(reach: ReachState | null, driven: boolean): string | undefined {
  if (reach === "no-daemon") return "no daemon answering";
  return reach === "unsupported" && !driven ? "no daemon on this machine" : undefined;
}

/** The sentences a meta line can carry in place of its counts, in the order a surface draws them: what the
 * runtime is doing to the machine's daemon, then a drop with memory near full, then a daemon that is not there at
 * all. Written once because two surfaces draw them and both have to tell them from a figure: prose takes the ink
 * that reads at AA, the counts beside it keep the whisper. */
export function metaSentences({ project, outOfMemory }: Pick<WorkspaceMetaInput, "project" | "outOfMemory">): string[] {
  return [
    daemonNote(project),
    outOfMemory === undefined ? undefined : outOfMemoryRowLine(outOfMemory),
    daemonGoneLine(project.reach, kindWords(workspaceKind(project.workspace)).driven),
  ].filter((line): line is string => line !== undefined);
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
 * to the machine's daemon, a drop with memory near full, or a daemon that is not there at all takes the whole line
 * while it lasts: it is the one thing on the row a person may be waiting on, and it reads in the ink prose gets. A
 * machine wsp does not drive spends nothing and naps never, so its line says what the machine is instead. */
export function workspaceMetaLine({ project, cost, outOfMemory, nowMs }: WorkspaceMetaInput): string {
  const [sentence] = metaSentences({ project, outOfMemory });
  if (sentence !== undefined) return sentence;
  const machine = machineLine(project);
  if (!kindWords(workspaceKind(project.workspace)).driven && machine !== null) return machine;
  return [
    accruedTodayLabel(cost?.accruedUsd ?? 0),
    isBilling(project.state) ? rateLabel(cost?.rateUsdPerHour ?? project.status?.rateUsdPerHour ?? null) : null,
    reachNote(project.reach),
    idleCountdownLabel(project.status, nowMs),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** What the machine is, the one line the row and the Spaces header both read: the kind's own words where it has
 * them (this computer), else the size the provider built and the OS every fork runs. Null before a status carries a
 * size, so a surface leaves the line out rather than drawing it half. The row shows it only for a kind wsp does not
 * drive, which has no spend to show there instead; a fork's size reads in the header and the Machine tab. */
export function machineLine(project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string | null {
  const kind = kindWords(workspaceKind(project.workspace));
  if (kind.machine !== null) return kind.machine;
  return project.status === null ? null : `${fmtSize(project.status.size)} · ${MACHINE_OS_WORD}`;
}

/** What the runtime is doing to this machine's daemon, or why its last attempt failed; the status leads where one
 * has arrived, and nothing is being done when it is absent. */
export function daemonNote(project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string | undefined {
  return project.status !== null ? project.status.daemonNote : project.workspace.daemonNote;
}

/** What a workspace has cost since the meter's midnight, in cents; the sidebar row and the switcher card read the one rule. */
export function accruedTodayLabel(accruedUsd: number | null): string | null {
  return accruedUsd === null ? null : `$${accruedUsd.toFixed(2)} today`;
}

/** The awake rate as every sidebar surface prints it, to the tenth of a cent; null before the meter's first tick. */
export const rateLabel = (rateUsdPerHour: number | null): string | null => (rateUsdPerHour === null ? null : `$${rateUsdPerHour.toFixed(3)}/hr`);

/** The Spaces header's lines under the name. The two the row's meta line gives a whole line to lead, since the one
 * workspace on screen is where a person waits on them: what the runtime is doing to the daemon, a drop with memory
 * near full, then a daemon that is not there at all. Then what the machine is, what it costs, and when it naps. A line nothing is known for is left
 * out rather than drawn half: no size yet means no machine line, as no nap scheduled means no nap line. The cost
 * line leads with the same honest zero the row's does and carries the rate only while the machine bills. A kind
 * with its own words for what the machine is says them where a fork's size reads, through the one machine line, and
 * a machine wsp does not drive stops there: it spends nothing and naps never, so a rate under the words for what
 * the machine is would name an hour nobody is charged for. */
export function spaceHeaderLines({ project, cost, outOfMemory, nowMs }: WorkspaceMetaInput): string[] {
  const lines: (string | null)[] = [...metaSentences({ project, outOfMemory }), machineLine(project)];
  if (kindWords(workspaceKind(project.workspace)).driven) {
    const nap = idleCountdownLabel(project.status, nowMs);
    lines.push(
      [accruedTodayLabel(cost?.accruedUsd ?? 0), isBilling(project.state) ? rateLabel(cost?.rateUsdPerHour ?? project.status?.rateUsdPerHour ?? null) : null]
        .filter((part): part is string => part !== null)
        .join(" · "),
      nap === NO_NAP_SCHEDULED ? null : nap,
    );
  }
  return lines.filter((line): line is string => line !== null);
}

/** The word in the row's state slot: nothing while running, since the dot says it; the state's word otherwise. A
 * machine wsp does not drive has no state of its own to name, so its slot stays empty whatever the reach says. */
export function stateSlotWord(project: Pick<SidebarProjectSnapshot, "state" | "indicator" | "workspace">): string {
  if (!kindWords(workspaceKind(project.workspace)).driven) return "";
  return project.state === "running" ? "" : project.indicator.label;
}

// The base the sidebar's whispered tiers mix from, not the app's muted ink: the same colour on a
// dark surface, and on a light one the step an alpha needs there. A row in the command palette
// draws it from the root's copy of the token.
const PLAIN = { colorClass: "text-sidebar-whisper/70", dotClass: "bg-sidebar-whisper/60" };

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
