// SPDX-License-Identifier: AGPL-3.0-only
// One MCP server in an agent's own config on one computer or workspace: added,
// removed, or turned off and on, by the agent's format module over the text
// read off the target, then written back as that computer's login. A file
// keeps its mode, a new one is the login's alone, a file that is a link out of
// the folder it belongs to is never written through, and a file the agent
// wrote between the read and the write is left as the agent left it. The
// values a person typed go into that file and are never said anywhere else.
import { posix } from "node:path";
import { MCP_AGENTS, agentName, catalogEntry, type McpAgent, type McpTransport } from "@wsp/catalog";
import { expand, nodeHost, tilde, type Host } from "@wsp/collect";
import type { ExecResult } from "@wsp/engine";
import {
  configChangedRefusal,
  configLinkRefusal,
  hasControlChar,
  noServerSwitchRefusal,
  noServersConfigRefusal,
  noSuchServerRefusal,
  serverNameRefusal,
  serverThereRefusal,
  shellQuote,
  type McpScope,
  type ServerAdd,
  type ServerAsk,
} from "@wsp/protocol";
import type { AgentsOn, ServersActs } from "@wsp/runtime";
import { firstLine, roadOf, type Road } from "./target-road.js";

/** The exit a line takes, with the file and where it points on stdout, when the file is a link out of its folder. */
const LINK_EXIT = 4;
/** The exit a write takes when the file is not what was read. */
const CHANGED_EXIT = 5;

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The server a person typed, as the format modules place it; refused in a sentence that never repeats a value. */
export function serverTransport(ask: Omit<ServerAdd, "agent" | "name" | "project">): McpTransport {
  const command = ask.command?.trim() ?? "";
  const url = ask.url?.trim() ?? "";
  const env = ask.env ?? {};
  const headers = ask.headers ?? {};
  if (command !== "" && url !== "") throw usage("A server is a command or an address, not both.");
  if (command === "" && url === "") throw usage("A server needs a command to run or an address to reach.");
  if (command !== "") {
    if (Object.keys(headers).length > 0) throw usage("Headers go with an address; a command takes variables.");
    if (hasControlChar(command) || (ask.args ?? []).some(hasControlChar)) throw usage("The command holds a control character, so nothing was written.");
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME.test(name)) throw usage(`${name} is not a variable name.`);
      if (hasControlChar(value)) throw usage(`The value of ${name} holds a control character, so nothing was written.`);
    }
    return { kind: "stdio", command, args: [...(ask.args ?? [])], env: { ...env } };
  }
  if (Object.keys(env).length > 0) throw usage("Variables go with a command; an address takes headers.");
  let parsed: URL | undefined;
  try {
    parsed = hasControlChar(url) ? undefined : new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) throw usage("The address is not one that starts with https:// or http://.");
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw usage(`${name} is not a header name.`);
    if (hasControlChar(value)) throw usage(`The value of the ${name} header holds a control character, so nothing was written.`);
  }
  return { kind: "http", url, headers: { ...headers } };
}

const checkName = (name: string): void => {
  if (name.trim() === "" || hasControlChar(name)) throw usage(serverNameRefusal);
};

/** The agent's MCP config the act is for, by the scope: the files it reads in the home (the first that is there is the
 * config), or the project's, and the folder the file must stay inside. `folder` names Claude Code's servers kept for
 * the home folder itself inside its user file. */
interface Config {
  agent: McpAgent;
  files: string[];
  base: string;
  folder?: string;
}

