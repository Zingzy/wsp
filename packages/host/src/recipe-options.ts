// SPDX-License-Identifier: AGPL-3.0-only
// What a recipe can pick from, read off this computer when the modal or a
// recipe opens: the agents it has and how each can sign in on a box, the MCP
// servers per agent, the CLIs by manager, the skills, the plugins and the
// configs. A Mac-only thing is never offered: a cask is no row at all, a
// formula with no Linux build and a server bound to a macOS path are left out.
import { posix } from "node:path";
import { CATALOG_AGENTS, COMPILER_ROW, catalogEntry, catalogIdOfRow, hasLogin, keyEnvOf, mintsToken } from "@wsp/catalog";
import { collect, detectSkills, expand, skillRoots, type Host, type Manifest } from "@wsp/collect";
import { agentOfRow, MCP_ID_PREFIX, packageOf, type RecipeOptions, type RecipeSignIn, type SkillRow } from "@wsp/protocol";
import { CONFIG_PATHS } from "./recipe-configs.js";

/** Managers whose installs build from source, so a row of theirs needs the C toolchain on the box. */
const COMPILING_MANAGERS = new Set(["cargo"]);

/** What a CLI row needs beyond its own road: the C toolchain for a manager that compiles, or a catalog row that
 * installs after it. */
function needsOf(id: string, manager: string): string[] | undefined {
  const catalogId = catalogIdOfRow({ id });
  const entry = catalogId === undefined ? undefined : catalogEntry(catalogId);
  const after = entry?.kind === "tool" ? entry.after : undefined;
  return COMPILING_MANAGERS.has(manager) || after === COMPILER_ROW ? [COMPILER_ROW] : undefined;
}

/** The sign-in words an agent can take on a box: the vault where its token or key can be held here, the machine
 * where it has a login to run there. */
function signinsOf(agentId: string): RecipeSignIn[] {
  const entry = CATALOG_AGENTS.find(a => a.id === agentId);
  if (entry === undefined) return [];
  const s = entry.signIn;
  return [...(mintsToken(s) || keyEnvOf(s) !== undefined ? (["vault"] as const) : []), ...(hasLogin(s) ? (["machine"] as const) : [])];
}

/** The plugins one Claude Code index lists as installed for the person, by `name@marketplace`. */
export function userPlugins(text: string | undefined): string[] {
  if (text === undefined) return [];
  try {
    const plugins = (JSON.parse(text) as { plugins?: Record<string, unknown> }).plugins ?? {};
    return Object.entries(plugins)
      .filter(([, installs]) => Array.isArray(installs) && installs.some(i => (i as { scope?: unknown }).scope === "user"))
      .map(([name]) => name)
      .sort();
  } catch {
    return [];
  }
}

/** The options off what was read: the manifest, the person's own skills, the plugins and which config rows this
 * computer has files for. */
export function recipeOptions(manifest: Manifest, o: { skills: readonly SkillRow[]; plugins: readonly string[]; configs: readonly ("git" | "shell")[]; github: boolean }): RecipeOptions {
  const agents = manifest.entries.flatMap(e => {
    const id = agentOfRow(e);
    const entry = id === undefined ? undefined : CATALOG_AGENTS.find(a => a.id === id);
    return entry === undefined ? [] : [{ id: entry.id, name: entry.name, signins: signinsOf(entry.id) }];
  });
  const servers = new Map<string, Set<string>>();
  for (const e of manifest.entries) {
    if (!e.id.startsWith(MCP_ID_PREFIX) || e.reason !== undefined) continue;
    const agent = e.id.slice(MCP_ID_PREFIX.length).split("/")[0];
    if (agent === undefined || !CATALOG_AGENTS.some(a => a.id === agent)) continue;
    (servers.get(e.label) ?? servers.set(e.label, new Set()).get(e.label)!).add(agent);
  }
  const clis = manifest.entries.flatMap(e => {
    const manager = e.id.split("/")[1];
    if (e.rung !== "tools" || manager === undefined || manager === "brew-tap" || e.linux === "no" || e.id.split("/").length < 3) return [];
    const needs = needsOf(e.id, manager);
    return [{ name: packageOf(e), via: manager, ...(e.version !== undefined ? { version: e.version } : {}), ...(needs !== undefined ? { needs } : {}) }];
  });
  const skills = o.skills.flatMap(s => {
    const at = s.paths[0];
    if (s.scope !== "user" || at === undefined) return [];
    return [{ name: s.name, from: posix.dirname(at.path), linked: at.linkTo !== undefined }];
  });
  return {
    agents,
    mcp: [...servers].map(([name, on]) => ({ name, agents: [...on].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    clis,
    skills,
    plugins: o.plugins.map(name => ({ name })),
    configs: [
      ...(o.configs.includes("git") ? [{ id: "git" as const, label: "git settings and identity" }] : []),
      ...(o.configs.includes("shell") ? [{ id: "shell" as const, label: "zsh or fish, the prompt, tmux and the rest of the shell's look" }] : []),
      ...(o.github ? [{ id: "github" as const, label: "the GitHub sign-in" }] : []),
    ],
  };
}

/** Reads this computer for the options: the collector's manifest, the person's own skills folders, Claude Code's
 * plugin index, and whether any file of each config row is here. */
export async function readRecipeOptions(host: Host): Promise<RecipeOptions> {
  const manifest = await collect(host);
  const read = await detectSkills(host, await skillRoots(host));
  const indexes = await Promise.all(CATALOG_AGENTS.flatMap(a => (a.pluginSkills === undefined ? [] : [host.fs.readText(expand(host, a.pluginSkills.index))])));
  const plugins = [...new Set(indexes.flatMap(userPlugins))].sort();
  const has = async (paths: readonly string[]): Promise<boolean> => (await Promise.all(paths.map(p => host.fs.stat(expand(host, `~/${p}`))))).some(s => s !== undefined);
  const configs = [...((await has(CONFIG_PATHS.git)) ? (["git"] as const) : []), ...((await has(CONFIG_PATHS.shell)) ? (["shell"] as const) : [])];
  return recipeOptions(manifest, { skills: read.skills, plugins, configs, github: manifest.entries.some(e => e.id === "logins/gh") });
}
