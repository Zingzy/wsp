// SPDX-License-Identifier: AGPL-3.0-only
// The renderer's one door into the formula language: evaluate, resolve a prop, list what an expression reads.
// Own names are $name (02-model); every path that reaches the resolver and every dependency comes back in that form.
import { evaluateSlateExpression, isSlateBinding, isSlateFormat, resolveSlateProp, slateDependencies, type SlateJson, type SlatePropValue } from "@wsp/protocol";

export type Resolve = (path: string) => SlateJson | undefined;
export interface Row {
  item: SlateJson;
  index: number;
}

// The module this build carries reads own names as state.<name>; the bridge spells $name that way going in and
// back to $name coming out.
const OWN = /\$(?=[a-zA-Z_])/g;
const inward = (text: string): string => text.replace(OWN, "state.");
const outward = (path: string): string => (path.startsWith("state.") ? `$${path.slice(6)}` : path.startsWith("state[") ? `$${path.slice(5)}` : path);

function contextOf(resolve: Resolve, row: Row | undefined, now: number) {
  return { resolve: (path: string) => resolve(outward(path)), ...(row !== undefined ? { row } : {}), now };
}

function inwardProp(value: SlatePropValue): SlatePropValue {
  if (value === null || typeof value !== "object") return value;
  if (isSlateBinding(value)) return { bind: inward(value.bind) };
  if (isSlateFormat(value)) return { format: inward(value.format) };
  if (Array.isArray(value)) return value.map(inwardProp);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inwardProp(v)]));
}

export function evaluate(expr: string, resolve: Resolve, row: Row | undefined, now: number): SlateJson | undefined {
  try {
    return evaluateSlateExpression(inward(expr), contextOf(resolve, row, now));
  } catch {
    return undefined;
  }
}

export function resolveProp(value: SlatePropValue, resolve: Resolve, row: Row | undefined, now: number): SlateJson | undefined {
  try {
    return resolveSlateProp(inwardProp(value), contextOf(resolve, row, now));
  } catch {
    return undefined;
  }
}

export function dependencies(expr: string): string[] {
  try {
    return slateDependencies(inward(expr)).map(outward);
  } catch {
    return [];
  }
}
