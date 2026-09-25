// SPDX-License-Identifier: AGPL-3.0-only
// The Skills tab: every skill in every folder an agent reads, one row per
// skill with the agents that read it after its name and the folder it really
// lives in under it. The detail says who wrote it, where every copy is, and
// what can be done to it: a skill wsp writes is always on, a plugin's comes
// and goes with the plugin, a project's lives in the repo.
import { PowerOffIcon, ScrollTextIcon, Trash2Icon } from "lucide-react";
import { agentName, isSystemSkill } from "@wsp/catalog";
import type { AgentsReport, SkillRow } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, holdAll, notYet, onImage, type RowAct, type RowsContext } from "../agentsRows.js";
import { byName, kind, matchesAny, type Fact, type GroupBy, type GroupView, type KindModule } from "./kind.js";

/** The folder a skill really lives in: the one that is no link, else the first. */
const realPath = (row: SkillRow): string => (row.paths.find(p => p.linkTo === undefined) ?? row.paths[0])?.path ?? "";

const agentsOf = (row: SkillRow): string[] => [...new Set(row.paths.flatMap(p => (p.agent === undefined ? [] : [p.agent])))];

const rowId = (row: SkillRow): string => `skill-${row.scope}-${row.name}`;

type Source = "system" | "plugin" | "user" | "project";
const sourceOf = (row: SkillRow): Source => (isSystemSkill(row.name) ? "system" : row.scope);

const SOURCES: readonly { source: Source; label: string }[] = [
  { source: "system", label: "System" },
  { source: "plugin", label: "Plugins" },
  { source: "user", label: "Global" },
  { source: "project", label: "Project" },
];

function actsOf(row: SkillRow, ctx: RowsContext): RowAct[] {
  const source = sourceOf(row);
  if (source === "system" || source === "plugin" || onImage(ctx)) return [];
  const turnOff = notYet("turn-off", W.turnOff, PowerOffIcon, source === "project" ? { hover: W.livesInRepo(realPath(row)) } : {});
  return holdAll([turnOff, notYet("remove", W.remove, Trash2Icon, { destructive: true })], ctx);
}

export const SKILLS_KIND: KindModule<SkillRow> = {
  id: "skills",
  icon: ScrollTextIcon,
  word: "Skills",
  noun: n => `${n} ${n === 1 ? "skill" : "skills"}`,
  search: "Search skills",
  add: "Add a skill",
  rowHeight: "h-14",
  groupings: ["none", "agent", "source"],
  defaultGroup: shell => (shell === "page" ? "source" : "none"),
  items: (report: AgentsReport) => [...report.skills].sort(byName),
  count: items => items.length,
  key: rowId,
  matches: (row, q) => matchesAny(q, row.name, row.description, realPath(row), ...agentsOf(row).map(agentName)),
  groups: (items, by: GroupBy): GroupView<SkillRow>[] => {
    if (by === "agent") {
      const agents = [...new Set(items.flatMap(agentsOf))];
      const shared = items.filter(s => agentsOf(s).length === 0);
      return [...agents.map(agent => ({ id: `agent-${agent}`, label: agentName(agent), items: items.filter(s => agentsOf(s).includes(agent)) })), ...(shared.length === 0 ? [] : [{ id: "shared", label: W.shared, items: shared }])];
    }
    if (by === "source") {
      return SOURCES.flatMap(g => {
        const hit = items.filter(s => sourceOf(s) === g.source);
        return hit.length === 0 ? [] : [{ id: `source-${g.source}`, label: g.label, items: hit }];
      });
    }
    return [{ id: "all", items }];
  },
  row: row => ({ key: rowId(row), title: row.name, lead: { kind: "glyph", icon: ScrollTextIcon }, marks: agentsOf(row), subtext: realPath(row) }),
  detail: (row, ctx) => {
    const source = sourceOf(row);
    // The shared folder first, then each agent's own, every one by its own path alone.
    const ordered = [...row.paths].sort((a, b) => Number(a.agent !== undefined) - Number(b.agent !== undefined));
    const status: Fact =
      source === "system"
        ? { id: "status", label: W.status, value: W.alwaysOn, fact: W.keptCurrent }
        : source === "plugin"
          ? { id: "status", label: W.status, value: W.on, fact: W.fromPlugin }
          : source === "project"
            ? { id: "status", label: W.status, value: W.on, fact: W.inRepo }
            : { id: "status", label: W.status, value: W.on };
    const facts: Fact[] = [
      status,
      ...(row.description === undefined ? [] : [{ id: "description", label: W.description, value: row.description }]),
      ...ordered.map((p, at) => ({ id: `path-${at}`, label: at === 0 ? W.path : "", value: p.path, copy: true, ...(p.agent === undefined ? { fact: W.shared } : { agent: p.agent }) })),
    ];
    return { title: row.name, lead: { kind: "glyph", icon: ScrollTextIcon }, marks: agentsOf(row), facts, acts: actsOf(row, ctx) };
  },
  empty: on => `No skills on ${on} yet.`,
  none: "no skills",
};

export const SKILLS = kind(SKILLS_KIND);
