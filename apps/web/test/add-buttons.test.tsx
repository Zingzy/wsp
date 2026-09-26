// SPDX-License-Identifier: AGPL-3.0-only
// Every button that says Add on a settings page or in the agents manager is
// the one shared Add button: each group's page, a computer's page and a
// project's page, the Add a computer panel on every road, and the manager on
// every tab and at its add level.
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitSetup, PlaceView, ProjectView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { drawnGroups } from "../src/settings/groups.js";
import { useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const box: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, takesForks: true, engine: "docker", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 63 * 1024 ** 3, joinedAt: "2026-09-12T11:00:00.000Z", lastSeenAt: "2026-09-12T11:59:00.000Z" };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const project: ProjectView = { id: "pr_spoo", name: "spoo", computer: "here", source: { kind: "folder", path: "/Users/dev/spoo" }, path: "/Users/dev/spoo", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-Users-dev-spoo", memoryDir: "/Users/dev/.claude-cfg/projects/-Users-dev-spoo/memory", createdAt: "2026-09-12T09:14:00.000Z" };
const setup = { keys: { solari: true }, home: "/Users/dev", agents: [], pricing: null, job: null } as unknown as InitSetup;

const api = () =>
  settingsApi({
    initGet: async () => setup,
    agentsRead: async () => AGENTS_REPORT,
    agentsAddTools: async () => ({ file: "~/.claude.json" }),
    serversAdd: async () => ({}),
    skillsSearch: async () => [],
    skillsAdd: async () => ({}),
  } as never).api;

/** A button's word as a person hears it: its name where the word is hidden, else its text. */
const wordOf = (b: HTMLButtonElement): string => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
const addsOn = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>("[data-settings-page] button, [data-slot=dialog-popup] button")].filter(b => wordOf(b).startsWith("Add"));
/** The Add buttons standing now that are drawn some other way, by word. */
const strays = (): string[] => addsOn().filter(b => !b.hasAttribute("data-add-button")).map(wordOf);
const go = async (at: SettingsAt): Promise<void> => {
  act(() => useSettingsStore.getState().go(at));
  await settle();
};

beforeEach(() => {
  resetSettings();
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
  useStore.setState({ places: [here, box, solari], projects: [project] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the shared Add button on the settings pages", () => {
  it("is every Add on each group's page, a computer's page and a project's page", async () => {
    mountSettings({ api: api() });
    await settle();
    const seen = new Set<string>();
    const pages: SettingsAt[] = [...drawnGroups().map(g => ({ kind: "group", group: g.id }) as SettingsAt), { kind: "computer", id: "here" }, { kind: "computer", id: "p_spoo" }, { kind: "computer", id: "solari" }, { kind: "project", id: project.id }];
    for (const at of pages) {
      await go(at);
      expect({ at, strays: strays() }).toEqual({ at, strays: [] });
      for (const b of addsOn()) seen.add(wordOf(b));
    }
    expect([...seen]).toEqual(expect.arrayContaining([ADD_COMPUTER_WORDS.title, ADD_COMPUTER_WORDS.addCloud, "Add a project"]));
  });

  it("is every Add in the Add a computer panel, on each road", async () => {
    mountSettings({ api: api(), at: { kind: "group", group: "computers" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.title }));
    await settle();
    for (const road of ["ssh", "cloud", "code"]) {
      fireEvent.click(document.querySelector(`[data-add-road='${road}']`)!);
      await settle();
      expect({ road, strays: strays() }).toEqual({ road, strays: [] });
    }
  });
});

describe("the shared Add button in the agents manager", () => {
  it("is every Add on each tab, at the add level and in the Add an MCP server form", async () => {
    mountSettings({ api: api(), at: { kind: "computer", id: "here" } });
    await settle();
    const tabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-slot=segmented-control] [role=radio]")];
    const names = tabs().map(t => t.textContent ?? "");
    expect(names.length).toBe(3);
    const seen = new Set<string>();
    for (const [at, name] of names.entries()) {
      fireEvent.click(tabs()[at]!);
      await settle();
      expect({ name, strays: strays() }).toEqual({ name, strays: [] });
      addsOn().forEach(b => seen.add(wordOf(b)));
      const rows = document.querySelectorAll("[data-agents-row]").length;
      for (let row = 0; row < rows; row++) {
        fireEvent.click(document.querySelectorAll<HTMLButtonElement>("[data-agents-row] [data-row-trigger]")[row]!);
        await settle();
        expect({ name, row, strays: strays() }).toEqual({ name, row, strays: [] });
        addsOn().forEach(b => seen.add(wordOf(b)));
        fireEvent.click(document.querySelector<HTMLButtonElement>("[data-level-head] button")!);
        await settle();
      }
      const add = document.querySelector<HTMLButtonElement>("[data-k=agents-add]");
      if (add === null || add.disabled) continue;
      fireEvent.click(add);
      await settle();
      document.querySelectorAll<HTMLButtonElement>("[data-k=add-server-pair-add]").forEach(b => fireEvent.click(b));
      expect({ name, level: "add", strays: strays() }).toEqual({ name, level: "add", strays: [] });
      addsOn().forEach(b => seen.add(wordOf(b)));
      fireEvent.click(document.querySelector<HTMLButtonElement>("[data-level-head] button")!);
      await settle();
    }
    expect([...seen]).toEqual(expect.arrayContaining(["Add the wsp tools", "Add skill", "Add MCP server", "Add server"]));
  });
});
