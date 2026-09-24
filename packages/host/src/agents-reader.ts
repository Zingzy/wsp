// SPDX-License-Identifier: AGPL-3.0-only
// The agents report off one target, read through the collector's Host: this
// computer's own, or machineHost over a computer's link, a workspace or a fork,
// every line as the login the computer was added with. Everything is read off
// config and presence: no MCP server is started, no harness list command runs
// and no login file is opened, so a page open costs a handful of round trips
// and nothing the person has set up is started by looking at it.
import { userInfo } from "node:os";
import { posix } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS, TOOL_PREFIX, signInRoadOf, type AgentEntry, type McpAgent, type McpServer } from "@wsp/catalog";
import { detectSkills, expand, nodeHost, skillRoots, stdioLine, tilde, type Host } from "@wsp/collect";
import { landedServersScript, mcpRowId, NO_DIGEST, parseLandedServers, targetLogin } from "@wsp/engine";
import { MCP_SERVER_NAME, agentVersionWord, shellQuote, type AgentRow, type AgentSignInState, type McpRow } from "@wsp/protocol";
import { vaultSignIn, type AgentsOn, type AgentsRead, type AgentsReader } from "@wsp/runtime";
import { machineHost } from "./machine-host.js";

const READ_MS = 20_000;
/** How long one agent's own version or status command is given where the computer has a timeout command. */
const COMMAND_S = 15;

/** Where each agent's command answers on the login PATH, one line per agent; empty where it is not there. */
const WHERE = 'for b; do command -v "$b" 2>/dev/null || echo; done';
/** Each command run side by side under its own bound, then each one's exit code and output in the order asked. */
const EACH = [
  'd=$(mktemp -d) || exit 1',
  `T=; command -v timeout >/dev/null 2>&1 && T="timeout ${COMMAND_S}"`,
  "i=0",
  'for c; do ( $T sh -c "$c" > "$d/$i" 2>&1 < /dev/null; echo $? > "$d/$i.x" ) & i=$((i+1)); done',
  "wait",
  "i=0",
  "for c; do printf '\\036%s\\037' \"$(cat \"$d/$i.x\" 2>/dev/null)\"; head -c 16384 \"$d/$i\" 2>/dev/null; i=$((i+1)); done",
  'rm -rf "$d"',
  "printf '\\036END\\n'",
].join("\n");

interface Said {
  code: number;
  output: string;
}

/** Each command's exit code and output, run on the target side by side; nothing for any where the run failed. */
async function each(host: Host, commands: readonly string[]): Promise<(Said | undefined)[]> {
  if (commands.length === 0) return [];
  const out = await host.exec.run("sh", ["-c", EACH, "sh", ...commands], { timeoutMs: READ_MS + 5_000 });
  if (out === undefined) return commands.map(() => undefined);
  const records = out.split("\x1e").slice(1, commands.length + 1);
  return commands.map((_, i) => {
    const [code, ...rest] = (records[i] ?? "").split("\x1f");
    return code === undefined || code === "" || !/^\d+$/.test(code) ? undefined : { code: Number(code), output: rest.join("\x1f") };
  });
}

/** The shown form of how a server is reached: its command with every value hidden, or its url's host. */
function transportOf(server: McpServer, home: string): McpRow["transport"] {
  const t = server.transport;
  if (t.kind === "stdio") return { kind: "stdio", line: stdioLine(t, home) };
  try {
    return { kind: "http", host: new URL(t.url).host };
  } catch {
    return { kind: "http", host: "" };
  }
}

/** A server's sign-in off its config alone: a command or a static header needs none, anything else is unknown
 * until something connects to it, which a list never does. */
const authOf = (server: McpServer): McpRow["auth"] => (server.transport.kind === "stdio" || Object.keys(server.transport.headers).length > 0 ? "open" : "unknown");

/** Names the definition sets or reads, never a value. */
const envNamesOf = (server: McpServer): string[] => [...new Set([...(server.transport.kind === "stdio" ? Object.keys(server.transport.env) : []), ...server.envRefs])].sort();

interface Servers {
  rows: McpRow[];
  wsp: Set<string>;
}

/** Every server each agent's own file defines, and its project's where a workspace is read; the first of an agent's
 * files that is there is its config, as the agent itself reads it. */
async function serversOf(host: Host, project: string | undefined): Promise<Servers> {
  const rows: McpRow[] = [];
  const wsp = new Set<string>();
  const firstOf = async (files: readonly string[]): Promise<{ file: string; text: string } | undefined> => {
    const texts = await Promise.all(files.map(f => host.fs.readText(f)));
    const at = texts.findIndex(t => t !== undefined);
    return at < 0 ? undefined : { file: files[at]!, text: texts[at]! };
  };
  const push = (agent: McpAgent, file: string, servers: readonly McpServer[], project: boolean): void => {
    for (const s of servers) {
      if (!project && s.name === MCP_SERVER_NAME) wsp.add(agent.id);
      rows.push({
        agent: agent.id,
        name: s.name,
        scope: project ? "project" : s.scope,
        file: tilde(host.home, file),
        transport: transportOf(s, host.home),
        envNames: envNamesOf(s),
        auth: authOf(s),
        enabled: s.disabled !== true,
      });
    }
  };
  await Promise.all(
    MCP_AGENTS.map(async agent => {
      const [own, theirs] = await Promise.all([
        firstOf(agent.mcp.files.map(f => expand(host, f))),
        project === undefined ? undefined : firstOf((agent.mcp.projectFiles ?? []).map(f => posix.join(project, f))),
      ]);
      if (own !== undefined) push(agent, own.file, agent.mcp.format.read(own.text, host.home), false);
      if (theirs !== undefined) push(agent, theirs.file, agent.mcp.format.read(theirs.text, host.home).filter(s => s.scope === "user"), true);
    }),
  );
  const order = new Map(MCP_AGENTS.map((a, i) => [a.id, i]));
  return { rows: rows.sort((a, b) => order.get(a.agent)! - order.get(b.agent)! || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name)), wsp };
}

