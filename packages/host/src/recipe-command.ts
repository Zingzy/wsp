// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file, with the
// same tables wsp init's first two screens draw printed under it, and the rows
// the catalog does not carry under those, so what would move and what each row
// costs is read before anything is built. Names and counts only; the histories
// are read here and nothing of them leaves.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG_AGENTS, CATALOG_TOOLS, agentName } from "@wsp/catalog";
import { type Host, type ProjectScan, computeRecipe } from "@wsp/collect";
import { plural } from "@wsp/engine";
import type { Recipe, RecipeCustomRow, RecipeHistory } from "@wsp/protocol";
import { loadRecipe } from "./init-recipe.js";
import { recipeTable, tableLines, totalsLine } from "./init-table.js";
import { customTableLines, withCustom } from "./recipe-custom.js";

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

/** What the project folder asked for: the file that asked beside each row, then the names the catalog carries no row for. */
export function projectLines(scan: ProjectScan): string[] {
  return [
    `Read ${scan.dir} for what it needs: ${scan.rows.length === 0 ? "nothing the catalog carries" : scan.rows.map(n => n.name).join(", ")}`,
    ...scan.rows.map(n => `  ${n.name}: ${n.why}`),
    ...(scan.candidates.length > 0 ? [`  not in the catalog: ${scan.candidates.map(n => `${n.name} (${n.why})`).join(", ")}`] : []),
  ];
}

/** The rows outside the catalog a recipe already at this path carries; a file nobody can read is about to be
 * rewritten anyway, so its rows are named as lost rather than stopping the run. Both writers of that file, the
 * recipe verb and the wizard, read it through here, so neither writes over what the other added. */
export function carriedOver(out: string, log: (line: string) => void): { custom?: RecipeCustomRow[] } {
  if (!existsSync(out)) return {};
  try {
    const custom = loadRecipe(out).custom;
    return custom === undefined ? {} : { custom };
  } catch (e) {
    log(`${out} could not be read (${e instanceof Error ? e.message : String(e)}); it is rewritten, and any rows it added are gone.`);
    return {};
  }
}

export interface RecipeCommandOptions {
  now?: () => Date;
  /** A project folder read for what its own manifests say it needs; those rows are ticked before anything this computer says. */
  project?: string;
  /** The rows the run adds outside the catalog (wsp recipe --add); they join whatever a recipe at `out` already carries. */
  add?: readonly RecipeCustomRow[];
  /** The colour depth the tables are drawn at; 1, no colour, off a terminal. */
  depth?: number;
}

export async function writeRecipe(host: Host, out: string, log: (line: string) => void, opts: RecipeCommandOptions = {}): Promise<Recipe> {
  log("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const here = await computeRecipe(host, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    onHistory: h => log(historyLine(h)),
    onProject: scan => projectLines(scan).forEach(log),
  });
  // The rows outside the catalog are the file's, not this computer's: an earlier run's stand, so --add adds up across calls.
  const recipe = withCustom({ ...here, ...carriedOver(out, log) }, opts.add ?? []);
  const depth = opts.depth ?? 1;
  for (const [title, catalog, noun] of [["Agents", CATALOG_AGENTS, "agents"], ["Tools", CATALOG_TOOLS, "tools"]] as const) {
    const rows = recipeTable(recipe, catalog);
    log(title);
    tableLines(rows, depth).forEach(log);
    log(totalsLine(rows, noun));
  }
  // The rows the catalog does not carry sit under the two tables, in their own, since no group of the catalog's holds them.
  customTableLines(recipe).forEach(log);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recipe, null, 2)}\n`);
  log(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  return recipe;
}
