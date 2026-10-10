// SPDX-License-Identifier: AGPL-3.0-only
// How an agent's own harness answers for one MCP server's sign-in: the line
// that asks it and how its words about that server read. A server
// behind a sign-in keeps its token where the harness put it, which wsp never
// reads, so the harness's word is the only one there is. One module per
// harness, registered on its catalog entry, each read against the version
// named on it; words that are not the measured ones answer nothing.
import { shellQuote, type McpAuth } from "@wsp/protocol";

/** The harness's word on one server: its sign-in, or that the config it read has no server of that name. */
export type McpCheckWord = McpAuth | "not-set-up";

export interface McpCheck {
  /** The harness and version the words were read off. */
  measured: string;
  /** The line that asks the harness for one server's sign-in, and starts no command server. */
  line(name: string): string;
  /** The server's word off what the line printed; nothing where the words are not the measured ones. */
  auth(output: string, name: string): McpCheckWord | undefined;
}

/** Claude Code's words for a name its config does not hold, from `mcp get` and `mcp login` alike: 2.1.296's, then
 * 2.1.281's. */
export const CLAUDE_NOT_SET_UP = /^No MCP server (named "|found with name: )/m;

/** `claude mcp get <name>` health-checks the one server and prints a `Status:` line. */
export const CLAUDE_MCP_CHECK: McpCheck = {
  measured: "claude 2.1.296",
  line: name => `claude mcp get ${shellQuote(name)}`,
  auth: output => {
    if (CLAUDE_NOT_SET_UP.test(output)) return "not-set-up";
    const status = /^\s*Status:\s*(.*)$/m.exec(output)?.[1] ?? "";
    if (status.includes("Needs authentication")) return "needs-sign-in";
    if (status.includes("Failed to connect")) return "failed";
    if (status.includes("Connected")) return "signed-in";
    return undefined;
  },
};

/** `codex mcp list --json` names every server its config holds with an `auth_status`, after any warning it printed on
 * stderr: `o_auth` where it holds a sign-in's tokens, `not_logged_in` where it holds none. `mcp get` says nothing of
 * a sign-in. */
export const CODEX_MCP_CHECK: McpCheck = {
  measured: "codex-cli 0.162.1",
  line: () => "codex mcp list --json",
  auth: (output, name) => {
    const at = output.search(/^\[/m);
    if (at < 0) return undefined;
    let listed: unknown;
    try {
      listed = JSON.parse(output.slice(at));
    } catch {
      return undefined;
    }
    if (!Array.isArray(listed)) return undefined;
    const entry: unknown = listed.find(s => typeof s === "object" && s !== null && (s as { name?: unknown }).name === name);
    if (entry === undefined) return "not-set-up";
    const status = (entry as { auth_status?: unknown }).auth_status;
    return status === "o_auth" ? "signed-in" : status === "not_logged_in" ? "needs-sign-in" : undefined;
  },
};
