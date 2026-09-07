// SPDX-License-Identifier: AGPL-3.0-only
// Where the small recipe and the cache of what the session histories came to
// live on this computer, and how the recipe is read and written. Nothing here
// reaches past the catalog, the protocol and the collector, so the MCP server
// can write a recipe without the runtime or the engine coming with it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loginIdOf } from "@wsp/catalog";
import { type HistoryCache, fileHistoryCache } from "@wsp/collect";
import { Recipe, type ToolPin } from "@wsp/protocol";

/** Where the small recipe lives, beside the saved manifest: what wsp recipe writes and wsp init --recipe reads. */
export function smallRecipePath(statePath: string): string {
  return join(dirname(statePath), "recipe.json");
}

/** What each of the agents' session files came to, beside the state: the one place that path is decided, so the
 * wizard, the recipe verb and the MCP tools all read and rewrite the same cache and none of them reads a session
 * file another already read. */
export function historyCache(statePath: string): HistoryCache {
  return fileHistoryCache(join(dirname(statePath), "history-cache.json"));
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

/** The pins a list of rows carries, by id: a recipe's rows by catalog id, a manifest's entries by row id. */
export function pinsOf(rows: readonly { id: string; pin?: ToolPin }[] | undefined): Map<string, ToolPin> {
  return new Map((rows ?? []).flatMap((r): [string, ToolPin][] => (r.pin === undefined ? [] : [[r.id, r.pin]])));
}

/** The recipe with these pins written on the rows they name; every other row keeps what it had. */
export function withPins(recipe: Recipe, pins: ReadonlyMap<string, ToolPin>): Recipe {
  if (pins.size === 0) return recipe;
  return { ...recipe, rows: recipe.rows.map(r => (pins.has(r.id) ? { ...r, pin: pins.get(r.id)! } : r)) };
}

/** This computer's recipe with a saved one's ticks, answers and pins written on, by id: a row the saved one lacks is
 * off and unanswered, and a saved row this computer's recipe does not carry follows them as it was saved. The rows
 * outside the catalog are the saved recipe's own: nothing on this computer decides them. */
export function withTicksOf(here: Recipe, saved: Recipe): Recipe {
  const rows = new Map(saved.rows.map(r => [r.id, r]));
  const ids = new Set(here.rows.map(r => r.id));
  return withPins(
    {
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
    },
    pinsOf(saved.rows),
  );
}
