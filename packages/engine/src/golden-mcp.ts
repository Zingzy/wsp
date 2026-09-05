// SPDX-License-Identifier: AGPL-3.0-only
// The MCP stage on the builder. The definitions themselves arrive inside each
// agent's config file with that agent's row, secrets included, so nothing here
// carries a definition: the plan names which servers stay, which come out and
// why, and the prefixes that read differently on the machine. A script on the
// guest edits the files in place and touches no server it was not told about.
import { MCP_ID_PREFIX } from "@wsp/protocol";
import { TOOLS_PATH, UV_INSTALL, type RecipeEntry } from "./golden-import.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { TOOL_TIMEOUT_S, guardDeadlineMs, guarded, reasonOf } from "./golden-tools.js";
import type { Machine } from "./machine.js";
import type { StageListener } from "./golden.js";

const MCP_REMOTE_ID = `${MCP_ID_PREFIX}mcp-remote`;

export type McpFormat = "claude" | "codex" | "gemini" | "opencode";

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

/** A row's agent, scope and server name from its id: `agents/mcp/<agent>/<name>`, or `agents/mcp/<agent>/home/<name>`. */
function parseId(id: string): { agent: string; home: boolean; name: string } | undefined {
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
      const p = parseId(e.id);
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
  };
}

// --- the guest script ------------------------------------------------------------

/** Runs under the guest's node with the plan as its one argument. Edits each config in place: kept servers get
 * their strings rewritten (the command to a bare name when it sits in a bin directory), dropped ones come out,
 * every other key and server stays. Codex's TOML is edited by line so its comments and order survive. Prints one
 * JSON object: a result per scope in plan order, naming each server's outcome and command and never its values. */
const GUEST_SCRIPT = String.raw`
const fs = require("fs");
const plan = JSON.parse(process.argv[1]);
function stripComments(text) {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) { out += c; if (c === "\\" && i + 1 < text.length) out += text[++i]; else if (c === '"') inString = false; i++; }
    else if (c === '"') { inString = true; out += c; i++; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; }
    else { out += c; i++; }
  }
  return out;
}
function rewriteString(s, command) {
  if (command) for (const d of plan.binDirs) if (s.startsWith(d) && !s.slice(d.length).includes("/")) return s.slice(d.length);
  const flag = /^--?[\w-]+=/.exec(s);
  const head = flag ? flag[0] : "";
  const body = s.slice(head.length);
  for (const [from, to] of plan.rewrites) if (body.startsWith(from)) return head + to + body.slice(from.length);
  return s;
}
function walk(v, command) {
  if (typeof v === "string") return rewriteString(v, command);
  if (Array.isArray(v)) return v.map((x, i) => walk(x, command && i === 0));
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k === "command"); return o; }
  return v;
}
function commandOf(def) {
  const c = def && def.command;
  return typeof c === "string" ? c : Array.isArray(c) && typeof c[0] === "string" ? c[0] : undefined;
}
function firstFile(files) {
  for (const f of files) { try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}
function jsonScope(scope, file) {
  const before = fs.readFileSync(file, "utf8");
  const root = JSON.parse(stripComments(before));
  const key = scope.format === "opencode" ? "mcp" : "mcpServers";
  const project = scope.project;
  const source = project ? (root.projects && root.projects[project.from]) || {} : root;
  const servers = source[key] && typeof source[key] === "object" ? source[key] : {};
  function target() {
    if (!project) return servers;
    root.projects = root.projects || {};
    root.projects[project.to] = root.projects[project.to] || {};
    root.projects[project.to][key] = root.projects[project.to][key] || {};
    return root.projects[project.to][key];
  }
  const moved = project && root.projects && root.projects[project.to] && root.projects[project.to][key] ? root.projects[project.to][key] : {};
  const results = [];
  for (const name of scope.keep) {
    const def = servers[name];
    if (def === undefined) {
      if (moved[name] !== undefined) results.push({ name, outcome: "written", command: commandOf(moved[name]) });
      else results.push({ name, outcome: "missing" });
      continue;
    }
    const next = walk(def, false);
    if (project) delete servers[name];
    target()[name] = next;
    results.push({ name, outcome: "written", command: commandOf(next) });
  }
  for (const d of scope.drop) { delete servers[d.name]; results.push({ name: d.name, outcome: "dropped" }); }
  const after = JSON.stringify(root, null, 2) + "\n";
  if (JSON.stringify(JSON.parse(stripComments(before))) !== JSON.stringify(root)) fs.writeFileSync(file, after);
  return results;
}
function uncomment(line) {
  let quote;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = undefined; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}
const HEADER = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*[A-Za-z0-9_-]+\s*)?\]$/;
const STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
function decodeToml(s) {
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (m, e) => (e[0] === "u" || e[0] === "U" ? String.fromCodePoint(parseInt(e.slice(1), 16)) : e in ESCAPES ? ESCAPES[e] : m));
}
function encodeToml(s) {
  return s.replace(/[\\"\u0000-\u001f\u007f]/g, c => {
    const back = Object.keys(ESCAPES).find(k => ESCAPES[k] === c);
    return back !== undefined ? "\\" + back : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  });
}
function rewriteTomlLine(line) {
  const code = uncomment(line);
  const isCommand = /^\s*command\s*=/.test(code);
  // A token is re-emitted only when its value changed, so escapes the rewrite never touched stay as written.
  const next = code.replace(STRING, (m, basic, literal) => {
    if (literal !== undefined) {
      const value = rewriteString(literal, isCommand);
      return value === literal ? m : "'" + value + "'";
    }
    const value = decodeToml(basic);
    const rewritten = rewriteString(value, isCommand);
    return rewritten === value ? m : '"' + encodeToml(rewritten) + '"';
  });
  return next + line.slice(code.length);
}
function codexScope(scope, file) {
  const before = fs.readFileSync(file, "utf8");
  const lines = before.split("\n");
  const owner = [];
  let current = null;
  for (const raw of lines) {
    const t = uncomment(raw).trim();
    if (t.startsWith("[")) { const m = HEADER.exec(t); current = m ? (m[1] || m[2] || m[3]) : null; }
    owner.push(current);
  }
  const keep = new Set(scope.keep), drop = new Set(scope.drop.map(d => d.name));
  const out = [], outOwner = [];
  for (let i = 0; i < lines.length; i++) {
    if (owner[i] !== null && drop.has(owner[i])) continue;
    out.push(owner[i] !== null && keep.has(owner[i]) ? rewriteTomlLine(lines[i]) : lines[i]);
    outOwner.push(owner[i]);
  }
  const results = [];
  for (const name of scope.keep) {
    if (!owner.includes(name)) { results.push({ name, outcome: "missing" }); continue; }
    let command;
    out.forEach((l, i) => {
      if (outOwner[i] !== name) return;
      const m = /^\s*command\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(uncomment(l));
      if (m) command = m[1] !== undefined ? decodeToml(m[1]) : m[2];
    });
    results.push({ name, outcome: "written", command });
  }
  for (const d of scope.drop) results.push({ name: d.name, outcome: "dropped" });
  const after = out.join("\n");
  if (after !== before) fs.writeFileSync(file, after);
  return results;
}
const scopes = [];
for (const agent of plan.agents) {
  for (const scope of agent.scopes) {
    const file = firstFile(scope.files);
    if (file === null) { scopes.push({ file: null, results: [] }); continue; }
    try { scopes.push({ file, results: scope.format === "codex" ? codexScope(scope, file) : jsonScope(scope, file) }); }
    catch (e) { scopes.push({ file, error: String(e && e.message || e), results: [] }); }
  }
}
process.stdout.write(JSON.stringify({ scopes }));
`;

