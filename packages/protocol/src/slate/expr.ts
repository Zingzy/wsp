// SPDX-License-Identifier: AGPL-3.0-only
import type { SlateEvalContext, SlateExpr, SlateJson, SlateProblem, SlatePropValue } from "./types.js";
import { slateProblem } from "./problems.js";

export function parseSlateExpression(_src: string): { ast?: SlateExpr; errors: SlateProblem[] } {
  return { errors: [slateProblem("P999", "expressions are not built yet")] };
}
export function evaluateSlateExpression(_expr: string | SlateExpr, _ctx: SlateEvalContext): SlateJson | undefined {
  return undefined;
}
export function slateDependencies(_expr: string | SlateExpr): string[] {
  return [];
}
export function resolveSlateProp(_value: SlatePropValue, _ctx: SlateEvalContext): SlateJson | undefined {
  return undefined;
}
