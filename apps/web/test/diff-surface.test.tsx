// SPDX-License-Identifier: AGPL-3.0-only
// The Diff surface over a fake wire: git.diff runs for the chosen scope in
// the panes' root, the header names that folder in the same breadcrumb row
// the Files pane uses and the branch git resolved there beside it, the
// changed-files tree and stat follow the reply, files collapse, the branch
// base is named, and the byte budget cut is announced. The Pierre code view
// is stubbed to a list of item ids and their collapse.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: { items: { id: string; collapsed?: boolean }[] }) => (
    <ul data-code-view>
      {props.items.map(item => (
        <li key={item.id} data-item={item.id} data-collapsed={item.collapsed === true}>{item.id}</li>
      ))}
    </ul>
  ),
}));

import { DiffSurface } from "../src/diffs/DiffSurface.js";
import { useDiffStore } from "../src/diffs/store.js";
import { useRootStore } from "../src/files/root.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useStore } from "../src/protocol/store.js";
import { fakeWire, folderCrumbRow, imported, LISTING, PROJECT_DEST, resetSurfaces, shownFolder, WS } from "./surface-harness.js";

const patch = (path: string, from: string, to: string) =>
  [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");

const DIFF = { base: null, files: [{ path: "src/a.ts", patch: patch("src/a.ts", "one", "two") }, { path: "README.md", patch: patch("README.md", "old", "new") }], truncated: false };
const STATUS = { branch: { oid: "abc", head: "main", ahead: 0, behind: 0 }, entries: [], root: "/root/app" };
const NOT_A_REPO = () => Object.assign(new Error("not inside a git repository"), { code: "not-a-git-repo" });

beforeEach(() => {
  resetSurfaces();
  useDiffStore.setState({ scopeByWorkspaceId: {}, renderMode: "stacked" });
});

const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
const items = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-item]")).map(li => [li.dataset["item"], li.dataset["collapsed"]]);
const diffCalls = (wire: { calls: [string, Record<string, unknown>][] }) => wire.calls.filter(([op]) => op === "git.diff").map(([, p]) => p);

