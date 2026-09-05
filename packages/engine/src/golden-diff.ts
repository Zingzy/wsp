// SPDX-License-Identifier: AGPL-3.0-only
// The recipe diff: what a golden was built from (the digest its seal wrote)
// against the recipe now, as rows to apply on top and rows to take off. Pure;
// golden.ts runs the result on a fork or on the kept builder.
import { MCP_ID_PREFIX, type RecipeDigest } from "@wsp/protocol";
import { AGENT_INSTALLERS, agentUninstall, extensionsFile, remoteEditorFor, terminalEditor, toolUninstall, type AgentInstaller, type RecipeEntry } from "./golden-import.js";

type Tick = RecipeDigest["ticks"][number];
type DigestFile = RecipeDigest["files"][number];

export type Change = "added" | "changed" | "removed";

export interface FileChange {
  id: string;
  dest: string;
  /** missing: still ticked but no longer on this computer; kept on the golden, with a note. */
  change: Change | "missing";
}

/** A row installed as a step of the tools stage: a tools row, an editors row that puts a binary on the machine, or a
 * remote editor's extension list. */
export interface ToolChange {
  id: string;
  label: string;
  change: Change;
  /** Pins, when the row carries one; a changed pin is a reinstall. */
  from?: string;
  to?: string;
  /** The rows the step is written from when it is more than the row itself: an extension list from every ticked extension row. */
  rows?: string[];
}

export interface AgentChange {
  id: string;
  label: string;
  change: "added" | "removed";
}

export interface LoginChange {
  id: string;
  label: string;
  /** The login choice before and after; absent when the row was not ticked. */
  from?: string;
  to?: string;
}

export interface RecipeDiff {
  files: FileChange[];
  tools: ToolChange[];
  agents: AgentChange[];
  logins: LoginChange[];
}

/** One thing taken off the machine, or noted when nothing can take it off. */
export interface Removal {
  what: "file" | "tool" | "editor" | "agent";
  id: string;
  label: string;
  /** Runs on the guest; absent when the manager has no uninstall, and `note` says so. */
  cmd?: string;
  note?: string;
  /** A removed agent's version check, so the next version's smoke stops asking for it. */
  smoke?: string;
}

/** A row's rung is the first segment of its id, its default label the last. */
const rungOf = (id: string): string => id.slice(0, id.indexOf("/"));
export const nameOf = (id: string): string => id.slice(id.lastIndexOf("/") + 1);
const byRung = (ticks: readonly Tick[], rung: string): Map<string, Tick> => new Map(ticks.filter(t => rungOf(t.id) === rung).map(t => [t.id, t]));
const fileKey = (f: DigestFile): string => `${f.id}\0${f.dest}`;
/** A remote editor's extension row, captured to the list it belongs in. */
const EXTENSION_ROW = /^(editors\/[a-z]+-ext)\//;
const extensionLists = (ticks: readonly Tick[]): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const t of ticks) {
    const list = EXTENSION_ROW.exec(t.id)?.[1];
    if (list !== undefined) (out.get(list) ?? out.set(list, []).get(list)!).push(t.id);
  }
  return out;
};

