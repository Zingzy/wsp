// SPDX-License-Identifier: AGPL-3.0-only
// The small recipe from this computer: every catalog entry with a tick and
// the source of it. One rule decides every tick, and which rule is the
// caller's choice: what the agents used here, what is installed here, the
// catalog's own default, or the three together. Names, paths and counts only;
// nothing read leaves as a value.
import { CATALOG, type CatalogEntry, type AgentEntry, catalogToolFor } from "@wsp/catalog";
import type { Recipe, RecipeRow, RecipeSource, RecipeTick } from "@wsp/protocol";
import { presenceOf } from "./detect/presence.js";
import { type AgentHistory, type Count, type Usage, readHistories } from "./history/index.js";
import type { Host } from "./host.js";

/** Sessions an agent has to have reached for a tool before use alone ticks it under the blended rule: one session
 * is a look, not a habit. A `used` tick is the person's own choice and takes any use. */
export const USED_TICK_SESSIONS = 2;

/** How one rule reads the computer. `order` is the source kinds it reports, best first: the first kind this
 * computer has anything for is the row's source, so the words beside a row say what the rule went on. */
interface TickRule {
  order: readonly RecipeSource["kind"][];
  on(source: RecipeSource, entry: CatalogEntry): boolean;
  /** Whether this rule ticks an agent the caller says no adapter can open a thread on. Only the rule that answers
   * about this computer does: it is saying what is here, not what wsp can drive. Every other rule holds such an
   * agent off, since ticking it would build a machine nothing here can open a thread on. */
  ticksAgentsWithoutAdapter: boolean;
}

const INSTALLED_FIRST: readonly RecipeSource["kind"][] = ["installed", "used", "popular"];
/** The catalog's own default: a tool the catalog ships on, never an agent. */
const catalogDefault = (_source: RecipeSource, entry: CatalogEntry): boolean => entry.kind === "tool" && entry.defaultOn;

/** One rule per `--tick` word; adding a word is an entry here and nothing else. */
const TICK_RULES: Readonly<Record<RecipeTick, TickRule>> = {
  used: { order: ["used", "installed", "popular"], on: source => source.kind === "used", ticksAgentsWithoutAdapter: false },
  installed: { order: INSTALLED_FIRST, on: source => source.kind === "installed", ticksAgentsWithoutAdapter: true },
  default: { order: INSTALLED_FIRST, on: catalogDefault, ticksAgentsWithoutAdapter: false },
};

/** What the wizard's screens start from when no rule was named: installed here, then a habit in the histories,
 * then the catalog's default, and an agent only ever from this computer. A use below the threshold is the row's
 * answer and vetoes the catalog default under it, so a tool looked at once stays off however popular it is. */
const BLENDED: TickRule = {
  order: INSTALLED_FIRST,
  ticksAgentsWithoutAdapter: false,
  on: (source, entry) => {
    if (source.kind === "installed") return true;
    if (entry.kind !== "tool") return false;
    return source.kind === "used" ? source.sessions >= USED_TICK_SESSIONS : catalogDefault(source, entry);
  },
};

/** Whether a rule reads a use before what is installed. Under one that does, an installed row is only ever a row
 * with no use at all, so a reader may say so; under any other, an installed row says nothing either way. Derived
 * from the rule's own `order`, so a word added to TICK_RULES answers this by existing. A recipe that names no rule
 * makes no such claim. */
export function readsUsedFirst(tick: RecipeTick | undefined): boolean {
  if (tick === undefined) return false;
  const { order } = TICK_RULES[tick];
  return order.indexOf("used") < order.indexOf("installed");
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
   * rule but `installed`, since ticking it would build a machine nothing here can open a thread on. Absent, no
   * agent is held back this way. */
  threadAgents?: readonly string[];
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

export async function computeRecipe(host: Host, opts: RecipeOptions = {}): Promise<Recipe> {
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
  const threads = opts.threadAgents !== undefined ? new Set(opts.threadAgents) : undefined;
  const rows = catalog.map((e): RecipeRow => {
    const used = e.kind === "tool" ? usedTools.get(e.id) : agentUse(byAgent.get(e.id));
    const popular: RecipeSource = { kind: "popular", sessions: e.source.sessions, images: e.source.images };
    const sources: Partial<Record<RecipeSource["kind"], RecipeSource>> = {
      ...(present.has(e.id) ? { installed: present.get(e.id) } : {}),
      ...(used !== undefined ? { used: { kind: "used" as const, ...used } } : {}),
      popular,
    };
    const source = rule.order.flatMap(kind => sources[kind] ?? [])[0] ?? popular;
    const held = e.kind === "agent" && threads !== undefined && !threads.has(e.id) && !rule.ticksAgentsWithoutAdapter;
    return { id: e.id, kind: e.kind, on: !held && rule.on(source, e), source, ...(e.size !== undefined ? { size: e.size } : {}) };
  });
  return {
    version: 1,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    ...(opts.tick !== undefined ? { tick: opts.tick } : {}),
    histories: histories.map(({ agent, state, sessions, calls }) => ({ agent, state, sessions, calls })),
    rows,
  };
}
