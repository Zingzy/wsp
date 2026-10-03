// SPDX-License-Identifier: AGPL-3.0-only
// Settings, Recipes: the list, a recipe open with its ticks written whole,
// the delete asked first, and the empty page with its act.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeFile, type RecipeOptions, type RecipeView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { closeAdd, useAddFlow } from "../src/settings/add/addFlow.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

beforeEach(() => resetSettings());
afterEach(() => {
  act(() => closeAdd());
  cleanup();
});

describe("Settings, Recipes", () => {
  const OPTIONS: RecipeOptions = { agents: [{ id: "claude", name: "Claude Code", signins: ["vault"] }, { id: "codex", name: "Codex", signins: ["machine"] }], mcp: [{ name: "context7", agents: ["claude"] }], clis: [{ name: "gh", via: "brew" }], skills: [], plugins: [], configs: [] };
  const builders: RecipeView = { name: "Builders", slug: "builders", summary: "1 agent, 1 MCP server", machines: ["spoo", "studio"], file: RecipeFile.parse({ name: "Builders", agents: { claude: { signin: "vault" } }, mcp: { context7: { agents: ["claude"] } } }) };

  it("says there are none yet with the act under it", async () => {
    mountSettings({ api: settingsApi({ recipesList: async () => [] } as Partial<Api>).api, at: { kind: "group", group: "recipes" } });
    await settle();
    expect(document.querySelector("[data-k=recipes-none]")?.textContent).toBe("No recipes yet. Save one at the end of Add a computer.");
    fireEvent.click(document.querySelector("[data-settings-card='recipes'] [data-k=add-computer-button]")!);
    expect(useAddFlow.getState().open).toBe(true);
  });

  it("lists each recipe with what it holds and who follows it, and opens one with its ticks, a tick writing the recipe whole", async () => {
    const saved: { name: string; from: unknown }[] = [];
    const fake = settingsApi({ recipesList: async () => [builders], recipesOptions: async () => OPTIONS, recipesSave: async (name: string, from: unknown) => (saved.push({ name, from }), builders) } as Partial<Api>);
    mountSettings({ api: fake.api, at: { kind: "group", group: "recipes" } });
    await settle();
    const row = document.querySelector<HTMLElement>("[data-recipe-row='builders']")!;
    expect(row.querySelector("[data-grid-name]")?.textContent).toBe("Builders");
    expect(row.textContent).toContain("spoo, studio");
    fireEvent.click(row);
    await settle();
    expect(document.querySelector("[data-k=recipe-head] [data-settings-description]")?.textContent).toBe("Followed by spoo and studio.");
    expect([...document.querySelectorAll("[data-settings-card='recipe-agents'] [data-pick-row]")].map(r => [r.getAttribute("data-pick-row"), r.getAttribute("data-checked")])).toEqual([
      ["claude", "true"],
      ["codex", "false"],
    ]);
    expect(document.querySelector("[data-settings-card='recipe-agents'] [data-pick-row='claude']")?.textContent).toContain("Copy the key");
    // A computer names the recipe's file, so a recipe that is followed keeps its name.
    expect(document.querySelector<HTMLInputElement>("[data-k=recipe-name]")?.readOnly).toBe(true);
    fireEvent.click(document.querySelector("[data-settings-card='recipe-agents'] [data-pick-row='codex'] [role=checkbox]")!);
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("Builders");
    expect(Object.keys((saved[0]!.from as { file: RecipeFile }).file.agents)).toEqual(["claude", "codex"]);
  });

  it("asks before deleting a recipe, naming what its computers keep, and the icon picked is kept with the person's looks", async () => {
    const removed: string[] = [];
    const fake = settingsApi({ recipesList: async () => [builders], recipesOptions: async () => OPTIONS, recipesRemove: async (name: string) => (removed.push(name), builders) } as Partial<Api>);
    mountSettings({ api: fake.api, at: { kind: "group", group: "recipes" } });
    await settle();
    fireEvent.click(document.querySelector("[data-recipe-row='builders']")!);
    await settle();
    expect(document.querySelector("[data-k=delete-line]")?.textContent).toContain("spoo and studio keep what they have and follow nothing.");
    fireEvent.click(document.querySelector("[data-k=delete]")!);
    await settle();
    expect(removed).toEqual([]);
    fireEvent.click(document.querySelector("[data-k=delete-confirm]")!);
    await settle();
    expect(removed).toEqual(["builders"]);
  });
});
