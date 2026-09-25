// SPDX-License-Identifier: AGPL-3.0-only
// The Agents tab: every agent on the computer's login PATH, then the ones the
// catalog could put there. An installed row says its version and, where no
// step is needed, its sign-in word; the detail says the rest and offers the
// next step first.
import { BotIcon, CircleArrowUpIcon, DownloadIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { compareVersions, MCP_SERVER_NAME, type AgentRow, type AgentsReport } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, agentSignInStart, editImageAct, heldReason, holdAll, notYet, onImage, signInAct, waitingFlow, type RowAct, type RowsContext } from "../agentsRows.js";
import { kind, matchesAny, type Fact, type KindModule } from "./kind.js";

export interface AgentItem {
  readonly row: AgentRow;
  /** The file that names the wsp tools for it, where one does. */
  readonly toolsFile?: string;
}

const signInWord = (row: AgentRow): string | undefined =>
  row.signIn === "signed-in" ? W.signedIn : row.signIn === "vault-key" ? W.yourKey : row.signIn === "unknown" ? W.notChecked : undefined;

/** The newer version its vendor publishes, where one is newer than what stands there. */
const newerThan = (row: AgentRow): string | undefined => (row.version !== undefined && row.latest !== undefined && compareVersions(row.latest, row.version) > 0 ? row.latest : undefined);

const ownHold = (row: AgentRow): string | undefined => (row.road === "own" ? W.ownHold : row.road === "shim" ? W.shimHold : undefined);

const rowId = (row: AgentRow): string => `agent-${row.id}`;

/** Every act the agent offers where the list stands, next step first. */
function actsOf(item: AgentItem, ctx: RowsContext) {
  const { row } = item;
  if (onImage(ctx)) return { acts: [editImageAct(ctx)] as RowAct[], flow: undefined };
  if (!row.installed) return { acts: holdAll([notYet("install", W.install, DownloadIcon)], ctx), flow: undefined };
  const latest = newerThan(row);
  const hold = ownHold(row);
  const signIn = signInAct(rowId(row), agentSignInStart(row, ctx), ctx);
  const adding = ctx.acts?.adding(row.id) === true;
  const addTools: RowAct =
    ctx.where !== "here"
      ? { id: "add-tools", label: W.addTools, icon: WrenchIcon, hover: W.toolsHereOnly }
      : { id: "add-tools", label: W.addTools, icon: WrenchIcon, ...(adding ? { busy: true } : ctx.acts === undefined ? {} : { run: () => ctx.acts!.addTools(row.id) }) };
  const update = notYet("update", W.update, CircleArrowUpIcon, hold === undefined ? {} : { hover: hold });
  const uninstall = notYet("uninstall", W.uninstall, Trash2Icon, { destructive: true, ...(hold === undefined ? {} : { hover: hold }) });
  const hasSignIn = row.signInRoad !== "none";
  const running = signIn.act.id === "cancel";
  const signedOut = row.signIn === "none";
  const acts: RowAct[] =
    signedOut || running
      ? [...(hasSignIn ? [signIn.act] : []), ...(row.wspTools ? [] : [addTools]), ...(latest === undefined ? [] : [update]), uninstall]
      : [...(latest === undefined ? [] : [update]), ...(row.wspTools ? [] : [addTools]), ...(hasSignIn ? [signIn.act] : []), uninstall];
  return { acts: holdAll(acts, ctx), flow: heldReason(ctx) === undefined ? signIn.flow : undefined };
}

export const AGENTS_KIND: KindModule<AgentItem> = {
  id: "agents",
  icon: BotIcon,
  word: "Agents",
  noun: n => `${n} ${n === 1 ? "agent" : "agents"}`,
  add: "Install an agent",
  rowHeight: "h-14",
  groupings: [],
  defaultGroup: () => "none",
  items: (report: AgentsReport) =>
    report.agents.map(row => {
      const toolsFile = report.servers.find(s => s.agent === row.id && s.name === MCP_SERVER_NAME)?.file;
      return { row, ...(toolsFile === undefined ? {} : { toolsFile }) };
    }),
  count: items => items.filter(i => i.row.installed).length,
  key: item => rowId(item.row),
  matches: (item, q) => matchesAny(q, item.row.name, item.row.version),
  groups: items => {
    const installed = items.filter(i => i.row.installed);
    const available = items.filter(i => !i.row.installed);
    return [...(installed.length === 0 ? [] : [{ id: "installed", items: installed }]), ...(available.length === 0 ? [] : [{ id: "available", label: "Available to install", items: available }])];
  },
  row: (item, ctx) => {
    const { row } = item;
    if (!row.installed) {
      const install = onImage(ctx) ? undefined : actsOf(item, ctx).acts[0];
      return { key: rowId(row), title: row.name, lead: { kind: "agent", agent: row.id, faded: true }, available: true, ...(install === undefined ? {} : { quick: install }) };
    }
    const { acts, flow } = actsOf(item, ctx);
    const latest = newerThan(row);
    // The row's one step: Sign in where no sign-in stands, else Update where a newer version is out.
    const quick = onImage(ctx) || waitingFlow(flow) ? undefined : row.signIn === "none" ? acts.find(a => a.id === "sign-in" || a.id === "cancel") : latest !== undefined ? acts.find(a => a.id === "update") : undefined;
    const word = waitingFlow(flow) ? W.waitingOnYou : signInWord(row);
    return {
      key: rowId(row),
      title: row.name,
      lead: { kind: "agent", agent: row.id },
      ...(row.version === undefined ? {} : { subtext: row.version }),
      ...(quick === undefined ? (word === undefined ? {} : { word }) : { quick }),
    };
  },
  detail: (item, ctx) => {
    const { row } = item;
    const { acts, flow } = actsOf(item, ctx);
    const latest = newerThan(row);
    const status = row.installed ? (row.signIn === "none" ? W.notSignedIn : signInWord(row)) : W.notInstalled;
    const versionFact = [latest === undefined ? undefined : W.latest(latest), row.pinned !== undefined && row.pinned !== row.version ? W.pins(row.pinned) : undefined].filter(Boolean).join(", ");
    const facts: Fact[] = [
      { id: "status", label: W.status, value: status ?? W.notChecked, ...(row.installed && row.signInRoad !== "none" ? { fact: W.roads[row.signInRoad] } : {}) },
      ...(row.version === undefined ? [] : [{ id: "version", label: W.version, value: row.version, ...(versionFact === "" ? {} : { fact: versionFact }) }]),
      ...(row.path === undefined ? [] : [{ id: "installed-at", label: W.installedAt, value: row.path, copy: true, ...(row.road === "own" ? { fact: W.own } : row.road === "shim" ? { fact: W.shim } : {}) }]),
      ...(row.installed ? [{ id: "wsp-tools", label: W.wspTools, ...(item.toolsFile === undefined ? { value: W.notAdded, muted: true } : { value: item.toolsFile, copy: true }) }] : []),
    ];
    return { title: row.name, lead: { kind: "agent", agent: row.id, ...(row.installed ? {} : { faded: true }) }, facts, acts, ...(flow === undefined ? {} : { flow }) };
  },
  empty: on => `No agents found on ${on}.`,
  none: "no agents",
};

export const AGENTS = kind(AGENTS_KIND);
