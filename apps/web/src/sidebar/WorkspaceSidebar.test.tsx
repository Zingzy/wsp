// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Capabilities, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import { workspaceActions } from "../actions/workspaceActions.js";
import { SidebarProvider } from "../components/ui/sidebar.js";
import type { Api, Landing } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import { NEW_WORKSPACE, PROJECT_WORDS } from "./words.js";

// The triggers keep their elements and no popup mounts: Base UI's positioning against jsdom's zero-size rects
// costs seconds per open, and this file reads rows rather than popups.
vi.mock("../components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

const project = (id: string, name: string): ProjectView => ({
  id,
  name,
  computer: "here",
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
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
const landing: Landing = { name: "This Mac", capabilities: SHARES };

function mount({ projects, workspaces }: { projects: ProjectView[]; workspaces: WorkspaceView[] }) {
  const create = vi.fn(async (_project: string, name: string) => ({ ...workspace("ws_new", name, "pr_1") }));
  const api = {
    subscribe: () => () => {},
    listWorkspaces: async () => workspaces,
    listSessions: async () => [],
    watchStatuses: async () => [],
    capabilities: async () => SHARES,
    getGolden: async () => ({ head: null, versions: [] }),
    placesList: async () => [],
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
    workspaces,
    projects,
    statuses: {},
    sessions: {},
    launches: {},
    creations: [],
    places: [],
    landings: Object.fromEntries(projects.map(p => [p.id, landing])),
    selectedId: null,
    selectedThreadId: null,
    toast: null,
    preferences: { ...DEFAULT_PREFERENCES, labs: true },
  } as never);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
    </SidebarProvider>,
  );
  return { create };
}

/** Every project header row the sidebar drew, in order, with the count beside it once its section is shut. */
const headers = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-k^=project\\:]")].map(row => row.textContent ?? "");
const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(row => row.dataset["rowId"] ?? "");

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, projects: [], workspaces: [], landings: {} } as never);
});

describe("the sidebar under the four nouns", () => {
  it("draws one section row per project with its workspaces under it, and no row over them all", async () => {
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [workspace("ws_a", "pricing page", "pr_1"), workspace("ws_b", "webhook retries", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(headers()).toEqual(["spoo", "wsp"]);
    expect(screen.queryByLabelText("Workspaces")).toBeNull();
    expect(rowIds()).toEqual(["ws:ws_a", "ws:ws_b"]);
    // The count rides the header while its section is shut, so a shut project still says how much it holds.
    fireEvent.click(screen.getByLabelText("spoo"));
    await waitFor(() => expect(headers()[0]).toBe("spoo2"));
    expect(rowIds()).toEqual([]);
  });

  it("says a project has no workspaces yet, and its plus opens the dialog with that project picked", async () => {
    mount({ projects: [project("pr_1", "spoo"), project("pr_2", "wsp")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(screen.getByText(PROJECT_WORDS.noWorkspaces)).toBeDefined();
    const plus = [...document.querySelectorAll<HTMLElement>(`[data-k=new-workspace]`)].find(el => el.dataset["project"] === "pr_2")!;
    fireEvent.click(plus);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(NEW_WORKSPACE);
    // Two projects are a segmented control, and the one whose plus was pressed is the checked segment.
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_2]")!.getAttribute("aria-checked")).toBe("true");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_1]")!.getAttribute("aria-checked")).toBe("false");
  });

  it("holds one row under the projects that records another, which opens the sheet", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [] });
    fireEvent.click(await screen.findByLabelText(PROJECT_WORDS.add));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.querySelector("[data-k=title]")!.textContent).toBe(PROJECT_WORDS.add);
  });

  it("offers no Spaces row and no look action in a row's menu, whatever the preferences record says", async () => {
    mount({ projects: [project("pr_1", "spoo")], workspaces: [workspace("ws_a", "pricing page", "pr_1")] });
    await waitFor(() => expect(screen.getByText("pricing page")).toBeDefined());
    expect(document.body.textContent).not.toContain("Spaces");
    expect(document.querySelector("[data-space-icon]")).toBeNull();
    // The registry itself no longer carries them, so no surface can offer one: no entry is held back by a flag.
    expect(workspaceActions.map(action => action.id)).not.toContain("icon");
    expect(workspaceActions.map(action => action.id)).not.toContain("theme");
    expect(workspaceActions.some(action => "labs" in action)).toBe(false);
  });

  it("draws a workspace an agent forked one step in under the thread that forked it", async () => {
    const lead = workspace("ws_a", "pricing page", "pr_1");
    const forked = { ...workspace("ws_fork", "pricing table", "pr_1"), parentThreadId: "th_lead" };
    mount({ projects: [project("pr_1", "spoo")], workspaces: [lead, forked] });
    await act(async () => {
      useStore.setState({
        sessions: {
          ws_a: [{ id: "s_lead", workspaceId: "ws_a", threadId: "th_lead", harness: "claude", status: "running", prompt: "move the pricing table", startedBy: "person" }],
          ws_fork: [{ id: "s_child", workspaceId: "ws_fork", threadId: "th_child", harness: "claude", status: "running", prompt: "write the migration", startedBy: "agent", parentThreadId: "th_lead" }],
        },
      } as never);
    });
    await waitFor(() => expect(screen.getByText("move the pricing table")).toBeDefined());
    expect(rowIds()).toEqual(["ws:ws_a", "thread:th_lead", "ws:ws_fork", "thread:th_child"]);
    // Its row carries the same lines a top-level row does, off its own record.
    const row = screen.getByText("pricing table").closest<HTMLElement>("[data-sidebar-row]")!;
    expect(row.querySelector("[data-workspace-made-of]")!.textContent).toBe("a copy · shares this Mac's ports, PORT 3100");
  });
});
