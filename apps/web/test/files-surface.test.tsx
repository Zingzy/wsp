// SPDX-License-Identifier: AGPL-3.0-only
// The Files surface over a fake daemon wire: the root lists one level with
// its folders shut, a folder lists itself when opened, a folder the daemon cut
// carries a note row with the count, a file opens as its own surface, and the
// one breadcrumb row follows the thread's folder until pinned. Base UI menus
// never settle under jsdom (see composer-pickers.test), so the root switch's
// menu is stood in by a plain open/closed context; diff-surface.test renders
// the real one.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/ui/menu.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Menu = ({ children }: { children: ReactNode }) => {
    const [open, setOpen] = useState(false);
    return <Ctx.Provider value={{ open, set: setOpen }}>{children}</Ctx.Provider>;
  };
  const MenuTrigger = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <button type="button" onClick={() => ctx.set(!ctx.open)} {...(props as Record<string, unknown>)}>
        {children}
      </button>
    );
  };
  const MenuPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="menu">{children}</div> : null);
  const MenuItem = ({ children, onClick, ...props }: { children: ReactNode; onClick?: () => void; [key: string]: unknown }) => (
    <div role="menuitem" onClick={onClick} {...(props as Record<string, unknown>)}>{children}</div>
  );
  return { Menu, MenuTrigger, MenuPopup, MenuItem };
});

import { FilesSurface } from "../src/files/FilesSurface.js";
import { resetListings } from "../src/files/listing.js";
import { useRootStore } from "../src/files/root.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";
import { useStore } from "../src/protocol/store.js";
import { fakeWire, folderCrumbRow, imported, LEVELS, LISTING, PROJECT_DEST, resetSurfaces, shownFolder, WS } from "./surface-harness.js";
import { provideDaemonHello } from "../src/files/wire.js";

beforeEach(resetSurfaces);

const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));

function treeRows(container: HTMLElement): { path: string; expanded: string | null }[] {
  const host = container.querySelector("file-tree-container");
  const shadow = host?.shadowRoot;
  if (!shadow) return [];
  return Array.from(shadow.querySelectorAll<HTMLElement>("[data-type='item']")).map(row => ({
    path: row.dataset["itemPath"] ?? "",
    expanded: row.getAttribute("aria-expanded"),
  }));
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector("file-tree-container")?.shadowRoot?.querySelector<HTMLElement>(`[data-type='item'][data-item-path='${path}']`);
  if (!row) throw new Error(`no tree row for ${path}`);
  return row;
}

const listCalls = (wire: { calls: [string, Record<string, unknown>][] }) => wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"]);
/** The chevron beside the root crumb, which is the only control that switches root. */
const ROOT_SWITCH = "Pick a browsable folder";
const rootMenu = () => screen.getAllByRole("menuitem").map(item => [item.textContent, item.dataset["currentRoot"]]);
/** Opening the switch names every browsable root, and an item pins the one picked. */
const pickRoot = (path: string) => {
  fireEvent.click(screen.getByRole("button", { name: ROOT_SWITCH }));
  fireEvent.click(screen.getByRole("menuitem", { name: path }));
};

