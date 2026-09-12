// SPDX-License-Identifier: AGPL-3.0-only
// The settings page: its three sections and their rows, each control reading
// the host's record and writing a patch to it, the theme, the sidebar body and
// the terminal text size as segmented controls, the sidebar width as a mono
// number field with a stepper and a reset offered only off the default, the
// resolved size in mono beside the text size pick, the release each half is on
// the about row, no sentence under any pick, the Image section's own sentence
// while nothing is sealed, and the page in the shell's centre with its name in
// the breadcrumb until a workspace is picked.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, applyPreferencesPatch, type BootPayload, type Preferences, type PreferencesPatch, type TerminalConfig, type WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { IMAGE_WORDS } from "../src/settings/image.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";
import { SIDEBAR_DEFAULT_WIDTH } from "../src/shell/sidebarWidth.js";
import { appTerminalFontSize } from "../src/terminal/ghostty/surface.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const FILE: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], fontSize: 16, palette: Array<null>(16).fill(null) };
const view = (id: string, name: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" });
const CAPS = caps();
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
    daemon: noDaemonApi,
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
      held = applyPreferencesPatch(held, patch);
      return held;
    },
    ...(file === null ? {} : { hostTerminalConfig: async () => file }),
  };
  return { api, sets };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const group = (name: string): HTMLElement => screen.getByRole("radiogroup", { name });
const checked = (name: string): string[] => within(group(name)).getAllByRole("radio").map(r => r.getAttribute("aria-checked") ?? "");
const segments = (name: string): string[] => within(group(name)).getAllByRole("radio").map(r => r.textContent ?? "");
const widthField = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-k=sidebar-width]")!;
/** The boot object a host wrote into this page, as the page reads it. */
const served = (boot: BootPayload | undefined): void => {
  const holder = window as unknown as { __WSP__?: BootPayload };
  if (boot === undefined) delete holder.__WSP__;
  else holder.__WSP__ = boot;
};

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.add("dark");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete window.wsp;
  served(undefined);
});