/** `labelOf` gives the person's words for a row; the id's last segment when the caller has none. */
export function diffRecipes(from: RecipeDigest, to: RecipeDigest, labelOf: (id: string) => string = nameOf): RecipeDiff {
  const diff: RecipeDiff = { files: [], tools: [], agents: [], logins: [] };

  const before = new Map(from.files.map(f => [fileKey(f), f]));
  const after = new Map(to.files.map(f => [fileKey(f), f]));
  for (const [key, f] of after) {
    const was = before.get(key);
    if (was === undefined) diff.files.push({ id: f.id, dest: f.dest, change: "added" });
    // A volatile entry is recorded, never hashed: its tool rewrites it, or the machine renders it, so its bytes moving is not a change to apply.
    else if (was.digest !== f.digest && was.volatile !== true && f.volatile !== true) diff.files.push({ id: f.id, dest: f.dest, change: "changed" });
  }
  // A delete needs an explicit change: the row unticked, a login no longer chosen as copy, or its dest moved. A
  // ticked file that is no longer on this computer stays on the golden.
  const tickedAfter = new Set(to.ticks.filter(t => rungOf(t.id) !== "logins" || t.choice === "copy").map(t => t.id));
  for (const [key, f] of before) {
    if (after.has(key)) continue;
    const moved = to.files.some(t => t.id === f.id && t.path === f.path && t.dest !== f.dest);
    diff.files.push({ id: f.id, dest: f.dest, change: !tickedAfter.has(f.id) || moved ? "removed" : "missing" });
  }

  const toolsBefore = byRung(from.ticks, "tools");
  const toolsAfter = byRung(to.ticks, "tools");
  for (const [id, t] of toolsAfter) {
    const was = toolsBefore.get(id);
    const pins = { ...(was?.version !== undefined ? { from: was.version } : {}), ...(t.version !== undefined ? { to: t.version } : {}) };
    if (was === undefined) diff.tools.push({ id, label: labelOf(id), change: "added", ...pins });
    else if (was.version !== t.version) diff.tools.push({ id, label: labelOf(id), change: "changed", ...pins });
  }
  for (const [id, t] of toolsBefore) if (!toolsAfter.has(id)) diff.tools.push({ id, label: labelOf(id), change: "removed", ...(t.version !== undefined ? { from: t.version } : {}) });

  // An editor's config, when it has one, is in the files above; the binary is an install of its own, named as the stage names it.
  const editorsBefore = byRung(from.ticks, "editors");
  const editorsAfter = byRung(to.ticks, "editors");
  for (const id of editorsAfter.keys()) {
    const ed = terminalEditor(id);
    if (ed !== undefined && !editorsBefore.has(id)) diff.tools.push({ id, label: ed.name, change: "added" });
  }
  for (const id of editorsBefore.keys()) {
    const ed = terminalEditor(id);
    if (ed !== undefined && !editorsAfter.has(id)) diff.tools.push({ id, label: ed.name, change: "removed" });
  }
  // The list file is written whole from every ticked extension row, so any change to them is one change of the list.
  const listsBefore = extensionLists(from.ticks);
  const listsAfter = extensionLists(to.ticks);
  for (const id of new Set([...listsBefore.keys(), ...listsAfter.keys()])) {
    const was = [...(listsBefore.get(id) ?? [])].sort();
    const now = [...(listsAfter.get(id) ?? [])].sort();
    if (was.join("\0") === now.join("\0")) continue;
    const label = `${remoteEditorFor(id)?.name ?? id} extension list`;
    const change: Change = was.length === 0 ? "added" : now.length === 0 ? "removed" : "changed";
    diff.tools.push({ id, label, change, ...(now.length > 0 ? { rows: now } : {}) });
  }

  const agentsBefore = byRung(from.ticks, "agents");
  const agentsAfter = byRung(to.ticks, "agents");
  for (const id of agentsAfter.keys()) if (!agentsBefore.has(id)) diff.agents.push({ id, label: labelOf(id), change: "added" });
  for (const id of agentsBefore.keys()) if (!agentsAfter.has(id)) diff.agents.push({ id, label: labelOf(id), change: "removed" });

  const loginsBefore = byRung(from.ticks, "logins");
  const loginsAfter = byRung(to.ticks, "logins");
  for (const id of new Set([...loginsBefore.keys(), ...loginsAfter.keys()])) {
    const was = loginsBefore.get(id);
    const now = loginsAfter.get(id);
    if (was?.choice === now?.choice) continue;
    diff.logins.push({ id, label: labelOf(id), ...(was?.choice !== undefined ? { from: was.choice } : {}), ...(now?.choice !== undefined ? { to: now.choice } : {}) });
  }
  return diff;
}

export function isEmptyDiff(d: RecipeDiff): boolean {
  return d.files.length + d.tools.length + d.agents.length + d.logins.length === 0;
}

/** The rows the delta plans like a first build: the row of every added or
 * changed file, every added or changed tool, every added agent, and every
 * login now chosen as copy. A row re-ships all of its paths. */
export function rowsToApply(d: RecipeDiff): Set<string> {
  const ids = new Set<string>();
  for (const f of d.files) if (f.change === "added" || f.change === "changed") ids.add(f.id);
  for (const t of d.tools) if (t.change !== "removed") for (const id of t.rows ?? [t.id]) ids.add(id);
  for (const a of d.agents) if (a.change === "added") ids.add(a.id);
  for (const l of d.logins) if (l.to === "copy") ids.add(l.id);
  return ids;
}

const GUEST_HOME = "/root";

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A removed file is deleted at its guest path; a dest that could climb out of home is refused with a note. */
function fileRemoval(f: FileChange): Removal {
  const parts = f.dest.split("/");
  if (f.dest === "" || parts.some(p => p === "" || p === "." || p === "..")) {
    return { what: "file", id: f.id, label: `~/${f.dest}`, note: "path refused; left on the machine" };
  }
  return { what: "file", id: f.id, label: `~/${f.dest}`, cmd: `rm -rf -- ${squote(`${GUEST_HOME}/${f.dest}`)}` };
}

/** Everything the diff takes off the machine: removed files, removed tools
 * through their manager, removed agents through their installer's inverse.
 * `installers` adds the agents the table lacks (the host owns Claude Code's). */
