// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CATALOG, catalogFor, catalogFromHarness, deriveSession } from "../src/adapt/index.js";
import { CHAT_HARNESS, CHAT_STREAM } from "./fixtures/chat-stream.js";

describe("CLAUDE_CODE_CATALOG", () => {
  it("seeds the slash menu with one entry, named without its slash", () => {
    expect(CLAUDE_CODE_CATALOG.slashCommands).toHaveLength(1);
    expect(CLAUDE_CODE_CATALOG.slashCommands[0]?.name).not.toMatch(/^\//);
  });

  it("resolves by the harness name sessions.start uses", () => {
    expect(catalogFor("claude")).toBe(CLAUDE_CODE_CATALOG);
    expect(catalogFor("codex")).toBeNull();
  });
});

describe("catalogFromHarness", () => {
  it("builds the slash menu from what the session announced", () => {
    const model = deriveSession(CHAT_STREAM);
    expect(model.harness).toEqual(CHAT_HARNESS);
    expect(catalogFromHarness({ harness: model.harness }).slashCommands.map(c => c.name)).toEqual(["compact", "context", "cost", "init", "review"]);
  });

  it("falls back to the static seed when the CLI named no commands", () => {
    expect(catalogFromHarness({ harness: null })).toEqual(CLAUDE_CODE_CATALOG);
    expect(catalogFromHarness({ harness: { permissionMode: "plan" } }).slashCommands).toBe(CLAUDE_CODE_CATALOG.slashCommands);
  });
});
