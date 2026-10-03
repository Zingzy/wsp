// SPDX-License-Identifier: AGPL-3.0-only
// The path grammar the renderer walks itself: a head name, then ".field" and "[index]" steps, as the expression
// language writes them. Sources answer the steps after the head; the dependency sets compare paths as text.
import { isSlateBinding, isSlateFormat, slateDependencies, type SlateJson, type SlatePiece, type SlatePropValue } from "@wsp/protocol";

const STEP = /^(?:\.([a-zA-Z_][a-zA-Z0-9_]*)|\[(-?\d+)\])/;

/** The head and the steps of a path, or undefined for text that is not one. */
export function splitPath(path: string): { head: string; steps: (string | number)[] } | undefined {
  const head = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(path);
  if (head === null) return undefined;
  const steps: (string | number)[] = [];
  let rest = path.slice(head[0].length);
  while (rest.length > 0) {
    const m = STEP.exec(rest);
    if (m === null) return undefined;
    steps.push(m[1] !== undefined ? m[1] : Number(m[2]));
    rest = rest.slice(m[0].length);
  }
  return { head: head[0], steps };
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** Walks steps into a value; a step into nothing, or into the wrong kind of value, is undefined. */
export function walk(value: unknown, steps: readonly (string | number)[]): SlateJson | undefined {
  let at: unknown = value;
  for (const step of steps) {
    if (at === null || at === undefined || typeof at !== "object") return undefined;
    if (Array.isArray(at)) {
      if (typeof step !== "number") return undefined;
      at = at[step < 0 ? at.length + step : step];
    } else {
      if (typeof step !== "string" || UNSAFE.has(step) || !Object.prototype.hasOwnProperty.call(at, step)) return undefined;
      at = (at as Record<string, unknown>)[step];
    }
  }
  return at === undefined ? undefined : (at as SlateJson);
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
    for (const path of slateDependencies(expression)) {
      if (!ROW_HEADS.has(splitPath(path)?.head ?? "")) out.add(path);
    }
  }
  return [...out];
}

/** What a piece's `when` reads, and what its props read; a hidden piece subscribes to the first alone. */
export function pieceReads(piece: SlatePiece): { when: string[]; props: string[] } {
  return {
    when: piece.when === undefined ? [] : readsOf([piece.when]),
    props: readsOf(Object.values(piece.props ?? {}).flatMap(expressionsIn)),
  };
}
