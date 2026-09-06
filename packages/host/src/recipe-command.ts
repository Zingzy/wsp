// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file, with a
// summary on the terminal of what decided each tick. Names and counts only;
// the histories are read here and nothing of them leaves.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentName } from "@wsp/catalog";
import { type Host, type ProjectScan, computeRecipe } from "@wsp/collect";
import type { Recipe, RecipeHistory, RecipeRow, RecipeSource } from "@wsp/protocol";

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

/** The ticked tools under the source that ticked them, the project's own needs first. */
export function toolLines(rows: readonly RecipeRow[]): string[] {
  const tools = rows.filter(r => r.kind === "tool");
  const on = tools.filter(r => r.on);
  const by = (kind: RecipeSource["kind"]): string => on.filter(r => r.source.kind === kind).map(r => agentName(r.id)).join(", ") || "none";
  return [
    `Tools on: ${on.length} of ${tools.length}`,
    `  your project needs: ${by("project")}`,
    `  installed here: ${by("installed")}`,
    `  used by your agents: ${by("used")}`,
    `  popular in the catalog: ${by("popular")}`,
  ];
}

/** What the project folder asked for: the file that asked beside each row, then the names the catalog carries no row for. */
export function projectLines(scan: ProjectScan): string[] {
  return [
    `Read ${scan.dir} for what it needs: ${scan.rows.length === 0 ? "nothing the catalog carries" : scan.rows.map(n => n.name).join(", ")}`,
    ...scan.rows.map(n => `  ${n.name}: ${n.why}`),
    ...(scan.candidates.length > 0 ? [`  not in the catalog: ${scan.candidates.map(n => `${n.name} (${n.why})`).join(", ")}`] : []),
  ];
}

export interface WriteRecipeOptions {
  now?: () => Date;
  /** A project folder read for what its own manifests say it needs; those rows are ticked first. */
  project?: string;
}

export async function writeRecipe(host: Host, out: string, log: (line: string) => void, opts: WriteRecipeOptions = {}): Promise<Recipe> {
  log("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const recipe = await computeRecipe(host, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    onHistory: h => log(historyLine(h)),
    onProject: scan => projectLines(scan).forEach(log),
  });
  const agents = recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => agentName(r.id));
  log(`Agents here: ${agents.join(", ") || "none"}`);
  toolLines(recipe.rows).forEach(log);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recipe, null, 2)}\n`);
  log(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  return recipe;
}
