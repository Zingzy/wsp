// SPDX-License-Identifier: AGPL-3.0-only
// A project's own MCP servers, carried with its folder to a computer somebody
// owns once that folder is a project there. The servers are the ones a turn in
// the folder gets here that its checkout does not bring along (the scan's
// detectProjectMcp), each agent's carried where its turns in the project's
// folder there read them: Claude Code's under that folder in its own file,
// never into the checkout, with the folder's own switches, and Codex's into
// the folder's own file with the folder trusted. Every value they carry goes
// to the vault by name, as the recipe's own servers' values do, and none is
// written there.
import { BREW_PREFIX, LAUNCH_SERVER_ROADS, MAC_BIN_DIRS, MAC_BREW, MCP_AGENTS, ownServerConfig, serversByName, type FolderSwitches, type McpAgent } from "@wsp/catalog";
import { detectProjectMcp, expand, type Host, type ProjectServer } from "@wsp/collect";
import { withheld, type McpAgentPlan, type McpPlan, type McpScope, type ProvisionOn } from "@wsp/engine";
import { keysKeptLine, type RecipeFile } from "@wsp/protocol";
import type { ServerVault } from "./env-keys.js";
import { keyOwner } from "./providers.js";

/** The folder's switches the agent's own file here keeps under `key`, read off the first of its files that is there. */
async function switchesOf(here: Host, agent: McpAgent, key: string, of: (text: string, key: string) => FolderSwitches | undefined): Promise<FolderSwitches | undefined> {
  for (const file of ownServerConfig(agent, here.home, here.stores?.[agent.id]).files) {
    const text = await here.fs.readText(file);
    if (text !== undefined) return of(text, key);
  }
  return undefined;
}

/** Why a server stays here: its row says why, it runs against a path this computer does not have, or it waits on a yes
 * to copying its keys, which names them and where the yes is given as a recipe's own server's row does. */
const dropOf = (s: ProjectServer, recipe: string | undefined): McpScope["drop"][number] => {
  const name = s.turn.server.name;
  if (s.row.default !== "bring") return { name, reason: s.row.reason ?? "a path it runs against is not on this computer" };
  const keys = s.row.keys ?? [];
  return { name, reason: keysKeptLine(keys, recipe), keys };
};

/** The servers of one agent's scopes, one scope per file they are read from here, each a copy of that file holding
 * its kept servers alone, under the folder there. */
async function scopesOf(agent: McpAgent, servers: readonly ProjectServer[], at: { from: string; to: string; carried: { files: string[]; base: string; folder?: string }; recipe?: string }, refer: (text: string) => Promise<{ text: string; dropped: { name: string; reason: string }[] }>, read: (file: string) => Promise<string | undefined>): Promise<McpScope[]> {
  const format = agent.mcp.format;
  const out: McpScope[] = [];
  for (const file of [...new Set(servers.map(s => s.turn.file))]) {
    const mine = servers.filter(s => s.turn.file === file);
    const kept = mine.filter(s => s.row.default === "bring" && !withheld(s.row)).map(s => s.turn.server.name);
    const drop = mine.filter(s => !kept.includes(s.turn.server.name)).map(s => dropOf(s, at.recipe));
    const local = mine[0]!.turn.scope === "local";
    const text = kept.length === 0 ? undefined : await read(file);
    let named: { text: string; dropped: { name: string; reason: string }[] };
    try {
      named = text === undefined ? { text: "", dropped: kept.map(name => ({ name, reason: `${file} could not be read here` })) } : await refer(format.only(text, kept, local ? at.from : undefined, at.carried.folder === undefined ? undefined : at.from));
    } catch (e) {
      // A copy that cannot be written by name stays here whole, as a recipe's own config does.
      named = { text: "", dropped: kept.map(name => ({ name, reason: `its servers could not be written by name (${e instanceof Error ? e.message : String(e)})` })) };
    }
    out.push({
      files: at.carried.files,
      own: { files: at.carried.files, base: at.carried.base },
      format,
      ...(at.carried.folder !== undefined ? { project: { from: at.from, to: at.carried.folder } } : {}),
      keep: kept.filter(name => !named.dropped.some(d => d.name === name)),
      drop: [...drop, ...named.dropped],
      travelled: named.text,
      folder: at.to,
    });
  }
  return out;
}

