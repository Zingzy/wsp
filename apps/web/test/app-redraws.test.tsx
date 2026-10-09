// SPDX-License-Identifier: AGPL-3.0-only
// The app's own hooks read the window's title mark and the dock's count off every workspace's rows, so a prompt that
// opens or closes anywhere draws the app again. The shell under it, the sidebar, the centre and the panel with a slate
// in it, has nothing new to draw for that: under a 198-workspace load each such draw landed in the middle of a scroll.
import { act, render } from "@testing-library/react";
import { NEEDS_YOU_MARK, type SessionView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/protocol/store.js";
import { ScriptedSocket } from "./scripted-socket.js";

const shellDraws = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/shell/AppShell.js", () => ({
  AppShell: () => {
    shellDraws.count += 1;
    return null;
  },
}));

const { App } = await import("../src/App.js");

const row = (asking?: string): SessionView => ({
  id: "s_lab",
  workspaceId: "ws_lab",
  threadId: "thr_lab",
  harness: "claude",
  status: "running",
  startedBy: "agent",
  prompt: "Build: ticket 1",
  harnessTitle: "Build: ticket 1",
  startedAt: Date.now() - 60_000,
  ...(asking === undefined ? {} : { asking }),
});

beforeEach(() => {
  ScriptedSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", ScriptedSocket);
  shellDraws.count = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({ sessions: {} });
  document.body.innerHTML = "";
});

describe("the app under its own hooks", () => {
  it("leaves the shell undrawn when a permission prompt opens and closes", () => {
    document.title = "wsp";
    useStore.setState({ sessions: { ws_lab: [row()] } });
    render(<App wsUrl="ws://test" token="tok" />);
    const drawn = shellDraws.count;
    act(() => useStore.setState({ sessions: { ws_lab: [row("Bash: pnpm test")] } }));
    expect(document.title.startsWith(NEEDS_YOU_MARK)).toBe(true);
    act(() => useStore.setState({ sessions: { ws_lab: [row()] } }));
    expect(document.title.startsWith(NEEDS_YOU_MARK)).toBe(false);
    expect(shellDraws.count).toBe(drawn);
  });
});
