// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { THREAD_AGENTS } from "@wsp/catalog";
import { HarnessCatalog, catalogSourceLine, effortsFor, keptAccess, listedPick, markedDefault, modelOf, noModelsLine, startPicks, THIS_COMPUTER, type HarnessCatalogProbe } from "@wsp/protocol";
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
      const line = catalogSourceLine(table, THIS_COMPUTER);
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
    expect(catalogSourceLine(harnessCatalog("codex")!, THIS_COMPUTER)).toBe("codex table · app-server 0.153.0, 2026-09-07");
    for (const id of ["gemini", "opencode", "pi", "hermes"]) {
      expect(harnessCatalog(id)!.version, id).toBeNull();
      expect(catalogSourceLine(harnessCatalog(id)!, THIS_COMPUTER)).toBe(`${id} table`);
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
    // The app-server reports a default effort per model, not one for the binary: Sol runs low, the other four medium.
    expect(codex.models.map(o => o.defaultEffort)).toEqual(["low", "medium", "medium", "medium", "medium"]);
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

describe("the default effort of a pick", () => {
  const codex = harnessCatalog("codex")!;
  const model = (value: string) => codex.models.find(m => m.value === value) ?? null;
  const shown = (value: string | null) => markedDefault(effortsFor(codex, value === null ? null : model(value)))?.value;

  it("is the picked model's own, so the picker marks what that model will run rather than what the binary's default model runs", () => {
    expect(shown("gpt-5.5")).toBe("medium");
    expect(shown("gpt-5.6-terra")).toBe("medium");
    expect(shown("gpt-5.6-sol")).toBe("low");
    // One mark on the list, not the model's beside the catalog's.
    expect(effortsFor(codex, model("gpt-5.5")).filter(o => o.isDefault).map(o => o.value)).toEqual(["medium"]);
  });

  it("is the catalog's mark for a model that names none, and for no model at all", () => {
    const claude = harnessCatalog("claude")!;
    expect(markedDefault(effortsFor(claude, markedDefault(claude.models) ?? null))?.value).toBe("high");
    expect(markedDefault(effortsFor(claude, null))?.value).toBe("high");
    // Every model this list carries is one a thread may be opened on, so each has the effort its turns run at.
    for (const m of claude.models) expect(markedDefault(effortsFor(claude, m))?.value).toBe("high");
    expect(modelOf(claude, "claude-fable-5-1")).toMatchObject({ label: "Fable 5.1", contextWindows: ["200k", "1m"] });
    // A model the binary routes to another provider names no efforts and no default of its own.
    expect(markedDefault(effortsFor(codex, { value: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5" }))?.value).toBe("low");
    expect(shown(null)).toBe("low");
  });

  it("marks nothing when the model names a default its own list does not carry", () => {
    const odd = { ...codex, models: [{ value: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"], defaultEffort: "medium" }] };
    expect(effortsFor(odd, odd.models[0]!).some(o => o.isDefault)).toBe(false);
  });
});

describe("what an access mode says it does", () => {
  // This menu is where a person decides what an agent may do on their computer, so every sentence is about that and
  // not about the binary behind it: no word from an agent's own documentation, no name of an agent, one sentence each.
  const INTERNALS = [/classifier/i, /\bCLIs?\b/, /print mode/i, /\bmachines?\b/i];
  const AGENT_NAMES = HARNESS_CATALOGS.flatMap(c => [new RegExp(`\\b${c.harness}\\b`, "i"), new RegExp(`\\b${c.label}\\b`, "i")]);

  it("says what the agent may do, naming no agent and nothing inside one", () => {
    const modes = HARNESS_CATALOGS.flatMap(c => c.permissionModes.map(o => [`${c.harness} ${o.value}`, o.description] as const));
    expect(modes.length).toBeGreaterThan(15);
    for (const [where, description] of modes) {
      expect(description, where).toBeDefined();
      for (const word of [...INTERNALS, ...AGENT_NAMES]) expect(description!, `${where} against ${word.source}`).not.toMatch(word);
      // One sentence: the semicolon joins two halves of the same one, a full stop would start another.
      expect(description!, where).not.toContain(".");
    }
  });

  it("the two a person could not read now read as a person would say them", () => {
    const claude = harnessCatalog("claude")!;
    const mode = (value: string) => claude.permissionModes.find(o => o.value === value)?.description;
    expect(mode("auto")).toBe("The agent decides which actions to ask about; where the account has no such mode it asks as Default does");
    expect(mode("manual")).toBe("Asks before every action");
  });
});

describe("the access a kept machine's threads start at", () => {
  it("every harness with an access mode names the one a kept machine runs, and it is not the throwaway default", () => {
    for (const catalog of HARNESS_CATALOGS) {
      if (catalog.permissionModes.length === 0) {
        expect(catalog.keptMode).toBeUndefined();
        continue;
      }
      expect(catalog.keptMode).toBeDefined();
      expect(catalog.permissionModes.map(o => o.value)).toContain(catalog.keptMode);
      expect(catalog.keptMode).not.toBe(markedDefault(catalog.permissionModes)?.value);
      // Each row names its own skip-everything mode, so nothing outside the table keeps a list of them.
      expect(catalog.bypassMode).toBeDefined();
      expect(catalog.permissionModes.map(o => o.value)).toContain(catalog.bypassMode);
      expect(catalog.bypassMode).not.toBe(catalog.keptMode);
    }
  });

  it("claude asks the person in its default mode; codex exec cannot ask, so its narrowest working sandbox stands", () => {
    expect(harnessCatalog("claude")!.keptMode).toBe("default");
    expect(harnessCatalog("codex")!.keptMode).toBe("workspace-write");
  });

  it("moves the default mark to the asking mode and names the machine on every mode that skips the asking", () => {
    const kept = keptAccess(harnessCatalog("claude")!, THIS_COMPUTER);
    expect(markedDefault(kept.permissionModes)?.value).toBe("default");
    expect(kept.permissionModes.filter(o => o.isDefault)).toHaveLength(1);
    expect(kept.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe("Bypass on this computer");
    // The CLI's own word stays as the short form the picker's button wears; no other row has one.
    expect(kept.permissionModes.find(o => o.value === "bypassPermissions")?.short).toBe("Bypass");
    expect(kept.permissionModes.filter(o => o.short !== undefined).map(o => o.value)).toEqual(["bypassPermissions"]);
    // Same modes, same order, same descriptions: bypass is one pick away, where it was.
    expect(kept.permissionModes.map(o => o.value)).toEqual(harnessCatalog("claude")!.permissionModes.map(o => o.value));
    expect(kept.permissionModes.map(o => o.description)).toEqual(harnessCatalog("claude")!.permissionModes.map(o => o.description));
    expect(HarnessCatalog.parse(kept)).toEqual(kept);
    const codex = keptAccess(harnessCatalog("codex")!, THIS_COMPUTER);
    expect(markedDefault(codex.permissionModes)?.value).toBe("workspace-write");
    expect(codex.permissionModes.find(o => o.value === "danger-full-access")?.label).toBe("Full access on this computer");
    expect(codex.permissionModes.find(o => o.value === "danger-full-access")?.short).toBe("Full access");
  });

  it("a catalog with no access mode of its own comes back untouched, so nothing invents one for it", () => {
    const pi = harnessCatalog("pi")!;
    expect(keptAccess(pi, THIS_COMPUTER)).toBe(pi);
  });
});

describe("startPicks", () => {
  const claude = harnessCatalog("claude")!;
  const MODELS = "Fable 5.1 (claude-fable-5-1), Opus 5 (claude-opus-5), Sonnet 5 (claude-sonnet-5)";
  /** A catalog whose default model takes two of the five efforts and whose other model takes none. */
  const narrowed = { ...claude, models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, efforts: ["high", "max"] }, { value: "claude-haiku-4-5", label: "Haiku", efforts: [] }] };

  it("a start that opens a thread without a pick runs every default the composer shows, the access included; a resume keeps the thread's own", () => {
    // Claude names no default effort per model, so the catalog's own mark is what the pick runs at. The access is
    // filled in like the other two: an unnamed one used to reach the adapter as nothing, which it reads as bypass.
    expect(startPicks(claude, {}, true)).toEqual({ model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" });
    expect(startPicks(claude, {}, false)).toEqual({});
    expect(startPicks(claude, { model: "claude-sonnet-5", effort: "low", permissionMode: "plan" }, true)).toEqual({ model: "claude-sonnet-5", effort: "low", permissionMode: "plan" });
    expect(startPicks(claude, { effort: "max" }, false)).toEqual({ effort: "max" });
    const noDefault = { ...claude, models: claude.models.map(({ isDefault: _d, ...m }) => m) };
    expect(startPicks(noDefault, {}, true)).toEqual({ effort: "high", permissionMode: "bypassPermissions" });
    // On a machine the person keeps the same start runs the mode its harness asks in, and nothing else changes.
    expect(startPicks(keptAccess(claude, THIS_COMPUTER), {}, true)).toEqual({ model: "claude-opus-5", effort: "high", permissionMode: "default" });
  });

  it("listedPick keeps a remembered pick this list carries and drops one it does not, which is not a refusal", () => {
    // The one rule every reader of a remembered pick uses: the composer's pickers, its start options and the
    // runtime's own read of the record. A pick belongs to a harness and is kept per workspace, so the reader in
    // front of it may be another harness's list.
    expect(listedPick(claude.permissionModes, "plan")).toBe("plan");
    expect(listedPick(claude.permissionModes, "read-only")).toBeUndefined();
    expect(listedPick(claude.permissionModes, undefined)).toBeUndefined();
    expect(listedPick(harnessCatalog("pi")!.permissionModes, "plan")).toBeUndefined();
    // Dropped, the start runs that list's own default, and never the value a caller named: that one still refuses.
    expect(startPicks(claude, { permissionMode: listedPick(claude.permissionModes, "read-only") }, true).permissionMode).toBe("bypassPermissions");
    expect(() => startPicks(claude, { permissionMode: "read-only" }, true)).toThrow(/not one claude takes/);
  });

  it("refuses a value the catalog does not list, naming the list in the composer's words", () => {
    expect(() => startPicks(claude, { model: "claude-haiku-4-5" }, true)).toThrow(`model "claude-haiku-4-5" is not one claude takes; one of: ${MODELS}`);
    expect(() => startPicks(claude, { effort: "ultra" }, false)).toThrow('effort "ultra" is not one claude takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)');
    expect(() => startPicks(claude, { permissionMode: "yolo" }, true)).toThrow(
      'access mode "yolo" is not one claude takes; one of: Default (default), Accept edits (acceptEdits), Plan (plan), Bypass (bypassPermissions), Auto (auto), Manual (manual), Don\'t ask (dontAsk)',
    );
  });

  it("a model that takes no effort at all is given none, and one that takes some runs the default its own list carries", () => {
    expect(startPicks(narrowed, { model: "claude-haiku-4-5" }, true)).toEqual({ model: "claude-haiku-4-5", permissionMode: "bypassPermissions" });
    expect(startPicks(narrowed, {}, true)).toEqual({ model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" });
    // A model whose own list drops the catalog's marked effort is left to the CLI, since nothing in its list is marked.
    const off = { ...claude, models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, efforts: ["low", "max"] }] };
    expect(startPicks(off, {}, true)).toEqual({ model: "claude-opus-5", permissionMode: "bypassPermissions" });
  });

  it("an effort is checked against the model's own list where the model has one, the chosen or the default model", () => {
    expect(startPicks(narrowed, { effort: "max" }, true)).toEqual({ model: "claude-opus-5", effort: "max", permissionMode: "bypassPermissions" });
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
    expect(startPicks(codex, {}, true)).toEqual({ model: "gpt-5.6-sol", effort: "low", permissionMode: "danger-full-access" });
    expect(markedDefault(effortsFor(codex, markedDefault(codex.models) ?? null))?.value).toBe("low");
    expect(startPicks(codex, { model: "gpt-5.5", effort: "high", permissionMode: "read-only" }, true)).toEqual({ model: "gpt-5.5", effort: "high", permissionMode: "read-only" });
    // The model's own default, not the catalog's low, which is the effort the binary reports for gpt-5.6-sol.
    expect(startPicks(codex, { model: "gpt-5.5" }, true)).toEqual({ model: "gpt-5.5", effort: "medium", permissionMode: "danger-full-access" });
    expect(startPicks(codex, { model: "gpt-5.5" }, false)).toEqual({ model: "gpt-5.5" });
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
    expect(catalog.permissionModes[1]?.description).toBe("Reads and plans only; changes nothing");
    // A mode the table has no words for still shows, named as the CLI spells it.
    expect(catalog.permissionModes[2]).toEqual({ value: "yolo", label: "yolo" });
    // The table's bypass default is not among the binary's modes here, so nothing is default.
    expect(catalog.permissionModes.some(o => o.isDefault)).toBe(false);
  });

  it("a probe without a version says so instead of pretending to the table's pin", () => {
    expect(catalogFromProbe(harnessCatalog("claude")!, { ...probe, version: null }).version).toBeNull();
    expect(catalogSourceLine(catalogFromProbe(harnessCatalog("claude")!, { ...probe, version: null }), THIS_COMPUTER)).toBe("Claude Code on this computer");
    expect(catalogSourceLine(catalogFromProbe(harnessCatalog("claude")!, probe), "hetzner")).toBe("Claude Code 2.1.257 on hetzner");
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

  it("carries each model's own default effort, so a pick runs what the binary reports for that model", () => {
    const perModel = { ...probe, models: probe.models.map(m => (m.slug === "claude-next-6" ? { ...m, defaultEffort: "turbo" } : m)) };
    const catalog = catalogFromProbe(harnessCatalog("claude")!, perModel);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.models.map(m => m.defaultEffort)).toEqual([undefined, undefined, "turbo"]);
    expect(markedDefault(effortsFor(catalog, catalog.models[2]!))?.value).toBe("turbo");
    expect(startPicks(catalog, { model: "claude-next-6" }, true)).toEqual({ model: "claude-next-6", effort: "turbo" });
    // The models that named none keep the catalog's mark, which the binary reports for the model it would run.
    expect(markedDefault(effortsFor(catalog, catalog.models[0]!))?.value).toBe("high");
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
