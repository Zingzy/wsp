// SPDX-License-Identifier: AGPL-3.0-only
// Chat tab against a fixture event stream built in the @wsp/protocol
// vocabulary; shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl (hello-world server run). No live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventUnion, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatTab } from "../src/tabs/ChatTab.js";
import { ApprovalPrompt } from "../src/tabs/chat/ApprovalPrompt.js";

const WS = "ws_chat0001";
const scope = { workspaceId: WS, sessionId: "sess_0001" };

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

const FIXTURE: EventUnion[] = [
  { type: "session.start", ...scope, model: "claude-sonnet-4-5", cwd: "/root", tools: ["Bash", "Read"] },
  { type: "session.delta", ...scope, kind: "text", text: "Creating the server file, " },
  { type: "session.delta", ...scope, kind: "text", text: "then starting it." },
  {
    type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", toolUseId: "toolu_01WspFixBash1",
    text: "node /root/server.js >/dev/null 2>&1 & sleep 0.3 && curl -s http://localhost:3000",
  },
  { type: "session.delta", ...scope, kind: "tool_result", toolUseId: "toolu_01WspFixBash1", text: "Hello, World!", isError: false },
  { type: "session.delta", ...scope, kind: "thinking", text: "curl returned the greeting, so the server is live." },
  { type: "session.delta", ...scope, kind: "text", text: "Server is live at :3000." },
  { type: "session.done", ...scope, result: { status: "completed", durationMs: 10458, costUsd: 0.0187, text: "Server is live at :3000." } },
  { type: "session.end", ...scope, exitCode: 0, sawResult: true },
];

function fixtureApi(workspaces: WorkspaceView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    listSessions: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

async function setup(api: Api) {
  useStore.getState().bind(api);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  return render(<ChatTab workspaceId={WS} />);
}

describe("chat tab rendering", () => {
  it("renders the fixture conversation: deltas accumulate, tool block toggles, done footer shows cost", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    expect(screen.getByText("No session yet. Send a prompt to start one.")).toBeDefined();

    for (const e of FIXTURE) emit(e);
    // An event for another workspace never renders.
    emit({ type: "session.delta", workspaceId: "ws_other", sessionId: "s2", kind: "text", text: "alien text" });

    // Two text deltas accumulated into one block; the later message is its own block.
    expect(screen.getByText("Creating the server file, then starting it.")).toBeDefined();
    expect(screen.getByText("Server is live at :3000.")).toBeDefined();
    expect(screen.queryByText("alien text")).toBeNull();

    // Tool block: collapsed by default, expands to the result, collapses back.
    const toolHead = screen.getByRole("button", { name: /Bash/ });
    expect(toolHead.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Hello, World!")).toBeNull();
    fireEvent.click(toolHead);
    expect(screen.getByText("Hello, World!")).toBeDefined();
    fireEvent.click(toolHead);
    expect(screen.queryByText("Hello, World!")).toBeNull();

    // Thinking: muted collapsible, closed by default.
    expect(screen.queryByText(/curl returned the greeting/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "thinking" }));
    expect(screen.getByText(/curl returned the greeting/)).toBeDefined();

    // Done footer: duration + spend, and the running indicator is gone.
    expect(screen.getByText("completed")).toBeDefined();
    expect(screen.getByText(/10\.5s/)).toBeDefined();
    expect(screen.getByText(/\$0\.0187/)).toBeDefined();
    expect(screen.queryByText("working")).toBeNull();
  });

  it("renders a plain error when the session exits without a result", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope });
    expect(screen.getByText("working")).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: 137, sawResult: false });
    expect(screen.getByText("failed")).toBeDefined();
    expect(screen.getByText("session exited without a result (exit code 137)")).toBeDefined();
    expect(screen.queryByText("working")).toBeNull();
  });
});

describe("approval prompt (fixture mode: no wire event exists yet, wsp-map #22)", () => {
  it("resolves the chosen option exactly once", () => {
    const onRespond = vi.fn();
    render(
      <ApprovalPrompt
        request={{ id: "apr_1", kind: "approval", title: "Run pnpm install?", detail: "Bash wants network access.", options: ["allow", "deny"] }}
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "allow" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("apr_1", "allow");
  });
});
