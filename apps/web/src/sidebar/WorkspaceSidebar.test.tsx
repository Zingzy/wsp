// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Capabilities, type Checkout, type PlaceView, type ProjectView, type PullRequestFact, type PullRequestSeen, type WorkspaceLanding, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { THREAD_TREE_WORKING } from "../actions/format.js";
import { workspaceActions } from "../actions/workspaceActions.js";
import { clearNotices, lastNotice } from "../../test/notice-text.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import type { Api } from "../protocol/client.js";
import { provideDaemonWire } from "../files/wire.js";
import { useStore } from "../protocol/store.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../terminal/link.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { PROJECT_WORDS } from "./words.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";

// The triggers keep their elements and a popup mounts on a plain hover, with no positioning: Base UI's against
// jsdom's zero-size rects costs seconds per open. A tile's card is read this way.
vi.mock("../components/ui/tooltip.js", () => {
  const Open = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Tooltip = ({ children }: { children: ReactNode }) => {
    const [open, set] = useState(false);
    return <Open.Provider value={{ open, set }}>{children}</Open.Provider>;
  };
  const TooltipTrigger = ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => {
    const { set } = useContext(Open);
    return element === undefined ? <>{children}</> : cloneElement(element, { onMouseEnter: () => set(true), onMouseLeave: () => set(false) } as never, children ?? element.props.children);
  };
  const TooltipPopup = ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
    useContext(Open).open ? <div {...Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("data-")))}>{children}</div> : null;
  return { Tooltip, TooltipTrigger, TooltipPopup };
});

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
  kind: "cloud",
  machineId: "local",
  project: { id: projectId, name: projectId, path: `/Users/dev/${projectId}`, computer: "here" },
  phase: "running",
  golden: "",
  createdAt: "2026-09-17T01:00:00.000Z",
  worktree: { path: "/Users/dev/spoo-pricing-page", branch: "agent/pricing-page", made: true },
});

const SHARES = { copies: true, ownNetwork: false } as unknown as Capabilities;
const landing: WorkspaceLanding = { name: "here", capabilities: SHARES };
const MAC_ROW: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true };

