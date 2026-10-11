// SPDX-License-Identifier: AGPL-3.0-only
// Codex's plugins, asked of `codex app-server` under the store's CODEX_HOME:
// plugin/list for the rows, config/read for what config.toml names and the
// version a write is checked against, plugin/read for what each brings. On
// 0.162.1 the three answered in about 150 ms, wrote no config and touched no
// plugin folder. Codex has no enable command; the switch is the app server's
// config/value/write on plugins.<id>.enabled, which changed exactly one line.
import { configChangedRefusal } from "@wsp/protocol";
import { answersOf, appServerScript, initializeRequest, request, resultOf, type ServerAnswer } from "./codex-app-server.js";
import { NOTHING_BROUGHT, isRecord, joinPath, pluginIdParts, type FoundPlugin, type PluginIo, type PluginShelf, type PluginsFound } from "./plugins.js";

type Json = Record<string, unknown>;

/** Printed in place of the answers where no codex answers on the login's PATH: no plugins, and nothing to refuse. */
const NO_CODEX = "__WSP_NO_CODEX__";

const INIT = 1;
const LIST = 2;
const CONFIG = 3;

/** The requests as one script on the computer, or nothing said where codex is not there. */
const ask = (io: PluginIo, lines: readonly string[]): Promise<string | undefined> =>
  io.run(`command -v codex >/dev/null 2>&1 || { echo ${NO_CODEX}; exit 0; }\ncd ~ || exit 1\n${appServerScript("codex", [{ lines, answers: lines.length }])}`);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const names = (v: unknown, key: string): string[] => (Array.isArray(v) ? [...new Set(v.flatMap(x => (isRecord(x) && typeof x[key] === "string" ? [x[key]] : [])))].sort() : []);

/** What one plugin/read answer says the plugin brings: its skills by the names Codex announces, the events its hooks
 * run on, its tool servers and its apps. Codex reports no commands, subagents or language servers. */
function broughtBy(read: Json | undefined): FoundPlugin["brings"] {
  const plugin = isRecord(read?.plugin) ? read.plugin : undefined;
  if (plugin === undefined) return NOTHING_BROUGHT;
  return {
    ...NOTHING_BROUGHT,
    skills: names(plugin.skills, "name"),
    hooks: names(plugin.hooks, "eventName"),
    servers: Array.isArray(plugin.mcpServers) ? plugin.mcpServers.filter((s): s is string => typeof s === "string").sort() : [],
    apps: names(plugin.apps, "name"),
  };
}

const sourceOf = (s: unknown): string | undefined => (isRecord(s) ? (str(s.url) ?? str(s.path) ?? str(s.package)) : undefined);

/** The user layer of a config/read with its layers: its file and the version a write names. */
function userLayer(config: Json | undefined): { file?: string; version?: string } {
  const layers = Array.isArray(config?.layers) ? config.layers : [];
  const user = layers.find(l => isRecord(l) && isRecord(l.name) && l.name.type === "user");
  if (!isRecord(user) || !isRecord(user.name)) return {};
  const file = str(user.name.file);
  const version = str(user.version);
  return { ...(file !== undefined ? { file } : {}), ...(version !== undefined ? { version } : {}) };
}

const errorOf = (answer: ServerAnswer | undefined): Json | undefined => (answer !== undefined && "error" in answer ? (answer.error as Json) : undefined);