interface ScopeOutcome {
  file: string | null;
  error?: string;
  results: { name: string; outcome: "written" | "missing" | "dropped"; command?: string }[];
}

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

/** Runs the plan on the builder: the guest script edits the configs, then every kept command is looked for on
 * the machine's PATH, uv is installed by its checksummed release when a server runs through it and it is missing,
 * and each server is named on the stage as installed or skipped with its reason. Nothing here fails the build. */
export async function applyMcp(machine: Machine, plan: McpPlan, stage: StageListener): Promise<McpResult[]> {
  const count = (a: McpAgentPlan): number => a.scopes.reduce((n, s) => n + s.keep.length + s.drop.length, 0) + a.aside.length;
  stage("installing-mcp", plan.agents.map(a => `${a.label} ${count(a)}`).join(", "));
  const res = await machine.run(`export PATH="/usr/local/bin:$PATH"\nnode -e ${squote(GUEST_SCRIPT)} ${squote(JSON.stringify(plan))}`, { deadlineMs: 120_000 });
  const report = res.exitCode === 0 ? parseReport(res.stdout) : undefined;
  const failure = report === undefined ? `the config edit did not run (${reasonOf(res, 120)})` : undefined;
  const rows: Pending[] = [];
  let at = 0;
  for (const agent of plan.agents) {
    for (const scope of agent.scopes) {
      const outcome = report?.scopes[at++];
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

  const asRun = (command: string): string => (command.startsWith("~/") ? `${plan.guestHome}${command.slice(1)}` : command);
  const commands = [...new Set(rows.flatMap(r => (r.command !== undefined ? [asRun(r.command)] : [])))];
  const missing = new Set<string>();
  if (commands.length > 0) {
    const check = await machine.exec(`export PATH=${TOOLS_PATH}\n${commands.map(c => `if command -v ${squote(c)} >/dev/null 2>&1; then echo ${squote(`ok ${c}`)}; else echo ${squote(`no ${c}`)}; fi`).join("\n")}`, { timeoutMs: INLINE_EXEC_MS });
    for (const line of check.stdout.split("\n")) if (line.startsWith("no ")) missing.add(line.slice(3));
  }
  const viaUv = rows.filter(r => r.command !== undefined && ["uv", "uvx"].includes(basename(r.command)) && missing.has(asRun(r.command)));
  if (viaUv.length > 0) {
    stage("installing-mcp", `uv for ${viaUv.map(r => r.name).join(", ")}`);
    const install = await machine.run(guarded(`set -euo pipefail\n${UV_INSTALL}`, TOOL_TIMEOUT_S), { deadlineMs: guardDeadlineMs(TOOL_TIMEOUT_S), onLine: line => stage("installing-mcp", `uv: ${line}`) });
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
  stage("installing-mcp", summarize(rows));
  return rows.map(strip);
}

const skipped = (id: string, agent: string, name: string, note: string): Pending => ({ id, agent, name, outcome: "skipped", notes: [note], shorts: [] });
