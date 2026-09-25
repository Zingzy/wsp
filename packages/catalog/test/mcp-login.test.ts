// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_MCP_LOGIN, CODEX_MCP_LOGIN, GEMINI_MCP_LOGIN, MCP_AGENTS, OPENCODE_MCP_LOGIN, SIGN_IN_ROWS, serverSignInRoad, signInRoadOf, type SignIn } from "../src/index.js";

describe("how one MCP server of an agent is signed in", () => {
  it("is each harness's own command, measured off its help, or the line its own session takes", () => {
    expect(CLAUDE_MCP_LOGIN).toMatchObject({ finish: "code" });
    expect("command" in CLAUDE_MCP_LOGIN && CLAUDE_MCP_LOGIN.command("notion")).toBe("claude mcp login 'notion' --no-browser");
    expect("command" in CODEX_MCP_LOGIN && CODEX_MCP_LOGIN.command("notion")).toBe("codex mcp login 'notion'");
    expect("command" in OPENCODE_MCP_LOGIN && OPENCODE_MCP_LOGIN.command("notion")).toBe("opencode mcp auth 'notion'");
    expect("inside" in GEMINI_MCP_LOGIN && GEMINI_MCP_LOGIN.inside("notion")).toBe("/mcp auth notion");
  });

  it("is registered on every agent with an MCP config, one module each", () => {
    expect(Object.fromEntries(MCP_AGENTS.map(a => [a.id, a.mcp.login]))).toEqual({ claude: CLAUDE_MCP_LOGIN, codex: CODEX_MCP_LOGIN, gemini: GEMINI_MCP_LOGIN, opencode: OPENCODE_MCP_LOGIN });
  });

  it("runs in a watched pty where its page comes back to it, and is the person's line where it cannot", () => {
    // A pasted redirect finishes Claude Code's anywhere; a page at localhost reaches only the computer the browser is on.
    expect(serverSignInRoad("claude", "notion", false)).toEqual({ kind: "pty", command: "claude mcp login 'notion' --no-browser", finish: "code" });
    expect(serverSignInRoad("codex", "notion", true)).toEqual({ kind: "pty", command: "codex mcp login 'notion'", finish: "callback" });
    expect(serverSignInRoad("codex", "notion", false)).toMatchObject({ kind: "copy", line: "codex mcp login 'notion'" });
    expect(serverSignInRoad("opencode", "notion", false)).toMatchObject({ kind: "copy", line: "opencode mcp auth 'notion'" });
    expect(serverSignInRoad("gemini", "notion", true)).toMatchObject({ kind: "copy", line: "/mcp auth notion" });
    expect(serverSignInRoad("hermes", "notion", true)).toBeUndefined();
  });
});

describe("the sign-in road a report names", () => {
  it("is read off the row's declared headless flow, never off the words of its command", () => {
    expect(signInRoadOf(SIGN_IN_ROWS.codex)).toBe("device");
    expect(signInRoadOf(SIGN_IN_ROWS.gemini)).toBe("code");
    expect(signInRoadOf(SIGN_IN_ROWS.claude)).toBe("token");
    expect(signInRoadOf(SIGN_IN_ROWS.opencode)).toBe("terminal");
    const row: SignIn = { kind: "oauth", sources: [], finish: "callback", login: "tool login", fallback: "tool login --no-browser", headless: "device", stateOnMachine: [] };
    expect(signInRoadOf(row)).toBe("device");
    expect(signInRoadOf({ ...row, fallback: "tool login --device", headless: "code" })).toBe("code");
  });
});
