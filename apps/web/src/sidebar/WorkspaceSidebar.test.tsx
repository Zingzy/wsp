// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Capabilities, type PlaceView, type ProjectView, type WorkspaceView , type WorkspaceLanding } from "@wsp/protocol";
import { workspaceActions } from "../actions/workspaceActions.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import type { Api } from "../protocol/client.js";
import { provideDaemonWire } from "../files/wire.js";
import { useStore } from "../protocol/store.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../terminal/link.js";
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
  const settleThreads = vi.fn(async (_threadIds: readonly string[]) => {});
  const markThreads = vi.fn(async (_threadIds: readonly string[], _marks: unknown) => {});
  const restoreThreads = vi.fn(async (_threadIds: readonly string[]) => {});
  const setPreferences = vi.fn(async (patch: unknown) => ({ ...DEFAULT_PREFERENCES, ...(patch as object) }));
  const api = {
    settleThreads,
    markThreads,
    restoreThreads,
    setPreferences,
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
  return { create, settleThreads, markThreads, restoreThreads, setPreferences };
}

const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(row => row.dataset["rowId"] ?? "");
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const depthOf = (text: string): number => Number(rowOf(text).dataset["depth"]);
const HOUR = 60 * 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** Sessions for the store, one per thread, keyed by workspace. */
/** A turn that ended was shown as it ended unless `readAgo` says the last showing was earlier. */
const sessions = (rows: Array<{ ws: string; id: string; prompt: string; parent?: string; status?: string; startedAgo?: number; endedAgo?: number; readAgo?: number; settledAgo?: number; asking?: string; pinnedAgo?: number; snoozed?: boolean; section?: { name: string; whileState: string } }>) => {
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
      ...(r.endedAgo === undefined ? {} : { endedAt: ago(r.endedAgo), readAt: ago(r.readAgo ?? r.endedAgo) }),
      ...(r.settledAgo === undefined ? {} : { settledAt: ago(r.settledAgo) }),
      ...(r.asking === undefined ? {} : { asking: r.asking }),
      ...(r.pinnedAgo === undefined ? {} : { pinnedAt: Date.now() - r.pinnedAgo }),
      ...(r.snoozed === true ? { snoozedUntil: Date.now() + HOUR } : {}),
      ...(r.section === undefined ? {} : { section: r.section }),
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

  describe("a fork's branch", () => {
    const { copy: _copy, ...bare } = workspace("ws_f", "cart rounding", "pr_1");
    const fork: WorkspaceView = { ...bare, kind: "cloud", machineId: "fk_1", golden: "snap_g", project: { ...bare.project, path: "/root/spoo" } };
    const asked: string[] = [];
    const wireAnswering = (answer: () => Promise<Record<string, unknown>>): TerminalWire => ({
      request: async (op, params) => {
        if (op !== "git.status") throw new Error(`no ${op}`);
        asked.push(String(params?.["cwd"]));
        return answer();
      },
    });
    const linked = (id: string, wire: TerminalWire): WorkspaceTerminals => {
      const terms = new WorkspaceTerminals(wire);
      provideDaemonWire(id, wire);
      provideTerminals(id, terms);
      return terms;
    };
    const three = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row-id='ws:${id}']`)!.children[2] as HTMLElement;
    afterEach(() => {
      cleanup();
      asked.length = 0;
      for (const id of ["ws_f", "ws_a"]) {
        provideDaemonWire(id, null);
        provideTerminals(id, null);
      }
    });

    it("shows the branch git.status names in its project's folder once its link is up, and keeps it while the link is down", async () => {
      const terms = linked("ws_f", wireAnswering(async () => ({ branch: { oid: "abc", head: "fix/cart-rounding", ahead: 0, behind: 0 }, entries: [], root: "/root/spoo" })));
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      expect(three("ws_f").querySelector("[data-tile-branch]")).toBeNull();
      await act(async () => terms.feedStatus("live"));
      await waitFor(() => expect(three("ws_f").querySelector("[data-tile-branch]")?.textContent).toBe("fix/cart-rounding"));
      expect(three("ws_f").querySelector(".lucide-git-branch")).not.toBeNull();
      expect(asked).toEqual(["/root/spoo"]);
      act(() => terms.feedStatus("connecting"));
      expect(three("ws_f").querySelector("[data-tile-branch]")?.textContent).toBe("fix/cart-rounding");
      expect(asked).toEqual(["/root/spoo"]);
    });

    it("reads a fork's branch once however many tiles it has, and every tile shows it", async () => {
      const terms = linked("ws_f", wireAnswering(async () => ({ branch: { oid: "abc", head: "fix/cart-rounding", ahead: 0, behind: 0 }, entries: [], root: "/root/spoo" })));
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await act(async () => {
        useStore.setState({ sessions: sessions([{ ws: "ws_f", id: "th_one", prompt: "round the total once", startedAgo: HOUR - 60_000 }, { ws: "ws_f", id: "th_two", prompt: "pin the cart order" }]) } as never);
      });
      await waitFor(() => expect(rowIds()).toEqual(["thread:th_one", "thread:th_two"]));
      await act(async () => terms.feedStatus("live"));
      const branches = (): string[] => rowIds().map(id => document.querySelector(`[data-row-id='${id}'] [data-tile-branch]`)?.textContent ?? "");
      await waitFor(() => expect(branches()).toEqual(["fix/cart-rounding", "fix/cart-rounding"]));
      expect(asked).toEqual(["/root/spoo"]);
    });

    it("keeps the empty row three at the tile's height where git names no branch or nothing answers", async () => {
      const terms = linked("ws_f", wireAnswering(async () => Promise.reject(Object.assign(new Error("not a git repository"), { code: "not-a-git-repo" }))));
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      await act(async () => terms.feedStatus("live"));
      await waitFor(() => expect(asked).toEqual(["/root/spoo"]));
      const tile = document.querySelector<HTMLElement>("[data-row-id='ws:ws_f']")!;
      expect(tile.children).toHaveLength(3);
      expect(tile.className).toContain("h-[68px]");
      expect(three("ws_f").className).toContain("h-3.5");
      expect(three("ws_f").querySelector("[data-tile-branch]")).toBeNull();
      expect(three("ws_f").querySelector(".lucide-git-branch")).toBeNull();
    });

    it("shows a copy's branch off its record and asks its daemon nothing", async () => {
      const terms = linked("ws_a", wireAnswering(async () => ({ branch: { oid: "abc", head: "somewhere-else", ahead: 0, behind: 0 }, entries: [], root: "/Users/dev/pr_1" })));
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_a"]));
      await act(async () => terms.feedStatus("live"));
      expect(three("ws_a").querySelector("[data-tile-branch]")?.textContent).toBe("agent/pricing-page");
      expect(asked).toEqual([]);
    });
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

  it("folds every read root quiet two hours into Settled at the foot: its count shut and open, a hover fill, 12 px under the list, opened by its chevron and remembered", async () => {
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
    expect(fold.className).toContain("hover:bg-sidebar-row-hover");
    expect(fold.closest("li")!.className).toContain("mt-3");
    expect(fold.querySelector("[data-group-word]")!.className).toContain("uppercase");
    expect(fold.querySelector("[data-group-word]")!.className).toContain("font-mono");
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("2");
    expect(fold.textContent).not.toMatch(/[·•]/);
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_live", "settled", "thread:th_quiet", "thread:th_quiet_child"]));
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("2");
    expect(window.localStorage.getItem("wsp:sidebar-settled-open")).toBe("true");
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_live", "settled"]));
    expect(window.localStorage.getItem("wsp:sidebar-settled-open")).toBe("false");
  });

  it("a thread on a paused workspace reads Done until it is opened, then its age, and its tile says nothing about the machine", async () => {
    const napping = { ...workspace("ws_a", "pricing page", "pr_1"), phase: "napping" as const };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [napping] });
    const turn = { ws: "ws_a", id: "th_boat", prompt: "boat check", status: "completed", startedAgo: 6 * 60_000, endedAgo: 5 * 60_000 };
    await act(async () => useStore.setState({ sessions: sessions([{ ...turn, readAgo: HOUR }]) } as never));
    await waitFor(() => expect(screen.getByText("boat check")).toBeDefined());
    const slot = (): HTMLElement => rowOf("boat check").querySelector<HTMLElement>("[data-thread-status]")!;
    expect(slot().textContent).toBe("Done");
    expect(slot().dataset["tone"]).toBe("done");
    expect(rowOf("boat check").textContent).not.toMatch(/Paused|Stopped|Unreachable|Waking|Failed/);
    expect(rowOf("boat check").querySelector("[data-tone=warning], [data-tone=failed]")).toBeNull();
    await act(async () => useStore.setState({ sessions: sessions([turn]) } as never));
    await waitFor(() => expect(slot().textContent).toBe("5m"));
    expect(slot().dataset["tone"]).toBeUndefined();
    expect(rowOf("boat check").textContent).not.toMatch(/Paused|Stopped|Unreachable/);
  });

  it("a live root's menu settles its whole tree, and the Settled row's own menu settles every read tree while an unseen one stays", async () => {
    const { settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => {
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_lead", prompt: "the lead", status: "completed", startedAgo: 20 * 60_000, endedAgo: 10 * 60_000 },
          { ws: "ws_a", id: "th_builder", prompt: "its builder", parent: "th_lead", status: "completed", startedAgo: 15 * 60_000, endedAgo: 12 * 60_000 },
          { ws: "ws_a", id: "th_unseen", prompt: "nobody looked", status: "completed", startedAgo: 9 * 60_000, endedAgo: 8 * 60_000, readAgo: HOUR },
        ]),
      } as never);
    });
    await waitFor(() => expect(screen.getByText("the lead")).toBeDefined());
    // Nothing has settled yet, but there is a read tree to settle, so the row that settles it is there.
    const fold = document.querySelector<HTMLElement>("[data-row-id=settled]")!;
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("0");
    const picked: string[][] = [];
    const choose = (id: string) => (window.wsp = { contextMenu: async (items: Array<{ id: string; enabled?: boolean }>) => (picked.push(items.map(item => item.id)), id) } as never);
    try {
      choose("settle");
      fireEvent.contextMenu(rowOf("the lead"));
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_lead", "th_builder"]));
      expect(picked[0]).toContain("settle");
      // A thread under a root settles with it, so its own menu offers none.
      fireEvent.contextMenu(rowOf("its builder"));
      await waitFor(() => expect(picked).toHaveLength(2));
      expect(picked[1]).not.toContain("settle");
      settleThreads.mockClear();
      choose("settle-read");
      fireEvent.contextMenu(fold);
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_lead", "th_builder"]));
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });

  it("keeps a failure on the list however long ago it was read, and folds it muted once settled by hand", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const failed = { ws: "ws_a", id: "th_broke", prompt: "it broke", status: "failed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR, readAgo: 28 * HOUR };
    await act(async () => useStore.setState({ sessions: sessions([failed]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_broke", "settled"]));
    expect(rowOf("it broke").querySelector("[data-thread-status]")!.textContent).toBe("Failed");
    await act(async () => useStore.setState({ sessions: sessions([{ ...failed, settledAgo: HOUR }]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    fireEvent.click(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
    await waitFor(() => expect(rowIds()).toEqual(["settled", "thread:th_broke"]));
    const slot = rowOf("it broke").querySelector<HTMLElement>("[data-thread-status]")!;
    expect(slot.textContent).toBe("1d");
    expect(slot.dataset["tone"]).toBeUndefined();
  });

  it("leaves the thread open in the centre on the list while it is read, and folds it once another is open", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_long", prompt: "a long read", status: "completed", startedAgo: 5 * HOUR, endedAgo: 4 * HOUR }]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    act(() => useStore.getState().select("ws_a", "th_long"));
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_long", "settled"]));
    act(() => useStore.getState().select(null));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
  });

  it("settles by hand at once, and a turn after the settle brings the thread back to the list", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const put = (row: Parameters<typeof sessions>[0][number]) => act(async () => useStore.setState({ sessions: sessions([row]) } as never));
    await put({ ws: "ws_a", id: "th_one", prompt: "put away", status: "completed", startedAgo: 20 * 60_000, endedAgo: 10 * 60_000, settledAgo: 5 * 60_000 });
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    await put({ ws: "ws_a", id: "th_one", prompt: "put away", status: "running", startedAgo: 60_000, settledAgo: 5 * 60_000 });
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_one"]));
  });

  it("scrolls its tiles under a hard edge with no fade, so a tile part way under the head never reads as a tile with its first row gone and its title dimmed", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    const scroller = document.querySelector<HTMLElement>("[data-sidebar-tree]")!.closest<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    expect(scroller).not.toBeNull();
    expect(scroller.className).not.toMatch(/mask-/);
  });

  describe("the sections, the marks and the drag", () => {
    const heads = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-section-head]")].map(head => head.dataset["sectionHead"] ?? "");
    const drag = (tile: HTMLElement, onto: HTMLElement): void => {
      const data = new Map<string, string>();
      const dataTransfer = { setData: (type: string, value: string) => void data.set(type, value), getData: (type: string) => data.get(type) ?? "", types: ["text/plain"], effectAllowed: "move", dropEffect: "move" };
      fireEvent.dragStart(tile, { dataTransfer });
      fireEvent.dragOver(onto, { dataTransfer });
      fireEvent.drop(onto, { dataTransfer });
      fireEvent.dragEnd(tile, { dataTransfer });
    };
    const all = [
      { ws: "ws_a", id: "th_asks", prompt: "wants an answer", startedAgo: 5 * 60_000, asking: "Permission for Bash: ls" },
      { ws: "ws_a", id: "th_works", prompt: "still going", startedAgo: 6 * 60_000 },
      { ws: "ws_a", id: "th_done", prompt: "finished unseen", status: "completed", startedAgo: 9 * 60_000, endedAgo: 8 * 60_000, readAgo: HOUR },
      { ws: "ws_a", id: "th_idle", prompt: "read already", status: "completed", startedAgo: 12 * 60_000, endedAgo: 11 * 60_000 },
      { ws: "ws_a", id: "th_pinned", prompt: "kept on top", status: "completed", startedAgo: 30 * 60_000, endedAgo: 29 * 60_000, pinnedAgo: 60_000 },
      { ws: "ws_a", id: "th_away", prompt: "snoozed away", status: "completed", startedAgo: 40 * 60_000, endedAgo: 39 * 60_000, snoozed: true },
    ];

    it("draws the live list under Pinned, Needs you, Working, Done and Idle, leaves a snoozed tree out, and a finish nobody opened reads Done", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(all) } as never));
      await waitFor(() => expect(screen.getByText("kept on top")).toBeDefined());
      expect(heads()).toEqual(["pinned", "needs-you", "working", "done", "idle"]);
      expect([...document.querySelectorAll("[data-section-head]")].map(head => head.querySelector("[data-group-word]")!.textContent)).toEqual(["Pinned", "Needs you", "Working", "Done", "Idle"]);
      expect(rowIds()).toEqual(["thread:th_pinned", "thread:th_asks", "thread:th_works", "thread:th_done", "thread:th_idle", "settled"]);
      expect(screen.queryByText("snoozed away")).toBeNull();
      expect(rowOf("finished unseen").querySelector("[data-thread-status]")!.textContent).toBe("Done");
    });

    it("a root's menu pins, unpins and snoozes it, and a folded root's menu restores its tree", async () => {
      const { markThreads, restoreThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([...all, { ws: "ws_a", id: "th_folded", prompt: "put away", status: "completed", startedAgo: 20 * 60_000, endedAgo: 10 * 60_000, settledAgo: 5 * 60_000 }]) } as never));
      await waitFor(() => expect(screen.getByText("read already")).toBeDefined());
      const picked: string[][] = [];
      const choose = (id: string) => (window.wsp = { contextMenu: async (items: Array<{ id: string }>) => (picked.push(items.map(item => item.id)), id) } as never);
      try {
        choose("pin");
        fireEvent.contextMenu(rowOf("read already"));
        await waitFor(() => expect(markThreads).toHaveBeenCalledWith(["th_idle"], { pinned: true }));
        choose("pin");
        fireEvent.contextMenu(rowOf("kept on top"));
        await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_pinned"], { pinned: false }));
        choose("snooze");
        fireEvent.contextMenu(rowOf("read already"));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: /In 1 hour/ }));
        await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_idle"], { snoozedUntil: expect.any(Number) }));
        const until = (markThreads.mock.calls.at(-1)![1] as { snoozedUntil: number }).snoozedUntil;
        expect(Math.abs(until - (Date.now() + HOUR))).toBeLessThan(5_000);
        fireEvent.click(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
        choose("restore");
        fireEvent.contextMenu(rowOf("put away"));
        await waitFor(() => expect(restoreThreads).toHaveBeenCalledWith(["th_folded"]));
      } finally {
        delete (window as { wsp?: unknown }).wsp;
      }
    });

    it("a tile dropped on another section holds there by a mark, one dropped on Pinned pins, one dropped back on its own section clears the mark, and one dropped on Settled settles its tree", async () => {
      const { markThreads, settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([...all, { ws: "ws_a", id: "th_moved", prompt: "moved by hand", startedAgo: 7 * 60_000, section: { name: "done", whileState: "working:s_th_moved" } }]) } as never));
      await waitFor(() => expect(screen.getByText("still going")).toBeDefined());
      expect(document.querySelector("[data-section=done]")!.textContent).toContain("moved by hand");
      const section = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-section=${id}]`)!;
      drag(rowOf("still going"), section("done"));
      await waitFor(() => expect(markThreads).toHaveBeenCalledWith(["th_works"], { section: { name: "done", whileState: "working:s_th_works" } }));
      drag(rowOf("read already"), section("pinned"));
      await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_idle"], { pinned: true }));
      drag(rowOf("kept on top"), section("working"));
      await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_pinned"], { pinned: false, section: { name: "working", whileState: "idle:s_th_pinned" } }));
      drag(rowOf("moved by hand"), section("working"));
      await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_moved"], { section: null }));
      const calls = markThreads.mock.calls.length;
      drag(rowOf("finished unseen"), section("done"));
      expect(markThreads.mock.calls).toHaveLength(calls);
      drag(rowOf("read already"), document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_idle"]));
    });

    it("while a tile is dragged every section stands as a place to drop it, even one holding nothing", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([all[1]!]) } as never));
      await waitFor(() => expect(heads()).toEqual(["working"]));
      fireEvent.dragStart(rowOf("still going"), { dataTransfer: { setData: () => {}, effectAllowed: "move" } });
      expect(heads()).toEqual(["pinned", "needs-you", "working", "done", "idle"]);
      fireEvent.dragEnd(rowOf("still going"));
      expect(heads()).toEqual(["working"]);
    });
  });

  it("orders the project switcher's rows as the person drags them, and keeps that order in the host's preferences", async () => {
    const { setPreferences } = mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp"), project("pr_3", "docs")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, projectOrder: ["pr_3"] } } as never));
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=project-switcher]")!);
    const options = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-switcher-option]")].map(o => o.dataset["switcherOption"] ?? "");
    expect(options()).toEqual(["all", "pr_3", "pr_1", "pr_2"]);
    const option = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-switcher-option=${id}]`)!;
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => void data.set(type, value), getData: (type: string) => data.get(type) ?? "", effectAllowed: "move", dropEffect: "move" };
    fireEvent.dragStart(option("pr_2"), { dataTransfer });
    fireEvent.dragOver(option("pr_3"), { dataTransfer });
    fireEvent.drop(option("pr_3"), { dataTransfer });
    await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ projectOrder: ["pr_2", "pr_3", "pr_1"] }));
  });
});