function mount({ projects, workspaces }: { projects: ProjectView[]; workspaces: WorkspaceView[] }, extra: Record<string, unknown> = {}) {
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
    ...extra,
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

/** Every row the arrow keys walk, the section heads with the tiles. */
const walkIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(row => row.dataset["rowId"] ?? "");
/** The tiles and the Settled row in their order, leaving out the live sections' heads. */
const rowIds = (): string[] => walkIds().filter(id => !id.startsWith("section:"));
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const depthOf = (text: string): number => Number(rowOf(text).dataset["depth"]);
const HOUR = 60 * 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** Sessions for the store, one per thread, keyed by workspace, every time read off one clock reading so two rows
 * given the same age share it exactly. A turn that ended was shown as it ended unless `readAgo` says the last
 * showing was earlier. */
const sessions = (rows: Array<{ ws: string; id: string; prompt: string; parent?: string; status?: string; startedAgo?: number; endedAgo?: number; readAgo?: number; settledAgo?: number; asking?: string; pinnedAgo?: number; snoozed?: boolean; section?: { name: string; whileState: string } }>) => {
  const now = Date.now();
  const before = (ms: number): string => new Date(now - ms).toISOString();
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
      startedAt: before(r.startedAgo ?? HOUR),
      ...(r.endedAgo === undefined ? {} : { endedAt: before(r.endedAgo), readAt: before(r.readAgo ?? r.endedAgo) }),
      ...(r.settledAgo === undefined ? {} : { settledAt: before(r.settledAgo) }),
      ...(r.asking === undefined ? {} : { asking: r.asking }),
      ...(r.pinnedAgo === undefined ? {} : { pinnedAt: now - r.pinnedAgo }),
      ...(r.snoozed === true ? { snoozedUntil: now + HOUR } : {}),
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
    const here = (id: string, name: string, projectId: string): WorkspaceView => ({ ...workspace(id, name, projectId), kind: "local" });
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [here("ws_a", "pricing page", "pr_1"), here("ws_b", "webhook retries", "pr_2")] });
    await act(async () => {
      useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_old", prompt: "the older one", startedAgo: 3 * HOUR }, { ws: "ws_b", id: "th_new", prompt: "the newer one", startedAgo: HOUR }]) } as never);
    });
    await waitFor(() => expect(screen.getByText("the newer one")).toBeDefined());
    expect(rowIds()).toEqual(["thread:th_new", "thread:th_old"]);
    expect(document.querySelector("[data-row-id^=project\\:]")).toBeNull();
    expect(rowOf("the older one").querySelector("[data-tile-where]")!.textContent).toBe("pr_1 @ zingzy's MacBook Pro");
    expect(rowOf("the older one").textContent).not.toContain("agent/pricing-page");
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

  it("draws no tile for this computer's own folder while it holds no thread, and its thread's tile once one starts", async () => {
    const { worktree: _worktree, ...itself } = workspace("ws_a", "spoo", "pr_1");
    mount({ projects: [project("pr_1", "spoo")], workspaces: [{ ...itself, kind: "local" }] });
    await waitFor(() => screen.getByText(PROJECT_WORDS.noWorkspaces));
    expect(rowIds()).toEqual([]);
    await act(async () => {
      useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_first", prompt: "the first one", startedAgo: HOUR }]) } as never);
    });
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_first"]));
  });

  describe("a workspace's checkout, on the tile and on its card", () => {
    const { worktree: _worktree, ...bare } = workspace("ws_f", "cart rounding", "pr_1");
    const fork: WorkspaceView = { ...bare, kind: "cloud", machineId: "fk_1", golden: "snap_g", project: { ...bare.project, path: "/root/spoo" } };
    const statusOf = (w: WorkspaceView, checkout?: Checkout): WorkspaceStatus =>
      ({ ...w, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, ...(checkout !== undefined ? { checkout } : {}) }) as WorkspaceStatus;
    const tileOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row-id='ws:${id}']`)!;
    /** The card a tile opens once the pointer rests on it, as its lines by kind. */
    const card = async (id: string): Promise<Record<string, string[]>> => {
      fireEvent.pointerEnter(tileOf(id), { pointerType: "mouse" });
      fireEvent.mouseEnter(tileOf(id));
      fireEvent.mouseMove(tileOf(id));
      const open = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-tile-card]");
        expect(found).not.toBeNull();
        return found!;
      });
      const lines: Record<string, string[]> = {};
      for (const line of open.querySelectorAll<HTMLElement>("[data-tile-card-line]")) (lines[line.dataset["tileCardLine"]!] ??= []).push(line.textContent ?? "");
      fireEvent.pointerLeave(tileOf(id), { pointerType: "mouse" });
      fireEvent.mouseLeave(tileOf(id));
      return lines;
    };
    const fact: Checkout = { branch: "fix/cart-rounding", ahead: 1, behind: 4, changed: 3, head: "0123456789abcdef0123456789abcdef01234567", readAt: 1 };

    it("draws two rows and nothing of the checkout on the tile; its card says the branch and what changed", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      act(() => useStore.setState({ statuses: { ws_f: statusOf(fork, fact) } } as never));
      expect(tileOf("ws_f").children).toHaveLength(2);
      expect(tileOf("ws_f").textContent).not.toMatch(/fix\/cart-rounding|ahead|behind|changed|0123456/);
      await waitFor(async () => expect(await card("ws_f")).toMatchObject({ branch: ["fix/cart-rounding"], changed: ["3 changed"] }));
    });

    it("says on the card that an editor is attached while one is connected over ssh", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      act(() => useStore.setState({ statuses: { ws_f: statusOf(fork, fact) } } as never));
      const editor = { workspaceId: "ws_f", port: 51022, startedAt: "2026-09-29T10:00:00Z", name: "cart rounding", kind: "editor" as const };
      act(() => useStore.setState({ forwards: [editor, { ...editor, workspaceId: "ws_other" }] } as never));
      // Nor is it a port of the forwarded list: nothing but wsp ssh dials it.
      expect(rowIds()).toEqual(["ws:ws_f"]);
      expect((await card("ws_f"))["note"]).toEqual([EDITOR_SSH_WORDS.attached]);
    });

    it("never says a commit for a head on no branch, on the tile or on the card", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      act(() => useStore.setState({ statuses: { ws_f: statusOf(fork, { ...fact, branch: "(detached)" }) } } as never));
      const lines = await card("ws_f");
      expect(lines["branch"]).toBeUndefined();
      expect(JSON.stringify(lines)).not.toMatch(/0123456|detached/);
      expect(tileOf("ws_f").textContent).not.toMatch(/0123456|detached/);
    });

    const pr = (over: Partial<PullRequestFact> = {}): PullRequestFact => ({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      state: "open",
      host: "github.com",
      draft: false,
      base: "main",
      branch: "fix/cart-rounding",
      headOid: "abc1234",
      headSubject: "Round once",
      mergeable: "mergeable",
      mergeState: "clean",
      review: "none",
      checks: [],
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      commits: 1,
      readAt: 1,
      ...over,
    });
    const withPr = (seen: PullRequestSeen): WorkspaceStatus => ({ ...statusOf(fork, fact), pr: seen }) as WorkspaceStatus;

    it("ends row two in the open pull request's icon alone, no number and no colour, and says its number and state on the card", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      const icon = (): Element | null => tileOf("ws_f").children[1]!.querySelector("[data-tile-pr]");
      act(() => useStore.setState({ statuses: { ws_f: withPr(pr({ checks: [{ name: "ci", state: "fail" }] })) } } as never));
      await waitFor(() => expect(icon()).not.toBeNull());
      expect(tileOf("ws_f").textContent).not.toMatch(/#12|checks failed|open/);
      expect(icon()!.getAttribute("class")).not.toMatch(/text-pr-/);
      expect((await card("ws_f"))["pr"]).toEqual(["Pull request #12, open"]);
      act(() => useStore.setState({ statuses: { ws_f: withPr(pr({ state: "merged" })) } } as never));
      await waitFor(() => expect(icon()).toBeNull());
      act(() => useStore.setState({ statuses: { ws_f: withPr({ number: 12, url: "https://github.com/o/r/pull/12", state: "closed", base: "main", closedAt: 1, readAt: 1 }) } } as never));
      await waitFor(() => expect(icon()).toBeNull());
    });

    it("draws no icon where the pull request could not be read, and keeps the reason on the card", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork] });
      await waitFor(() => expect(rowIds()).toEqual(["ws:ws_f"]));
      const why = "no signed-in command line for github.com is on this computer and cart rounding is stopped, so the pull request is not read";
      act(() => useStore.setState({ statuses: { ws_f: withPr({ why, readAt: 1 }) } } as never));
      await waitFor(async () => expect((await card("ws_f"))["note"]).toContain(why));
      expect(tileOf("ws_f").querySelector("[data-tile-pr]")).toBeNull();
    });

    it("asks the host for each workspace's fact once as the sidebar mounts, and reads no daemon of its own", async () => {
      const asked: string[] = [];
      mount({ projects: [project("pr_1", "spoo")], workspaces: [fork, workspace("ws_a", "pricing page", "pr_1")] }, { workspaceCheckout: async (id: string) => (asked.push(id), {}) });
      await waitFor(() => expect(asked.sort()).toEqual(["ws_a", "ws_f"]));
      act(() => useStore.setState({ statuses: { ws_f: statusOf(fork, fact) } } as never));
      expect(asked).toHaveLength(2);
    });

    it("says a copy's branch off its record on the card until the host has read one, and every tile keeps its height", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), fork] });
      await waitFor(() => expect(rowIds().sort()).toEqual(["ws:ws_a", "ws:ws_f"]));
      expect((await card("ws_a"))["branch"]).toEqual(["agent/pricing-page"]);
      for (const id of ["ws_a", "ws_f"]) {
        expect(tileOf(id).children, id).toHaveLength(2);
        expect(tileOf(id).className, id).toContain("h-[52px]");
      }
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

  it("folds every read root quiet two hours into Settled at the foot: 'Settled (2)' in muted sans, a hairline and a chevron, 12 px under the list, opened by its chevron and remembered", async () => {
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
    expect(fold.className).toContain("h-7");
    expect(fold.className).not.toContain("hover:bg-");
    expect(fold.closest("li")!.className).toContain("mt-3");
    expect(fold.textContent).toBe("Settled (2)");
    expect(fold.querySelector("[data-group-word]")!.className).not.toMatch(/uppercase|font-mono|tracking/);
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("(2)");
    expect(fold.querySelector("[data-section-rule]")!.className).toContain("flex-1");
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_live", "settled", "thread:th_quiet", "thread:th_quiet_child"]));
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("(2)");
    expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual([]);
    expect(window.localStorage.getItem("wsp:sidebar-settled-open")).toBeNull();
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_live", "settled"]));
    expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual(["settled"]);
  });

  it("folds Setting up by its head and remembers it in the window, as every other head is", async () => {
    const box = { id: "p_studio", kind: "computer", name: "studio", default: false, present: true, setup: { state: "running", addId: "a_1", startedAt: "2026-10-03T10:00:00.000Z", steps: [{ step: "floor", state: "running" }], waiting: [] } } as PlaceView;
    const settingUp = { placesList: async () => ({ places: [MAC_ROW, box], adds: [] }) };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] }, settingUp);
    await act(async () => useStore.setState({ places: [MAC_ROW, box] }));
    const head = (): HTMLElement => document.querySelector<HTMLElement>("[data-row-id='section:setting-up']")!;
    await waitFor(() => expect(document.querySelector("[data-setup-card='p_studio']")).not.toBeNull());
    fireEvent.click(head());
    await waitFor(() => expect(document.querySelector("[data-setup-card='p_studio']")).toBeNull());
    expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual(["settled", "setting-up"]);
    cleanup();
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] }, settingUp);
    await act(async () => useStore.setState({ places: [MAC_ROW, box] }));
    await waitFor(() => expect(head().getAttribute("aria-expanded")).toBe("false"));
    expect(document.querySelector("[data-setup-card='p_studio']")).toBeNull();
  });

  it("pins Setting up to the sidebar's foot above the corner's icons, out of the list that scrolls, and drops it once no setup runs", async () => {
    const setup = { state: "running", addId: "a_1", startedAt: "2026-10-03T10:00:00.000Z", steps: [{ step: "floor", state: "running" }], waiting: [] };
    const box = { id: "p_studio", kind: "computer", name: "studio", default: false, present: true, setup } as PlaceView;
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] }, { placesList: async () => ({ places: [MAC_ROW, box], adds: [] }) });
    await act(async () => useStore.setState({ places: [MAC_ROW, box] }));
    await waitFor(() => expect(document.querySelector("[data-setup-card='p_studio']")).not.toBeNull());
    const card = document.querySelector("[data-setup-card='p_studio']")!;
    const foot = document.querySelector("[data-slot=sidebar-footer]")!;
    expect(foot.contains(card)).toBe(true);
    expect(document.querySelector("[data-sidebar-tree]")!.contains(card)).toBe(false);
    const corner = foot.querySelector("[data-sidebar-corner]")!;
    expect(card.compareDocumentPosition(corner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => useStore.setState({ places: [MAC_ROW, { ...box, setup: { ...setup, state: "done", steps: [{ step: "floor", state: "done" }] } } as PlaceView] }));
    await waitFor(() => expect(document.querySelector("[data-section='setting-up']")).toBeNull());
    expect(foot.querySelector("[data-sidebar-corner]")).not.toBeNull();
  });

  it("a fold list saved before the sidebar lost a section is read without its old ids, and Settled folds and opens on a click", async () => {
    window.localStorage.setItem("wsp:sidebar-folded", JSON.stringify(["needs-you", "idle", "done"]));
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => {
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_live", prompt: "still going" },
          { ws: "ws_a", id: "th_quiet", prompt: "finished yesterday", status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR },
        ]),
      } as never);
    });
    await waitFor(() => expect(screen.getByText("still going")).toBeDefined());
    const fold = (): HTMLElement => document.querySelector<HTMLElement>("[data-row-id=settled]")!;
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold());
    await waitFor(() => expect(rowIds()).not.toContain("thread:th_quiet"));
    expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual(["needs-you", "settled"]);
    fireEvent.click(fold());
    await waitFor(() => expect(rowIds()).toContain("thread:th_quiet"));
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
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("(0)");
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

  it("Delete copies on the Settled row and on a settled tile names what each copy holds that its remote lacks before anything goes", async () => {
    const deleteWorkspace = vi.fn(async (_id: string) => {});
    const read = { branch: "fix/cart", ahead: 0, behind: 0, changed: 0, readAt: 1 };
    const workspaceCheckout = vi.fn(async (id: string) => ({ checkout: id === "ws_a" ? { ...read, ahead: 3, changed: 2 } : read }));
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "cart", "pr_1"), workspace("ws_b", "tidy", "pr_1")] }, { deleteWorkspace, workspaceCheckout });
    const quiet = { status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR, readAgo: 28 * HOUR, settledAgo: HOUR };
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_a", prompt: "round the cart", ...quiet }, { ws: "ws_b", id: "th_b", prompt: "tidy up", ...quiet }]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    const choose = (id: string) => (window.wsp = { contextMenu: async () => id } as never);
    try {
      choose("delete-copies");
      fireEvent.contextMenu(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      const dialog = await screen.findByRole("alertdialog");
      await waitFor(() => expect(dialog.textContent).toContain("cart holds 3 commits not pushed and 2 uncommitted files"));
      expect(dialog.textContent).toContain("Delete 2 copies?");
      expect(dialog.textContent).not.toContain("tidy holds");
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(deleteWorkspace.mock.calls.map(([id]) => id).sort()).toEqual(["ws_a", "ws_b"]));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      fireEvent.click(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      await waitFor(() => expect(rowIds()).toContain("thread:th_a"));
      choose("delete-copies");
      fireEvent.contextMenu(document.querySelector<HTMLElement>("[data-row-id='thread:th_a']")!);
      const one = await screen.findByRole("alertdialog");
      await waitFor(() => expect(one.textContent).toContain("cart holds 3 commits not pushed and 2 uncommitted files"));
      expect(one.textContent).toContain("Delete cart?");
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });

  it("holds Delete until every copy's fresh read has answered, and says a read that failed rather than trusting what was held", async () => {
    const deleteWorkspace = vi.fn(async (_id: string) => {});
    let answer: (reply: { checkout?: never }) => void = () => {};
    const workspaceCheckout = vi.fn(() => new Promise<{ checkout?: never }>((_resolve, reject) => (answer = () => reject(new Error("the copy's daemon did not answer")))));
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "cart", "pr_1")] }, { deleteWorkspace, workspaceCheckout });
    const clean = { branch: "fix/cart", ahead: 0, behind: 0, changed: 0, readAt: 1 };
    const quiet = { status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR, readAgo: 28 * HOUR, settledAgo: HOUR };
    const held = { ...workspace("ws_a", "cart", "pr_1"), machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, checkout: clean } as WorkspaceStatus;
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_a", prompt: "round the cart", ...quiet }]), statuses: { ws_a: held } } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    window.wsp = { contextMenu: async () => "delete-copies" } as never;
    try {
      fireEvent.contextMenu(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      const dialog = await screen.findByRole("alertdialog");
      const remove = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
      expect(remove.disabled).toBe(true);
      fireEvent.click(remove);
      expect(deleteWorkspace).not.toHaveBeenCalled();
      act(() => answer({}));
      await waitFor(() => expect(dialog.textContent).toContain("cart: could not read what is not pushed"));
      expect(remove.disabled).toBe(false);
      fireEvent.click(remove);
      await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith("ws_a"));
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });

  it("draws a settled thread as one slim row: its title and its age, never Merged in its slot and no mark for a merged pull request", async () => {
    const ws = workspace("ws_a", "pricing page", "pr_1");
    mount({ projects: [project("pr_1", "spoo")], workspaces: [ws] });
    const done = { ws: "ws_a", id: "th_done", prompt: "shipped it", status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR, readAgo: 28 * HOUR, settledAgo: HOUR };
    await act(async () => useStore.setState({ sessions: sessions([done]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    fireEvent.click(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
    await waitFor(() => expect(rowIds()).toEqual(["settled", "thread:th_done"]));
    const row = (): HTMLElement => document.querySelector<HTMLElement>("[data-row-id='thread:th_done']")!;
    expect(row().dataset["slim"]).toBe("true");
    expect(row().querySelector("[data-thread-title]")!.textContent).toBe("shipped it");
    expect(row().querySelector("[data-thread-status]")!.textContent).toBe("1d");
    expect(row().querySelector("[data-tile-where]")).toBeNull();
    const kept = { number: 12, url: "https://github.com/o/r/pull/12", state: "merged" as const, base: "main", mergedAt: 1, readAt: 1 };
    const status = { ...ws, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, pr: kept } as WorkspaceStatus;
    act(() => useStore.setState({ statuses: { ws_a: status } } as never));
    await new Promise(r => setTimeout(r, 20));
    expect(row().querySelector("[data-tile-pr]")).toBeNull();
    expect(row().textContent).not.toContain("#12");
    expect(row().querySelector("[data-thread-status]")!.textContent).toBe("1d");
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

  it("leaves a settled thread in Settled when it is opened, so nothing moves under the reader", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_long", prompt: "a long read", status: "completed", startedAgo: 5 * HOUR, endedAgo: 4 * HOUR }]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    act(() => useStore.getState().select("ws_a", "th_long"));
    await act(() => new Promise(r => setTimeout(r, 0)));
    expect(rowIds()).toEqual(["settled"]);
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

  it("ends in the corner row alone: no computer picker at the foot, even in the desktop shell where the menu bar holds the hosts", async () => {
    (window as unknown as { wsp?: unknown }).wsp = { hosts: async () => ({ here: "This Mac", current: null, hosts: [] }), contextMenu: async () => null };
    try {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await waitFor(() => expect(document.querySelector("[data-sidebar-corner]")).not.toBeNull());
      await act(async () => {});
      expect(document.querySelector("[data-host-foot]")).toBeNull();
      expect(screen.queryByText("This Mac")).toBeNull();
      expect(document.querySelector("[data-slot=sidebar-footer] svg.lucide-chevrons-up-down")).toBeNull();
      expect(screen.getByRole("button", { name: "Settings" }).closest("[data-slot=sidebar-footer]")).not.toBeNull();
    } finally {
      delete (window as unknown as { wsp?: unknown }).wsp;
    }
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

    it("draws Pinned and Needs you under their heads, then one bare list newest first whose rows say their time or Done, and leaves a snoozed tree out", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(all) } as never));
      await waitFor(() => expect(screen.getByText("kept on top")).toBeDefined());
      expect(heads()).toEqual(["pinned", "needs-you"]);
      // Every head names its section in words, Needs you as Pinned and Settled do; the state glyph is the tiles' alone.
      expect([...document.querySelectorAll("[data-section-head]")].map(head => head.textContent)).toEqual(["Pinned (1)", "Needs you (1)"]);
      expect(document.querySelector("[data-section-head=needs-you] svg.lucide-message-circle-question")).toBeNull();
      expect(rowIds()).toEqual(["thread:th_pinned", "thread:th_asks", "thread:th_works", "thread:th_done", "thread:th_idle", "settled"]);
      expect(walkIds()).toEqual(["section:pinned", "thread:th_pinned", "section:needs-you", "thread:th_asks", "thread:th_works", "thread:th_done", "thread:th_idle", "settled"]);
      expect(screen.queryByText("snoozed away")).toBeNull();
      const slot = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>("[data-thread-status]")!;
      // A working row's word is for a screen reader; the time ticking is what it shows.
      expect(slot("still going").querySelector(".sr-only")?.textContent).toBe("Working");
      expect(slot("still going").textContent).toBe("Working6m");
      expect(slot("finished unseen").textContent).toBe("Done");
      expect(slot("read already").textContent).toBe("11m");
    });

    it("keeps the rows that call for the person bright and lets working and read rows recede, as T3 Code's shouldRecede", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(all) } as never));
      await waitFor(() => expect(screen.getByText("kept on top")).toBeDefined());
      const ink = (title: string): string => rowOf(title).querySelector<HTMLElement>("[data-thread-title]")!.className.includes("text-sidebar-muted-foreground") ? "recedes" : "bright";
      expect(["wants an answer", "still going", "finished unseen", "read already"].map(ink)).toEqual(["bright", "recedes", "bright", "recedes"]);
      // The label keeps its hue while the row recedes.
      expect(rowOf("still going").querySelector<HTMLElement>("[data-thread-status]")!.dataset["tone"]).toBe("working");
    });

    it("folds each headed section by its head, one at a time, and remembers the fold per section; the bare list never folds", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(all) } as never));
      await waitFor(() => expect(screen.getByText("kept on top")).toBeDefined());
      const head = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-section-head=${id}]`)!;
      for (const id of ["pinned", "needs-you", "settled"]) {
        const at = id === "settled" ? document.querySelector<HTMLElement>("[data-row-id=settled]")! : head(id);
        expect(at.tagName, id).toBe("BUTTON");
        expect(at.className, id).toContain("h-7");
        expect(at.querySelector("[data-section-rule]"), id).not.toBeNull();
        expect(at.querySelector("svg.lucide-chevron-down"), id).not.toBeNull();
      }
      expect(head("threads")).toBeNull();
      expect(head("needs-you").getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(head("needs-you"));
      await waitFor(() => expect(screen.queryByText("wants an answer")).toBeNull());
      expect(head("needs-you").getAttribute("aria-expanded")).toBe("false");
      expect(head("needs-you").textContent).toBe("Needs you (1)");
      expect(screen.getByText("still going")).toBeDefined();
      expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual(["settled", "needs-you"]);
      fireEvent.click(head("pinned"));
      await waitFor(() => expect(screen.queryByText("kept on top")).toBeNull());
      expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual(["settled", "needs-you", "pinned"]);
      cleanup();
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(all) } as never));
      await waitFor(() => expect(screen.getByText("still going")).toBeDefined());
      expect(screen.queryByText("kept on top")).toBeNull();
      expect(screen.queryByText("wants an answer")).toBeNull();
      fireEvent.click(head("needs-you"));
      await waitFor(() => expect(screen.getByText("wants an answer")).toBeDefined());
      expect(JSON.parse(window.localStorage.getItem("wsp:sidebar-folded") ?? "null")).toEqual(["settled", "pinned"]);
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
      await act(async () => useStore.setState({ sessions: sessions([...all, { ws: "ws_a", id: "th_moved", prompt: "moved by hand", startedAgo: 7 * 60_000, section: { name: "needs-you", whileState: "working:s_th_moved" } }]) } as never));
      await waitFor(() => expect(screen.getByText("still going")).toBeDefined());
      expect(document.querySelector("[data-section=needs-you]")!.textContent).toContain("moved by hand");
      const section = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-section=${id}]`)!;
      drag(rowOf("still going"), section("needs-you"));
      await waitFor(() => expect(markThreads).toHaveBeenCalledWith(["th_works"], { section: { name: "needs-you", whileState: "working:s_th_works" } }));
      drag(rowOf("read already"), section("pinned"));
      await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_idle"], { pinned: true }));
      drag(rowOf("kept on top"), section("threads"));
      await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_pinned"], { pinned: false, section: null }));
      drag(rowOf("moved by hand"), section("threads"));
      await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["th_moved"], { section: null }));
      const calls = markThreads.mock.calls.length;
      drag(rowOf("finished unseen"), section("threads"));
      expect(markThreads.mock.calls).toHaveLength(calls);
      drag(rowOf("read already"), document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_idle"]));
    });

    it("a tree with a thread still working dropped on Settled settles nothing and says why in the menu's own sentence", async () => {
      const { settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () =>
        useStore.setState({ sessions: sessions([...all, { ws: "ws_a", id: "th_builder", prompt: "its builder", parent: "th_idle", startedAgo: 10 * 60_000 }]) } as never),
      );
      await waitFor(() => expect(screen.getByText("its builder")).toBeDefined());
      clearNotices();
      drag(rowOf("read already"), document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      await waitFor(() => expect(lastNotice()).toBe(THREAD_TREE_WORKING));
      expect(settleThreads).not.toHaveBeenCalled();
    });

    it("while a tile is dragged every section stands as a place to drop it, even one holding nothing", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([all[1]!]) } as never));
      const places = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-section]")].map(section => section.dataset["section"] ?? "");
      await waitFor(() => expect(places()).toEqual(["threads"]));
      expect(heads()).toEqual([]);
      fireEvent.dragStart(rowOf("still going"), { dataTransfer: { setData: () => {}, effectAllowed: "move" } });
      expect(places()).toEqual(["pinned", "needs-you", "threads"]);
      expect(heads()).toEqual(["pinned", "needs-you"]);
      fireEvent.dragEnd(rowOf("still going"));
      expect(places()).toEqual(["threads"]);
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