export function removalsFor(d: RecipeDiff, from: RecipeDigest, installers: Record<string, AgentInstaller> = {}): Removal[] {
  const out: Removal[] = [];
  for (const f of d.files) if (f.change === "removed") out.push(fileRemoval(f));
  for (const t of d.tools) {
    if (t.change !== "removed") continue;
    const editor = terminalEditor(t.id);
    if (editor !== undefined) {
      out.push({ what: "editor", id: t.id, label: t.label, cmd: editor.uninstall });
      continue;
    }
    const remote = t.id.endsWith("-ext") ? remoteEditorFor(t.id) : undefined;
    if (remote !== undefined) {
      out.push({ what: "editor", id: t.id, label: t.label, cmd: `rm -f -- ${squote(`${GUEST_HOME}/${extensionsFile(remote.dir)}`)}` });
      continue;
    }
    const tick = from.ticks.find(x => x.id === t.id);
    const row: RecipeEntry | undefined = tick === undefined ? undefined : { rung: "tools", id: tick.id, label: t.label, paths: [], bytes: 0, default: "bring", bring: true, ...(tick.version !== undefined ? { version: tick.version } : {}) };
    const r = row === undefined ? { note: "row not in the recipe the golden was built from" } : toolUninstall(row);
    out.push({ what: "tool", id: t.id, label: t.label, ...r });
  }
  const table = { ...AGENT_INSTALLERS, ...installers };
  for (const a of d.agents) {
    if (a.change !== "removed") continue;
    if (a.id.startsWith(MCP_ID_PREFIX)) {
      out.push({ what: "agent", id: a.id, label: a.label, note: "an MCP server; the MCP stage takes it out of the agent's config" });
      continue;
    }
    const installer = table[nameOf(a.id)];
    const r = installer === undefined ? { note: "no installer known, so nothing to uninstall" } : agentUninstall(installer);
    out.push({ what: "agent", id: a.id, label: a.label, ...r, ...(installer !== undefined ? { smoke: installer.smoke } : {}) });
  }
  return out;
}

/** One line per change, for the person. */
export function describeDiff(d: RecipeDiff): string[] {
  const lines: string[] = [];
  const group = (change: Change, items: string[], noun: string): void => {
    if (items.length === 0) return;
    const verb = change === "added" ? "add" : change === "changed" ? "update" : "remove";
    lines.push(`${verb} ${items.length} ${noun}${items.length === 1 ? "" : "s"}: ${items.join(", ")}`);
  };
  for (const change of ["added", "changed", "removed"] as const) {
    group(change, d.files.filter(f => f.change === change).map(f => `~/${f.dest}`), "file");
    if (change === "changed") for (const f of d.files.filter(x => x.change === "missing")) lines.push(`kept on the golden, no longer on this computer: ~/${f.dest}`);
    group(change, d.tools.filter(t => t.change === change && rungOf(t.id) === "tools").map(t => (change === "changed" ? `${t.label} (${t.from ?? "unpinned"} to ${t.to ?? "unpinned"})` : t.label)), "tool");
    group(change, d.tools.filter(t => t.change === change && rungOf(t.id) === "editors").map(t => t.label), "editor");
    if (change !== "changed") {
      const agents = d.agents.filter(a => a.change === change);
      group(change, agents.filter(a => !a.id.startsWith(MCP_ID_PREFIX)).map(a => a.label), "agent");
      group(change, agents.filter(a => a.id.startsWith(MCP_ID_PREFIX)).map(a => a.label), "MCP server");
    }
  }
  for (const l of d.logins) {
    if (l.to === "copy") lines.push(`copy the ${l.label}`);
    else if (l.to === "machine") lines.push(`${l.label}: sign in on the machine is not done by an update, so it would not be in the golden; pick the rebuild for it`);
    else lines.push(`take the ${l.label} off the machine`);
  }
  return lines;
}

/** A change small enough that applying it on a fork beats a rebuild: no
 * agent to install, no sign-in to do on the machine, at most this many tool
 * installs, and this much to upload. `bytesOf` is a row's size on this computer. */
export const SMALL_TOOLS = 5;
export const SMALL_BYTES = 50 * 1024 * 1024;

export function isSmallDelta(d: RecipeDiff, bytesOf: (id: string) => number): boolean {
  if (d.agents.some(a => a.change === "added")) return false;
  if (d.logins.some(l => l.to === "machine")) return false;
  if (d.tools.filter(t => t.change !== "removed").length > SMALL_TOOLS) return false;
  const bytes = [...rowsToApply(d)].filter(id => rungOf(id) !== "tools").reduce((n, id) => n + bytesOf(id), 0);
  return bytes <= SMALL_BYTES;
}
