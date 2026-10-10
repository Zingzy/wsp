// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_MCP_CHECK, CODEX_MCP_CHECK, MCP_AGENTS } from "../src/index.js";

// `claude mcp get <name>` as Claude Code 2.1.281 printed it; the first is this computer's own answer for a server.
const transcript = (status: string): string => `notion:\n  Scope: User config (available in all your projects)\n  Status: ${status}\n\nTo remove this server, run: claude mcp remove notion -s user\n`;

// `codex mcp list --json` as Codex 0.162.1 printed it, its warning on stderr first, with one server of each state.
const listed = `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"
[
  { "name": "axiom", "enabled": true, "transport": { "type": "streamable_http", "url": "https://mcp.axiom.co/mcp" }, "auth_status": "o_auth" },
  { "name": "linear", "enabled": true, "transport": { "type": "streamable_http", "url": "https://mcp.linear.app/mcp" }, "auth_status": "not_logged_in" },
  { "name": "tok", "enabled": true, "transport": { "type": "streamable_http", "url": "https://example.com/mcp", "bearer_token_env_var": "TOK" }, "auth_status": "bearer_token" },
  { "name": "plain", "enabled": true, "transport": { "type": "stdio", "command": "echo" }, "auth_status": "unsupported" }
]
`;

describe("the harness's own word on one server's sign-in", () => {
  it("reads Claude Code's status line as the sign-in it stands for, and nothing where the words are not the measured ones", () => {
    expect(CLAUDE_MCP_CHECK.line("notion")).toBe("claude mcp get 'notion'");
    expect(CLAUDE_MCP_CHECK.auth(transcript("✔ Connected"), "notion")).toBe("signed-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("⚠ Needs authentication"), "notion")).toBe("needs-sign-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("! Needs authentication"), "notion")).toBe("needs-sign-in");
    expect(CLAUDE_MCP_CHECK.auth(transcript("✘ Failed to connect"), "notion")).toBe("failed");
    expect(CLAUDE_MCP_CHECK.auth(transcript("⏸ Pending approval"), "notion")).toBeUndefined();
  });

  it("reads Claude Code's words for a name its config does not hold as not set up, in both versions' words", () => {
    expect(CLAUDE_MCP_CHECK.auth('No MCP server named "cloudflare". Configured servers: plugin:context7:context7\n', "cloudflare")).toBe("not-set-up");
    expect(CLAUDE_MCP_CHECK.auth("No MCP server named \"cloudflare\". Run `claude mcp add` to add one.\n", "cloudflare")).toBe("not-set-up");
    expect(CLAUDE_MCP_CHECK.auth("No MCP server found with name: notion\n", "notion")).toBe("not-set-up");
  });

  it("reads the server's auth_status off Codex's list, a name it does not list as not set up, and nothing off words that are not a list", () => {
    expect(CODEX_MCP_CHECK.line("axiom")).toBe("codex mcp list --json");
    expect(CODEX_MCP_CHECK.auth(listed, "axiom")).toBe("signed-in");
    expect(CODEX_MCP_CHECK.auth(listed, "linear")).toBe("needs-sign-in");
    expect(CODEX_MCP_CHECK.auth(listed, "tok")).toBeUndefined();
    expect(CODEX_MCP_CHECK.auth(listed, "plain")).toBeUndefined();
    expect(CODEX_MCP_CHECK.auth(listed, "cloudflare_observability")).toBe("not-set-up");
    expect(CODEX_MCP_CHECK.auth("[]\n", "axiom")).toBe("not-set-up");
    expect(CODEX_MCP_CHECK.auth("error: unexpected argument '--json' found\n", "axiom")).toBeUndefined();
    expect(CODEX_MCP_CHECK.auth('[\n  { "name": "axiom"', "axiom")).toBeUndefined();
  });

  it("is registered on the agents whose check was measured, and no other agent guesses one", () => {
    expect(Object.fromEntries(MCP_AGENTS.map(a => [a.id, a.mcp.check]))).toEqual({ claude: CLAUDE_MCP_CHECK, codex: CODEX_MCP_CHECK, gemini: undefined, opencode: undefined });
  });
});
