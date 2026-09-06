// SPDX-License-Identifier: AGPL-3.0-only
// The one table both wsp recipe and wsp init's second screen draw: which rows
// it makes of a recipe, the order they come in, what each says about why it is
// on and what it costs, and the styles the columns take at each colour depth.
import { CATALOG, type CatalogEntry } from "@wsp/catalog";
import type { Recipe } from "@wsp/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { GREY, grey } from "../src/init-layout.js";
import { BASE_GROUP, CATALOG_GROUP, GROUP_LABEL, GROUP_ORDER, HERE_GROUP, HEAVY_BYTES, PROJECT_GROUP, USED_GROUP, groupTotal, recipeTable, sizeCell, sizeText, tableLines, totalsLine, whyCell, type TableRow } from "../src/init-table.js";
import { RECIPE } from "./init-fixture.js";

/** A few catalog entries, in the catalog's own order. */
const slice = (...ids: string[]): CatalogEntry[] => CATALOG.filter(e => ids.includes(e.id));
const used = (id: string, sessions: number, calls: number): Recipe["rows"][number] => ({ id, kind: "tool", on: true, source: { kind: "used", sessions, calls } });
const installed = (id: string, kind: "agent" | "tool" = "tool"): Recipe["rows"][number] => ({ id, kind, on: true, source: { kind: "installed", paths: [], bin: true } });
const with_ = (...rows: Recipe["rows"]): Recipe => ({ ...RECIPE, rows: [...RECIPE.rows.filter(r => !rows.some(n => n.id === r.id)), ...rows] });
const shape = (rows: readonly TableRow[]): string[][] => rows.map(r => [r.on ? "on" : "off", r.name, r.why, sizeText(r)]);

