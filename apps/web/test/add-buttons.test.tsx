// SPDX-License-Identifier: AGPL-3.0-only
// Every button that says Add on a settings page or in the agents panel is the
// one shared Add button: each group's page, a computer's page and a project's
// page, the Add a computer panel on every road, and the agents in a task's
// panel on every tab, on every item's page and at its add.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitSetup, PlaceView, ProjectView, WorkspaceView } from "@wsp/protocol";
import { AgentsSurface } from "../src/components/agents/AgentsSurface.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { useStore } from "../src/protocol/store.js";
import { FirstRun } from "../src/shell/FirstRun.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { drawnGroups } from "../src/settings/groups.js";
import { useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const box: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, takesForks: true, engine: "docker", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 63 * 1024 ** 3, joinedAt: "2026-09-12T11:00:00.000Z", lastSeenAt: "2026-09-12T11:59:00.000Z" };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const project: ProjectView = { id: "pr_spoo", name: "spoo", computer: "here", source: { kind: "folder", path: "/Users/dev/spoo" }, path: "/Users/dev/spoo", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-Users-dev-spoo", memoryDir: "/Users/dev/.claude-cfg/projects/-Users-dev-spoo/memory", createdAt: "2026-09-12T09:14:00.000Z" };
const MINE: WorkspaceView = { id: "ws_here", project: { id: "pr_spoo", name: "spoo", path: "/Users/dev/spoo", computer: "here" }, name: "spoo", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: "2026-09-12T09:14:00.000Z" };
const setup = { keys: { box: false, solari: true }, home: "/Users/dev", agents: [], pricing: null, job: null } as unknown as InitSetup;

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
const addsOn = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>("[data-settings-page] button, [data-agents-panel] button, [data-slot=dialog-popup] button")].filter(b => wordOf(b).startsWith("Add"));
/** Rows that carry their plus and stay rows: the Add a project sheet's side list ends in Add a computer. */
const SIDE_ROWS = ["[data-slot=dialog-popup] aside [data-k=add-computer]"];
/** The Add buttons standing now that are drawn some other way, by word. */
const strays = (): string[] => addsOn().filter(b => !b.hasAttribute("data-add-button") && !SIDE_ROWS.some(row => b.matches(row))).map(wordOf);
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
  cleanup();
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
    await go({ kind: "group", group: "projects" });
    act(() => useSettingsStore.getState().openAddProject());
    await settle();
    expect(document.querySelector("[data-slot=dialog-popup]")).not.toBeNull();
    expect({ at: "add-project", strays: strays() }).toEqual({ at: "add-project", strays: [] });
    for (const b of addsOn()) seen.add(wordOf(b));
    expect([...seen]).toEqual(expect.arrayContaining([ADD_COMPUTER_WORDS.title, ADD_COMPUTER_WORDS.addCloud, "Add a project", "Add"]));
  });

  it("is every Add in the Add a cloud panel", async () => {
    mountSettings({ api: api(), at: { kind: "group", group: "computers" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.addCloud }));
    await settle();
    expect(document.querySelector("[data-k='road-cloud']")).not.toBeNull();
    expect({ road: "cloud", strays: strays() }).toEqual({ road: "cloud", strays: [] });
  });
});

/** The keycap's classes that set its size: the 32 px default and nothing of the xs or of a hand-set height. */
const keycap = (b: Element | null): void => {
  const cls = (b?.className ?? "").split(" ");
  expect(cls).toEqual(expect.arrayContaining(["h-8", "px-3", "gap-1.5", "text-[13px]"]));
  expect(cls.filter(c => /^(sm:)?h-(6|7|9|10)$|^(sm:)?text-xs$/.test(c))).toEqual([]);
};

/** The agents panel where it stands now, in a task's panel on this computer. */
const mountPanel = async (): Promise<void> => {
  useStore.setState({ api: api(), places: [here], workspaces: [MINE] });
  render(
    <TooltipProvider>
      <AgentsSurface workspaceId={MINE.id} />
    </TooltipProvider>,
  );
  await settle();
};

describe("the one size of the shared Add button", () => {
  it("is the 32 px keycap on the key road and the first run", async () => {
    mountSettings({ api: api(), at: { kind: "group", group: "computers" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.addCloud }));
    await settle();
    const keyAdds = document.querySelectorAll("[data-k='cloud-save'][data-add-button]");
    expect(keyAdds.length).toBeGreaterThan(0);
    keyAdds.forEach(keycap);
    cleanup();
    render(<FirstRun />);
    keycap(document.querySelector("[data-k=add-project]"));
    expect(document.querySelector("[data-k=add-project]")?.hasAttribute("data-add-button")).toBe(true);
  });
});

describe("the shared Add button in the agents panel", () => {
  it("is every Add on each tab, on every item's page, at the add and in the Add a tool server form", async () => {
    await mountPanel();
    const tabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-agents-panel] [data-slot=segmented-control] [role=radio]")];
    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-agents-panel] [data-settings-card]:not([data-settings-card=not-read]) [data-settings-row] [data-settings-title]")];
    const back = async (): Promise<void> => {
      fireEvent.click(document.querySelector<HTMLButtonElement>("[data-agents-panel] [data-k=agents-back]")!);
      await settle();
    };
    const names = tabs().map(t => t.textContent ?? "");
    expect(names.length).toBe(3);
    const seen = new Set<string>();
    for (const [at, name] of names.entries()) {
      fireEvent.click(tabs()[at]!);
      await settle();
      expect({ name, strays: strays() }).toEqual({ name, strays: [] });
      addsOn().forEach(b => seen.add(wordOf(b)));
      const count = rows().length;
      for (let row = 0; row < count; row++) {
        fireEvent.click(rows()[row]!);
        await settle();
        expect({ name, row, strays: strays() }).toEqual({ name, row, strays: [] });
        addsOn().forEach(b => seen.add(wordOf(b)));
        await back();
      }
      const add = document.querySelector<HTMLButtonElement>("[data-agents-panel] [data-k=kind-add]");
      if (add === null || add.disabled) continue;
      fireEvent.click(add);
      await settle();
      document.querySelectorAll<HTMLButtonElement>("[data-k=add-server-pair-add]").forEach(b => fireEvent.click(b));
      expect({ name, level: "add", strays: strays() }).toEqual({ name, level: "add", strays: [] });
      addsOn().forEach(b => seen.add(wordOf(b)));
      await back();
    }
    expect([...seen]).toEqual(expect.arrayContaining(["Add the wsp tools", "Add skill", "Add a tool server", "Add server"]));
  });
});
