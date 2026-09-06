// SPDX-License-Identifier: AGPL-3.0-only
// The one renderer the recipe verb, the MCP tool and the wizard's What they
// need screen all draw from: rows in, lines out, no colour and no terminal.
import { readsUsedFirst } from "@wsp/collect";
import { RECIPE_TICKS } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { THREAD_AGENTS } from "../src/thread-agents.js";
import { COMMANDS_TITLE, HEAVY_BYTES, UNMEASURED, commandTableLines, recipeTable, recipeTableLines, recipeTableRows, recipeTotalLine, whyLine, type RecipeTableRow } from "../src/recipe-table.js";

const MB = 1024 * 1024;
const ESC = String.fromCharCode(27);
const rows: RecipeTableRow[] = [
  { id: "node", name: "Node 22 with npm", kind: "tool", on: true, why: "used 412 times in 37 sessions", size: 250 * MB },
  { id: "java", name: "Java 21", kind: "tool", on: false, why: "installed here, never used", size: 343 * MB },
  { id: "pnpm", name: "pnpm", kind: "tool", on: true, why: "catalog default" },
];

describe("the recipe table", () => {
  it("says why a row has its tick in the words the rule went on", () => {
    expect(whyLine({ kind: "used", sessions: 37, calls: 412 }, true)).toBe("used 412 times in 37 sessions");
    expect(whyLine({ kind: "used", sessions: 1, calls: 1 }, true)).toBe("used 1 time in 1 session");
    // A rule that reads a use before what is installed leaves only never-run rows on the installed source.
    expect(whyLine({ kind: "installed", paths: [], bin: true }, true)).toBe("installed here, never used");
    expect(whyLine({ kind: "installed", paths: [], bin: true }, false)).toBe("installed here");
    expect(whyLine({ kind: "popular", sessions: 3, images: 2 }, false)).toBe("catalog default");
    // Which rules read a use first is the collector's answer, not a word this file knows.
    expect(RECIPE_TICKS.map(readsUsedFirst)).toEqual([true, false, false]);
    // A recipe the wizard wrote names no rule, so nothing can claim a row was never used.
    expect(readsUsedFirst(undefined)).toBe(false);
  });

  it("renders a recipe that names no rule without claiming one, so the wizard's own recipes read right", () => {
    const recipe = {
      version: 1 as const,
      at: "x",
      histories: [],
      rows: [{ id: "claude", kind: "agent" as const, on: true, source: { kind: "installed" as const, paths: [], bin: true }, size: 208 * MB }],
    };
    expect(recipeTableRows(recipe)[0]).toMatchObject({ why: "installed here" });
    expect(recipeTable(recipe, "/tmp/r.json").tick).toBeUndefined();
  });

  it("draws a header and one line per row, the columns lined up and nothing coloured", () => {
    const lines = recipeTableLines(rows);
    expect(lines).toEqual([
      "id    on   why                                    size",
      "node  on   used 412 times in 37 sessions      250.0 MB",
      "java  off  installed here, never used         343.0 MB",
      `pnpm  on   catalog default                ${UNMEASURED}`,
    ]);
    expect(lines.some(l => l.includes(ESC))).toBe(false);
  });

  it("adds up only the ticked rows and counts the ones worth putting to the person", () => {
    const empty = recipeTable({ version: 1, at: "2026-09-06T03:00:00.000Z", tick: "used", histories: [], rows: [] }, "/tmp/recipe.json");
    expect(empty).toMatchObject({ tick: "used", at: "2026-09-06T03:00:00.000Z", out: "/tmp/recipe.json", totalBytes: 0, heavy: [], commands: [] });
    const table = recipeTable(
      {
        version: 1,
        at: "x",
        tick: "used",
        histories: [],
        rows: [
          { id: "java", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true }, size: 343 * MB },
          { id: "opencode", kind: "agent", on: true, source: { kind: "popular", sessions: 1, images: 1 }, size: 673 * MB },
          { id: "node", kind: "tool", on: false, source: { kind: "popular", sessions: 1, images: 1 }, size: 900 * MB },
        ],
      },
      "/tmp/r.json",
    );
    expect(table.totalBytes).toBe((343 + 673) * MB);
    expect(table.heavy.map(r => r.id)).toEqual(["opencode", "java"]);
    expect(HEAVY_BYTES).toBe(300 * MB);
    expect(recipeTotalLine(table.rows)).toBe("2 rows on, 1016.0 MB; 2 rows over 300.0 MB.");
    expect(table.rows.find(r => r.id === "opencode")?.name).toBe("OpenCode");
  });

  it("says when a ticked row's size was never measured, so the total reads as a floor", () => {
    const t = recipeTable({ version: 1, at: "x", tick: "used", histories: [], rows: [{ id: "pnpm", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 } }] }, "/tmp/r.json");
    expect(recipeTotalLine(t.rows)).toBe("1 row on, 0 B measured and 1 row not; 0 rows over 300.0 MB.");
  });

  it("lists the commands the catalog does not carry under one title, and says so when there are none", () => {
    expect(commandTableLines([])).toEqual([COMMANDS_TITLE, "  none"]);
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `cmd${i}`, calls: 15 - i, sessions: 1 }));
    const lines = commandTableLines(many, 3);
    expect(lines[0]).toBe(COMMANDS_TITLE);
    expect(lines[1]).toMatch(/^ {2}command +calls +sessions$/);
    expect(lines.slice(2, 5).map(l => l.trim().split(/ +/)[0])).toEqual(["cmd0", "cmd1", "cmd2"]);
    expect(lines.at(-1)).toBe("  and 12 more");
  });
});

describe("the agents wsp can open a thread on", () => {
  it("is one list, and the adapter registry is keyed by it", () => {
    expect(Object.keys(HARNESS_ADAPTERS).sort()).toEqual([...THREAD_AGENTS].sort());
  });
});
