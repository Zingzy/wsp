// SPDX-License-Identifier: AGPL-3.0-only
// The wizard's state machine, kept pure so every transition is a frame or a
// resolved request and none is a timer. Stage names are the protocol's
// GoldenStage enum. The builder arrives from wsp init through the boot object;
// without one there is nothing to show but where to get one.
import type { GoldenBuilderView, GoldenStage } from "@wsp/protocol";

export type Step = "none" | "hero" | "sealing" | "done" | "failed";

export interface WizardState {
  step: Step;
  /** Every stage frame seen this run, in arrival order. */
  seen: GoldenStage[];
  /** Detail of the latest stage frame, or the failure message. */
  detail?: string;
  builder?: GoldenBuilderView;
}

export type Action =
  | { type: "stage"; stage: GoldenStage; detail?: string }
  | { type: "seal" }
  | { type: "sealed" }
  | { type: "failed"; detail: string };

export function initial(builder?: GoldenBuilderView): WizardState {
  return builder ? { step: "hero", seen: [], builder } : { step: "none", seen: [] };
}

export const SEAL_STAGES: readonly GoldenStage[] = ["snapshotting", "smoke-forking", "sealed"];

export function reduce(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case "stage":
      if (action.stage === "failed") return { step: "failed", seen: state.seen, detail: action.detail ?? "no detail given" };
      return {
        ...state,
        seen: [...state.seen, action.stage],
        ...(action.detail !== undefined ? { detail: action.detail } : { detail: undefined }),
      };
    case "seal":
      return state.step === "hero" ? { ...state, step: "sealing", detail: undefined } : state;
    case "sealed":
      return state.step === "sealing" ? { ...state, step: "done" } : state;
    case "failed":
      return state.step === "failed" ? state : { step: "failed", seen: state.seen, detail: action.detail };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export type RowState = "done" | "current" | "pending";

/** Where each stage of a list stands given the frames seen so far; stages
 * before the latest seen one count as done even when no frame named them. */
export function rowStates(list: readonly GoldenStage[], seen: readonly GoldenStage[]): Record<string, RowState> {
  const latest = [...seen].reverse().find(s => list.includes(s));
  const at = latest === undefined ? -1 : list.indexOf(latest);
  const out: Record<string, RowState> = {};
  list.forEach((s, i) => {
    out[s] = i < at ? "done" : i === at ? "current" : "pending";
  });
  return out;
}
