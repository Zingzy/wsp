// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CATALOG, catalogFor } from "../src/adapt/index.js";

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
