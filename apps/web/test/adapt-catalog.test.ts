// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CATALOG, catalogFor, catalogFromHarness, deriveSession } from "../src/adapt/index.js";
import { CHAT_HARNESS, CHAT_STREAM } from "./fixtures/chat-stream.js";

describe("CLAUDE_CODE_CATALOG", () => {
  it("seeds every picker with one entry and exactly one default", () => {
    expect(CLAUDE_CODE_CATALOG.slashCommands).toHaveLength(1);
    expect(CLAUDE_CODE_CATALOG.models.filter(m => m.isDefault)).toHaveLength(1);
    expect(CLAUDE_CODE_CATALOG.permissionModes.filter(m => m.isDefault)).toHaveLength(1);
    expect(CLAUDE_CODE_CATALOG.slashCommands[0]?.name).not.toMatch(/^\//);
  });

  it("resolves by the harness name sessions.start uses", () => {
    expect(catalogFor("claude")).toBe(CLAUDE_CODE_CATALOG);
    expect(catalogFor("codex")).toBeNull();
  });
});

describe("catalogFromHarness", () => {
  it("builds the pickers from what the session announced", () => {
    const model = deriveSession(CHAT_STREAM);
    expect(model.harness).toEqual(CHAT_HARNESS);
    const catalog = catalogFromHarness({ harness: model.harness, model: model.model });
    expect(catalog.slashCommands.map(c => c.name)).toEqual(["compact", "context", "cost", "init", "review"]);
    expect(catalog.models).toEqual([{ slug: "claude-sonnet-4-5", name: "claude-sonnet-4-5", isCustom: false, isDefault: true }]);
    expect(catalog.permissionModes).toEqual([{ slug: "bypassPermissions", name: "Bypass permissions", description: expect.any(String), isDefault: true }]);
  });

  it("falls back to the static catalog part by part", () => {
    expect(catalogFromHarness({ harness: null, model: null })).toEqual(CLAUDE_CODE_CATALOG);
    const partial = catalogFromHarness({ harness: { permissionMode: "plan" }, model: null });
    expect(partial.slashCommands).toBe(CLAUDE_CODE_CATALOG.slashCommands);
    expect(partial.models).toBe(CLAUDE_CODE_CATALOG.models);
    expect(partial.permissionModes).toEqual([{ slug: "plan", name: "Plan", description: expect.any(String), isDefault: true }]);
  });

  it("an unknown permission mode keeps its slug as the name", () => {
    expect(catalogFromHarness({ harness: { permissionMode: "yolo" }, model: null }).permissionModes).toEqual([{ slug: "yolo", name: "yolo", isDefault: true }]);
  });
});
