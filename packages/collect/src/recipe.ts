// SPDX-License-Identifier: AGPL-3.0-only
// The small recipe from this computer: every catalog entry with a tick and
// the source of it. One rule decides every tick, and which rule is the
// caller's choice: what the agents used here, what is installed here, the
// catalog's own default, or the three together. Names, paths and counts only;
// nothing read leaves as a value.
import { CATALOG, type CatalogEntry, type AgentEntry, catalogToolFor, sizeBytes } from "@wsp/catalog";
import type { Recipe, RecipeRow, RecipeSource, RecipeTick } from "@wsp/protocol";
import { presenceOf } from "./detect/presence.js";
import { type AgentHistory, type Count, type Usage, meetsUsedFloor, readHistories } from "./history/index.js";
import type { Host } from "./host.js";

/** How one rule reads the computer. `order` is the source kinds it reports for an entry, best first: the first kind
 * this computer has anything for is the row's source, so the words beside a row say what the rule went on. It takes
 * the entry because a rule may read an agent and a tool differently: what the agents ran is the plainest thing to
 * say about a tool, while an agent is placed by whether it is on this computer. */
interface TickRule {
  order(entry: CatalogEntry): readonly RecipeSource["kind"][];
  /** Whether the row is on, read from everything this computer said about it rather than from the one source the
   * order picked to show: a rule may tick on a use while the row still reads as installed here. */
  on(sources: Sources, entry: CatalogEntry): boolean;
  /** Whether this rule weighs a tool's use against the floor, so a table drawn from its recipe names the floor. */
  weighsUse: boolean;
  /** Whether this rule ticks an agent the caller says no adapter can open a thread on. Only the rule that answers
   * about this computer does: it is saying what is here, not what wsp can drive. Every other rule holds such an
   * agent off, since ticking it would build a machine nothing here can open a thread on. */
  ticksAgentsWithoutAdapter: boolean;
}

const INSTALLED_FIRST: readonly RecipeSource["kind"][] = ["installed", "used", "popular"];
const USED_FIRST: readonly RecipeSource["kind"][] = ["used", "installed", "popular"];
const installedFirst = (): readonly RecipeSource["kind"][] => INSTALLED_FIRST;
/** Everything this computer said about one entry; `popular` is the catalog's own and is always there. */
type Sources = Partial<Record<RecipeSource["kind"], RecipeSource>>;
/** The catalog's own default: a tool the catalog ships on, never an agent. */
const catalogDefault = (_sources: Sources, entry: CatalogEntry): boolean => entry.kind === "tool" && entry.defaultOn;

/** Whether what the agents ran ticks the entry: a tool at or over the floor its size sets, an agent on any session
 * of its own, since an agent's sessions are the use and its row is still placed by whether it is here. */
function usedEnough(sources: Sources, entry: CatalogEntry): boolean {
  const used = sources.used;
  if (used === undefined || used.kind !== "used") return false;
  return entry.kind === "tool" ? meetsUsedFloor(used, sizeBytes(entry.size)) : true;
}

/** One rule per `--tick` word; adding a word is an entry here and nothing else. */
const TICK_RULES: Readonly<Record<RecipeTick, TickRule>> = {
  used: { order: entry => (entry.kind === "tool" ? USED_FIRST : INSTALLED_FIRST), on: usedEnough, weighsUse: true, ticksAgentsWithoutAdapter: false },
  installed: { order: installedFirst, on: sources => sources.installed !== undefined, weighsUse: false, ticksAgentsWithoutAdapter: true },
  default: { order: installedFirst, on: catalogDefault, weighsUse: false, ticksAgentsWithoutAdapter: false },
};

/** What the wizard's screens start from when no rule was named. A tool: installed here, then use over the floor,
 * then the catalog's default; a use below the floor is the row's answer and vetoes the catalog default under it, so
 * a tool looked at once stays off however popular it is. An agent: only its own use here, so one installed and never
 * run is off with the row saying so. */
const BLENDED: TickRule = {
  // A tool says what the agents ran with it, so a row can read "installed here, never used"; an agent is placed by
  // whether it is on this computer, and its tick is a separate answer.
  order: entry => (entry.kind === "tool" ? USED_FIRST : INSTALLED_FIRST),
  weighsUse: true,
  ticksAgentsWithoutAdapter: false,
  on: (sources, entry) => {
    if (entry.kind !== "tool") return usedEnough(sources, entry);
    if (sources.installed !== undefined) return true;
    return sources.used !== undefined ? usedEnough(sources, entry) : catalogDefault(sources, entry);
  },
};

/** Whether the rule a recipe went on (the named one, or the wizard's blended one when none is) weighs use against
 * the floor, so the table drawn from it should name the floor. */
