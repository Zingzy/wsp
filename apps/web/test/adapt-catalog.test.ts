// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { DEFAULT_HARNESS } from "../src/components/chat/ComposerOptionPickers.js";
import { HARNESS_CLIENTS, catalogFor, catalogFromHarness, deriveSession, harnessClient } from "../src/adapt/index.js";
import { CHAT_HARNESS, CHAT_STREAM } from "./fixtures/chat-stream.js";

describe("the client's harness registry", () => {
  it("has one module per harness, each seeding the slash menu with names without their slash", () => {
    expect(HARNESS_CLIENTS.map(c => c.harness)).toEqual(["claude"]);
    for (const c of HARNESS_CLIENTS) {
      expect(harnessClient(c.harness)).toBe(c);
      for (const s of c.slashCommands) expect(s.name).not.toMatch(/^\//);
    }
    expect(harnessClient("codex")).toBeUndefined();
    // The composer's first pick is the catalog's default agent, the same fact the runtime starts an unnamed thread on.
    expect(DEFAULT_HARNESS).toBe(DEFAULT_AGENT.id);
  });

  it("resolves a catalog by the harness id sessions.start uses, from the registered module alone", () => {
    for (const c of HARNESS_CLIENTS) expect(catalogFor(c.harness)).toEqual({ harness: c.harness, slashCommands: c.slashCommands });
    expect(catalogFor("codex")).toBeNull();
  });
});

describe("catalogFromHarness", () => {
  it("builds the slash menu from what the session announced, under the thread's harness", () => {
    const model = deriveSession(CHAT_STREAM);
    expect(model.harness).toEqual(CHAT_HARNESS);
    const catalog = catalogFromHarness({ id: "claude", harness: model.harness });
    expect(catalog.harness).toBe("claude");
    expect(catalog.slashCommands.map(c => c.name)).toEqual(["compact", "context", "cost", "init", "review"]);
  });

  it("falls back to the harness's registered seed when the CLI named no commands, and to nothing for a harness with no module", () => {
    const seed = harnessClient("claude")!.slashCommands;
    expect(catalogFromHarness({ id: "claude", harness: null })).toEqual({ harness: "claude", slashCommands: seed });
    expect(catalogFromHarness({ id: "claude", harness: { permissionMode: "plan" } }).slashCommands).toBe(seed);
    expect(catalogFromHarness({ id: "codex", harness: null })).toEqual({ harness: "codex", slashCommands: [] });
    expect(catalogFromHarness({ id: "codex", harness: { slashCommands: ["diff"] } }).slashCommands.map(c => c.name)).toEqual(["diff"]);
  });
});