describe("files surface", () => {
  it("lists the root one level with its folders shut, and lists a folder when it is opened", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    expect(wire.calls[0]).toEqual(["fs.list", { path: "/root", gitignore: true }]);
    expect(listCalls(wire)).toEqual(["/root"]);
    expect(treeRows(container).map(r => r.path)).toEqual(["app/", "docs/", "locked/", "src/", "wide/", "README.md"]);
    expect(rowFor(container, "src/").getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(rowFor(container, "src/"));
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toContain("src/a.ts"));
    expect(listCalls(wire)).toEqual(["/root", "/root/src"]);
    expect(shownFolder(container)).toBe("/root");

    fireEvent.click(rowFor(container, "src/"));
    await settle();
    expect(treeRows(container).map(r => r.path)).not.toContain("src/a.ts");
    fireEvent.click(rowFor(container, "src/"));
    await settle();
    expect(treeRows(container).map(r => r.path)).toContain("src/a.ts");
    expect(listCalls(wire)).toEqual(["/root", "/root/src"]);
  });

  it("names the folder in one row at a root: the root is its only crumb, and nothing stands there for up", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    expect(container.querySelectorAll("[data-files-location]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-folder-crumbs]")).toHaveLength(1);
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"]]);
    expect(shownFolder(container)).toBe("/root");
    // The path is in the row once and the row holds no control for up, at a root or anywhere.
    expect(container.querySelector("[data-files-location]")?.textContent).toBe("/root");
    expect(screen.queryByRole("button", { name: /up/i })).toBeNull();
    expect(container.querySelector("[data-files-roots]")).toBeNull();
    expect(screen.queryByRole("button", { name: ROOT_SWITCH })).toBeNull();
  });

  it("draws the root and every folder below it as crumbs, and a crumb between them goes there", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    act(() => useRootStore.getState().follow(WS, "/root/app/lib"));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toEqual(["index.ts"]));
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"], ["app", "/root/app"], ["lib", "/root/app/lib"]]);
    expect(shownFolder(container)).toBe("/root/app/lib");
    expect(container.querySelectorAll("[data-files-location]")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "app" }));
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app"));
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"], ["app", "/root/app"]]);
    expect(useRootStore.getState().byWorkspaceId[WS]).toEqual({ followed: "/root/app/lib", pinned: "/root/app", shell: null });
    expect(listCalls(wire)).toEqual(["/root/app/lib", "/root/app"]);
    expect(treeRows(container).map(r => r.path)).toEqual(["lib/", "package.json"]);
  });

  it("goes up a folder on Backspace and Alt+Up, is inert at the root, and leaves a field's own keys alone", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    act(() => useRootStore.getState().follow(WS, "/root/app/lib"));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app/lib"));
    const pane = container.querySelector<HTMLElement>("[data-files-pane]")!;
    // Nothing was clicked in the pane: it is focusable and took focus as it was shown, so the keys are live.
    expect(pane.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(pane);

    // From a tree row, where the key is pressed in practice: the row lives in the tree's shadow root.
    fireEvent.keyDown(rowFor(container, "index.ts"), { key: "Backspace" });
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app"));
    fireEvent.keyDown(pane, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(shownFolder(container)).toBe("/root"));

    fireEvent.keyDown(pane, { key: "Backspace" });
    fireEvent.keyDown(pane, { key: "ArrowUp", altKey: true });
    await settle();
    expect(shownFolder(container)).toBe("/root");

    act(() => useRootStore.getState().pin(WS, "/root/app"));
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app"));
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search api files" }), { key: "Backspace" });
    fireEvent.keyDown(pane, { key: "ArrowUp" });
    fireEvent.keyDown(pane, { key: "Backspace", metaKey: true });
    await settle();
    expect(shownFolder(container)).toBe("/root/app");
  });

  it("puts a note row with the count under a folder the daemon cut at its cap", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    useRightPanelStore.getState().open(WS, "files");
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    fireEvent.click(rowFor(container, "wide/"));
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toContain("wide/… 10,000 more entries not shown"));
    expect(treeRows(container).map(r => r.path).slice(-3)).toEqual(["wide/w0.txt", "wide/… 10,000 more entries not shown", "README.md"]);
    expect(container.querySelector("[data-files-error]")).toBeNull();
    fireEvent.click(rowFor(container, "wide/… 10,000 more entries not shown"));
    await settle();
    expect(useRightPanelStore.getState().byWorkspaceId[WS]!.surfaces.map(s => s.id)).toEqual(["files"]);
  });

  it("reports a folder that would not list beside the tree, never as rows", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    fireEvent.click(rowFor(container, "locked/"));
    await waitFor(() => expect(container.querySelector("[data-files-error='locked']")).not.toBeNull());
    expect(container.querySelector("[data-files-error='locked']")?.textContent).toBe("locked: EACCES: permission denied, scandir '/root/locked'");
    expect(treeRows(container).map(r => r.path).filter(p => p.startsWith("locked/"))).toEqual(["locked/"]);
  });

  it("opens a clicked file as a surface and keeps the explorer tab", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    useRightPanelStore.getState().open(WS, "files");
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));

    fireEvent.click(rowFor(container, "README.md"));
    await settle();
    const panel = useRightPanelStore.getState().byWorkspaceId[WS]!;
    expect(panel.activeSurfaceId).toBe("file:/root/README.md");
    expect(panel.surfaces.map(s => s.id)).toEqual(["files", "file:/root/README.md"]);
  });

  it("roots at the thread's folder, opens files by their full path, and the pin stops following", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    useRightPanelStore.getState().open(WS, "files");
    act(() => useRootStore.getState().follow(WS, "/root/app"));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toEqual(["lib/", "package.json"]));
    expect(listCalls(wire)).toEqual(["/root/app"]);
    expect(shownFolder(container)).toBe("/root/app");

    fireEvent.click(rowFor(container, "package.json"));
    await settle();
    expect(useRightPanelStore.getState().byWorkspaceId[WS]!.activeSurfaceId).toBe("file:/root/app/package.json");

    fireEvent.click(screen.getByRole("button", { name: "Stay in this folder" }));
    act(() => useRootStore.getState().follow(WS, "/root"));
    await settle();
    expect(shownFolder(container)).toBe("/root/app");
    expect(screen.getByRole("button", { name: "Follow the agent's folder" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Follow the agent's folder" }));
    await waitFor(() => expect(shownFolder(container)).toBe("/root"));
    expect(treeRows(container).map(r => r.path)).toContain("README.md");
    fireEvent.click(rowFor(container, "README.md"));
    await settle();
    expect(useRightPanelStore.getState().byWorkspaceId[WS]!.activeSurfaceId).toBe("file:/root/README.md");
  });

  it("the root crumb pins the root; new thread here follows the shown folder and asks for a thread", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    act(() => useRootStore.getState().follow(WS, "/root/app"));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app"));
    fireEvent.click(screen.getByRole("button", { name: "/root" }));
    await waitFor(() => expect(shownFolder(container)).toBe("/root"));
    expect(useRootStore.getState().byWorkspaceId[WS]).toEqual({ followed: "/root/app", pinned: "/root", shell: null });

    const requests: string[] = [];
    const off = onNewThreadRequest(detail => requests.push(detail.workspaceId));
    fireEvent.click(screen.getByRole("button", { name: "New thread in this folder" }));
    off();
    expect(requests).toEqual([WS]);
    expect(useRootStore.getState().byWorkspaceId[WS]!.followed).toBe("/root");
  });

  it("refresh asks again for every folder the tree shows", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    fireEvent.click(rowFor(container, "docs/"));
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toContain("docs/guide.md"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));
    await settle();
    expect(listCalls(wire)).toEqual(["/root", "/root/docs", "/root", "/root/docs"]);
  });

  it("shows the listing error with the last good tree gone", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": () => { throw new Error("daemon unreachable"); } }));
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(screen.getByText("daemon unreachable")).toBeTruthy());
  });

  it("says what the daemon predates in place of its refusal, when it is behind this app", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": params => (String(params["path"]) === PROJECT_DEST ? new Error(`${PROJECT_DEST} resolves outside the workspace root`) : LEVELS["/root"]!) }));
    provideDaemonHello(WS, { root: "/root", version: 2 });
    useStore.setState({ workspaces: [imported] });
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    expect(container.querySelector("[data-files-behind]")).toBeNull();

    pickRoot(PROJECT_DEST);
    await waitFor(() => expect(container.querySelector("[data-files-behind]")).not.toBeNull());
    expect(container.querySelector("[data-files-behind]")?.textContent).toBe("daemon v2 predates Files in imported projects");
    expect(screen.queryByText(`${PROJECT_DEST} resolves outside the workspace root`)).toBeNull();
  });

  it("shows a refusal that has nothing to do with the version as itself, on a current daemon and on an old one alike", async () => {
    const refuses = () => new Error("EACCES: permission denied, scandir '/root'");
    provideDaemonWire(WS, fakeWire({ "fs.list": refuses }));
    const { container, unmount } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(screen.getByText("EACCES: permission denied, scandir '/root'")).toBeTruthy());
    expect(container.querySelector("[data-files-behind]")).toBeNull();
    unmount();

    // The daemon's home is the one folder every version browses, so a failure there is never the version's doing.
    resetListings();
    provideDaemonHello(WS, { root: "/root", version: 2 });
    const old = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(screen.getByText("EACCES: permission denied, scandir '/root'")).toBeTruthy());
    expect(old.container.querySelector("[data-files-behind]")).toBeNull();
  });

  it("explains itself when the workspace has no daemon wire, and waits for the daemon's root", () => {
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    expect(screen.getByText("The workspace is not running.")).toBeTruthy();
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    provideDaemonHello(WS, null);
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    expect(screen.getAllByText("The workspace is not running.")).toHaveLength(2);
  });

  it("keeps the root crumb going to its root when the daemon browses two roots, with the switch its own button beside it, and up stops at each root's edge", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    useStore.setState({ workspaces: [imported] });
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"]]);
    expect(container.querySelector("[data-files-roots]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: ROOT_SWITCH }));
    expect(rootMenu()).toEqual([["/root", "true"], [PROJECT_DEST, "false"]]);

    fireEvent.click(screen.getByRole("menuitem", { name: PROJECT_DEST }));
    await waitFor(() => expect(shownFolder(container)).toBe(PROJECT_DEST));
    expect(treeRows(container).map(r => r.path)).toEqual(["packages/", "pnpm-workspace.yaml"]);
    expect(listCalls(wire)).toEqual(["/root", PROJECT_DEST]);
    expect(folderCrumbRow(container)).toEqual([[PROJECT_DEST, PROJECT_DEST]]);
    expect(useRootStore.getState().byWorkspaceId[WS]).toEqual({ followed: null, pinned: PROJECT_DEST, shell: null });

    // At a root's edge the key does nothing, as the daemon lists nothing above it.
    const pane = container.querySelector<HTMLElement>("[data-files-pane]")!;
    fireEvent.keyDown(pane, { key: "Backspace" });
    await settle();
    expect(shownFolder(container)).toBe(PROJECT_DEST);

    fireEvent.click(rowFor(container, "packages/"));
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toContain("packages/web/"));
    act(() => useRootStore.getState().pin(WS, `${PROJECT_DEST}/packages`));
    await waitFor(() => expect(shownFolder(container)).toBe(`${PROJECT_DEST}/packages`));
    expect(folderCrumbRow(container)).toEqual([[PROJECT_DEST, PROJECT_DEST], ["packages", `${PROJECT_DEST}/packages`]]);
    fireEvent.keyDown(pane, { key: "Backspace" });
    await waitFor(() => expect(shownFolder(container)).toBe(PROJECT_DEST));

    pickRoot("/root");
    await waitFor(() => expect(shownFolder(container)).toBe("/root"));
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"]]);

    // Two roots, and the crumb is still one click to its root, the same gesture it is with one root.
    act(() => useRootStore.getState().pin(WS, "/root/app"));
    await waitFor(() => expect(shownFolder(container)).toBe("/root/app"));
    fireEvent.click(screen.getByRole("button", { name: "/root" }));
    await waitFor(() => expect(shownFolder(container)).toBe("/root"));
  });

  it("follows the thread into the imported project and lists it there", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    useStore.setState({ workspaces: [imported] });
    act(() => useRootStore.getState().follow(WS, PROJECT_DEST));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).map(r => r.path)).toEqual(["packages/", "pnpm-workspace.yaml"]));
    expect(listCalls(wire)).toEqual([PROJECT_DEST]);
    expect(folderCrumbRow(container)).toEqual([[PROJECT_DEST, PROJECT_DEST]]);
    expect(container.querySelector("[data-files-error]")).toBeNull();
  });
});
