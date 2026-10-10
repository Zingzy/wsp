// SPDX-License-Identifier: AGPL-3.0-only
// Every line of an agent's own command the host runs or hands out is built by
// harnessLine(), which points it at the store that agent's threads read and
// runs it in the project's folder: a line built off the catalog any other way
// reads the default home, which on a computer you joined holds none of the
// agent's logins or servers.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { harnessLine } from "@wsp/catalog";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Where the catalog hands out a line of an agent's own command: a server check, a server sign-in's command or line,
 * an agent's login and its status, a plugin's install and uninstall. */
const READS_A_LINE = /\bcheck\.line\(|\broad\.(command|line)\b|\broad\.(install|uninstall)\(|\bstatus\??\.(typed|command)\b|\bfallback \?\?|\blogin\.command\(|\.pasted\(/;

/** Files whose matches are no agent's line on a computer you joined, with why. */
const NOT_ON_A_BOX: Record<string, string> = {
  "init-handoff.ts": "the image's own sign-ins, on a machine no thread has run on yet, whose guest environment names each store",
  "places/add-words.ts": "a relay's join roads, which are wsp's own lines and no agent's",
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });

describe("a line of an agent's own command", () => {
  it("is built by harnessLine() wherever the host reads one off the catalog", () => {
    const loose = files(SRC).flatMap(path => {
      const rel = relative(SRC, path);
      if (NOT_ON_A_BOX[rel] !== undefined) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, at) => (READS_A_LINE.test(line) && !line.includes("harnessLine(") ? [`${rel}:${at + 1}: ${line.trim()}`] : []));
    });
    expect(loose).toEqual([]);
  });

  it("names a store and a folder only where it is handed one", () => {
    expect(harnessLine("codex", "codex mcp list --json")).toBe("codex mcp list --json");
    expect(harnessLine("codex", "codex mcp list --json", { stores: { codex: "/wsp/logins/codex" }, folder: "/root/acme" })).toBe("cd '/root/acme' 2>/dev/null; export CODEX_HOME='/wsp/logins/codex'; codex mcp list --json");
    expect(harnessLine("claude", "claude mcp get 'lab'", { stores: { codex: "/wsp/logins/codex", claude: "/root/.claude" } })).toBe("export CLAUDE_CONFIG_DIR='/root/.claude'; claude mcp get 'lab'");
    expect(harnessLine("opencode", "opencode mcp auth 'lab'", { stores: { opencode: "/root/.opencode" } }), "an agent with no store variable runs as it is").toBe("opencode mcp auth 'lab'");
  });
});
