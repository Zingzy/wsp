// SPDX-License-Identifier: AGPL-3.0-only
// How an agent's own harness answers for one MCP server's sign-in: the line
// that asks it and how its words about that server read. A server
// behind a sign-in keeps its token where the harness put it, which wsp never
// reads, so the harness's word is the only one there is. One module per
// harness, registered on its catalog entry, each read against the version
// named on it; words that are not the measured ones answer nothing.
import { shellQuote, type McpAuth } from "@wsp/protocol";

export interface McpCheck {
  /** The harness and version the words were read off. */
  measured: string;
  /** The line that asks the harness for one server's sign-in, and starts no command server. */
  line(name: string): string;
  /** The named server's sign-in off what the line printed; nothing where the words are not the measured ones. */
  auth(output: string, name: string): McpAuth | undefined;
}

/** `claude mcp get <name>` health-checks the one server and prints a `Status:` line. */
export const CLAUDE_MCP_CHECK: McpCheck = {
  measured: "claude 2.1.281",
  line: name => `claude mcp get ${shellQuote(name)}`,
  auth: output => {
    const status = /^\s*Status:\s*(.*)$/m.exec(output)?.[1] ?? "";
    if (status.includes("Needs authentication")) return "needs-sign-in";
    if (status.includes("Failed to connect")) return "failed";
    if (status.includes("Connected")) return "signed-in";
    return undefined;
  },
};

/** `codex mcp list --json` reads the config and starts no command server, but prints each entry's env and header
 * values and asks an address's OAuth discovery; the grep keeps only each top-level name and auth_status line, so no
 * value leaves the computer. Only `not_logged_in` is a word about a sign-in; `bearer_token` says a token is
 * configured, not that it works. */
export const CODEX_MCP_CHECK: McpCheck = {
  measured: "codex-cli 0.155.1",
  line: () => `codex mcp list --json 2>/dev/null | grep -E '^    "(name|auth_status)": '`,
  auth: (output, name) => {
    let current: unknown;
    for (const line of output.split("\n")) {
      const m = /^ {4}"(name|auth_status)": (".*"),?$/.exec(line);
      if (m === null) continue;
      let value: unknown;
      try {
        value = JSON.parse(m[2]!);
      } catch {
        continue;
      }
      if (m[1] === "name") current = value;
      else if (current === name) return value === "not_logged_in" ? "needs-sign-in" : undefined;
    }
    return undefined;
  },
};
