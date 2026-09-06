// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { HarnessCatalog, startPicks } from "@wsp/protocol";
import { HARNESS_CATALOGS, TABLE_PIN, catalogFromProbe, harnessCatalog, type HarnessCatalogProbe } from "../src/harness-catalog.js";

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

describe("startPicks", () => {
  const claude = harnessCatalog("claude")!;
  const MODELS = "Fable 5.1 (claude-fable-5-1), Opus 5 (claude-opus-5), Sonnet 5 (claude-sonnet-5)";

  it("a start that opens a thread without a model runs the catalog's default, the one the composer shows; a resume keeps the thread's own", () => {
    expect(startPicks(claude, {}, true)).toEqual({ model: "claude-opus-5" });
    expect(startPicks(claude, {}, false)).toEqual({});
    expect(startPicks(claude, { model: "claude-sonnet-5", effort: "low", permissionMode: "plan" }, true)).toEqual({ model: "claude-sonnet-5", effort: "low", permissionMode: "plan" });
    expect(startPicks(claude, { effort: "max" }, false)).toEqual({ effort: "max" });
    const noDefault = { ...claude, models: claude.models.map(({ isDefault: _d, ...m }) => m) };
    expect(startPicks(noDefault, {}, true)).toEqual({});
  });

  it("refuses a value the catalog does not list, naming the list in the composer's words", () => {
    expect(() => startPicks(claude, { model: "claude-haiku-4-5" }, true)).toThrow(`model "claude-haiku-4-5" is not one claude takes; one of: ${MODELS}`);
    expect(() => startPicks(claude, { effort: "ultra" }, false)).toThrow('effort "ultra" is not one claude takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)');
    expect(() => startPicks(claude, { permissionMode: "yolo" }, true)).toThrow(
      'access mode "yolo" is not one claude takes; one of: Default (default), Accept edits (acceptEdits), Plan (plan), Bypass (bypassPermissions), Auto (auto), Manual (manual), Don\'t ask (dontAsk)',
    );
  });

  it("an effort is checked against the model's own list where the model has one, the chosen or the default model", () => {
    const narrowed = { ...claude, models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, efforts: ["high", "max"] }, { value: "claude-haiku-4-5", label: "Haiku", efforts: [] }] };
    expect(startPicks(narrowed, { effort: "max" }, true)).toEqual({ model: "claude-opus-5", effort: "max" });
    expect(() => startPicks(narrowed, { effort: "low" }, true)).toThrow('effort "low" is not one Opus 5 takes; one of: High (high), Max (max)');
    expect(() => startPicks(narrowed, { model: "claude-haiku-4-5", effort: "low" }, true)).toThrow("Haiku takes no effort");
    expect(startPicks(narrowed, { effort: "low" }, false)).toEqual({ effort: "low" });
  });

  it("a list the CLI leaves empty takes any value, since the values are open or the flag does not exist", () => {
    const codex = harnessCatalog("codex")!;
    expect(startPicks(codex, { model: "gpt-5-codex" }, true)).toEqual({ model: "gpt-5-codex" });
    expect(startPicks(codex, {}, true)).toEqual({});
    expect(() => startPicks(codex, { effort: "ultra" }, true)).toThrow('effort "ultra" is not one codex takes');
    const pi = harnessCatalog("pi")!;
    expect(startPicks(pi, { permissionMode: "anything" }, true)).toEqual({ permissionMode: "anything" });
  });

  it("a harness without a catalog takes any value and fills no default; only the three picks come out, whatever else the request carries", () => {
    const request = { prompt: "go", harness: "aider", model: "gpt-9", effort: "high", requestId: "r1", startedBy: "cli", cwd: "/w" };
    expect(startPicks(undefined, request, true)).toEqual({ model: "gpt-9", effort: "high" });
    expect(startPicks(claude, { ...request, model: "claude-sonnet-5" }, false)).toEqual({ model: "claude-sonnet-5", effort: "high" });
  });
});

describe("catalogFromProbe", () => {
  const probe: HarnessCatalogProbe = {
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
    const catalog = catalogFromProbe(harnessCatalog("claude")!, probe);
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
    expect(catalogFromProbe(harnessCatalog("claude")!, { ...probe, version: null }).version).toBeNull();
  });

  it("keeps the harness-level flags the runtime set on the table: the default harness stays marked when its binary answered", () => {
    expect(catalogFromProbe({ ...harnessCatalog("claude")!, isDefault: true, steers: true }, probe)).toMatchObject({ isDefault: true, steers: true });
    expect(catalogFromProbe(harnessCatalog("claude")!, probe).isDefault).toBeUndefined();
  });
});
