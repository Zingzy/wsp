// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configChangedRefusal } from "@wsp/protocol";
import { CLAUDE_PLUGIN_SHELF, CODEX_PLUGIN_SHELF, catalogEntry, inStore, joinPath, plainValues, type FoundPlugin, type PeekGroup, type Peeked, type PluginIo } from "../src/index.js";

const fixture = <T,>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/plugins/${name}`, import.meta.url), "utf8")) as T;

interface ClaudeFixture {
  files: Record<string, string>;
  init: { plugins: { name: string; source: string; path: string }[]; agents: string[]; skills: string[]; slash_commands: string[]; mcp_servers: { name: string; source: string }[] };
}

/** A computer holding exactly these files, every folder above one there too, answering only what a peek asks;
 * `runs` records each line run and `peeks` each peek. */
function filesIo(files: Record<string, string>, o: { store?: string; run?: (line: string) => string | undefined } = {}): PluginIo & { runs: string[]; peeks: number } {
  const paths = Object.keys(files);
  const io = {
    home: "/x",
    ...(o.store !== undefined ? { store: o.store } : {}),
    runs: [] as string[],
    peeks: 0,
    peek: async (groups: readonly PeekGroup[]): Promise<Peeked> => {
      io.peeks++;
      const texts = new Map<string, string>();
      const lists = new Map<string, string[]>();
      const looked = new Set<string>();
      for (const g of groups) {
        const from = g.rootsFrom === undefined ? [] : plainValues(files[g.rootsFrom.file] ?? "", g.rootsFrom.key);
        for (const r of [...(g.roots ?? []), ...from]) {
          looked.add(joinPath(r));
          for (const f of g.files ?? []) if (files[joinPath(r, f)] !== undefined) texts.set(joinPath(r, f), files[joinPath(r, f)]!);
          for (const d of g.dirs ?? []) {
            const dir = joinPath(r, d.path);
            const under = paths.filter(x => x.startsWith(`${dir}/`)).map(x => x.slice(dir.length + 1).split("/"));
            if (under.length > 0) lists.set(dir, [...new Set(under.flatMap(segs => segs.slice(0, d.depth).map((_, i) => segs.slice(0, i + 1).join("/"))))]);
          }
        }
      }
      return { text: p => texts.get(joinPath(p)), list: d => lists.get(joinPath(d)), looked: r => looked.has(joinPath(r)) };
    },
    run: async (line: string) => {
      io.runs.push(line);
      return o.run?.(line);
    },
  };
  return io;
}

const CLAUDE = fixture<ClaudeFixture>("claude-2.1.296.json");
const ids = (rows: readonly FoundPlugin[]): string[] => rows.map(r => r.id).sort();

describe("Claude Code's plugins off its files", () => {
  it("lists the owner's 13 user installs out of 18 plugins in 30 records, 6 on, and none of the 16 temp-folder records", async () => {
    const index = JSON.parse(CLAUDE.files["/x/claude/plugins/installed_plugins.json"]!) as { plugins: Record<string, unknown[]> };
    expect(Object.keys(index.plugins)).toHaveLength(18);
    expect(Object.values(index.plugins).flat()).toHaveLength(30);
    const io = filesIo(CLAUDE.files, { store: "/x/claude" });
    const read = await CLAUDE_PLUGIN_SHELF.read(io, []);
    expect(read.plugins).toHaveLength(13);
    expect(read.plugins.every(r => r.scope === "user" && r.project === undefined)).toBe(true);
    expect(ids(read.plugins.filter(r => r.on))).toEqual(["brag@brag", "code-simplifier@claude-plugins-official", "no-claude-coauthor@acme", "rust-analyzer-lsp@claude-plugins-official", "skill-creator@claude-plugins-official", "vercel@claude-plugins-official"]);
    expect(read.plugins.map(r => r.id)).not.toContain("code-review@claude-plugins-official");
    expect(read.refused).toEqual([]);
  });

  it("never runs claude plugin list or details: it reads files alone", async () => {
    const io = filesIo(CLAUDE.files, { store: "/x/claude" });
    await CLAUDE_PLUGIN_SHELF.read(io, [{ id: "p1", name: "lab", path: "/x/lab" }]);
    expect(io.runs).toEqual([]);
    // The config and every plugin's folder in one peek: one round trip on a computer reached over a link.
    expect(io.peeks).toBe(1);
  });

  it("brings what the recorded turn loaded, for each plugin the turn loaded", async () => {
    const read = await CLAUDE_PLUGIN_SHELF.read(filesIo(CLAUDE.files, { store: "/x/claude" }), []);
    const loaded = CLAUDE.init.plugins.filter(p => p.path !== "builtin");
    // What a turn loads is exactly the plugins that are on and whose folder is there: skill-creator is on, its folder is not.
    expect(ids(read.plugins.filter(r => r.on && r.missing === undefined))).toEqual(loaded.map(p => p.source).sort());
    for (const p of loaded) {
      const row = read.plugins.find(r => r.id === p.source)!;
      const own = (names: readonly string[]): string[] => names.filter(n => n.startsWith(`${p.name}:`)).sort();
      expect(row.brings.skills, p.name).toEqual(own(CLAUDE.init.skills));
      expect(row.brings.subagents, p.name).toEqual(own(CLAUDE.init.agents));
      expect([...new Set([...row.brings.skills, ...row.brings.commands])].sort(), p.name).toEqual([...new Set(own(CLAUDE.init.slash_commands))].sort());
      expect(row.brings.servers, p.name).toEqual(CLAUDE.init.mcp_servers.filter(s => s.source === "plugin" && s.name.startsWith(`plugin:${p.name}:`)).map(s => s.name).sort());
      expect(row.path).toBe(p.path);
    }
    const vercel = read.plugins.find(r => r.name === "vercel")!;
    expect(vercel.brings.skills).toHaveLength(37);
    expect(vercel.brings.commands).toEqual(["vercel:bootstrap", "vercel:deploy", "vercel:env", "vercel:status"]);
    expect(vercel.brings.subagents).toEqual(["vercel:ai-architect", "vercel:deployment-expert", "vercel:performance-optimizer"]);
    expect(vercel.brings.hooks).toEqual(["PostToolUse", "SessionEnd", "SessionStart"]);
    expect(vercel.brings.servers).toEqual(["plugin:vercel:vercel"]);
    expect(vercel.source).toBe("anthropics/claude-plugins-official");
    expect(vercel.description).toBe("Build and deploy web apps and agents");
    expect(read.plugins.find(r => r.name === "brag")!.skills).toEqual({ dirs: ["/x/claude/plugins/cache/brag/brag/0.4.0/skills"], prefix: "brag" });
    expect(read.plugins.find(r => r.name === "no-claude-coauthor")!.brings.hooks).toEqual(["PreToolUse"]);
  });

  it("takes a plugin with no plugin.json from its marketplace entry, its language server included", async () => {
    const files = CLAUDE.files;
    expect(Object.keys(files).some(f => f.includes("rust-analyzer-lsp/1.0.0/.claude-plugin"))).toBe(false);
    const read = await CLAUDE_PLUGIN_SHELF.read(filesIo(files, { store: "/x/claude" }), []);
    const rust = read.plugins.find(r => r.name === "rust-analyzer-lsp")!;
    expect(rust.brings).toEqual({ skills: [], commands: [], subagents: [], hooks: [], servers: [], lsp: ["rust-analyzer"], apps: [] });
    expect(rust.description).toBe("Rust language server for code intelligence and analysis");
  });

  it("reads every plugin Missing where the cache is not there, as on the Boat machine, keeping each one's switch", async () => {
    const boat = Object.fromEntries(Object.entries(CLAUDE.files).filter(([path]) => !path.includes("/plugins/cache/")));
    const read = await CLAUDE_PLUGIN_SHELF.read(filesIo(boat, { store: "/x/claude" }), []);
    expect(read.plugins).toHaveLength(13);
    expect(read.plugins.every(r => r.missing === "folder")).toBe(true);
    expect(read.plugins.filter(r => r.on)).toHaveLength(6);
  });

  it("merges a project's switch local over project over user, and names the file that sets it", async () => {
    const files: Record<string, string> = { ...CLAUDE.files, "/x/lab/.claude/settings.json": JSON.stringify({ enabledPlugins: { "posthog-lab@lab-local": false } }) };
    const project = { id: "p1", name: "lab", path: "/x/lab" };
    const shared = (await CLAUDE_PLUGIN_SHELF.read(filesIo(files, { store: "/x/claude" }), [project])).plugins.find(r => r.scope === "local")!;
    expect(shared).toMatchObject({ id: "posthog-lab@lab-local", project, on: false, setIn: "/x/lab/.claude/settings.json", missing: "folder" });
    files["/x/lab/.claude/settings.local.json"] = JSON.stringify({ enabledPlugins: { "posthog-lab@lab-local": true } });
    const local = (await CLAUDE_PLUGIN_SHELF.read(filesIo(files, { store: "/x/claude" }), [project])).plugins.find(r => r.scope === "local")!;
    expect(local).toMatchObject({ on: true, setIn: "/x/lab/.claude/settings.local.json" });
  });

  it("falls back to the plugin's defaultEnabled where no settings file names it", async () => {
    const files: Record<string, string> = { ...CLAUDE.files, "/x/claude/settings.json": "{}" };
    files["/x/claude/plugins/cache/brag/brag/0.4.0/.claude-plugin/plugin.json"] = JSON.stringify({ name: "brag", defaultEnabled: false });
    const read = await CLAUDE_PLUGIN_SHELF.read(filesIo(files, { store: "/x/claude" }), []);
    expect(read.plugins.find(r => r.name === "brag")!.on).toBe(false);
    expect(read.plugins.find(r => r.name === "vercel")!.on).toBe(true);
  });

  it("reads under the home where no store is named", async () => {
    const home = Object.fromEntries(Object.entries(CLAUDE.files).map(([path, text]) => [path.replace("/x/claude/", "/x/.claude/"), text]));
    const read = await CLAUDE_PLUGIN_SHELF.read(filesIo(home), []);
    expect(read.plugins).toHaveLength(13);
    expect(inStore(catalogEntry("claude") as { stateHome: string }, "~/.claude/settings.json", { home: "/x", store: "/s" })).toBe("/s/settings.json");
  });

  it("switches with claude plugin enable or disable at user scope, and counts already_in_goal_state as done", async () => {
    const row = { id: "brag@brag" } as FoundPlugin;
    const answers: Record<string, string> = {
      disable: '{"command":"disable","outcome":"failed","plugin":"brag@brag","scope":"user","message":"Plugin \\"brag@brag\\" is already disabled at user scope","failureCode":"already_in_goal_state","alreadyInGoalState":true}\n\x1e1\n',
      enable: '{"command":"enable","outcome":"ok","plugin":"brag@brag","pluginId":"brag@brag","scope":"user","message":"Successfully enabled plugin: brag (scope: user)"}\n\x1e0\n',
    };
    const io = filesIo({}, { run: line => answers[/claude plugin (\w+)/.exec(line)![1]!] });
    expect(await CLAUDE_PLUGIN_SHELF.turn(io, row, false, { plugins: [], refused: [] })).toEqual({});
    expect(await CLAUDE_PLUGIN_SHELF.turn(io, row, true, { plugins: [], refused: [] })).toEqual({});
    expect(io.runs[0]).toMatch(/^claude plugin disable 'brag@brag' --scope user --json <\/dev\/null/);
    const failed = filesIo({}, { run: () => '{"command":"enable","outcome":"failed","message":"Plugin \\"x@y\\" not found"}\n\x1e1\n' });
    expect(await CLAUDE_PLUGIN_SHELF.turn(failed, row, true, { plugins: [], refused: [] })).toEqual({ refused: 'Plugin "x@y" not found, so nothing was switched.' });
  });
});

interface CodexFixture {
  pluginList: Record<string, unknown>;
  configRead: Record<string, unknown>;
  pluginRead: Record<string, Record<string, unknown>>;
  writeOk: Record<string, unknown>;
  writeStale: Record<string, unknown>;
}

const CODEX = fixture<CodexFixture>("codex-0.162.1.json");

/** A computer whose codex app server answers each request in a script as 0.162.1 did. */
function codexIo(o: { stale?: boolean; dead?: boolean; none?: boolean; old?: boolean } = {}): PluginIo & { runs: string[]; sent: { method: string; params: Record<string, unknown> }[] } {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const io = filesIo({}, {
    run: line => {
      if (o.none === true) return "__WSP_NO_CODEX__\n";
      if (o.dead === true) return undefined;
      const lines = [...line.matchAll(/'(\{"jsonrpc"[^']*\})'/g)].map(m => JSON.parse(m[1]!) as { id: number; method: string; params: Record<string, unknown> });
      return lines
        .map(req => {
          sent.push({ method: req.method, params: req.params });
          if (req.method === "initialize") return { id: req.id, result: { codexHome: "/x/codex" } };
          if (req.method === "plugin/list") return o.old === true ? { id: req.id, error: { code: -32600, message: "Invalid request: unknown variant `plugin/list`, expected one of `initialize`, `thread/start`" } } : { id: req.id, result: CODEX.pluginList };
          if (req.method === "config/read") return { id: req.id, result: CODEX.configRead };
          if (req.method === "plugin/read") return { id: req.id, result: Object.values(CODEX.pluginRead).find(r => (r.plugin as { summary: { name: string } }).summary.name === req.params.pluginName) };
          if (req.method === "config/value/write") return o.stale === true ? { id: req.id, error: CODEX.writeStale } : { id: req.id, result: CODEX.writeOk };
          return { id: req.id, error: { message: "unknown" } };
        })
        .map(a => JSON.stringify(a))
        .join("\n");
    },
  });
  return Object.assign(io, { sent });
}

describe("Codex's plugins through its app server", () => {
  it("lists brag and no-claude-coauthor with what each brings, from plugin/list and plugin/read", async () => {
    const io = codexIo();
    const read = await CODEX_PLUGIN_SHELF.read(io, []);
    const brag = read.plugins.find(r => r.id === "brag@brag")!;
    expect(brag).toMatchObject({ name: "brag", marketplace: "brag", version: "0.4.0", scope: "user", on: true, path: "/x/codex/plugins/cache/brag/brag/0.4.0", source: "/x/mk/brag" });
    expect(brag.missing).toBeUndefined();
    expect(brag.brings).toEqual({ skills: ["brag:brag", "brag:brag-slim"], commands: [], subagents: [], hooks: [], servers: [], lsp: [], apps: [] });
    expect(read.plugins.find(r => r.id === "no-claude-coauthor@acme")!.brings.hooks).toEqual(["preToolUse"]);
    expect(io.sent.filter(s => s.method === "plugin/read").map(s => s.params.marketplacePath)).toEqual(["/x/mk/brag/.claude-plugin/marketplace.json", "/x/mk/acme/.claude-plugin/marketplace.json"]);
    expect(read.version).toMatch(/^sha256:/);
  });

  it("reads the six Codex app plugins config.toml names and plugin/list does not return as Missing, each switch as written", async () => {
    const read = await CODEX_PLUGIN_SHELF.read(codexIo(), []);
    const missing = read.plugins.filter(r => r.missing !== undefined);
    expect(missing.map(r => [r.id, r.on, r.missing])).toEqual([
      ["browser@openai-bundled", true, "marketplace"],
      ["chrome@openai-bundled", true, "marketplace"],
      ["computer-use@openai-bundled", false, "marketplace"],
      ["documents@openai-primary-runtime", true, "marketplace"],
      ["presentations@openai-primary-runtime", true, "marketplace"],
      ["spreadsheets@openai-primary-runtime", true, "marketplace"],
    ]);
  });

  it("says Codex's plugins were not read where its app server did not answer, and nothing where codex is not there", async () => {
    expect(await CODEX_PLUGIN_SHELF.read(codexIo({ dead: true }), [])).toEqual({ plugins: [], refused: ["plugins: Codex's app server did not answer, so Codex's plugins were not read"] });
    expect(await CODEX_PLUGIN_SHELF.read(codexIo({ none: true }), [])).toEqual({ plugins: [], refused: [] });
    // A Codex older than its plugins answers plugin/list as a method it does not know, the way 0.162.1 answers any such.
    expect(await CODEX_PLUGIN_SHELF.read(codexIo({ old: true }), [])).toEqual({ plugins: [], refused: [] });
  });

  it("switches with config/value/write on plugins.<id>.enabled with the version it read, and refuses a write the file moved under", async () => {
    const io = codexIo();
    const read = await CODEX_PLUGIN_SHELF.read(io, []);
    const brag = read.plugins.find(r => r.id === "brag@brag")!;
    expect(await CODEX_PLUGIN_SHELF.turn(io, brag, false, read)).toEqual({});
    expect(io.sent.at(-1)).toEqual({ method: "config/value/write", params: { keyPath: "plugins.brag@brag.enabled", value: false, mergeStrategy: "upsert", expectedVersion: read.version } });
    const stale = codexIo({ stale: true });
    expect(await CODEX_PLUGIN_SHELF.turn(stale, brag, true, read)).toEqual({ refused: configChangedRefusal(read.file!) });
  });
});
