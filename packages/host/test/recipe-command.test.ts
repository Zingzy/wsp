// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe from a fake computer: what it writes, what it says about each
// agent's history, and the two tables it prints, which are the wizard's own.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS, CATALOG_TOOLS } from "@wsp/catalog";
import type { Host } from "@wsp/collect";
import { Recipe } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { tableItems } from "../src/init-pick.js";
import { recipeTable, sizeText, tableLines, totalsLine } from "../src/init-table.js";
import { writeRecipe } from "../src/recipe-command.js";
import { FIXTURE } from "./init-fixture.js";

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

  it("writes the recipe where asked, creating the directory, and prints the agents and the tools as tables", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmd-"));
    const out = join(dir, "state", "recipe.json");
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), out, l => lines.push(l), { now: () => new Date("2026-09-06T03:00:00Z") });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toEqual(recipe);
    expect(recipe.rows.find(r => r.id === "claude")).toMatchObject({ on: true, source: { kind: "installed", paths: ["~/.claude/settings.json"], bin: true } });
    expect(lines[0]).toBe("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
    expect(lines).toContain("Claude Code: no history here");
    expect(lines).toContain("Gemini CLI: no reader for its history yet");
    // Two tables, each with its own totals: one row per catalog entry, its tick, why it is here and what it downloads.
    expect(lines).toContain("Agents");
    expect(lines).toContain("Tools");
    const line = (re: RegExp): string => lines.find(l => /^[●○] /.test(l) && re.test(l)) ?? lines.join("\n");
    expect(line(/Claude Code/)).toMatch(/^● {2}Claude Code\s+installed\s+installed here, never used\s+208\.0 MB$/);
    expect(line(/Codex/)).toMatch(/^○ {2}Codex\s+catalog\s+not installed here\s+455\.0 MB$/);
    expect(line(/Node 22/)).toMatch(/^● {2}Node 22 with npm\s+base\s+always on the image\s+250\.0 MB$/);
    expect(line(/Java 21/)).toMatch(/^○ {2}Java 21\s+catalog\s+in the catalog, on request\s+343\.0 MB$/);
    // A row the catalog has never measured says so, instead of being folded into the estimate's unmeasured count.
    expect(line(/GitHub CLI/)).toMatch(/^● {2}GitHub CLI\s+installed\s+installed here, never used\s+size unknown$/);
    expect(lines.filter(l => /^On: /.test(l))).toEqual([expect.stringMatching(/^On: 1 agent, 208\.0 MB$/), expect.stringMatching(/^On: \d+ tools, [\d.]+ MB, \d+ of unknown size$/)]);
    expect(lines.at(-1)).toBe(`Recipe written to ${out}. Review it, then run wsp init --recipe ${out}.`);
  });

  it("the verb and the wizard's screens draw the same rows from the same function", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-same-"));
    const lines: string[] = [];
    const recipe = await writeRecipe(laptop(), join(dir, "recipe.json"), l => lines.push(l), { now: () => new Date("2026-09-06T03:00:00Z") });
    for (const [catalog, grouped, noun] of [[CATALOG_AGENTS, false, "agents"], [CATALOG_TOOLS, true, "tools"]] as const) {
      const rows = recipeTable(recipe, catalog);
      const items = tableItems(rows, recipe, FIXTURE, 4, grouped);
      // The screen's rows are the table's rows, in its order, with the same names, ticks and sizes.
      expect(items.map(i => i.id)).toEqual(rows.map(r => r.id));
      expect(items.map(i => i.label)).toEqual(rows.map(r => r.name));
      expect(items.map(i => (typeof i.hint === "object" ? i.hint.text : i.hint))).toEqual(rows.map(sizeText));
      expect(items.filter(i => i.lock === "on").map(i => i.id)).toEqual(rows.filter(r => r.base).map(r => r.id));
      // And the text the verb printed is that same table with its totals under it.
      const at = lines.indexOf(totalsLine(rows, noun));
      expect(lines.slice(at - rows.length, at)).toEqual(tableLines(rows, 1));
    }
  });
});
