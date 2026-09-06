// SPDX-License-Identifier: AGPL-3.0-only
// The MCP stage on the builder. The definitions themselves arrive inside each
// agent's config file with that agent's row, secrets included, so nothing here
// carries a definition: the plan names which servers stay, which come out and
// why, and the prefixes that read differently on the machine. A script on the
// guest edits the files in place and touches no server it was not told about.
import type { McpFormat, McpGuestResult } from "@wsp/catalog";
import { MCP_ID_PREFIX, shellQuote } from "@wsp/protocol";
import { TOOLS_PATH, UV_INSTALL, type RecipeEntry } from "./golden-import.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { TOOL_TIMEOUT_S, type ToolResult, closing, freeNote, guardDeadlineMs, guarded, reasonOf } from "./golden-tools.js";
import type { ExecResult, Machine } from "./machine.js";
import type { StageListener } from "./golden.js";

const MCP_REMOTE_ID = `${MCP_ID_PREFIX}mcp-remote`;

export interface McpAgentSource {
  label: string;
  format: McpFormat;
  /** Absolute paths on the guest; the first that exists is the config. */
  files: string[];
}

export interface McpScope {
  files: string[];
  format: McpFormat;
  /** Claude Code's servers local to the laptop's home folder move under the machine's home. */
  project?: { from: string; to: string };
  keep: string[];
  drop: { name: string; reason: string }[];
}

export interface McpAgentPlan {
  id: string;
  label: string;
  scopes: McpScope[];
  /** Rows that never reach the machine: the agent itself is not ticked, so its config did not travel. */
  aside: { id: string; name: string; reason: string }[];
}

export interface McpPlan {
  agents: McpAgentPlan[];
  guestHome: string;
  /** Laptop prefixes and what they read as on the machine, tried in order on every string of a kept definition. */
  rewrites: [string, string][];
  /** Directories whose binaries the machine finds on PATH by name; a command right under one becomes its name. */
  binDirs: string[];
  /** The recipe's tool rows that install one binary each, with their tick: a server whose command is not on the machine names the row that would have brought it. */
  tools: McpToolRow[];
}

export interface McpToolRow {
  id: string;
  ticked: boolean;
  reason?: string;
}

export interface McpPlanOptions {
  home: string;
  guestHome?: string;
  agents: Record<string, McpAgentSource>;
  /** Absolute bin directories the machine's PATH covers by name, the collector's list; ~/.local/bin is added here. */
  binDirs?: readonly string[];
}

/** `fetched-on-first-use`: the definition is in place, but its package comes down when the agent first starts it (npx, uv). */
export interface McpResult {
  id: string;
  agent: string;
  name: string;
  outcome: "installed" | "fetched-on-first-use" | "skipped";
  note?: string;
}

const GUEST_HOME = "/root";
const LINUXBREW = "/home/linuxbrew/.linuxbrew/";
/** Rows whose last id segment is the binary they put on PATH; taps, casks and the toolchain install none. */
const BINARY_ROW = /^tools\/(brew|go|cargo|npm|pnpm|bun|pipx|uv|hand)\//;

/** A row's agent, scope and server name from its id: `agents/mcp/<agent>/<name>`, or `agents/mcp/<agent>/home/<name>`;
 * nothing for a row that is not a server, the mcp-remote row included. */
export function parseMcpId(id: string): { agent: string; home: boolean; name: string } | undefined {
  if (!id.startsWith(MCP_ID_PREFIX) || id === MCP_REMOTE_ID) return undefined;
  const rest = id.slice(MCP_ID_PREFIX.length).split("/");
  const agent = rest[0];
  if (agent === undefined || rest.length < 2) return undefined;
  const home = rest.length === 3 && rest[1] === "home";
  return { agent, home, name: home ? rest[2]! : rest.slice(1).join("/") };
}

