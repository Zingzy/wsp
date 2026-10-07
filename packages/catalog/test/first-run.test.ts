// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_RUN_INSTALLERS, installsOnFirstRun } from "../src/first-run.js";

const mise = FIRST_RUN_INSTALLERS.find(i => i.id === "mise")!;
const lazyRun = FIRST_RUN_INSTALLERS.find(i => i.id === "lazy-run")!;

/** ASCII's shim as its cloud image writes it at /usr/local/bin/<name>, with that folder and its fallback given. */
const asciiShim = (name: string, folder = "/usr/local/bin", fallback = `/usr/local/lib/ascii-harnesses/bin/${name}`): string =>
  `#!/bin/sh\n# ascii-harness-shim\nu=$(PATH=$(printf %s "$PATH" | tr : "\\n" | grep -vx ${folder} | paste -sd:) command -v ${name} 2>/dev/null)\n[ -n "$u" ] && exec "$u" "$@"\nexec ${fallback} "$@"\n`;

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

describe("an ASCII lazy-run shim", () => {
  it("names the launcher it falls back to, and nothing for a script that is not the shim", () => {
    expect(lazyRun.tool(asciiShim("cursor-agent"))).toBe("/usr/local/lib/ascii-harnesses/bin/cursor-agent");
    expect(lazyRun.tool(asciiShim("hermes"))).toBe("/usr/local/lib/ascii-harnesses/bin/hermes");
    expect(lazyRun.tool('#!/bin/sh\n# ascii-lazy-harness cursor\nexec /usr/local/lib/ascii-harnesses/lazy-run cursor cursor-agent "$@"\n')).toBeUndefined();
    expect(lazyRun.tool('#!/bin/sh\nexec /opt/cursor-agent/cursor-agent "$@"\n')).toBeUndefined();
    expect(mise.tool(asciiShim("cursor-agent"))).toBeUndefined();
  });

  it("is installed once the launcher is no longer lazy-run's, or once another command of its name stands on PATH past the shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-lazy-"));
    try {
      const shims = join(dir, "shims");
      const other = join(dir, "other");
      const launcher = join(dir, "lib", "cursor-agent");
      for (const d of [shims, other, join(dir, "lib")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(shims, "cursor-agent"), asciiShim("cursor-agent", shims, launcher), { mode: 0o755 });
      writeFileSync(launcher, `#!/bin/sh\n# ascii-lazy-harness cursor\nexec ${dir}/lazy-run cursor cursor-agent "$@"\n`);
      const passes = (): boolean => spawnSync("/bin/sh", ["-c", lazyRun.installed(lazyRun.tool(asciiShim("cursor-agent", shims, launcher))!)], { env: { HOME: dir, PATH: `${shims}:${other}:/usr/bin:/bin` } }).status === 0;
      expect(passes()).toBe(false);
      writeFileSync(join(other, "cursor-agent"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
      expect(passes()).toBe(true);
      rmSync(join(other, "cursor-agent"));
      writeFileSync(launcher, "#!/bin/sh\necho 2026.10.01\n");
      expect(passes()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
