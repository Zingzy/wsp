// SPDX-License-Identifier: AGPL-3.0-only
// The small recipe from this computer: every catalog entry with a tick and
// the source of it. Installed here wins, then used by the agents' own session
// histories, then the catalog's evidence for a fresh computer. Names, paths
// and counts only; nothing read leaves as a value.
import { CATALOG, catalogEntry, type CatalogEntry, type AgentEntry } from "@wsp/catalog";
import type { Recipe, RecipeHistory, RecipeRow, RecipeSource } from "@wsp/protocol";
import { presenceOf } from "./detect/presence.js";
import { type AgentHistory, type Count, readHistories } from "./history/index.js";
import type { Host } from "./host.js";
import { type ProjectScan, scanProject } from "./project/index.js";

/** Sessions an agent has to have reached for a tool before use alone ticks it: one session is a look, not a habit. */
export const USED_TICK_SESSIONS = 2;

export interface RecipeOptions {
  /** The entries to decide; the shipped catalog by default. */
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
  /** Told each catalog entry found on this computer, as it is found. */
  onPresent?: (e: CatalogEntry) => void;
  /** Told each agent's history as it is read, as the counts the recipe keeps. */
  onHistory?: (h: RecipeHistory) => void;
  /** A project folder whose own manifests say what it takes to build; its needs weigh before anything this computer says. */
  project?: string;
  /** Told what that folder asked for, the candidates the catalog carries no row for among them. */
  onProject?: (scan: ProjectScan) => void;
}

/** What every agent's histories together said about each catalog tool; each store's sessions are its own, so they add. */
function usedTools(histories: readonly AgentHistory[]): Map<string, Count> {
  const out = new Map<string, Count>();
  for (const h of histories) {
    for (const [id, c] of h.usage.tools) {
      const was = out.get(id) ?? { sessions: 0, calls: 0 };
      out.set(id, { sessions: was.sessions + c.sessions, calls: was.calls + c.calls });
    }
  }
  return out;
}

/** The recipe with every row a project asked for ticked and saying which of its files asked: a project's own needs
 * weigh before what is installed here, what the agents used and what the catalog favours. A need the recipe never
 * named gets a row of its own, so a folder can ask for a tool nothing on this computer ever mentioned. */
export function withProject(recipe: Recipe, scan: ProjectScan): Recipe {
  const needs = new Map(scan.rows.map(n => [n.id, n]));
  const source = (why: string): RecipeSource => ({ kind: "project", why });
  const rows = recipe.rows.map(r => {
    const need = needs.get(r.id);
    return need === undefined ? r : { ...r, on: true, source: source(need.why) };
  });
  const named = new Set(recipe.rows.map(r => r.id));
  const missing = [...needs.values()].flatMap((need): RecipeRow[] => {
    const e = named.has(need.id) ? undefined : catalogEntry(need.id);
    return e === undefined ? [] : [{ id: e.id, kind: e.kind, on: true, source: source(need.why), ...(e.size !== undefined ? { size: e.size } : {}) }];
  });
  return { ...recipe, rows: [...rows, ...missing] };
}

export async function computeRecipe(host: Host, opts: RecipeOptions = {}): Promise<Recipe> {
  const catalog = opts.catalog ?? CATALOG;
  const present = new Map<string, RecipeSource>();
  for (const e of catalog) {
    const p = await presenceOf(host, e);
    if (p === undefined) continue;
    present.set(e.id, { kind: "installed", paths: p.paths, bin: p.bin });
    opts.onPresent?.(e);
  }
  const histories = await readHistories(host, catalog.filter((e): e is AgentEntry => e.kind === "agent"), opts.onHistory);
  const used = usedTools(histories);
  const rows = catalog.map((e): RecipeRow => {
    const size = e.size !== undefined ? { size: e.size } : {};
    const installed = present.get(e.id);
    // What the agents ran is the source even for a tool this computer has, so a row can say it is installed and
    // never used; being here still ticks it.
    const u = e.kind === "tool" ? used.get(e.id) : undefined;
    if (u !== undefined) return { id: e.id, kind: e.kind, on: installed !== undefined || u.sessions >= USED_TICK_SESSIONS, source: { kind: "used", ...u }, ...size };
    if (installed !== undefined) return { id: e.id, kind: e.kind, on: true, source: installed, ...size };
    return { id: e.id, kind: e.kind, on: e.kind === "tool" && e.defaultOn, source: { kind: "popular", sessions: e.source.sessions, images: e.source.images }, ...size };
  });
  const recipe: Recipe = {
    version: 1,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    histories: histories.map(({ agent, state, sessions, calls }) => ({ agent, state, sessions, calls })),
    rows,
  };
  if (opts.project === undefined) return recipe;
  const scan = await scanProject(host, opts.project);
  opts.onProject?.(scan);
  return withProject(recipe, scan);
}