/** What wsp's recipe job put into the agents' files on a computer you own, off the list it keeps beside the job;
 * nothing where the list could not be read, which leaves every row's answer unsaid rather than no. */
async function recipeServers(host: Host): Promise<Set<string> | undefined> {
  const said = await host.exec.run("bash", ["-c", landedServersScript(host.home)], { timeoutMs: READ_MS });
  return said === undefined ? undefined : new Set([...parseLandedServers(said)].filter(([, digest]) => digest !== NO_DIGEST).map(([id]) => id));
}

/** What a box's own report already says, which is read there once per dial and not asked again. */
interface BoxSaid {
  signIns?: Record<string, AgentSignInState>;
  versions?: Record<string, string>;
}

/** The report off one Host. `box` carries what a computer you joined reported, which stands in for the version
 * and sign-in reads; everywhere else each agent's own version flag and status command answer, run side by side. */
export async function readAgents(host: Host, o: { user: string; vault: Readonly<Record<string, string>>; project?: string; box?: BoxSaid }): Promise<AgentsRead> {
  const refused: string[] = [];
  const agents: readonly AgentEntry[] = CATALOG_AGENTS;
  const [where, servers, skills, recipe] = await Promise.all([
    host.exec.run("sh", ["-c", WHERE, "sh", ...agents.map(a => a.bin)], { timeoutMs: READ_MS }),
    serversOf(host, o.project),
    skillRoots(host, o.project !== undefined ? { project: o.project } : {}).then(roots => detectSkills(host, roots)),
    o.box !== undefined ? recipeServers(host) : Promise.resolve(undefined),
  ]);
  if (where === undefined) refused.push("agents: the login PATH could not be read");
  if (o.box !== undefined && recipe === undefined) refused.push("servers: the list of what wsp's recipe put there could not be read");
  const paths = (where ?? "").split("\n");
  const at = new Map(agents.map((a, i) => [a.id, paths[i]?.trim() ?? ""]));
  const installed = agents.filter(a => at.get(a.id) !== "");
  const box = o.box;
  const [versions, statuses] = await Promise.all([
    box?.versions !== undefined ? Promise.resolve(installed.map(a => box.versions?.[a.id])) : each(host, installed.map(a => `${shellQuote(a.bin)} --version`)).then(r => r.map(s => s?.output.split("\n")[0])),
    box !== undefined ? Promise.resolve([]) : each(host, installed.map(a => a.signIn.status?.typed ?? a.signIn.status?.command ?? "false")),
  ]);
  const rows: AgentRow[] = agents.map(a => {
    const path = at.get(a.id) ?? "";
    const i = installed.indexOf(a);
    const said = i < 0 ? undefined : versions[i];
    const version = said === undefined || said.trim() === "" ? undefined : agentVersionWord(said);
    const status = i < 0 ? undefined : statuses[i];
    const signIn: AgentRow["signIn"] =
      box !== undefined
        ? (box.signIns?.[a.id] ?? "unknown")
        : status === undefined
          ? "unknown"
          : a.signIn.status !== undefined && a.signIn.status.signedIn(status.output, status.code)
            ? "signed-in"
            : vaultSignIn(a.id, o.vault);
    return {
      id: a.id,
      name: a.name,
      installed: path !== "",
      ...(version !== undefined ? { version } : {}),
      road: path === "" ? "none" : path.startsWith(`${TOOL_PREFIX}/`) ? "wsp" : "own",
      ...(path !== "" ? { path: tilde(host.home, path) } : {}),
      signIn: path === "" ? "none" : signIn,
      signInRoad: signInRoadOf(a.signIn),
      wspTools: servers.wsp.has(a.id),
    };
  });
  const serverRows = recipe === undefined ? servers.rows : servers.rows.map(r => (r.scope === "project" ? r : { ...r, inRecipe: recipe.has(mcpRowId(r.agent, r.scope === "home", r.name)) }));
  return { home: host.home, user: o.user, agents: rows, skills: skills.skills, servers: serverRows, refused: [...refused, ...skills.refused] };
}

/** The reader the runtime is wired with: this computer's own Host for this computer and a workspace on it, and
 * machineHost for everything else, after one read of who its lines run as. */
export function agentsReader(o: { vault: () => Readonly<Record<string, string>>; here?: () => Host }): AgentsReader {
  return {
    read: async (on: AgentsOn) => {
      if (on.kind === "here") return readAgents(o.here?.() ?? nodeHost(), { user: userInfo().username, vault: o.vault(), ...(on.project !== undefined ? { project: on.project } : {}) });
      const login = await targetLogin(on.machine, on.kind === "box" ? on.login : {});
      const host = machineHost(on.machine, login);
      const box = on.kind === "box" ? { ...(on.signIns !== undefined ? { signIns: on.signIns } : {}), ...(on.versions !== undefined ? { versions: on.versions } : {}) } : undefined;
      const read = await readAgents(host, { user: login.user, vault: o.vault(), ...(on.kind === "machine" && on.project !== undefined ? { project: on.project } : {}), ...(box !== undefined ? { box } : {}) });
      return { ...read, refused: [...read.refused, ...host.refused] };
    },
  };
}
