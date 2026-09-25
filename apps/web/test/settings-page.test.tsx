// SPDX-License-Identifier: AGPL-3.0-only
// The settings page as a window of its own: the settings sidebar in the app
// sidebar's place with the groups in order and the open one lifted, the page
// by the pick and the breadcrumb naming it, the search over every group, the
// row grammar every page keeps, the Appearance picks writing the record and
// Restore defaults standing only off the defaults, the doors that open
// Settings on a page, the memory of where it was closed, and the chords that
// do nothing behind the page.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type PlaceView, type ProjectView, type TerminalConfig, type WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { ABOUT_WORDS, GROUP_BLURBS, SETTINGS_WORDS } from "../src/settings/format.js";
import { SETTINGS_GROUPS } from "../src/settings/groups.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { useThemeEffect } from "../src/settings/theme.js";
import { runShellCommand } from "../src/shell/shellCommands.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { crumb, descriptionOf, liftedRowIds, lineLabels, mountSettings, pageAt, resetSettings, rowOf, rowTitles, settingsApi, settle, sidebarRowIds } from "./settings-harness.js";

const FILE: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], fontSize: 16, palette: Array<null>(16).fill(null) };
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const box: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, takesForks: true, engine: "docker", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 63 * 1024 ** 3, joinedAt: "2026-09-12T11:00:00.000Z", lastSeenAt: "2026-09-12T11:59:00.000Z", road: { ssh: "root@spoo" } };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const project = (id: string, name: string, computer = "here"): ProjectView => ({ id, name, computer, source: { kind: "folder", path: `/Users/dev/${name}` }, path: `/Users/dev/${name}`, remote: `https://github.com/dev/${name}.git`, defaultBranch: "main", memoryKey: `-Users-dev-${name}`, memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`, createdAt: "2026-09-12T09:14:00.000Z" });
const view = (id: string, name: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, kind: "local", project: { id: "pr_spoo", name: "spoo", path: "/Users/dev/spoo", computer: "here" }, phase: "running", golden: "", createdAt: "2026-09-01T00:00:00Z" });

const group = (name: string): HTMLElement => screen.getByRole("radiogroup", { name });
const checked = (name: string): string[] => within(group(name)).getAllByRole("radio").map(r => r.getAttribute("aria-checked") ?? "");
const segments = (name: string): string[] => within(group(name)).getAllByRole("radio").map(r => r.textContent ?? "");
const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-k=settings-search] input, input[data-k=settings-search]")!;
const restore = (): HTMLElement | null => document.querySelector("[data-k=restore-defaults]");

function ThemeRule() {
  useThemeEffect();
  return null;
}

beforeEach(() => {
  resetSettings();
  document.documentElement.classList.add("dark");
  // Base UI's radio re-dispatches a click as a PointerEvent, which jsdom does not have.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete window.wsp;
});

describe("the settings sidebar", () => {
  it("lists the seven groups in order with Appearance the one lifted row on a fresh open, and no General", async () => {
    mountSettings({ api: settingsApi().api });
    await settle();
    expect(sidebarRowIds()).toEqual(["group:appearance", "group:computers", "group:projects", "group:devices", "group:account", "group:keybindings", "group:about"]);
    expect(liftedRowIds()).toEqual(["group:appearance"]);
    expect(document.querySelector("[data-slot=sidebar]")!.textContent).not.toContain("General");
    // The field over the groups and Back at the foot with the chord that does the same.
    expect(field().getAttribute("placeholder")).toBe(SETTINGS_WORDS.search);
    expect(document.querySelector("[data-k=settings-back]")?.textContent).toBe(`${SETTINGS_WORDS.back}esc`);
  });

  it("picking a group draws its page alone and the breadcrumb reads it after an inert Settings; a computer's page names it and its group crumb returns to the list", async () => {
    useStore.setState({ places: [here, box] });
    mountSettings({ api: settingsApi().api });
    await settle();
    expect(pageAt()).toBe("appearance");
    expect(crumb()).toBe("Settings/Appearance");
    expect(document.querySelector("[data-breadcrumb-settings]")?.tagName).toBe("SPAN");
    fireEvent.click(screen.getByRole("button", { name: "Computers" }));
    expect(pageAt()).toBe("computers");
    expect(crumb()).toBe("Settings/Computers");
    expect(liftedRowIds()).toEqual(["group:computers"]);
    expect(sidebarRowIds()).toEqual(["group:appearance", "group:computers", "computer:here", "computer:p_spoo", "group:projects", "group:devices", "group:account", "group:keybindings", "group:about"]);
    fireEvent.click(document.querySelector("[data-row-id='computer:p_spoo']")!);
    expect(pageAt()).toBe("computer:p_spoo");
    expect(crumb()).toBe("Settings/Computers/spoo");
    expect(liftedRowIds()).toEqual(["computer:p_spoo"]);
    expect(rowTitles()).not.toContain(SETTINGS_WORDS.theme);
    fireEvent.click(document.querySelector("[data-breadcrumb-group]")!);
    expect(pageAt()).toBe("computers");
  });

  it("reads which groups have pages under them off the one table, so a group that gains pages is one entry there", () => {
    expect(SETTINGS_GROUPS.filter(group => group.sub !== undefined).map(group => group.id)).toEqual(["computers", "projects"]);
  });

  it("holds the room for every computer and project whichever group is open, so picking one moves no row below it", async () => {
    useStore.setState({ places: [here, box], projects: [project("pr_spoo", "spoo")] });
    mountSettings({ api: settingsApi().api });
    await settle();
    // Appearance is open and the two computers and the one project are already rows: the sub-rows are the
    // sidebar's shape, not a state of it.
    const before = ["group:appearance", "group:computers", "computer:here", "computer:p_spoo", "group:projects", "project:pr_spoo", "group:devices", "group:account", "group:keybindings", "group:about"];
    expect(sidebarRowIds()).toEqual(before);
    fireEvent.click(document.querySelector("[data-k=settings-computers]")!);
    expect(sidebarRowIds()).toEqual(before);
    fireEvent.click(document.querySelector("[data-row-id='computer:p_spoo']")!);
    expect(sidebarRowIds()).toEqual(before);
    fireEvent.click(document.querySelector("[data-k=settings-projects]")!);
    expect(sidebarRowIds()).toEqual(before);
  });

  it("ArrowDown and ArrowUp walk the sidebar's rows in visual order, from the field into the groups and their sub-rows", async () => {
    useStore.setState({ places: [here, box] });
    mountSettings({ api: settingsApi().api, at: { kind: "group", group: "computers" } });
    await settle();
    field().focus();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("group:appearance");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("group:computers");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("computer:here");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("group:about");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("group:keybindings");
  });

  it("Back closes Settings as Escape does", async () => {
    mountSettings({ api: settingsApi().api });
    await settle();
    fireEvent.click(document.querySelector("[data-k=settings-back]")!);
    expect(useStore.getState().settingsOpen).toBe(false);
  });
});

describe("search", () => {
  it("draws the matching rows under their group's name and nothing else, dims the groups with no match, says so for no match, and the field's Escape clears it without closing Settings", async () => {
    useStore.setState({ places: [here], projects: [project("pr_spoo", "spoo")] });
    mountSettings({ api: settingsApi().api });
    await settle();
    // A line matches by its hover sentence too.
    fireEvent.change(field(), { target: { value: "serves this page" } });
    expect(pageAt()).toBe("search");
    expect(crumb()).toBe("Settings/Search");
    expect(lineLabels()).toEqual([ABOUT_WORDS.host]);
    expect(rowTitles()).toEqual([]);
    expect(document.querySelector("[data-k=search-group-about]")?.textContent).toBe(ABOUT_WORDS.title);
    // A computer or a project under a dimmed group dims with it: left lit under a dimmed head it would read as
    // the one row that matched.
    const dimmed = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row][data-dimmed]")].map(row => row.dataset["rowId"]);
    expect(dimmed).toEqual(["group:appearance", "group:computers", "computer:here", "group:projects", "project:pr_spoo", "group:devices", "group:account", "group:keybindings"]);
    // Standing back is an opacity, never another ink: the sidebar's rest ink is darker than its muted ink on the
    // dark side, so an ink swap read brighter there and did nothing at all on light.
    expect(document.querySelector<HTMLElement>("[data-row-id='computer:here']")?.className).toContain("opacity-50");
    expect(document.querySelector<HTMLElement>("[data-row-id='group:computers']")?.className).not.toContain("text-sidebar-muted-foreground");
    // No row is the page while the results stand in the centre, so none is lifted.
    expect(liftedRowIds()).toEqual([]);
    fireEvent.change(field(), { target: { value: "zzz" } });
    expect(document.querySelector("[data-k=nothing-matches]")?.textContent).toBe(SETTINGS_WORDS.nothingMatches);
    // A project matches by its name, the one word on its row a person searches for.
    fireEvent.change(field(), { target: { value: "spoo" } });
    expect(rowTitles()).toEqual(["spoo"]);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("");
    expect(pageAt()).toBe("appearance");
    expect(liftedRowIds()).toEqual(["group:appearance"]);
    expect(useStore.getState().settingsOpen).toBe(true);
    // With the field empty the same key closes Settings, through the dispatcher.
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(useStore.getState().settingsOpen).toBe(false);
  });
});

describe("search over a computer", () => {
  it("finds a computer by the facts its chips say", async () => {
    useStore.setState({ places: [here], projects: [] });
    mountSettings({ api: settingsApi().api });
    await settle();
    fireEvent.change(field(), { target: { value: "210 GB free" } });
    expect(rowTitles()).toEqual(["This Mac"]);
  });
});

describe("the row grammar", () => {
  const walk = (): { rows: HTMLElement[]; lines: HTMLElement[]; cards: HTMLElement[] } => ({
    rows: [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-row]")],
    lines: [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-line]")],
    cards: [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-card]")],
  });
  const check = (where: string): void => {
    const { rows, lines, cards } = walk();
    // Appearance is the theme picker alone, drawn in place of a card's rows.
    if (where === "appearance") expect(document.querySelector("[data-settings-page] [data-k=theme-picker]"), where).not.toBeNull();
    else expect(rows.length + lines.length, where).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector("[data-settings-title]")?.textContent, `${where}: a row's title`).not.toBe("");
      expect(row.querySelector("[data-settings-description]")?.textContent, `${where}: a row's description`).not.toBe("");
      const slot = row.querySelector("[data-settings-slot]");
      if (slot !== null) {
        const words = slot.querySelectorAll("[data-settings-word]");
        const controls = slot.querySelectorAll("[data-slot=button], [data-slot=segmented-control], [data-slot=number-field], [data-slot=select-trigger], [data-slot=switch]");
        expect(words.length, `${where}: one word at most`).toBeLessThanOrEqual(1);
        expect(controls.length, `${where}: one control at most`).toBeLessThanOrEqual(1);
        expect(words.length + controls.length + (row.tagName === "BUTTON" ? 1 : 0), `${where}: a slot holds something`).toBeGreaterThan(0);
      }
    }
    for (const line of lines) {
      expect(line.querySelector("[data-settings-label]")?.textContent, `${where}: a line's label`).not.toBe("");
      expect(line.querySelector("[data-settings-description]"), `${where}: a line has no description`).toBeNull();
      expect(line.querySelectorAll("[data-settings-word], [data-settings-keys]").length, `${where}: a line's one word or its keycaps`).toBe(1);
    }
    for (const card of cards) {
      const kinds = new Set([...card.querySelectorAll("[data-settings-row], [data-settings-line]")].map(el => (el.hasAttribute("data-settings-row") ? "row" : "line")));
      expect(kinds.size, `${where}: a card holds rows or lines, never both`).toBeLessThanOrEqual(1);
    }
    for (const held of document.querySelectorAll("[data-settings-page] button[disabled]")) expect(held.hasAttribute("title"), `${where}: no disabled control carries a title`).toBe(false);
  };

  it("holds on every group page, a computer's page and a project's page", async () => {
    const devices = [{ id: "d_1", name: "zingzy-laptop", createdAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-12T09:00:00Z" }];
    const api = settingsApi({
      account: async () => ({ signedIn: false }),
      devicesList: async () => devices,
      image: async () => ({ image: null, copies: [], projects: [] }),
      initGet: async () => ({ keys: { solari: true }, home: "/Users/dev", agents: [{ id: "claude", name: "Claude Code", configured: false, takesTools: true }], pricing: null, job: null }),
      hostTerminalConfig: async () => FILE,
    } as Partial<Api>).api;
    const spooProject = project("pr_spoo", "spoo");
    useStore.setState({ places: [here, { ...box, agents: ["claude", "codex"], signIns: { claude: "vault-key", codex: "none" }, agentVersions: { claude: "2.1.270 (Claude Code)" } }, solari], projects: [spooProject, project("pr_landing", "landing", "p_spoo")], workspaces: [view("ws_a", "pricing page")] });
    window.wsp = { version: "0.2.0" };
    mountSettings({ api });
    await settle();
    for (const groupId of ["appearance", "computers", "projects", "devices", "account", "keybindings", "about"]) {
      fireEvent.click(document.querySelector(`[data-k=settings-${groupId}]`)!);
      await settle();
      expect(pageAt()).toBe(groupId);
      check(groupId);
    }
    for (const id of ["computer:here", "computer:p_spoo", "computer:solari"]) {
      fireEvent.click(document.querySelector("[data-k=settings-computers]")!);
      fireEvent.click(document.querySelector(`[data-row-id='${id}']`)!);
      await settle();
      check(id);
    }
    fireEvent.click(document.querySelector("[data-k=settings-projects]")!);
    fireEvent.click(document.querySelector("[data-row-id='project:pr_spoo']")!);
    await settle();
    check("project:pr_spoo");
    // Nothing on the page or in the settings sidebar wears caps: the groups are rows and the sections sub-heads.
    for (const el of document.querySelectorAll("[data-settings-page] *, [data-slot=sidebar] *")) expect(el.getAttribute("class") ?? "").not.toMatch(/uppercase|tracking-/);
  });
});

