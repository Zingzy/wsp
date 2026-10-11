// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Capabilities, type Checkout, type PlaceView, type ProjectView, type PullRequestFact, type PullRequestSeen, type WorkspaceLanding, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { THREAD_TREE_WORKING } from "../actions/format.js";
import { workspaceActions } from "../actions/workspaceActions.js";
import { clearNotices, lastNotice } from "../../test/notice-text.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import type { Api } from "../protocol/client.js";
import { provideDaemonWire } from "../files/wire.js";
import { useNotices } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../terminal/link.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { askCheckout } from "./tileCheckout.js";
import { PROJECT_WORDS } from "./words.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import { pointerLeave } from "../../test/pointer.js";

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
const sessions = (rows: Array<{ ws: string; id: string; prompt: string; parent?: string; status?: string; startedAgo?: number; endedAgo?: number; readAgo?: number; settledAgo?: number; asking?: string; pinnedAgo?: number; orderAt?: number; attempt?: string; snoozed?: boolean; section?: { name: string; whileState: string }; foldedAgo?: number; subagents?: unknown[]; replaces?: string; replacedBy?: string }>) => {
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
      ...(r.orderAt === undefined ? {} : { order: r.orderAt }),
      ...(r.attempt === undefined ? {} : { attempt: r.attempt }),
      ...(r.snoozed === true ? { snoozedUntil: now + HOUR } : {}),
      ...(r.section === undefined ? {} : { section: r.section }),
      ...(r.foldedAgo === undefined ? {} : { foldedAt: now - r.foldedAgo }),
      ...(r.subagents === undefined ? {} : { subagents: r.subagents }),
      ...(r.replaces === undefined ? {} : { replaces: r.replaces }),
      ...(r.replacedBy === undefined ? {} : { replacedBy: r.replacedBy }),
    });
  }
  return by;
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useStore.setState({ api: null, projects: [], workspaces: [], landings: {}, heldKeys: {} } as never);
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

    /** A lead on ws_lead and its fork ws_kid, the lead's status carrying its tree as the host pushes it. */
    const forked = async (child: Record<string, unknown>, kid: Record<string, unknown> = {}) => {
      const lead = workspace("ws_lead", "coordinator", "pr_1");
      const copy: WorkspaceView = { ...workspace("ws_kid", "cart rounding", "pr_1"), parentWorkspaceId: "ws_lead" };
      const tree = { leadBranch: "main", children: [{ workspaceId: "ws_kid", branch: "fix/cart-rounding", pushed: true, aheadOfLead: 2, ...child }], readAt: 1 };
      mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, copy] });
      await act(async () =>
        useStore.setState({
          sessions: sessions([{ ws: "ws_lead", id: "lead", prompt: "run the marathon" }, { ws: "ws_kid", id: "kid", prompt: "round the cart", parent: "lead", ...kid }]),
          statuses: { ws_lead: { ...statusOf(lead), tree }, ws_kid: statusOf(copy, { ...fact, branch: String(child["branch"] ?? "fix/cart-rounding") }) },
        } as never),
      );
    };
    /** The branch lines on the card of the tile whose row id is given. */
    const branchLines = (rowId: string): string[] => {
      const tile = document.querySelector<HTMLElement>(`[data-row-id='${rowId}']`)!;
      fireEvent.mouseEnter(tile);
      const lines = [...document.querySelectorAll<HTMLElement>("[data-tile-card] [data-tile-card-line=branch]")].map(line => line.textContent ?? "");
      fireEvent.mouseLeave(tile);
      return lines;
    };

    it("says a fork's own branch and its one fact on its thread's card, and neither on its tile", async () => {
      await forked({ pushRefused: "this computer has no git credential for github.com; sign gh in on it" });
      const tile = await waitFor(() => rowOf("round the cart"));
      expect(tile.textContent).not.toMatch(/fix\/cart-rounding|ahead|push/);
      fireEvent.mouseEnter(tile);
      const card = document.querySelector<HTMLElement>("[data-tile-card]")!;
      expect([...card.querySelectorAll("[data-tile-card-line=branch]")].map(line => line.textContent)).toEqual(["fix/cart-rounding, 2 ahead of main"]);
      expect(card.querySelector("[data-tile-card-line=branch] svg.lucide-git-branch")).not.toBeNull();
      // The fact line is the whole of it: no push sentence and no steps ride the card.
      expect(card.textContent).not.toMatch(/credential|sign gh|this computer/);
    });

    it("names no branch on the card of a fork on its lead's own branch", async () => {
      await forked({ branch: "main", pushed: false, aheadOfLead: undefined });
      await waitFor(() => rowOf("round the cart"));
      expect(branchLines("thread:kid")).toEqual([]);
    });

    it("says the same branch line on a fork's tile in Needs you as on its tile under its lead", async () => {
      await forked({}, { asking: "Bash: pnpm install" });
      await waitFor(() => expect(document.querySelector("[data-row-id='inbox:thread:kid']")).not.toBeNull());
      expect(branchLines("inbox:thread:kid")).toEqual(["fix/cart-rounding, 2 ahead of main"]);
      expect(branchLines("thread:kid")).toEqual(["fix/cart-rounding, 2 ahead of main"]);
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

    it("asks only for a workspace whose tile is in view, and nothing when the sidebar is drawn again", async () => {
      const inView = new Set(["ws_f"]);
      const watching = new Set<{ fn: IntersectionObserverCallback; targets: Set<Element> }>();
      class SomeInView {
        private readonly me: { fn: IntersectionObserverCallback; targets: Set<Element> };
        constructor(fn: IntersectionObserverCallback) {
          this.me = { fn, targets: new Set() };
          watching.add(this.me);
        }
        observe(target: Element): void {
          this.me.targets.add(target);
          const id = target.closest("[data-workspace-id]")?.getAttribute("data-workspace-id") ?? "";
          queueMicrotask(() => this.me.fn([{ target, isIntersecting: inView.has(id) } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
        }
        unobserve(target: Element): void {
          this.me.targets.delete(target);
        }
        disconnect(): void {
          watching.delete(this.me);
        }
      }
      Object.assign(globalThis, { IntersectionObserver: SomeInView });
      try {
        const asked: string[] = [];
        const both = { projects: [project("pr_1", "spoo")], workspaces: [fork, workspace("ws_a", "pricing page", "pr_1")] };
        mount(both, { workspaceCheckout: async (id: string) => (asked.push(id), { checkout: fact }) });
        await waitFor(() => expect(rowIds().sort()).toEqual(["ws:ws_a", "ws:ws_f"]));
        await waitFor(() => expect(asked).toEqual(["ws_f"]));
        const api = useStore.getState().api;
        cleanup();
        render(
          <SidebarProvider defaultOpen>
            <WorkspaceSidebar />
          </SidebarProvider>,
        );
        await waitFor(() => expect(rowIds().sort()).toEqual(["ws:ws_a", "ws:ws_f"]));
        await act(async () => await new Promise(r => setTimeout(r, 20)));
        expect(useStore.getState().api).toBe(api);
        expect(asked).toEqual(["ws_f"]);
        inView.add("ws_a");
        for (const { fn, targets } of watching) for (const target of targets) act(() => fn([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
        await waitFor(() => expect(asked).toEqual(["ws_f", "ws_a"]));
      } finally {
        Reflect.deleteProperty(globalThis, "IntersectionObserver");
      }
    });

    it("asks again for a workspace whose reply held no checkout, and never again for one whose reply held one", async () => {
      const asked: string[] = [];
      const api = { workspaceCheckout: async (id: string) => (asked.push(id), id === "ws_stopped" ? {} : { checkout: fact }) } as unknown as Api;
      const settle = () => act(async () => await new Promise(r => setTimeout(r, 0)));
      askCheckout(api, "ws_stopped");
      askCheckout(api, "ws_read");
      await settle();
      askCheckout(api, "ws_stopped");
      askCheckout(api, "ws_read");
      await settle();
      expect(asked).toEqual(["ws_stopped", "ws_read", "ws_stopped"]);
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
    expect(rowOf("write the migration").closest("li")!.className).toContain("before:border-[var(--sidebar-rail)]");
    expect(rowOf("write the migration").closest("li")!.className).toContain("after:rounded-bl-sm");
    expect(rowOf("write the migration").closest("ul")!.className).toContain("ml-3.25");
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
    expect(slot().getAttribute("aria-label")).toBe("Done");
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
    const live = [
      { ws: "ws_a", id: "th_lead", prompt: "the lead", status: "completed", startedAgo: 20 * 60_000, endedAgo: 10 * 60_000 },
      { ws: "ws_a", id: "th_builder", prompt: "its builder", parent: "th_lead", status: "completed", startedAgo: 15 * 60_000, endedAgo: 12 * 60_000 },
      { ws: "ws_a", id: "th_unseen", prompt: "nobody looked", status: "completed", startedAgo: 9 * 60_000, endedAgo: 8 * 60_000, readAgo: HOUR },
    ];
    await act(async () => {
      useStore.setState({ sessions: sessions(live) } as never);
    });
    await waitFor(() => expect(screen.getByText("the lead")).toBeDefined());
    // Nothing has settled yet: no Settled row, though a read tree could settle.
    expect(document.querySelector("[data-row-id=settled]")).toBeNull();
    await act(async () => {
      useStore.setState({ sessions: sessions([...live, { ws: "ws_a", id: "th_old", prompt: "settled last week", status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR, readAgo: 28 * HOUR, settledAgo: HOUR }]) } as never);
    });
    await waitFor(() => expect(document.querySelector("[data-row-id=settled]")).not.toBeNull());
    const fold = document.querySelector<HTMLElement>("[data-row-id=settled]")!;
    expect(fold.querySelector("[data-group-count]")!.textContent).toBe("(1)");
    const picked: string[][] = [];
    const choose = (id: string) => (window.wsp = { contextMenu: async (items: Array<{ id: string; enabled?: boolean }>) => (picked.push(items.map(item => item.id)), id) } as never);
    try {
      useNotices.getState().clear();
      // The host's answer is said: what it left, beside what it settled.
      settleThreads.mockResolvedValueOnce({ settled: [{ threadId: "th_lead", title: "the lead" }], left: [{ threadId: "th_builder", why: "still working: stop it first" }] } as never);
      choose("settle");
      fireEvent.contextMenu(rowOf("the lead"));
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_lead"]));
      await waitFor(() => expect(useNotices.getState().notices[0]).toMatchObject({ kind: "done", text: "Settled 1 thread. Left 1 thread: still working: stop it first" }));
      expect(picked[0]).toContain("settle");
      // A finished thread under a root stands behind the lead's Finished fold, and settles alone from its own menu.
      expect(picked[0]).toContain("settle-finished");
      fireEvent.click(document.querySelector<HTMLElement>("[data-child-fold=finished]")!);
      settleThreads.mockClear();
      fireEvent.contextMenu(await waitFor(() => rowOf("its builder")));
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_builder"]));
      expect(picked[1]).toContain("settle");
      settleThreads.mockClear();
      choose("settle-read");
      fireEvent.contextMenu(fold);
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_lead"]));
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });

  it("a restarted child's tile menu opens the thread it replaced, and the replaced child's opens its restart", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => {
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_lead", prompt: "the lead", startedAgo: 30 * 60_000 },
          { ws: "ws_a", id: "th_old", prompt: "security fixes", parent: "th_lead", status: "interrupted", startedAgo: 20 * 60_000, endedAgo: 8 * 60_000, replacedBy: "th_new" },
          { ws: "ws_a", id: "th_new", prompt: "security fixes again", parent: "th_lead", startedAgo: 7 * 60_000, replaces: "th_old" },
        ]),
      } as never);
    });
    await waitFor(() => expect(screen.getByText("security fixes again")).toBeDefined());
    const picked: string[][] = [];
    window.wsp = { contextMenu: async (items: Array<{ id: string }>) => (picked.push(items.map(item => item.id)), "open-replaced") } as never;
    try {
      fireEvent.contextMenu(rowOf("security fixes again"));
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("th_old"));
      expect(picked[0]).toContain("open-replaced");
      expect(picked[0]).not.toContain("open-restart");
      window.wsp = { contextMenu: async (items: Array<{ id: string }>) => (picked.push(items.map(item => item.id)), "open-restart") } as never;
      fireEvent.click(document.querySelector<HTMLElement>("[data-child-fold=finished]")!);
      fireEvent.contextMenu(await waitFor(() => rowOf("security fixes")));
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("th_new"));
      expect(picked[1]).toContain("open-restart");
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });

  it("the list's own menu holds Settle all read, so it is there with nothing settled and read trees to settle", async () => {
    const { settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => {
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_read", prompt: "read already", status: "completed", startedAgo: 20 * 60_000, endedAgo: 10 * 60_000 },
          { ws: "ws_a", id: "th_unseen", prompt: "nobody looked", status: "completed", startedAgo: 9 * 60_000, endedAgo: 8 * 60_000, readAgo: HOUR },
        ]),
      } as never);
    });
    await waitFor(() => expect(screen.getByText("read already")).toBeDefined());
    expect(rowIds()).toEqual(expect.arrayContaining(["thread:th_read", "thread:th_unseen"]));
    expect(rowIds().filter(id => id.startsWith("thread:"))).toHaveLength(2);
    const picked: string[][] = [];
    window.wsp = { contextMenu: async (items: Array<{ id: string }>) => (picked.push(items.map(item => item.id)), "settle-read") } as never;
    try {
      fireEvent.contextMenu(document.querySelector<HTMLElement>("[data-sidebar-tree]")!);
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_read"]));
      expect(picked).toEqual([["settle-read"]]);
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
    await waitFor(() => expect(rowIds()).toEqual(["thread:th_broke"]));
    expect(rowOf("it broke").querySelector("[data-thread-status]")!.getAttribute("aria-label")).toBe("Failed");
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
    const heads = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-section-head]")].filter(head => head.closest("[data-drop-only]") === null).map(head => head.dataset["sectionHead"] ?? "");
    /** `onto` as a function is found once the drag has started, for a place that stands only while a tile is dragged. */
    const drag = (tile: HTMLElement, onto: HTMLElement | (() => HTMLElement)): void => {
      const data = new Map<string, string>();
      const dataTransfer = { setData: (type: string, value: string) => void data.set(type, value), getData: (type: string) => data.get(type) ?? "", types: ["text/plain"], effectAllowed: "move", dropEffect: "move" };
      fireEvent.dragStart(tile, { dataTransfer });
      const place = typeof onto === "function" ? onto() : onto;
      fireEvent.dragOver(place, { dataTransfer });
      fireEvent.drop(place, { dataTransfer });
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
      expect(rowIds()).toEqual(["thread:th_pinned", "thread:th_asks", "thread:th_works", "thread:th_done", "thread:th_idle"]);
      expect(walkIds()).toEqual(["section:pinned", "thread:th_pinned", "section:needs-you", "thread:th_asks", "thread:th_works", "thread:th_done", "thread:th_idle"]);
      expect(screen.queryByText("snoozed away")).toBeNull();
      const slot = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>("[data-thread-status]")!;
      // Every state is its icon alone, its word on the label: the crab while it works.
      expect(slot("still going").getAttribute("aria-label")).toBe("Working");
      expect(slot("still going").querySelector("canvas[data-crab]")).not.toBeNull();
      expect(slot("still going").textContent).toBe("");
      expect(slot("finished unseen").getAttribute("aria-label")).toBe("Done");
      expect(slot("finished unseen").textContent).toBe("");
      expect(slot("read already").textContent).toBe("11m");
    });

    it("a thread with nothing under it that starts asking keeps its own row id in Needs you, one row through every later update", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      const working = { ws: "ws_a", id: "th_one", prompt: "one thread", startedAgo: 5 * 60_000 };
      await act(async () => useStore.setState({ sessions: sessions([working]) } as never));
      await waitFor(() => expect(document.querySelector("[data-section=threads] [data-row-id='thread:th_one']")).not.toBeNull());
      await act(async () => useStore.setState({ sessions: sessions([{ ...working, asking: "Permission for Bash: ls" }]) } as never));
      await waitFor(() => expect(heads()).toEqual(["needs-you"]));
      const row = document.querySelector("[data-row-id='thread:th_one']");
      expect(row?.closest("[data-section]")?.getAttribute("data-section")).toBe("needs-you");
      expect(rowIds()).toEqual(["thread:th_one"]);
      await act(async () => useStore.setState({ sessions: sessions([{ ...working, asking: "Permission for Bash: ls" }]) } as never));
      await act(async () => useStore.setState({ sessions: sessions([{ ...working, asking: "Permission for Bash: ls" }]) } as never));
      expect(document.querySelector("[data-row-id='thread:th_one']")).toBe(row);
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
      for (const id of ["pinned", "needs-you"]) {
        const at = head(id);
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
      drag(rowOf("read already"), () => document.querySelector<HTMLElement>("[data-drop-settled]")!);
      await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["th_idle"]));
    });

    it("a tree with a thread still working dropped on Settled settles nothing and says why in the menu's own sentence", async () => {
      const { settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () =>
        useStore.setState({ sessions: sessions([...all, { ws: "ws_a", id: "th_builder", prompt: "its builder", parent: "th_idle", startedAgo: 10 * 60_000 }]) } as never),
      );
      await waitFor(() => expect(screen.getByText("its builder")).toBeDefined());
      clearNotices();
      drag(rowOf("read already"), () => document.querySelector<HTMLElement>("[data-drop-settled]")!);
      await waitFor(() => expect(lastNotice()).toBe(THREAD_TREE_WORKING));
      expect(settleThreads).not.toHaveBeenCalled();
    });
  });

  describe("moving a tree by drag, by the menu and by the keys", () => {
    const frame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const transfer = () => ({ setData: () => {}, getData: () => "", types: ["text/plain"], effectAllowed: "move", dropEffect: "move" });
    /** A drag event with the pointer at `y`, which jsdom's events do not carry. */
    const dragAt = (type: "dragOver" | "drop", el: Element, y = 0): void => {
      const event = createEvent[type](el, { dataTransfer: transfer() });
      Object.defineProperty(event, "clientY", { value: y });
      fireEvent(el, event);
    };
    const itemOf = (title: string): HTMLElement => rowOf(title).closest("li")!;
    const box = (el: Element, top: number, height: number): void => {
      el.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 240, width: 240, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    };
    const dragging = (): boolean => document.querySelector("[data-tree-dragging]") !== null;
    const head = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-section-head=${id}]`)!;
    const line = (): HTMLElement => document.querySelector<HTMLElement>("[data-drop-line]")!;
    const startedMs = (id: string): number => Date.parse((Object.values(useStore.getState().sessions).flat().find(row => row.threadId === id)!.startedAt as unknown as string));
    const three = [
      { ws: "ws_a", id: "th_a", prompt: "first tree", startedAgo: 60_000 },
      { ws: "ws_a", id: "th_b", prompt: "second tree", startedAgo: 2 * 60_000 },
      { ws: "ws_a", id: "th_c", prompt: "third tree", startedAgo: 3 * 60_000 },
    ];
    /** The list's three trees one tile tall each, in a list whose top is at 0. */
    const laidOut = (): void => {
      box(document.querySelector("[data-sidebar-tree]")!, 0, 400);
      ["first tree", "second tree", "third tree"].forEach((title, i) => {
        box(itemOf(title), i * 52, 52);
        box(itemOf(title).firstElementChild!, i * 52, 52);
      });
    };

    it("starts a drag with nothing in the layout moved, then shows the empty heads and folds the tree a frame later; a drop on Pinned pins it", async () => {
      const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_lead", prompt: "the lead", startedAgo: 5 * 60_000 }, { ws: "ws_a", id: "th_kid", prompt: "its builder", parent: "th_lead", startedAgo: 4 * 60_000 }, { ws: "ws_a", id: "th_other", prompt: "another one", startedAgo: 6 * 60_000 }]) } as never));
      await waitFor(() => expect(screen.getByText("its builder")).toBeDefined());
      // Nothing pinned and nothing waits: the heads are drawn with no box, so the keys and a screen reader pass them.
      for (const bare of [document.querySelector("[data-section=pinned]")!, document.querySelector("[data-section=needs-you]")!, document.querySelector("[data-drop-settled]")!]) {
        expect(bare.hasAttribute("data-drop-only")).toBe(true);
        expect(bare.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "data-[drop-shown]:block"]));
      }
      // The list starts where it did before any drag: its gap stands only while the bare heads above it show.
      const list = document.querySelector<HTMLElement>("[data-section=threads]")!;
      expect(list.className.split(" ")).not.toContain("mt-3");
      expect(list.className.split(" ")).toContain("data-[drop-shown]:mt-3");
      expect(list.hasAttribute("data-drop-gap")).toBe(true);
      rowOf("the lead").focus();
      fireEvent.keyDown(rowOf("the lead"), { key: "ArrowUp" });
      expect(document.activeElement).toBe(rowOf("the lead"));
      fireEvent.keyDown(rowOf("the lead"), { key: "End" });
      expect(document.activeElement).toBe(rowOf("another one"));
      const tree = document.querySelector("[data-sidebar-tree]")!;
      const before = tree.outerHTML;
      fireEvent.dragStart(rowOf("the lead"), { dataTransfer: transfer() });
      expect(tree.outerHTML).toBe(before);
      expect(dragging()).toBe(false);
      await frame();
      expect(dragging()).toBe(true);
      // The frame shows the bare heads and the list's gap by attributes on them alone, never on an ancestor.
      for (const shown of [document.querySelector("[data-section=pinned]")!, document.querySelector("[data-section=needs-you]")!, document.querySelector("[data-drop-settled]")!, list]) expect(shown.hasAttribute("data-drop-shown")).toBe(true);
      const lead = itemOf("the lead");
      expect(lead.hasAttribute("data-drag-source")).toBe(true);
      expect(lead.className.split(" ")).toEqual(expect.arrayContaining(["data-[drag-source]:[&>:first-child]:opacity-50", "data-[drag-source]:[&>ul]:hidden"]));
      // Folded by the CSS alone: the tree stays mounted under the tile.
      expect(lead.querySelector(":scope > ul")!.textContent).toContain("its builder");
      dragAt("dragOver", head("pinned"));
      expect(document.querySelector("[data-section=pinned]")!.hasAttribute("data-drop-over")).toBe(true);
      dragAt("drop", head("pinned"));
      fireEvent.dragEnd(rowOf("the lead"));
      await waitFor(() => expect(markThreads).toHaveBeenCalledWith(["th_lead"], { pinned: true }));
      expect(dragging()).toBe(false);
      expect(lead.hasAttribute("data-drag-source")).toBe(false);
      expect(document.querySelector("[data-drop-over]")).toBeNull();
      expect(document.querySelector("[data-drop-shown]")).toBeNull();
      expect(markThreads.mock.calls.some(([, marks]) => "folded" in (marks as object))).toBe(false);
    });

    it("puts everything back on an Escape, writes nothing, and leaves a tree folded on the host folded", async () => {
      const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_lead", prompt: "the lead", startedAgo: 5 * 60_000, foldedAgo: 60_000 }, { ws: "ws_a", id: "th_kid", prompt: "its builder", parent: "th_lead", startedAgo: 4 * 60_000 }]) } as never));
      await waitFor(() => expect(rowOf("the lead").getAttribute("aria-expanded")).toBe("false"));
      fireEvent.dragStart(rowOf("the lead"), { dataTransfer: transfer() });
      await frame();
      dragAt("dragOver", head("pinned"));
      // The browser ends a drag Escape cancelled with a dragend and no drop.
      fireEvent.dragEnd(rowOf("the lead"));
      expect(dragging()).toBe(false);
      expect(itemOf("the lead").hasAttribute("data-drag-source")).toBe(false);
      expect(document.querySelector("[data-drop-over]")).toBeNull();
      expect(rowOf("the lead").getAttribute("aria-expanded")).toBe("false");
      expect(markThreads).not.toHaveBeenCalled();
    });

    it("scrolls the list by what the heads add over the tile, so the tile stays under the pointer", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(three) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      const viewport = document.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
      let scrolled = 0;
      Object.defineProperty(viewport, "scrollTop", { get: () => scrolled, set: (to: number) => void (scrolled = to), configurable: true });
      const tile = itemOf("third tree").firstElementChild!;
      tile.getBoundingClientRect = () => ({ top: dragging() ? 184 : 104, height: 52 }) as DOMRect;
      fireEvent.dragStart(rowOf("third tree"), { dataTransfer: transfer() });
      expect(scrolled).toBe(0);
      await frame();
      expect(scrolled).toBe(80);
      fireEvent.dragEnd(rowOf("third tree"));
    });

    it("draws one 2 px line in the ring's blue before a tree over the top half of its head and after it anywhere else; a head takes the fill and no line", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([...three, { ws: "ws_a", id: "th_asks", prompt: "wants an answer", startedAgo: 30_000, asking: "Permission for Bash: ls" }]) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      laidOut();
      expect(document.querySelectorAll("[data-drop-line]")).toHaveLength(1);
      expect(line().className.split(" ")).toEqual(expect.arrayContaining(["h-0.5", "bg-ring", "absolute", "pointer-events-none"]));
      expect(line().hidden).toBe(true);
      fireEvent.dragStart(rowOf("first tree"), { dataTransfer: transfer() });
      await frame();
      // Over the bottom half of the second tree's head: after it, on the edge with the third.
      dragAt("dragOver", rowOf("second tree"), 90);
      expect(line().hidden).toBe(false);
      expect(line().style.top).toBe("103px");
      // Over the top half of the third tree's head: before it, the same edge.
      dragAt("dragOver", rowOf("third tree"), 110);
      expect(line().style.top).toBe("103px");
      dragAt("dragOver", rowOf("third tree"), 140);
      expect(line().style.top).toBe("155px");
      // The edges either side of the dragged tree are where it already stands: no line.
      dragAt("dragOver", rowOf("second tree"), 60);
      expect(line().hidden).toBe(true);
      dragAt("dragOver", head("pinned"));
      expect(line().hidden).toBe(true);
      expect(document.querySelector("[data-section=pinned]")!.hasAttribute("data-drop-over")).toBe(true);
      dragAt("dragOver", rowOf("wants an answer"));
      expect(line().hidden).toBe(true);
      expect(document.querySelector("[data-section=needs-you]")!.hasAttribute("data-drop-over")).toBe(true);
      expect(document.querySelector("[data-section=pinned]")!.hasAttribute("data-drop-over")).toBe(false);
      fireEvent.dragEnd(rowOf("first tree"));
      expect(line().hidden).toBe(true);
    });

    it("writes the neighbours' midpoint for a drop between two trees, a pin key into Pinned and the pin off with an order out of it, one mark each", async () => {
      const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([...three, { ws: "ws_a", id: "th_p1", prompt: "pinned one", startedAgo: 9 * 60_000, pinnedAgo: 60_000 }, { ws: "ws_a", id: "th_p2", prompt: "pinned two", startedAgo: 9 * 60_000, pinnedAgo: 2 * 60_000 }]) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      laidOut();
      fireEvent.dragStart(rowOf("third tree"), { dataTransfer: transfer() });
      await frame();
      dragAt("dragOver", rowOf("second tree"), 60);
      dragAt("drop", rowOf("second tree"), 60);
      fireEvent.dragEnd(rowOf("third tree"));
      expect(markThreads).toHaveBeenCalledTimes(1);
      expect(markThreads).toHaveBeenLastCalledWith(["th_c"], { order: (startedMs("th_a") + startedMs("th_b")) / 2 });
      const pins = (id: string): number => Object.values(useStore.getState().sessions).flat().find(row => row.threadId === id)!.pinnedAt!;
      box(itemOf("pinned one"), 0, 52);
      box(itemOf("pinned one").firstElementChild!, 0, 52);
      box(itemOf("pinned two"), 52, 52);
      box(itemOf("pinned two").firstElementChild!, 52, 52);
      fireEvent.dragStart(rowOf("first tree"), { dataTransfer: transfer() });
      await frame();
      dragAt("drop", rowOf("pinned two"), 60);
      fireEvent.dragEnd(rowOf("first tree"));
      expect(markThreads).toHaveBeenLastCalledWith(["th_a"], { pinned: (pins("th_p1") + pins("th_p2")) / 2 });
      laidOut();
      fireEvent.dragStart(rowOf("pinned one"), { dataTransfer: transfer() });
      await frame();
      dragAt("drop", rowOf("second tree"), 90);
      fireEvent.dragEnd(rowOf("pinned one"));
      expect(markThreads).toHaveBeenLastCalledWith(["th_p1"], { pinned: false, order: expect.any(Number) });
      expect(markThreads).toHaveBeenCalledTimes(3);
    });

    it("lands a drop at once, keeps it until the host's rows carry it, and puts the tree back with the host's reason when it refuses", async () => {
      let refuse: (e: Error) => void = () => {};
      const markThreads = vi.fn(() => new Promise<void>((_resolve, reject) => void (refuse = reject)));
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] }, { markThreads });
      await act(async () => useStore.setState({ sessions: sessions(three) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      expect(rowIds()).toEqual(["thread:th_a", "thread:th_b", "thread:th_c"]);
      laidOut();
      fireEvent.dragStart(rowOf("third tree"), { dataTransfer: transfer() });
      await frame();
      act(() => dragAt("drop", rowOf("second tree"), 60));
      fireEvent.dragEnd(rowOf("third tree"));
      expect(rowIds()).toEqual(["thread:th_a", "thread:th_c", "thread:th_b"]);
      // A reload that lands before the host's write still reads the old key; the hold stands over it.
      await act(async () => useStore.setState({ sessions: sessions(three) } as never));
      expect(rowIds()).toEqual(["thread:th_a", "thread:th_c", "thread:th_b"]);
      clearNotices();
      await act(async () => refuse(new Error("the host is read only")));
      await waitFor(() => expect(rowIds()).toEqual(["thread:th_a", "thread:th_b", "thread:th_c"]));
      expect(lastNotice()).toContain("the host is read only");
    });

    it("draws the order the host keeps the same in a second window, and lets the hold go once the host's rows carry the key", async () => {
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(three) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      laidOut();
      fireEvent.dragStart(rowOf("third tree"), { dataTransfer: transfer() });
      await frame();
      act(() => dragAt("drop", rowOf("second tree"), 60));
      fireEvent.dragEnd(rowOf("third tree"));
      const key = (startedMs("th_a") + startedMs("th_b")) / 2;
      await act(async () => {});
      const carried = three.map(row => (row.id === "th_c" ? { ...row, orderAt: key } : row));
      await act(async () => useStore.setState({ sessions: sessions(carried) } as never));
      expect(useStore.getState().heldKeys).toEqual({});
      expect(rowIds()).toEqual(["thread:th_a", "thread:th_c", "thread:th_b"]);
      cleanup();
      mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(carried) } as never));
      await waitFor(() => expect(rowIds()).toEqual(["thread:th_a", "thread:th_c", "thread:th_b"]));
    });

    it("drags a group sent to several models by its head under one key, and never a thread under a lead, a settled tile, a snoozed tree, a workspace tile or a tile being made", async () => {
      const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), workspace("ws_b", "other copy", "pr_1"), workspace("ws_e", "empty copy", "pr_1")] });
      await act(async () =>
        useStore.setState({
          creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [], failed: null }],
          sessions: sessions([
            ...three,
            { ws: "ws_a", id: "th_g1", prompt: "the task", startedAgo: 30_000, attempt: "att" },
            { ws: "ws_b", id: "th_g2", prompt: "the task", startedAgo: 29_000, attempt: "att" },
            { ws: "ws_a", id: "th_kid", prompt: "a builder", parent: "th_a", startedAgo: 50_000 },
            { ws: "ws_a", id: "th_away", prompt: "snoozed but busy", startedAgo: 40 * 60_000, snoozed: true },
            { ws: "ws_a", id: "th_old", prompt: "settled one", status: "completed", startedAgo: 30 * HOUR, endedAgo: 29 * HOUR, settledAgo: HOUR },
          ]),
        } as never),
      );
      await waitFor(() => expect(screen.getByText("a builder")).toBeDefined());
      fireEvent.click(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
      await waitFor(() => expect(screen.getByText("settled one")).toBeDefined());
      const draggable = [...document.querySelectorAll<HTMLElement>('[draggable="true"]')].map(el => el.dataset["rowId"] ?? (el.hasAttribute("data-attempt-head") ? "group" : "?"));
      expect(draggable.sort()).toEqual(["group", "thread:th_a", "thread:th_b", "thread:th_c"]);
      box(document.querySelector("[data-sidebar-tree]")!, 0, 600);
      const group = document.querySelector<HTMLElement>("[data-attempt-head]")!;
      box(itemOf("first tree"), 100, 52);
      box(itemOf("first tree").firstElementChild!, 100, 52);
      fireEvent.dragStart(group, { dataTransfer: transfer() });
      await frame();
      dragAt("drop", rowOf("first tree"), 140);
      fireEvent.dragEnd(group);
      expect(markThreads).toHaveBeenCalledTimes(1);
      const [ids, marks] = markThreads.mock.calls[0]!;
      expect([...ids].sort()).toEqual(["th_g1", "th_g2"]);
      expect(marks).toEqual({ order: (startedMs("th_a") + startedMs("th_b")) / 2 });
    });

    it("moves a tree up, down and to the top from its menu after Pin and Snooze, held at either end, and says where it went", async () => {
      const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions(three) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      type Offered = { id: string; group?: string; enabled?: boolean; refusal?: string; shortcut?: string; accelerator?: string };
      const offered: Offered[][] = [];
      const choose = (id: string) => (window.wsp = { contextMenu: async (items: Offered[]) => (offered.push(items), id) } as never);
      try {
        choose("");
        fireEvent.contextMenu(rowOf("first tree"));
        await waitFor(() => expect(offered).toHaveLength(1));
        const place = offered[0]!.filter(item => item.group === "place");
        expect(place.map(item => item.id)).toEqual(["pin", "snooze", "move-up", "move-down", "move-top"]);
        expect(place.find(item => item.id === "move-up")).toMatchObject({ enabled: false, refusal: "Already first" });
        expect(place.find(item => item.id === "move-top")).toMatchObject({ enabled: false, refusal: "Already first" });
        expect(place.find(item => item.id === "move-down")).toMatchObject({ enabled: true });
        // The keys a focused tile moves by are named on their rows, as Settle names its chord.
        expect(place.map(item => [item.id, item.shortcut ?? null, item.accelerator ?? null])).toEqual([
          ["pin", null, null],
          ["snooze", null, null],
          ["move-up", "Alt+Shift+Up", "Alt+Shift+Up"],
          ["move-down", "Alt+Shift+Down", "Alt+Shift+Down"],
          ["move-top", null, null],
        ]);
        choose("");
        fireEvent.contextMenu(rowOf("third tree"));
        await waitFor(() => expect(offered).toHaveLength(2));
        expect(offered[1]!.find(item => item.id === "move-down")).toMatchObject({ enabled: false, refusal: "Already last" });
        choose("move-top");
        fireEvent.contextMenu(rowOf("third tree"));
        await waitFor(() => expect(markThreads).toHaveBeenCalledWith(["th_c"], { order: startedMs("th_a") + 1 }));
        expect(document.querySelector("[data-move-said]")!.getAttribute("aria-live")).toBe("polite");
        expect(document.querySelector("[data-move-said]")!.textContent).toBe("Moved third tree to 1 of 3");
        choose("move-down");
        fireEvent.contextMenu(rowOf("first tree"));
        // The third tree now stands first, so the first tree moves from second to third.
        await waitFor(() => expect(document.querySelector("[data-move-said]")!.textContent).toBe("Moved first tree to 3 of 3"));
      } finally {
        delete (window as { wsp?: unknown }).wsp;
      }
    });

    it("moves a focused root one place with Alt+Shift and an arrow, keeps the focus on it, and says the move in Pinned", async () => {
      const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
      await act(async () => useStore.setState({ sessions: sessions([...three, { ws: "ws_a", id: "th_p1", prompt: "pinned one", startedAgo: 9 * 60_000, pinnedAgo: 60_000 }, { ws: "ws_a", id: "th_p2", prompt: "pinned two", startedAgo: 9 * 60_000, pinnedAgo: 2 * 60_000 }]) } as never));
      await waitFor(() => expect(screen.getByText("third tree")).toBeDefined());
      rowOf("first tree").focus();
      act(() => void fireEvent.keyDown(rowOf("first tree"), { key: "ArrowDown", altKey: true, shiftKey: true }));
      expect(markThreads).toHaveBeenLastCalledWith(["th_a"], { order: (startedMs("th_b") + startedMs("th_c")) / 2 });
      await waitFor(() => expect(rowIds().filter(id => !id.includes("th_p"))).toEqual(["thread:th_b", "thread:th_a", "thread:th_c"]));
      expect(document.activeElement).toBe(rowOf("first tree"));
      expect(document.querySelector("[data-move-said]")!.textContent).toBe("Moved first tree to 2 of 3");
      rowOf("pinned two").focus();
      act(() => void fireEvent.keyDown(rowOf("pinned two"), { key: "ArrowUp", altKey: true, shiftKey: true }));
      await waitFor(() => expect(document.querySelector("[data-move-said]")!.textContent).toBe("Moved pinned two to 1 of 2 in Pinned"));
      expect(document.activeElement).toBe(rowOf("pinned two"));
      // At the top of its section the key moves nothing, and the plain arrows still walk.
      const calls = markThreads.mock.calls.length;
      act(() => void fireEvent.keyDown(rowOf("pinned two"), { key: "ArrowUp", altKey: true, shiftKey: true }));
      expect(markThreads.mock.calls).toHaveLength(calls);
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

describe("a lead's tree in the sidebar", () => {
  const MIN = 60_000;
  /** The marathon's shape: a lead working, two children that need the person, a reviewer whose probe failed, and a
   * thread of its own asking. */
  const marathon = [
    { ws: "ws_a", id: "relay", prompt: "probe the relay", startedAgo: 9 * MIN, asking: "Fetch the metrics" },
    { ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN },
    { ws: "ws_a", id: "c-ask", prompt: "build the box thread", parent: "lead", startedAgo: 23 * MIN, asking: "Run pnpm install" },
    { ws: "ws_a", id: "c-fail", prompt: "fix the smoke", parent: "lead", status: "failed", startedAgo: 31 * MIN, endedAgo: 4 * MIN },
    { ws: "ws_a", id: "c-rev", prompt: "review the carry", parent: "lead", startedAgo: 9 * MIN },
    { ws: "ws_a", id: "g-probe", prompt: "probe the carry", parent: "c-rev", status: "failed", startedAgo: 8 * MIN, endedAgo: 5 * MIN },
  ];
  const menuOf = async (row: HTMLElement): Promise<string[]> => {
    let ids: string[] = [];
    window.wsp = { contextMenu: async (items: Array<{ id: string }>) => ((ids = items.map(item => item.id)), null) } as never;
    try {
      fireEvent.contextMenu(row);
      await waitFor(() => expect(ids.length).toBeGreaterThan(0));
      return ids;
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  };

  it("Needs you is an inbox: each thread that needs the person stands alone, one under a tree marked with its starter, the head counting them, and the trees stay in the list; picking one marks it in both", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () => useStore.setState({ sessions: sessions(marathon) } as never));
    await waitFor(() => expect(screen.getAllByText("build the box thread")).toHaveLength(2));
    const head = document.querySelector<HTMLElement>("[data-section-head=needs-you]")!;
    expect(head.textContent).toBe("Needs you (4)");
    const inbox = [...document.querySelectorAll<HTMLElement>("[data-section=needs-you] li [data-sidebar-row]")];
    expect(inbox.map(row => row.dataset["rowId"])).toEqual(["inbox:thread:g-probe", "inbox:thread:c-ask", "inbox:thread:c-fail", "thread:relay"]);
    const probe = inbox[0]!;
    // Row one keeps the project's glyph, the starter's mark on its corner, and names the thread that started it.
    expect(probe.querySelector("[data-tile-where]")!.textContent).toBe("review the carry");
    expect(probe.querySelector("[data-tile-started-by]")).not.toBeNull();
    expect(probe.querySelector("[data-tile-started-by] svg.lucide-corner-down-right")).not.toBeNull();
    expect(inbox[3]!.querySelector("[data-tile-started-by]")).toBeNull();
    expect(inbox[3]!.querySelector("[data-tile-where]")!.textContent).toBe(document.querySelector("[data-row-id='thread:lead'] [data-tile-where]")!.textContent);
    // Nothing hangs under an inbox tile.
    expect(probe.closest("li")!.querySelector("ul")).toBeNull();
    // Its card says the whole path down to it.
    fireEvent.mouseEnter(probe);
    expect(document.querySelector("[data-tile-card-line=started-by]")!.textContent).toBe("Started by coordinator / review the carry");
    // The tree stays in the list, whatever under it asks; the relay, alone, stands in the inbox only, as its own tile.
    expect(document.querySelector("[data-section=threads] [data-row-id='thread:lead']")).not.toBeNull();
    expect(document.querySelector("[data-section=threads] [data-row-id='thread:c-ask']")).not.toBeNull();
    expect(document.querySelector("[data-section=threads] [data-row-id='thread:relay']")).toBeNull();
    fireEvent.click(inbox[1]!);
    expect(useStore.getState().selectedThreadId).toBe("c-ask");
    await waitFor(() => expect(document.querySelector("[data-row-id='inbox:thread:c-ask']")!.getAttribute("data-active")).toBe("true"));
    expect(document.querySelector("[data-row-id='thread:c-ask']")!.getAttribute("data-active")).toBe("true");
  });

  it("a tile folds its tree by the host's folded mark, from its control and the arrow keys; folded it reads how many rows it would draw, keeps its own glyphs and mounts nothing under it", async () => {
    const { markThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const tree = [
      { ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN },
      { ws: "ws_a", id: "c-one", prompt: "child one", parent: "lead", startedAgo: 3 * MIN },
      { ws: "ws_a", id: "c-two", prompt: "child two", parent: "lead", startedAgo: 4 * MIN },
      { ws: "ws_a", id: "g-one", prompt: "grandchild", parent: "c-two", startedAgo: 1 * MIN },
      { ws: "ws_a", id: "c-done", prompt: "child done", parent: "lead", status: "completed", startedAgo: 9 * MIN, endedAgo: 8 * MIN },
    ];
    await act(async () => useStore.setState({ sessions: sessions(tree) } as never));
    await waitFor(() => expect(screen.getByText("grandchild")).toBeDefined());
    const lead = (): HTMLElement => rowOf("coordinator");
    // Open: the chevron alone, nothing at rest, its room kept; no count.
    const control = lead().querySelector<HTMLElement>("[data-tile-fold]")!;
    expect(lead().getAttribute("aria-expanded")).toBe("true");
    expect(control.textContent).toBe("");
    expect(control.className).toContain("opacity-0");
    expect(control.querySelector("svg.lucide-chevron-down")).not.toBeNull();
    fireEvent.click(control);
    await waitFor(() => expect(markThreads).toHaveBeenCalledWith(["lead"], { folded: true }));
    expect(useStore.getState().selectedThreadId).toBeNull();
    lead().focus();
    fireEvent.keyDown(lead(), { key: "ArrowLeft" });
    await waitFor(() => expect(markThreads).toHaveBeenCalledTimes(2));
    expect(markThreads).toHaveBeenLastCalledWith(["lead"], { folded: true });
    // The host's mark lands: the tile reads how many rows it would draw at any depth, and mounts none of them.
    await act(async () => useStore.setState({ sessions: sessions(tree.map(row => (row.id === "lead" ? { ...row, foldedAgo: MIN } : row))) } as never));
    await waitFor(() => expect(screen.queryByText("grandchild")).toBeNull());
    expect(lead().getAttribute("aria-expanded")).toBe("false");
    const shut = lead().querySelector<HTMLElement>("[data-tile-fold]")!;
    expect(shut.textContent).toBe("4");
    expect(shut.className).not.toContain("opacity-0");
    expect(shut.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    expect(lead().closest("li")!.querySelector("ul, [data-child-fold]")).toBeNull();
    expect(screen.queryByText("child one")).toBeNull();
    expect(lead().querySelector("[data-thread-status=working]")).not.toBeNull();
    lead().focus();
    fireEvent.keyDown(lead(), { key: "ArrowRight" });
    await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["lead"], { folded: false }));
    // A child with a tree under it folds as the lead does; one with nothing under it has no fold.
    await act(async () => useStore.setState({ sessions: sessions(tree) } as never));
    await waitFor(() => expect(screen.getByText("grandchild")).toBeDefined());
    expect(rowOf("child one").getAttribute("aria-expanded")).toBeNull();
    expect(rowOf("child one").querySelector("[data-tile-fold]")).toBeNull();
    fireEvent.click(rowOf("child two").querySelector<HTMLElement>("[data-tile-fold]")!);
    await waitFor(() => expect(markThreads).toHaveBeenLastCalledWith(["c-two"], { folded: true }));
  });

  it("a folded tile whose tree is a Finished fold alone counts that fold's row, never 0", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const tree = [
      { ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN },
      { ws: "ws_a", id: "c-done", prompt: "child done", parent: "lead", status: "completed", startedAgo: 9 * MIN, endedAgo: 8 * MIN },
    ];
    await act(async () => useStore.setState({ sessions: sessions(tree) } as never));
    await waitFor(() => expect(document.querySelector("[data-child-fold=finished]")).not.toBeNull());
    await act(async () => useStore.setState({ sessions: sessions(tree.map(row => (row.id === "lead" ? { ...row, foldedAgo: MIN } : row))) } as never));
    await waitFor(() => expect(document.querySelector("[data-child-fold=finished]")).toBeNull());
    expect(rowOf("coordinator").querySelector<HTMLElement>("[data-tile-fold]")!.textContent).toBe("1");
  });

  it("draws live children first and the finished behind a shut Finished fold that mounts none of them; open, it pages twenty at a time; its menu and the lead's hold Settle N finished", async () => {
    const { settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const finished = Array.from({ length: 25 }, (_, i) => ({ ws: "ws_a", id: `f${i}`, prompt: `finished ${i}`, parent: "lead", status: "completed", startedAgo: (30 + i) * MIN, endedAgo: (10 + i) * MIN, ...(i === 0 ? { readAgo: 2 * HOUR } : {}) }));
    await act(async () =>
      useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN, pinnedAgo: MIN }, { ws: "ws_a", id: "c-live", prompt: "still building", parent: "lead", startedAgo: 3 * MIN }, ...finished]) } as never),
    );
    await waitFor(() => expect(screen.getByText("still building")).toBeDefined());
    // The head counts the tiles it draws: the lead and its one live child.
    expect(document.querySelector("[data-section-head=pinned]")!.textContent).toBe("Pinned (2)");
    const fold = document.querySelector<HTMLElement>("[data-child-fold=finished]")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toBe("Finished25");
    expect(fold.querySelector("svg.lucide-circle-check")).not.toBeNull();
    expect(screen.queryByText("finished 3")).toBeNull();
    expect(await menuOf(fold)).toEqual(["settle-finished"]);
    expect(await menuOf(rowOf("coordinator"))).toContain("settle-finished");
    fireEvent.click(fold);
    await waitFor(() => expect(screen.getByText("finished 3")).toBeDefined());
    // The rows stand at the fold row's own x, under it in the same list.
    const rows = (): HTMLElement[] => [...fold.closest("ul")!.querySelectorAll<HTMLElement>(":scope > li > div > [data-sidebar-row][data-slim]")];
    expect(rows()).toHaveLength(20);
    // The fold's rows end in the check: green while nobody has read one, muted after.
    expect(rows()[0]!.querySelector("[data-thread-status]")!.getAttribute("data-tone")).toBe("done");
    expect(rows()[1]!.querySelector("[data-thread-status=finished]")).not.toBeNull();
    const more = document.querySelector<HTMLElement>("[data-child-fold=more]")!;
    expect(more.textContent).toBe("5 more");
    fireEvent.click(more);
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(document.querySelector("[data-child-fold=more]")).toBeNull();
    // A finished row offers Settle on hover, as a quiet tile does.
    const settle = rows()[1]!.parentElement!.querySelector<HTMLElement>("[data-tile-settle]")!;
    fireEvent.click(settle);
    await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["f1"]));
  });

  it("keeps a child settled under a running lead in the lead's Finished fold, after the finished, muted, and opens it on a click", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const tree = [
      { ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN },
      { ws: "ws_a", id: "c-live", prompt: "still building", parent: "lead", startedAgo: 3 * MIN },
      { ws: "ws_a", id: "c-done", prompt: "child done", parent: "lead", status: "completed", startedAgo: 9 * MIN, endedAgo: 8 * MIN },
      { ws: "ws_a", id: "c-put", prompt: "child put away", parent: "lead", status: "completed", startedAgo: 30 * MIN, endedAgo: 20 * MIN, settledAgo: MIN },
    ];
    await act(async () => useStore.setState({ sessions: sessions(tree) } as never));
    const fold = await waitFor(() => document.querySelector<HTMLElement>("[data-child-fold=finished]")!);
    expect(fold.textContent).toBe("Finished2");
    expect(document.querySelector("[data-row-id=settled]")).toBeNull();
    expect(screen.queryByText("child put away")).toBeNull();
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds()).toEqual(["thread:lead", "thread:c-live", "finished:thread:lead", "thread:c-done", "thread:c-put"]));
    const put = rowOf("child put away");
    expect(put.dataset["slim"]).toBe("true");
    expect(put.closest("li")!.parentElement).toBe(fold.closest("ul"));
    const slot = put.querySelector<HTMLElement>("[data-thread-status]")!;
    expect(slot.textContent).toBe("20m");
    expect(slot.dataset["tone"]).toBeUndefined();
    expect(put.parentElement!.querySelector("[data-tile-settle]")).toBeNull();
    expect(await menuOf(put)).toContain("restore");
    fireEvent.click(put);
    await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("c-put"));
    expect(rowOf("child put away")).toBeDefined();
  });

  it("a folded tile over a settled child alone counts its Finished fold's row", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () =>
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN, foldedAgo: MIN },
          { ws: "ws_a", id: "c-put", prompt: "child put away", parent: "lead", status: "completed", startedAgo: 30 * MIN, endedAgo: 20 * MIN, settledAgo: MIN },
        ]),
      } as never),
    );
    await waitFor(() => expect(rowOf("coordinator").querySelector<HTMLElement>("[data-tile-fold]")!.textContent).toBe("1"));
  });

  it("a settled row past the second level names its opener on its card, and a fold of settled rows alone leaves its right-click to the sidebar's own menu", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const chain = [{ id: "lead", prompt: "coordinator" }, { id: "l1", prompt: "level one", parent: "lead" }, { id: "l2", prompt: "level two", parent: "l1" }].map((row, i) => ({ ws: "ws_a", startedAgo: (10 - i) * MIN, ...row }));
    await act(async () => useStore.setState({ sessions: sessions([...chain, { ws: "ws_a", id: "l3", prompt: "level three", parent: "l2", status: "completed", startedAgo: 7 * MIN, endedAgo: 6 * MIN, settledAgo: MIN }]) } as never));
    const fold = await waitFor(() => document.querySelector<HTMLElement>("[data-row-id='finished:thread:l2']")!);
    let ids: string[] = [];
    window.wsp = { contextMenu: async (items: Array<{ id: string }>) => ((ids = items.map(item => item.id)), null) } as never;
    fireEvent.contextMenu(fold);
    delete (window as { wsp?: unknown }).wsp;
    expect(ids).toEqual(["settle-read"]);
    fireEvent.click(fold);
    fireEvent.mouseEnter(await waitFor(() => document.querySelector<HTMLElement>("[data-row-id='thread:l3']")!));
    const card = await waitFor(() => [...document.querySelectorAll("[data-tile-card]")].find(at => at.querySelector("[data-tile-card-title]")!.textContent === "level three")!);
    expect(card.querySelector("[data-tile-card-line=started-by]")?.textContent).toBe("Started by coordinator / level one / level two");
  });

  it("moves the whole tree into Settled once the lead settles too, the child nested under it there and no Finished fold left", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const child = { ws: "ws_a", id: "c-put", prompt: "child put away", parent: "lead", status: "completed", startedAgo: 30 * MIN, endedAgo: 20 * MIN, settledAgo: 10 * MIN };
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN }, child]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["thread:lead", "finished:thread:lead"]));
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "lead", prompt: "coordinator", status: "completed", startedAgo: 9 * MIN, endedAgo: 5 * MIN, settledAgo: MIN }, child]) } as never));
    await waitFor(() => expect(rowIds()).toEqual(["settled"]));
    fireEvent.click(document.querySelector<HTMLElement>("[data-row-id=settled]")!);
    await waitFor(() => expect(rowIds()).toEqual(["settled", "thread:lead", "thread:c-put"]));
    expect(rowOf("child put away").closest("li")!.parentElement).toBe(rowOf("coordinator").closest("li")!.querySelector(":scope > ul"));
    expect(document.querySelector("[data-child-fold=finished]")).toBeNull();
  });

  it("a quiet tile offers Settle beside its button, a working one and one over a working child nothing", async () => {
    const { settleThreads } = mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await act(async () =>
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "quiet", prompt: "all quiet", status: "completed", startedAgo: 30 * MIN, endedAgo: 20 * MIN },
          { ws: "ws_a", id: "works", prompt: "still going", startedAgo: 10 * MIN },
          { ws: "ws_a", id: "over", prompt: "over a builder", status: "completed", startedAgo: 40 * MIN, endedAgo: 35 * MIN },
          { ws: "ws_a", id: "builder", prompt: "the builder", parent: "over", startedAgo: 34 * MIN },
        ]),
      } as never),
    );
    await waitFor(() => expect(screen.getByText("the builder")).toBeDefined());
    const settleOf = (title: string): HTMLElement | null => rowOf(title).parentElement!.querySelector<HTMLElement>(":scope > [data-tile-settle]");
    expect(rowOf("all quiet").parentElement!.hasAttribute("data-has-action")).toBe(true);
    expect(settleOf("still going")).toBeNull();
    expect(settleOf("over a builder")).toBeNull();
    fireEvent.click(settleOf("all quiet")!);
    await waitFor(() => expect(settleThreads).toHaveBeenCalledWith(["quiet"]));
    expect(useStore.getState().selectedThreadId).toBeNull();
  });

  it("a thread's subagents hang under it as slim rows, a running one live with Stop on hover and in its menu, an ended one in the Finished fold", async () => {
    const at = Date.now();
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] }, { interruptSession: vi.fn(async () => ({})) });
    const subagents = [
      { id: "sa-map", title: "Read the open tickets", state: "running", startedAt: at - MIN, model: "claude-opus-5-5", asked: "Read every open ticket" },
      { id: "sa-done", title: "Check the gate", state: "done", startedAt: at - 5 * MIN, endedAt: at - 4 * MIN, lastLine: "Main is green." },
    ];
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 10 * MIN, subagents }]) } as never));
    await waitFor(() => expect(screen.getByText("Read the open tickets")).toBeDefined());
    const row = screen.getByText("Read the open tickets").closest<HTMLElement>("[data-subagent-row]")!;
    expect(row.className).toContain("h-9");
    expect(row.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(row.querySelector("[data-thread-status=working]")).not.toBeNull();
    expect(row.parentElement!.querySelector(":scope > [data-stop-act]")).not.toBeNull();
    expect(await menuOf(row)).toEqual(["stop-subagent"]);
    expect(screen.queryByText("Check the gate")).toBeNull();
    expect(document.querySelector("[data-child-fold=finished]")!.textContent).toBe("Finished1");
  });

  it("a snoozed root that runs a subagent stands alone at the foot of the list: no subagent row under it and no fold", async () => {
    const at = Date.now();
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const subagents = [{ id: "sa1", title: "Read the open tickets", state: "running", startedAt: at - MIN }];
    await act(async () =>
      useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "here", prompt: "still here", status: "completed", startedAgo: 9 * MIN, endedAgo: 8 * MIN }, { ws: "ws_a", id: "away", prompt: "snoozed away", startedAgo: 5 * MIN, snoozed: true, subagents }]) } as never),
    );
    await waitFor(() => expect(screen.getByText("snoozed away")).toBeDefined());
    expect(rowIds()).toEqual(["thread:here", "thread:away"]);
    expect(rowOf("snoozed away").querySelector("[data-tile-fold]")).toBeNull();
    expect(rowOf("snoozed away").getAttribute("aria-expanded")).toBeNull();
    expect(rowOf("snoozed away").closest("li")!.querySelector("ul")).toBeNull();
  });

  it("a done lead over a failed child offers Settle on hover, as its menu's Settle does; over an asking child it offers none", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const tree = [
      { ws: "ws_a", id: "lead", prompt: "coordinator", status: "completed", startedAgo: 20 * MIN, endedAgo: 10 * MIN },
      { ws: "ws_a", id: "c-fail", prompt: "fix the smoke", parent: "lead", status: "failed", startedAgo: 31 * MIN, endedAgo: 4 * MIN },
    ];
    await act(async () => useStore.setState({ sessions: sessions(tree) } as never));
    await waitFor(() => expect(document.querySelector("[data-row-id='thread:c-fail']")).not.toBeNull());
    const settleOf = (rowId: string): HTMLElement | null => document.querySelector(`[data-row-id='${rowId}']`)!.parentElement!.querySelector<HTMLElement>(":scope > [data-tile-settle]");
    expect(settleOf("thread:lead")).not.toBeNull();
    expect(settleOf("thread:c-fail")).not.toBeNull();
    expect(await menuOf(document.querySelector<HTMLElement>("[data-row-id='thread:lead']")!)).toContain("settle");
    await act(async () => useStore.setState({ sessions: sessions([...tree, { ws: "ws_a", id: "c-ask", prompt: "build the box thread", parent: "lead", status: "completed", startedAgo: 23 * MIN, endedAgo: 3 * MIN, asking: "Run pnpm install" }]) } as never));
    await waitFor(() => expect(document.querySelector("[data-row-id='thread:c-ask']")).not.toBeNull());
    expect(settleOf("thread:lead")).toBeNull();
  });

  it("nests two levels and then stands flat, and a tile past the second level names its opener on its card", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const chain = ["coordinator", "level one", "level two", "level three", "level four"];
    const ids = ["lead", "l1", "l2", "l3", "l4"];
    await act(async () => useStore.setState({ sessions: sessions(ids.map((id, i) => ({ ws: "ws_a", id, prompt: chain[i]!, startedAgo: (10 - i) * MIN, ...(i === 0 ? {} : { parent: ids[i - 1] }) }))) } as never));
    await waitFor(() => expect(screen.getByText("level four")).toBeDefined());
    const listOf = (title: string): Element => rowOf(title).closest("li")!.parentElement!;
    expect(listOf("level one")).toBe(rowOf("coordinator").closest("li")!.querySelector(":scope > ul"));
    expect(listOf("level two")).toBe(rowOf("level one").closest("li")!.querySelector(":scope > ul"));
    expect(listOf("level three")).toBe(listOf("level two"));
    expect(listOf("level four")).toBe(listOf("level two"));
    const startedBy = async (title: string): Promise<string | null> => {
      fireEvent.mouseEnter(document.querySelector<HTMLElement>(`[data-row-id='thread:${ids[chain.indexOf(title)]}']`)!);
      const card = await waitFor(() => [...document.querySelectorAll("[data-tile-card]")].find(at => at.querySelector("[data-tile-card-title]")!.textContent === title)!);
      return card.querySelector("[data-tile-card-line=started-by]")?.textContent ?? null;
    };
    expect(await startedBy("level two")).toBeNull();
    expect(await startedBy("level three")).toBe("Started by coordinator / level one / level two");
    expect(await startedBy("level four")).toBe("Started by coordinator / level one / level two / level three");
    // Settled whole, the tree nests in the Settled fold at every depth, and no card names an opener.
    await act(async () => useStore.setState({ sessions: sessions(ids.map((id, i) => ({ ws: "ws_a", id, prompt: chain[i]!, status: "completed", startedAgo: (10 - i) * HOUR, endedAgo: (9 - i) * HOUR, settledAgo: HOUR, ...(i === 0 ? {} : { parent: ids[i - 1] }) }))) } as never));
    fireEvent.click(await waitFor(() => document.querySelector<HTMLElement>("[data-row-id=settled]")!));
    await waitFor(() => expect(document.querySelector("[data-row-id='thread:l4']")).not.toBeNull());
    expect(await startedBy("level four")).toBeNull();
  });

  it("a folded tile reads as selected while a thread under it is open", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const tree = [
      { ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN },
      { ws: "ws_a", id: "c-one", prompt: "child one", parent: "lead", startedAgo: 3 * MIN },
    ];
    await act(async () => useStore.setState({ sessions: sessions(tree) } as never));
    await waitFor(() => expect(screen.getByText("child one")).toBeDefined());
    fireEvent.click(rowOf("child one"));
    expect(useStore.getState().selectedThreadId).toBe("c-one");
    expect(rowOf("coordinator").getAttribute("data-active")).not.toBe("true");
    await act(async () => useStore.setState({ sessions: sessions(tree.map(row => (row.id === "lead" ? { ...row, foldedAgo: MIN } : row))) } as never));
    await waitFor(() => expect(screen.queryByText("child one")).toBeNull());
    expect(rowOf("coordinator").getAttribute("data-active")).toBe("true");
  });

  it("draws no fold control and folds on no key where the host cannot mark threads", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] }, { markThreads: undefined });
    await act(async () =>
      useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN }, { ws: "ws_a", id: "c-one", prompt: "child one", parent: "lead", startedAgo: 3 * MIN }]) } as never),
    );
    await waitFor(() => expect(screen.getByText("child one")).toBeDefined());
    expect(rowOf("coordinator").querySelector("[data-tile-fold]")).toBeNull();
    expect(rowOf("coordinator").getAttribute("aria-expanded")).toBeNull();
  });

  it("the n more row is a row the arrow keys reach, and a shut fold opens again on its first page", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    const finished = Array.from({ length: 45 }, (_, i) => ({ ws: "ws_a", id: `f${i}`, prompt: `finished ${i}`, parent: "lead", status: "completed", startedAgo: (30 + i) * MIN, endedAgo: (10 + i) * MIN }));
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "lead", prompt: "coordinator", startedAgo: 2 * MIN }, ...finished]) } as never));
    await waitFor(() => expect(document.querySelector("[data-child-fold=finished]")).not.toBeNull());
    const fold = (): HTMLElement => document.querySelector<HTMLElement>("[data-child-fold=finished]")!;
    const more = (): HTMLElement => document.querySelector<HTMLElement>("[data-child-fold=more]")!;
    fireEvent.click(fold());
    await waitFor(() => expect(more().textContent).toBe("25 more"));
    expect(more().hasAttribute("data-sidebar-row")).toBe(true);
    rowOf("finished 19").focus();
    fireEvent.keyDown(rowOf("finished 19"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(more());
    fireEvent.click(more());
    await waitFor(() => expect(more().textContent).toBe("5 more"));
    fireEvent.click(fold());
    await waitFor(() => expect(document.querySelector("[data-child-fold=more]")).toBeNull());
    fireEvent.click(fold());
    await waitFor(() => expect(more().textContent).toBe("25 more"));
  });
});

describe("Stop on a tile", () => {
  const stopOf = (title: string): HTMLElement | null => rowOf(title).parentElement!.querySelector<HTMLElement>(":scope > [data-stop-act]");
  const settleOf = (title: string): HTMLElement | null => rowOf(title).parentElement!.querySelector<HTMLElement>(":scope > [data-tile-settle]");

  it("offers Stop on a lead whose own turn ended while its builders run, saying the whole tree stops, Settle on a quiet tree, and one or the other only", async () => {
    const interruptSession = vi.fn(async () => ({ outcome: "not-running" as const }));
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] }, { interruptSession });
    await act(async () =>
      useStore.setState({
        sessions: sessions([
          { ws: "ws_a", id: "th_lead", prompt: "the lead", status: "completed", startedAgo: 20 * 60_000, endedAgo: 10 * 60_000 },
          { ws: "ws_a", id: "th_kid", prompt: "its builder", parent: "th_lead", startedAgo: 9 * 60_000 },
          { ws: "ws_a", id: "th_quiet", prompt: "a quiet one", status: "completed", startedAgo: 30 * 60_000, endedAgo: 29 * 60_000 },
          { ws: "ws_a", id: "th_lone", prompt: "a lone one", startedAgo: 5 * 60_000 },
        ]),
      } as never),
    );
    await waitFor(() => expect(screen.getByText("its builder")).toBeDefined());
    expect(stopOf("the lead")!.getAttribute("aria-label")).toBe("Stop this thread and every thread under it");
    expect(settleOf("the lead")).toBeNull();
    expect(stopOf("its builder")!.getAttribute("aria-label")).toBe("Stop thread");
    expect(stopOf("a lone one")!.getAttribute("aria-label")).toBe("Stop thread");
    expect(stopOf("a quiet one")).toBeNull();
    expect(settleOf("a quiet one")).not.toBeNull();
    fireEvent.click(stopOf("the lead")!);
    expect(interruptSession).not.toHaveBeenCalled();
    fireEvent.click(stopOf("the lead")!);
    await waitFor(() => expect(interruptSession).toHaveBeenCalledWith("s_th_lead"));
    // The menu's Stop thread is one press: opening the menu is the first.
    const offered: Array<Array<{ id: string; enabled?: boolean }>> = [];
    window.wsp = { contextMenu: async (items: Array<{ id: string; enabled?: boolean }>) => (offered.push(items), "stop") } as never;
    try {
      fireEvent.contextMenu(rowOf("the lead"));
      await waitFor(() => expect(interruptSession).toHaveBeenCalledTimes(2));
      expect(offered[0]!.find(item => item.id === "stop")).toMatchObject({ enabled: true });
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });

  it("a subagent row's Stop takes the same two presses", async () => {
    const interruptSession = vi.fn(async () => ({ outcome: "accepted" as const }));
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] }, { interruptSession });
    await act(async () => useStore.setState({ sessions: sessions([{ ws: "ws_a", id: "th_lead", prompt: "the lead", startedAgo: 60_000, subagents: [{ id: "task_1", title: "Read the tickets", state: "running", startedAt: Date.now() - 30_000 }] }]) } as never));
    const row = await waitFor(() => document.querySelector<HTMLElement>('[data-subagent-row="task_1"]')!);
    const stop = row.parentElement!.querySelector<HTMLElement>(":scope > [data-stop-act]")!;
    expect(stop.getAttribute("aria-label")).toBe("Stop subagent");
    fireEvent.click(stop);
    expect(interruptSession).not.toHaveBeenCalled();
    expect(stop.textContent).toBe("Stop");
    pointerLeave(row.parentElement!);
    expect(stop.hasAttribute("data-armed")).toBe(false);
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => expect(interruptSession).toHaveBeenCalledWith("s_th_lead", "task_1"));
  });
});
