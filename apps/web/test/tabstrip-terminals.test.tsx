// SPDX-License-Identifier: AGPL-3.0-only
// Terminal tabs live in the top-level strip: one tab per pty from the
// workspace's WorkspaceTerminals, a + to open more, the link state at the
// right end. Real in-process daemon through the harness; WebGL mocked (jsdom).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabStrip } from "../src/components/TabStrip.js";
import { useStore } from "../src/protocol/store.js";
import { boot, teardown, WS_ID } from "./terminal-harness.js";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): { dispose(): void } {
      return { dispose() {} };
    }
  },
}));

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: WS_ID, sessions: {}, ready: true });
});
afterEach(async () => {
  cleanup();
  await teardown();
});

const ptyTabs = () => screen.getAllByRole("tab").filter(t => t.hasAttribute("data-pty"));

describe("terminal tabs in the strip", () => {
  it("shows a bare terminal tab before any pty, then one tab per pty once the first opens", async () => {
    const { wt, daemon } = await boot();
    render(<TabStrip />);
    expect(screen.getByRole("tab", { name: "terminal" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    await waitFor(() => expect(ptyTabs()).toHaveLength(1), { timeout: 10_000 });
    expect(screen.queryByRole("tab", { name: "terminal" })).toBeNull();
    expect(ptyTabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(ptyTabs()[0]!.textContent).toContain(wt.tabs()[0]!.title);
    expect(document.querySelector(".xterm")).not.toBeNull();
  }, 15_000);

  it("tab-away parks the terminal (pty alive, xterm gone) and the pty tab brings it back", async () => {
    const { wt, daemon } = await boot();
    render(<TabStrip />);
    await waitFor(() => expect(wt.sinkCount()).toBe(1), { timeout: 10_000 });

    fireEvent.click(screen.getByRole("tab", { name: "screen" }));
    expect(wt.sinkCount()).toBe(0);
    expect(document.querySelector(".xterm")).toBeNull();
    expect(daemon.ptys.list()).toHaveLength(1);

    fireEvent.click(ptyTabs()[0]!);
    await waitFor(() => expect(wt.sinkCount()).toBe(1), { timeout: 10_000 });
    expect(daemon.ptys.list()).toHaveLength(1);
  }, 15_000);

  it("+ opens a second pty as its own tab and makes it active", async () => {
    const { wt, daemon } = await boot();
    render(<TabStrip />);
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    fireEvent.click(screen.getByLabelText("new terminal"));
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(2), { timeout: 10_000 });
    await waitFor(() => expect(ptyTabs()).toHaveLength(2), { timeout: 10_000 });
    const second = daemon.ptys.list()[1]!.id;
    expect(wt.activeId()).toBe(second);
    expect(ptyTabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(ptyTabs()[0]!.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(ptyTabs()[0]!);
    expect(wt.activeId()).toBe(daemon.ptys.list()[0]!.id);
  }, 15_000);

  it("closing the last pty leaves the bare terminal tab and never respawns", async () => {
    const { daemon } = await boot();
    render(<TabStrip />);
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    fireEvent.click(await screen.findByLabelText(/^close /));
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(0), { timeout: 10_000 });
    await new Promise(r => setTimeout(r, 250));
    expect(daemon.ptys.list()).toHaveLength(0);
    screen.getByRole("tab", { name: "terminal" });
    screen.getByText("no terminals");
  }, 15_000);

  it("renders the link state at the strip's edge: live dot, reconnecting, reauth banner", async () => {
    const { wt } = await boot();
    render(<TabStrip />);
    await screen.findByTitle("connected");

    act(() => wt.feedStatus("connecting"));
    screen.getByText("reconnecting");
    expect(screen.queryByTitle("connected")).toBeNull();

    act(() => wt.feedStatus("reauth-needed"));
    screen.getByText("auth expired");
    screen.getByText(/rejected this workspace/);

    act(() => wt.feedStatus("live"));
    await screen.findByTitle("connected");
  }, 15_000);
});
