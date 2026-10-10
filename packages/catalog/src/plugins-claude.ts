// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code's plugins, read off the files under its config folder, never
// through `claude plugin list` (2.1.296 fetched every plugin from the network
// and wrote the cache) or `claude plugin details` (no JSON, and it said vercel
// brings no agents while a turn loaded three). What a plugin brings follows
// the manifest rules of code.claude.com/docs/en/plugins-reference, pinned by
// a turn recorded on 2.1.296. The switch is Claude Code's own command.
import { shellQuote, type PluginBrings, type PluginScope } from "@wsp/protocol";
import { NOTHING_BROUGHT, baseName, inStore, joinPath, isRecord, jsonOf, pluginIdParts, type FoundPlugin, type Peeked, type PluginIo, type PluginProject, type PluginShelf, type PluginsFound } from "./plugins.js";

const CLAUDE_HOME = { stateHome: ".claude" };
const INDEX = "~/.claude/plugins/installed_plugins.json";
const MARKETPLACES = "~/.claude/plugins/known_marketplaces.json";
const SETTINGS = "~/.claude/settings.json";
/** A project's shared settings, then the login's own for it, which wins. */
const PROJECT_SETTINGS = ".claude/settings.json";
const LOCAL_SETTINGS = ".claude/settings.local.json";

type Json = Record<string, unknown>;

/** One install record of installed_plugins.json, version 2. */
interface Install {
  scope: PluginScope;
  installPath: string;
  version?: string;
  projectPath?: string;
}

function installsOf(index: unknown): Map<string, Install[]> {
  const out = new Map<string, Install[]>();
  const plugins = isRecord(index) && isRecord(index.plugins) ? index.plugins : {};
  for (const [id, records] of Object.entries(plugins)) {
    if (!Array.isArray(records)) continue;
    for (const r of records) {
      if (!isRecord(r) || typeof r.installPath !== "string" || !r.installPath.startsWith("/")) continue;
      if (r.scope !== "user" && r.scope !== "project" && r.scope !== "local") continue;
      const install: Install = { scope: r.scope, installPath: r.installPath.replace(/\/+$/, ""), ...(typeof r.version === "string" ? { version: r.version } : {}), ...(typeof r.projectPath === "string" ? { projectPath: r.projectPath } : {}) };
      out.set(id, [...(out.get(id) ?? []), install]);
    }
  }
  return out;
}

/** What a settings file says of a plugin: on, off, or nothing. */
const switchIn = (settings: unknown, id: string): boolean | undefined => {
  const on = isRecord(settings) ? settings.enabledPlugins : undefined;
  return isRecord(on) && typeof on[id] === "boolean" ? on[id] : undefined;
};

/** Where a marketplace comes from, as known_marketplaces.json says: a GitHub repo, an address, or a folder. */
function sourceOf(known: unknown, marketplace: string): string | undefined {
  const at = isRecord(known) && isRecord(known[marketplace]) ? known[marketplace] : undefined;
  const source = isRecord(at?.source) ? at.source : undefined;
  if (source === undefined) return undefined;
  const value = source.source === "github" ? source.repo : source.source === "directory" ? source.path : source.url;
  return typeof value === "string" ? value : undefined;
}

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** A manifest path, which starts with `./` (or is `.` for skills), resolved in the plugin's folder; nothing for one
 * that would leave it, which Claude Code does not load. */
function inside(root: string, path: string): string | undefined {
  const at = joinPath(root, path);
  return at === root || at.startsWith(`${root}/`) ? at : undefined;
}

const stem = (file: string): string => baseName(file).replace(/\.md$/, "");
const markdown = (names: readonly string[]): string[] => names.filter(n => n.endsWith(".md")).sort();

/** The manifest Claude Code loads: plugin.json, with a marketplace entry's commands, agents and skills appended and its
 * hooks merged where the entry is not `strict: false`; the entry alone where the plugin has no plugin.json. */
function effective(manifest: Json | undefined, entry: Json | undefined): Json {
  if (manifest === undefined) return entry ?? {};
  if (entry === undefined || entry.strict === false) return manifest;
  const out: Json = { ...manifest };
  for (const key of ["commands", "agents", "skills"] as const) {
    if (entry[key] === undefined) continue;
    out[key] = isRecord(manifest[key]) || isRecord(entry[key]) ? { ...(isRecord(manifest[key]) ? manifest[key] : {}), ...(isRecord(entry[key]) ? entry[key] : {}) } : [...strings(manifest[key]), ...strings(entry[key])];
  }
  if (entry.hooks !== undefined) out.hooks = [...(Array.isArray(manifest.hooks) ? manifest.hooks : manifest.hooks === undefined ? [] : [manifest.hooks]), entry.hooks];
  return out;
}

