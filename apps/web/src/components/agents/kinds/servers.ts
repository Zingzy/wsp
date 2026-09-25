// SPDX-License-Identifier: AGPL-3.0-only
// The MCP servers tab: one entry per server across agents, folded where two
// agents in one scope name the same server with the same command or address.
// The row says where it is reached and its state in one badge; the detail is
// the /mcp view: status, command, names, each agent's file, the tools, and
// the next step first. Tools are asked only on a click.
import { PlugIcon, PowerIcon, PowerOffIcon, RefreshCwIcon, ServerIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import type { AgentsReport, McpRow, ServerToolsAnswer } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, editImageAct, heldReason, holdAll, notYet, onImage, serverSignInStart, signInAct, waitingFlow, type FlowView, type RowAct, type RowsContext } from "../agentsRows.js";
import { byName, kind, matchesAny, type Fact, type GroupBy, type GroupView, type KindModule, type ServerState, type StatusBadge } from "./kind.js";

/** Where a server is set up: the person's own files, or the project's. */
type Scope = "global" | "project";

export interface ServerEntry {
  readonly key: string;
  readonly name: string;
  readonly scope: Scope;
  /** The command with its values hidden, or the address. */
  readonly reach: string;
  readonly stdio: boolean;
  /** One per agent it is set up for, in the report's order. */
  readonly rows: readonly McpRow[];
}

const scopeOf = (row: McpRow): Scope => (row.scope === "project" ? "project" : "global");
const reachOf = (row: McpRow): string => (row.transport.kind === "stdio" ? row.transport.line : row.transport.host);
const rowId = (row: McpRow): string => `server-${row.agent}-${row.scope}-${row.name}`;

/** One entry per server: the same name reached the same way in the same scope is one server set up for each agent. */
export function foldServers(rows: readonly McpRow[]): ServerEntry[] {
  const out = new Map<string, { name: string; scope: Scope; reach: string; stdio: boolean; rows: McpRow[] }>();
  for (const row of rows) {
    const key = `${scopeOf(row)}\0${row.name}\0${row.transport.kind}\0${reachOf(row)}`;
    const was = out.get(key);
    if (was === undefined) out.set(key, { name: row.name, scope: scopeOf(row), reach: reachOf(row), stdio: row.transport.kind === "stdio", rows: [row] });
    else was.rows.push(row);
  }
  return [...out].map(([key, e]) => ({ key: `server-${key.replaceAll("\0", "-")}`, ...e }));
}

/** One agent's state for a server: off, then the connect's answer where one came back, then the config's word. */
export function rowState(row: McpRow, answer: ServerToolsAnswer | undefined): ServerState {
  if (!row.enabled) return "off";
  const auth = answer?.auth ?? row.auth;
  return auth === "failed" ? "failed" : auth === "needs-sign-in" ? "needs-sign-in" : auth === "unknown" ? "unknown" : "connected";
}

/** Worst first: what a folded entry's one badge says. */
const WORST: readonly ServerState[] = ["failed", "needs-sign-in", "off", "unknown", "connected"];

interface Standing {
  readonly row: McpRow;
  readonly state: ServerState;
  readonly answer?: ServerToolsAnswer;
  readonly listing: boolean;
  readonly error?: string;
}

const standings = (entry: ServerEntry, ctx: RowsContext): Standing[] =>
  entry.rows.map(row => {
    const s = ctx.tools?.of(row);
    return { row, state: rowState(row, s?.answer), listing: s?.listing === true, ...(s?.answer === undefined ? {} : { answer: s.answer }), ...(s?.error === undefined ? {} : { error: s.error }) };
  });

const worstOf = (all: readonly Standing[]): Standing => [...all].sort((a, b) => WORST.indexOf(a.state) - WORST.indexOf(b.state))[0]!;

/** The standing whose connect answered, which speaks for the server's tools: the server is one whoever asked. */
const askedOf = (all: readonly Standing[]): Standing | undefined => all.find(s => s.answer !== undefined || s.error !== undefined || s.listing);

export function badgeOf(s: Standing, tools: readonly unknown[] | undefined): StatusBadge {
  switch (s.state) {
    case "connected":
      return { state: "connected", words: tools !== undefined ? W.toolsCount(tools.length) : (s.answer?.auth ?? s.row.auth) === "signed-in" ? W.signedIn : "open" };
    case "needs-sign-in":
      return { state: "needs-sign-in", words: "needs sign-in", hover: W.signInToSee };
    case "failed": {
      const why = s.error ?? s.answer?.refused;
      return { state: "failed", words: "failed", ...(why === undefined ? {} : { hover: why }) };
    }
    case "off":
      return { state: "off", words: "off" };
    case "unknown":
      return { state: "unknown", words: W.notChecked, ...(s.answer?.holder === undefined ? {} : { hover: W.holdsSignIn(agentName(s.answer.holder)) }) };
  }
}

