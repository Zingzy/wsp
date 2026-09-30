// SPDX-License-Identifier: AGPL-3.0-only
// The file tab over a fake wire: fs.read feeds the code view, markdown renders
// and toggles back to source, the 2 MB cap is announced, a line asked for is
// marked and scrolled to every time it is asked, the crumbs go back to the
// tree, and Open in editor asks the host on this computer and says one
// sentence for a machine elsewhere. The Pierre code view is stubbed; it is a
// worker-backed custom element.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrolled = vi.hoisted(() => [] as unknown[]);
vi.mock("@pierre/diffs/react", () => ({
  CodeView: forwardRef(function CodeView(
    props: { items: { file: { name: string; contents: string } }[]; selectedLines?: { range: { start: number } } | null },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollTo: (target: unknown) => void scrolled.push(target) }));
    const file = props.items[0]?.file;
    return (
      <pre data-code-view={file?.name} data-selected-line={props.selectedLines?.range.start}>
        {file?.contents}
      </pre>
    );
  }),
}));

import { sshIncludeLine } from "@wsp/protocol";
import { useSshConsent } from "../src/files/EditorConsent.js";
import { RequestError } from "../src/protocol/client.js";
import { FilePreviewSurface } from "../src/files/FilePreviewSurface.js";
import { useRootStore } from "../src/files/root.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { fakeWire, folderCrumbRow, LISTING, resetSurfaces, view, WS } from "./surface-harness.js";

beforeEach(() => {
  resetSurfaces();
  scrolled.length = 0;
});

const fileSurface = (path: string, line: number | null = null, reveal = 1) => ({ id: `file:${path}` as const, kind: "files" as const, path, line, reveal });
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
const frame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

describe("file tab", () => {
  it("reads the file over the wire and shows it as code under the crumbs of its folders", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "fs.read": { content: "const a = 1;\n", size: 13, truncated: false } });
    provideDaemonWire(WS, wire);
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-code-view='/root/src/a.ts']")).not.toBeNull());
    expect(wire.calls).toContainEqual(["fs.read", { path: "/root/src/a.ts" }]);
    expect(container.querySelector("[data-code-view]")?.textContent).toBe("const a = 1;\n");
    expect(folderCrumbRow(container)).toEqual([["/root", "/root"], ["src", "/root/src"], ["a.ts", "/root/src/a.ts"]]);
    expect(screen.queryByRole("button", { name: /markdown/ })).toBeNull();
  });

  it("goes back to the tree from a folder crumb, rooted at that folder", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x\n", size: 2, truncated: false } }));
    render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(useRootStore.getState().byWorkspaceId[WS]?.pinned).toBe("/root/src");
    expect(useRightPanelStore.getState().byWorkspaceId[WS]?.activeSurfaceId).toBe("files");
  });

  it("marks the line asked for and scrolls to it, and scrolls again when the same line is asked for again", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "a\nb\nc\n", size: 6, truncated: false } }));
    const { container, rerender } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts", 2, 1)} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-code-view]")).not.toBeNull());
    await frame();
    expect(container.querySelector("[data-code-view]")?.getAttribute("data-selected-line")).toBe("2");
    expect(scrolled).toEqual([{ type: "line", id: "/root/src/a.ts", lineNumber: 2, align: "center" }]);
    rerender(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts", 2, 2)} theme="dark" />);
    await frame();
    expect(scrolled).toHaveLength(2);
  });

  it("renders markdown and toggles back to the source", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "# Guide\n\nSome *words*.\n", size: 22, truncated: false } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/docs/guide.md")} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-markdown-preview] h1")?.textContent).toBe("Guide"));
    expect(container.querySelector("[data-markdown-preview] em")?.textContent).toBe("words");

    fireEvent.click(screen.getByRole("button", { name: "Show markdown source" }));
    await settle();
    expect(container.querySelector("[data-markdown-preview]")).toBeNull();
    expect(container.querySelector("[data-code-view='/root/docs/guide.md']")?.textContent).toContain("# Guide");
    expect(window.localStorage.getItem("wsp:render-markdown")).toBe("false");
  });

  it("reads a markdown file opened at a line in its source, where the line can be marked", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "# Guide\n\nline three\n", size: 20, truncated: false } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/docs/guide.md", 3)} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-code-view='/root/docs/guide.md']")).not.toBeNull());
    expect(container.querySelector("[data-markdown-preview]")).toBeNull();
    expect(screen.queryByRole("button", { name: /markdown/ })).toBeNull();
  });

  it("says when the daemon cut the read at its cap", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x".repeat(64), size: 3 * 1024 * 1024, truncated: true } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-file-truncated]")).not.toBeNull());
    expect(container.querySelector("[data-file-truncated]")?.textContent).toContain("3 MB");
  });

  it("shows a read refusal as the body", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": () => { throw new Error("/root/src/a.ts does not exist"); } }));
    render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await waitFor(() => expect(screen.getByText("/root/src/a.ts does not exist")).toBeTruthy());
  });
});

describe("open in editor, from the file tab", () => {
  it("asks the host to open a copy's file at its line on this computer", async () => {
    const openInEditor = vi.fn(async () => "zed" as const);
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local" }], api: { openInEditor } as never }));
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x\n", size: 2, truncated: false } }));
    render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts", 12)} theme="dark" />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open in editor" })));
    expect(openInEditor).toHaveBeenCalledWith(WS, "/root/src/a.ts", 12);
  });

  it("asks the host to open a running fork's file at its line, over its ssh", async () => {
    const openInEditor = vi.fn(async () => "zed" as const);
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "cloud", name: "Delete compatibility and duplicates" }], api: { openInEditor } as never }));
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x\n", size: 2, truncated: false } }));
    render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/wsp-boat/README.md", 12)} theme="dark" />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open in editor" })));
    expect(openInEditor).toHaveBeenCalledWith(WS, "/root/wsp-boat/README.md", 12);
  });

  it("hands the question of the line in the person's ssh config to the one sheet, and says nothing in place of the button", async () => {
    const openInEditor = vi.fn(async () => {
      throw new RequestError(sshIncludeLine("Delete compatibility and duplicates"), "sshInclude");
    });
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "cloud", name: "Delete compatibility and duplicates" }], api: { openInEditor } as never }));
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x\n", size: 2, truncated: false } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/wsp-boat/README.md", 12)} theme="dark" />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open in editor" })));
    expect(useSshConsent.getState().asking).toMatchObject({ workspaceId: WS, name: "Delete compatibility and duplicates" });
    expect(container.querySelector("[data-open-in-editor-said]")).toBeNull();
    act(() => useSshConsent.setState({ asking: null }));
  });

  it("says in place of the button where a napping fork's files are, naming it, and asks the host nothing", async () => {
    const openInEditor = vi.fn(async () => "zed" as const);
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "cloud", phase: "napping", name: "Delete compatibility and duplicates" }], api: { openInEditor } as never }));
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x\n", size: 2, truncated: false } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/wsp-boat/README.md")} theme="dark" />);
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(container.querySelector("[data-open-in-editor-said]")?.textContent).toBe("These files are on Delete compatibility and duplicates, so they open here.");
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("says the host's refusal in place of the button", async () => {
    const openInEditor = vi.fn(async () => {
      throw new Error("/Users/dev/Downloads/a.ts is not in this workspace's folder, so it does not open in your editor.");
    });
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local" }], api: { openInEditor } as never }));
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x\n", size: 2, truncated: false } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open in editor" })));
    expect(container.querySelector("[data-open-in-editor-said]")?.textContent).toContain("does not open in your editor");
  });
});