/** The plan from every row of the recipe with its tick: ticked servers stay, unticked ones come out with the
 * row's own reason, and an agent that is not ticked has its servers set aside. Nothing when no row is a server. */
export function mcpPlanFor(rows: readonly RecipeEntry[], opts: McpPlanOptions): McpPlan | undefined {
  const guestHome = opts.guestHome ?? GUEST_HOME;
  const ticked = new Set(rows.filter(e => e.bring === true).map(e => e.id));
  const agents: McpAgentPlan[] = [];
  for (const [agent, source] of Object.entries(opts.agents)) {
    const own = rows.flatMap(e => {
      const p = parseMcpId(e.id);
      return p !== undefined && p.agent === agent ? [{ row: e, home: p.home, name: p.name }] : [];
    });
    if (own.length === 0) continue;
    if (!ticked.has(`agents/${agent}`)) {
      agents.push({ id: agent, label: source.label, scopes: [], aside: own.map(o => ({ id: o.row.id, name: o.name, reason: `${source.label} is not ticked, so its config did not travel` })) });
      continue;
    }
    const scopes: McpScope[] = [];
    for (const home of [false, true]) {
      const rows = own.filter(o => o.home === home);
      if (rows.length === 0) continue;
      scopes.push({
        files: source.files,
        format: source.format,
        ...(home ? { project: { from: opts.home, to: guestHome } } : {}),
        keep: rows.filter(o => ticked.has(o.row.id)).map(o => o.name),
        drop: rows.filter(o => !ticked.has(o.row.id)).map(o => ({ name: o.name, reason: o.row.reason ?? "unticked" })),
      });
    }
    agents.push({ id: agent, label: source.label, scopes, aside: [] });
  }
  if (agents.length === 0) return undefined;
  return {
    agents,
    guestHome,
    rewrites: [[`${opts.home}/`, `${guestHome}/`], ["/opt/homebrew/", LINUXBREW]],
    binDirs: [`${opts.home}/.local/bin/`, "~/.local/bin/", ...(opts.binDirs ?? ["/opt/homebrew/bin/", "/opt/homebrew/sbin/"])],
    tools: rows.filter(e => e.rung === "tools" && BINARY_ROW.test(e.id)).map(e => ({ id: e.id, ticked: e.bring === true, ...(e.reason !== undefined ? { reason: e.reason } : {}) })),
  };
}

// --- the guest script ------------------------------------------------------------

/** Runs under the guest's node with the plan as its one argument. Each config is edited in place by its format's own
 * editor, which travels inside the script from the catalog module: kept servers get their strings rewritten (the
 * command to a bare name when it sits in a bin directory), dropped ones come out, every other key and server stays.
 * With `write` off nothing is written, so the same pass reads each kept server's command as the machine would run
 * it. Prints one JSON object: a result per scope in plan order, naming each server's outcome and command and never
 * its values. */
const guestScript = (editors: readonly string[]): string => String.raw`
const fs = require("fs");
const plan = JSON.parse(process.argv[1]);
function rewriteString(s, command) {
  if (command) for (const d of plan.binDirs) if (s.startsWith(d) && !s.slice(d.length).includes("/")) return s.slice(d.length);
  const flag = /^--?[\w-]+=/.exec(s);
  const head = flag ? flag[0] : "";
  const body = s.slice(head.length);
  for (const [from, to] of plan.rewrites) if (body.startsWith(from)) return head + to + body.slice(from.length);
  return s;
}
function firstFile(files) {
  for (const f of files) { try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}
const editors = [
${editors.join(",\n")}
];
const lib = { fs, write: plan.write, rewriteString };
const scopes = [];
for (const agent of plan.agents) {
  for (const scope of agent.scopes) {
    const file = firstFile(scope.files);
    if (file === null) { scopes.push({ file: null, results: [] }); continue; }
    try { scopes.push({ file, results: editors[scope.editor](lib, { keep: scope.keep, drop: scope.drop.map(d => d.name), project: scope.project }, file) }); }
    catch (e) { scopes.push({ file, error: String(e && e.message || e), results: [] }); }
  }
}
process.stdout.write(JSON.stringify({ scopes }));
`;