function configOf(road: Road, on: AgentsOn, agentId: string, scope: McpScope): Config {
  const agent = MCP_AGENTS.find(a => a.id === agentId);
  if (agent === undefined) throw usage(catalogEntry(agentId) === undefined ? `The catalog has no agent ${agentId}.` : noServersConfigRefusal(agentName(agentId)));
  const home = road.host.home;
  if (scope !== "project") return { agent, files: agent.mcp.files.map(f => expand(road.host, f)), base: home, ...(scope === "home" ? { folder: home } : {}) };
  const project = on.kind === "box" ? undefined : on.project;
  if (project === undefined) throw usage("A project's server is changed from a workspace, which names the project.");
  const files = (agent.mcp.projectFiles ?? []).map(f => posix.join(project, f));
  if (files.length === 0) throw usage(noServersConfigRefusal(agentName(agentId)));
  return { agent, files, base: project };
}

/** A shell check that the real path `$r` stands inside the base's real path `$b`, else says the path and exits. */
const inside = (said: string): string => `case $r/ in "$b"/*) ;; *) printf '%s\\t%s\\n' ${said} "$r"; exit ${LINK_EXIT};; esac`;

/** The config as it stands: the file it is, its text and the checksum a write compares, or no file yet. */
interface Read {
  file: string;
  text?: string;
  sum?: string;
}

async function readConfig(road: Road, config: Config): Promise<Read> {
  const q = shellQuote;
  const line = [
    `b=$(realpath ${q(config.base)}) || exit 1`,
    `for f in ${config.files.map(q).join(" ")}; do`,
    '  if [ -e "$f" ] || [ -L "$f" ]; then',
    `    r=$(realpath "$f" 2>/dev/null) || { printf '%s\\t%s\\n' "$f" "$(readlink "$f")"; exit ${LINK_EXIT}; }`,
    `    ${inside('"$f"')}`,
    '    [ -f "$r" ] || exit 1',
    `    printf 'at\\t%s\\t%s\\t%s\\n' "$f" "$(wc -c < "$r" | tr -d ' ')" "$(cksum < "$r")"`,
    '    cat "$r"',
    "    exit 0",
    "  fi",
    "done",
    "echo none",
  ].join("\n");
  const res = await road.run(line);
  linkRefused(res, road.host);
  const cut = res.stdout.indexOf("\n");
  const head = cut < 0 ? res.stdout : res.stdout.slice(0, cut);
  if (res.exitCode !== 0) throw new Error(`${tilde(road.host.home, config.files[0]!)} could not be read: ${firstLine(res)}`);
  if (head === "none") return { file: config.files[0]! };
  const [at, file = "", size = "", sum = ""] = head.split("\t");
  const text = res.stdout.slice(cut + 1);
  if (at !== "at" || Buffer.byteLength(text) !== Number(size)) throw new Error(`${tilde(road.host.home, file)} came back cut short, so it was not changed.`);
  return { file, text, sum };
}

function linkRefused(res: ExecResult, host: Host): void {
  if (res.exitCode !== LINK_EXIT) return;
  const [file = "", to = ""] = res.stdout.trim().split("\n")[0]!.split("\t");
  throw usage(configLinkRefusal(tilde(host.home, file), tilde(host.home, to)));
}

/** Writes the text over what was read, as the login: an existing file in place, so it keeps its mode and owner; a new
 * one made 0600 with its folder. Nothing is written when the file is no longer what was read, or when its folder
 * reaches out of the base through a link. */
