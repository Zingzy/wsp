// SPDX-License-Identifier: AGPL-3.0-only
// The Files surface over a fake daemon wire: the root lists one level with
// its folders shut, a folder lists itself when opened, a folder the daemon cut
// carries a note row with the count, a file opens as its own surface, and the
// location bar follows the thread's folder until pinned.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesSurface } from "../src/files/FilesSurface.js";
import { useRootStore } from "../src/files/root.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";
import { fakeWire, LISTING, resetSurfaces, WS } from "./surface-harness.js";
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
const rootLabel = (container: HTMLElement) => container.querySelector("[data-files-root]")?.textContent;

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
    expect(rootLabel(container)).toBe("/root");
    expect((screen.getByRole("button", { name: "Up one folder" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(rowFor(container, "src/"));
    await settle();
    expect(treeRows(container).map(r => r.path)).not.toContain("src/a.ts");
    fireEvent.click(rowFor(container, "src/"));
    await settle();
    expect(treeRows(container).map(r => r.path)).toContain("src/a.ts");
    expect(listCalls(wire)).toEqual(["/root", "/root/src"]);
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
    expect(rootLabel(container)).toBe("/root/app");

    fireEvent.click(rowFor(container, "package.json"));
    await settle();
    expect(useRightPanelStore.getState().byWorkspaceId[WS]!.activeSurfaceId).toBe("file:/root/app/package.json");

    fireEvent.click(screen.getByRole("button", { name: "Stay in this folder" }));
    act(() => useRootStore.getState().follow(WS, "/root"));
    await settle();
    expect(rootLabel(container)).toBe("/root/app");
    expect(screen.getByRole("button", { name: "Follow the agent's folder" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Follow the agent's folder" }));
    await waitFor(() => expect(rootLabel(container)).toBe("/root"));
    expect(treeRows(container).map(r => r.path)).toContain("README.md");
    fireEvent.click(rowFor(container, "README.md"));
    await settle();
    expect(useRightPanelStore.getState().byWorkspaceId[WS]!.activeSurfaceId).toBe("file:/root/README.md");
  });

  it("up one folder pins the parent; new thread here follows the shown folder and asks for a thread", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    act(() => useRootStore.getState().follow(WS, "/root/app"));
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(rootLabel(container)).toBe("/root/app"));
    const up = () => screen.getByRole("button", { name: "Up one folder" }) as HTMLButtonElement;
    expect(up().disabled).toBe(false);
    fireEvent.click(up());
    await waitFor(() => expect(rootLabel(container)).toBe("/root"));
    expect(useRootStore.getState().byWorkspaceId[WS]).toEqual({ followed: "/root/app", pinned: "/root", shell: null });
    expect(up().disabled).toBe(true);

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

  it("explains itself when the workspace has no daemon wire, and waits for the daemon's root", () => {
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    expect(screen.getByText("The workspace is not running.")).toBeTruthy();
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    provideDaemonHello(WS, null);
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    expect(screen.getAllByText("The workspace is not running.")).toHaveLength(2);
  });
});
