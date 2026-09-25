// SPDX-License-Identifier: AGPL-3.0-only
// How an agent's own harness signs one MCP server in: the command that runs
// the harness's sign-in for that server and how it finishes, or the line the
// person types inside the harness's own session where it has no command.
// One module per harness, registered on its catalog entry.
import { shellQuote } from "@wsp/protocol";

export type McpLogin =
  /** A command run in a pty on the computer the server is set up on. `code`: the page's redirect is pasted back into
   * it; `callback`: the page returns to localhost on the computer the browser is on. */
  | { measured: string; command(name: string): string; finish: "code" | "callback" }
  /** The harness signs a server in only inside its own session: the line typed there. */
  | { measured: string; inside(name: string): string };

/** `--no-browser` prints the page and asks for the redirect URL back, which a person pastes from any computer. */
export const CLAUDE_MCP_LOGIN: McpLogin = { measured: "claude 2.1.282", command: name => `claude mcp login ${shellQuote(name)} --no-browser`, finish: "code" };

/** No flag for a headless run: the page returns to a port the command listens on. */
export const CODEX_MCP_LOGIN: McpLogin = { measured: "codex-cli 0.155.1", command: name => `codex mcp login ${shellQuote(name)}`, finish: "callback" };

export const OPENCODE_MCP_LOGIN: McpLogin = { measured: "opencode 1.18.18", command: name => `opencode mcp auth ${shellQuote(name)}`, finish: "callback" };

/** Gemini CLI has no command for it: `/mcp auth` inside a session. */
export const GEMINI_MCP_LOGIN: McpLogin = { measured: "gemini docs", inside: name => `/mcp auth ${name}` };

/** Where one server's sign-in runs: in a watched pty on that computer, or as the line the person runs there
 * themselves, with why. */
export type ServerSignInRoad = { kind: "pty"; command: string; finish: "code" | "callback" } | { kind: "copy"; line: string; why: "inside" | "callback" };

/** The road for one server under this harness's module. `here`: the computer the browser is on, which is the only
 * one a page returning to localhost reaches. */
export function loginRoad(login: McpLogin, name: string, here: boolean): ServerSignInRoad {
  if ("inside" in login) return { kind: "copy", line: login.inside(name), why: "inside" };
  const command = login.command(name);
  return login.finish === "callback" && !here ? { kind: "copy", line: command, why: "callback" } : { kind: "pty", command, finish: login.finish };
}
