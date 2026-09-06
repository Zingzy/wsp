// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file, with a
// summary on the terminal of what decided each tick. Names and counts only;
// the histories are read here and nothing of them leaves.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentName } from "@wsp/catalog";
import { type Host, computeRecipe } from "@wsp/collect";
import type { Recipe, RecipeCustomRow, RecipeHistory, RecipeRow, RecipeSource } from "@wsp/protocol";
import { loadRecipe } from "./init-recipe.js";
import { customTableLines, withCustom } from "./recipe-custom.js";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

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

/** The ticked tools under the source that ticked them. */
export function toolLines(rows: readonly RecipeRow[]): string[] {
  const tools = rows.filter(r => r.kind === "tool");
  const on = tools.filter(r => r.on);
  const by = (kind: RecipeSource["kind"]): string => on.filter(r => r.source.kind === kind).map(r => agentName(r.id)).join(", ") || "none";
  return [`Tools on: ${on.length} of ${tools.length}`, `  installed here: ${by("installed")}`, `  used by your agents: ${by("used")}`, `  popular in the catalog: ${by("popular")}`];
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
  /** The rows the run adds outside the catalog (wsp recipe --add); they join whatever a recipe at `out` already carries. */
  add?: readonly RecipeCustomRow[];
}

export async function writeRecipe(host: Host, out: string, log: (line: string) => void, opts: RecipeCommandOptions = {}): Promise<Recipe> {
  log("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const here = await computeRecipe(host, { ...(opts.now !== undefined ? { now: opts.now } : {}), onHistory: h => log(historyLine(h)) });
  // The rows outside the catalog are the file's, not this computer's: an earlier run's stand, so --add adds up across calls.
  const recipe = withCustom({ ...here, ...carriedOver(out, log) }, opts.add ?? []);
  const agents = recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => agentName(r.id));
  log(`Agents here: ${agents.join(", ") || "none"}`);
  toolLines(recipe.rows).forEach(log);
  customTableLines(recipe).forEach(log);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recipe, null, 2)}\n`);
  log(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  return recipe;
}
