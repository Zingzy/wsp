// SPDX-License-Identifier: AGPL-3.0-only
// The Files surface over a fake daemon wire: the tree lists fs.list, expands
// on click, opens a file as its own surface, and says when the daemon cut
// the listing short.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesSurface } from "../src/files/FilesSurface.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { fakeWire, LISTING, resetSurfaces, WS } from "./surface-harness.js";

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

describe("files surface", () => {
  it("lists the daemon root gitignore-aware, top level open, and toggles a folder on click", async () => {
    const wire = fakeWire({ "fs.list": LISTING });
    provideDaemonWire(WS, wire);
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));
    expect(wire.calls[0]).toEqual(["fs.list", { path: ".", depth: 8, gitignore: true }]);
    expect(treeRows(container).map(r => r.path)).toEqual(["docs/", "docs/guide.md", "src/", "src/a.ts", "README.md"]);
    expect(rowFor(container, "src/").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(rowFor(container, "src/"));
    await settle();
    expect(treeRows(container).map(r => r.path)).toEqual(["docs/", "docs/guide.md", "src/", "README.md"]);
    expect(rowFor(container, "src/").getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(rowFor(container, "src/"));
    await settle();
    expect(treeRows(container).map(r => r.path)).toContain("src/a.ts");
  });

  it("opens a clicked file as a surface and keeps the explorer tab", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING }));
    useRightPanelStore.getState().open(WS, "files");
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(treeRows(container).length).toBeGreaterThan(0));

    fireEvent.click(rowFor(container, "README.md"));
    await settle();
    const panel = useRightPanelStore.getState().byWorkspaceId[WS]!;
    expect(panel.activeSurfaceId).toBe("file:README.md");
    expect(panel.surfaces.map(s => s.id)).toEqual(["files", "file:README.md"]);
  });

  it("shows the daemon's truncation and the refresh asks again", async () => {
    const wire = fakeWire({ "fs.list": { ...LISTING, truncated: true } });
    provideDaemonWire(WS, wire);
    const { container } = render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-files-truncated]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));
    await settle();
    expect(wire.calls.filter(([op]) => op === "fs.list")).toHaveLength(2);
  });

  it("shows the listing error with the last good tree gone", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": () => { throw new Error("daemon unreachable"); } }));
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(screen.getByText("daemon unreachable")).toBeTruthy());
  });

  it("explains itself when the workspace has no daemon wire", () => {
    render(<FilesSurface workspaceId={WS} theme="dark" />);
    expect(screen.getByText("The workspace is not running.")).toBeTruthy();
  });
});
