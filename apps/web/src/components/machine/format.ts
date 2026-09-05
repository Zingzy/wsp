// SPDX-License-Identifier: AGPL-3.0-only
// Words the machine surface puts next to wire values. Phase is the product
// word (Running, Paused, Waking); machine state is the provider word and only
// shows when it diverges from what the phase implies.
import { workspaceState, workspaceWord, type MachineState, type ReachState, type WorkspacePhase, type WorkspaceSize } from "@wsp/protocol";

export const money = (n: number, digits = 4): string => `$${n.toFixed(digits)}`;

export const sizeLabel = (size: WorkspaceSize): string => `${size.cpu} vCPU · ${size.memMb / 1024} GB`;

/** A tick's wall-clock time in the person's zone, hours and minutes. */
export const clockLabel = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function phaseLabel(phase: WorkspacePhase): string {
  return workspaceWord(workspaceState({ phase }));
}

/** The provider word only when it contradicts the phase. A waking machine passes through paused,
 * starting and running, and a pausing one through running and paused, so only gone counts against those. */
export function divergentMachineState(phase: WorkspacePhase, state: MachineState): MachineState | null {
  switch (phase) {
    case "running":
      return state === "running" ? null : state;
    case "napping":
      return state === "paused" ? null : state;
    case "pausing":
    case "waking":
      return state === "gone" ? state : null;
    default: {
      const _exhaustive: never = phase;
      return null;
    }
  }
}

export function reachLabel(state: ReachState): string {
  switch (state) {
    case "slow":
      return "edge slow";
    case "no-daemon":
      return "no daemon";
    case "reachable":
    case "unreachable":
    case "napping":
    case "unsupported":
    case "gone":
    case "zombie":
      return state;
    default: {
      const _exhaustive: never = state;
      return state;
    }
  }
}

/** idleAt is absent while napping, while a session holds the machine awake, or with auto-nap off; the wire does not say which. */
export function idleLabel(idleAt: number | undefined, now: number): string {
  if (idleAt === undefined) return "not scheduled";
  const left = idleAt - now;
  return left <= 0 ? "napping now" : `naps in ${durationLabel(left)}`;
}

export type DiskTier = "plain" | "yellow" | "orange" | "red";

/** How full the workspace disk is, in percent: the number turns before the disk does. */
export function diskTier(percent: number): DiskTier {
  if (percent >= 75) return "red";
  if (percent >= 65) return "orange";
  if (percent >= 50) return "yellow";
  return "plain";
}

export const percentLabel = (n: number): string => `${Math.round(n)}%`;

/** Used and total in one unit picked by the total: GB with a decimal from a gigabyte up, whole MB below. */
export function bytesOfLabel(used: number, total: number): string {
  const GiB = 1024 ** 3;
  if (total >= GiB) return `${(used / GiB).toFixed(1)} of ${(total / GiB).toFixed(1)} GB`;
  const MiB = 1024 ** 2;
  return `${Math.round(used / MiB)} of ${Math.round(total / MiB)} MB`;
}