/** What a plugin's folder holds where Claude Code looks by default: its manifest, its hooks, servers and language
 * servers files, and the folders of its skills, commands and agents. */
const FOLDER_FILES = [".claude-plugin/plugin.json", "hooks/hooks.json", ".mcp.json", ".lsp.json"];
const FOLDER_DIRS = [
  { path: ".", depth: 1 },
  { path: "skills", depth: 2 },
  { path: "commands", depth: 1 },
  { path: "agents", depth: 1 },
] as const;

/** A manifest's paths for one component, inside the plugin. */
const pathsOf = (root: string, field: unknown): string[] => strings(field).flatMap(p => inside(root, p) ?? []);

/** The `.json` files a hooks, servers or language servers field names, beside its inline maps. */
const jsonFiles = (root: string, field: unknown): string[] => (Array.isArray(field) ? field : [field]).flatMap(p => (typeof p === "string" && p.endsWith(".json") ? (inside(root, p) ?? []) : []));

/** What a manifest names outside the default places, which a second peek reads: skill and command folders, and the
 * `.json` files of its hooks and servers. */
function declared(root: string, m: Json): { dirs: { path: string; depth: 1 | 2 }[]; files: string[] } {
  const rel = (p: string): string => (p === root ? "." : p.slice(root.length + 1));
  return {
    dirs: [...pathsOf(root, m.skills).map(p => ({ path: rel(p), depth: 2 as const })), ...(isRecord(m.commands) ? [] : pathsOf(root, m.commands).filter(p => !p.endsWith(".md")).map(p => ({ path: rel(p), depth: 1 as const })))],
    files: [m.hooks, m.mcpServers, m.lspServers].flatMap(f => jsonFiles(root, f)).map(rel),
  };
}

/** Every key of the maps a field names, its default file first: inline maps, and `.json` files holding the map under
 * `wrap` or bare. */
function keysOf(root: string, field: unknown, file: string, wrap: string, seen: Peeked): string[] {
  const parts = Array.isArray(field) ? field : field === undefined ? [] : [field];
  const files = [joinPath(root, file), ...jsonFiles(root, field)].flatMap(f => {
    const json = jsonOf(seen.text(f));
    return isRecord(json) ? [isRecord(json[wrap]) ? json[wrap] : json] : [];
  });
  return [...new Set([...files, ...parts.filter(isRecord)].flatMap(m => Object.keys(m)))];
}

/** The skills a folder holds: itself where it holds a SKILL.md, else each folder in it that does. */
function skillsIn(dir: string, seen: Peeked): string[] {
  const names = seen.list(dir) ?? [];
  if (names.includes("SKILL.md")) return [baseName(dir)];
  return names.filter(n => !n.includes("/") && !n.startsWith(".") && names.includes(`${n}/SKILL.md`));
}

/** What one plugin's folder brings, each by the name a turn gives it, off what the peeks read. */
function broughtBy(root: string, prefix: string, m: Json, seen: Peeked): { brings: PluginBrings; skillDirs: string[] } {
  const named = (names: readonly string[]): string[] => [...new Set(names)].map(n => `${prefix}:${n}`);
  // Skills: the default folder, and every folder the manifest adds to it. Commands and agents: the manifest's own
  // list replaces the default folder.
  const skillDirs = [joinPath(root, "skills"), ...pathsOf(root, m.skills)];
  const skills = skillDirs.flatMap(d => skillsIn(d, seen));
  // A plugin with SKILL.md at its root and no skills of its own elsewhere is one skill, named after it.
  if (skills.length === 0 && m.skills === undefined && (seen.list(root) ?? []).includes("SKILL.md")) skills.push(prefix);
  const mdIn = (dir: string): string[] => markdown(seen.list(dir) ?? []).map(stem);
  const commands = isRecord(m.commands) ? Object.keys(m.commands) : m.commands === undefined ? mdIn(joinPath(root, "commands")) : pathsOf(root, m.commands).flatMap(p => (p.endsWith(".md") ? [stem(p)] : mdIn(p)));
  const subagents = isRecord(m.agents) ? Object.keys(m.agents) : m.agents === undefined ? mdIn(joinPath(root, "agents")) : pathsOf(root, m.agents).filter(p => p.endsWith(".md")).map(stem);
  return {
    brings: {
      skills: named(skills).sort(),
      commands: named(commands).sort(),
      subagents: named(subagents).sort(),
      hooks: keysOf(root, m.hooks, "hooks/hooks.json", "hooks", seen).sort(),
      servers: keysOf(root, m.mcpServers, ".mcp.json", "mcpServers", seen).map(s => `plugin:${prefix}:${s}`).sort(),
      lsp: keysOf(root, m.lspServers, ".lsp.json", "lspServers", seen).sort(),
      apps: [],
    },
    skillDirs: skillDirs.filter(d => skillsIn(d, seen).length > 0 && !(seen.list(d) ?? []).includes("SKILL.md")),
  };
}

