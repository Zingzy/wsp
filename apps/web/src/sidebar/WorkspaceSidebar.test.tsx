// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Capabilities, type PlaceView, type ProjectView, type WorkspaceView , type WorkspaceLanding } from "@wsp/protocol";
import { workspaceActions } from "../actions/workspaceActions.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { PROJECT_WORDS } from "./words.js";

// The triggers keep their elements and no popup mounts: Base UI's positioning against jsdom's zero-size rects
// costs seconds per open, and this file reads rows rather than popups.
vi.mock("../components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

// The switcher's menu on a plain open/closed context: Base UI's popover never settles under jsdom.
vi.mock("../components/ui/popover.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Popover = ({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => <Ctx.Provider value={{ open, set: onOpenChange }}>{children}</Ctx.Provider>;
  const PopoverTrigger = ({ children, render: element, disabled, ...props }: { children: ReactNode; render: ReactElement<Record<string, unknown>>; disabled?: boolean; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return cloneElement(element, { ...props, disabled, onClick: () => ctx.set(!ctx.open) }, children);
  };
  const PopoverPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="dialog" data-slot="popover-popup">{children}</div> : null);
  return { Popover, PopoverTrigger, PopoverPopup };
});

const project = (id: string, name: string, computer = "here"): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-Users-dev-${name}`,
  memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`,
  createdAt: "2026-09-17T00:00:00.000Z",
});

const workspace = (id: string, name: string, projectId: string): WorkspaceView => ({
  id,
  name,
  kind: "local",
  machineId: "local",
  project: { id: projectId, name: projectId, path: `/Users/dev/${projectId}`, computer: "here" },
  phase: "running",
  golden: "",
  createdAt: "2026-09-17T01:00:00.000Z",
  copy: { road: "clonefile", path: "/Users/dev/spoo-pricing-page", source: "/Users/dev/spoo", base: "abc", branch: "agent/pricing-page", carried: "deps-and-config" },
  portBase: 3100,
});

const SHARES = { copies: true, ownNetwork: false } as unknown as Capabilities;
const landing: WorkspaceLanding = { name: "here", capabilities: SHARES };
const MAC_ROW: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true };

function mount({ projects, workspaces }: { projects: ProjectView[]; workspaces: WorkspaceView[] }) {
  const create = vi.fn(async (_project: string, name: string) => ({ ...workspace("ws_new", name, "pr_1") }));
  const api = {
    subscribe: () => () => {},
    listWorkspaces: async () => workspaces,
    listSessions: async () => [],
    watchStatuses: async () => [],
    capabilities: async () => SHARES,
    getGolden: async () => ({ head: null, versions: [] }),
    placesList: async () => ({ places: [MAC_ROW], adds: [] }),
    projectsList: async () => projects,
    projectsAdd: async () => project("pr_new", "new"),
    projectsRemove: async () => {},
    workspacesLanding: async () => landing,
    createWorkspace: create,
    daemon: { open: () => () => {} },
  } as unknown as Api;
  useStore.setState({
    api,
    conn: "live",
    ready: true,
    projectsRead: true,
    workspaces,
    projects,
    statuses: {},
    sessions: {},
    launches: {},
    creations: [],
    places: [MAC_ROW],
    landings: Object.fromEntries(projects.map(p => [p.id, landing])),
    selectedId: null,
    selectedThreadId: null,
    projectHome: null,
    projectsRefused: null,
    preferences: { ...DEFAULT_PREFERENCES, labs: true },
  } as never);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
    </SidebarProvider>,
  );
  return { create };
}

const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(row => row.dataset["rowId"] ?? "");
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const depthOf = (text: string): number => Number(rowOf(text).dataset["depth"]);
const HOUR = 60 * 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** Sessions for the store, one per thread, keyed by workspace. */
const sessions = (rows: Array<{ ws: string; id: string; prompt: string; parent?: string; status?: string; startedAgo?: number; endedAgo?: number }>) => {
  const by: Record<string, unknown[]> = {};
  for (const r of rows) {
    (by[r.ws] ??= []).push({
      id: `s_${r.id}`,
      workspaceId: r.ws,
      threadId: r.id,
      harness: "claude",
      status: r.status ?? "running",
      prompt: r.prompt,
      startedBy: r.parent === undefined ? "person" : "agent",
      ...(r.parent === undefined ? {} : { parentThreadId: r.parent }),
      startedAt: ago(r.startedAgo ?? HOUR),
      ...(r.endedAgo === undefined ? {} : { endedAt: ago(r.endedAgo) }),
    });
  }
  return by;
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useStore.setState({ api: null, projects: [], workspaces: [], landings: {} } as never);
});