/** The acts, next step first, and the sign-in flow standing for any of the entry's agents. */
function actsOf(entry: ServerEntry, ctx: RowsContext, openUnder: () => void) {
  const all = standings(entry, ctx);
  const worst = worstOf(all);
  const asked = askedOf(all);
  if (ctx.where === "provider") return { all, worst, asked, acts: [] as RowAct[], signIns: new Map<string, RowAct>(), flow: undefined as FlowView | undefined };
  if (onImage(ctx)) return { all, worst, asked, acts: [editImageAct(ctx)], signIns: new Map<string, RowAct>(), flow: undefined };
  const tools = ctx.tools;
  const primary = asked?.row ?? worst.row;
  const listing = asked?.listing === true;
  const listed = asked?.answer?.tools;
  const list: RowAct = {
    id: "list-tools",
    label: listing ? W.listing : W.listTools,
    icon: WrenchIcon,
    hover: asked?.answer?.holder !== undefined ? W.holdsSignIn(agentName(asked.answer.holder)) : W.startsOnce,
    ...(listing ? { busy: true } : tools === undefined ? {} : { run: () => tools.list(primary) }),
  };
  const reconnect: RowAct = { id: "reconnect", label: listing ? W.listing : W.reconnect, icon: RefreshCwIcon, ...(listing ? { busy: true } : tools === undefined ? {} : { run: () => tools.list(worst.state === "failed" ? worst.row : primary, true) }) };
  const view: RowAct = { id: "view-tools", label: W.viewTools, icon: WrenchIcon, run: openUnder };
  const turnOff = notYet("turn-off", W.turnOff, PowerOffIcon);
  const turnOn = notYet("turn-on", W.turnOn, PowerIcon);
  const remove = notYet("remove", W.remove, Trash2Icon, { destructive: true });
  // Each agent that needs its own sign-in, and the flow any one of them drew.
  const signIns = new Map<string, RowAct>();
  let flow: FlowView | undefined;
  for (const s of all) {
    const made = signInAct(rowId(s.row), serverSignInStart(s.row, ctx), ctx);
    if (made.flow !== undefined && flow === undefined) flow = made.flow;
    if (s.state === "needs-sign-in" || made.act.id === "cancel" || (s.state === "unknown" && !entry.stdio)) signIns.set(s.row.agent, made.act);
  }
  const signIn = signIns.get(worst.row.agent) ?? [...signIns.values()][0];
  const acts: RowAct[] =
    worst.state === "needs-sign-in"
      ? [...(signIn === undefined ? [] : [signIn]), turnOff, remove]
      : worst.state === "failed"
        ? [reconnect, turnOff, remove]
        : worst.state === "off"
          ? [turnOn, remove]
          : listed !== undefined
            ? [view, reconnect, turnOff, remove]
            : [list, ...(signIn === undefined ? [] : [signIn]), turnOff, remove];
  return { all, worst, asked, acts: holdAll(acts, ctx), signIns, flow: heldReason(ctx) === undefined ? flow : undefined };
}

const NO_NAV = (): void => {};

function scopeGroups(items: readonly ServerEntry[], ctx: RowsContext): GroupView<ServerEntry>[] {
  const global = items.filter(e => e.scope === "global");
  const project = items.filter(e => e.scope === "project");
  return [
    ...(global.length === 0 ? [] : [{ id: "global", label: "Global", items: global }]),
    ...(project.length === 0 ? [] : [{ id: "project", label: ctx.project?.name ?? "Project", ...(ctx.project?.path === undefined ? {} : { path: ctx.project.path }), items: project }]),
  ];
}

const STATE_GROUPS: readonly { state: ServerState; label: string }[] = [
  { state: "needs-sign-in", label: "Needs sign-in" },
  { state: "failed", label: "Failed" },
  { state: "off", label: "Off" },
  { state: "connected", label: "Connected" },
  { state: "unknown", label: "Not checked" },
];