export const CODEX_PLUGIN_SHELF: PluginShelf = {
  async read(io: PluginIo): Promise<PluginsFound> {
    const said = await ask(io, [initializeRequest(INIT), request(LIST, "plugin/list"), request(CONFIG, "config/read", { includeLayers: true })]);
    if (said?.includes(NO_CODEX) === true) return { plugins: [], refused: [] };
    const answers = answersOf(said ?? "");
    const home = str(resultOf(answers, INIT)?.codexHome);
    const list = resultOf(answers, LIST);
    const config = resultOf(answers, CONFIG);
    // A Codex with no plugins answers plugin/list as a method it does not know, as 0.162.1 answers any such: none to read.
    if (/unknown variant `plugin\/list`/.test(errorOf(answers.get(LIST))?.message as string | undefined ?? "")) return { plugins: [], refused: [] };
    if (list === undefined || config === undefined) return { plugins: [], refused: ["plugins: Codex's app server did not answer, so Codex's plugins were not read"] };
    const marketplaces = Array.isArray(list.marketplaces) ? list.marketplaces.filter(isRecord) : [];
    const installed = marketplaces.flatMap(mk => (Array.isArray(mk.plugins) ? mk.plugins.filter(isRecord) : []).filter(p => p.installed === true && typeof p.id === "string").map(p => ({ mk, p })));
    // What each brings, in one more run, since plugin/read takes the marketplace file plugin/list names.
    const reads = installed.length === 0 ? undefined : answersOf((await ask(io, [initializeRequest(INIT), ...installed.map(({ mk, p }, i) => request(LIST + i, "plugin/read", { pluginName: p.name, ...(typeof mk.path === "string" ? { marketplacePath: mk.path } : {}) }))])) ?? "");
    const plugins: FoundPlugin[] = installed.map(({ mk, p }, i) => {
      const id = p.id as string;
      const { name, marketplace } = pluginIdParts(id);
      const face = isRecord(p.interface) ? p.interface : undefined;
      const read = reads === undefined ? undefined : resultOf(reads, LIST + i);
      const version = str(p.localVersion);
      const description = str(isRecord(read?.plugin) ? read.plugin.description : undefined) ?? str(face?.shortDescription);
      const source = sourceOf(p.source);
      return {
        id,
        name: str(p.name) ?? name,
        marketplace: str(mk.name) ?? marketplace,
        ...(version !== undefined ? { version } : {}),
        scope: "user",
        on: p.enabled === true,
        // Where `codex plugin add` put it on 0.162.1, which plugin/list does not say.
        ...(home !== undefined && version !== undefined ? { path: joinPath(home, "plugins", "cache", marketplace, name, version) } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(source !== undefined ? { source } : {}),
        brings: broughtBy(read),
      };
    });
    // A plugin config.toml names that plugin/list does not return loads nowhere, and Codex says nothing of it.
    const conf = isRecord(config.config) ? config.config : {};
    const named = isRecord(conf.plugins) ? conf.plugins : {};
    const known = isRecord(conf.marketplaces) ? conf.marketplaces : {};
    const listed = new Set(marketplaces.flatMap(mk => (Array.isArray(mk.plugins) ? mk.plugins.flatMap(p => (isRecord(p) && typeof p.id === "string" ? [p.id] : [])) : [])));
    const absent = Object.keys(named).filter(id => !listed.has(id)).sort();
    const localOf = (id: string): string | undefined => {
      const at = known[pluginIdParts(id).marketplace];
      return isRecord(at) && at.source_type === "local" && typeof at.source === "string" && at.source.startsWith("/") ? at.source : undefined;
    };
    const sources = [...new Set(absent.flatMap(id => localOf(id) ?? []))];
    const seen = sources.length === 0 ? undefined : await io.peek([{ roots: sources, dirs: [{ path: ".", depth: 1 }] }]);
    absent.forEach(id => {
      const { name, marketplace } = pluginIdParts(id);
      const setting = named[id];
      const source = localOf(id);
      const folder = source === undefined ? undefined : { source, there: seen?.list(source) !== undefined };
      plugins.push({
        id,
        name,
        marketplace,
        scope: "user",
        on: isRecord(setting) && setting.enabled === true,
        missing: folder !== undefined && !folder.there ? "marketplace" : "unlisted",
        ...(folder !== undefined ? { source: folder.source } : {}),
        brings: NOTHING_BROUGHT,
      });
    });
    // One config.toml names that plugin/list has in a marketplace and not installed loads nowhere either.
    for (const mk of marketplaces) {
      for (const p of Array.isArray(mk.plugins) ? mk.plugins.filter(isRecord) : []) {
        if (p.installed === true || typeof p.id !== "string" || !(p.id in named)) continue;
        const { name, marketplace } = pluginIdParts(p.id);
        const setting = named[p.id];
        const source = sourceOf(p.source);
        plugins.push({ id: p.id, name: str(p.name) ?? name, marketplace: str(mk.name) ?? marketplace, scope: "user", on: isRecord(setting) && setting.enabled === true, missing: "uninstalled", ...(source !== undefined ? { source } : {}), brings: NOTHING_BROUGHT });
      }
    }
    const refused = (Array.isArray(list.marketplaceLoadErrors) ? list.marketplaceLoadErrors : []).flatMap(e => (isRecord(e) && typeof e.message === "string" ? [`plugins: Codex could not load a marketplace: ${e.message}`] : []));
    return { plugins, refused, ...userLayer(config) };
  },
  async turn(io, plugin, on, read) {
    const write = request(LIST, "config/value/write", { keyPath: `plugins.${plugin.id}.enabled`, value: on, mergeStrategy: "upsert", ...(read.version !== undefined ? { expectedVersion: read.version } : {}) });
    const said = await ask(io, [initializeRequest(INIT), write]);
    const answers = answersOf(said ?? "");
    if (resultOf(answers, LIST)?.status === "ok") return {};
    const error = errorOf(answers.get(LIST));
    const conflict = isRecord(error?.data) && error.data.config_write_error_code === "configVersionConflict";
    if (conflict) return { refused: configChangedRefusal(read.file ?? "config.toml") };
    return { refused: `${typeof error?.message === "string" ? error.message.replace(/\.$/, "") : "Codex's app server did not answer"}, so nothing was switched.` };
  },
};
