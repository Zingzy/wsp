// SPDX-License-Identifier: AGPL-3.0-only
// Quick open and search in files over a fake daemon wire: the finder asks
// fs.search under the open thread's project folder (a worktree's own folder where
// it runs in one), ranks a file by its name first, lists a line with its place,
// opens the pick as a Files tab at its line, and says why it lists nothing.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileFinder, FINDER_WORDS } from "../src/files/FileFinder.js";
import { rankFilePaths } from "../src/files/fileFinder.logic.js";
import { openFileFinder } from "../src/files/finderBus.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { fakeWire, resetSurfaces, view, WS } from "./surface-harness.js";

const PATHS = ["README.md", "apps/web/src/components/RightPanelTabs.tsx", "apps/web/src/panes.ts", "apps/web/test/panes.test.tsx", "packages/pantry/index.ts", "todo.md"];

beforeEach(resetSurfaces);
afterEach(cleanup);

const rows = () => [...document.querySelectorAll("[data-file-finder] [role='option']")].map(row => row.textContent);
const type = (text: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });

describe("ranking the paths the daemon found", () => {
  it("puts a name that starts with the letters first, then a name that holds them, then letters in the folders", () => {
    expect(rankFilePaths(PATHS, "pan").map(m => m.path)).toEqual(["apps/web/src/panes.ts", "apps/web/test/panes.test.tsx", "apps/web/src/components/RightPanelTabs.tsx", "packages/pantry/index.ts"]);
    expect(rankFilePaths(PATHS, "rea")[0]).toEqual({ path: "README.md", name: "README.md", folder: "" });
    expect(rankFilePaths(PATHS, "", 2).map(m => m.path)).toEqual(["README.md", "apps/web/src/components/RightPanelTabs.tsx"]);
  });
});

describe("the file finder", () => {
  it("finds a file by a few letters of its name under the worktree's own folder and opens it as a Files tab", async () => {
    const wire = fakeWire({ "fs.search": params => ({ hits: PATHS.filter(p => String(params["query"]) === "" || p.toLowerCase().includes("a")).map(path => ({ path })), truncated: false }) });
    provideDaemonWire(WS, wire);
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local", worktree: { path: "/Users/dev/web-copy", branch: "feat/x", made: true }, folder: "/Users/dev/web-copy" } as never] }));
    render(<FileFinder />);
    act(() => openFileFinder("files"));
    type("pan");
    await waitFor(() => expect(rows()[0]).toContain("panes.ts"));
    expect(wire.calls.at(-1)).toEqual(["fs.search", { path: "/Users/dev/web-copy", query: "pan", mode: "files" }]);
    fireEvent.click(screen.getAllByRole("option")[0]!);
    const panel = useRightPanelStore.getState().byWorkspaceId[WS]!;
    expect(panel.activeSurfaceId).toBe("file:/Users/dev/web-copy/apps/web/src/panes.ts");
    expect(document.querySelector("[data-file-finder]")).toBeNull();
  });

  it("searches the files for a word, lists each line with its place, and opens the pick at its line", async () => {
    const wire = fakeWire({ "fs.search": { hits: [{ path: "todo.md", line: 3, text: "  - the thing to do" }], truncated: true } });
    provideDaemonWire(WS, wire);
    render(<FileFinder />);
    act(() => openFileFinder("text"));
    expect(screen.getByText(FINDER_WORDS.typeWord)).toBeTruthy();
    type("thing");
    await waitFor(() => expect(rows()).toEqual(["- the thing to dotodo.md:3"]));
    expect(wire.calls.at(-1)).toEqual(["fs.search", { path: "/root", query: "thing", mode: "text" }]);
    expect(document.querySelector("[data-file-finder-more]")?.textContent).toBe(FINDER_WORDS.moreLines);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(useRightPanelStore.getState().byWorkspaceId[WS]?.surfaces.at(-1)).toMatchObject({ kind: "files", path: "/root/todo.md", line: 3 });
  });

  it("says no line holds the word, and says the daemon's refusal as itself", async () => {
    let refuse = false;
    provideDaemonWire(WS, fakeWire({ "fs.search": () => (refuse ? new Error("/root resolves outside the workspace root") : { hits: [], truncated: false }) }));
    render(<FileFinder />);
    act(() => openFileFinder("text"));
    type("nowhere");
    await waitFor(() => expect(screen.getByText(FINDER_WORDS.text.none)).toBeTruthy());
    refuse = true;
    type("nowhere at all");
    await waitFor(() => expect(screen.getByText("/root resolves outside the workspace root")).toBeTruthy());
  });

  it("asks nothing and says so while the open thread's machine is not running", async () => {
    const wire = fakeWire({ "fs.search": { hits: [], truncated: false } });
    provideDaemonWire(WS, wire);
    act(() => useStore.setState({ workspaces: [{ ...view, phase: "napping" }] }));
    render(<FileFinder />);
    act(() => openFileFinder("files"));
    type("rea");
    await act(() => new Promise(resolve => setTimeout(resolve, 200)));
    expect(screen.getByText(FINDER_WORDS.notRunning)).toBeTruthy();
    expect(wire.calls).toEqual([]);
  });
});