export const SERVERS_KIND: KindModule<ServerEntry> = {
  id: "servers",
  icon: PlugIcon,
  word: "MCP servers",
  noun: n => `${n} ${n === 1 ? "server" : "servers"}`,
  search: "Search MCP servers",
  add: "Add an MCP server",
  rowHeight: "h-[84px]",
  groupings: ["scope", "state", "agent", "none"],
  defaultGroup: () => "scope",
  items: (report: AgentsReport) => foldServers(report.servers).sort(byName),
  count: items => items.length,
  key: entry => entry.key,
  matches: (entry, q) => matchesAny(q, entry.name, entry.reach, ...entry.rows.flatMap(r => [agentName(r.agent), r.file])),
  groups: (items, by: GroupBy, ctx) => {
    if (by === "none") return [{ id: "all", items }];
    if (by === "agent") {
      const agents = [...new Set(items.flatMap(e => e.rows.map(r => r.agent)))];
      return agents.map(agent => ({ id: `agent-${agent}`, label: agentName(agent), items: items.filter(e => e.rows.some(r => r.agent === agent)) }));
    }
    if (by === "state") {
      return STATE_GROUPS.flatMap(g => {
        const hit = items.filter(e => worstOf(standings(e, ctx)).state === g.state);
        return hit.length === 0 ? [] : [{ id: `state-${g.state}`, label: g.label, items: hit }];
      });
    }
    return scopeGroups(items, ctx);
  },
  row: (entry, ctx) => {
    const { worst, asked, acts, flow } = actsOf(entry, ctx, NO_NAV);
    const badge = badgeOf(worst, asked?.answer?.tools);
    const step = worst.state === "needs-sign-in" ? acts.find(a => a.id === "sign-in" || a.id === "cancel") : worst.state === "failed" ? acts.find(a => a.id === "reconnect") : worst.state === "off" ? acts.find(a => a.id === "turn-on") : undefined;
    const quick = onImage(ctx) || waitingFlow(flow) ? undefined : step;
    return {
      key: entry.key,
      title: entry.name,
      lead: { kind: "box", icon: ServerIcon },
      marks: entry.rows.map(r => r.agent),
      subtext: entry.reach,
      badge: waitingFlow(flow) ? { ...badge, words: W.waitingOnYou } : badge,
      ...(quick === undefined ? {} : { quick }),
    };
  },
  detail: (entry, ctx, nav) => {
    const { all, worst, asked, acts, signIns, flow } = actsOf(entry, ctx, nav.openUnder);
    const listed = asked?.answer?.tools;
    const badge = badgeOf(worst, listed);
    const first = entry.rows[0]!;
    const names = [...new Set(entry.rows.flatMap(r => r.envNames))].join(", ");
    const disagree = new Set(all.map(s => s.state)).size > 1;
    const holder = asked?.answer?.holder;
    const refused = asked?.error ?? asked?.answer?.refused;
    const toolsFact: Fact =
      listed !== undefined
        ? { id: "tools", label: W.tools, value: W.toolsCount(listed.length) }
        : holder !== undefined
          ? { id: "tools", label: W.tools, value: W.heldBy(agentName(holder)), muted: true, hover: W.heldByHover(agentName(holder)) }
          : { id: "tools", label: W.tools, value: worst.state === "needs-sign-in" ? W.signInToSee : W.notListed, muted: true };
    const recipe = entry.rows.find(r => r.inRecipe !== undefined)?.inRecipe;
    const facts: Fact[] = [
      { id: "status", label: W.status, badge, ...(badge.state === "failed" && badge.hover !== undefined ? { fact: badge.hover } : {}) },
      { id: "reach", label: entry.stdio ? W.command : W.url, value: entry.reach, copy: true },
      ...(names === "" ? [] : [{ id: "names", label: entry.stdio ? W.environment : W.headers, value: names, muted: true }]),
      ...all.map((s, at) => {
        const act = disagree && entry.rows.length > 1 ? signIns.get(s.row.agent) : undefined;
        return {
          id: `config-${s.row.agent}`,
          label: at === 0 ? W.configLocation : "",
          value: s.row.file,
          agent: s.row.agent,
          copy: true,
          ...(disagree ? { fact: badgeOf(s, s.answer?.tools).words } : {}),
          ...(act === undefined ? {} : { act: heldReason(ctx) === undefined ? act : { ...act, hover: heldReason(ctx)! } }),
        } satisfies Fact;
      }),
      toolsFact,
      ...(recipe === undefined ? [] : [{ id: "recipe", label: W.recipe, value: recipe ? W.inRecipe : W.notInRecipe, muted: !recipe }]),
    ];
    const tools = asked?.row ?? first;
    const refresh = ctx.tools === undefined || heldReason(ctx) !== undefined || onImage(ctx) ? undefined : () => ctx.tools!.list(tools, true);
    return {
      title: entry.name,
      lead: { kind: "box", icon: ServerIcon },
      marks: entry.rows.map(r => r.agent),
      facts,
      acts,
      ...(flow === undefined ? {} : { flow }),
      ...(refused === undefined ? {} : { refused }),
      under: {
        title: W.toolsOf(entry.name),
        reading: asked?.listing === true,
        ...(listed === undefined ? {} : { rows: listed.map(t => ({ key: t.name, title: t.name, ...(t.description === undefined ? {} : { subtext: t.description, body: t.description }) })) }),
        ...(asked?.answer === undefined ? {} : { readAt: asked.answer.readAt }),
        ...(refused === undefined ? {} : { refused }),
        ...(refresh === undefined ? {} : { refresh }),
      },
    };
  },
  empty: on => `No MCP servers on ${on} yet.`,
  none: "no MCP servers",
};

export const SERVERS = kind(SERVERS_KIND);
