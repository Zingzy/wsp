// SPDX-License-Identifier: AGPL-3.0-only
// The two pickers a workspace's menu opens, over the real popover: Change icon
// is a search field over the app's icon set with the current one marked and a
// way back to none; Edit theme colour is the Zen-shaped picker, the mode at
// the top, a wheel the first dot is dragged over with the harmony's dots
// following, the count and harmony controls, the preset row, the grain and
// opacity sliders and the way back to no theme. A drag paints the record here
// as it moves and the host hears the value once the pointer lets go. Both open
// anchored to the space icon in Spaces and to the row in the list, from the
// same menu the space icon carries.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, DEFAULT_THEME, THEME_PRESETS, applyPreset, harmonyDots, type SessionView, type WorkspaceLook, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { ContextMenuHost } from "../src/actions/ContextMenuHost.js";
import { WORKSPACE_WORDS } from "../src/actions/format.js";
import { THEME_WORDS, dotAt } from "../src/components/look/ThemePopover.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { statusOf } from "./workspace-status.js";

// The popover renders inline and records what it was anchored to: Base UI's positioning against jsdom's zero-size
// rects costs seconds per open, and the anchor is the one fact of it this file reads.
vi.mock("../src/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverPopup: ({ children, anchor, role, "aria-label": label, ...rest }: { children: ReactNode; anchor?: HTMLElement | null; role?: string; "aria-label"?: string } & Record<string, unknown>) => (
    <div role={role} aria-label={label} data-anchor={anchor instanceof HTMLElement ? anchor.getAttribute("data-space-icon") ?? anchor.getAttribute("data-row-id") ?? "root" : "none"} {...Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("data-")))}>
      {children}
    </div>
  ),
}));
vi.mock("../src/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : children === undefined ? element : cloneElement(element, {}, children),
  TooltipPopup: () => null,
}));

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({ id, name, machineId: `m_${id}`, phase, golden: "snap_g", createdAt: new Date(Date.now() - 3_600_000).toISOString() });
const API = view("ws_a", "api");
const WEB = view("ws_b", "web", "napping");

type FakeApi = Api & { setWorkspaceLook: ReturnType<typeof vi.fn> };

function fakeApi(workspaces: WorkspaceView[], statuses: WorkspaceStatus[], sessions: SessionView[] = []): FakeApi {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => statuses,
    nap: async id => view(id, "?", "napping"),
    wake: async id => view(id, "?"),
    upgrade: async id => view(id, "?"),
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, firstLifeSnapshots: true, templates: false, kept: false, sizes: [] }),
    startSession: async o => ({ id: "s_x", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: 0 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => sessions,
    subscribe: () => () => {},
    getGolden: async () => ({ head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "t", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 } }] }),
    // The look sits on the record beside the name, so the fixture writes it there and answers with the row.
    setWorkspaceLook: vi.fn(async (id: string, look: WorkspaceLook) => {
      const row = workspaces.find(w => w.id === id)!;
      if (look.theme !== undefined) {
        if (look.theme === null) delete row.theme;
        else row.theme = look.theme;
      }
      if (look.glyph !== undefined) {
        if (look.glyph === null) delete row.glyph;
        else row.glyph = look.glyph;
      }
      return row;
    }),
  };
}

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const item = (label: string): HTMLElement => within(screen.getByRole("menu")).getAllByRole("menuitem").find(el => el.textContent?.startsWith(label))!;
const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 40, clientY: 50, composed: true });
const iconPicker = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-icon-picker]");
const themePicker = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-theme-picker]");
const icons = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-icon]"));
const stored = (id: string): WorkspaceView => useStore.getState().workspaces.find(w => w.id === id)!;

async function mount(api: FakeApi, spaces = false): Promise<void> {
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarMode: spaces ? "spaces" : "list" } });
  useStore.getState().bind(api);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
      <ContextMenuHost />
    </SidebarProvider>,
  );
  await waitFor(() => expect(screen.getByText("api")).toBeDefined());
}

async function openFromMenu(on: HTMLElement, word: string): Promise<HTMLElement> {
  rightClick(on);
  await screen.findByRole("menu");
  fireEvent.click(item(word));
  return await screen.findByRole("dialog");
}

