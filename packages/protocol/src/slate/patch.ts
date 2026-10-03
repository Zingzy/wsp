// SPDX-License-Identifier: AGPL-3.0-only
import type { Slate, SlateJson, SlatePatchOp, SlateProblem } from "./types.js";
import { slateProblem } from "./problems.js";

export function applySlatePatch(_doc: Slate, _state: Record<string, SlateJson>, _ops: SlatePatchOp[]):
  { document?: Slate; state?: Record<string, SlateJson>; errors: SlateProblem[]; warnings: SlateProblem[] } {
  return { errors: [slateProblem("P999", "patches are not built yet")], warnings: [] };
}
