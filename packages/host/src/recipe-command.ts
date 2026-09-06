// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file, with a
// summary on the terminal of what decided each tick. Names and counts only;
// the histories are read here and nothing of them leaves.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { catalogEntry } from "@wsp/catalog";
import { type Host, computeRecipe } from "@wsp/collect";
import type { Recipe, RecipeHistory, RecipeRow, RecipeSource } from "@wsp/protocol";

const nameOf = (id: string): string => catalogEntry(id)?.name ?? id;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line per agent: what its history here said. */
export function historyLine(h: RecipeHistory): string {
  const name = nameOf(h.agent);
  switch (h.state) {
    case "read":
      return `${name}: ${plural(h.sessions, "session")}, ${plural(h.calls, "tool call")}`;
    case "empty":
      return `${name}: no history here`;
    case "unreadable":
      return `${name}: history is here but could not be read`;
    case "no-reader":
      return `${name}: no reader for its history yet`;
    default: {
      const _exhaustive: never = h.state;
      return _exhaustive;
    }
  }
}

/** The ticked tools under the source that ticked them. */
export function toolLines(rows: readonly RecipeRow[]): string[] {
  const tools = rows.filter(r => r.kind === "tool");
  const on = tools.filter(r => r.on);
  const by = (kind: RecipeSource["kind"]): string => on.filter(r => r.source.kind === kind).map(r => nameOf(r.id)).join(", ") || "none";
  return [`Tools on: ${on.length} of ${tools.length}`, `  installed here: ${by("installed")}`, `  used by your agents: ${by("used")}`, `  popular in the catalog: ${by("popular")}`];
}

export async function writeRecipe(host: Host, out: string, log: (line: string) => void, now?: () => Date): Promise<Recipe> {
  log("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const recipe = await computeRecipe(host, { ...(now !== undefined ? { now } : {}), onHistory: h => log(historyLine(h)) });
  const agents = recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => nameOf(r.id));
  log(`Agents here: ${agents.join(", ") || "none"}`);
  toolLines(recipe.rows).forEach(log);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recipe, null, 2)}\n`);
  log(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  return recipe;
}
