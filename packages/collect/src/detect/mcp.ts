// SPDX-License-Identifier: AGPL-3.0-only
// MCP servers travel with the agent that runs them, credentials included: one
// row per server under its agent. The definition itself rides inside the
// agent's config file (the agent's own row); this file reads that config
// through the catalog entry's format module to say what each server is, what
// it needs on Linux and which secret it carries. Token files are only stat'ed,
// never read.
import { createHash } from "node:crypto";
import { MCP_AGENTS, parseJsonc, type McpAgent, type McpConfig, type McpServer, type McpTransport } from "@wsp/catalog";
import { MCP_ID_PREFIX, fmtBytes } from "@wsp/protocol";
import { type Host, expand } from "../host.js";
import type { GroupNote, ManifestEntry } from "../manifest.js";
import { isSecretName } from "../everything/shell-rc.js";
import { BASE_INTERPRETERS, HAND_DIRS, HAND_GROUP, type HandBin, brought, carries, handBins } from "./hand-bins.js";

/** The row that carries mcp-remote's saved browser sign-ins for every agent. */
export const MCP_REMOTE_ID = `${MCP_ID_PREFIX}mcp-remote`;
export const MCP_REMOTE_LABEL = "mcp-remote sign-ins";

export type LinuxFit = { ok: true; needs: string } | { ok: false; reason: string };

const MCP_AUTH = "~/.mcp-auth";
/** mcp-remote's store since its versioned folders went away: MCP_REMOTE_CONFIG_DIR or ~/.mcp-auth, then mcp-remote-v1. */
const MCP_REMOTE_STORE = `${MCP_AUTH}/mcp-remote-v1`;

