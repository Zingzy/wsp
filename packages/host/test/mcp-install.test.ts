// SPDX-License-Identifier: AGPL-3.0-only
// Installing the MCP server into a local agent's config: the command that
// runs this same wsp against this state file, placed by the catalog entry's
// own config module under the person's home, the skill beside it, and wsp's
// own section in the instructions the folder the command ran in keeps.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { mcpServerCommandLine, nextInsideAgentLine } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP, JSON_COMMANDS, PROSE_COMMANDS, cli, type CliIO } from "../src/cli.js";
import { SECTION_BEGIN, sectionText } from "../src/agents-md.js";
import { agentsOnPath, installEach, installLines, installMcp, mcpServerSpec, removeLines, runningWsp, type RunningWsp } from "../src/mcp-install.js";
import { SKILL_NAME, WSP_SKILL } from "../src/skill.js";
import { VERSION } from "../src/version.js";

/** wsp run from a checkout: node given the bundle's path, and no wsp on PATH is that file. */
const PROC: RunningWsp = { execPath: "/opt/node/bin/node", execArgv: ["--disable-warning=ExperimentalWarning"], argv: ["/opt/node/bin/node", "/opt/wsp/dist/bin.js", "mcp", "install"], version: "0.1.2", PATH: "/usr/bin:/bin" };

