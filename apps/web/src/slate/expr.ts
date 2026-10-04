// SPDX-License-Identifier: AGPL-3.0-only
// The renderer's one door into the formula language: evaluate, resolve a prop, list what an expression reads. A
// formula that fails to parse or evaluate is missing, and the piece draws its quiet placeholder.
import { evaluateSlateExpression, resolveSlateProp, slateDependencies, type SlateJson, type SlatePropValue } from "@wsp/protocol";

export type Resolve = (path: string) => SlateJson | undefined;
export interface Row {
  item: SlateJson;
  index: number;
}

const contextOf = (resolve: Resolve, row: Row | undefined, now: number) => ({ resolve, now, ...(row !== undefined ? { item: row.item, index: row.index } : {}) });

export function evaluate(expr: string, resolve: Resolve, row: Row | undefined, now: number): SlateJson | undefined {
  try {
    return evaluateSlateExpression(expr, contextOf(resolve, row, now));
  } catch {
    return undefined;
  }
}

export function resolveProp(value: SlatePropValue, resolve: Resolve, row: Row | undefined, now: number): SlateJson | undefined {
  try {
    return resolveSlateProp(value, contextOf(resolve, row, now));
  } catch {
    return undefined;
  }
}

export function dependencies(expr: string): string[] {
  try {
    return slateDependencies(expr);
  } catch {
    return [];
  }
}