describe("the sidebar's list of thread tiles", () => {
  it("lists every root thread as a tile across every workspace, newest first, with no project row and no workspace row over them", async () => {
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), workspace("ws_b", "webhook retries", "pr_2")] });
    await act(async () => {
      useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_old", prompt: "the older one", startedAgo: 3 * HOUR }, { ws: "ws_b", id: "th_new", prompt: "the newer one", startedAgo: HOUR }]) } as never);
    });
    await waitFor(() => expect(screen.getByText("the newer one")).toBeDefined());
    expect(rowIds()).toEqual(["thread:th_new", "thread:th_old"]);
    expect(document.querySelector("[data-row-id^=project\\:]")).toBeNull();
    expect(rowOf("the older one").querySelector("[data-tile-where]")!.textContent).toBe("pr_1 @ zingzy's MacBook Pro");
    expect(rowOf("the older one").querySelector("[data-tile-branch]")!.textContent).toBe("agent/pricing-page");
    expect(depthOf("the newer one")).toBe(0);
  });

  it("draws a workspace with no thread as a tile of its own under its name, which selects it", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(rowIds()).toEqual(["ws:ws_a"]);
    fireEvent.click(rowOf("pricing page"));
    expect(useStore.getState().selectedId).toBe("ws_a");
    expect(useStore.getState().selectedThreadId).toBeNull();
  });

  it("titles this computer's own workspace with no thread by the computer's name, never its host name, and a copy by its own", async () => {
    const { copy: _copy, ...itself } = workspace("ws_a", "zingzys-MacBook-Pro.local", "pr_1");
    mount({ projects: [project("pr_1", "spoo")], workspaces: [itself] });
    await waitFor(() => expect(rowIds()).toEqual(["ws:ws_a"]));
    const tile = document.querySelector<HTMLElement>("[data-row-id='ws:ws_a']")!;
    expect(tile.querySelector("[data-thread-title]")!.textContent).toBe("zingzy's MacBook Pro");
    expect(tile.textContent).not.toContain("zingzys-MacBook-Pro.local");
  });

  it("under a picked project lists that project's tiles alone, and All projects brings every tile back", async () => {
    window.localStorage.setItem("wsp:sidebar-project", JSON.stringify("pr_2"));
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), workspace("ws_b", "webhook retries", "pr_2")] });
    await waitFor(() => expect(screen.getByText("webhook retries")).toBeDefined());
    expect(rowIds()).toEqual(["ws:ws_b"]);
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=project-switcher]")!);
    fireEvent.click(await screen.findByText("All projects"));
    await waitFor(() => expect(rowIds().sort()).toEqual(["ws:ws_a", "ws:ws_b"]));
  });

  it("says a project with nothing on it as one quiet sentence where the tiles would stand, and drops it once a tile is there", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] });
    const line = await waitFor(() => screen.getByText(PROJECT_WORDS.noWorkspaces));
    expect(line.className).toContain("text-[13px]");
    expect(line.className).not.toContain("font-mono");
    act(() => useStore.setState({ workspaces: [workspace("ws_a", "pricing page", "pr_1")] } as never));
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(screen.queryByText(PROJECT_WORDS.noWorkspaces)).toBeNull();
  });

  it("records another project from the foot of the switcher's menu, which opens the Add a project dialog, and from nowhere else at rest", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] });
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-k=project-switcher]")!.disabled).toBe(false));
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=project-switcher]")!);
    fireEvent.click(await screen.findByText(PROJECT_WORDS.add));
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
    expect(screen.getByRole("dialog", { name: PROJECT_WORDS.add })).toBeDefined();
  });

  it("offers no Spaces row and no look action in a tile's menu, whatever the preferences record says", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(document.body.textContent).not.toContain("Spaces");
    expect(document.querySelector("[data-space-icon]")).toBeNull();
    // The registry itself no longer carries them, so no surface can offer one: no entry is held back by a flag.
    expect(workspaceActions.map(action => action.id)).not.toContain("icon");
    expect(workspaceActions.map(action => action.id)).not.toContain("theme");
    expect(workspaceActions.some(action => "labs" in action)).toBe(false);
  });

  it("hangs the threads an agent opened, and a workspace it forked with its threads, under the thread on the rail", async () => {
    const lead = workspace("ws_a", "pricing page", "pr_1");
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    const empty = { ...workspace("ws_empty", "pricing copy", "pr_1"), parentThreadId: "th_lead", createdAt: ago(3 * HOUR) };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, forked, empty] });
    await act(async () => {
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_lead", prompt: "move the pricing table", startedAgo: 2 * HOUR },
          { ws: "ws_a", id: "th_review", prompt: "review the move", parent: "th_lead", startedAgo: 90 * 60_000 },
          { ws: "ws_fork", id: "th_child", prompt: "write the migration", startedAgo: HOUR },
        ]),
      } as never);
    });
    await waitFor(() => expect(screen.getByText("write the migration")).toBeDefined());
    expect(rowIds()).toEqual(["thread:th_lead", "thread:th_child", "thread:th_review", "ws:ws_empty"]);
    expect([depthOf("move the pricing table"), depthOf("write the migration"), depthOf("review the move"), depthOf("pricing copy")]).toEqual([0, 1, 1, 1]);
    // Real nesting: the children sit in the root's own list item, each item drawing its rail.
    const rootItem = rowOf("move the pricing table").closest("li[data-thread-item]")!;
    expect(rootItem.contains(rowOf("write the migration"))).toBe(true);
    expect(rootItem.className).not.toContain("before:");
    expect(rowOf("write the migration").closest("li")!.className).toContain("before:bg-[var(--sidebar-rail)]");
    expect(rowOf("write the migration").closest("li")!.className).toContain("after:top-[15px]");
    expect(rowOf("write the migration").closest("ul")!.className).toContain("ml-3");
  });

  it("keeps a thread whose opener was forgotten as a root of its own, so no thread the host holds loses its tile", async () => {
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), forked] });
    await act(async () => {
      useStore.setState({ sessions: sessions([{ ws: "ws_fork", id: "th_child", prompt: "write the migration", parent: "th_lead" }]) } as never);
    });
    await waitFor(() => expect(screen.getByText("write the migration")).toBeDefined());
    expect(rowIds()).toEqual(["thread:th_child", "ws:ws_a"]);
    expect(depthOf("write the migration")).toBe(0);
  });

  it("folds every root quiet a day into Settled at the foot: shut with its count, 12 px under the list, opened by its chevron and remembered", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => {
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_live", prompt: "still going" },
          { ws: "ws_a", id: "th_quiet", prompt: "finished yesterday", status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR },
          { ws: "ws_a", id: "th_quiet_child", prompt: "its helper", parent: "th_quiet", status: "completed", startedAgo: 30 * HOUR, endedAgo: 28 * HOUR },
        ]),
      } as never);
    });
    await waitFor(() => expect(screen.getByText("still going")).toBeDefined());
    expect(rowIds()).toEqual(["thread:th_live", "settled"]);
    const fold = document.querySelector<HTMLElement>("[data-row-id=settled]")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.className).toContain("h-9");
    expect(fold.closest("li")!.className).toContain("mt-3");
    expect(fold.querySelector("[data-group-word]")!.className).toContain("uppercase");
    expect(fold.querySelector("[data-group-word]")!.className).toContain("font-mono");
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("2");
    expect(fold.textContent).not.toMatch(/[·•]/);
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_live", "settled", "thread:th_quiet", "thread:th_quiet_child"]));
    expect(fold.querySelector("[data-group-count]")).toBeNull();
    expect(window.localStorage.getItem("wsp:sidebar-settled-open")).toBe("true");
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_live", "settled"]));
    expect(window.localStorage.getItem("wsp:sidebar-settled-open")).toBe("false");
  });
});