// --- parsing -----------------------------------------------------------------

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = parseJsonc(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- what runs on Linux --------------------------------------------------------

/** Absolute prefixes with no Linux equivalent. */
const MAC_ONLY = ["/Applications/", "/System/", "/Library/", "/Volumes/", "/private/", "/opt/homebrew/Caskroom/"];
/** Directories whose binaries the machine finds on its own PATH under the same name; the import's plan strips them too. */
export const MCP_BIN_DIRS: readonly string[] = ["/opt/homebrew/bin/", "/opt/homebrew/sbin/", "/usr/local/bin/", "/usr/bin/", "/bin/"];

function tilde(home: string, p: string): string {
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function isMacOnly(p: string, home: string): boolean {
  const abs = p.startsWith("~/") ? `${home}${p.slice(1)}` : p;
  return abs.startsWith(`${home}/Library/`) || MAC_ONLY.some(prefix => abs.startsWith(prefix));
}

/** `--flag=/path` carries its path after the equals sign. */
const pathOf = (s: string): string => (/^--?[\w-]+=/.test(s) ? s.slice(s.indexOf("=") + 1) : s);

/** The binary a command names: a path under a known bin directory or under ~/.local/bin is found by name on the machine. */
function binaryOf(command: string, home: string): string {
  const abs = command.startsWith("~/") ? `${home}${command.slice(1)}` : command;
  if (!abs.startsWith("/")) return abs;
  if (MCP_BIN_DIRS.some(d => abs.startsWith(d)) || abs.startsWith(`${home}/.local/bin/`)) return abs.slice(abs.lastIndexOf("/") + 1);
  return tilde(home, abs);
}

/** The hand-installed binary a command names, when the command sits in one of the hand bin directories. */
function handOf(command: string, home: string, hands: ReadonlyMap<string, HandBin>): HandBin | undefined {
  const abs = command.startsWith("~/") ? `${home}${command.slice(1)}` : command;
  const slash = abs.lastIndexOf("/");
  if (slash === -1) return undefined;
  return HAND_DIRS.some(d => `${home}${d.slice(1)}` === abs.slice(0, slash)) ? hands.get(abs.slice(slash + 1)) : undefined;
}

/** Whether a definition can run on the machine and what it needs there. A path under ~/Library or a macOS
 * install location has no Linux equivalent; home paths and Homebrew's prefix are rewritten on the machine.
 * A command installed by hand travels only as a copy of a script or a Linux binary, with its own row; brings
 * is what the machine has for its interpreter (see brought). */
export function linuxFit(server: McpServer, home: string, hands: ReadonlyMap<string, HandBin> = new Map(), brings: ReadonlySet<string> = BASE_INTERPRETERS): LinuxFit {
  const t = server.transport;
  if (t.kind === "http") return { ok: true, needs: "nothing to install" };
  if (isMacOnly(t.command, home)) return { ok: false, reason: `command ${tilde(home, t.command)} is macOS-only, will not run` };
  for (const s of [...t.args.map(pathOf), ...(t.cwd !== undefined ? [t.cwd] : []), ...Object.values(t.env)]) {
    if (isMacOnly(s, home)) return { ok: false, reason: `path ${tilde(home, s)} is macOS-only, will not run` };
  }
  const hand = handOf(t.command, home, hands);
  if (hand !== undefined && !carries(hand.format)) {
    return { ok: false, reason: hand.format.kind === "mach-o" ? `command ${hand.name} is a macOS binary installed by hand, will not run` : `command ${hand.name} is installed by hand and has no build the machine can run, will not run` };
  }
  if (hand !== undefined) {
    const need = hand.format.kind === "script" && hand.format.at !== undefined && !BASE_INTERPRETERS.has(hand.format.interpreter) ? hand.format.interpreter : undefined;
    if (need !== undefined && !brings.has(need)) {
      return { ok: false, reason: `command ${hand.name} is a ${need} script installed by hand, and neither the machine nor a tools row brings ${need}; its row under ${HAND_GROUP} is locked, will not run` };
    }
    const via = need !== undefined ? `, and runs with ${need}, so the ${need} row has to be ticked too` : "";
    return { ok: true, needs: `needs ${hand.name} on the machine; it travels as a copy when its row under ${HAND_GROUP} is ticked${via}` };
  }
  const bin = binaryOf(t.command, home);
  if (bin === "npx") return { ok: true, needs: "runs via npx" };
  if (bin === "uvx" || bin === "uv") return { ok: true, needs: "needs uv, installed on the machine when missing" };
  return { ok: true, needs: `needs ${bin} on the machine` };
}

// --- mcp-remote ------------------------------------------------------------------

const isUrl = (s: string): boolean => /^https?:\/\//.test(s);

const sortedJson = (o: Record<string, string>): string[] => (Object.keys(o).length > 0 ? [JSON.stringify(o, Object.keys(o).sort())] : []);

/** The store key mcp-remote derives for a definition that runs it, as its getServerUrlHash does: md5 of the server
 * url, the `--resource`, the sorted `--authorize-param` pairs, the sorted `--header` pairs and the
 * `--client-metadata-url`, joined with `|`. Undefined when the definition does not run mcp-remote. */
export function mcpRemoteHash(args: readonly string[]): string | undefined {
  const at = args.findIndex(a => /^mcp-remote(@[^/]*)?$/.test(a));
  if (at < 0) return undefined;
  const rest = args.slice(at + 1);
  const url = rest.find(isUrl);
  if (url === undefined) return undefined;
  const headers: Record<string, string> = {};
  const params: Record<string, string> = {};
  const after = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1]?.trim() : undefined;
  };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i + 1];
    if (value === undefined) continue;
    if (rest[i] === "--header" || rest[i] === "-H") {
      const colon = value.indexOf(":");
      if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
    } else if (rest[i] === "--authorize-param") {
      const eq = value.indexOf("=");
      if (eq > 0) params[value.slice(0, eq).trim()] = value.slice(eq + 1).trim();
    }
  }
  const resource = after("--resource");
  const metadata = after("--client-metadata-url");
  const parts = [url, ...(resource !== undefined ? [resource] : []), ...sortedJson(params), ...sortedJson(headers), ...(metadata !== undefined ? [metadata] : [])];
  return createHash("md5").update(parts.join("|")).digest("hex");
}

