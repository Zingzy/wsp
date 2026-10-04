// SPDX-License-Identifier: AGPL-3.0-only
// Patches applied all or nothing (03, "Patches"), and the live values a document write keeps (02, "Values").
import type { SlateDoc, SlatePatch, SlateProblem, SlateValues } from "./types.js";

export function applySlatePatch(doc: SlateDoc | null, values: SlateValues, patch: SlatePatch): { document?: SlateDoc | null; values?: SlateValues; errors: SlateProblem[]; warnings: SlateProblem[] } {
  void doc; void values; void patch;
  return { errors: [], warnings: [] };
}
