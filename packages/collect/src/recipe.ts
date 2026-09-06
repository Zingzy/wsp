// SPDX-License-Identifier: AGPL-3.0-only
// The small recipe from this computer: every catalog entry with a tick and
// the source of it. Installed here wins, then used by the agents' own session
// histories, then the catalog's evidence for a fresh computer. Names, paths
// and counts only; nothing read leaves as a value.
import { CATALOG, type CatalogEntry, type AgentEntry } from "@wsp/catalog";
import type { Recipe, RecipeHistory, RecipeRow, RecipeSource } from "@wsp/protocol";
import { presenceOf } from "./detect/presence.js";
import { type AgentHistory, type Count, readHistories } from "./history/index.js";
import type { Host } from "./host.js";

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
    if (installed !== undefined) return { id: e.id, kind: e.kind, on: true, source: installed, ...size };
    const u = e.kind === "tool" ? used.get(e.id) : undefined;
    if (u !== undefined) return { id: e.id, kind: e.kind, on: u.sessions >= USED_TICK_SESSIONS, source: { kind: "used", ...u }, ...size };
    return { id: e.id, kind: e.kind, on: e.kind === "tool" && e.defaultOn, source: { kind: "popular", sessions: e.source.sessions, images: e.source.images }, ...size };
  });
  return {
    version: 1,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    histories: histories.map(({ agent, state, sessions, calls }) => ({ agent, state, sessions, calls })),
    rows,
  };
}
