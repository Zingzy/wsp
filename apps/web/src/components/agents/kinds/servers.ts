// SPDX-License-Identifier: AGPL-3.0-only
// The MCP servers tab: one entry per server across agents, folded where two
// agents in one scope name the same server with the same command or address.
// The row says where it is reached and its state as a dot and a word; the
// detail is the /mcp view: status, command, names, each agent's file, the
// tools, and the next step first. Tools are asked only on a click. Turn off
// and on and Remove act on every agent the entry is set up for, and Add an MCP
// server is a form in place of the list.
import { PlugIcon, PowerIcon, PowerOffIcon, RefreshCwIcon, ServerIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { agentName, mcpSwitch } from "@wsp/catalog";
import type { AgentsProject, AgentsReport, McpRow, McpTool, McpToolParam, ServerToolsAnswer } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, editImageAct, heldReason, holdAll, notYet, onImage, serverSignInStart, signInAct, waitingFlow, type FlowView, type RowAct, type RowsContext } from "../agentsRows.js";
import { AddServerForm } from "../AddServerForm.js";
import { byName, kind, matchesAny, projectGroups, rowKey, type Fact, type GroupBy, type GroupView, type KindModule, type ServerState, type ServerStatus, type UnderRow } from "./kind.js";

/** Where a server is set up: the person's own files, or the project's. */
type Scope = "global" | "project";

export interface ServerEntry {
  readonly key: string;
  readonly name: string;
  readonly scope: Scope;
  /** The project a project server is set up in. */
  readonly project?: AgentsProject;
  /** The command with its values hidden, or the address. */
  readonly reach: string;
  readonly stdio: boolean;
  /** One per agent it is set up for, in the report's order. */
  readonly rows: readonly McpRow[];
  /** When the report these rows came from was read. */
  readonly readAt?: string;
}

const scopeOf = (row: McpRow): Scope => (row.scope === "project" ? "project" : "global");
const reachOf = (row: McpRow): string => (row.transport.kind === "stdio" ? row.transport.line : row.transport.host);
const rowId = (row: McpRow): string => rowKey(["server", row.agent, row.scope], row.project, row.name);

/** One entry per server: the same name reached the same way in the same scope, and the same project, is one server
 * set up for each agent. */
export function foldServers(rows: readonly McpRow[], readAt?: string): ServerEntry[] {
  const out = new Map<string, { name: string; scope: Scope; project?: AgentsProject; reach: string; stdio: boolean; rows: McpRow[] }>();
  for (const row of rows) {
    const key = [scopeOf(row), ...(row.project === undefined ? [] : [row.project.id]), row.name, row.transport.kind, reachOf(row)].join("\0");
    const was = out.get(key);
    if (was === undefined) out.set(key, { name: row.name, scope: scopeOf(row), ...(row.project !== undefined ? { project: row.project } : {}), reach: reachOf(row), stdio: row.transport.kind === "stdio", rows: [row] });
    else was.rows.push(row);
  }
  return [...out].map(([key, e]) => ({ key: `server-${key.replaceAll("\0", "-")}`, ...e, ...(readAt === undefined ? {} : { readAt }) }));
}

/** One agent's state for a server: off, then the newer of the connect's answer and the report, where a report that
 * checked nothing never outweighs an answer. */
export function rowState(row: McpRow, answer: ServerToolsAnswer | undefined, reportAt?: string): ServerState {
  if (!row.enabled) return "off";
  const unchecked = row.auth === "open" || row.auth === "env-key" || row.auth === "unknown";
  return answer !== undefined && (unchecked || reportAt === undefined || answer.readAt >= reportAt) ? answer.auth : row.auth;
}

/** Worst first: what a folded entry's one status says. */
const WORST: readonly ServerState[] = ["failed", "needs-sign-in", "off", "unknown", "env-key", "open", "signed-in", "connected"];

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
    return { row, state: rowState(row, s?.answer, entry.readAt), listing: s?.listing === true, ...(s?.answer === undefined ? {} : { answer: s.answer }), ...(s?.error === undefined ? {} : { error: s.error }) };
  });