beforeEach(() => {
  window.localStorage.clear();
  // Base UI's radio re-dispatches a click as a PointerEvent, and the wheel reads a pointer's button and place, none
  // of which jsdom has.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Change icon", () => {
  it("opens a popover with a search field over the icon set, None first and the current one marked; a pick sends the glyph alone and the row follows", async () => {
    const api = fakeApi([{ ...API, glyph: "rocket" }], [statusOf(API)]);
    await mount(api);
    const popover = await openFromMenu(rowOf("api"), WORKSPACE_WORDS.icon);
    expect(iconPicker()).not.toBeNull();
    expect(themePicker()).toBeNull();
    // In the list the picker hangs off the row the menu was opened on.
    expect(popover.getAttribute("data-anchor")).toBe("ws:ws_a");
    expect(within(popover).getByText(WORKSPACE_WORDS.icon)).toBeDefined();
    expect(within(popover).getByText("api")).toBeDefined();
    const cells = (): string[] => within(popover).getAllByRole("button").map(b => b.getAttribute("aria-label") ?? "").filter(label => label.startsWith("Icon:"));
    expect(cells()[0]).toBe("Icon: None");
    expect(cells()).toContain("Icon: Flask");
    expect(cells().length).toBeGreaterThan(20);
    expect(within(popover).getByRole("button", { name: "Icon: Rocket" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(popover).getByRole("button", { name: "Icon: None" }).getAttribute("aria-pressed")).toBe("false");
    // The search narrows the set; None is the way back, so it is offered with the whole set alone.
    fireEvent.change(within(popover).getByRole("searchbox", { name: "Search icons" }), { target: { value: "fla" } });
    expect(cells()).toEqual(["Icon: Flask"]);
    fireEvent.click(within(popover).getByRole("button", { name: "Icon: Flask" }));
    await waitFor(() => expect(api.setWorkspaceLook).toHaveBeenCalledWith("ws_a", { glyph: "flask" }));
    await waitFor(() => expect(stored("ws_a").glyph).toBe("flask"));
    expect(within(popover).getByRole("button", { name: "Icon: Flask" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(within(popover).getByRole("searchbox", { name: "Search icons" }), { target: { value: "" } });
    fireEvent.click(within(popover).getByRole("button", { name: "Icon: None" }));
    await waitFor(() => expect(api.setWorkspaceLook).toHaveBeenCalledWith("ws_a", { glyph: null }));
    await waitFor(() => expect(stored("ws_a").glyph).toBeUndefined());
  });
});

describe("Edit theme colour", () => {
  it("opens the picker with the mode, the wheel and its dots, the count and harmony controls, the presets, the two sliders and the way back; a preset sends the theme whole and marks itself", async () => {
    const api = fakeApi([API], [statusOf(API)]);
    await mount(api);
    const popover = await openFromMenu(rowOf("api"), WORKSPACE_WORDS.theme);
    expect(themePicker()).not.toBeNull();
    expect(iconPicker()).toBeNull();
    expect(within(popover).getAllByRole("radio").map(r => r.textContent)).toEqual([THEME_WORDS.mode.auto, THEME_WORDS.mode.light, THEME_WORDS.mode.dark]);
    expect(within(popover).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    // No theme yet: the picker shows the default and sends nothing until a control moves.
    expect(api.setWorkspaceLook).not.toHaveBeenCalled();
    expect(popover.querySelectorAll("[data-theme-dot]")).toHaveLength(DEFAULT_THEME.dots.length);
    expect(popover.querySelector("[data-theme-count]")!.textContent).toBe(`${DEFAULT_THEME.dots.length}/3`);
    expect(within(popover).getAllByRole("button", { name: /^Presets:/ })).toHaveLength(THEME_PRESETS.length);
    expect(within(popover).getByRole("button", { name: `Presets: ${THEME_PRESETS[0]!.id}` }).getAttribute("aria-pressed")).toBe("true");
    expect(within(popover).getAllByRole("slider").map(s => s.getAttribute("aria-label"))).toEqual([THEME_WORDS.grain, THEME_WORDS.opacity]);
    expect(popover.querySelector("[data-theme-slider=grain]")!.textContent).toContain("0%");
    expect(popover.querySelector("[data-theme-slider=opacity]")!.textContent).toContain("50%");
    // Nothing loud: the labels are caps mono, the values mono, and no chip or badge anywhere.
    expect(popover.querySelectorAll("[data-slot=badge]")).toHaveLength(0);
    for (const label of popover.querySelectorAll("[data-theme-slider] span:first-child")) expect(label.className).toContain("uppercase");
    expect((within(popover).getByRole("button", { name: THEME_WORDS.remove }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(popover).getByRole("button", { name: `Presets: ${THEME_PRESETS[1]!.id}` }));
    const expected = applyPreset(DEFAULT_THEME, THEME_PRESETS[1]!);
    await waitFor(() => expect(api.setWorkspaceLook).toHaveBeenCalledWith("ws_a", { theme: expected }));
    await waitFor(() => expect(stored("ws_a").theme).toEqual(expected));
    expect(within(popover).getByRole("button", { name: `Presets: ${THEME_PRESETS[1]!.id}` }).getAttribute("aria-pressed")).toBe("true");
    expect(within(popover).getByRole("button", { name: `Presets: ${THEME_PRESETS[0]!.id}` }).getAttribute("aria-pressed")).toBe("false");
    expect(popover.querySelectorAll("[data-theme-dot]")).toHaveLength(expected.dots.length);

    fireEvent.click(within(popover).getByRole("radio", { name: THEME_WORDS.mode.dark }));
    await waitFor(() => expect(stored("ws_a").theme?.mode).toBe("dark"));
    await waitFor(() => expect(within(popover).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]));
    fireEvent.click(within(popover).getByRole("button", { name: THEME_WORDS.moreDots }));
    await waitFor(() => expect(stored("ws_a").theme?.dots).toHaveLength(3));
    expect((within(popover).getByRole("button", { name: THEME_WORDS.moreDots }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(popover).getByRole("button", { name: THEME_WORDS.harmony }));
    await waitFor(() => expect(stored("ws_a").theme?.harmony).not.toBe(expected.harmony));
    expect(stored("ws_a").theme?.dots).toEqual(harmonyDots(stored("ws_a").theme!.dots[0]!, stored("ws_a").theme!.harmony));

    fireEvent.click(within(popover).getByRole("button", { name: THEME_WORDS.remove }));
    await waitFor(() => expect(api.setWorkspaceLook).toHaveBeenCalledWith("ws_a", { theme: null }));
    await waitFor(() => expect(stored("ws_a").theme).toBeUndefined());
  });

  it("a press on the wheel moves the first dot there with the harmony's dot following, the record follows as the pointer moves, and the host hears the value once when it lets go", async () => {
    const api = fakeApi([{ ...API, theme: DEFAULT_THEME }], [statusOf(API)]);
    await mount(api);
    const popover = await openFromMenu(rowOf("api"), WORKSPACE_WORDS.theme);
    const wheel = popover.querySelector<HTMLElement>("[data-theme-wheel]")!;
    wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(wheel, { button: 0, clientX: 200, clientY: 100, pointerId: 1 });
    expect(stored("ws_a").theme?.dots[0]).toEqual({ angle: 0, radius: 1 });
    expect(api.setWorkspaceLook).not.toHaveBeenCalled();
    fireEvent.pointerMove(wheel, { clientX: 100, clientY: 150, pointerId: 1 });
    expect(stored("ws_a").theme?.dots[0]).toEqual({ angle: 90, radius: 0.5 });
    // The harmony's dot keeps its angle from the first and its radius.
    expect(stored("ws_a").theme?.dots).toEqual(harmonyDots({ angle: 90, radius: 0.5 }, DEFAULT_THEME.harmony));
    fireEvent.pointerUp(wheel, { clientX: 100, clientY: 150, pointerId: 1 });
    await waitFor(() => expect(api.setWorkspaceLook).toHaveBeenCalledTimes(1));
    expect(api.setWorkspaceLook).toHaveBeenCalledWith("ws_a", { theme: { ...DEFAULT_THEME, dots: harmonyDots({ angle: 90, radius: 0.5 }, DEFAULT_THEME.harmony) } });
    // The first dot is a button the arrows move too, and a press outside the rim lands on it.
    fireEvent.keyDown(within(popover).getByRole("button", { name: THEME_WORDS.dot }), { key: "ArrowRight" });
    await waitFor(() => expect(stored("ws_a").theme?.dots[0]?.angle).toBe(95));
    expect(dotAt({ left: 0, top: 0, width: 200, height: 200 } as DOMRect, 400, 100)).toEqual({ angle: 0, radius: 1 });
  });

  it("in Spaces the space icon's menu is the workspace's menu, with the two pickers, and they open anchored to that icon", async () => {
    const api = fakeApi([API, WEB], [statusOf(API), statusOf(WEB)]);
    await mount(api, true);
    await waitFor(() => expect(icons()).toHaveLength(2));
    rightClick(icons()[1]!);
    const menu = await screen.findByRole("menu");
    const words = within(menu).getAllByRole("menuitem").map(el => el.querySelector("[data-menu-label]")?.textContent);
    expect(words).toContain(WORKSPACE_WORDS.wake);
    expect(words).toContain(WORKSPACE_WORDS.rename);
    expect(words).toContain(WORKSPACE_WORDS.newThread);
    expect(words).toContain(WORKSPACE_WORDS.forget);
    expect(words).toContain(WORKSPACE_WORDS.icon);
    expect(words).toContain(WORKSPACE_WORDS.theme);
    fireEvent.click(item(WORKSPACE_WORDS.icon));
    const popover = await screen.findByRole("dialog");
    expect(popover.getAttribute("aria-label")).toBe(`${WORKSPACE_WORDS.icon}: web`);
    expect(popover.getAttribute("data-anchor")).toBe("ws_b");
    fireEvent.click(within(popover).getByRole("button", { name: "Icon: Bug" }));
    await waitFor(() => expect(api.setWorkspaceLook).toHaveBeenCalledWith("ws_b", { glyph: "bug" }));
    await waitFor(() => expect(icons()[1]!.querySelector("[data-space-glyph='bug']")).not.toBeNull());
  });
});