// --- rows ----------------------------------------------------------------------------

/** isSecretName's words plus the ones a file-valued variable tends to carry. */
function secretNamed(name: string): boolean {
  return isSecretName(name) || name.toUpperCase().split("_").some(w => ["CREDENTIAL", "CREDENTIALS", "AUTH", "CERT", "PASSWD"].includes(w));
}

/** Flags whose next argument is a secret whatever its name says: a header line, mcp-remote's OAuth client record with its client_secret. */
const HIDDEN_FLAGS = new Set(["--header", "-H", "--static-oauth-client-info"]);
/** A flag takes the next argument as its value unless that argument is itself a flag. */
const takesValue = (next: string | undefined): next is string => next !== undefined && !next.startsWith("-");

/** `--api-key`, `--token=`: a flag whose name is secret-shaped; its value is a secret. */
const secretFlag = (arg: string): string | undefined => {
  const m = /^(--?[A-Za-z][\w-]*)(=|$)/.exec(arg);
  return m !== null && secretNamed(m[1]!.replace(/-/g, "_")) ? m[1]! : undefined;
};
/** `API_KEY=...` as an argument. */
const secretAssign = (arg: string): string | undefined => {
  const m = /^([A-Za-z_]\w*)=/.exec(arg);
  return m !== null && secretNamed(m[1]!) ? m[1]! : undefined;
};

const shownUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

/** The definition in a few words: the command and its arguments with npx's yes flag dropped, urls shown as
 * host and path, and every value that is a secret hidden: after --header, after or inside a secret-named flag,
 * inside a secret-named NAME=value. */
function transportLine(t: McpTransport, home: string): string {
  if (t.kind === "http") return `http: ${shownUrl(t.url)}`;
  const shown: string[] = [];
  for (let i = 0; i < t.args.length; i++) {
    const a = t.args[i]!;
    if (a === "-y" || a === "--yes") continue;
    const flag = secretFlag(a);
    const assign = secretAssign(a);
    if (HIDDEN_FLAGS.has(a) || (flag !== undefined && !a.includes("="))) {
      shown.push(a);
      if (takesValue(t.args[i + 1])) {
        shown.push("…");
        i++;
      }
      continue;
    }
    if (flag !== undefined || assign !== undefined) {
      shown.push(`${flag ?? assign}=…`);
      continue;
    }
    shown.push(isUrl(a) ? `(${shownUrl(a)})` : tilde(home, a));
  }
  const cut = shown.length > 5 ? [...shown.slice(0, 5), "…"] : shown;
  return `stdio: ${[tilde(home, t.command), ...cut].join(" ")}`;
}

interface Carried {
  secrets: string[];
  notes: string[];
  paths: string[];
  bytes: number;
}

/** Home paths a stdio definition runs against (arguments, cwd, env values), `~`-relative, the command itself and
 * anything under ~/.local/bin left out: what the machine needs beside the definition. */
export function homePaths(server: McpServer, home: string): string[] {
  const t = server.transport;
  if (t.kind === "http") return [];
  const out = new Set<string>();
  for (const s of [...t.args.map(pathOf), ...(t.cwd !== undefined ? [t.cwd] : []), ...Object.values(t.env)]) {
    const abs = s.startsWith("~/") ? `${home}${s.slice(1)}` : s;
    if (!abs.startsWith(`${home}/`) || abs.startsWith(`${home}/.local/bin/`)) continue;
    out.add(tilde(home, abs));
  }
  return [...out];
}

interface HomeDeps {
  notes: string[];
  /** A path the definition runs against is not here: the row starts unticked, and the person decides. */
  gone: boolean;
}

