// SPDX-License-Identifier: AGPL-3.0-only
// The path grammar the renderer walks itself: a head name, then ".field" and "[index]" steps, as the expression
// language writes them. Sources answer the steps after the head; the dependency sets compare paths as text.
import { getSlateValue, isSlateBinding, isSlateFormat, parseSlateOwnPath, setSlateValue, slateSegments, slateStep, type SlateJson, type SlatePropValue } from "@wsp/protocol";
import { dependencies } from "./expr.js";
import type { SlatePiece } from "./model.js";

/** The head and the steps of a path, or undefined for text that is not one. */
export function splitPath(path: string): { head: string; steps: (string | number)[] } | undefined {
  const head = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(path);
  const steps = head === null ? undefined : slateSegments(path.slice(head[0].length));
  return head === null || steps === undefined ? undefined : { head: head[0], steps };
}

/** A literal "$name" with no steps: a value named whole, as an output names its run. */
export const isOwnName = (v: unknown): v is string => typeof v === "string" && parseSlateOwnPath(v)?.segs.length === 0;

/** An own path, "$name" then steps: the value's name and the steps into it. */
export function ownPath(path: string): { name: string; steps: (string | number)[] } | undefined {
  const own = parseSlateOwnPath(path);
  return own === undefined ? undefined : { name: own.name, steps: own.segs };
}

export const getOwn = (values: Readonly<Record<string, SlateJson>>, path: string): SlateJson | undefined => getSlateValue(values, path);

/** A copy of the values with one path written; a path that cannot be written leaves them as they were. */
export const setOwn = (values: Readonly<Record<string, SlateJson>>, path: string, value: SlateJson): Record<string, SlateJson> => setSlateValue(values, path, value) ?? { ...values };

/** Steps into a value, each a record's own field or a list's item, never a prototype key. */
export function walk(value: unknown, steps: readonly (string | number)[]): SlateJson | undefined {
  return steps.reduce<SlateJson | undefined>((at, step) => slateStep(at, step), value as SlateJson | undefined);
}

/** Whether a change at one path can move a value read at another: either is the other or under it. */
export function touches(read: string, changed: string): boolean {
  const under = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}[`);
  return under(read, changed) || under(changed, read);
}

/** The expressions inside a format string's ${...} holes; "$${" is a literal and opens none. */
export function formatHoles(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "$" && text[i + 1] === "$" && text[i + 2] === "{") {
      i += 2;
      continue;
    }
    if (text[i] !== "$" || text[i + 1] !== "{") continue;
    let depth = 0;
    let quote: string | null = null;
    let j = i + 2;
    for (; j < text.length; j += 1) {
      const c = text[j]!;
      if (quote !== null) {
        if (c === "\\") j += 1;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    out.push(text.slice(i + 2, j));
    i = j;
  }
  return out;
}

/** Every expression a prop value holds, bindings and format holes, nested lists and records included. */
export function expressionsIn(value: SlatePropValue | undefined): string[] {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (isSlateBinding(value)) return [value.bind];
  if (isSlateFormat(value)) return formatHoles(value.format);
  if (Array.isArray(value)) return value.flatMap(expressionsIn);
  return Object.values(value).flatMap(expressionsIn);
}

const ROW_HEADS = new Set(["item", "index"]);

/** The source and state paths an expression list reads, less the row scope, which the repeating piece owns. */
export function readsOf(expressions: readonly string[]): string[] {
  const out = new Set<string>();
  for (const expression of expressions) {
    for (const path of dependencies(expression)) {
      if (!ROW_HEADS.has(splitPath(path)?.head ?? "")) out.add(path);
    }
  }
  return [...out];
}

/** The when an item written out in a list prop carries: a formula as text. */
export function whenOf(item: SlatePropValue | undefined): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const when = (item as Readonly<Record<string, SlatePropValue>>)["when"];
  return typeof when === "string" ? when : undefined;
}

/** What a piece's `when` reads, and what its props read; a hidden piece subscribes to the first alone. A literal
 * "$name" prop names a value the piece reads whole (an output's run). */
export function pieceReads(piece: SlatePiece): { when: string[]; props: string[] } {
  const values = Object.values(piece.props ?? {});
  const named = values.filter(isOwnName);
  // A fact, a column, an option or a row action written out carries its own when, a formula as text.
  const whens = values.flatMap(v => (Array.isArray(v) ? v.flatMap(item => whenOf(item) ?? []) : []));
  return {
    when: piece.when === undefined ? [] : readsOf([piece.when]),
    props: [...new Set([...readsOf([...values.flatMap(expressionsIn), ...whens]), ...named])],
  };
}

/** The paths an own derived value stands on, followed through other derived values to values and sources. */
export function expandDerived(paths: readonly string[], derived: Readonly<Record<string, string>>): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string) => {
    out.add(path);
    const name = ownPath(path)?.name;
    if (name === undefined || !Object.prototype.hasOwnProperty.call(derived, name) || seen.has(name)) return;
    seen.add(name);
    for (const dep of readsOf([derived[name]!])) visit(dep);
  };
  for (const path of paths) visit(path);
  return [...out];
}
