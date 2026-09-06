// SPDX-License-Identifier: AGPL-3.0-only
// Where the small recipe lives on this computer and how it is read and
// written. Nothing here reaches past the catalog and the protocol, so the MCP
// server can write a recipe without the runtime or the engine coming with it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loginIdOf } from "@wsp/catalog";
import { Recipe } from "@wsp/protocol";

/** Where the small recipe lives, beside the saved manifest: what wsp recipe writes and wsp init --recipe reads. */
export function smallRecipePath(statePath: string): string {
  return join(dirname(statePath), "recipe.json");
}

/** The small recipe wsp recipe wrote (or a person or an agent did), checked against the protocol's shape. */
export function loadRecipe(path: string): Recipe {
  if (!existsSync(path)) throw new Error(`no recipe at ${path}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = Recipe.safeParse(data);
  if (r.success) return r.data;
  throw new Error(`${path}: invalid recipe: ${r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}

export function saveSmallRecipe(path: string, recipe: Recipe): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`);
}

/** This computer's recipe with a saved one's ticks and answers written on, by id: a row the saved one lacks is off
 * and unanswered, and a saved row this computer's recipe does not carry follows them as it was saved. The rows
 * outside the catalog are the saved recipe's own: nothing on this computer decides them. */
export function withTicksOf(here: Recipe, saved: Recipe): Recipe {
  const rows = new Map(saved.rows.map(r => [r.id, r]));
  const ids = new Set(here.rows.map(r => r.id));
  return {
    ...here,
    ...(saved.custom !== undefined ? { custom: saved.custom } : {}),
    rows: [
      ...here.rows.map(r => {
        const { signIn: _signIn, ...rest } = r;
        const s = rows.get(r.id);
        return { ...rest, on: s?.on === true, ...(s?.signIn === undefined ? {} : { signIn: s.signIn }) };
      }),
      ...saved.rows.filter(r => !ids.has(r.id)),
    ],
  };
}
