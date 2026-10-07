// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_RUN_INSTALLERS, installsOnFirstRun } from "../src/first-run.js";

const mise = FIRST_RUN_INSTALLERS.find(i => i.id === "mise")!;

describe("a mise wrapper", () => {
  it("names the tool its script installs, past flags, quotes and a version, and nothing for a script that only runs one", () => {
    expect(mise.tool('#!/bin/bash\nexport MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet "claude" || exit 1\nexec mise x "claude" -- "claude" "$@"\n')).toBe("claude");
    expect(mise.tool("#!/bin/sh\nmise install 'npm:@anthropic-ai/claude-code@2.1.289' && exec claude \"$@\"\n")).toBe("npm:@anthropic-ai/claude-code@2.1.289");
    expect(mise.tool('#!/bin/sh\n# mise use -g claude\nexec "$HOME/.local/share/claude/bin/claude" "$@"\n')).toBeUndefined();
    expect(mise.tool('#!/usr/bin/env node\nrequire("./cli.js")\n')).toBeUndefined();
  });

  it("is installed once mise's own installs folder for the tool holds a version, its version cut from the name and the rest in kebab case as mise writes it", () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-mise-"));
    try {
      const passes = (tool: string, env: Record<string, string> = {}): boolean => spawnSync("/bin/sh", ["-c", mise.installed(tool)], { env: { HOME: home, PATH: "/usr/bin:/bin", ...env } }).status === 0;
      expect(passes("claude")).toBe(false);
      mkdirSync(join(home, ".local", "share", "mise", "installs", "claude"), { recursive: true });
      expect(passes("claude")).toBe(false);
      mkdirSync(join(home, ".local", "share", "mise", "installs", "claude", "2.1.289"));
      expect(passes("claude")).toBe(true);
      mkdirSync(join(home, "data", "installs", "npm-anthropic-ai-claude-code", "2.1.289"), { recursive: true });
      expect(passes("npm:@anthropic-ai/claude-code@2.1.289")).toBe(false);
      expect(passes("npm:@anthropic-ai/claude-code@2.1.289", { MISE_DATA_DIR: join(home, "data") })).toBe(true);
      mkdirSync(join(home, "data", "installs", "github-burnt-sushi-ripgrep", "14.1.1"), { recursive: true });
      mkdirSync(join(home, "data", "installs", "aqua-my-tool-http-server", "1.0.0"), { recursive: true });
      expect(passes("github:BurntSushi/ripgrep", { MISE_DATA_DIR: join(home, "data") })).toBe(true);
      expect(passes("aqua:my_tool/HTTPServer@1.0.0", { MISE_DATA_DIR: join(home, "data") })).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("installsOnFirstRun", () => {
  it("asks nothing more where no command is a script, and reads a script the second run says is still to install", async () => {
    const asked: string[] = [];
    const none = await installsOnFirstRun(async script => (asked.push(script), "\x1e\x1e\x1e"), ["claude", "codex"]);
    expect(none).toEqual([false, false]);
    expect(asked).toHaveLength(1);
    const heads = `\x1e#!/bin/bash\nmise use -g claude\n\x1e\x7fELF\x1e`;
    const said = await installsOnFirstRun(async script => (script.startsWith("for b in") ? heads : "1\n0\n"), ["claude", "codex"]);
    expect(said).toEqual([true, false]);
  });

  it("answers false for every bin when the read could not run", async () => {
    expect(await installsOnFirstRun(async () => undefined, ["claude"])).toEqual([false]);
  });
});
