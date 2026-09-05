// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { HarnessCatalog } from "@wsp/protocol";
import { HARNESS_CATALOGS, harnessCatalog } from "../src/harness-catalog.js";

describe("harness catalogs", () => {
  it("names every harness the recipe collects, each parsing as the wire type with at most one default per picker", () => {
    expect(HARNESS_CATALOGS.map(c => c.harness)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const catalog of HARNESS_CATALOGS) {
      expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
      for (const list of [catalog.models, catalog.efforts, catalog.permissionModes]) {
        expect(list.filter(o => o.isDefault).length).toBeLessThanOrEqual(1);
        expect(new Set(list.map(o => o.value)).size).toBe(list.length);
      }
    }
  });

  it("Claude Code offers the models, effort levels and permission modes its CLI takes, bypass being what runs today", () => {
    const claude = harnessCatalog("claude")!;
    expect(claude.models.map(o => o.value)).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
    expect(claude.efforts.map(o => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claude.permissionModes.map(o => o.value)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(claude.permissionModes.find(o => o.isDefault)?.value).toBe("bypassPermissions");
  });

  it("a CLI without a flag, or with open values, leaves that list empty", () => {
    expect(harnessCatalog("gemini")!.efforts).toEqual([]);
    expect(harnessCatalog("pi")!.permissionModes).toEqual([]);
    expect(harnessCatalog("opencode")!.efforts).toEqual([]);
    expect(harnessCatalog("codex")!.models).toEqual([]);
    expect(harnessCatalog("aider")).toBeUndefined();
  });
});