export function floorApplies(tick: RecipeTick | undefined): boolean {
  return (tick !== undefined ? TICK_RULES[tick] : BLENDED).weighsUse;
}

export interface RecipeOptions {
  /** The entries to decide; the shipped catalog by default. */
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
  /** Which rule decides every tick; the blended one when absent. */
  tick?: RecipeTick;
  /** Absolute folders to weigh the histories against: only sessions that ran at one of them or inside it are
   * counted, so a recipe for one project reflects that project's tools. Every session counts when this is absent. */
  folders?: readonly string[];
  /** The catalog ids of the agents this host can run a thread on. An agent outside the list is off under every
   * rule but `installed`, since ticking it would build a machine nothing here can open a thread on. */
  threadAgents: readonly string[];
  /** Told each catalog entry found on this computer, as it is found. */
  onPresent?: (e: CatalogEntry) => void;
  /** Told each agent's history as it is read, with the counts the recipe keeps. */
  onHistory?: (h: AgentHistory) => void;
}

/** Counts from every agent's store added together; each store's sessions are its own, so they add. */
function merged(histories: readonly AgentHistory[], of: (u: Usage) => ReadonlyMap<string, Count>): Map<string, Count> {
  const out = new Map<string, Count>();
  for (const h of histories) {
    for (const [name, c] of of(h.usage)) {
      const was = out.get(name) ?? { sessions: 0, calls: 0 };
      out.set(name, { sessions: was.sessions + c.sessions, calls: was.calls + c.calls });
    }
  }
  return out;
}

/** One command the agents ran here, with how much. */
export interface CommandCount extends Count {
  name: string;
}

const byUse = (a: CommandCount, b: CommandCount): number => b.calls - a.calls || b.sessions - a.sessions || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Every command the agents ran here that no catalog row carries, most-run first: what this person works with that
 * the catalog does not know yet. Shell syntax and builtins are already out; the command parser drops them. */
export function unknownCommands(histories: readonly AgentHistory[]): CommandCount[] {
  return [...merged(histories, u => u.commands)]
    .flatMap(([name, c]) => (catalogToolFor(name) === undefined ? [{ name, ...c }] : []))
    .sort(byUse);
}

/** What one agent's own store says about the agent itself: its sessions here are its use. */
const agentUse = (h: AgentHistory | undefined): Count | undefined => (h !== undefined && h.state === "read" ? { sessions: h.sessions, calls: h.calls } : undefined);

export async function computeRecipe(host: Host, opts: RecipeOptions): Promise<Recipe> {
  const catalog = opts.catalog ?? CATALOG;
  const rule = opts.tick !== undefined ? TICK_RULES[opts.tick] : BLENDED;
  const present = new Map<string, RecipeSource>();
  for (const e of catalog) {
    const p = await presenceOf(host, e);
    if (p === undefined) continue;
    present.set(e.id, { kind: "installed", paths: p.paths, bin: p.bin });
    opts.onPresent?.(e);
  }
  const histories = await readHistories(host, catalog.filter((e): e is AgentEntry => e.kind === "agent"), {
    ...(opts.onHistory !== undefined ? { onAgent: opts.onHistory } : {}),
    ...(opts.folders !== undefined ? { folders: opts.folders } : {}),
  });
  const usedTools = merged(histories, u => u.tools);
  const byAgent = new Map(histories.map(h => [h.agent, h]));
  const threads = new Set(opts.threadAgents);
  const rows = catalog.map((e): RecipeRow => {
    const used = e.kind === "tool" ? usedTools.get(e.id) : agentUse(byAgent.get(e.id));
    const bytes = sizeBytes(e.size);
    const size = bytes !== undefined ? { size: bytes } : {};
    const installed = present.get(e.id);
    const popular: RecipeSource = { kind: "popular", sessions: e.source.sessions, images: e.source.images };
    const sources: Sources = {
      ...(installed !== undefined ? { installed } : {}),
      ...(used !== undefined ? { used: { kind: "used" as const, ...used } } : {}),
      popular,
    };
    const source = rule.order(e).flatMap(kind => sources[kind] ?? [])[0] ?? popular;
    const held = e.kind === "agent" && !threads.has(e.id) && !rule.ticksAgentsWithoutAdapter;
    return { id: e.id, kind: e.kind, on: !held && rule.on(sources, e), source, ...size };
  });
  return {
    version: 1,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    ...(opts.tick !== undefined ? { tick: opts.tick } : {}),
    histories: histories.map(({ agent, state, sessions, calls }) => ({ agent, state, sessions, calls })),
    rows,
  };
}