describe("diff surface", () => {
  it("diffs the working tree at the root first and lists the changed files with a stat", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": STATUS });
    provideDaemonWire(WS, wire);
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    // Before git answers there is no mark at all, rather than an icon with nothing beside it.
    expect(container.querySelector("[data-diff-git]")).toBeNull();
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(diffCalls(wire)).toEqual([{ cwd: "/root", scope: "unstaged" }]);
    expect(container.querySelector("[data-diff-surface]")?.getAttribute("data-diff-scope")).toBe("unstaged");
    await waitFor(() => expect(container.querySelector("[data-diff-repo]")?.getAttribute("data-diff-repo")).toBe("/root/app"));
    expect(container.querySelector("[data-diff-repo]")?.textContent).toBe("main");
    expect(container.querySelector("[data-diff-git]")?.textContent).toBe("main");
    expect(screen.getByRole("group", { name: "2 additions, 2 deletions" })).toBeTruthy();
    const tree = container.querySelector("[data-changed-files]")!;
    expect(tree.textContent).toContain("2 changed files");
    expect(tree.textContent).toContain("a.ts");
    expect(tree.textContent).toContain("README.md");
  });

  // Base UI menus do not open under jsdom (the positioner never settles), so
  // the pickers are driven through the store actions their items call.
  it("switches scope and asks git.diff again with it, naming the branch base", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": STATUS, "git.diff": params => ({ ...DIFF, base: params["scope"] === "branch" ? "main" : null }) });
    provideDaemonWire(WS, wire);
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Diff scope: Working tree" })).toBeTruthy();

    act(() => useDiffStore.getState().setScope(WS, "staged"));
    await waitFor(() => expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root", scope: "staged" }));
    expect(screen.getByRole("button", { name: "Diff scope: Staged" })).toBeTruthy();
    expect(container.querySelector("[data-diff-base]")).toBeNull();

    act(() => useDiffStore.getState().setScope(WS, "branch"));
    await waitFor(() => expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root", scope: "branch" }));
    await waitFor(() => expect(container.querySelector("[data-diff-base]")?.getAttribute("data-diff-base")).toBe("main"));
    expect(container.querySelector("[data-diff-base]")?.textContent).toContain("HEAD");
    expect(container.querySelector("[data-diff-surface]")?.getAttribute("data-diff-scope")).toBe("branch");
  });

  it("runs git in the panes' root, follows the thread's folder, and stops when pinned", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    act(() => useRootStore.getState().follow(WS, "/root/app"));
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(diffCalls(wire)).toEqual([{ cwd: "/root/app", scope: "unstaged" }]);
    await waitFor(() => expect(container.querySelector("[data-diff-repo]")?.getAttribute("data-diff-repo")).toBe("/root/app"));

    act(() => useRootStore.getState().follow(WS, "/root/other"));
    await waitFor(() => expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root/other", scope: "unstaged" }));

    fireEvent.click(screen.getByRole("button", { name: "Stay in this folder" }));
    act(() => useRootStore.getState().follow(WS, "/root/third"));
    await settle();
    expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root/other", scope: "unstaged" });
    expect(container.querySelector("[data-diff-surface]")?.getAttribute("data-diff-cwd")).toBe("/root/other");
  });

  it("runs git in the agent's shell folder inside the imported project, the same roots the Files pane reads", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": { ...STATUS, root: PROJECT_DEST } });
    provideDaemonWire(WS, wire);
    act(() => {
      useRootStore.getState().follow(WS, "/root");
      useRootStore.getState().shell(WS, `${PROJECT_DEST}/packages`);
    });
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(diffCalls(wire)).toEqual([{ cwd: "/root", scope: "unstaged" }]);

    act(() => useStore.setState({ workspaces: [imported] }));
    await waitFor(() => expect(diffCalls(wire).at(-1)).toEqual({ cwd: `${PROJECT_DEST}/packages`, scope: "unstaged" }));
    await waitFor(() => expect(container.querySelector("[data-diff-repo]")?.getAttribute("data-diff-repo")).toBe(PROJECT_DEST));
  });

  it("says when the root is outside any repository", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.diff": NOT_A_REPO, "git.status": NOT_A_REPO }));
    act(() => useRootStore.getState().follow(WS, "/root/scratch"));
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-diff-repo]")).toBeNull());
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"], ["scratch", "/root/scratch"]]);
    expect(container.querySelector("[data-surface-subheader]")?.textContent).toContain("no git");
    expect(screen.getByRole("alert").textContent).toBe("not inside a git repository");
  });

  it("keeps the repository label through a refresh of the same folder", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": STATUS });
    provideDaemonWire(WS, wire);
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-diff-repo]")?.getAttribute("data-diff-repo")).toBe("/root/app"));
    // Checked before the replies land: the label must not drop while the same folder's status is in flight.
    fireEvent.click(screen.getByRole("button", { name: "Refresh diff" }));
    expect(container.querySelector("[data-diff-repo]")?.getAttribute("data-diff-repo")).toBe("/root/app");
    act(() => useRootStore.getState().follow(WS, "/root/other"));
    expect(container.querySelector("[data-diff-repo]")).toBeNull();
  });

  it("names the folder git runs in as one breadcrumb row, which a crumb and the key up both move", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    act(() => useRootStore.getState().follow(WS, "/root/app/lib"));
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"], ["app", "/root/app"], ["lib", "/root/app/lib"]]);
    expect(shownFolder(container)).toBe("/root/app/lib");
    expect(container.querySelectorAll("[data-folder-crumbs]")).toHaveLength(1);
    // The row draws the path; the git mark beside it carries the branch and never the path again.
    await waitFor(() => expect(container.querySelector("[data-diff-repo]")?.textContent).toBe("main"));

    fireEvent.click(screen.getByRole("button", { name: "app" }));
    await waitFor(() => expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root/app", scope: "unstaged" }));
    expect(shownFolder(container)).toBe("/root/app");

    fireEvent.keyDown(container.querySelector("[data-diff-surface]")!, { key: "Backspace" });
    await waitFor(() => expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root", scope: "unstaged" }));
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"]]);
    fireEvent.keyDown(container.querySelector("[data-diff-surface]")!, { key: "Backspace" });
    await settle();
    expect(diffCalls(wire).at(-1)).toEqual({ cwd: "/root", scope: "unstaged" });
  });

  it("draws the root switch as its own button beside the crumb, on the real menu the Files test stands in for", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": { ...STATUS, root: PROJECT_DEST } });
    provideDaemonWire(WS, wire);
    useStore.setState({ workspaces: [imported] });
    act(() => useRootStore.getState().follow(WS, `${PROJECT_DEST}/packages`));
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(folderCrumbRow(container)).toEqual([[PROJECT_DEST, PROJECT_DEST], ["packages", `${PROJECT_DEST}/packages`]]);

    const crumb = screen.getByRole("button", { name: PROJECT_DEST });
    const switchRoot = screen.getByRole("button", { name: "Pick a browsable folder" });
    expect(switchRoot).not.toBe(crumb);
    expect(switchRoot.getAttribute("aria-haspopup")).toBe("menu");
    expect(crumb.getAttribute("aria-haspopup")).toBeNull();
    expect(crumb.dataset["folderCrumb"]).toBe(PROJECT_DEST);
    expect(switchRoot.dataset["folderCrumb"]).toBeUndefined();

    fireEvent.click(crumb);
    await waitFor(() => expect(shownFolder(container)).toBe(PROJECT_DEST));
    expect(diffCalls(wire).at(-1)).toEqual({ cwd: PROJECT_DEST, scope: "unstaged" });
  });

  it("collapses and expands every file", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.diff": DIFF, "git.status": STATUS }));
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(items(container)).toHaveLength(2));
    expect(items(container).map(([, c]) => c)).toEqual(["false", "false"]);

    fireEvent.click(screen.getByRole("button", { name: "Collapse all files" }));
    await settle();
    expect(items(container).map(([, c]) => c)).toEqual(["true", "true"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    await settle();
    expect(items(container).map(([, c]) => c)).toEqual(["false", "false"]);
  });

  it("announces the budget cut and still lists the file without a patch", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS, "git.diff": { ...DIFF, files: [DIFF.files[0]!, { path: "huge.log", patch: "" }], truncated: true } }));
    const { container } = render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-diff-truncated]")).not.toBeNull());
    expect(container.querySelector("[data-diff-truncated]")?.textContent).toContain("2 MB budget");
    expect(items(container)).toHaveLength(1);
    expect(container.querySelector("[data-changed-files]")?.textContent).toContain("huge.log");
  });

  it("shows the daemon's refusal when the folder is not a repository", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS, "git.diff": () => { throw new Error("git diff failed (128): fatal: bad revision"); } }));
    render(<DiffSurface workspaceId={WS} theme="dark" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("git diff failed (128): fatal: bad revision"));
  });
});