describe("the settings page", () => {
  it("has Appearance, Terminal and About, one hairline row per pick with its label left and its control right, segments for the picks, and the record's values checked", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true, theme: "light", sidebarMode: "spaces", sidebarWidth: 312, terminalSize: "file", terminalZoom: {} });
    useStore.getState().bind(api);
    await flush();
    render(<SettingsPage />);
    expect(screen.getAllByRole("region").map(s => s.getAttribute("aria-labelledby"))).toEqual(["settings-appearance", "settings-terminal", "settings-image", "settings-where", "settings-about"]);
    expect(screen.getByText("Appearance").tagName).toBe("H2");
    expect(screen.getByText("Terminal").tagName).toBe("H2");
    expect(screen.getByText("About").tagName).toBe("H2");
    expect(segments("Theme")).toEqual(["System", "Light", "Dark"]);
    expect(checked("Theme")).toEqual(["false", "true", "false"]);
    expect(segments("Sidebar")).toEqual(["List", "Spaces"]);
    expect(checked("Sidebar")).toEqual(["false", "true"]);
    expect(segments("Text size")).toEqual(["From the app", "From the Ghostty file"]);
    expect(checked("Text size")).toEqual(["false", "true"]);
    expect(widthField().value).toBe("312");
    expect(widthField().className).toContain("font-mono");
    // One hairline under every row, the label at the left and nothing else in the label's slot: no radio, no chip.
    // A section may put one sentence of its own in a row of the same shape, which the Image section does while
    // nothing is sealed; a pick still never carries one.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-row]"));
    expect(rows.map(row => row.firstElementChild?.textContent)).toEqual(["Theme", "Sidebar", "Sidebar width", "Text size", "Image", IMAGE_WORDS.firstBuild, "Version"]);
    for (const row of rows) {
      expect(row.className).toContain("border-b");
      expect(row.querySelector("[data-slot=badge], .truncate + span span")).toBeNull();
    }
    expect(document.querySelectorAll("[data-settings-page] [data-slot=radio]")).toHaveLength(0);
    expect(screen.queryByText("Follows this computer")).toBeNull();
    expect(screen.queryByText(/One workspace at a time/)).toBeNull();
  });

  it("the resolved size sits in mono beside the text size pick: the app's own, the file's, and the app's again for a file naming none", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    render(<SettingsPage />);
    const fact = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=terminal-size]")!;
    expect(fact().textContent).toBe(`${appTerminalFontSize()} px`);
    expect(fact().className).toContain("font-mono");
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    fireEvent.click(within(group("Text size")).getByRole("radio", { name: "From the Ghostty file" }));
    await waitFor(() => expect(fact().textContent).toBe("16 px"));
    document.body.innerHTML = "";
    const bare = fakeApi({ ...DEFAULT_PREFERENCES, labs: true, terminalSize: "file" }, { ...FILE, fontSize: undefined });
    useStore.getState().bind(bare.api);
    await flush();
    render(<SettingsPage />);
    await waitFor(() => expect(fact().textContent).toBe(`${appTerminalFontSize()} px`));
  });

  it("each pick paints at once and goes to the host as one patch; the width steps and types, and its reset shows only off the default", async () => {
    // Base UI's radio re-dispatches a click as a PointerEvent, which jsdom does not have.
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const { api, sets } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    render(<SettingsPage />);
    expect(widthField().value).toBe(String(SIDEBAR_DEFAULT_WIDTH));
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    fireEvent.click(within(group("Theme")).getByRole("radio", { name: "Light" }));
    expect(useStore.getState().preferences.theme).toBe("light");
    fireEvent.click(within(group("Sidebar")).getByRole("radio", { name: "Spaces" }));
    expect(useStore.getState().preferences.sidebarMode).toBe("spaces");
    fireEvent.click(within(group("Text size")).getByRole("radio", { name: "From the Ghostty file" }));
    expect(useStore.getState().preferences.terminalSize).toBe("file");
    fireEvent.click(screen.getByRole("button", { name: "Wider" }));
    await waitFor(() => expect(useStore.getState().preferences.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 8));
    expect(screen.getByRole("button", { name: "Reset" })).toBeDefined();
    fireEvent.change(widthField(), { target: { value: "300" } });
    fireEvent.blur(widthField());
    await waitFor(() => expect(useStore.getState().preferences.sidebarWidth).toBe(300));
    // A typed width outside the drag's bounds is held to them before the host hears it, not only on blur.
    fireEvent.change(widthField(), { target: { value: "1000" } });
    await waitFor(() => expect(useStore.getState().preferences.sidebarWidth).toBe(480));
    fireEvent.blur(widthField());
    fireEvent.change(widthField(), { target: { value: "10" } });
    await waitFor(() => expect(useStore.getState().preferences.sidebarWidth).toBe(220));
    fireEvent.blur(widthField());
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(useStore.getState().preferences.sidebarWidth).toBeUndefined());
    expect(widthField().value).toBe(String(SIDEBAR_DEFAULT_WIDTH));
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    await flush();
    expect(sets.filter(patch => "sidebarWidth" in patch).map(patch => patch.sidebarWidth)).not.toContain(1000);
    expect(sets.filter(patch => "sidebarWidth" in patch).map(patch => patch.sidebarWidth)).not.toContain(10);
    expect(sets).toEqual([{ theme: "light" }, { sidebarMode: "spaces" }, { terminalSize: "file" }, { sidebarWidth: SIDEBAR_DEFAULT_WIDTH + 8 }, { sidebarWidth: 300 }, { sidebarWidth: 480 }, { sidebarWidth: 220 }, { sidebarWidth: null }]);
  });

  it("shows both halves on the about row in a desktop shell, and the host's alone in a browser tab that has no other half", async () => {
    const { api } = fakeApi({ ...DEFAULT_PREFERENCES, labs: true });
    useStore.getState().bind(api);
    await flush();
    const fact = (): string => document.querySelector<HTMLElement>("[data-k=version]")!.textContent!;
    served({ wsPort: 1, token: "t", wsPath: "/ws", paired: true, version: "0.1.5" });
    window.wsp = { version: "0.1.3" };
    render(<SettingsPage />);
    expect(fact()).toBe("app 0.1.3 · host 0.1.5");
    expect(document.querySelector<HTMLElement>("[data-k=version]")!.className).toContain("font-mono");
    document.body.innerHTML = "";
    delete window.wsp;
    render(<SettingsPage />);
    expect(fact()).toBe("host 0.1.5");
    document.body.innerHTML = "";
    // A shell from before the bridge carried a version: the page has a half it cannot name, and says so rather than
    // reading as a browser tab.
    window.wsp = {};
    render(<SettingsPage />);
    expect(fact()).toBe("app unknown · host 0.1.5");
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
