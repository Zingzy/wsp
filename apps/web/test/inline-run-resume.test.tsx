// SPDX-License-Identifier: AGPL-3.0-only
// A run the thread records running, drawn by a page that just loaded: the workspace's terminal link comes live after
// the block mounted, and the block takes its pty back then.
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRunEvent } from "@wsp/protocol";
import { InlineRun } from "../src/components/chat/InlineRun.js";
import { useStore } from "../src/protocol/store.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";

vi.mock("../src/components/ThreadTerminalDrawer.js", () => ({
  TerminalViewport: ({ terminalId }: { terminalId: string }) => <div data-terminal-viewport={terminalId} />,
}));

afterEach(() => {
  provideTerminals("ws_a", null);
  useStore.setState({ api: null } as never);
});

const running: SessionRunEvent = { type: "session.run", workspaceId: "ws_a", sessionId: "s", threadId: "th_1", turnId: "turn_1", runId: "run-live", block: "b", command: "sudo true", state: "running", ptyId: "pty_2" };

describe("a live run on a page that just loaded", () => {
  it("takes its pty back once the workspace's terminal link comes live, however late", async () => {
    useStore.setState({ api: { recordRun: async () => ({}) } } as never);
    const wire: TerminalWire = {
      request: async op => (op === "pty.list" ? { ptys: [{ id: "pty_2", pid: 2, cols: 80, rows: 24, exited: false, reply: true }] } : { ok: true }),
    };
    const { container } = render(<InlineRun run={running} />);
    const wt = new WorkspaceTerminals(wire);
    provideTerminals("ws_a", wt);
    expect(container.querySelector("[data-terminal-viewport]")).toBeNull();
    wt.feedStatus("live");
    await waitFor(() => expect(container.querySelector("[data-terminal-viewport]")?.getAttribute("data-terminal-viewport")).toBe("pty_2"));
  });
});
