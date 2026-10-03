// SPDX-License-Identifier: AGPL-3.0-only
import type { Slate, SlateProblem } from "./types.js";
import { slateProblem } from "./problems.js";

export function validateSlate(_input: unknown): { document?: Slate; errors: SlateProblem[]; warnings: SlateProblem[] } {
  return { errors: [slateProblem("P999", "the validator is not built yet")], warnings: [] };
}
