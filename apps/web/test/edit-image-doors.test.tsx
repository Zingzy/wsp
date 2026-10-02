// SPDX-License-Identifier: AGPL-3.0-only
// Every Edit image outside a computer's page lands on that computer's page:
// the task panel's on a fork. The page draws the image as one row and never
// the recipe's long list, so the door opens the page and the ask is dropped.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type InitJob, type InitSetup, type PlaceView, type WorkspaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { AgentsSurface } from "../src/components/agents/AgentsSurface.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { openImageRecipe } from "../src/settings/openAt.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { mountSettings, pageAt, resetSettings, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true, buildsImages: true };
const SETUP: InitSetup = { keys: { solari: true }, home: "/Users/dev", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
const FORK: WorkspaceView = { id: "ws_f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, name: "ws_f", kind: "cloud", machineId: "fk_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", provider: "solari" };

const api = (): Api => settingsApi({ initGet: async () => ({ ...SETUP, job: useStore.getState().initJob }), image: async () => ({ image: null, copies: [], projects: [] }), initStart: async () => ({}) as InitJob } as Partial<Api>).api;

beforeEach(() => {
  resetSettings();
  useSettingsStore.setState({ recipeAsked: null });
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here, box, solari], initJob: null, goldenFrames: {}, workspaces: [FORK] });
});
afterEach(() => cleanup());

describe("an Edit image outside the Image card", () => {
  it("on a fork's task panel opens Settings on the cloud the fork stands at, with its recipe asked for", async () => {
    useStore.setState({ api: settingsApi({ agentsRead: async () => AGENTS_REPORT } as Partial<Api>).api });
    render(
      <TooltipProvider>
        <AgentsSurface workspaceId="ws_f" />
      </TooltipProvider>,
    );
    await settle();
    // A fork's one act on every item's page is Edit image, since what it holds is the image's.
    fireEvent.click(document.querySelector<HTMLElement>('[data-agent-row="claude"] [data-settings-title]')!);
    const edit = [...document.querySelectorAll<HTMLButtonElement>("[data-k=kind-head] [data-k^=act-]")];
    expect(edit.map(b => b.textContent)).toEqual([AGENTS_LIST_WORDS.editImage]);
    fireEvent.click(edit[0]!);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "solari" });
    expect(useSettingsStore.getState().recipeAsked).toBe("solari");
  });

  it("on a fork whose cloud this host holds no key for is held, its reason on the hover and never the Add word", async () => {
    useStore.setState({ places: [here, box], api: settingsApi({ agentsRead: async () => AGENTS_REPORT } as Partial<Api>).api });
    render(
      <TooltipProvider>
        <AgentsSurface workspaceId="ws_f" />
      </TooltipProvider>,
    );
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: /^Skills/ }));
    const edit = document.querySelector<HTMLButtonElement>("[data-k=kind-add]")!;
    expect(edit.textContent).toBe(AGENTS_LIST_WORDS.editImage);
    expect(edit.closest("[title]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.editImageHeld);
    fireEvent.click(edit);
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("lands on that computer's page, which draws your image as one row and no recipe, and drops the ask", async () => {
    openImageRecipe("p_2");
    mountSettings({ api: api() });
    await settle();
    expect(pageAt()).toBe("computer:p_2");
    expect(document.querySelector("[data-settings-page] [data-k='image-state']")).not.toBeNull();
    expect(document.querySelector("[data-settings-page] [data-k='recipe']")).toBeNull();
    expect(useSettingsStore.getState().recipeAsked).toBeNull();
  });
});