describe("the table of what travels", () => {
  it("one row per catalog entry: the tick, why it is here in this computer's own words, and the size its install downloads", () => {
    expect(shape(recipeTable(with_(used("go", 3, 40)), slice("node", "claude", "go")))).toEqual([
      ["on", "Node 22 with npm", "always on the image", "250.0 MB"],
      ["on", "Go", "40 commands in 3 sessions", "251.0 MB"],
      ["on", "Claude Code", "installed here, never used", "208.0 MB"],
    ]);
    // An agent this computer has run says how much; one it has never run says that, and one it does not have says that.
    const histories = [{ agent: "claude", state: "read" as const, sessions: 151, calls: 4000 }];
    expect(shape(recipeTable({ ...RECIPE, histories }, slice("claude", "codex")))).toEqual([
      ["on", "Claude Code", "used here, 151 sessions", "208.0 MB"],
      ["off", "Codex", "not installed here", "455.0 MB"],
    ]);
    // A row the recipe never named falls to the catalog's own evidence.
    expect(shape(recipeTable({ ...RECIPE, rows: [] }, slice("go", "ripgrep")))).toEqual([
      ["on", "ripgrep", "always on the image", "size unknown"],
      ["off", "Go", "in the catalog, on request", "251.0 MB"],
    ]);
    expect(recipeTable(RECIPE, slice("gh"))[0]).toMatchObject({ name: "GitHub CLI", group: HERE_GROUP, heavy: false });
    expect(recipeTable(RECIPE, slice("gh"))[0]!.size).toBeUndefined();
  });

  it("an agent wsp cannot drive says so on its row, and the one it can says nothing", () => {
    expect(recipeTable(RECIPE, slice("claude"))[0]!.note).toBeUndefined();
    expect(recipeTable(RECIPE, slice("codex"))[0]!.note).toBe("installs, but wsp cannot run its threads yet");
  });

  it("the groups come in one order and the heavy rows first inside their own", () => {
    const rows = recipeTable(with_(installed("codex", "agent"), used("go", 3, 40), used("wrangler", 4, 9)), slice("node", "gh", "claude", "codex", "go", "wrangler"));
    expect(rows.map(r => r.group)).toEqual([BASE_GROUP, USED_GROUP, USED_GROUP, HERE_GROUP, HERE_GROUP, HERE_GROUP]);
    // Codex is over 300 MB, so it comes before the two lighter rows its group holds.
    expect(rows.map(r => r.name)).toEqual(["Node 22 with npm", "Go", "Cloudflare Wrangler", "Codex", "Claude Code", "GitHub CLI"]);
    expect(rows.filter(r => r.heavy).map(r => r.name)).toEqual(["Codex"]);
    expect(HEAVY_BYTES).toBe(300 * 1024 * 1024);
    expect(GROUP_ORDER).toEqual(["Always on the image", "Your project needs", "You use these", "Installed here, never used", "Also in the catalog"]);
  });

  it("a row the project's own files asked for is its own group, first after the base, and its why line is the file that asked", () => {
    const project = (id: string, why: string): Recipe["rows"][number] => ({ id, kind: "tool", on: true, source: { kind: "project", why } });
    const rows = recipeTable(with_(project("go", "go.mod needs Go"), used("wrangler", 4, 9), installed("yq")), slice("node", "go", "wrangler", "yq"));
    expect(rows.map(r => r.group)).toEqual([BASE_GROUP, PROJECT_GROUP, USED_GROUP, HERE_GROUP]);
    expect(shape(rows)).toEqual([
      ["on", "Node 22 with npm", "always on the image", "250.0 MB"],
      ["on", "Go", "go.mod needs Go", "251.0 MB"],
      ["on", "Cloudflare Wrangler", "9 commands in 4 sessions", "size unknown"],
      ["on", "yq", "installed here, never used", "size unknown"],
    ]);
    // A floor row the project also named stays in the base: it installs whatever anyone ticks.
    expect(recipeTable(with_(project("pnpm", "pnpm-lock.yaml needs pnpm")), slice("pnpm"))[0]).toMatchObject({ group: BASE_GROUP, why: "always on the image" });
    expect(GROUP_LABEL[PROJECT_GROUP]).toBe("project");
  });

  it("the totals: what comes, what it downloads, and how many sizes the catalog does not have", () => {
    expect(totalsLine(recipeTable(with_(used("go", 3, 40)), slice("node", "claude", "go")), "tools")).toBe("On: 3 tools, 709.0 MB");
    expect(totalsLine(recipeTable({ ...RECIPE, rows: [] }, slice("claude", "go", "ripgrep")))).toBe("On: 1 row, 0 B, 1 of unknown size");
    expect(totalsLine([])).toBe("On: 0 rows, 0 B");
    // A group's header carries the same two facts over its own rows, the base counted as rows and not as ticks.
    expect(groupTotal(recipeTable(with_(used("go", 3, 40)), slice("node", "go")).filter(r => r.base))).toBe("1  250.0 MB");
    expect(groupTotal(recipeTable(with_(used("go", 3, 40), used("wrangler", 1, 1)), slice("go", "wrangler")))).toBe("2 of 2  251.0 MB");
    expect(groupTotal(recipeTable({ ...RECIPE, rows: [] }, slice("go", "java")))).toBe("0 of 2  0 B");
  });

  it("as text: the tick, the name, the why column, and the size flush right, each column as wide as its widest cell", () => {
    expect(tableLines(recipeTable(with_(used("go", 3, 40)), slice("node", "claude", "go")), 1)).toEqual([
      "●  Node 22 with npm  base       always on the image         250.0 MB",
      "●  Go                used       40 commands in 3 sessions   251.0 MB",
      "●  Claude Code       installed  installed here, never used  208.0 MB",
    ]);
    expect(tableLines(recipeTable({ ...RECIPE, rows: [] }, slice("go")), 1)).toEqual(["○  Go  catalog    in the catalog, on request  251.0 MB"]);
    expect(tableLines([], 1)).toEqual([]);
  });

  it("the why column takes a style per group from 256 colours up, and the group's word instead at 16", () => {
    // styleText reads FORCE_COLOR at each call, so the accent is on for this test alone.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "3";
    onTestFinished(() => {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    });
    const rows = recipeTable(with_(installed("codex", "agent"), used("go", 3, 40)), slice("node", "claude", "codex", "go", "java"));
    const painted = rows.map(r => whyCell(r, 8)).map(c => c.paint!(c.text));
    const opener = painted.map(p => p.slice(0, p.indexOf("m") + 1));
    // Four groups, four styles: what this computer ran in the accent, the rest down the grey ramp.
    expect(new Set(opener).size).toBe(4);
    expect(rows.map(r => r.group)).toEqual([BASE_GROUP, USED_GROUP, HERE_GROUP, HERE_GROUP, CATALOG_GROUP]);
    expect(opener).toEqual(["\x1b[38;5;239m", "\x1b[36m", "\x1b[38;5;247m", "\x1b[38;5;247m", "\x1b[38;5;243m"]);
    expect(whyCell(rows[4]!, 8).paint!("x")).toBe(grey(GREY.mid, "x"));
    // At 16 colours the group's word carries what the shade cannot, in a column of its own.
    expect(rows.map(r => whyCell(r, 4).text)).toEqual([
      "base       always on the image",
      "used       40 commands in 3 sessions",
      "installed  installed here, never used",
      "installed  installed here, never used",
      "catalog    in the catalog, on request",
    ]);
    expect(rows.every(r => whyCell(r, 4).paint === undefined)).toBe(true);
    expect(GROUP_LABEL[BASE_GROUP]).toBe("base");
  });

  it("a heavy size is drawn a step brighter than the rest, and only where there are shades for it", () => {
    const [codex, claude] = recipeTable(with_(installed("codex", "agent")), slice("codex", "claude"));
    expect(sizeCell(codex!, 8).paint!("455.0 MB")).toBe(grey(GREY.bright, "455.0 MB"));
    expect(sizeCell(claude!, 8).paint).toBeUndefined();
    expect(sizeCell(codex!, 4)).toEqual({ text: "455.0 MB" });
  });
});