interface ScopeOutcome {
  file: string | null;
  error?: string;
  results: McpGuestResult[];
}

/** The last line that parses as the script's report. */
function parseReport(stdout: string): { scopes: ScopeOutcome[] } | undefined {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined) return undefined;
  try {
    const v = JSON.parse(line) as { scopes?: unknown };
    return Array.isArray(v.scopes) ? (v as { scopes: ScopeOutcome[] }) : undefined;
  } catch {
    return undefined;
  }
}

interface Pending extends McpResult {
  /** The command as the machine will run it; absent for a remote server or a skipped row. */
  command?: string;
  /** Full sentences for the saved result. */
  notes: string[];
  /** The summary's words, one per note. */
  shorts: string[];
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
/** Runners that pull the server's package down when the agent first starts it: the definition is in place, the package is not. */
const FETCHERS: Record<string, string> = { npx: "npx", uvx: "uv", uv: "uv" };

/** Installed servers by name; then, per distinct wording, the servers whose package is fetched on first use or
 * whose runner was installed or is missing; then each skipped server with its reason. */
function summarize(rows: readonly Pending[]): string {
  const parts: string[] = [];
  const installed = rows.filter(r => r.outcome === "installed" && r.shorts.length === 0);
  if (installed.length > 0) parts.push(`${installed.map(r => r.name).join(", ")} installed`);
  const byNote = new Map<string, string[]>();
  for (const r of rows) {
    if (r.outcome === "skipped" || r.shorts.length === 0) continue;
    const key = r.shorts.join(", ");
    (byNote.get(key) ?? byNote.set(key, []).get(key)!).push(r.name);
  }
  for (const [short, names] of byNote) parts.push(`${names.join(", ")}: ${short}`);
  for (const r of rows) if (r.outcome === "skipped") parts.push(`${r.name} skipped (${r.notes[0] ?? "no reason given"})`);
  return parts.length > 0 ? parts.join("; ") : "nothing to do";
}

const strip = (r: Pending): McpResult => ({ id: r.id, agent: r.agent, name: r.name, outcome: r.outcome, ...(r.notes.length > 0 ? { note: r.notes.join("; ") } : {}) });

interface GuestScope extends Omit<McpScope, "format"> {
  /** Index into the script's editors: the scope's format, carried once however many scopes share it. */
  editor: number;
}

interface GuestAgent extends Omit<McpAgentPlan, "scopes"> {
  scopes: GuestScope[];
}

/** The plan as the guest script takes it: `write` off reads, on edits; the tool rows stay on the host. */
interface GuestPlan extends Omit<McpPlan, "tools" | "agents"> {
  agents: GuestAgent[];
  write: boolean;
}

/** The script with every format the agents use, each editor once, and the plan pointing each scope at its editor. */
function guestRun(plan: McpPlan, agents: readonly McpAgentPlan[], write: boolean): { script: string; plan: GuestPlan } {
  const editors = [...new Set(agents.flatMap(a => a.scopes.map(s => s.format.guest)))];
  const guestAgents = agents.map(a => ({ ...a, scopes: a.scopes.map(({ format, ...scope }) => ({ ...scope, editor: editors.indexOf(format.guest) })) }));
  return { script: guestScript(editors), plan: { agents: guestAgents, guestHome: plan.guestHome, rewrites: plan.rewrites, binDirs: plan.binDirs, write } };
}

/** An exec the machine never ran (refused by the provider, lost while it napped) reads as a failed one with the
 * error's words, so the stage names it on every server and the build goes on. */
const refused = (e: unknown): ExecResult => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });

