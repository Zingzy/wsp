// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_MCP_CHECK, CODEX_MCP_CHECK, MCP_AGENTS } from "../src/index.js";

// `claude mcp get <name>` as Claude Code 2.1.281 printed it; the first is this computer's own answer for a server.
const transcript = (status: string): string => `notion:\n  Scope: User config (available in all your projects)\n  Status: ${status}\n\nTo remove this server, run: claude mcp remove notion -s user\n`;

describe("the harness's own word on one server's sign-in", () => {
  it("reads Claude Code's status line as the sign-in it stands for, and nothing where the words are not the measured ones", () => {
    expect(CLAUDE_MCP_CHECK.line("notion")).toBe("claude mcp get 'notion'");
    expect(CLAUDE_MCP_CHECK.auth(transcript("✔ Connected"), "notion")).toBe("signed-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("⚠ Needs authentication"), "notion")).toBe("needs-sign-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("✘ Failed to connect"), "notion")).toBe("failed");
    expect(CLAUDE_MCP_CHECK.auth(transcript("⏸ Pending approval"), "notion")).toBeUndefined();
    expect(CLAUDE_MCP_CHECK.auth("No MCP server found with name: notion\n", "notion")).toBeUndefined();
  });

  it("keeps only each server's name and sign-in word of Codex's list, since the rest carries the config's values, and reads the named one", () => {
    // `codex mcp list --json` as Codex 0.155.1 printed it off a scratch config, through the line's own filter.
    const listed = ['    "name": "local",', '    "auth_status": "unsupported"', '    "name": "oauthy",', '    "auth_status": "not_logged_in"', '    "name": "remote",', '    "auth_status": "bearer_token"', ""].join("\n");
    expect(CODEX_MCP_CHECK.line("oauthy")).toBe(`codex mcp list --json 2>/dev/null | grep -E '^    "(name|auth_status)": '`);
    expect(CODEX_MCP_CHECK.auth(listed, "oauthy")).toBe("needs-sign-in");
    expect(CODEX_MCP_CHECK.auth(listed, "remote")).toBeUndefined();
    expect(CODEX_MCP_CHECK.auth(listed, "local")).toBeUndefined();
    expect(CODEX_MCP_CHECK.auth(listed, "nobody")).toBeUndefined();
  });

  it("is registered on the agents whose check was measured, and no other agent guesses one", () => {
    expect(Object.fromEntries(MCP_AGENTS.map(a => [a.id, a.mcp.check]))).toEqual({ claude: CLAUDE_MCP_CHECK, codex: CODEX_MCP_CHECK, gemini: undefined, opencode: undefined });
  });
});
