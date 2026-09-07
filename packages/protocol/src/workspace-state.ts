// SPDX-License-Identifier: AGPL-3.0-only
// The one vocabulary for a workspace's state. The runtime's phase leads; the
// provider's word and the daemon reach only change it where they contradict
// it. Every client renders these words, and the runtime refuses a send with
// the same sentence the composer shows, so one screen never says two things.
import type { MachineState, ReachState, WorkspacePhase } from "./index.js";

export type WorkspaceState = "running" | "pausing" | "paused" | "waking" | "unreachable" | "gone";

export interface WorkspaceStateInput {
  phase: WorkspacePhase;
  machineState?: MachineState | null | undefined;
  reach?: ReachState | null | undefined;
}

export function workspaceState(input: WorkspaceStateInput): WorkspaceState {
  const machine = input.machineState ?? null;
  const reach = input.reach ?? null;
  if (machine === "gone") return "gone";
  switch (input.phase) {
    case "pausing":
      return "pausing";
    case "napping":
      return "paused";
    case "waking":
      return "waking";
    case "gone":
      return "gone";
    case "running":
      if (machine === "paused") return "paused";
      if (machine === "starting") return "waking";
      if (reach === "unreachable" || reach === "no-daemon" || reach === "zombie") return "unreachable";
      return "running";
    default: {
      const _exhaustive: never = input.phase;
      return "running";
    }
  }
}

const WORDS: Record<WorkspaceState, string> = {
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  waking: "Waking",
  unreachable: "Unreachable",
  gone: "Gone",
};

export function workspaceWord(state: WorkspaceState): string {
  return WORDS[state];
}

/** Why an action that needs the machine (send, import, export) cannot run in this state; null while running.
 * goneWords are the provider's, quoted when the caller holds them (the runtime does, the composer does not). */
export function actionRefusal(state: WorkspaceState, action: string, goneWords?: string): string | null {
  switch (state) {
    case "running":
      return null;
    case "pausing":
    case "paused":
      return `Workspace is ${state}; wake it to ${action}`;
    case "waking":
      return `Workspace is waking; ${action}s open when it is running`;
    case "unreachable":
      return `Workspace is unreachable; ${action}s open when the machine answers`;
    case "gone":
      return goneRefusal(action, goneWords);
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

/** Why a turn cannot be sent in this state; null while running. */
export function sendRefusal(state: WorkspaceState, goneWords?: string): string | null {
  return actionRefusal(state, "send", goneWords);
}

/** Whether the machine is up and billing in this state: running, or running with its edge or daemon dark (the
 * provider bills a machine it cannot be reached on). Paused, moving and gone ones bill nothing, and only a billing
 * machine has anything to nap, so the rate and the nap countdown on every surface read this one rule. */
export function isBilling(state: WorkspaceState): boolean {
  return state === "running" || state === "unreachable";
}

/** Rebuild is the one action left: the machine is gone, or a zombie the provider still calls running. Every
 * surface that offers the rebuild (sidebar row, palette, Machine tab) asks this and nothing else. */
export function needsRebuild(input: WorkspaceStateInput): boolean {
  return workspaceState(input) === "gone" || input.reach === "zombie";
}

/** The one sentence for a verb a gone machine cannot take (send, wake, fork), with the provider's words when the
 * caller holds them; rebuild and delete are the roads out. */
export function goneRefusal(action: string, words?: string): string {
  const sentence = `Workspace machine is gone; rebuild it to ${action}`;
  return words === undefined || words === "" ? sentence : `${sentence} (${words})`;
}

/** What a workspace's image is, for a move onto the golden's head: whether any golden of this host knows the
 * snapshot it forked from as a version, and whether that snapshot is a project golden. */
export interface ImageMoveInput {
  knownVersion: boolean;
  projectImage: boolean;
}

/** Why a workspace cannot be moved onto its golden's head, or null when it can. One rule, so the app's offer and
 * the runtime's refusal cannot drift apart: the app hides the button on the sentence the runtime would throw.
 * A move replaces the machine, so only a running one can take it; a project image is refused outright, since the
 * disk the move leaves behind is the project's. */
export function imageMoveRefusal(name: string, state: WorkspaceState, image: ImageMoveInput): string | null {
  if (image.projectImage) return `${name} was forked from a project image, which a version move would throw away; make a new workspace on the newer version instead`;
  if (!image.knownVersion) return `${name}'s image is not a version of any golden this host knows`;
  if (state === "gone") return `${name}'s machine is gone; rebuild it to move it to a newer image`;
  if (state !== "running") return `${name} is ${workspaceWord(state).toLowerCase()}; wake it to move it to a newer image`;
  return null;
}
