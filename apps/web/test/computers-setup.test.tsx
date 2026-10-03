// SPDX-License-Identifier: AGPL-3.0-only
// What the setup job puts on Settings, Computers: the Pending list, each row
// carrying on where it was left, and a computer's page with the recipe it
// follows and its setup's steps.
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeFile, type PendingComputer, type PlaceSetup, type PlaceView, type RecipeView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { closeAdd, useAddFlow } from "../src/settings/add/addFlow.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false };
const AT = "2026-10-03T10:00:00.000Z";
const running: PlaceSetup = { state: "running", addId: "a_1", startedAt: AT, steps: [{ step: "floor", state: "done" }, { step: "agents", state: "done" }, { step: "skills", state: "running" }], waiting: [] };
const box = (id: string, name: string, over: Partial<PlaceView> = {}): PlaceView => ({ id, kind: "computer", name, default: false, present: true, ...over });

beforeEach(() => resetSettings());
afterEach(() => {
  act(() => closeAdd());
  cleanup();
});

describe("the Computers page's Pending list", () => {
  it("lists the adds not set up, a joined one out of the computers, each opening Add a computer where it was left", async () => {
    const jump: PendingComputer = { id: "a_jump", address: "root@jump", name: "jumpbox", step: "choosing", placeId: "p_jump", startedAt: AT, choices: RecipeFile.parse({ name: "jumpbox" }) };
    const refused: PendingComputer = { id: "a_old", address: "ubuntu@old", step: "check", startedAt: AT, choices: RecipeFile.parse({ name: "old" }), failed: { said: "old logs in as a user that is not root" } };
    useStore.setState({ places: [here, box("p_jump", "jumpbox")], pending: [jump, refused] });
    localStorage.setItem("wsp:add-reached", JSON.stringify({ a_jump: "skills" }));
    mountSettings({ api: settingsApi({ initGet: async () => null } as unknown as Partial<Api>).api, at: { kind: "group", group: "computers" } });
    await settle();
    expect([...document.querySelectorAll("[data-grid='computers'] [data-place-row]")].map(r => r.getAttribute("data-place-row"))).toEqual(["here"]);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-grid='pending'] [data-pending-row]")];
    expect(rows.map(r => r.querySelector("[data-grid-name]")?.textContent)).toEqual(["jumpbox", "ubuntu@old"]);
    expect(rows[0]!.textContent).toContain("Chosen up to Skills");
    expect(rows.map(r => r.querySelector("[data-state-mark]")?.getAttribute("data-state-mark"))).toEqual(["pending", "failed"]);
    fireEvent.click(rows[0]!);
    expect(useAddFlow.getState()).toMatchObject({ open: true, placeId: "p_jump", step: "skills" });
    act(() => closeAdd());
    fireEvent.click(rows[1]!);
    expect(useAddFlow.getState()).toMatchObject({ open: true, step: "where", address: "ubuntu@old" });
  });
});

describe("a computer's page after a setup", () => {
  it("names the recipe it follows, held until the host can move it, and lists the setup's steps", async () => {
    const builders: RecipeView = { name: "Builders", slug: "builders", summary: "1 agent", machines: ["studio"], file: RecipeFile.parse({ name: "Builders" }) };
    const studio = box("p_studio", "studio", { setup: running, picks: RecipeFile.parse({ name: "Builders" }), recipe: "builders" });
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: settingsApi({ initGet: async () => null, recipesList: async () => [builders] } as unknown as Partial<Api>).api, at: { kind: "computer", id: "p_studio" } });
    await settle();
    const row = document.querySelector("[data-settings-row='follows']")!;
    expect(row.querySelector("[data-settings-description]")?.textContent).toBe("Changes to it reach studio on their own.");
    await waitFor(() => expect(row.querySelector("[data-slot=select-trigger]")?.textContent).toBe("Builders"));
    expect(row.querySelector("[data-slot=select-trigger]")?.hasAttribute("disabled") || row.querySelector("[data-slot=select-trigger]")?.getAttribute("data-disabled") !== null).toBe(true);
    expect(document.querySelector("[data-settings-card='setup'] [data-settings-head]")?.textContent).toBe("Setup");
    expect([...document.querySelectorAll("[data-settings-card='setup'] [data-step-row]")].map(r => r.getAttribute("data-step-row")).slice(0, 4)).toEqual(["wsp", "floor", "agents", "mcp"]);
  });
});

