// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file, with the
// same table wsp init's second screen draws printed under it, so what would
// move and what each row costs is read before anything is built. Names and
// counts only; the histories are read here and nothing of them leaves.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG_AGENTS, CATALOG_TOOLS, agentName } from "@wsp/catalog";
import { type Host, computeRecipe } from "@wsp/collect";
import { plural } from "@wsp/engine";
import type { Recipe, RecipeHistory } from "@wsp/protocol";
import { recipeTable, tableLines, totalsLine } from "./init-table.js";

/** One line per agent: what its history here said. */
export function historyLine(h: RecipeHistory): string {
  const name = agentName(h.agent);
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

export interface WriteRecipeOptions {
  now?: () => Date;
  /** The colour depth the table is drawn at; 1, no colour, off a terminal. */
  depth?: number;
}

export async function writeRecipe(host: Host, out: string, log: (line: string) => void, opts: WriteRecipeOptions = {}): Promise<Recipe> {
  log("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const recipe = await computeRecipe(host, { ...(opts.now !== undefined ? { now: opts.now } : {}), onHistory: h => log(historyLine(h)) });
  const depth = opts.depth ?? 1;
  for (const [title, catalog, noun] of [["Agents", CATALOG_AGENTS, "agents"], ["Tools", CATALOG_TOOLS, "tools"]] as const) {
    const rows = recipeTable(recipe, catalog);
    log(title);
    tableLines(rows, depth).forEach(log);
    log(totalsLine(rows, noun));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recipe, null, 2)}\n`);
  log(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  return recipe;
}