/** Two peeks read as one: the second's answer where it has one. */
const both = (a: Peeked, b: Peeked | undefined): Peeked => (b === undefined ? a : { text: p => b.text(p) ?? a.text(p), list: d => b.list(d) ?? a.list(d), looked: r => b.looked(r) || a.looked(r) });

/** Where a marketplace's own folder is, as known_marketplaces.json says. */
function locationOf(known: unknown, marketplace: string): string | undefined {
  const at = isRecord(known) ? known[marketplace] : undefined;
  return isRecord(at) && typeof at.installLocation === "string" && at.installLocation.startsWith("/") ? at.installLocation : undefined;
}

/** One marketplace's plugin entries by name, off the marketplace.json in its folder. */
function entriesOf(known: unknown, marketplace: string, seen: Peeked): Map<string, Json> {
  const at = locationOf(known, marketplace);
  const json = at === undefined ? undefined : jsonOf(seen.text(joinPath(at, MARKETPLACE_FILE)));
  const plugins = isRecord(json) && Array.isArray(json.plugins) ? json.plugins : [];
  return new Map(plugins.flatMap(p => (isRecord(p) && typeof p.name === "string" ? [[p.name, p] as const] : [])));
}

const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";

export const CLAUDE_PLUGIN_SHELF: PluginShelf = {
  // One peek reads the config and every plugin's folder, its paths read off the index on the computer, so one reached
  // over a link answers in one round trip; a second only for a path the peek could not read off the file, or a
  // manifest that keeps a component outside its default place.
  async read(io: PluginIo, projects: readonly PluginProject[]): Promise<PluginsFound> {
    const path = (p: string): string => inStore(CLAUDE_HOME, p, io);
    const first = await io.peek([
      { roots: ["/"], files: [path(INDEX), path(MARKETPLACES), path(SETTINGS)] },
      { roots: projects.map(p => p.path), files: [PROJECT_SETTINGS, LOCAL_SETTINGS] },
      { rootsFrom: { file: path(INDEX), key: "installPath" }, files: FOLDER_FILES, dirs: FOLDER_DIRS },
      { rootsFrom: { file: path(MARKETPLACES), key: "installLocation" }, files: [MARKETPLACE_FILE] },
    ]);
    if (first === undefined) return { plugins: [], refused: ["plugins: Claude Code's plugin files could not be read"] };
    const indexText = first.text(path(INDEX));
    if (indexText === undefined) return { plugins: [], refused: [] };
    const index = jsonOf(indexText);
    if (index === undefined) return { plugins: [], refused: [`plugins: ${path(INDEX)} does not parse, so Claude Code's plugins were not read`] };
    const known = jsonOf(first.text(path(MARKETPLACES)));
    const user = jsonOf(first.text(path(SETTINGS)));
    const settingsOf = (p: PluginProject) => ({ shared: jsonOf(first.text(joinPath(p.path, PROJECT_SETTINGS))), local: jsonOf(first.text(joinPath(p.path, LOCAL_SETTINGS))) });
    // A project or local install is a row only in a project the read covers; one for a folder gone is dropped.
    const rows: { id: string; install: Install; project?: PluginProject }[] = [];
    for (const [id, installs] of installsOf(index)) {
      const mine = installs.find(i => i.scope === "user");
      if (mine !== undefined) rows.push({ id, install: mine });
      for (const scope of ["project", "local"] as const) {
        for (const p of projects) {
          const install = installs.find(i => i.scope === scope && i.projectPath === p.path);
          if (install !== undefined) rows.push({ id, install, project: p });
        }
      }
    }
    const unread = [...new Set(rows.map(r => r.install.installPath))].filter(r => !first.looked(r));
    const unknown = [...new Set(rows.flatMap(r => locationOf(known, pluginIdParts(r.id).marketplace) ?? []))].filter(r => !first.looked(r));
    const folders = unread.length + unknown.length === 0 ? first : both(first, await io.peek([{ roots: unread, files: FOLDER_FILES, dirs: FOLDER_DIRS }, { roots: unknown, files: [MARKETPLACE_FILE] }]));
    const entries = new Map<string, Map<string, Json>>();
    const manifests = rows.map(({ id, install }) => {
      const { name, marketplace } = pluginIdParts(id);
      if (!entries.has(marketplace)) entries.set(marketplace, entriesOf(known, marketplace, folders));
      const entry = entries.get(marketplace)!.get(name);
      const there = folders.list(install.installPath) !== undefined;
      const manifest = there ? jsonOf(folders.text(joinPath(install.installPath, FOLDER_FILES[0]!))) : undefined;
      return { entry, there, m: effective(isRecord(manifest) ? manifest : undefined, entry) };
    });
    const extra = rows.flatMap(({ install }, i) => {
      const d = manifests[i]!.there ? declared(install.installPath, manifests[i]!.m) : { dirs: [], files: [] };
      return d.dirs.length === 0 && d.files.length === 0 ? [] : [{ roots: [install.installPath], files: d.files, dirs: d.dirs }];
    });
    const seen = both(folders, extra.length === 0 ? undefined : await io.peek(extra));
    const plugins = rows.map(({ id, install, project }, i): FoundPlugin => {
      const { name, marketplace } = pluginIdParts(id);
      const { entry, there, m } = manifests[i]!;
      const prefix = typeof m.name === "string" && m.name !== "" ? m.name : name;
      const fallback = typeof entry?.defaultEnabled === "boolean" ? entry.defaultEnabled : typeof m.defaultEnabled === "boolean" ? m.defaultEnabled : true;
      const set = project === undefined ? undefined : settingsOf(project);
      const local = set === undefined ? undefined : switchIn(set.local, id);
      const shared = set === undefined ? undefined : switchIn(set.shared, id);
      // The order Claude Code merges in, measured on 2.1.296: local over project over user, then the plugin's default.
      const on = local ?? shared ?? switchIn(user, id) ?? fallback;
      const read = there ? broughtBy(install.installPath, prefix, m, seen) : undefined;
      const description = typeof m.description === "string" ? m.description : typeof entry?.description === "string" ? entry.description : undefined;
      const source = sourceOf(known, marketplace);
      const setIn = project === undefined ? undefined : joinPath(project.path, local !== undefined || (shared === undefined && install.scope === "local") ? LOCAL_SETTINGS : PROJECT_SETTINGS);
      return {
        id,
        name,
        marketplace,
        ...(install.version !== undefined ? { version: install.version } : {}),
        scope: install.scope,
        ...(project !== undefined ? { project } : {}),
        on,
        ...(there ? {} : { missing: "folder" as const }),
        path: install.installPath,
        ...(setIn !== undefined ? { setIn } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(source !== undefined ? { source } : {}),
        brings: read?.brings ?? NOTHING_BROUGHT,
        ...(read !== undefined && read.skillDirs.length > 0 ? { skills: { dirs: read.skillDirs, prefix } } : {}),
      };
    });
    return { plugins, refused: [] };
  },
  async turn(io, plugin, on) {
    const verb = on ? "enable" : "disable";
    const said = await io.run(`claude plugin ${verb} ${shellQuote(plugin.id)} --scope user --json </dev/null 2>/dev/null; printf '\\n\\036%s\\n' "$?"`);
    if (said === undefined) return { refused: `claude plugin ${verb} did not run there, so nothing was switched.` };
    const answer = said
      .split("\n")
      .map(line => jsonOf(line.trim()))
      .find(isRecord);
    // Switching a plugin to where it stands already exits 1 with this code; it stands as asked, so that is done.
    if (answer?.outcome === "ok" || answer?.failureCode === "already_in_goal_state") return {};
    const message = typeof answer?.message === "string" ? answer.message : `claude plugin ${verb} exited ${/\x1e(\d+)/.exec(said)?.[1] ?? "with no answer"}`;
    return { refused: `${message.replace(/\.$/, "")}, so nothing was switched.` };
  },
};
