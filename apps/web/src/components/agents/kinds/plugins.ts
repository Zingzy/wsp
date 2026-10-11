// SPDX-License-Identifier: AGPL-3.0-only
// The Plugins tab: each agent's plugins, one row per agent and plugin, the
// agent's own group first and a project's after. A row is the plugin's name
// with its agent's mark and its marketplace under it, and its switch where the
// host turns it for the login: a project's is set in its repo and says On or
// Off, and one the agent cannot load says Missing. The page says where it
// comes from and what it brings, each kind with its count.
import { PowerIcon, PowerOffIcon, PuzzleIcon } from "lucide-react";
import { CATALOG_AGENTS, agentName } from "@wsp/catalog";
import { pluginMissingLine, projectPluginRefusal, type AgentsReport, type PluginRow } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, holdAll, onImage, pluginKey, type RowAct, type RowsContext } from "../agentsRows.js";
import { byName, kind, matchesAny, projectGroups, type DetailView, type Fact, type GroupView, type KindModule, type Status, type UnderRow } from "./kind.js";

const KINDS = Object.keys(W.brings) as (keyof PluginRow["brings"])[];

const ON: Status = { state: "on", tone: "good", words: W.on };
const OFF: Status = { state: "off", tone: "quiet", words: W.off };

/** A plugin the agent names and loads nothing of, for the reason the host read. */
const missingOf = (row: PluginRow, ctx: RowsContext): string | undefined => (row.missing === undefined ? undefined : pluginMissingLine(row, agentName(row.agent), ctx.on ?? ctx.computer ?? ""));

/** Its state where the row says one rather than a switch: Missing, or a project's On or Off with where it is set. */
function statusOf(row: PluginRow, ctx: RowsContext): Status | undefined {
  const missing = missingOf(row, ctx);
  if (missing !== undefined) return { state: "missing", tone: "waiting", words: W.missing, hover: missing };
  if (row.scope === "user") return undefined;
  return { ...(row.on ? ON : OFF), ...(row.setIn === undefined ? {} : { hover: projectPluginRefusal(row.id, row.setIn) }) };
}

/** The switch a login's own plugin turns by, while the host can. */
function actsOf(row: PluginRow, ctx: RowsContext): RowAct[] {
  if (row.scope !== "user" || row.missing !== undefined || onImage(ctx)) return [];
  const plugins = ctx.plugins;
  const busy = plugins?.busyOf(pluginKey(row)) === true;
  const turn: RowAct = { id: row.on ? "turn-off" : "turn-on", label: row.on ? W.turnOff : W.turnOn, icon: row.on ? PowerOffIcon : PowerIcon, ...(busy ? { busy: true } : plugins === undefined ? {} : { run: () => plugins.toggle(row, !row.on) }) };
  return holdAll([turn], ctx);
}

/** A marketplace's own page where its source is a GitHub repo, as owner/name, or an address. */
function sourcePage(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (/^https:\/\//.test(source)) return source;
  return /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}` : undefined;
}

/** What the page lists under its facts: one row per kind the plugin brings, its names and their count. */
function broughtRows(row: PluginRow): UnderRow[] {
  return KINDS.flatMap(k => (row.brings[k].length === 0 ? [] : [{ key: k, title: W.brings[k], subtext: row.brings[k].join(", "), count: String(row.brings[k].length) }]));
}

const AGENT_ORDER = new Map(CATALOG_AGENTS.map((a, i) => [a.id, i]));

export const PLUGINS_KIND: KindModule<PluginRow> = {
  id: "plugins",
  search: W.searchPlugins,
  items: (report: AgentsReport) => [...(report.plugins ?? [])].sort(byName),
  key: pluginKey,
  matches: (row, q) => matchesAny(q, row.name, row.id, row.marketplace, row.description, agentName(row.agent), row.project?.name, ...KINDS.flatMap(k => row.brings[k])),
  groups: (items): GroupView<PluginRow>[] => {
    const mine = items.filter(p => p.scope === "user");
    const agents = [...new Set(mine.map(p => p.agent))].sort((a, b) => (AGENT_ORDER.get(a) ?? Infinity) - (AGENT_ORDER.get(b) ?? Infinity) || a.localeCompare(b));
    return [...agents.map(agent => ({ id: `agent-${agent}`, label: agentName(agent), items: mine.filter(p => p.agent === agent) })), ...projectGroups(items.filter(p => p.scope !== "user"))];
  },
  row: (row, ctx) => {
    const status = statusOf(row, ctx);
    return { key: pluginKey(row), title: row.name, lead: { kind: "glyph", icon: PuzzleIcon }, marks: [row.agent], subtext: row.marketplace, ...(status === undefined ? {} : { status }) };
  },
  detail: (row, ctx) => {
    const status = statusOf(row, ctx) ?? (row.on ? ON : OFF);
    const page = sourcePage(row.source);
    const facts: Fact[] = [
      { id: "status", label: W.status, status },
      { id: "marketplace", label: W.marketplace, value: row.marketplace, ...(page === undefined ? {} : { href: page }) },
      ...(row.version === undefined ? [] : [{ id: "version", label: W.version, value: row.version }]),
      { id: "scope", label: W.scope, value: W.scopes[row.scope] },
      ...(row.path === undefined ? [] : [{ id: "path", label: W.path, value: row.path, copy: true }]),
      ...(row.setIn === undefined ? [] : [{ id: "set-in", label: W.setIn, value: row.setIn, copy: true }]),
    ];
    const brought = broughtRows(row);
    const about = missingOf(row, ctx) ?? row.description;
    const refused = ctx.plugins?.refusedOf(pluginKey(row));
    const detail: DetailView = {
      title: row.name,
      lead: { kind: "glyph", icon: PuzzleIcon },
      marks: [row.agent],
      ...(about === undefined ? {} : { about }),
      facts,
      acts: actsOf(row, ctx),
      ...(brought.length === 0 ? {} : { under: { title: W.whatItBrings, reading: false, rows: brought } }),
      ...(refused === undefined ? {} : { refused }),
    };
    return detail;
  },
  empty: on => W.noPlugins(on),
};

export const PLUGINS = kind(PLUGINS_KIND);