describe("Appearance", () => {
  it("the theme segments read the record and write it, the html element follows and the shell hears the pick", async () => {
    const setTheme = vi.fn();
    window.wsp = { setTheme };
    const { api, sets } = settingsApi();
    mountSettings({ api, children: <ThemeRule /> });
    await settle();
    expect(segments(SETTINGS_WORDS.theme)).toEqual(["System", "Light", "Dark"]);
    expect(checked(SETTINGS_WORDS.theme)).toEqual(["true", "false", "false"]);
    fireEvent.click(within(group(SETTINGS_WORDS.theme)).getByRole("radio", { name: "Light" }));
    expect(useStore.getState().preferences.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(setTheme).toHaveBeenLastCalledWith("light");
    fireEvent.click(within(group(SETTINGS_WORDS.theme)).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    await settle();
    expect(sets).toEqual([{ theme: "light" }, { theme: "dark" }]);
  });

  it("is the page's head over the theme picker alone, with no line under the pictures", async () => {
    const { api } = settingsApi();
    mountSettings({ api });
    await settle();
    const head = document.querySelector<HTMLElement>("[data-settings-page] [data-k=settings-page-head]")!;
    expect(head.querySelector("h1")!.textContent).toBe(SETTINGS_WORDS.appearance);
    expect(head.querySelector("p")!.textContent).toBe(GROUP_BLURBS.appearance);
    expect(document.querySelectorAll("[data-settings-page] [data-settings-row], [data-settings-page] [data-settings-line]")).toHaveLength(0);
    expect(document.querySelector("[data-k=sidebar-width]")).toBeNull();
    expect(document.querySelector("[data-k=terminal-size-row]")).toBeNull();
    expect(within(group(SETTINGS_WORDS.theme)).queryByText(/whatever this Mac/)).toBeNull();
  });

  it("Restore defaults is absent on the defaults, stands once any pick is off them, writes the one patch, and is absent on every other group", async () => {
    const { api, sets } = settingsApi();
    mountSettings({ api });
    await settle();
    expect(restore()).toBeNull();
    fireEvent.click(within(group(SETTINGS_WORDS.theme)).getByRole("radio", { name: "Light" }));
    await waitFor(() => expect(restore()).not.toBeNull());
    fireEvent.click(document.querySelector("[data-k=settings-about]")!);
    expect(restore()).toBeNull();
    fireEvent.click(document.querySelector("[data-k=settings-appearance]")!);
    fireEvent.click(restore()!);
    await waitFor(() => expect(restore()).toBeNull());
    expect(useStore.getState().preferences.theme).toBe("system");
    await settle();
    expect(sets.at(-1)).toEqual({ theme: "system" });
  });
});

describe("the doors and the memory", () => {
  it("Add a computer opens Settings on Computers with the sheet over it whatever was remembered, and the image's Open lands on the cloud's page with its sheet", async () => {
    useStore.setState({ places: [here, solari] });
    const api = settingsApi({ initGet: async () => ({ keys: { solari: true }, home: "/Users/dev", agents: [], pricing: null, job: null }), image: async () => ({ image: null, copies: [], projects: [] }) } as Partial<Api>).api;
    useSettingsStore.getState().go({ kind: "group", group: "about" });
    useStore.setState({ api });
    useStore.getState().openAddComputer();
    expect(useStore.getState().settingsOpen).toBe(true);
    mountSettings();
    await settle();
    expect(pageAt()).toBe("computers");
    expect(document.querySelector("[data-k=add-computer]")).not.toBeNull();
    // The door moved the page rather than standing over it: the computer it added is on the list the person is left
    // on, not behind whatever page they were last reading.
    act(() => useStore.getState().closeAddComputer());
    await settle();
    expect(pageAt()).toBe("computers");
    expect(window.localStorage.getItem("wsp:settings-at")).toBe("computers");
    act(() => useStore.getState().openSetup());
    await settle();
    expect(pageAt()).toBe("computer:solari");
    expect(crumb()).toBe("Settings/Computers/Solari");
    expect(document.querySelector("[data-cloud-setup-dialog]")).not.toBeNull();
    act(() => useStore.getState().closeSetup());
    await settle();
    expect(pageAt()).toBe("computers");
  });

  it("reopens where it was closed in this window, and a remembered computer or project that is gone falls back to its group", async () => {
    useStore.setState({ places: [here, box], projects: [project("pr_spoo", "spoo")] });
    const view1 = mountSettings({ api: settingsApi().api });
    await settle();
    fireEvent.click(document.querySelector("[data-k=settings-devices]")!);
    expect(pageAt()).toBe("devices");
    act(() => useStore.getState().closeSettings());
    view1.unmount();
    expect(window.localStorage.getItem("wsp:settings-at")).toBe("devices");
    mountSettings();
    await settle();
    expect(pageAt()).toBe("devices");
    fireEvent.click(document.querySelector("[data-k=settings-computers]")!);
    fireEvent.click(document.querySelector("[data-row-id='computer:p_spoo']")!);
    expect(pageAt()).toBe("computer:p_spoo");
    act(() => useStore.setState({ places: [here] }));
    await settle();
    expect(pageAt()).toBe("computers");
    fireEvent.click(document.querySelector("[data-k=settings-projects]")!);
    fireEvent.click(document.querySelector("[data-row-id='project:pr_spoo']")!);
    expect(pageAt()).toBe("project:pr_spoo");
    act(() => useStore.setState({ projects: [] }));
    await settle();
    expect(pageAt()).toBe("projects");
  });
});

describe("the chords behind the page", () => {
  it("leave the drawer store and the right panel's record as they were while Settings is open, and no layout control stands in the header", async () => {
    useStore.setState({ workspaces: [view("ws_a", "api")], selectedId: "ws_a" });
    useRightPanelStore.setState({ byWorkspaceId: { ws_a: { isOpen: true, activeSurfaceId: "browser:new", surfaces: [{ id: "browser:new", kind: "preview", resourceId: null }] } } });
    mountSettings({ api: settingsApi().api });
    await settle();
    const panelBefore = useRightPanelStore.getState().byWorkspaceId["ws_a"];
    const drawerBefore = useTerminalDrawerStore.getState().byWorkspaceId["ws_a"];
    const target = { workspaceId: "ws_a", toggleSidebar: () => {} };
    runShellCommand("rightPanel.toggle", target, []);
    runShellCommand("preview.toggle", target, []);
    runShellCommand("terminal.toggle", target, []);
    expect(useRightPanelStore.getState().byWorkspaceId["ws_a"]).toEqual(panelBefore);
    expect(useTerminalDrawerStore.getState().byWorkspaceId["ws_a"]).toEqual(drawerBefore);
    expect(document.querySelector("[data-panel-layout-controls]")).toBeNull();
    expect(document.querySelector("[data-right-panel-tabbar]")).toBeNull();
    act(() => useStore.getState().closeSettings());
    await settle();
    expect(useRightPanelStore.getState().byWorkspaceId["ws_a"]).toEqual(panelBefore);
    expect(document.querySelector("[data-panel-layout-controls]")).not.toBeNull();
    runShellCommand("terminal.toggle", target, []);
    expect(useTerminalDrawerStore.getState().byWorkspaceId["ws_a"]).not.toEqual(drawerBefore);
  });
});

/** The api type, for the partials the cases hand the harness. */
type Api = import("../src/protocol/client.js").Api;
