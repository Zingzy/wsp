// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@wsp/collect";
import { Recipe } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { writeRecipe } from "../src/recipe-command.js";

/** A laptop with Claude Code and gh on it, one config file, and no session history anywhere. */
function laptop(): Host {
  return {
    platform: "darwin",
    home: "/Users/dev",
    fs: {
      stat: async p => (p === "/Users/dev/.claude/settings.json" ? { kind: "file", bytes: 10 } : undefined),
      list: async () => [],
      readText: async () => undefined,
      walk: async () => [],
      async *lines() {},
    },
    exec: { which: async bin => ["claude", "gh", "node"].includes(bin), run: async () => undefined },
  };
}

describe("wsp recipe", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the recipe where asked, creating the directory, and says what decided each tick in names and counts", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "state", "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), () => new Date("2026-09-06T03:00:00Z"));
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
    expect(recipe.rows.find(r => r.id === "claude")).toMatchObject({ on: true, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true } });
    expect(lines[0]).toBe("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
    expect(lines).toContain("Claude Code: no history here");
    expect(lines).toContain("Codex: no history here");
    expect(lines).toContain("Gemini CLI: no reader for its history yet");
    expect(lines).toContain("Hermes Agent: no history here");
    expect(lines).toContain("Agents here: Claude Code");
    const tools = lines.findIndex(l => l.startsWith("Tools on: "));
    expect(lines[tools]).toMatch(/^Tools on: \d+ of \d+$/);
    expect(lines[tools + 1]).toBe("  installed here: Node 22 with npm, GitHub CLI");
    expect(lines[tools + 2]).toBe("  used by your agents: none");
    expect(lines[tools + 3]).toMatch(/^  popular in the catalog: pnpm, uv, Python 3\.12, git, /);
    expect(lines.at(-1)).toBe(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  });
});
