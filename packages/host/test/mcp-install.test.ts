// SPDX-License-Identifier: AGPL-3.0-only
// Installing the MCP server into a local agent's config: the command that
// runs this same wsp against this state file, placed by the catalog entry's
// own config module under the person's home.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP, cli, type CliIO } from "../src/cli.js";
import { installMcp, mcpServerSpec } from "../src/mcp-install.js";

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
    expect(installMcp("claude", spec, home)).toEqual({ agent: "Claude Code", path: "~/.claude.json", commentsDropped: false });
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { wsp: { command: spec.command, args: spec.args } } });
    expect(installMcp("codex", spec, home)).toEqual({ agent: "Codex", path: "~/.codex/config.toml", commentsDropped: false });
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
    expect(installMcp("opencode", spec, home)).toEqual({ agent: "OpenCode", path: "~/.config/opencode/opencode.jsonc", commentsDropped: true });
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"))).toEqual({
      mcp: { other: { type: "remote", url: "https://ctx.example/mcp" }, wsp: { type: "local", command: [spec.command, ...spec.args], enabled: true } },
    });
  });

  it("an agent the catalog has no MCP config for gets nothing written and no path; an agent it does not know is refused in one line", () => {
    const spec = mcpServerSpec(statePath, PROC);
    expect(installMcp("pi", spec, home)).toEqual({ agent: "Pi" });
    expect(installMcp("hermes", spec, home)).toEqual({ agent: "Hermes Agent" });
    expect(() => installMcp("emacs", spec, home)).toThrow("no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode");
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(existsSync(join(home, ".hermes"))).toBe(false);
  });

  it("wsp mcp install --agent <id> writes the config for this state file and prints one line; without --agent it prints the usage", async () => {
    const out = io();
    expect(await cli(["mcp", "install", "--agent", "claude", "--state", statePath], out)).toBe(0);
    expect(out.lines).toEqual(["Claude Code now has the wsp tools: ~/.claude.json"]);
    const written = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: { wsp: { command: string; args: string[] } } };
    expect(written.mcpServers.wsp.command).toBe(process.execPath);
    expect(written.mcpServers.wsp.args.slice(-3)).toEqual(["mcp", "--state", statePath]);
    const bare = io();
    expect(await cli(["mcp", "install", "--state", statePath], bare)).toBe(1);
    expect(bare.errors).toEqual(["usage: wsp mcp install --agent <id>   (claude, codex, gemini, opencode)"]);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), '{\n  // the look\n  "theme": "dark"\n}\n');
    const commented = io();
    expect(await cli(["mcp", "install", "--agent", "gemini", "--state", statePath], commented)).toBe(0);
    expect(commented.lines).toEqual(["Gemini CLI now has the wsp tools: ~/.gemini/settings.json", "The file held comments; the rewrite is plain JSON, so they are gone."]);
    const none = io();
    expect(await cli(["mcp", "install", "--agent", "pi", "--state", statePath], none)).toBe(0);
    expect(none.lines).toEqual(["Pi: the catalog has no MCP config for it yet, so nothing was written; add the server by hand."]);
    expect(none.errors).toEqual([]);
    const unknown = io();
    expect(await cli(["mcp", "install", "--agent", "emacs", "--state", statePath], unknown)).toBe(1);
    expect(unknown.errors).toEqual(["wsp mcp install: no agent emacs in the catalog; agents with an MCP config: claude, codex, gemini, opencode"]);
    expect(HELP).toContain("wsp mcp");
  });
});