async function writeConfig(road: Road, config: Config, read: Read, text: string): Promise<void> {
  const q = shellQuote;
  const bytes = new TextEncoder().encode(text);
  const line = [
    "umask 077",
    `b=$(realpath ${q(config.base)}) || exit 1`,
    't=$(mktemp) || exit 1',
    "trap 'rm -f -- \"$t\"' EXIT",
    'cat > "$t"',
    `[ "$(wc -c < "$t" | tr -d ' ')" = ${bytes.length} ] || exit 1`,
    `f=${q(read.file)}`,
    'if [ -e "$f" ] || [ -L "$f" ]; then',
    `  ${read.sum === undefined ? `exit ${CHANGED_EXIT}` : ":"}`,
    `  r=$(realpath "$f" 2>/dev/null) || exit ${LINK_EXIT}`,
    `  ${inside('"$f"')}`,
    `  [ "$(cksum < "$r")" = ${q(read.sum ?? "")} ] || exit ${CHANGED_EXIT}`,
    '  cat "$t" > "$r" || exit 1',
    "else",
    `  ${read.sum === undefined ? ":" : `exit ${CHANGED_EXIT}`}`,
    '  d=${f%/*}; a=$d',
    '  while [ -n "$a" ] && [ ! -e "$a" ]; do a=${a%/*}; done',
    '  r=$(realpath "${a:-/}") || exit 1',
    `  ${inside('"$a"')}`,
    '  mkdir -p "$d" && cat "$t" > "$f" || exit 1',
    "fi",
  ].join("\n");
  const res = await road.run(line, bytes);
  const shown = tilde(road.host.home, read.file);
  linkRefused(res, road.host);
  if (res.exitCode === CHANGED_EXIT) throw usage(configChangedRefusal(shown));
  if (res.exitCode !== 0) throw new Error(`${shown} was not written: ${firstLine(res)}`);
}

/** The format's own words for text it could not take, named by the file. */
function formatted<T>(file: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    throw usage(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Whether the text defines the server in that scope: a project's file holds its servers at its root. */
const defines = (config: Config, text: string, home: string, ask: ServerAsk): { disabled: boolean } | undefined => {
  const want = ask.scope === "home" ? "home" : "user";
  const found = config.agent.mcp.format.read(text, home).find(s => s.name === ask.name && s.scope === want);
  return found === undefined ? undefined : { disabled: found.disabled === true };
};

export interface ServersActsOptions {
  /** This computer's Host; the node one, over this login's home, unless a test names another. */
  here?: () => Host;
}

export function serversActs(o: ServersActsOptions = {}): ServersActs {
  const here = o.here ?? nodeHost;
  /** The server's file read, the change made to its text, and the text written back. */
  const change = async (on: AgentsOn, ask: ServerAsk, edit: (config: Config, text: string, shown: string, standing: { disabled: boolean }) => string): Promise<{ file: string }> => {
    checkName(ask.name);
    const road = await roadOf(on, here, "the server");
    const config = configOf(road, on, ask.agent, ask.scope ?? "user");
    const read = await readConfig(road, config);
    const shown = tilde(road.host.home, read.file);
    const standing = read.text === undefined ? undefined : defines(config, read.text, road.host.home, ask);
    if (read.text === undefined || standing === undefined) throw usage(noSuchServerRefusal(ask.name, shown));
    const next = edit(config, read.text, shown, standing);
    await writeConfig(road, config, read, next);
    return { file: shown };
  };
  return {
    add: async (on, ask) => {
      checkName(ask.name);
      const transport = serverTransport(ask);
      const road = await roadOf(on, here, "the server");
      const config = configOf(road, on, ask.agent, ask.project === true ? "project" : "user");
      const read = await readConfig(road, config);
      const shown = tilde(road.host.home, read.file);
      if (read.text !== undefined && defines(config, read.text, road.host.home, { agent: ask.agent, name: ask.name }) !== undefined) throw usage(serverThereRefusal(ask.name, shown));
      const placed = formatted(shown, () => config.agent.mcp.format.place(read.text, ask.name, transport));
      await writeConfig(road, config, read, placed.text);
      return { file: shown };
    },
    remove: (on, ask) => change(on, ask, (config, text, shown) => formatted(shown, () => config.agent.mcp.format.remove(text, [ask.name], config.folder)).text),
    toggle: (on, ask) =>
      change(on, ask, (config, text, shown, standing) => {
        const enable = config.agent.mcp.format.enable;
        if (enable === undefined) throw usage(noServerSwitchRefusal(agentName(config.agent.id)));
        if (standing.disabled === !ask.on) throw usage(`${ask.name} is already ${ask.on ? "on" : "off"}.`);
        return formatted(shown, () => enable(text, ask.name, ask.on, config.folder)).text;
      }),
  };
}
