// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@wsp/collect";
import { Recipe } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { applyRecipe, withCatalogAgents } from "../src/init-recipe.js";
import { signInItems } from "../src/init-pick.js";
import { writeRecipe } from "../src/recipe-command.js";
import { customFromFlags } from "../src/recipe-custom.js";

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
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { now: () => new Date("2026-09-06T03:00:00Z") });
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

  it("carries the rows --add names into the file and shows them in the printout with the exact command", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { add: customFromFlags({ add: ["just=brew install just"] }) });
    expect(recipe.custom).toEqual([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v 'just'", why: "added by the agent" }]);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom).toEqual(recipe.custom);
    expect(lines).toContain("Rows the catalog does not carry:");
    expect(lines.find(l => l.includes("just"))).toContain("brew install just");
  });

  it("says so and rewrites the file when a recipe already there cannot be read, rather than refusing to run", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    writeFileSync(out, "{ not json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { add: customFromFlags({ add: ["just=brew install just"] }) });
    expect(lines.find(l => l.includes("could not be read"))).toContain("any rows it added are gone");
    expect(recipe.custom?.map(r => r.id)).toEqual(["just"]);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
  });

  it("keeps the rows an earlier run added, so --add adds up across calls", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    await writeRecipe(laptop(), out, () => {}, { add: customFromFlags({ add: ["just=brew install just"] }) });
    const second = await writeRecipe(laptop(), out, () => {}, { add: customFromFlags({ add: ["ruff=uv tool install ruff"] }) });
    expect(second.custom?.map(r => r.id)).toEqual(["just", "ruff"]);
  });

  it("never offers a sign-in for a row outside the catalog: the install is the whole row", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "recipe.json");
    const recipe = await writeRecipe(laptop(), out, () => {}, { add: customFromFlags({ add: ["gh-enterprise=brew install gh-enterprise"] }) });
    expect(recipe.custom?.[0]).not.toHaveProperty("signIn");
    expect(recipe.rows.some(r => r.id === "gh-enterprise")).toBe(false);
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [] }), recipe)).items.map(i => i.id)).not.toContain("logins/gh-enterprise");
  });
});
