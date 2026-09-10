// SPDX-License-Identifier: AGPL-3.0-only
// Words the machine surface puts next to wire values. Phase is the product
// word (Running, Paused, Waking); machine state is the provider word and only
// shows when it diverges from what the phase implies.
import { fmtBytes, kindWords, machineWord, workspaceState, workspaceWord, type MachineState, type ReachState, type WorkspaceKind, type WorkspacePhase } from "@wsp/protocol";

export const money = (n: number, digits = 4): string => `$${n.toFixed(digits)}`;

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
    case "gone":
      return null;
    default: {
      const _exhaustive: never = phase;
      return null;
    }
  }
}

/** The Reach row's word. A kind whose machines serve no daemon at all reads what the machine is instead of the bare
 * `unsupported`, from the same table the sidebar row reads: on that kind it is not a state that passes, it is what
 * the machine is. */
export function reachLabel(state: ReachState, kind: WorkspaceKind = "cloud"): string {
  if (state === "unsupported" && !kindWords(kind).daemon) return `none on ${machineWord(kind)}`;
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

export const percentLabel = (n: number): string => `${Math.round(n)}%`;

const UNITS = ["", "K", "M", "G", "T"];

/** rss as a process table column with a three-digit budget fmtBytes does not fit, so its own rule: 900, 12K, 1.5M, 123M, 2.3G. */
export function compactBytes(n: number): string {
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${text}${UNITS[i]}`;
}
