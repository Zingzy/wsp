// SPDX-License-Identifier: AGPL-3.0-only
// The recipe's MCP servers on a computer somebody owns. The guest is a temp
// directory with real files in it, so what the run ends with is the file on
// disk: the file an agent keeps its servers in is merged key by key, every
// other key of its own stands, and a server the agent or the person has under
// one of the recipe's names is left with its row saying so.
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_TOML, MCP_SERVERS_JSON, OPENCODE_JSON, parseJsonc } from "@wsp/catalog";
import { MCP_ID_PREFIX, TOOLS_PATH, placeProvisionPaths } from "@wsp/protocol";
import type { McpPlan } from "../src/golden-mcp.js";
import { closeAgentFiles, machineServerPort, oncePathsOf, provisionFiles, unlandFiles, unmergeServers, type ProvisionLanding } from "../src/provision-files.js";
import { keyUnreachedLine, provisionMcp, theirServerLine } from "../src/provision-mcp.js";
import { newSetupRun, provisionStep, type ProvisionPlan } from "../src/provision.js";
import { tarOf } from "../src/vault.js";
import type { PackedFiles } from "../src/golden.js";
import { boxGuest, cleanGuests, type BoxGuest } from "./box-guest.js";

const HOME = "/Users/dev";

const guests: BoxGuest[] = [];
afterEach(() => cleanGuests(guests.splice(0)));

function box(present: string[] = ["npx"]): BoxGuest {
  const g = boxGuest(present);
  guests.push(g);
  return g;
}

/** What Claude Code writes for itself the first time it runs on that computer, with one server the person added
 * there by hand under a name the recipe also carries. */
const CLAUDE_ON_BOX = `${JSON.stringify(
  {
    numStartups: 41,
    oauthAccount: { emailAddress: "he@example.com" },
    mcpServers: { mine: { command: "/usr/local/bin/mine", args: [] } },
    projects: { "/root/work": { history: ["his own turn"] } },
  },
  null,
  2,
)}\n`;

/** This computer's own copy of each agent's file, which is what travels: the recipe's servers are taken from it. */
const CLAUDE_TRAVELLED = (gsc: string[] = ["--stdio"], far = false): string =>
  `${JSON.stringify(
    {
      numStartups: 7,
      mcpServers: {
        gsc: { command: "npx", args: ["-y", "gsc-mcp", ...gsc] },
        notes: { command: `${HOME}/Library/Notes/mcp`, args: [] },
        mine: { command: "npx", args: ["theirs-on-the-mac"] },
        ...(far ? { far: { command: "/usr/bin/far-mcp", args: [] } } : {}),
      },
    },
    null,
    2,
  )}\n`;

