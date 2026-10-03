// SPDX-License-Identifier: AGPL-3.0-only
import type { Slate, SlatePatchOp, SlateProblem } from "./types.js";
import { slateProblem } from "./problems.js";

export function compileSlate(_lines: string): { document?: Slate; errors: SlateProblem[]; warnings: SlateProblem[] } {
  return { errors: [slateProblem("P999", "the shorthand compiler is not built yet")], warnings: [] };
}
export function compileSlatePatch(_lines: string, _current: Slate): { ops?: SlatePatchOp[]; errors: SlateProblem[] } {
  return { errors: [slateProblem("P999", "patches are not built yet")] };
}
export function printSlate(_doc: Slate): string {
  return "";
}
