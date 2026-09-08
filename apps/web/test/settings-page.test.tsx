// SPDX-License-Identifier: AGPL-3.0-only
// The settings page: its two sections and their rows, each control reading the
// host's record and writing a patch to it, the facts beside the terminal size
// rows from the app's token and the host's Ghostty file, the sidebar width
// reset, and the page in the shell's centre with its name in the breadcrumb
// until a workspace is picked.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch, type TerminalConfig, type WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";
import { appTerminalFontSize } from "../src/terminal/ghostty/surface.js";

const FILE: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], fontSize: 16, palette: Array<null>(16).fill(null) };
const view = (id: string, name: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" });
const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, kept: false, sizes: [] };
const GOLDEN = { head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } }] };

function fakeApi(record: Preferences, file: TerminalConfig | null = FILE) {
  const sets: PreferencesPatch[] = [];
  let held = record;
  const api: Api = {
    listWorkspaces: async () => [view("ws_a", "api")],
    getWorkspace: async () => view("ws_a", "api"),
    createWorkspace: async () => view("ws_a", "api"),
    createFromGoldenHead: async () => view("ws_a", "api"),
    watchStatuses: async () => [],
    nap: async () => view("ws_a", "api"),
    wake: async () => view("ws_a", "api"),
    upgrade: async () => view("ws_a", "api"),
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: 0 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    getGolden: async () => GOLDEN,
    subscribe: () => () => {},
    preferences: async () => held,
    setPreferences: async patch => {
      sets.push(patch);
      held = { ...held, ...(patch as Partial<Preferences>) };
      return held;
    },
    ...(file === null ? {} : { hostTerminalConfig: async () => file }),
  };
  return { api, sets };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const checked = (group: HTMLElement): string[] => within(group).getAllByRole("radio").map(r => r.getAttribute("aria-checked") ?? "");
const group = (name: string): HTMLElement => screen.getByRole("radiogroup", { name });

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.add("dark");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the settings page", () => {
  it("has Appearance and Terminal, a label over each pick, and the record's values checked", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true, theme: "light", sidebarMode: "spaces", sidebarWidth: 312, terminalSize: "file", terminalZoom: {} });
    useStore.getState().bind(api);
    await flush();
    render(<SettingsPage />);
    const sections = screen.getAllByRole("region").map(s => s.getAttribute("aria-labelledby"));
    expect(sections).toEqual(["settings-appearance", "settings-terminal"]);
    expect(screen.getByText("Appearance").tagName).toBe("H2");
    expect(screen.getByText("Terminal").tagName).toBe("H2");
    expect(within(group("Theme")).getAllByRole("radio").map(r => r.closest("label")!.textContent)).toEqual(["SystemFollows this computer", "Light", "Dark"]);
    expect(checked(group("Theme"))).toEqual(["false", "true", "false"]);
    expect(within(group("Sidebar")).getAllByRole("radio").map(r => r.closest("label")!.textContent)).toEqual(["ListEvery workspace and its threads", "SpacesOne workspace at a time, with a dot per workspace at the bottom"]);
    expect(checked(group("Sidebar"))).toEqual(["false", "true"]);
    expect(screen.getByText("Sidebar width")).toBeTruthy();
    expect(document.querySelector("[data-k=sidebar-width]")!.textContent).toBe("312 px");
    expect(checked(group("Text size"))).toEqual(["false", "true"]);
    // Every choice row is one height, and the facts and the width read in the mono voice.
    const rows = Array.from(document.querySelectorAll("[data-settings-row]"));
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.className).toContain("min-h-9");
    // A detail sentence is whole, never cut: nothing truncates it.
    expect(rows.some(row => row.querySelector(".truncate") !== null)).toBe(false);
    expect(document.querySelector("[data-k=sidebar-width]")!.className).toContain("font-mono");
  });

  it("the terminal size rows say the app's size and the file's, and a file naming no size says so beside the app's", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    render(<SettingsPage />);
    const labels = () => within(group("Text size")).getAllByRole("radio").map(r => r.closest("label")!.textContent);
    await waitFor(() => expect(labels()).toEqual([`From the app${appTerminalFontSize()} px`, "From the Ghostty file16 px"]));
    document.body.innerHTML = "";
    const bare = fakeApi({ ...DEFAULT_PREFERENCES, labs: true }, { ...FILE, fontSize: undefined });
    useStore.getState().bind(bare.api);
    await flush();
    render(<SettingsPage />);
    await waitFor(() => expect(labels()).toEqual([`From the app${appTerminalFontSize()} px`, `From the Ghostty file${appTerminalFontSize()} px, the file names no size`]));
  });

  it("each pick paints at once and goes to the host as one patch; the width reset is offered only off the default", async () => {
    // Base UI's radio re-dispatches a click as a PointerEvent, which jsdom does not have.
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const { api, sets } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true, sidebarWidth: 300 });
    useStore.getState().bind(api);
    await flush();
    render(<SettingsPage />);
    fireEvent.click(within(group("Theme")).getByRole("radio", { name: "Light" }));
    expect(useStore.getState().preferences.theme).toBe("light");
    fireEvent.click(within(group("Sidebar")).getByRole("radio", { name: /Spaces/ }));
    expect(useStore.getState().preferences.sidebarMode).toBe("spaces");
    fireEvent.click(within(group("Text size")).getByRole("radio", { name: /Ghostty file/ }));
    expect(useStore.getState().preferences.terminalSize).toBe("file");
    const reset = screen.getByRole("button", { name: "Reset" });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reset);
    expect(useStore.getState().preferences.sidebarWidth).toBeUndefined();
    expect(document.querySelector("[data-k=sidebar-width]")!.textContent).toBe("default");
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
    await flush();
    expect(sets).toEqual([{ theme: "light" }, { sidebarMode: "spaces" }, { terminalSize: "file" }, { sidebarWidth: null }]);
  });

  it("in the shell's centre, the page takes the thread's place and the breadcrumb its name until a workspace is picked", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    render(<Shell />);
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
    await waitFor(() => expect(document.querySelector("[data-chat-composer], [data-terminal-beside]")).not.toBeNull());
    useStore.getState().openSettings();
    await waitFor(() => expect(document.querySelector("[data-settings-page]")).not.toBeNull());
    expect(document.querySelector("[data-terminal-beside]")).toBeNull();
    expect(document.querySelector("[data-thread-breadcrumb]")!.textContent).toBe("Settings");
    useStore.getState().select("ws_a");
    await waitFor(() => expect(document.querySelector("[data-settings-page]")).toBeNull());
    expect(document.querySelector("[data-thread-breadcrumb]")!.textContent).toContain("api");
  });
});