const CODEX_TRAVELLED = ['model = "gpt-5"', "", "[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "context7"]', "", "[mcp_servers.grafana]", 'command = "npx"', ""].join("\n");

/** OpenCode's own config as somebody keeps it on that computer: jsonc, with a comment of the person's. */
const OPENCODE_ON_BOX = '{\n  // my own servers\n  "theme": "dark",\n  "mcp": {}\n}\n';
const OPENCODE_TRAVELLED = `${JSON.stringify({ mcp: { docs: { type: "local", command: ["npx", "docs-mcp"], enabled: true } } }, null, 2)}\n`;

const opencodePlanOn = (root: string): McpPlan => ({
  agents: [{ id: "opencode", label: "OpenCode", scopes: [{ files: [join(root, ".config/opencode/opencode.json")], format: OPENCODE_JSON, keep: ["docs"], drop: [] }], aside: [] }],
  guestHome: root,
  rewrites: [[`${HOME}/`, `${root}/`]],
  binDirs: [],
  tools: [],
});

const LANDS: ProvisionLanding[] = [
  { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/.claude.json", once: true },
  { id: "agents/codex", label: "Codex", dest: ".codex/config.toml", once: true },
];

function planOn(root: string, far = false, unticked: readonly string[] = []): McpPlan {
  const asked = ["gsc", "mine", ...(far ? ["far"] : [])];
  return {
    agents: [
      {
        id: "claude",
        label: "Claude Code",
        scopes: [
          {
            files: [join(root, ".claude-cfg/.claude.json")],
            format: MCP_SERVERS_JSON,
            keep: asked.filter(name => !unticked.includes(name)),
            drop: [{ name: "notes", reason: "command is macOS-only, will not run" }, ...unticked.map(name => ({ name, reason: "unticked" }))],
          },
        ],
        aside: [],
      },
      { id: "codex", label: "Codex", scopes: [{ files: [join(root, ".codex/config.toml")], format: CODEX_TOML, keep: ["context7"], drop: [{ name: "grafana", reason: "unticked" }] }], aside: [] },
    ],
    guestHome: root,
    rewrites: [[`${HOME}/`, `${root}/`]],
    binDirs: [`${HOME}/.local/bin/`],
    tools: [],
  };
}

const packed = (tar: Buffer): PackedFiles => ({ tar, bytes: tar.length, unpacked: tar.length, skipped: [], cut: [], silenced: [], macPaths: [] });

const tarOfConfigs = (claude: string, codex: string): Buffer =>
  tarOf([
    { path: ".claude-cfg/.claude.json", mode: 0o600, content: claude },
    { path: ".codex/config.toml", mode: 0o600, content: codex },
  ]);

/** One run of the job's files and servers rounds on that computer, in the order the job runs them, with the close
 * that folds what it wrote into the list beside the job. */
async function run(g: BoxGuest, o: { claude?: string; codex?: string; far?: boolean; untick?: readonly string[]; held?: ReadonlySet<string> } = {}): Promise<{ files: [string, string][]; servers: [string, string, string | undefined][]; closing: string }> {
  const said: string[] = [];
  const landed = await provisionFiles(g.machine, { home: g.root, lands: LANDS, pack: async () => packed(tarOfConfigs(o.claude ?? CLAUDE_TRAVELLED(["--stdio"], o.far === true), o.codex ?? CODEX_TRAVELLED)) });
  const servers = await provisionMcp(g.machine, planOn(g.root, o.far === true, o.untick ?? []), {
    home: g.root,
    landed: landed.owned,
    tools: [],
    path: TOOLS_PATH,
    ...(o.held !== undefined ? { held: o.held } : {}),
    stage: (_which, detail) => {
      if (detail !== undefined) said.push(detail);
    },
  });
  await closeAgentFiles(g.machine, g.root, oncePathsOf(LANDS));
  return {
    files: landed.rows.map(r => [r.id, r.outcome]),
    servers: servers.map(r => [r.id, r.outcome, r.note]),
    closing: said.at(-1) ?? "",
  };
}

const CODEX_AGENTS_MD = "Answer in one line.\n";
const CODEX_PROMPT = "Review the diff.\n";

/** The servers step of a box job carrying Codex alone: its config, its standing instructions and a prompt, with the
 * one server the person ticked. */
const codexStepPlan = (root: string): ProvisionPlan => ({
  recipeAt: "picks",
  path: TOOLS_PATH,
  steps: [],
  skipped: [],
  agents: 0,
  compiler: false,
  files: {
    lands: [
      { id: "agents/codex", label: "Codex", dest: ".codex/config.toml", once: true },
      { id: "agents/codex", label: "Codex", dest: ".codex/AGENTS.md" },
      { id: "agents/codex", label: "Codex", dest: ".codex/prompts" },
    ],
    pack: async () =>
      packed(
        tarOf([
          { path: ".codex/config.toml", mode: 0o600, content: CODEX_TRAVELLED },
          { path: ".codex/AGENTS.md", mode: 0o644, content: CODEX_AGENTS_MD },
          { path: ".codex/prompts/review.md", mode: 0o644, content: CODEX_PROMPT },
        ]),
      ),
  },
  mcp: { ...planOn(root), agents: planOn(root).agents.filter(a => a.id === "codex") },
});

const CODEX_OWN = [
  { path: ".codex/AGENTS.md", content: CODEX_AGENTS_MD },
  { path: ".codex/prompts/review.md", content: CODEX_PROMPT },
];

/** One files round and its close with no server in it, as the skills step lands a skill, given the stores its step
 * is handed. */
async function landOnly(g: BoxGuest, files: readonly { path: string; content: string }[], stores?: Record<string, string>): Promise<void> {
  const lands = files.map(f => ({ id: `files/${f.path}`, label: f.path, dest: f.path }));
  const pack = async () => packed(tarOf(files.map(f => ({ path: f.path, mode: 0o644, content: f.content }))));
  await provisionFiles(g.machine, { home: g.root, lands, pack, ...(stores !== undefined ? { stores } : {}) });
  await closeAgentFiles(g.machine, g.root, [], stores);
}

const list = (root: string): string[] => readFileSync(placeProvisionPaths(root).landed, "utf8").split("\n").filter(l => l !== "");
const claudeOf = (root: string): { numStartups: number; oauthAccount: unknown; projects: Record<string, unknown>; mcpServers: Record<string, { command: string; args: string[] }> } =>
  JSON.parse(readFileSync(join(root, ".claude-cfg/.claude.json"), "utf8")) as never;

describe("the recipe's servers on a computer somebody owns", { timeout: 60_000 }, () => {
  it("lands each server as the copy carries it, every key the person set kept and every value still a name", async () => {
    const g = box();
    const gsc = { type: "http", url: "https://gsc.example/mcp", headers: { Authorization: "Bearer ${GSC_TOKEN}" }, oauth: { clientId: "abc", callbackPort: 8080 } };
    const claude = `${JSON.stringify({ mcpServers: { gsc, mine: { command: "npx", args: [] } } }, null, 2)}\n`;
    const codex = ["[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "context7"]', 'env_vars = ["GITHUB_PERSONAL_ACCESS_TOKEN", "HTTPS_PROXY"]', 'disabled_tools = ["delete_repository"]', "startup_timeout_sec = 40", ""].join("\n");
    await run(g, { claude, codex });
    expect(claudeOf(g.root).mcpServers.gsc).toEqual(gsc);
    const own = readFileSync(join(g.root, ".codex/config.toml"), "utf8");
    for (const line of ['env_vars = ["GITHUB_PERSONAL_ACCESS_TOKEN", "HTTPS_PROXY"]', 'disabled_tools = ["delete_repository"]', "startup_timeout_sec = 40"]) expect(own).toContain(line);
  });

  it("merges them into the file its agent keeps, reads them present on the next run, and writes its own copy again only where this computer's changed", async () => {
    const g = box();
    const { root } = g;
    mkdirSync(join(root, ".claude-cfg"), { recursive: true });
    writeFileSync(join(root, ".claude-cfg/.claude.json"), CLAUDE_ON_BOX);

    // The first run: Claude Code has already run on that computer, so its file stands and its servers are merged
    // into it; Codex has not, so its file lands whole and the servers that came in it arrived with this run.
    const first = await run(g);
    expect(first.files).toEqual([
      ["files/.claude-cfg/.claude.json", "present"],
      ["files/.codex/config.toml", "installed"],
    ]);
    expect(first.servers).toEqual([
      // Both run through npx, which brings the package down at the agent's first use of the server.
      [`${MCP_ID_PREFIX}claude/gsc`, "installed", "npx fetches the package on first use"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped", "command is macOS-only, will not run"],
      [`${MCP_ID_PREFIX}claude/mine`, "skipped", theirServerLine("Claude Code", "mine", join(root, ".claude-cfg/.claude.json"))],
      [`${MCP_ID_PREFIX}codex/context7`, "installed", "npx fetches the package on first use"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped", "unticked"],
    ]);
    // A file that arrived whole is wsp's own hand for that run, so the server the person unticked comes out of it
    // again rather than standing there because nobody owns it.
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).not.toContain("grafana");
    // Every key the agent wrote for itself stands, and the server the person put there is the one they wrote.
    const after = claudeOf(root);
    expect(after.numStartups).toBe(41);
    expect(after.oauthAccount).toEqual({ emailAddress: "he@example.com" });
    expect(after.projects).toEqual({ "/root/work": { history: ["his own turn"] } });
    expect(after.mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
    expect(after.mcpServers["gsc"]).toEqual({ command: "npx", args: ["-y", "gsc-mcp", "--stdio"] });
    // The list holds one line per key wsp wrote and not one line for either file: what wsp owns in a file its
    // agent keeps is the keys, never the bytes.
    expect(list(root)).toHaveLength(2);
    expect(list(root).map(l => l.split("\t")[0]).sort()).toEqual([`${MCP_ID_PREFIX}claude/gsc`, `${MCP_ID_PREFIX}codex/context7`]);

    // Both agents write their own files again, as they do at every launch and at the first turn in a folder.
    const rewritten = claudeOf(root);
    writeFileSync(join(root, ".claude-cfg/.claude.json"), `${JSON.stringify({ ...rewritten, numStartups: 42, projects: { ...rewritten.projects, "/root/again": { history: [] } } }, null, 2)}\n`);
    writeFileSync(join(root, ".codex/config.toml"), `${readFileSync(join(root, ".codex/config.toml"), "utf8")}\n[projects."/root/repo"]\ntrust_level = "trusted"\n`);
    const listed = list(root).sort();

    const second = await run(g);
    expect(second.files).toEqual([
      ["files/.claude-cfg/.claude.json", "present"],
      ["files/.codex/config.toml", "present"],
    ]);
    expect(second.servers.map(r => [r[0], r[1]])).toEqual([
      [`${MCP_ID_PREFIX}claude/gsc`, "present"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped"],
      [`${MCP_ID_PREFIX}claude/mine`, "skipped"],
      [`${MCP_ID_PREFIX}codex/context7`, "present"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped"],
    ]);
    expect(list(root).sort()).toEqual(listed);
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain('[projects."/root/repo"]');
    // The words the round closes with say what its rows say: nothing on this run was installed.
    expect(second.closing).toContain("gsc, context7 already there");
    expect(second.closing).not.toContain("installed");
    expect(second.closing).not.toContain("fetched");

    // This computer's copy of one server changed: that key is wsp's own by the list, so it is written again.
    const third = await run(g, { claude: CLAUDE_TRAVELLED(["--stdio", "--verbose"]) });
    expect(third.servers.map(r => [r[0], r[1]])).toEqual([
      [`${MCP_ID_PREFIX}claude/gsc`, "installed"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped"],
      [`${MCP_ID_PREFIX}claude/mine`, "skipped"],
      [`${MCP_ID_PREFIX}codex/context7`, "present"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped"],
    ]);
    const held = claudeOf(root);
    expect(held.mcpServers["gsc"]!.args).toEqual(["-y", "gsc-mcp", "--stdio", "--verbose"]);
    expect(held.numStartups).toBe(42);
    expect(held.projects["/root/again"]).toEqual({ history: [] });
    expect(held.mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
    // And on a run where one server did arrive, the closing words name that one and say the other is already there.
    expect(third.closing).toContain("context7 already there");
    expect(third.closing).toContain("gsc: package fetched on first use by npx");
    expect(third.closing).not.toContain("context7 installed");
    const gsc = list(root).find(l => l.startsWith(`${MCP_ID_PREFIX}claude/gsc\t`))!;
    expect(gsc).not.toBe(listed.find(l => l.startsWith(`${MCP_ID_PREFIX}claude/gsc\t`)));
    expect(list(root)).toHaveLength(2);
  });

  it("leaves a server the agent itself rewrote since, names whose it is, and skips one whose command that computer does not have", async () => {
    const g = box();
    const { root } = g;
    mkdirSync(join(root, ".claude-cfg"), { recursive: true });
    writeFileSync(join(root, ".claude-cfg/.claude.json"), CLAUDE_ON_BOX);
    const first = await run(g, { far: true });
    expect(first.servers.find(r => r[0] === `${MCP_ID_PREFIX}claude/far`)).toEqual([`${MCP_ID_PREFIX}claude/far`, "skipped", "command not on the machine"]);
    expect(claudeOf(root).mcpServers["far"]).toBeUndefined();

    // The agent adds a field of its own to the entry wsp wrote: the entry is no longer the one the list holds, so
    // it is the agent's from here on and the next run leaves it exactly as it is.
    const held = claudeOf(root);
    held.mcpServers["gsc"] = { ...held.mcpServers["gsc"]!, args: ["-y", "gsc-mcp", "--stdio", "--codex-added-this"] };
    const theirs = `${JSON.stringify(held, null, 2)}\n`;
    writeFileSync(join(root, ".claude-cfg/.claude.json"), theirs);
    const again = await run(g, { claude: CLAUDE_TRAVELLED(["--stdio", "--verbose"]) });
    expect(again.servers.find(r => r[0] === `${MCP_ID_PREFIX}claude/gsc`)).toEqual([
      `${MCP_ID_PREFIX}claude/gsc`,
      "skipped",
      theirServerLine("Claude Code", "gsc", join(root, ".claude-cfg/.claude.json")),
    ]);
    expect(readFileSync(join(root, ".claude-cfg/.claude.json"), "utf8")).toBe(theirs);
  });

  it("writes down the keys it no longer owns, so the list stops naming a server that was unticked on this computer", async () => {
    const g = box();
    const { root } = g;
    mkdirSync(join(root, ".claude-cfg"), { recursive: true });
    writeFileSync(join(root, ".claude-cfg/.claude.json"), CLAUDE_ON_BOX);
    await run(g);
    expect(list(root).map(l => l.split("\t")[0]).sort()).toEqual([`${MCP_ID_PREFIX}claude/gsc`, `${MCP_ID_PREFIX}codex/context7`]);

    // The person unticks that server on this computer: the merge takes wsp's own entry back out of the file its
    // agent keeps, and the list stops saying wsp owns the name.
    const second = await run(g, { untick: ["gsc"] });
    expect(second.servers.find(r => r[0] === `${MCP_ID_PREFIX}claude/gsc`)![1]).toBe("skipped");
    expect(claudeOf(root).mcpServers["gsc"]).toBeUndefined();
    expect(list(root).map(l => l.split("\t")[0])).toEqual([`${MCP_ID_PREFIX}codex/context7`]);
    // What the round wrote down for a name it no longer owns is itself out of the list: it is read once, by the
    // close, and what stands afterwards is what wsp owns.
    expect(readFileSync(placeProvisionPaths(root).landed, "utf8")).not.toContain("\t-\t-");
    // Every key the agent wrote for itself and the server the person put there are where they were.
    expect(claudeOf(root).numStartups).toBe(41);
    expect(claudeOf(root).mcpServers["mine"]).toEqual({ command: "/usr/local/bin/mine", args: [] });
  });

  it("says on a server's row where its key does not reach that computer's threads, since that agent's launch hands it no value", async () => {
    const g = box();
    const held = new Set(["LINEAR_TOKEN"]);
    const claude = `${JSON.stringify({ mcpServers: { gsc: { type: "http", url: "https://gsc.example/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" } }, mine: { command: "npx", args: [] } } }, null, 2)}\n`;
    const codex = ["[mcp_servers.context7]", 'url = "https://c7.example/mcp"', 'bearer_token_env_var = "LINEAR_TOKEN"', ""].join("\n");
    const { servers } = await run(g, { claude, codex, held });
    expect(servers.find(([id]) => id === `${MCP_ID_PREFIX}codex/context7`)).toEqual([`${MCP_ID_PREFIX}codex/context7`, "installed", keyUnreachedLine("Codex", ["LINEAR_TOKEN"])]);
    expect(servers.find(([id]) => id === `${MCP_ID_PREFIX}claude/gsc`)?.[2]).toBeUndefined();

    const o = box();
    const config = join(o.root, ".config/opencode/opencode.json");
    mkdirSync(join(o.root, ".config/opencode"), { recursive: true });
    writeFileSync(config, OPENCODE_ON_BOX);
    const travelled = `${JSON.stringify({ mcp: { docs: { type: "local", command: ["npx", "docs-mcp"], enabled: true, environment: { DOCS_KEY: "{env:LINEAR_TOKEN}" } } } }, null, 2)}\n`;
    const lands: ProvisionLanding[] = [{ id: "agents/opencode", label: "OpenCode", dest: ".config/opencode/opencode.json", once: true }];
    const landed = await provisionFiles(o.machine, { home: o.root, lands, pack: async () => packed(tarOf([{ path: ".config/opencode/opencode.json", mode: 0o600, content: travelled }])) });
    const rows = await provisionMcp(o.machine, opencodePlanOn(o.root), { home: o.root, landed: landed.owned, tools: [], path: TOOLS_PATH, stage: () => {}, held });
    expect(rows.map(r => r.note)).toEqual([`npx fetches the package on first use; ${keyUnreachedLine("OpenCode", ["LINEAR_TOKEN"])}`]);
    // Read again with the server already as it travelled, the row reads present and still says so.
    const again = await provisionMcp(o.machine, opencodePlanOn(o.root), { home: o.root, landed: new Map(), tools: [], path: TOOLS_PATH, stage: () => {}, held });
    expect(again.map(r => [r.outcome, r.note])).toEqual([["present", keyUnreachedLine("OpenCode", ["LINEAR_TOKEN"])]]);
  });

  it("merges into a jsonc config in place, so the person's comments stand and no row says anything of them", async () => {
    const g = box();
    const { root } = g;
    const config = join(root, ".config/opencode/opencode.json");
    mkdirSync(join(root, ".config/opencode"), { recursive: true });
    writeFileSync(config, OPENCODE_ON_BOX);
    const lands: ProvisionLanding[] = [{ id: "agents/opencode", label: "OpenCode", dest: ".config/opencode/opencode.json", once: true }];
    const landed = await provisionFiles(g.machine, { home: root, lands, pack: async () => packed(tarOf([{ path: ".config/opencode/opencode.json", mode: 0o600, content: OPENCODE_TRAVELLED }])) });
    const rows = await provisionMcp(g.machine, opencodePlanOn(root), { home: root, landed: landed.owned, tools: [], path: TOOLS_PATH, stage: () => {} });
    expect(rows.map(r => [r.id, r.outcome, r.note])).toEqual([[`${MCP_ID_PREFIX}opencode/docs`, "installed", "npx fetches the package on first use"]]);
    const held = readFileSync(config, "utf8");
    expect(parseJsonc(held)).toEqual({ theme: "dark", mcp: { docs: { type: "local", command: ["npx", "docs-mcp"], enabled: true } } });
    expect(held).toContain("  // my own servers\n");
  });

  it("merges an agent's servers into the config under the store its threads there read, outside the home, and takes them back out of it on a leave", async () => {
    const g = box();
    // The box's shared logins folder, where its Codex sign-in wrote and a thread's CODEX_HOME points.
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    writeFileSync(join(logins, "config.toml"), 'model = "o4"\n');
    const said: string[] = [];
    const landed = await provisionFiles(g.machine, { home: g.root, lands: LANDS, pack: async () => packed(tarOfConfigs(CLAUDE_TRAVELLED(), CODEX_TRAVELLED)) });
    const o = { home: g.root, landed: landed.owned, tools: [], path: TOOLS_PATH, stores: { codex: logins }, stage: (_w: string, d?: string) => void (d !== undefined && said.push(d)) };
    const rows = await provisionMcp(g.machine, planOn(g.root), o);
    await closeAgentFiles(g.machine, g.root, oncePathsOf(LANDS));
    expect(rows.find(r => r.id === `${MCP_ID_PREFIX}codex/context7`)?.outcome).toBe("installed");
    const own = readFileSync(join(logins, "config.toml"), "utf8");
    expect(own.startsWith('model = "o4"\n')).toBe(true);
    expect(CODEX_TOML.read(own, g.root).map(s => s.name)).toEqual(["context7"]);
    // Claude Code names no store here, so its servers go where the catalog keeps them, as before.
    expect(Object.keys(claudeOf(g.root).mcpServers)).toContain("gsc");

    const again = await provisionMcp(g.machine, planOn(g.root), { ...o, landed: new Map() });
    expect(again.find(r => r.id === `${MCP_ID_PREFIX}codex/context7`)?.outcome).toBe("present");

    const out = await unmergeServers(machineServerPort(g.machine), g.root, { codex: logins });
    expect(out.find(x => x.path === join(logins, "config.toml"))?.names).toEqual(["context7"]);
    expect(readFileSync(join(logins, "config.toml"), "utf8")).toBe('model = "o4"\n');
  });

  it("lands the rest of an agent's own files under the store its threads there read, and leaves none of them under the home", async () => {
    const g = box();
    // The box's logins folder, which a Codex thread there reads as its CODEX_HOME.
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    const plan = codexStepPlan(g.root);
    const on = { home: g.root, stores: { codex: logins } };
    const rows = await provisionStep(g.machine, plan, "mcp", newSetupRun(), () => {}, on);
    const own = readFileSync(join(logins, "config.toml"), "utf8");
    expect(own).toContain('model = "gpt-5"');
    expect(CODEX_TOML.read(own, g.root).map(s => s.name)).toEqual(["context7"]);
    expect(readFileSync(join(logins, "AGENTS.md"), "utf8")).toBe(CODEX_AGENTS_MD);
    expect(readFileSync(join(logins, "prompts/review.md"), "utf8")).toBe(CODEX_PROMPT);
    expect(existsSync(join(g.root, ".codex"))).toBe(false);
    expect(rows.filter(r => r.kind === "file").map(r => [r.label, r.outcome])).toEqual([
      [`Codex ${logins}/config.toml`, "installed"],
      [`Codex ${logins}/AGENTS.md`, "installed"],
      [`Codex ${logins}/prompts`, "installed"],
    ]);

    // The next run reads them as wsp's own copies, and a sync that takes the prompts off takes them from the store.
    const again = await provisionStep(g.machine, plan, "mcp", newSetupRun(), () => {}, on);
    expect(again.filter(r => r.kind === "file").map(r => r.outcome)).toEqual(["present", "present", "present"]);
    expect(await unlandFiles(g.machine, g.root, [".codex/prompts"], on.stores)).toEqual({ gone: [".codex/prompts/review.md"], kept: [] });
    expect(existsSync(join(logins, "prompts"))).toBe(false);
    expect(existsSync(join(logins, "AGENTS.md"))).toBe(true);
  });

  it("moves the copies an earlier run left under the home into the store, a file the person wrote there since staying", async () => {
    const g = box();
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    const plan = codexStepPlan(g.root);
    await provisionStep(g.machine, plan, "mcp", newSetupRun(), () => {}, { home: g.root });
    writeFileSync(join(g.root, ".codex/prompts/mine.md"), "his own\n");
    await provisionStep(g.machine, plan, "mcp", newSetupRun(), () => {}, { home: g.root, stores: { codex: logins } });
    expect(readFileSync(join(logins, "AGENTS.md"), "utf8")).toBe(CODEX_AGENTS_MD);
    expect(existsSync(join(g.root, ".codex/AGENTS.md"))).toBe(false);
    expect(existsSync(join(g.root, ".codex/prompts/review.md"))).toBe(false);
    expect(readFileSync(join(g.root, ".codex/prompts/mine.md"), "utf8")).toBe("his own\n");
  });

  it("takes a dropped skill off under the home where the skills step landed it, on a box whose Claude reads a store of its own", async () => {
    const g = box();
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    const skill = ".claude/skills/why/SKILL.md";
    await landOnly(g, [{ path: skill, content: "# why\n" }]);
    expect(list(g.root).some(l => l.startsWith(`${skill}\t`))).toBe(true);
    const stores = { claude: join(g.root, ".claude-cfg"), codex: logins };
    expect(await unlandFiles(g.machine, g.root, [".claude/skills/why"], stores)).toEqual({ gone: [skill], kept: [] });
    expect(existsSync(join(g.root, ".claude/skills/why"))).toBe(false);
    expect(list(g.root).some(l => l.startsWith(`${skill}\t`))).toBe(false);
  });

  it("takes the copies an earlier run left under the home off with a Codex dropped before any run moved them", async () => {
    const g = box();
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    await landOnly(g, CODEX_OWN);
    writeFileSync(join(g.root, ".codex/prompts/mine.md"), "his own\n");
    const out = await unlandFiles(g.machine, g.root, [".codex/AGENTS.md", ".codex/prompts"], { codex: logins });
    expect(out).toEqual({ gone: [".codex/AGENTS.md", ".codex/prompts/review.md"], kept: [] });
    expect(existsSync(join(g.root, ".codex/AGENTS.md"))).toBe(false);
    expect(existsSync(join(g.root, ".codex/prompts/review.md"))).toBe(false);
    expect(readFileSync(join(g.root, ".codex/prompts/mine.md"), "utf8")).toBe("his own\n");
    expect(list(g.root).filter(l => l.startsWith(".codex/"))).toEqual([]);
  });

  it("moves an earlier copy into the store without taking the agent's own folder under the home", async () => {
    const g = box();
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    await landOnly(g, CODEX_OWN);
    await landOnly(g, CODEX_OWN, { codex: logins });
    expect(readFileSync(join(logins, "prompts/review.md"), "utf8")).toBe(CODEX_PROMPT);
    expect(existsSync(join(g.root, ".codex/prompts"))).toBe(false);
    expect(existsSync(join(g.root, ".codex"))).toBe(true);
  });

  it("takes every file wsp landed in a store off by the agent's folder alone, and leaves the store standing", async () => {
    const g = box();
    const logins = mkdtempSync(join(tmpdir(), "wsp-box-logins-"));
    g.dirs.push(logins);
    await landOnly(g, CODEX_OWN, { codex: logins });
    expect(await unlandFiles(g.machine, g.root, [".codex"], { codex: logins })).toEqual({ gone: [".codex/AGENTS.md", ".codex/prompts/review.md"], kept: [] });
    expect(existsSync(join(logins, "AGENTS.md"))).toBe(false);
    expect(existsSync(logins)).toBe(true);
    expect(list(g.root).filter(l => l.startsWith(".codex/"))).toEqual([]);
  });

  it("leaves a config that is on no computer to the merge itself, which skips its servers rather than writing a file nobody has", async () => {
    const { root, machine } = box();
    const rows = await provisionMcp(machine, planOn(root), { home: root, landed: new Map(), tools: [], stage: () => {}, path: TOOLS_PATH });
    expect(rows.every(r => r.outcome === "skipped")).toBe(true);
    expect(rows[0]!.note).toContain("Claude Code's config is not on the machine");
  });
});