/** Whether each home path a definition runs against is here: one that is here and travels on no row of this
 * server is named as a dependency; one that is not here unticks the row but never locks it, since a server that
 * makes its own file (a memory store, a sqlite db) runs fine without it. */
async function homeDeps(host: Host, server: McpServer, carriedPaths: readonly string[]): Promise<HomeDeps> {
  const out: HomeDeps = { notes: [], gone: false };
  for (const p of homePaths(server, host.home)) {
    if (carriedPaths.includes(p)) continue;
    if ((await host.fs.stat(expand(host, p))) === undefined) {
      out.gone = true;
      out.notes.push(`${p} is not on this computer; unticked, tick it if the server creates it on first start`);
    } else out.notes.push(`depends on ${p}, which comes along only if a row carries it`);
  }
  return out;
}

/** What a definition carries: secret-named env values by size, the file such a value points at (which travels on
 * the row), header values, and where its mcp-remote or Claude Code sign-in lives. Nothing is read. */
async function carried(host: Host, server: McpServer, agent: McpAgent, remoteTokens: ReadonlyMap<string, number>): Promise<Carried> {
  const out: Carried = { secrets: [], notes: [], paths: [], bytes: 0 };
  const t = server.transport;
  if (t.kind === "http") {
    for (const [k, v] of Object.entries(t.headers)) out.secrets.push(`header ${k} (${Buffer.byteLength(v)} B)`);
    if (agent.id === "claude") out.notes.push("its sign-in is kept with the Claude Code login");
    return out;
  }
  for (const [k, v] of Object.entries(t.env)) {
    if (!secretNamed(k)) continue;
    const abs = v.startsWith("~/") ? expand(host, v) : v;
    const st = abs.startsWith("/") ? await host.fs.stat(abs) : undefined;
    if (st?.kind === "file") {
      if (!abs.startsWith(`${host.home}/`)) {
        out.notes.push(`the file ${k} points at is outside your home and is not copied`);
        continue;
      }
      out.secrets.push(`the file ${k} points at (${fmtBytes(st.bytes)})`);
      out.paths.push(`~${abs.slice(host.home.length)}`);
      out.bytes += st.bytes;
      continue;
    }
    out.secrets.push(`env ${k} (${Buffer.byteLength(v)} B)`);
  }
  for (let i = 0; i < t.args.length; i++) {
    const a = t.args[i]!;
    const flag = secretFlag(a);
    const assign = secretAssign(a);
    const hidden = HIDDEN_FLAGS.has(a) ? a : flag;
    if (hidden !== undefined && !a.includes("=")) {
      const value = t.args[i + 1];
      if (!takesValue(value)) continue;
      out.secrets.push(`flag ${hidden} (${Buffer.byteLength(value)} B)`);
      i++;
    } else if (flag !== undefined || assign !== undefined) {
      out.secrets.push(`${flag !== undefined ? "flag" : "arg"} ${flag ?? assign} (${Buffer.byteLength(a.slice(a.indexOf("=") + 1))} B)`);
    }
  }
  const hash = mcpRemoteHash(t.args);
  if (hash !== undefined) {
    const bytes = remoteTokens.get(hash);
    out.notes.push(bytes === undefined ? "no saved sign-in; the browser sign-in runs again on the machine" : `its saved sign-in (${fmtBytes(bytes)}) travels on the ${MCP_REMOTE_LABEL} row`);
  }
  return out;
}

const mcpGroup = (agent: McpAgent): string => `${agent.name} MCP servers`;