async function runScript(machine: Machine, plan: McpPlan, agents: readonly McpAgentPlan[], write: boolean): Promise<{ scopes: ScopeOutcome[] } | { failure: string }> {
  const run = guestRun(plan, agents, write);
  const res = await machine.run(`export PATH="/usr/local/bin:$PATH"\nnode -e ${shellQuote(run.script)} ${shellQuote(JSON.stringify(run.plan))}`, { deadlineMs: 120_000 }).catch(refused);
  const report = res.exitCode === 0 ? parseReport(res.stdout) : undefined;
  return report ?? { failure: `the config edit did not run (${reasonOf(res, 120)})` };
}

const tail = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/** Why a server whose command the machine does not have is skipped: when the recipe has a tool row for that
 * binary, what became of the row. */
function absentReason(command: string, plan: McpPlan, tools: readonly ToolResult[]): string {
  const base = "command not on the machine";
  const row = plan.tools.find(t => tail(t.id) === basename(command));
  if (row === undefined) return base;
  if (!row.ticked) return `${base}; ${row.id} was not ticked${row.reason !== undefined ? ` (${row.reason})` : ""}`;
  const result = tools.find(t => t.id === row.id);
  if (result?.outcome === "skipped" || result?.outcome === "failed") return `${base}; ${row.id} ${result.outcome === "failed" ? "failed" : "was skipped"}${result.note !== undefined ? ` (${result.note})` : ""}`;
  return `${base}; ${row.id} was ticked, but nothing by that name is on PATH`;
}

/** The agents with every kept server whose command is neither on the machine nor fetched on first use moved to
 * the drops, with its reason. */
function withoutAbsent(plan: McpPlan, read: readonly ScopeOutcome[], missing: ReadonlySet<string>, asRun: (c: string) => string, tools: readonly ToolResult[]): McpAgentPlan[] {
  let at = 0;
  return plan.agents.map(agent => ({
    ...agent,
    scopes: agent.scopes.map(scope => {
      const results = read[at++]?.results ?? [];
      const commandOf = (name: string): string | undefined => results.find(r => r.name === name)?.command;
      const absent = scope.keep.filter(name => {
        const command = commandOf(name);
        return command !== undefined && FETCHERS[basename(command)] === undefined && missing.has(asRun(command));
      });
      if (absent.length === 0) return scope;
      return { ...scope, keep: scope.keep.filter(name => !absent.includes(name)), drop: [...scope.drop, ...absent.map(name => ({ name, reason: absentReason(commandOf(name)!, plan, tools) }))] };
    }),
  }));
}

/** Runs the plan on the builder in two passes of the guest script: the first reads each kept server's command as
 * the machine will run it, every command is looked for on the machine's PATH, and the second writes the configs
 * with the servers whose command is neither there nor fetched on first use taken out. uv is installed by its
 * checksummed release when a server runs through it and it is missing. Each server is named on the stage as
 * installed or skipped with its reason; `tools` is what the tools stage did, so a skipped server can name the row
 * that would have brought its command. Nothing here fails the build. */
