// SPDX-License-Identifier: AGPL-3.0-only
// The file surface over a fake wire: fs.read feeds the code view, markdown
// renders and toggles back to source, and the 2 MB cap is announced. The
// Pierre code view is stubbed; it is a worker-backed custom element.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  File: (props: { file: { name: string; contents: string } }) => (
    <pre data-code-view={props.file.name}>{props.file.contents}</pre>
  ),
  Virtualizer: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
}));

import { FilePreviewSurface } from "../src/files/FilePreviewSurface.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { fakeWire, LISTING, resetSurfaces, WS } from "./surface-harness.js";

beforeEach(resetSurfaces);

const fileSurface = (relativePath: string) => ({ id: `file:${relativePath}` as const, kind: "file" as const, relativePath, revealLine: null, revealRequestId: 1 });
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 20)));

describe("file preview surface", () => {
  it("reads the file over the wire and shows it as code under its breadcrumbs", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "fs.read": { content: "const a = 1;\n", size: 13, truncated: false } });
    provideDaemonWire(WS, wire);
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-code-view='/root/src/a.ts']")).not.toBeNull());
    expect(wire.calls).toContainEqual(["fs.read", { path: "/root/src/a.ts" }]);
    expect(container.querySelector("[data-code-view]")?.textContent).toBe("const a = 1;\n");
    const crumbs = container.querySelector("[data-file-breadcrumbs]")!;
    expect(crumbs.textContent).toContain("api");
    expect(crumbs.textContent).toContain("src");
    expect(crumbs.textContent).toContain("a.ts");
    expect(screen.queryByRole("button", { name: /markdown/ })).toBeNull();
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

  it("says when the daemon cut the read at its cap", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": { content: "x".repeat(64), size: 3 * 1024 * 1024, truncated: true } }));
    const { container } = render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await waitFor(() => expect(container.querySelector("[data-file-truncated]")).not.toBeNull());
    expect(container.querySelector("[data-file-truncated]")?.textContent).toContain("3.0 MB");
  });

  it("shows a read refusal as the body", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "fs.read": () => { throw new Error("/root/src/a.ts does not exist"); } }));
    render(<FilePreviewSurface workspaceId={WS} surface={fileSurface("/root/src/a.ts")} theme="dark" />);
    await waitFor(() => expect(screen.getByText("/root/src/a.ts does not exist")).toBeTruthy());
  });
});