/** The command line the install prints for the spec it registered. */
const commandLine = (spec: { command: string; args: readonly string[] }): string => mcpServerCommandLine(spec.command, spec.args);

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
  /** The folder the command line runs in, which is the project whose instructions take wsp's section. */
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-mcp-home-"));
    statePath = join(home, ".wsp", "state.json");
    project = mkdtempSync(join(tmpdir(), "wsp-mcp-project-"));
    vi.stubEnv("HOME", home);
    vi.spyOn(process, "cwd").mockReturnValue(project);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("run out of npx's cache, the server's command is the npx beside this node with this version pinned, never the cache path, whatever wsp PATH holds; bare npx only when none sits there", () => {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "wsp"), "#!/usr/bin/env node\n");
    mkdirSync(join(home, "node", "bin"), { recursive: true });
    writeFileSync(join(home, "node", "bin", "npx"), "#!/usr/bin/env node\n");
    const cached = join(home, ".npm", "_npx", "ee7519ab73f4721e", "node_modules", ".bin", "wsp");
    const npx: RunningWsp = { ...PROC, execPath: join(home, "node", "bin", "node"), argv: [join(home, "node", "bin", "node"), cached, "mcp", "install"], PATH: `${join(home, "bin")}:/usr/bin` };
    expect(mcpServerSpec(statePath, npx)).toEqual({ command: join(home, "node", "bin", "npx"), args: ["-y", "@zingzy/wsp@0.1.2", "mcp", "--state", statePath] });
    const resolved = { ...npx, argv: [npx.execPath, join(home, ".npm", "_npx", "ee7519ab73f4721e", "node_modules", "@zingzy", "wsp", "dist", "bin.js")] };
    expect(mcpServerSpec(statePath, resolved).command).toBe(join(home, "node", "bin", "npx"));
    const bareNode: RunningWsp = { ...npx, execPath: "/opt/node/bin/node", argv: ["/opt/node/bin/node", cached] };
    expect(mcpServerSpec(statePath, bareNode)).toEqual({ command: "npx", args: ["-y", "@zingzy/wsp@0.1.2", "mcp", "--state", statePath] });
  });

  it("the default reading of the process is this node, its flags and argv, its PATH and the running package's version, the one an npx pin names", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(runningWsp()).toEqual({ execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, version: VERSION, PATH: process.env.PATH });
    expect(mcpServerSpec(statePath)).toEqual(mcpServerSpec(statePath, runningWsp()));
  });

  it("run as the wsp on PATH, the server's command is that binary and the word mcp, through a symlinked PATH folder too", () => {
    mkdirSync(join(home, ".local", "lib", "node_modules", "@zingzy", "wsp", "dist"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "lib", "node_modules", "@zingzy", "wsp", "dist", "bin.js"), "#!/usr/bin/env node\n");
    symlinkSync("../lib/node_modules/@zingzy/wsp/dist/bin.js", join(home, ".local", "bin", "wsp"));
    const bin = join(home, ".local", "bin", "wsp");
    const global: RunningWsp = { ...PROC, argv: ["/opt/node/bin/node", bin, "mcp", "install"], PATH: `/usr/bin:${join(home, ".local", "bin")}` };
    expect(mcpServerSpec(statePath, global)).toEqual({ command: bin, args: ["mcp", "--state", statePath] });
    symlinkSync(join(home, ".local", "bin"), join(home, "link"));
    const linked = { ...global, PATH: `${join(home, "link")}:/usr/bin` };
    expect(mcpServerSpec(statePath, linked)).toEqual({ command: join(home, "link", "wsp"), args: ["mcp", "--state", statePath] });
  });

  it("run any other way, the server's command is this node with the flags and script it was started with, against this state file, wherever the agent's cwd is", () => {
    const node = { command: "/opt/node/bin/node", args: ["--disable-warning=ExperimentalWarning", "/opt/wsp/dist/bin.js", "mcp", "--state", statePath] };
    expect(mcpServerSpec(statePath, PROC)).toEqual(node);
    // A wsp on PATH that is not the one running does not get registered over it.
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "wsp"), "#!/usr/bin/env node\n");
    expect(mcpServerSpec(statePath, { ...PROC, PATH: `${join(home, "bin")}:/usr/bin` })).toEqual(node);
    expect(mcpServerSpec(statePath, { ...PROC, PATH: undefined })).toEqual(node);
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
      server: spec,
      installed: [
        { id: "claude", agent: "Claude Code", path: "~/.claude.json", commentsDropped: false, skill: "~/.claude/skills/wsp/SKILL.md" },
        { id: "pi", agent: "Pi", skill: "~/.pi/agent/skills/wsp/SKILL.md" },
      ],
      failures: [{ id: "emacs", error: "no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode" }],
    });
    expect(existsSync(join(home, ".claude.json"))).toBe(true);
    expect(readFileSync(join(home, ".pi", "agent", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
  });

  it("wsp mcp install --json prints the report as one JSON line and nothing else, the registered command in it, and exits 1 when an agent failed", async () => {
    const out = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--agent", "codex", "--json", "--state", statePath], out)).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(out.errors).toEqual([]);
    expect(JSON.parse(out.lines[0]!)).toEqual({
      server: mcpServerSpec(statePath),
      installed: [
        { id: "claude", agent: "Claude Code", path: "~/.claude.json", commentsDropped: false, skill: "~/.claude/skills/wsp/SKILL.md", docs: [join(project, "AGENTS.md"), join(project, "CLAUDE.md")] },
        { id: "codex", agent: "Codex", path: "~/.codex/config.toml", commentsDropped: false, skill: "~/.codex/skills/wsp/SKILL.md", docs: [join(project, "AGENTS.md")] },
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
    // Which shared-parse commands print JSON is the command table's fact: init prints each sign-in hand-off as one
    // object per line and takes the flag; recipe parses its own flags and prints its table as one object.
    expect(PROSE_COMMANDS).toEqual(["up", "down", "status", "doctor"]);
    expect(JSON_COMMANDS).toEqual(["init"]);
    for (const cmd of PROSE_COMMANDS) {
      const out = io();
      expect(await cli([cmd, "--json", "--state", statePath], out), cmd).toBe(1);
      expect(out.errors[0], cmd).toContain("Unknown option '--json'");
      expect(out.lines, cmd).toEqual([]);
    }
    for (const cmd of JSON_COMMANDS) {
      // --yes beside --json is init's own refusal, so the flag reached the command instead of the parse turning it away.
      const out = io();
      expect(await cli([cmd, "--json", "--yes", "--state", statePath], out), cmd).toBe(1);
      expect(out.errors[0], cmd).not.toContain("Unknown option");
      expect(out.errors[0], cmd).toContain("--json");
    }
    const agented = io();
    expect(await cli(["up", "--agent", "claude", "--state", statePath], agented)).toBe(1);
    expect(agented.errors[0]).toContain("Unknown option '--agent'");
    const help = io();
    expect(await cli(["mcp", "--help", "--state", statePath], help)).toBe(0);
    expect(help.lines).toEqual(["usage: wsp mcp\n       wsp mcp install --agent <id> [--agent <id>] [--json] [--remove]   (claude, codex, gemini, opencode)"]);
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
    expect(flagFirst.errors).toEqual(["usage: wsp mcp\n       wsp mcp install --agent <id> [--agent <id>] [--json] [--remove]   (claude, codex, gemini, opencode)"]);
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
    expect(installLines({ agent: "Codex", path: "~/.codex/config.toml", commentsDropped: false, skill: "~/.codex/skills/wsp/SKILL.md", docs: ["/p/AGENTS.md"] }).at(-1)).toBe("The wsp section is in /p/AGENTS.md");
    expect(removeLines({ agent: "Claude Code", docs: ["/p/AGENTS.md", "/p/CLAUDE.md"] })).toEqual(["Claude Code: the wsp section is out of /p/AGENTS.md and /p/CLAUDE.md"]);
    expect(removeLines({ agent: "Codex", docs: [] })).toEqual(["Codex: no wsp section in this folder; nothing was changed."]);
  });

  it("wsp mcp install --agent <id> writes the config for this state file and prints its lines and the command it registered; without --agent it prints the usage", async () => {
    const out = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--state", statePath], out)).toBe(0);
    const registered = mcpServerSpec(statePath);
    expect(registered.command).toBe(process.execPath);
    expect(out.lines).toEqual([
      "Claude Code now has the wsp tools: ~/.claude.json",
      "The wsp skill went to ~/.claude/skills/wsp/SKILL.md",
      `The wsp section is in ${join(project, "AGENTS.md")} and ${join(project, "CLAUDE.md")}`,
      commandLine(registered),
      "Next: run claude in this folder and say: /wsp set up wsp for me",
    ]);
    expect(out.lines[3]).toContain(`mcp --state ${statePath}`);
    expect(out.lines.at(-1)).toBe(nextInsideAgentLine("claude", `/${SKILL_NAME} set up wsp for me`));
    expect(readFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    const written = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: { wsp: { command: string; args: string[] } } };
    expect(written.mcpServers.wsp.command).toBe(process.execPath);
    expect(written.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", statePath]);
    const bare = { ...io(), isTTY: true };
    expect(await cli(["mcp", "install", "--state", statePath], bare)).toBe(1);
    expect(bare.errors).toEqual(["usage: wsp mcp install --agent <id> [--agent <id>] [--json] [--remove]   (claude, codex, gemini, opencode)"]);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), '{\n  // the look\n  "theme": "dark"\n}\n');
    const commented = io();
    expect(await cli(["mcp", "install", "--agent", "gemini", "--state", statePath], commented)).toBe(0);
    expect(commented.lines).toEqual([
      "Gemini CLI now has the wsp tools: ~/.gemini/settings.json",
      "The file held comments; the rewrite is plain JSON, so they are gone.",
      "The wsp skill went to ~/.gemini/skills/wsp/SKILL.md",
      `The wsp section is in ${join(project, "AGENTS.md")}`,
      commandLine(registered),
      "Next: run gemini in this folder and say: set up wsp for me",
    ]);
    // No config took the server, so there is no registered command to name.
    const none = io();
    expect(await cli(["mcp", "install", "--agent", "pi", "--state", statePath], none)).toBe(0);
    expect(none.lines).toEqual([
      "Pi: the catalog has no MCP config for it yet, so the server was not written; add it by hand.",
      "The wsp skill went to ~/.pi/agent/skills/wsp/SKILL.md",
      `The wsp section is in ${join(project, "AGENTS.md")}`,
      "Next: run pi in this folder and say: set up wsp for me",
    ]);
    expect(none.errors).toEqual([]);
    const unknown = io();
    expect(await cli(["mcp", "install", "--agent", "emacs", "--state", statePath], unknown)).toBe(1);
    expect(unknown.errors).toEqual(["wsp mcp install: no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode"]);
    expect(HELP).toContain("wsp mcp");
  });

  it("the section goes into the folder the command ran in, a second install leaves one, and --remove gives the file back byte for byte", async () => {
    const mine = "# myrepo\n\nRun the gate before you push.\n";
    const agents = join(project, "AGENTS.md");
    writeFileSync(agents, mine);
    expect(await cli(["mcp", "install", "--agent", "claude", "--state", statePath], io())).toBe(0);
    const once = readFileSync(agents, "utf8");
    expect(once).toBe(`${mine}${sectionText()}\n`);
    expect(await cli(["mcp", "install", "--agent", "claude", "--state", statePath], io())).toBe(0);
    expect(readFileSync(agents, "utf8")).toBe(once);
    expect(once.split(SECTION_BEGIN)).toHaveLength(2);
    const gone = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--remove", "--state", statePath], gone)).toBe(0);
    expect(gone.lines).toEqual([`Claude Code: the wsp section is out of ${agents} and ${join(project, "CLAUDE.md")}`]);
    expect(readFileSync(agents, "utf8")).toBe(mine);
    expect(existsSync(join(project, "CLAUDE.md"))).toBe(false);
    // --remove is the section's alone: the server and the skill stay where the install put them.
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.wsp).toBeDefined();
    expect(readFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    const removeJson = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--agent", "emacs", "--remove", "--json", "--state", statePath], removeJson)).toBe(1);
    expect(JSON.parse(removeJson.lines[0]!)).toEqual({
      removed: [{ id: "claude", agent: "Claude Code", docs: [] }],
      failures: [{ id: "emacs", error: "no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode" }],
    });
  });

  it("two agents installed into the same AGENTS.md leave one section, true for both, naming neither one's skill path", async () => {
    const agents = join(project, "AGENTS.md");
    expect(await cli(["mcp", "install", "--agent", "claude", "--agent", "codex", "--state", statePath], io())).toBe(0);
    const shared = readFileSync(agents, "utf8");
    expect(shared.split(SECTION_BEGIN)).toHaveLength(2);
    // The file codex also reads must not send it to ~/.claude/skills, and the file only Claude Code reads says the same.
    expect(shared).not.toContain("~/");
    expect(shared).toBe(readFileSync(join(project, "CLAUDE.md"), "utf8"));
  });

  it("nobody named an agent and there is no terminal to ask at: every agent whose own command is on PATH takes the install, and none there is said in one line", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const agent of ["codex", "pi"]) writeFileSync(join(bin, agent), "#!/bin/sh\n");
    expect(agentsOnPath(`${bin}:/nowhere`)).toEqual(["codex", "pi"]);
    expect(agentsOnPath(undefined)).toEqual([]);
    vi.stubEnv("PATH", `${bin}:/nowhere`);
    const found = io();
    expect(await cli(["mcp", "install", "--state", statePath], found)).toBe(0);
    expect(found.lines[0]).toBe("Codex now has the wsp tools: ~/.codex/config.toml");
    expect(found.lines.at(-1)).toBe("Next: run codex in this folder and say: set up wsp for me");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(SECTION_BEGIN);
    expect(readFileSync(join(home, ".pi", "agent", "skills", "wsp", "SKILL.md"), "utf8")).toBe(WSP_SKILL);
    vi.stubEnv("PATH", "/nowhere");
    const none = io();
    expect(await cli(["mcp", "install", "--state", statePath], none)).toBe(1);
    expect(none.errors).toEqual([
      "wsp mcp install: no agent of the catalog's is on this computer's PATH; name one with --agent.",
      "usage: wsp mcp install --agent <id> [--agent <id>] [--json] [--remove]   (claude, codex, gemini, opencode)",
    ]);
  });

  it("an agent's own slash form for the wsp skill is the skill's own folder name, so the two cannot drift", () => {
    const slashes = CATALOG_AGENTS.filter(a => a.firstMove.startsWith("/"));
    expect(slashes.map(a => a.id)).toEqual(["claude"]);
    for (const agent of slashes) expect(agent.firstMove.split(" ")[0], agent.id).toBe(`/${SKILL_NAME}`);
  });
});
