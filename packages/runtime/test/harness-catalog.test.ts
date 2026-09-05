// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ClaudeCatalogProbe } from "@wsp/adapter-claude";
import { HarnessCatalog } from "@wsp/protocol";
import { HARNESS_CATALOGS, TABLE_PIN, catalogFromProbe, harnessCatalog } from "../src/harness-catalog.js";

describe("harness catalogs", () => {
  it("names every harness the recipe collects, each parsing as the wire type with at most one default per picker", () => {
    expect(HARNESS_CATALOGS.map(c => c.harness)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const catalog of HARNESS_CATALOGS) {
      expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
      expect(catalog.source).toBe("table");
      expect(catalog.version).toBe(TABLE_PIN);
      for (const list of [catalog.models, catalog.efforts, catalog.contextWindows, catalog.permissionModes]) {
        expect(list.filter(o => o.isDefault).length).toBeLessThanOrEqual(1);
        expect(new Set(list.map(o => o.value)).size).toBe(list.length);
      }
    }
  });

  it("Claude Code offers the models, effort levels, context windows and permission modes its CLI takes, bypass being what runs today", () => {
    const claude = harnessCatalog("claude")!;
    expect(claude.models.map(o => o.value)).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
    expect(claude.models.find(o => o.isDefault)?.value).toBe("claude-opus-5");
    expect(claude.models.map(o => o.contextWindows)).toEqual([["200k", "1m"], ["200k", "1m"], []]);
    expect(claude.efforts.map(o => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claude.contextWindows).toEqual([{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }]);
    expect(claude.permissionModes.map(o => o.value)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "manual", "dontAsk"]);
    expect(claude.permissionModes.find(o => o.isDefault)?.value).toBe("bypassPermissions");
    expect(claude.permissionModes.every(o => o.description !== undefined)).toBe(true);
  });

  it("a CLI without a flag, or with open values, leaves that list empty", () => {
    expect(harnessCatalog("gemini")!.efforts).toEqual([]);
    expect(harnessCatalog("pi")!.permissionModes).toEqual([]);
    expect(harnessCatalog("opencode")!.efforts).toEqual([]);
    expect(harnessCatalog("codex")!.models).toEqual([]);
    expect(harnessCatalog("codex")!.contextWindows).toEqual([]);
    expect(harnessCatalog("aider")).toBeUndefined();
  });
});

describe("catalogFromProbe", () => {
  const probe: ClaudeCatalogProbe = {
    version: "2.1.257",
    models: [
      { slug: "claude-opus-5", label: "Opus", description: "Opus 5 with 1M context", efforts: ["low", "high"], contextWindows: ["200k", "1m"], isDefault: true },
      { slug: "claude-haiku-4-5-20251001", label: "Haiku", efforts: [], contextWindows: [], isDefault: false },
      { slug: "claude-next-6", label: "Next", efforts: ["low", "turbo"], contextWindows: [], isDefault: false },
    ],
    efforts: ["low", "high", "turbo"],
    permissionModes: ["default", "plan", "yolo"],
  };

  it("takes the binary's values and defaults, borrows the table's labels and descriptions, and says the binary answered", () => {
    const catalog = catalogFromProbe(probe);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog).toMatchObject({ harness: "claude", label: "Claude Code", source: "harness", version: "2.1.257" });
    expect(catalog.models).toEqual([
      { value: "claude-opus-5", label: "Opus 5", description: "Opus 5 with 1M context", isDefault: true, efforts: ["low", "high"], contextWindows: ["200k", "1m"] },
      { value: "claude-haiku-4-5-20251001", label: "Haiku", efforts: [], contextWindows: [] },
      { value: "claude-next-6", label: "Next", efforts: ["low", "turbo"], contextWindows: [] },
    ]);
    expect(catalog.efforts).toEqual([{ value: "low", label: "Low" }, { value: "high", label: "High" }, { value: "turbo", label: "Turbo" }]);
    expect(catalog.contextWindows).toEqual(harnessCatalog("claude")!.contextWindows);
    expect(catalog.permissionModes.map(o => o.value)).toEqual(["default", "plan", "yolo"]);
    expect(catalog.permissionModes[1]?.description).toBe("Read and plan only; no changes");
    // A mode the table has no words for still shows, named as the CLI spells it.
    expect(catalog.permissionModes[2]).toEqual({ value: "yolo", label: "yolo" });
    // The table's bypass default is not among the binary's modes here, so nothing is default.
    expect(catalog.permissionModes.some(o => o.isDefault)).toBe(false);
  });

  it("a probe without a version says so instead of pretending to the table's pin", () => {
    expect(catalogFromProbe({ ...probe, version: null }).version).toBeNull();
  });
});
