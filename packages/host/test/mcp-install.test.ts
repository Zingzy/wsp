// SPDX-License-Identifier: AGPL-3.0-only
// Installing the MCP server into a local agent's config: the command that
// runs this same wsp against this state file, placed by the catalog entry's
// own config module under the person's home.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP, cli, type CliIO } from "../src/cli.js";
import { installEach, installLines, installMcp, mcpServerSpec } from "../src/mcp-install.js";
import { WSP_SKILL } from "../src/skill.js";

const PROC = { execPath: "/opt/node/bin/node", execArgv: ["--disable-warning=ExperimentalWarning"], argv: ["/opt/node/bin/node", "/opt/wsp/dist/bin.js", "mcp", "install"] };

function io(): CliIO & { lines: string[]; errors: string[] } {
  const out = {
    lines: [] as string[],
    errors: [] as string[],
    log: (l: string) => out.lines.push(l),
    error: (l: string) => out.errors.push(l),
    ask: () => Promise.reject(new Error("no prompt")),
    askSecret: () => Promise.reject(new Error("no prompt")),
  };
  return out;
}

describe("installing the MCP server for a local agent", () => {
  let home: string;
  let statePath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-mcp-home-"));
    statePath = join(home, ".wsp", "state.json");
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("the server's command is this same wsp, run the way it was started, against this state file, wherever the agent's cwd is", () => {
    expect(mcpServerSpec(statePath, PROC)).toEqual({
      command: "/opt/node/bin/node",
      args: ["--disable-warning=ExperimentalWarning", "/opt/wsp/dist/bin.js", "mcp", "--state", statePath],
    });
  });

  it("places the server in the agent's config file under the home, creating the file and its folder, and says where", () => {
    const spec = mcpServerSpec(statePath, PROC);
    expect(installMcp("claude", spec, home)).toEqual({ agent: "Claude Code", path: "~/.claude.json", commentsDropped: false, skill: "~/.claude/skills/wsp/SKILL.md" });
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { wsp: { command: spec.command, args: spec.args } } });
    expect(installMcp("codex", spec, home)).toEqual({ agent: "Codex", path: "~/.codex/config.toml", commentsDropped: false, skill: "~/.codex/skills/wsp/SKILL.md" });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.wsp]\n");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), '{ "theme": "dark" }\n');
    installMcp("gemini", spec, home);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"))).toEqual({ theme: "dark", mcpServers: { wsp: { command: spec.command, args: spec.args } } });
  });

  it("an agent whose config is a jsonc file with comments gets the server placed in that file, its other servers kept", () => {
    const spec = mcpServerSpec(statePath, PROC);
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), '{\n  // mine\n  "mcp": { "other": { "type": "remote", "url": "https://ctx.example/mcp" }, },\n}\n');
    expect(installMcp("opencode", spec, home)).toEqual({ agent: "OpenCode", path: "~/.config/opencode/opencode.jsonc", commentsDropped: true, skill: "~/.config/opencode/skills/wsp/SKILL.md" });
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"))).toEqual({
      mcp: { other: { type: "remote", url: "https://ctx.example/mcp" }, wsp: { type: "local", command: [spec.command, ...spec.args], enabled: true } },
    });
  });

  it("the skill lands in the agent's skills folder under the home, the repo's file as it is, and a second install replaces an older copy", () => {
    const spec = mcpServerSpec(statePath, PROC);
    installMcp("claude", spec, home);
    installMcp("codex", spec, home);
    expect(readFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    expect(readFileSync(join(home, ".codex", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    expect(WSP_SKILL.startsWith("---\nname: wsp\n")).toBe(true);
    writeFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "old\n");
    installMcp("claude", spec, home);
    expect(readFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
  });

  it("an agent the catalog has no MCP config for gets the skill and no config path; an agent it does not know is refused in one line", () => {
    const spec = mcpServerSpec(statePath, PROC);
    expect(installMcp("pi", spec, home)).toEqual({ agent: "Pi", skill: "~/.pi/agent/skills/wsp/SKILL.md" });
    expect(installMcp("hermes", spec, home)).toEqual({ agent: "Hermes Agent", skill: "~/.hermes/skills/wsp/SKILL.md" });
    expect(() => installMcp("emacs", spec, home)).toThrow("no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode");
    expect(readFileSync(join(home, ".pi", "agent", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    expect(readFileSync(join(home, ".hermes", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    expect(existsSync(join(home, ".pi", "agent", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".hermes", "config.yaml"))).toBe(false);
  });

  it("several --agent are installed in turn and one bad id costs the others nothing; the report names each by its catalog id", () => {
    const spec = mcpServerSpec(statePath, PROC);
    const report = installEach(["claude", "emacs", "pi"], spec, home);
    expect(report).toEqual({
      installed: [
        { id: "claude", agent: "Claude Code", path: "~/.claude.json", commentsDropped: false, skill: "~/.claude/skills/wsp/SKILL.md" },
        { id: "pi", agent: "Pi", skill: "~/.pi/agent/skills/wsp/SKILL.md" },
      ],
      failures: [{ id: "emacs", error: "no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode" }],
    });
    expect(existsSync(join(home, ".claude.json"))).toBe(true);
    expect(readFileSync(join(home, ".pi", "agent", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
  });

  it("wsp mcp install --json prints the report as one JSON line and nothing else, and exits 1 when an agent failed", async () => {
    const out = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--agent", "codex", "--json", "--state", statePath], out)).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(out.errors).toEqual([]);
    expect(JSON.parse(out.lines[0]!)).toEqual({
      installed: [
        { id: "claude", agent: "Claude Code", path: "~/.claude.json", commentsDropped: false, skill: "~/.claude/skills/wsp/SKILL.md" },
        { id: "codex", agent: "Codex", path: "~/.codex/config.toml", commentsDropped: false, skill: "~/.codex/skills/wsp/SKILL.md" },
      ],
      failures: [],
    });
    const partial = io();
    expect(await cli(["mcp", "install", "--agent", "emacs", "--agent", "gemini", "--json", "--state", statePath], partial)).toBe(1);
    expect(partial.errors).toEqual([]);
    const report = JSON.parse(partial.lines[0]!) as { installed: Array<{ id: string }>; failures: Array<{ id: string; error: string }> };
    expect(report.installed.map(i => i.id)).toEqual(["gemini"]);
    expect(report.failures).toEqual([{ id: "emacs", error: "no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode" }]);
    expect(readFileSync(join(home, ".gemini", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    expect(HELP).toContain("--json");
  });

  it("--agent belongs to mcp install alone, a command with no JSON to print refuses --json, and mcp --help says its own usage", async () => {
    // recipe and init are not on this list: recipe prints a table, and --json is that table as one object; init prints
    // each sign-in hand-off, and --json is those as one object per line.
    for (const cmd of ["up", "doctor"]) {
      const out = io();
      expect(await cli([cmd, "--json", "--state", statePath], out), cmd).toBe(1);
      expect(out.errors[0], cmd).toContain("Unknown option '--json'");
      expect(out.lines, cmd).toEqual([]);
    }
    const agented = io();
    expect(await cli(["up", "--agent", "claude", "--state", statePath], agented)).toBe(1);
    expect(agented.errors[0]).toContain("Unknown option '--agent'");
    const help = io();
    expect(await cli(["mcp", "--help", "--state", statePath], help)).toBe(0);
    expect(help.lines).toEqual(["usage: wsp mcp\n       wsp mcp install --agent <id> [--agent <id>] [--json]   (claude, codex, gemini, opencode)"]);
    const stray = io();
    expect(await cli(["mcp", "install", "--nope", "--state", statePath], stray)).toBe(1);
    expect(stray.errors[0]).toContain("Unknown option '--nope'");
    // recipe parses its own flags for the same reason, so --json reaches it and --agent never does.
    const recipeAgent = io();
    expect(await cli(["recipe", "--agent", "claude", "--state", statePath], recipeAgent)).toBe(1);
    expect(recipeAgent.errors[0]).toContain("Unknown option '--agent'");
    expect(recipeAgent.errors[0]).toContain("usage: wsp recipe");
    const recipeHelp = io();
    expect(await cli(["recipe", "--help", "--state", statePath], recipeHelp)).toBe(0);
    expect(recipeHelp.lines[0]).toMatch(/^usage: wsp recipe \[--tick used\|installed\|default\]/);
  });

  it("a line that puts a flag before the word gets mcp's own usage, the way a verb's line gets its verb's", async () => {
    const flagFirst = io();
    expect(await cli(["--state", statePath, "mcp"], flagFirst)).toBe(1);
    expect(flagFirst.errors).toEqual(["usage: wsp mcp\n       wsp mcp install --agent <id> [--agent <id>] [--json]   (claude, codex, gemini, opencode)"]);
    expect(flagFirst.lines).toEqual([]);
    const verbLine = io();
    expect(await cli(["--state", statePath, "threads"], verbLine)).toBe(1);
    expect(verbLine.errors[0]).toContain("usage: wsp threads");
    const nonsense = io();
    expect(await cli(["--state", statePath, "nope"], nonsense)).toBe(1);
    expect(nonsense.errors[0]).toContain("unknown command: nope");
  });

  it("what an install says: the agent and its file, the dropped-comments line when the rewrite lost them, the by-hand line when the server was not written, and where the skill went", () => {
    expect(installLines({ agent: "Claude Code", path: "~/.claude.json", commentsDropped: false, skill: "~/.claude/skills/wsp/SKILL.md" })).toEqual(["Claude Code now has the wsp tools: ~/.claude.json", "The wsp skill went to ~/.claude/skills/wsp/SKILL.md"]);
    expect(installLines({ agent: "Gemini CLI", path: "~/.gemini/settings.json", commentsDropped: true, skill: "~/.gemini/skills/wsp/SKILL.md" })).toEqual(["Gemini CLI now has the wsp tools: ~/.gemini/settings.json", "The file held comments; the rewrite is plain JSON, so they are gone.", "The wsp skill went to ~/.gemini/skills/wsp/SKILL.md"]);
    expect(installLines({ agent: "Pi", skill: "~/.pi/agent/skills/wsp/SKILL.md" })).toEqual(["Pi: the catalog has no MCP config for it yet, so the server was not written; add it by hand.", "The wsp skill went to ~/.pi/agent/skills/wsp/SKILL.md"]);
  });

  it("wsp mcp install --agent <id> writes the config for this state file and prints one line; without --agent it prints the usage", async () => {
    const out = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--state", statePath], out)).toBe(0);
    expect(out.lines).toEqual(["Claude Code now has the wsp tools: ~/.claude.json", "The wsp skill went to ~/.claude/skills/wsp/SKILL.md"]);
    expect(readFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    const written = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: { wsp: { command: string; args: string[] } } };
    expect(written.mcpServers.wsp.command).toBe(process.execPath);
    expect(written.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", statePath]);
    const bare = io();
    expect(await cli(["mcp", "install", "--state", statePath], bare)).toBe(1);
    expect(bare.errors).toEqual(["usage: wsp mcp install --agent <id> [--agent <id>] [--json]   (claude, codex, gemini, opencode)"]);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), '{\n  // the look\n  "theme": "dark"\n}\n');
    const commented = io();
    expect(await cli(["mcp", "install", "--agent", "gemini", "--state", statePath], commented)).toBe(0);
    expect(commented.lines).toEqual(["Gemini CLI now has the wsp tools: ~/.gemini/settings.json", "The file held comments; the rewrite is plain JSON, so they are gone.", "The wsp skill went to ~/.gemini/skills/wsp/SKILL.md"]);
    const none = io();
    expect(await cli(["mcp", "install", "--agent", "pi", "--state", statePath], none)).toBe(0);
    expect(none.lines).toEqual(["Pi: the catalog has no MCP config for it yet, so the server was not written; add it by hand.", "The wsp skill went to ~/.pi/agent/skills/wsp/SKILL.md"]);
    expect(none.errors).toEqual([]);
    const unknown = io();
    expect(await cli(["mcp", "install", "--agent", "emacs", "--state", statePath], unknown)).toBe(1);
    expect(unknown.errors).toEqual(["wsp mcp install: no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode"]);
    expect(HELP).toContain("wsp mcp");
  });
});
