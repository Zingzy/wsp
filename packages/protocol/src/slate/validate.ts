// SPDX-License-Identifier: AGPL-3.0-only
// The validator (10, "The error code table").
import type { SlateDoc, SlateProblem } from "./types.js";

export function validateSlate(input: unknown): { document?: SlateDoc; errors: SlateProblem[]; warnings: SlateProblem[] } {
  return { document: input as SlateDoc, errors: [], warnings: [] };
}