function serverRow(agent: McpAgent, server: McpServer, fit: LinuxFit, deps: HomeDeps, c: Carried, home: string): ManifestEntry {
  const id = `${MCP_ID_PREFIX}${agent.id}/${server.scope === "home" ? "home/" : ""}${server.name}`;
  const reason = fit.ok ? undefined : fit.reason;
  const words = [
    ...(server.scope === "home" ? ["local to ~"] : []),
    transportLine(server.transport, home),
    ...(fit.ok ? [fit.needs, ...deps.notes] : []),
    ...server.envRefs.map(n => `reads ${n} from the environment, set it on the machine`),
    ...(c.secrets.length > 0 ? [`carries ${c.secrets.length === 1 ? "a secret" : "secrets"}: ${c.secrets.join(", ")}`] : c.notes.length === 0 ? ["carries no secret"] : []),
    ...c.notes,
  ];
  return {
    rung: "agents",
    id,
    label: server.name,
    group: mcpGroup(agent),
    paths: c.paths,
    bytes: c.bytes,
    default: reason === undefined && !deps.gone ? "bring" : "skip",
    ...(reason !== undefined ? { reason } : {}),
    // A server that carries a secret travels only on a copy answer, never on a bare tick.
    ...(c.secrets.length > 0 ? { consent: true } : {}),
    detail: words.join("; "),
  };
}

interface RemoteStore {
  /** Token file size by server hash. */
  tokens: Map<string, number>;
  /** Every file that travels: tokens, client registrations and the verifiers beside them. */
  bytes: number;
  excludes: string[];
}

/** The store as it is on disk, by listing: token sizes per hash, older bridge versions' folders and lock files
 * set aside. Undefined when there is no store. */
async function remoteStore(host: Host): Promise<RemoteStore | undefined> {
  if ((await host.fs.stat(expand(host, MCP_AUTH)))?.kind !== "dir") return undefined;
  const out: RemoteStore = { tokens: new Map(), bytes: 0, excludes: [] };
  for (const name of await host.fs.list(expand(host, MCP_AUTH))) if (/^mcp-remote-\d/.test(name)) out.excludes.push(`${MCP_AUTH}/${name}`);
  for (const name of await host.fs.list(expand(host, MCP_REMOTE_STORE))) {
    if (/^[0-9a-f]{32}_lock\.json$/.test(name)) {
      out.excludes.push(`${MCP_REMOTE_STORE}/${name}`);
      continue;
    }
    const bytes = (await host.fs.stat(expand(host, `${MCP_REMOTE_STORE}/${name}`)))?.bytes ?? 0;
    out.bytes += bytes;
    const token = /^([0-9a-f]{32})_tokens\.json$/.exec(name);
    if (token !== null) out.tokens.set(token[1]!, bytes);
  }
  return out;
}

function remoteRow(store: RemoteStore, matched: readonly string[]): ManifestEntry {
  const n = store.tokens.size;
  const tokenBytes = [...store.tokens.values()].reduce((a, b) => a + b, 0);
  const older = store.excludes.some(e => !e.startsWith(`${MCP_REMOTE_STORE}/`));
  const base = { rung: "agents" as const, id: MCP_REMOTE_ID, label: MCP_REMOTE_LABEL, group: "MCP sign-ins", paths: [MCP_AUTH], ...(store.excludes.length > 0 ? { excludes: store.excludes } : {}), bytes: store.bytes };
  if (n === 0) return { ...base, default: "skip", reason: `no saved sign-in the current bridge reads${older ? "; older versions' folders are left here" : ""}` };
  const elsewhere = n - matched.length;
  const whom = [...(matched.length > 0 ? [`for ${matched.join(", ")}`] : []), ...(elsewhere > 0 ? [`${elsewhere} for server${elsewhere === 1 ? "" : "s"} configured elsewhere (a repo's .mcp.json)`] : [])];
  return {
    ...base,
    default: "bring",
    consent: true,
    detail: `browser sign-ins saved by mcp-remote for remote servers: ${n} token${n === 1 ? "" : "s"} (${fmtBytes(tokenBytes)})${whom.length > 0 ? `, ${whom.join("; ")}` : ""}${older ? "; older bridge versions' folders stay here" : ""}`,
  };
}