const worstOf = (all: readonly Standing[]): Standing => [...all].sort((a, b) => WORST.indexOf(a.state) - WORST.indexOf(b.state))[0]!;

/** The standing whose connect answered, which speaks for the server's tools: the server is one whoever asked. */
const askedOf = (all: readonly Standing[]): Standing | undefined => all.find(s => s.answer !== undefined || s.error !== undefined || s.listing);

export function statusOf(s: Standing, tools: readonly unknown[] | undefined): ServerStatus {
  switch (s.state) {
    case "connected":
    case "signed-in":
      return { state: s.state, words: tools !== undefined ? W.toolsCount(tools.length) : s.state === "connected" ? W.connected : W.signedIn };
    case "open":
      return { state: "open", words: W.noSignInNeeded };
    case "env-key":
      return { state: "env-key", words: W.keyFromEnvironment };
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
  const servers = ctx.servers;
  const busy = servers?.busyOf(entry.key) === true;
  // A server turns off only where every agent it is set up for keeps a switch per server.
  const unswitched = entry.rows.find(r => !mcpSwitch(r.agent));
  const turn = (on: boolean): RowAct => {
    const [id, label, icon] = on ? (["turn-on", W.turnOn, PowerIcon] as const) : (["turn-off", W.turnOff, PowerOffIcon] as const);
    if (servers === undefined) return notYet(id, label, icon);
    if (unswitched !== undefined) return notYet(id, label, icon, { hover: W.noSwitch(agentName(unswitched.agent)) });
    return { id, label, icon, ...(busy ? { busy: true } : { run: () => servers.toggle(entry.key, entry.rows.filter(r => r.enabled !== on), on) }) };
  };
  const turnOff = turn(false);
  const turnOn = turn(true);
  const files = [...new Set(entry.rows.map(r => r.file))];
  const remove: RowAct =
    servers === undefined
      ? notYet("remove", W.remove, Trash2Icon, { destructive: true })
      : { id: "remove", label: W.remove, icon: Trash2Icon, destructive: true, confirm: { title: W.removeTitle(entry.name), body: W.leavesFiles(files, ctx.on ?? ctx.computer ?? "") }, ...(busy ? { busy: true } : { run: () => servers.remove(entry.key, entry.rows) }) };
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

/** A tool as a row of its server's tools, and its own level: the description whole, then each parameter by name with
 * its type and whether a call needs it. */
function toolRow(tool: McpTool): UnderRow {
  const facts = (p: McpToolParam): string | undefined => [p.type, p.required ? W.required : undefined].filter(w => w !== undefined).join(" · ") || undefined;
  return {
    key: tool.name,
    title: tool.name,
    ...(tool.description === undefined ? {} : { subtext: tool.description, body: tool.description }),
    ...(tool.params === undefined
      ? {}
      : {
          list: {
            label: W.parameters,
            items: tool.params.map(p => {
              const fact = facts(p);
              return { name: p.name, ...(fact === undefined ? {} : { fact }), ...(p.description === undefined ? {} : { about: p.description }) };
            }),
          },
        }),
  };
}

/** Global first, then one group per project, each by its name with its folder. */
function scopeGroups(items: readonly ServerEntry[], ctx: RowsContext): GroupView<ServerEntry>[] {
  const global = items.filter(e => e.scope === "global");
  return [...(global.length === 0 ? [] : [{ id: "global", label: "Global", items: global }]), ...projectGroups(items.filter(e => e.scope === "project"))];
}

export const SERVERS_KIND: KindModule<ServerEntry> = {
  id: "servers",
  icon: PlugIcon,
  word: "MCP servers",
  noun: n => `${n} ${n === 1 ? "server" : "servers"}`,
  search: "Search MCP servers",
  add: "Add an MCP server",
  rowHeight: "h-[84px]",
  groupings: ["scope", "agent", "none"],
  defaultGroup: () => "scope",
  items: (report: AgentsReport) => foldServers(report.servers, report.readAt).sort(byName),
  count: items => items.length,
  key: entry => entry.key,
  matches: (entry, q) => matchesAny(q, entry.name, entry.reach, entry.project?.name, ...entry.rows.flatMap(r => [agentName(r.agent), r.file])),
  groups: (items, by: GroupBy, ctx) => {
    if (by === "none") return [{ id: "all", items }];
    if (by === "agent") {
      const agents = [...new Set(items.flatMap(e => e.rows.map(r => r.agent)))];
      return agents.map(agent => ({ id: `agent-${agent}`, label: agentName(agent), items: items.filter(e => e.rows.some(r => r.agent === agent)) }));
    }
    return scopeGroups(items, ctx);
  },
  row: (entry, ctx) => {
    const { worst, asked, acts, flow } = actsOf(entry, ctx, NO_NAV);
    const status = statusOf(worst, asked?.answer?.tools);
    const step = worst.state === "needs-sign-in" ? acts.find(a => a.id === "sign-in" || a.id === "cancel") : worst.state === "failed" ? acts.find(a => a.id === "reconnect") : worst.state === "off" ? acts.find(a => a.id === "turn-on") : undefined;
    const quick = onImage(ctx) || waitingFlow(flow) ? undefined : step;
    return {
      key: entry.key,
      title: entry.name,
      lead: { kind: "box", icon: ServerIcon },
      marks: entry.rows.map(r => r.agent),
      subtext: entry.reach,
      status: waitingFlow(flow) ? { ...status, words: W.waitingOnYou } : status,
      ...(quick === undefined ? {} : { quick }),
    };
  },
  detail: (entry, ctx, nav) => {
    const { all, worst, asked, acts, signIns, flow } = actsOf(entry, ctx, nav.openUnder);
    const listed = asked?.answer?.tools;
    const status = statusOf(worst, listed);
    const first = entry.rows[0]!;
    const names = [...new Set(entry.rows.flatMap(r => r.envNames))].join(", ");
    const disagree = new Set(all.map(s => s.state)).size > 1;
    const holder = asked?.answer?.holder;
    const refused = asked?.error ?? asked?.answer?.refused;
    const wrote = ctx.servers?.refusedOf(entry.key);
    const toolsFact: Fact =
      listed !== undefined
        ? { id: "tools", label: W.tools, value: W.toolsCount(listed.length) }
        : holder !== undefined
          ? { id: "tools", label: W.tools, value: W.keepsSignIn(agentName(holder)), muted: true }
          : { id: "tools", label: W.tools, value: worst.state === "needs-sign-in" ? W.signInToSee : W.notListed, muted: true };
    const recipe = entry.rows.find(r => r.inRecipe !== undefined)?.inRecipe;
    const facts: Fact[] = [
      { id: "status", label: W.status, status, ...(status.state === "failed" && status.hover !== undefined ? { fact: status.hover } : {}) },
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
          ...(disagree ? { fact: statusOf(s, s.answer?.tools).words } : {}),
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
      ...(wrote !== undefined ? { refused: wrote } : refused === undefined ? {} : { refused }),
      under: {
        title: W.toolsOf(entry.name),
        reading: asked?.listing === true,
        ...(listed === undefined ? {} : { rows: listed.map(toolRow) }),
        ...(asked?.answer === undefined ? {} : { readAt: asked.answer.readAt }),
        ...(refused === undefined ? {} : { refused }),
        ...(refresh === undefined ? {} : { refresh }),
      },
    };
  },
  empty: on => `No MCP servers on ${on} yet.`,
  none: "no MCP servers",
  form: ctx => (ctx.servers === undefined || onImage(ctx) ? undefined : { title: W.addServer, Form: AddServerForm }),
};

export const SERVERS = kind(SERVERS_KIND);