export async function applyMcp(machine: Machine, plan: McpPlan, stage: StageListener, tools: readonly ToolResult[] = []): Promise<McpResult[]> {
  const count = (a: McpAgentPlan): number => a.scopes.reduce((n, s) => n + s.keep.length + s.drop.length, 0) + a.aside.length;
  stage("installing-mcp", plan.agents.map(a => `${a.label} ${count(a)}`).join(", "));
  const asRun = (command: string): string => (command.startsWith("~/") ? `${plan.guestHome}${command.slice(1)}` : command);
  const missing = new Set<string>();
  let agents = plan.agents;
  let run = await runScript(machine, plan, agents, false);
  if ("scopes" in run) {
    const commands = [...new Set(run.scopes.flatMap(s => s.results.flatMap(r => (r.command !== undefined ? [asRun(r.command)] : []))))];
    if (commands.length > 0) {
      const check = await machine.exec(`export PATH=${TOOLS_PATH}\n${commands.map(c => `if command -v ${shellQuote(c)} >/dev/null 2>&1; then echo ${shellQuote(`ok ${c}`)}; else echo ${shellQuote(`no ${c}`)}; fi`).join("\n")}`, { timeoutMs: INLINE_EXEC_MS }).catch(refused);
      for (const line of check.stdout.split("\n")) if (line.startsWith("no ")) missing.add(line.slice(3));
    }
    agents = withoutAbsent(plan, run.scopes, missing, asRun, tools);
    run = await runScript(machine, plan, agents, true);
  }
  const report = "scopes" in run ? run.scopes : undefined;
  const failure = "failure" in run ? run.failure : undefined;
  const rows: Pending[] = [];
  let at = 0;
  for (const agent of agents) {
    for (const scope of agent.scopes) {
      const outcome = report?.[at++];
      const id = (name: string): string => `${MCP_ID_PREFIX}${agent.id}/${scope.project !== undefined ? "home/" : ""}${name}`;
      const skippedKeep =
        failure ?? (outcome === undefined || outcome.file === null ? `${agent.label}'s config is not on the machine` : outcome.error !== undefined ? `${agent.label}'s config on the machine did not parse (${outcome.error})` : undefined);
      for (const name of scope.keep) {
        const r = outcome?.results.find(x => x.name === name);
        if (skippedKeep !== undefined || r === undefined || r.outcome === "missing") {
          rows.push(skipped(id(name), agent.label, name, skippedKeep ?? "not in the config that travelled"));
          continue;
        }
        const fetcher = r.command !== undefined ? FETCHERS[basename(r.command)] : undefined;
        rows.push({
          id: id(name), agent: agent.label, name,
          outcome: fetcher === undefined ? "installed" : "fetched-on-first-use",
          ...(r.command !== undefined ? { command: r.command } : {}),
          notes: fetcher === undefined ? [] : [`${fetcher} fetches the package on first use`],
          shorts: fetcher === undefined ? [] : [`package fetched on first use by ${fetcher}`],
        });
      }
      for (const d of scope.drop) rows.push(skipped(id(d.name), agent.label, d.name, d.reason));
    }
    for (const a of agent.aside) rows.push(skipped(a.id, agent.label, a.name, a.reason));
  }

  const viaUv = rows.filter(r => r.command !== undefined && ["uv", "uvx"].includes(basename(r.command)) && missing.has(asRun(r.command)));
  if (viaUv.length > 0) {
    stage("installing-mcp", `uv for ${viaUv.map(r => r.name).join(", ")}`);
    const install = await machine.run(guarded(`set -euo pipefail\n${UV_INSTALL}`, TOOL_TIMEOUT_S), { deadlineMs: guardDeadlineMs(TOOL_TIMEOUT_S), onLine: line => stage("installing-mcp", `uv: ${line}`) }).catch(refused);
    for (const r of viaUv) {
      if (install.exitCode === 0) {
        r.notes.unshift("uv installed for it");
        r.shorts.unshift("uv installed");
      } else {
        const short = `uv did not install (${reasonOf(install, TOOL_TIMEOUT_S)})`;
        r.shorts.unshift(short);
        r.notes.unshift(`${short}; the server starts once it is installed there`);
      }
    }
  }
  const viaUvNames = new Set(viaUv.map(r => r.id));
  for (const r of rows) {
    if (r.command === undefined || viaUvNames.has(r.id) || !missing.has(asRun(r.command))) continue;
    const short = `${basename(r.command)} is not on the machine`;
    r.shorts.push(short);
    r.notes.push(`${short}; the server starts once it is installed there`);
  }
  stage("installing-mcp", closing(summarize(rows), await freeNote(machine).catch(() => undefined)));
  return rows.map(strip);
}

const skipped = (id: string, agent: string, name: string, note: string): Pending => ({ id, agent, name, outcome: "skipped", notes: [note], shorts: [] });
