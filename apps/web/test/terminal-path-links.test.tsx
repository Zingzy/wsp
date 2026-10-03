// SPDX-License-Identifier: AGPL-3.0-only
// A modifier-click on a link in a terminal: a path opens as its own tab in the
// Files pane at the line it names, read against the folder the workspace's
// shells open in, and a URL still opens in a new browser tab. The surface is
// stubbed to hand over the options it was built with, so the click is the one
// the real surface raises with the text under the pointer.
import { act, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ options: null as null | { onLinkActivate: (text: string, event: Pick<MouseEvent, "metaKey" | "ctrlKey">) => void } }));
vi.mock("../src/terminal/ghostty/surface.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/terminal/ghostty/surface.js")>()),
  GhosttyTerminalSurface: {
    create: async (_mount: HTMLElement, options: NonNullable<typeof built.options>) => {
      built.options = options;
      return new Proxy({}, { get: (_target, key) => (key === "translucent" ? false : () => undefined) });
    },
  },
}));

import ThreadTerminalDrawer from "../src/components/ThreadTerminalDrawer.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { useTerminalViewportConfig } from "../src/terminal/fontSetting.js";
import { useStore } from "../src/protocol/store.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
beforeAll(() => Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true }));
afterAll(() => {
  delete (navigator as { platform?: string }).platform;
  if (platform) Object.defineProperty(Navigator.prototype, "platform", platform);
});
beforeEach(() => {
  resetSurfaces();
  built.options = null;
});

function Drawer() {
  const config = useTerminalViewportConfig(WS);
  return (
    <ThreadTerminalDrawer
      mode="panel"
      workspaceId={WS}
      height={0}
      terminalIds={["p1"]}
      activeTerminalId="p1"
      terminalGroups={[{ id: "g1", terminalIds: ["p1"] }]}
      activeTerminalGroupId="g1"
      focusRequestId={0}
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={() => {}}
      onHeightChange={() => {}}
      terminalIo={() => ({ attach: () => () => {}, write: () => {}, resize: () => {} })}
      terminalConfig={config}
    />
  );
}

const CMD = { metaKey: true, ctrlKey: false };
const panel = () => useRightPanelStore.getState().byWorkspaceId[WS];

describe("a link clicked in a terminal", () => {
  it("opens a path as a Files tab at its line, read against the folder the shells open in", async () => {
    render(<Drawer />);
    await waitFor(() => expect(built.options).not.toBeNull());
    act(() => built.options!.onLinkActivate("apps/web/src/panes.ts:12", CMD));
    expect(panel()?.activeSurfaceId).toBe("file:/root/apps/web/src/panes.ts");
    expect(panel()?.surfaces.at(-1)).toMatchObject({ kind: "files", path: "/root/apps/web/src/panes.ts", line: 12 });
    act(() => built.options!.onLinkActivate("./src/../README.md", CMD));
    expect(panel()?.surfaces.at(-1)).toMatchObject({ kind: "files", path: "/root/README.md", line: null });
  });

  it("reads a path against a worktree's own folder, where its shells open and its turns run, never the project folder", async () => {
    act(() => useStore.setState({ workspaces: [{ ...view, kind: "local", worktree: { path: "/Users/dev/wsp-codex-reviews", branch: "codex/reviews", made: true }, folder: "/Users/dev/wsp-codex-reviews" } as never] }));
    render(<Drawer />);
    await waitFor(() => expect(built.options).not.toBeNull());
    act(() => built.options!.onLinkActivate("apps/web/src/panes.ts:12", CMD));
    expect(panel()?.surfaces.at(-1)).toMatchObject({ kind: "files", path: "/Users/dev/wsp-codex-reviews/apps/web/src/panes.ts", line: 12 });
  });

  it("does nothing without the modifier, and opens a URL in a new browser tab rather than the Files pane", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Drawer />);
    await waitFor(() => expect(built.options).not.toBeNull());
    act(() => built.options!.onLinkActivate("apps/web/src/panes.ts:12", { metaKey: false, ctrlKey: false }));
    expect(panel()).toBeUndefined();
    act(() => built.options!.onLinkActivate("https://example.com/x", CMD));
    expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener,noreferrer");
    expect(panel()).toBeUndefined();
    open.mockRestore();
  });
});