/** The text of the first of an agent's config files that is here. */
async function configText(host: Host, config: McpConfig): Promise<string | undefined> {
  for (const file of config.files) {
    if ((await host.fs.stat(expand(host, file)))?.kind !== "file") continue;
    const text = await host.fs.readText(expand(host, file));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** One row per MCP server under its agent, then the mcp-remote sign-in store when there is one; prior is the
 * rows detected before this rung, whose tools rows say which interpreters reach the machine. Each agent's config is
 * read by its entry's format module, so an agent the catalog gains needs nothing here. */
export async function detectMcp(host: Host, prior: readonly ManifestEntry[] = [], agents: readonly McpAgent[] = MCP_AGENTS): Promise<ManifestEntry[]> {
  const brings = brought(prior);
  const store = await remoteStore(host);
  const tokens = store?.tokens ?? new Map<string, number>();
  const rows: ManifestEntry[] = [];
  const matched: string[] = [];
  let hands: Map<string, HandBin> | undefined;
  for (const agent of agents) {
    const text = await configText(host, agent.mcp);
    if (text === undefined) continue;
    hands ??= new Map((await handBins(host)).map(b => [b.name, b]));
    for (const server of agent.mcp.format.read(text, host.home)) {
      const fit = linuxFit(server, host.home, hands, brings);
      const c = await carried(host, server, agent, tokens);
      const deps = await homeDeps(host, server, c.paths);
      const hash = server.transport.kind === "stdio" ? mcpRemoteHash(server.transport.args) : undefined;
      if (hash !== undefined && tokens.has(hash)) matched.push(server.name);
      rows.push(serverRow(agent, server, fit, deps, c, host.home));
    }
  }
  if (store !== undefined) rows.push(remoteRow(store, matched));
  return rows;
}

// --- what the list leaves out ------------------------------------------------------

interface LeftOut {
  servers: number;
  folders: number;
}

/** Servers Claude Code reads only inside a project folder: a project entry's own list (the home folder's is on
 * the rows) and the .mcp.json in that folder, both in the file's own shape. Only the folders ~/.claude.json names
 * are looked at. */
async function claudeLeftOut(host: Host, agent: McpAgent, root: Record<string, unknown>): Promise<LeftOut> {
  const out: LeftOut = { servers: 0, folders: 0 };
  if (!isObject(root.projects)) return out;
  const names = (text: string): string[] => agent.mcp.format.read(text, host.home).filter(s => s.scope === "user").map(s => s.name);
  for (const [folder, project] of Object.entries(root.projects)) {
    if (!folder.startsWith("/")) continue;
    const found = new Set(folder === host.home ? [] : names(JSON.stringify(project)));
    const file = `${folder}/.mcp.json`;
    if ((await host.fs.stat(file))?.kind === "file") {
      const text = await host.fs.readText(file);
      if (text !== undefined) for (const name of names(text)) found.add(name);
    }
    if (found.size === 0) continue;
    out.servers += found.size;
    out.folders += 1;
  }
  return out;
}

/** What each agent's group covers, for the groups that have rows; Claude Code's also counts the project-scoped
 * servers it leaves out. */
export async function mcpGroups(host: Host, rows: readonly ManifestEntry[], agents: readonly McpAgent[] = MCP_AGENTS): Promise<GroupNote[]> {
  const out: GroupNote[] = [];
  for (const agent of agents) {
    const group = mcpGroup(agent);
    if (!rows.some(r => r.group === group)) continue;
    const note: GroupNote = { rung: "agents", group, hint: agent.mcp.scope };
    if (agent.id === "claude") {
      const text = await configText(host, agent.mcp);
      const root = text === undefined ? undefined : parseJson(text);
      const left = root === undefined ? undefined : await claudeLeftOut(host, agent, root);
      if (left !== undefined && left.servers > 0) {
        note.note = `${left.servers} more in ${left.folders} project folder${left.folders === 1 ? "" : "s"} stay on this computer (a repo's .mcp.json travels with it)`;
      }
    }
    out.push(note);
  }
  return out;
}
