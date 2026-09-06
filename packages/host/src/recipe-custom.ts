// SPDX-License-Identifier: AGPL-3.0-only
// The rows a recipe carries that the catalog does not: how `wsp recipe --add`
// and the MCP recipe tool read them, how they join a recipe, and the lines
// they take in the recipe's table. The install line runs as given, so nothing
// here rewrites one; a row outside the catalog is never offered a sign-in.
import { ADDED_BY_AGENT, commandCheck, customRows, fmtBytes, type Recipe, type RecipeCustomRow } from "@wsp/protocol";
import { table } from "./init-layout.js";

/** `<id>=<value>`, split at the first equals; both sides have to be there. */
export function parsePair(flag: string, spec: string): { id: string; value: string } {
  const at = spec.indexOf("=");
  const id = at < 0 ? "" : spec.slice(0, at).trim();
  const value = at < 0 ? "" : spec.slice(at + 1).trim();
  if (id === "" || value === "") throw new Error(`${flag} takes <id>=<command>, not ${JSON.stringify(spec)}`);
  return { id, value };
}

export interface AddFlags {
  /** `<id>=<install command>`, one per row; repeated ids are one row, the last line winning. */
  add: readonly string[];
  /** `<id>=<command that exits 0 when installed>`; a row without one is checked with its id on PATH. */
  addCheck?: readonly string[];
  /** What the rows say they are for; the agent's own words, or that it added them. */
  why?: string;
}

/** The rows the flags name, in the order they were given. A check for an id nobody added is an error, since the
 * command it would guard never runs. */
export function customFromFlags(flags: AddFlags): RecipeCustomRow[] {
  const checks = new Map((flags.addCheck ?? []).map(spec => {
    const { id, value } = parsePair("--add-check", spec);
    return [id, value];
  }));
  const rows = new Map<string, RecipeCustomRow>();
  for (const spec of flags.add) {
    const { id, value } = parsePair("--add", spec);
    rows.set(id, { kind: "custom", id, name: id, install: [value], check: checks.get(id) ?? commandCheck(id), why: flags.why ?? ADDED_BY_AGENT });
  }
  for (const id of checks.keys()) if (!rows.has(id)) throw new Error(`--add-check ${id}: nothing was added under that id`);
  return [...rows.values()];
}

/** The recipe with these rows on it: a row already there under the same id is replaced, the rest keep their order. */
export function withCustom(recipe: Recipe, rows: readonly RecipeCustomRow[]): Recipe {
  const added = new Map(rows.map(r => [r.id, r]));
  const kept = customRows(recipe).map(r => added.get(r.id) ?? r);
  const known = new Set(kept.map(r => r.id));
  return { ...recipe, custom: [...kept, ...rows.filter(r => !known.has(r.id))] };
}

/** A custom row's cells in the recipe's table: the same columns a catalog row takes, and its install line beside
 * them, since the command is the row. */
export function customCells(row: RecipeCustomRow): string[] {
  return [row.id, "on", row.why, row.size === undefined ? "size unknown" : fmtBytes(row.size), row.install.join("; ")];
}

/** The custom rows as printed lines, headed like the table above them; nothing when the recipe has none. */
export function customTableLines(recipe: Pick<Recipe, "custom">): string[] {
  const rows = customRows(recipe);
  if (rows.length === 0) return [];
  return ["Rows the catalog does not carry:", ...table([["id", "on", "why", "size", "install"], ...rows.map(customCells)]).map(l => `  ${l}`)];
}
