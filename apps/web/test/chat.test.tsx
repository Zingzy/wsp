// SPDX-License-Identifier: AGPL-3.0-only
// Chat tab against a fixture event stream built in the @wsp/protocol
// vocabulary; shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl (hello-world server run). No live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatTab } from "../src/tabs/ChatTab.js";
import { ApprovalPrompt } from "../src/tabs/chat/ApprovalPrompt.js";

const WS = "ws_chat0001";
const CLAUDE_SID = "e16ed170-8257-4668-879e-fe836341633c";
const scope = { workspaceId: WS, sessionId: "sess_0001" };

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: CLAUDE_SID,
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

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string }> = [];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true }),
    listSessions: async () => [],
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit };
}

async function setup(api: Api) {
  useStore.getState().bind(api);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<ChatTab workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
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

describe("chat tab hydration", () => {
  const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "web", claudeSessionId: undefined };
  const replay = (ws: string, prompt: string, text: string): SessionEvent[] => {
    const sc = { workspaceId: ws, sessionId: `sess_${ws}` };
    return [
      { type: "session.start", ...sc, model: "claude-sonnet-4-5", prompt },
      { type: "session.delta", ...sc, kind: "text", text },
      { type: "session.done", ...sc, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
      { type: "session.end", ...sc, exitCode: 0, sawResult: true },
    ];
  };

  it("replays the persisted transcript on mount, user turn included, and again on workspace switch", async () => {
    const { api } = fixtureApi([workspace, other], {
      [WS]: replay(WS, "add a health route", "Added GET /health."),
      [other.id]: replay(other.id, "bump react", "React is on 19.1."),
    });
    const view = await setup(api);
    await screen.findByText("Added GET /health.");
    expect(screen.getByText("add a health route")).toBeDefined();
    expect(screen.queryByText("No session yet. Send a prompt to start one.")).toBeNull();
    expect(screen.queryByText("working")).toBeNull();

    view.rerender(<ChatTab workspaceId={other.id} />);
    await screen.findByText("React is on 19.1.");
    expect(screen.getByText("bump react")).toBeDefined();
    expect(screen.queryByText("Added GET /health.")).toBeNull();
  });

  it("live events keep landing after hydration and the composer follows the replayed state", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: replay(WS, "first", "one.") });
    await setup(api);
    await screen.findByText("one.");
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    emit({ type: "session.start", ...scope });
    emit({ type: "session.delta", ...scope, kind: "text", text: "two." });
    expect(screen.getByText("two.")).toBeDefined();
    expect(input.disabled).toBe(true);
  });
});

describe("chat tab composer", () => {
  it("enter sends exactly one turn with resume, disables while in flight, re-enables on done", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "fix the flaky test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "fix the flaky test", resume: CLAUDE_SID });

    // Local echo of the user turn; composer disabled with the reason shown.
    expect(screen.getByText("fix the flaky test")).toBeDefined();
    expect(input.disabled).toBe(true);
    expect(screen.getByText("turn in flight")).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(started.length).toBe(1);

    emit({ type: "session.start", ...scope });
    expect(input.disabled).toBe(true);
    emit({ type: "session.done", ...scope, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", ...scope, exitCode: 0, sawResult: true });
    expect(input.disabled).toBe(false);
    expect(started.length).toBe(1);
  });

  it("restores the draft and re-enables when startSession rejects", async () => {
    const { api } = fixtureApi([workspace]);
    api.startSession = async () => { throw new Error("workspace is napping"); };
    await setup(api);
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "fix the flaky test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("workspace is napping")).toBeDefined());
    expect(screen.getByText("failed")).toBeDefined();
    expect(input.value).toBe("fix the flaky test");
    expect(input.disabled).toBe(false);
  });

  it("ignores empty and whitespace-only drafts", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const input = screen.getByRole("textbox", { name: "prompt" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(started.length).toBe(0);
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
