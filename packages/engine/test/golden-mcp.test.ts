// SPDX-License-Identifier: AGPL-3.0-only
// The MCP stage against a guest that is a temp directory: the merge script
// runs under this machine's node, the command checks and the uv install are
// canned, so the files it writes are the proof.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyMcp, mcpPlanFor, type McpPlan, type McpResult } from "../src/golden-mcp.js";
import { MCP_ID_PREFIX } from "@wsp/protocol";
import type { RecipeEntry } from "../src/golden-import.js";
import type { ToolResult } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";

const execFileAsync = promisify(execFile);
const HOME = "/Users/dev";

const row = (id: string, over: Partial<RecipeEntry> = {}): RecipeEntry => ({ rung: "agents", id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over });

const AGENTS = {
  claude: { label: "Claude Code", format: "claude" as const, files: ["/root/.claude-cfg/.claude.json"] },
  codex: { label: "Codex", format: "codex" as const, files: ["/root/.codex/config.toml"] },
  gemini: { label: "Gemini CLI", format: "gemini" as const, files: ["/root/.gemini/settings.json"] },
  opencode: { label: "OpenCode", format: "opencode" as const, files: ["/root/.config/opencode/opencode.json", "/root/.config/opencode/opencode.jsonc"] },
};

describe("mcpPlanFor", () => {
  it("keeps the ticked servers, drops the unticked with their reason, sets aside an agent that is not ticked, and moves the home scope", () => {
    const rows = [
      row("agents/claude"),
      row(`${MCP_ID_PREFIX}claude/github`),
      row(`${MCP_ID_PREFIX}claude/notes`, { bring: false, default: "skip", reason: "command ~/Library/x is macOS-only, will not run" }),
      row(`${MCP_ID_PREFIX}claude/old`, { bring: false }),
      row(`${MCP_ID_PREFIX}claude/home/zomato`),
      row("agents/codex", { bring: false }),
      row(`${MCP_ID_PREFIX}codex/grafana`),
      row(`${MCP_ID_PREFIX}mcp-remote`, { paths: ["~/.mcp-auth"] }),
      row("agents/gemini"),
      row("tools/go/codebase-memory-mcp", { rung: "tools" }),
      row("tools/brew/jq", { rung: "tools", bring: false, default: "skip", reason: "no Linux bottle" }),
      row("tools/brew-cask/iterm2", { rung: "tools", bring: false }),
      row("tools/hand/omp", { rung: "tools", bring: false, default: "skip", reason: "installed by hand; no Linux build known" }),
    ];
    expect(mcpPlanFor(rows, { home: HOME, agents: AGENTS })).toEqual<McpPlan>({
      agents: [
        {
          id: "claude", label: "Claude Code",
          scopes: [
            { files: AGENTS.claude.files, format: "claude", keep: ["github"], drop: [{ name: "notes", reason: "command ~/Library/x is macOS-only, will not run" }, { name: "old", reason: "unticked" }] },
            { files: AGENTS.claude.files, format: "claude", project: { from: HOME, to: "/root" }, keep: ["zomato"], drop: [] },
          ],
          aside: [],
        },
        { id: "codex", label: "Codex", scopes: [], aside: [{ id: `${MCP_ID_PREFIX}codex/grafana`, name: "grafana", reason: "Codex is not ticked, so its config did not travel" }] },
      ],
      guestHome: "/root",
      rewrites: [[`${HOME}/`, "/root/"], ["/opt/homebrew/", "/home/linuxbrew/.linuxbrew/"]],
      binDirs: [`${HOME}/.local/bin/`, "~/.local/bin/", "/opt/homebrew/bin/", "/opt/homebrew/sbin/"],
      tools: [{ id: "tools/go/codebase-memory-mcp", ticked: true }, { id: "tools/brew/jq", ticked: false, reason: "no Linux bottle" }, { id: "tools/hand/omp", ticked: false, reason: "installed by hand; no Linux build known" }],
    });
  });

  it("is nothing when the recipe has no MCP rows", () => {
    expect(mcpPlanFor([row("agents/claude")], { home: HOME, agents: AGENTS })).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A guest whose files are a temp directory and whose exec is this machine's bash, except the PATH checks and the uv install, which are canned. */
function guest(present: string[], canned: Record<string, ExecResult> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wsp-mcp-guest-"));
  dirs.push(root);
  const cmds: string[] = [];
  const runs: string[] = [];
  const exec = async (cmd: string): Promise<ExecResult> => {
    cmds.push(cmd);
    if (cmd.includes("astral-sh/uv/releases")) return canned.uv ?? { exitCode: 0, stdout: "", stderr: "" };
    if (cmd.includes("command -v")) {
      const asked = [...cmd.matchAll(/command -v '([^']*)'/g)].map(m => m[1]!);
      return { exitCode: 0, stdout: asked.map(c => `${present.includes(c) ? "ok" : "no"} ${c}`).join("\n"), stderr: "" };
    }
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], { env: { ...process.env, PATH: `${join(process.execPath, "..")}:${process.env.PATH ?? ""}` } });
      return { exitCode: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };
  const machine = {
    id: "m1", kind: "sandbox", exec,
    run: (script: string) => {
      runs.push(script);
      return exec(script);
    },
  } as unknown as Machine;
  return { root, cmds, runs, machine };
}

const CLAUDE = {
  numStartups: 3,
  mcpServers: {
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_secret" } },
    gsc: { command: "uvx", args: ["mcp-search-console"], env: { GSC_CREDENTIALS_PATH: `${HOME}/.config/gsc/creds.json` } },
    notes: { command: `${HOME}/Library/Application Support/Notes/mcp`, args: [] },
    survivor: { command: "survivor-bin", args: [] },
  },
  projects: {
    [HOME]: { allowedTools: ["Bash"], mcpServers: { zomato: { type: "stdio", command: "npx", args: ["mcp-remote", "https://mcp.zomato.com/mcp"] }, whatsapp: { command: `${HOME}/.local/bin/uv`, args: ["--directory", `${HOME}/code/wa`, "run", "main.py"] } } },
  },
};

const CODEX = [
  'model = "gpt-5"',
  "",
  "[mcp_servers.grafana]",
  'command = "/opt/homebrew/bin/uvx"',
  'args = ["mcp-grafana", "--config=/Users/dev/.config/grafana.toml", "/Users/dev/tab\\there"]',
  'note = "keep \\u00e9 \\"quoted\\" and\\ttab"',
  "",
  "[mcp_servers.grafana.env]",
  'GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_x" # keep the comment',
  "",
  "[mcp_servers.sentry]",
  'url = "https://mcp.sentry.dev/mcp"',
  'bearer_token_env_var = "SENTRY_TOKEN"',
  "",
  "[mcp_servers.keeper]",
  'command = "keeper"',
  "",
  "[[hooks.SessionStart]]",
  'matcher = "x"',
  "",
].join("\n");

const GEMINI = '{\n  // servers\n  "mcpServers": { "memory": { "command": "~/.local/bin/codebase-memory-mcp" }, "gone": { "command": "/Applications/X.app/x" } },\n  "theme": "dark"\n}\n';

function planOn(root: string, over: Partial<McpPlan> = {}): McpPlan {
  const file = (rel: string): string => join(root, rel);
  return {
    agents: [
      {
        id: "claude", label: "Claude Code",
        scopes: [
          { files: [file(".claude-cfg/.claude.json")], format: "claude", keep: ["github", "gsc"], drop: [{ name: "notes", reason: "command ~/Library/Application Support/Notes/mcp is macOS-only, will not run" }] },
          { files: [file(".claude-cfg/.claude.json")], format: "claude", project: { from: HOME, to: root }, keep: ["zomato", "whatsapp"], drop: [] },
        ],
        aside: [],
      },
      { id: "codex", label: "Codex", scopes: [{ files: [file(".codex/config.toml")], format: "codex", keep: ["grafana"], drop: [{ name: "sentry", reason: "unticked" }] }], aside: [] },
      { id: "gemini", label: "Gemini CLI", scopes: [{ files: [file(".gemini/settings.json")], format: "gemini", keep: ["memory"], drop: [{ name: "gone", reason: "path /Applications/X.app/x is macOS-only, will not run" }] }], aside: [] },
      { id: "opencode", label: "OpenCode", scopes: [{ files: [file(".config/opencode/opencode.json")], format: "opencode", keep: ["ctx"], drop: [] }], aside: [{ id: `${MCP_ID_PREFIX}opencode/late`, name: "late", reason: "OpenCode is not ticked, so its config did not travel" }] },
    ],
    guestHome: root,
    rewrites: [[`${HOME}/`, `${root}/`], ["/opt/homebrew/", "/home/linuxbrew/.linuxbrew/"]],
    binDirs: [`${HOME}/.local/bin/`, "~/.local/bin/", "/opt/homebrew/bin/", "/opt/homebrew/sbin/"],
    tools: [],
    ...over,
  };
}

function seed(root: string): void {
  mkdirSync(join(root, ".claude-cfg"), { recursive: true });
  writeFileSync(join(root, ".claude-cfg", ".claude.json"), `${JSON.stringify(CLAUDE, null, 2)}\n`);
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), CODEX);
  mkdirSync(join(root, ".gemini"), { recursive: true });
  writeFileSync(join(root, ".gemini", "settings.json"), GEMINI);
}

describe("applyMcp", () => {
  it("writes the kept definitions with their paths rewritten, drops the unticked, leaves a server it never heard of alone, and names each on the stage", async () => {
    const { root, cmds, runs, machine } = guest(["npx", "codebase-memory-mcp"]);
    seed(root);
    const stages: string[] = [];
    const results = await applyMcp(machine, planOn(root), (s, d) => void stages.push(`${s}:${d ?? ""}`));
    // The script runs twice detached, once to read the commands and once to write; the PATH check between them is one short exec.
    expect(runs).toHaveLength(3);
    expect(runs[0]).toContain("\nnode -e ");
    expect(runs[1]).toContain("\nnode -e ");
    expect(runs[2]).toContain("astral-sh/uv/releases");
    expect(runs[2]).toContain("\nsetsid bash -c '");
    const check = cmds.find(c => c.split("\n")[1]?.startsWith("if command -v"))!;
    expect(check).toBeDefined();
    expect(runs).not.toContain(check);

    const claude = JSON.parse(readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8"));
    expect(claude.numStartups).toBe(3);
    expect(Object.keys(claude.mcpServers)).toEqual(["github", "gsc", "survivor"]);
    expect(claude.mcpServers.github).toEqual(CLAUDE.mcpServers.github);
    expect(claude.mcpServers.gsc.env.GSC_CREDENTIALS_PATH).toBe(`${root}/.config/gsc/creds.json`);
    // Servers local to the laptop's home folder now belong to the machine's; the rest of the laptop project entry stays.
    expect(claude.projects[HOME]).toEqual({ allowedTools: ["Bash"], mcpServers: {} });
    expect(claude.projects[root].mcpServers).toEqual({
      zomato: CLAUDE.projects[HOME].mcpServers.zomato,
      whatsapp: { command: "uv", args: ["--directory", `${root}/code/wa`, "run", "main.py"] },
    });

    const codex = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(codex).toBe([
      'model = "gpt-5"',
      "",
      "[mcp_servers.grafana]",
      'command = "uvx"',
      // A rewritten string keeps its escapes; one the rewrite never touched is left byte for byte.
      `args = ["mcp-grafana", "--config=${root}/.config/grafana.toml", "${root}/tab\\there"]`,
      'note = "keep \\u00e9 \\"quoted\\" and\\ttab"',
      "",
      "[mcp_servers.grafana.env]",
      'GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_x" # keep the comment',
      "",
      "[mcp_servers.keeper]",
      'command = "keeper"',
      "",
      "[[hooks.SessionStart]]",
      'matcher = "x"',
      "",
    ].join("\n"));

    expect(JSON.parse(readFileSync(join(root, ".gemini", "settings.json"), "utf8"))).toEqual({ mcpServers: { memory: { command: "codebase-memory-mcp" } }, theme: "dark" });

    // A definition whose package npx or uv pulls down when the agent first starts it is in place, not installed.
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}claude/github`, agent: "Claude Code", name: "github", outcome: "fetched-on-first-use", note: "npx fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}claude/gsc`, agent: "Claude Code", name: "gsc", outcome: "fetched-on-first-use", note: "uv installed for it; uv fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}claude/notes`, agent: "Claude Code", name: "notes", outcome: "skipped", note: "command ~/Library/Application Support/Notes/mcp is macOS-only, will not run" },
      { id: `${MCP_ID_PREFIX}claude/home/zomato`, agent: "Claude Code", name: "zomato", outcome: "fetched-on-first-use", note: "npx fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}claude/home/whatsapp`, agent: "Claude Code", name: "whatsapp", outcome: "fetched-on-first-use", note: "uv installed for it; uv fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}codex/grafana`, agent: "Codex", name: "grafana", outcome: "fetched-on-first-use", note: "uv installed for it; uv fetches the package on first use" },
      { id: `${MCP_ID_PREFIX}codex/sentry`, agent: "Codex", name: "sentry", outcome: "skipped", note: "unticked" },
      { id: `${MCP_ID_PREFIX}gemini/memory`, agent: "Gemini CLI", name: "memory", outcome: "installed" },
      { id: `${MCP_ID_PREFIX}gemini/gone`, agent: "Gemini CLI", name: "gone", outcome: "skipped", note: "path /Applications/X.app/x is macOS-only, will not run" },
      { id: `${MCP_ID_PREFIX}opencode/ctx`, agent: "OpenCode", name: "ctx", outcome: "skipped", note: "OpenCode's config is not on the machine" },
      { id: `${MCP_ID_PREFIX}opencode/late`, agent: "OpenCode", name: "late", outcome: "skipped", note: "OpenCode is not ticked, so its config did not travel" },
    ]);
    expect(stages).toEqual([
      "installing-mcp:Claude Code 5, Codex 2, Gemini CLI 2, OpenCode 2",
      "installing-mcp:uv for gsc, whatsapp, grafana",
      "installing-mcp:memory installed; github, zomato: package fetched on first use by npx; gsc, whatsapp, grafana: uv installed, package fetched on first use by uv; notes skipped (command ~/Library/Application Support/Notes/mcp is macOS-only, will not run); sentry skipped (unticked); gone skipped (path /Applications/X.app/x is macOS-only, will not run); ctx skipped (OpenCode's config is not on the machine); late skipped (OpenCode is not ticked, so its config did not travel)",
    ]);
    // Every command is looked for once on the machine's PATH; uv, found missing, is installed by its checksummed release.
    const checks = cmds.filter(c => c.includes("command -v '"));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/command -v 'npx'.*command -v 'uvx'.*command -v 'uv'.*command -v 'codebase-memory-mcp'/s);
    expect(cmds.filter(c => c.includes("astral-sh/uv/releases"))).toHaveLength(1);
    expect(cmds.indexOf(checks[0]!)).toBeLessThan(cmds.findIndex(c => c.includes("astral-sh/uv/releases")));
    expect(cmds.some(c => c.includes("ghp_secret"))).toBe(false);
  });

  const geminiOnly = (root: string, over: Partial<McpPlan> = {}): McpPlan =>
    planOn(root, { agents: [{ id: "gemini", label: "Gemini CLI", scopes: [{ files: [join(root, ".gemini/settings.json")], format: "gemini", keep: ["memory", "vanished"], drop: [] }], aside: [] }], ...over });
  const geminiServers = (root: string): string[] => Object.keys(JSON.parse(readFileSync(join(root, ".gemini/settings.json"), "utf8")).mcpServers);

  it("a server whose command is not on the machine is taken out of the config and skipped with the reason; a kept server the config no longer holds is named", async () => {
    const { root, machine } = guest(["npx"]);
    seed(root);
    const stages: string[] = [];
    const results = await applyMcp(machine, geminiOnly(root), (s, d) => void stages.push(d ?? s));
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}gemini/vanished`, agent: "Gemini CLI", name: "vanished", outcome: "skipped", note: "not in the config that travelled" },
      { id: `${MCP_ID_PREFIX}gemini/memory`, agent: "Gemini CLI", name: "memory", outcome: "skipped", note: "command not on the machine" },
    ]);
    expect(geminiServers(root)).toEqual(["gone"]);
    expect(stages.at(-1)).toBe("vanished skipped (not in the config that travelled); memory skipped (command not on the machine)");
  });

  it("a server whose command is on the machine is written and installed", async () => {
    const { root, machine } = guest(["codebase-memory-mcp"]);
    seed(root);
    const results = await applyMcp(machine, geminiOnly(root), () => {});
    expect(results[0]).toEqual({ id: `${MCP_ID_PREFIX}gemini/memory`, agent: "Gemini CLI", name: "memory", outcome: "installed" });
    expect(geminiServers(root)).toEqual(["memory", "gone"]);
  });

  it("a server that runs through npx is written even when npx is not on the machine yet", async () => {
    const { root, machine } = guest([]);
    seed(root);
    const plan = planOn(root, { agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: [join(root, ".claude-cfg/.claude.json")], format: "claude", keep: ["github"], drop: [] }], aside: [] }] });
    const results = await applyMcp(machine, plan, () => {});
    expect(results).toEqual<McpResult[]>([
      { id: `${MCP_ID_PREFIX}claude/github`, agent: "Claude Code", name: "github", outcome: "fetched-on-first-use", note: "npx fetches the package on first use; npx is not on the machine; the server starts once it is installed there" },
    ]);
    expect(Object.keys(JSON.parse(readFileSync(join(root, ".claude-cfg/.claude.json"), "utf8")).mcpServers)).toContain("github");
  });

  it("the reason names the recipe's tool row that would have brought the command, and what became of it", async () => {
    const cases: { row: McpPlan["tools"][number]; result?: ToolResult; note: string }[] = [
      { row: { id: "tools/go/codebase-memory-mcp", ticked: true }, result: { id: "tools/go/codebase-memory-mcp", label: "codebase-memory-mcp", outcome: "skipped", note: "1803 MB free, keeping 2048 MB free" }, note: "command not on the machine; tools/go/codebase-memory-mcp was skipped (1803 MB free, keeping 2048 MB free)" },
      { row: { id: "tools/go/codebase-memory-mcp", ticked: true }, result: { id: "tools/go/codebase-memory-mcp", label: "codebase-memory-mcp", outcome: "failed", note: "exit 1: go: module not found" }, note: "command not on the machine; tools/go/codebase-memory-mcp failed (exit 1: go: module not found)" },
      { row: { id: "tools/brew/codebase-memory-mcp", ticked: false, reason: "no Linux bottle" }, note: "command not on the machine; tools/brew/codebase-memory-mcp was not ticked (no Linux bottle)" },
      { row: { id: "tools/cargo/codebase-memory-mcp", ticked: false }, note: "command not on the machine; tools/cargo/codebase-memory-mcp was not ticked" },
      { row: { id: "tools/npm/codebase-memory-mcp", ticked: true }, note: "command not on the machine; tools/npm/codebase-memory-mcp was ticked, but nothing by that name is on PATH" },
      { row: { id: "tools/go/other-bin", ticked: true }, result: { id: "tools/go/other-bin", label: "other-bin", outcome: "skipped", note: "1803 MB free, keeping 2048 MB free" }, note: "command not on the machine" },
    ];
    for (const c of cases) {
      const { root, machine } = guest(["npx"]);
      seed(root);
      const results = await applyMcp(machine, geminiOnly(root, { tools: [c.row] }), () => {}, c.result !== undefined ? [c.result] : []);
      expect(results.find(r => r.name === "memory")?.note).toBe(c.note);
    }
  });

  it("running twice leaves the files as they were after the first run and reports the same, the moved home servers included", async () => {
    const { root, machine } = guest(["npx", "uv", "codebase-memory-mcp"]);
    seed(root);
    const first = await applyMcp(machine, planOn(root), () => {});
    const after = [".claude-cfg/.claude.json", ".codex/config.toml", ".gemini/settings.json"].map(f => readFileSync(join(root, f), "utf8"));
    const second = await applyMcp(machine, planOn(root), () => {});
    expect([".claude-cfg/.claude.json", ".codex/config.toml", ".gemini/settings.json"].map(f => readFileSync(join(root, f), "utf8"))).toEqual(after);
    expect(second).toEqual(first);
    expect(second.filter(r => r.name === "zomato" || r.name === "whatsapp").map(r => r.outcome)).toEqual(["fetched-on-first-use", "fetched-on-first-use"]);
  });

  it("a failed uv install is named on every server that needed it, and the definitions still land", async () => {
    const { root, machine } = guest(["npx"], { uv: { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" } });
    seed(root);
    const results = await applyMcp(machine, planOn(root), () => {});
    expect(results.find(r => r.name === "gsc")).toEqual({ id: `${MCP_ID_PREFIX}claude/gsc`, agent: "Claude Code", name: "gsc", outcome: "fetched-on-first-use", note: "uv did not install (curl: (6) Could not resolve host); the server starts once it is installed there; uv fetches the package on first use" });
    expect(Object.keys(JSON.parse(readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8")).mcpServers)).toEqual(["github", "gsc", "survivor"]);
  });
});