/** The plan that carries the servers a turn in the picked folder gets here, and its checkout does not bring, into the
 * project it became at `path` on that computer; nothing where no picked agent's turns there read any. */
export async function projectServersPlan(o: { here: Host; picks: RecipeFile; folder: RecipeFile["folders"][string]; path: string; on: ProvisionOn & { recipe?: string }; vault: ServerVault }): Promise<McpPlan | undefined> {
  const folder = expand(o.here, o.folder.from);
  const agents = MCP_AGENTS.filter(a => o.picks.agents[a.id] !== undefined && LAUNCH_SERVER_ROADS[a.id] !== undefined);
  const found = await detectProjectMcp(o.here, folder, { agents, keep: o.folder.keep });
  // The agents key a folder's own servers and switches by its main checkout, which the project's folder there clones.
  const from = found.checkout.key;
  const top = found.checkout.top ?? folder;
  // Every value the copies carry moves to the vault by name, held across the agents as one copy's files are.
  const held = new Map<string, { value: string; by: string }>();
  const owners = o.vault.owners();
  const known = Object.fromEntries(Object.entries(o.vault.held()).map(([name, value]) => [name, { value, by: owners[name] ?? [] }]));
  const plans: McpAgentPlan[] = [];
  for (const agent of agents) {
    const road = LAUNCH_SERVER_ROADS[agent.id]!;
    const own = ownServerConfig(agent, o.on.home, o.on.stores?.[agent.id]);
    const carried = road.carry(o.path, own);
    // The picks' one yes to copying the ticked servers' keys answers a project's servers as it answers the recipe's own.
    const servers = found.servers.filter(s => s.agent.id === agent.id).map(s => (o.picks.copyKeys === true && s.row.consent === true ? { ...s, row: { ...s.row, choice: "copy" as const } } : s));
    const refer = (text: string) => serversByName(agent.mcp.format, text, held, keyOwner, known);
    const scopes = await scopesOf(agent, servers, { from, to: o.path, carried, ...(o.on.recipe !== undefined ? { recipe: o.on.recipe } : {}) }, refer, file => o.here.fs.readText(file));
    // A folder whose own file this agent reads only where it is trusted is trusted there too, its file carried or not.
    const trust: McpScope[] = carried.trust === true && found.read.includes(agent.id) ? [{ files: own.files, own, format: agent.mcp.format, keep: [], drop: [], travelled: "", trust: o.path }] : [];
    // The folder's own switches go with it, so a server off for it here is off for it there.
    const switches = road.switches === undefined ? undefined : await switchesOf(o.here, agent, from, road.switches.of);
    const put = road.switches?.put;
    const off: McpScope[] = switches === undefined || put === undefined ? [] : [{ files: own.files, own, format: agent.mcp.format, keep: [], drop: [], travelled: "", edit: text => put(text, o.path, switches) }];
    if (scopes.length + trust.length + off.length > 0) plans.push({ id: agent.id, label: agent.name, scopes: [...trust, ...scopes, ...off], aside: [] });
  }
  for (const server of new Set([...held.values()].map(at => at.by))) o.vault.hold(Object.fromEntries([...held].filter(([, at]) => at.by === server).map(([name, at]) => [name, at.value])), server);
  if (plans.length === 0) return undefined;
  return {
    agents: plans,
    guestHome: o.on.home,
    rewrites: [[`${top.replace(/\/+$/, "")}/`, `${o.path.replace(/\/+$/, "")}/`], [`${o.here.home}/`, `${o.on.home}/`], [`${MAC_BREW}/`, `${BREW_PREFIX}/`]],
    binDirs: [`${o.here.home}/.local/bin/`, "~/.local/bin/", ...MAC_BIN_DIRS],
    tools: [],
  };
}
