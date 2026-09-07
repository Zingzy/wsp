// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { THREAD_AGENTS } from "@wsp/catalog";
import { HarnessCatalog, catalogSourceLine, effortsFor, markedDefault, noModelsLine, startPicks, type HarnessCatalogProbe } from "@wsp/protocol";
import { HARNESS_CATALOGS, catalogFromProbe, harnessCatalog } from "../src/harness-catalog.js";

describe("harness catalogs", () => {
  it("names every harness the recipe collects, each parsing as the wire type with at most one default per picker", () => {
    expect(HARNESS_CATALOGS.map(c => c.harness)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const catalog of HARNESS_CATALOGS) {
      expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
      expect(catalog.source).toBe("table");
      expect(catalog.refusal).toBeUndefined();
      for (const list of [catalog.models, catalog.efforts, catalog.contextWindows, catalog.permissionModes]) {
        expect(list.filter(o => o.isDefault).length).toBeLessThanOrEqual(1);
        expect(new Set(list.map(o => o.value)).size).toBe(list.length);
      }
    }
  });

  it("every agent wsp can run stands in with its own models, its own pin and its own binary in the footer, never another agent's", () => {
    for (const id of THREAD_AGENTS) {
      const table = harnessCatalog(id)!;
      // The bug this walks: a tab whose binary never answered showed no model and another agent's pin.
      expect(table.models.length).toBeGreaterThan(0);
      expect(table.version).toMatch(/^\S+ \d+\.\d+\.\d+, \d{4}-\d{2}-\d{2}$/);
      const line = catalogSourceLine(table);
      expect(line).toBe(`${id} table · ${table.version!}`);
      // One line at the popup's width: 48 characters of the 10px mono the footer draws in (measured in Chromium).
      expect(line.length).toBeLessThanOrEqual(48);
      for (const other of THREAD_AGENTS.filter(a => a !== id)) {
        expect(line).not.toContain(other);
        expect(noModelsLine(table)).not.toContain(other);
      }
    }
  });

  it("the pin is what was run on the row's own binary, and a row written from a CLI's docs claims none", () => {
    expect(harnessCatalog("claude")!.version).toBe("--help 2.1.257, 2026-09-05");
    expect(harnessCatalog("codex")!.version).toBe("app-server 0.153.0, 2026-09-07");
    expect(catalogSourceLine(harnessCatalog("codex")!)).toBe("codex table · app-server 0.153.0, 2026-09-07");
    for (const id of ["gemini", "opencode", "pi", "hermes"]) {
      expect(harnessCatalog(id)!.version, id).toBeNull();
      expect(catalogSourceLine(harnessCatalog(id)!)).toBe(`${id} table`);
    }
  });

  it("Codex offers the models and reasoning efforts its app-server reports, and no context window", () => {
    const codex = harnessCatalog("codex")!;
    expect(codex.models.map(o => o.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"]);
    expect(codex.models.find(o => o.isDefault)?.value).toBe("gpt-5.6-sol");
    expect(codex.models.map(o => o.efforts)).toEqual([
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max"],
      ["low", "medium", "high", "xhigh"],
      ["low", "medium", "high", "xhigh"],
    ]);
    expect(codex.efforts.map(o => o.value)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    // The effort the app-server reports for the default model, so the tab shows a default with no probe at all.
    expect(codex.efforts.find(o => o.isDefault)?.value).toBe("low");
    expect(codex.contextWindows).toEqual([]);
    expect(codex.permissionModes.map(o => o.value)).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(codex.permissionModes.find(o => o.isDefault)?.value).toBe("danger-full-access");
  });

  it("Claude Code offers the models, effort levels, context windows and permission modes its CLI takes, bypass being what runs today", () => {
    const claude = harnessCatalog("claude")!;
    expect(claude.models.map(o => o.value)).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
    expect(claude.models.find(o => o.isDefault)?.value).toBe("claude-opus-5");
    expect(claude.models.map(o => o.contextWindows)).toEqual([["200k", "1m"], ["200k", "1m"], []]);
    expect(claude.efforts.map(o => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The handshake names no default effort; the CLI documents high on every model that takes one.
    expect(claude.efforts.find(o => o.isDefault)?.value).toBe("high");
    expect(claude.contextWindows).toEqual([{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }]);
    expect(claude.permissionModes.map(o => o.value)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "manual", "dontAsk"]);
    expect(claude.permissionModes.find(o => o.isDefault)?.value).toBe("bypassPermissions");
    expect(claude.permissionModes.every(o => o.description !== undefined)).toBe(true);
  });

  it("a CLI without a flag, or with open values, leaves that list empty", () => {
    expect(harnessCatalog("gemini")!.efforts).toEqual([]);
    expect(harnessCatalog("pi")!.permissionModes).toEqual([]);
    expect(harnessCatalog("opencode")!.efforts).toEqual([]);
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
    const gemini = harnessCatalog("gemini")!;
    expect(startPicks(gemini, { model: "gemini-3-pro" }, true)).toEqual({ model: "gemini-3-pro" });
    expect(startPicks(gemini, { effort: "anything" }, true)).toEqual({ effort: "anything" });
    const pi = harnessCatalog("pi")!;
    expect(startPicks(pi, { permissionMode: "anything" }, true)).toEqual({ permissionMode: "anything" });
  });

  it("a start on the Codex table runs its default model and refuses a model or effort that table does not carry", () => {
    const codex = harnessCatalog("codex")!;
    expect(startPicks(codex, {}, true)).toEqual({ model: "gpt-5.6-sol" });
    expect(markedDefault(effortsFor(codex, markedDefault(codex.models) ?? null))?.value).toBe("low");
    expect(startPicks(codex, { model: "gpt-5.5", effort: "high", permissionMode: "read-only" }, true)).toEqual({ model: "gpt-5.5", effort: "high", permissionMode: "read-only" });
    expect(() => startPicks(codex, { model: "gpt-4" }, true)).toThrow('model "gpt-4" is not one codex takes');
    expect(() => startPicks(codex, { model: "gpt-5.5", effort: "ultra" }, true)).toThrow('effort "ultra" is not one GPT-5.5 takes');
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
    expect(catalog.efforts).toEqual([{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }, { value: "turbo", label: "Turbo" }]);
    // A binary that no longer lists the table's default effort leaves none marked.
    expect(catalogFromProbe(harnessCatalog("claude")!, { ...probe, efforts: ["low", "turbo"] }).efforts.some(o => o.isDefault)).toBe(false);
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
    expect(catalogSourceLine(catalogFromProbe(harnessCatalog("claude")!, { ...probe, version: null }))).toBe("Claude Code on this machine");
    expect(catalogSourceLine(catalogFromProbe(harnessCatalog("claude")!, probe))).toBe("Claude Code 2.1.257 on this machine");
  });

  it("a model whose efforts the binary did not name keeps none of its own, so every effort the catalog lists stays open to it", () => {
    const routed = { ...probe, models: [{ slug: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", contextWindows: [], isDefault: true }, ...probe.models.map(m => ({ ...m, isDefault: false }))] };
    const catalog = catalogFromProbe(harnessCatalog("codex")!, routed);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.models[0]).toEqual({ value: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", isDefault: true, contextWindows: [] });
    expect("efforts" in catalog.models[0]!).toBe(false);
    // Absent, not empty: empty would mean the model takes no effort at all and refuse every one.
    expect(effortsFor(catalog, catalog.models[0]!).map(o => o.value)).toEqual(["low", "high", "turbo"]);
    expect(startPicks(catalog, { effort: "turbo" }, true)).toEqual({ model: "anthropic/claude-sonnet-4.5", effort: "turbo" });
    expect(() => startPicks(catalog, { effort: "off" }, true)).toThrow('effort "off" is not one codex takes');
    // A model that named an empty list still takes none.
    expect(effortsFor(catalog, catalog.models.find(m => m.value === "claude-haiku-4-5-20251001")!)).toEqual([]);
  });

  it("marks the effort the binary reports for the model it would run, and keeps the table's mark where it reports none", () => {
    const withDefault = { ...probe, models: probe.models.map(m => (m.isDefault ? { ...m, defaultEffort: "turbo" } : m)) };
    expect(catalogFromProbe(harnessCatalog("codex")!, withDefault).efforts.find(o => o.isDefault)?.value).toBe("turbo");
    // The table's own mark is dropped, not kept beside the binary's.
    expect(catalogFromProbe(harnessCatalog("codex")!, withDefault).efforts.filter(o => o.isDefault)).toHaveLength(1);
    expect(catalogFromProbe(harnessCatalog("codex")!, probe).efforts.find(o => o.isDefault)?.value).toBe("low");
    // An effort the binary names as its default that its own list does not carry marks nothing.
    const odd = { ...probe, models: probe.models.map(m => (m.isDefault ? { ...m, defaultEffort: "nope" } : m)) };
    expect(catalogFromProbe(harnessCatalog("codex")!, odd).efforts.some(o => o.isDefault)).toBe(false);
  });

  it("keeps the harness-level flags the runtime set on the table: the default harness stays marked when its binary answered", () => {
    expect(catalogFromProbe({ ...harnessCatalog("claude")!, isDefault: true, steers: true }, probe)).toMatchObject({ isDefault: true, steers: true });
    expect(catalogFromProbe(harnessCatalog("claude")!, probe).isDefault).toBeUndefined();
  });
});
