// SPDX-License-Identifier: AGPL-3.0-only
// Every agent's plugins on a computer, off the module each catalog agent
// names for them, read where that agent reads: under the folder its store
// variable names for a thread there, else under the home.
import { CATALOG_AGENTS, harnessLine, joinPath, type AgentEntry, type FoundPlugin, type PeekGroup, type Peeked, type PluginIo, type PluginProject, type PluginShelf, type PluginsFound } from "@wsp/catalog";
import { shellQuote } from "@wsp/protocol";
import type { AgentsProject, PluginRow } from "@wsp/protocol";
import { type Host, tilde } from "../host.js";

/** One agent's plugins as its module found them, beside the rows the report carries. */
export interface AgentPlugins {
  agent: string;
  shelf: PluginShelf;
  found: PluginsFound;
}

export interface PluginsRead {
  plugins: PluginRow[];
  refused: string[];
  /** Each agent's own read, which a switch acts on and the skills reader takes plugin skills from. */
  agents: AgentPlugins[];
}

/** How much of one file a peek reads. */
const PEEK_FILE_BYTES = 256 * 1024;

/** `peek <files> <dirs> <root>...`: for each root, each file there (one relative path a line) as a record of its path
 * and its first bytes, and each folder there (`<depth> <path>` a line, `.` the root itself) as a record of its path
 * and every name under it to that depth, relative to it. A name with a newline in it is not one this reads. */
const PEEK = [
  "peek() {",
  "  files=$1; dirs=$2; shift 2",
  "  for r; do",
  String.raw`    printf '\036r%s\037' "$r"`,
  String.raw`    printf '%s\n' "$files" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$r/$f" ] && { printf '\036f%s/%s\037' "$r" "$f"; head -c ` + String(PEEK_FILE_BYTES) + String.raw` "$r/$f"; }; done`,
  String.raw`    printf '%s\n' "$dirs" | while IFS=' ' read -r k d; do`,
  '      [ -n "$d" ] || continue',
  '      if [ "$d" = . ]; then p=$r; else p=$r/$d; fi',
  '      [ -d "$p" ] || continue',
  String.raw`      printf '\036d%s\037' "$p"`,
  String.raw`      find -L "$p" -mindepth 1 -maxdepth "$k" 2>/dev/null | while IFS= read -r x; do printf '%s\037' "` + "${x#" + String.raw`"$p"/}"; done`,
  "    done",
  "  done",
  "}",
  // Every plain string value of a key in a JSON file, each once: a value holding an escape is the reader's to ask for.
  "from() {",
  String.raw`  [ -f "$1" ] && LC_ALL=C grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"\\]*\"" "$1" | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//' | sort -u`,
  "}",
].join("\n");

/** One peek of every group as one line on the computer, and what it printed read back by path; nothing where the
 * answer did not come back whole. */
async function peekOn(run: (line: string) => Promise<string | undefined>, groups: readonly PeekGroup[]): Promise<Peeked | undefined> {
  const calls = groups.flatMap(g => {
    const what = `${shellQuote((g.files ?? []).join("\n"))} ${shellQuote((g.dirs ?? []).map(d => `${d.depth} ${d.path}`).join("\n"))}`;
    const named = (g.roots ?? []).length === 0 ? [] : [`peek ${what} ${g.roots!.map(shellQuote).join(" ")}`];
    const from = g.rootsFrom === undefined ? [] : [`from ${shellQuote(g.rootsFrom.file)} ${shellQuote(g.rootsFrom.key)} | while IFS= read -r r; do peek ${what} "$r"; done`];
    return [...named, ...from];
  });
  const said = await run([PEEK, ...calls, String.raw`printf '\036END\n'`].join("\n"));
  if (said === undefined || !said.trimEnd().endsWith("\x1eEND")) return undefined;
  const texts = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const looked = new Set<string>();
  for (const record of said.split("\x1e").slice(1)) {
    const cut = record.indexOf("\x1f");
    if (cut < 0) continue;
    const at = joinPath(record.slice(1, cut));
    const body = record.slice(cut + 1);
    if (record[0] === "f") texts.set(at, body);
    else if (record[0] === "d") lists.set(at, body.split("\x1f").filter(n => n !== "" && n !== "\n"));
    else if (record[0] === "r") looked.add(at);
  }
  return { text: path => texts.get(joinPath(path)), list: dir => lists.get(joinPath(dir)), looked: root => looked.has(joinPath(root)) };
}

/** The module's view of the computer, for one agent: its files, and its lines run pointed at its store. */
export function pluginIo(host: Host, agent: string): PluginIo {
  const store = host.stores?.[agent];
  return {
    home: host.home,
    ...(store !== undefined ? { store } : {}),
    peek: groups => peekOn(line => host.exec.run("sh", ["-c", line], { timeoutMs: 30_000 }), groups),
    // bash: Codex's app server script reads its answers with read -u.
    run: line => host.exec.run("bash", ["-c", harnessLine(agent, line, { stores: host.stores })], { timeoutMs: 30_000 }),
  };
}

/** A found plugin as the report's row, its paths `~`-relative. */
export function pluginRow(host: Pick<Host, "home">, agent: string, p: FoundPlugin): PluginRow {
  const { skills: _skills, project, path, setIn, ...rest } = p;
  return {
    agent,
    ...rest,
    ...(project !== undefined ? { project: { ...project, path: tilde(host.home, project.path) } } : {}),
    ...(path !== undefined ? { path: tilde(host.home, path) } : {}),
    ...(setIn !== undefined ? { setIn: tilde(host.home, setIn) } : {}),
  };
}

/** Every agent's plugins, side by side: one agent's read that fails leaves the others' rows standing. */
export async function detectPlugins(host: Host, o: { agents?: readonly AgentEntry[]; projects?: readonly AgentsProject[] } = {}): Promise<PluginsRead> {
  const agents = (o.agents ?? CATALOG_AGENTS).filter(a => a.pluginShelf !== undefined);
  const projects: PluginProject[] = (o.projects ?? []).map(p => ({ id: p.id, name: p.name, path: p.path }));
  const reads = await Promise.all(
    agents.map(async (a): Promise<AgentPlugins> => {
      const shelf = a.pluginShelf!;
      const found = await shelf.read(pluginIo(host, a.id), projects).catch((e: unknown) => ({ plugins: [], refused: [`plugins: ${a.name}'s plugins were not read: ${e instanceof Error ? e.message : String(e)}`] }));
      return { agent: a.id, shelf, found };
    }),
  );
  return {
    plugins: reads.flatMap(r => r.found.plugins.map(p => pluginRow(host, r.agent, p))),
    refused: reads.flatMap(r => r.found.refused),
    agents: reads,
  };
}
