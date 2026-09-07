// SPDX-License-Identifier: AGPL-3.0-only
// ChatView against a fixture event stream built in the @wsp/protocol
// vocabulary (shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl). No live daemon; the fixture api replays history and
// pushes live events through the store's subscription.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeLayout } from "./fake-layout.js";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import type { ChatThreadHandle } from "../src/components/chat/useChatThread.js";
import { CHAT_STREAM, CHAT_T0, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";
import { requestNewThread } from "../src/shell/shellRequests.js";
import { useWorkspacePreviews } from "../src/shell/workspacePreviews.js";
import { getSyntaxHighlighterPromise } from "../src/lib/syntaxHighlighting.js";

let restoreLayout: () => void = () => {};
// The fenced block's highlighter loads its wasm engine and grammar once per worker; cold, that load plus React's
// suspense reveal is 300 ms idle and outgrows the 1 s query wait under load, so it is paid here, not in a case.
beforeAll(async () => {
  restoreLayout = installFakeLayout();
  await getSyntaxHighlighterPromise("ts");
});
afterAll(() => restoreLayout());

const WS = CHAT_WS;
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const T0 = CHAT_T0;

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

// The shared stream plus one fenced code block in the closing text, so the highlighter has work.
const FIXTURE: EventUnion[] = [
  ...CHAT_STREAM.slice(0, 6),
  { type: "session.delta", ...scope, at: T0 + 9_300, kind: "text", text: "Server is live at :3000.\n\n```ts\nconst port: number = 3000;\n```\n" },
  ...CHAT_STREAM.slice(7),
];

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, sizes: [] }),
    listSessions: async () => [],
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" }),
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

/** The composer's half of a send, since ChatView alone mounts no composer: the start that follows must carry this prompt. */
const sendFrom = (thread: ChatThreadHandle | null, prompt: string) => act(() => { thread!.setSending(true); thread!.appendUserTurn(prompt, "req_view"); });

async function setup(api: Api, workspaceId = WS) {
  useStore.getState().bind(api);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<ChatView workspaceId={workspaceId} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const settledTurn = (ws: string, prompt: string, text: string, n = 1): SessionEvent[] => {
  const sc = { workspaceId: ws, sessionId: `sess_${ws}`, turnId: `turn_${ws}_${n}` };
  const start = T0 + n * 60_000;
  return [
    { type: "session.start", ...sc, at: start, model: "claude-sonnet-4-5", prompt },
    { type: "session.delta", ...sc, at: start + 300, kind: "text", text },
    { type: "session.done", ...sc, at: start + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
    { type: "session.end", ...sc, at: start + 950, exitCode: 0, sawResult: true },
  ];
};

const THREAD = "thr_lastline";
const THREADED_SCOPE = { workspaceId: WS, sessionId: "sess_lastline", turnId: "turn_lastline", threadId: THREAD };

/** One settled turn stamped with a runtime thread id, which is what a switcher card matches a recorded line on. */
const threaded = (text: string): SessionEvent[] => [
  { type: "session.start", ...THREADED_SCOPE, at: T0, model: "claude-sonnet-4-5", prompt: "add a health route" },
  { type: "session.delta", ...THREADED_SCOPE, at: T0 + 300, kind: "text", text },
  { type: "session.done", ...THREADED_SCOPE, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
  { type: "session.end", ...THREADED_SCOPE, at: T0 + 950, exitCode: 0, sawResult: true },
];

describe("ChatView", () => {
  it("shows the empty-thread headline with the workspace name before any turn", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("What should we build in api?");
    expect(screen.queryByTestId("settled-footer")).toBeNull();
  });

  it("replays the persisted transcript on mount and shows the settled footer", async () => {
    const { api } = fixtureApi([workspace], { [WS]: settledTurn(WS, "add a health route", "Added GET /health.") });
    await setup(api);
    await screen.findByText("Added GET /health.");
    expect(screen.getByText("add a health route")).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("completed");
    expect(footer.textContent).toContain("Worked for 900ms");
    expect(footer.textContent).toContain("$0.0010");
  });

  it("renders the live fixture stream: grouped tool calls, collapsed thinking, highlighted code", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    // Up to and including the thinking delta: the turn is live.
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    emit({ type: "session.delta", workspaceId: "ws_other", sessionId: "s2", kind: "text", text: "alien text" });
    await screen.findByText(/Creating the server file, then starting it\./);
    expect(screen.queryByText("alien text")).toBeNull();
    // The live row names the latest activity: the command, or the reasoning that followed it.
    expect(screen.getByText(/Working for/)).toBeDefined();
    expect(screen.getAllByText(/Ran node|Thinking|curl returned the greeting/).length).toBeGreaterThan(0);

    for (const e of FIXTURE.slice(6)) emit(e);
    // Assistant text is markdown; the fenced block is highlighted by shiki once the highlighter resolves.
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => {
      const shiki = document.querySelector(".chat-markdown-shiki");
      expect(shiki?.innerHTML ?? "").toContain('<span style="color:');
    });
    expect(screen.queryByText(/Working for/)).toBeNull();

    // A settled turn folds its work behind one line; the fold opens onto the grouped tool calls.
    const fold = screen.getByRole("button", { name: /Worked for 10s/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Ran 1 command/ })).toBeNull();
    fireEvent.click(fold);
    const toggle = screen.getByRole("button", { name: /Ran 1 command/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Hello, World!")).toBeNull();
    await act(async () => { fireEvent.click(toggle); });
    const group = await screen.findByRole("region", { name: "Tool calls" });
    const bashRow = within(group).getByRole("button", { name: /node \/root\/server\.js/ });
    expect(bashRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bashRow);
    expect(within(group).getByText(/Hello, World!/)).toBeDefined();
    // Reasoning survives the settle as a row of its own; this one fits its preview, so there is nothing more to open.
    expect(within(group).getAllByText(/curl returned the greeting/)).toHaveLength(1);
    expect(within(group).queryByRole("button", { name: /curl returned the greeting/ })).toBeNull();

    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("Worked for 10s");
    expect(footer.textContent).toContain("$0.02");
  });

  it("shows the working row while a turn runs and an error when it exits without a result", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    expect(screen.getByText(/Working/)).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: 137, sawResult: false });
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
    expect(screen.getByText(/session exited without a result \(exit code 137\)/i)).toBeDefined();
  });

  it("a session the runtime ended for a nap shows its reason as the last row and settles the thread", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "Starting on it." });
    expect(screen.getByText(/Working/)).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: null, sawResult: false, reason: "machine paused while the agent was working" });
    expect(screen.queryByText(/Working for/)).toBeNull();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")];
    expect(rows.at(-1)?.textContent).toMatch(/machine paused while the agent was working/i);
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
  });

  it("a turn in flight on a paused workspace waits for the machine with a Wake that calls the wake op; unreachable waits without one", async () => {
    const wakes: string[] = [];
    const { api, emit } = fixtureApi([workspace]);
    api.wake = async id => { wakes.push(id); return workspace; };
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    expect(screen.getByText(/Working/)).toBeDefined();
    const status = { ...workspace, machineState: "paused" as const, reach: { state: "napping" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
    emit({ type: "workspace.status", status: { ...status, phase: "pausing" } });
    await screen.findByText("Waiting for the machine to wake");
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
    emit({ type: "workspace.napped", workspaceId: WS });
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await waitFor(() => expect(wakes).toEqual([WS]));
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    await screen.findByText("Waking the machine");
    expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
    emit({ type: "workspace.woken", workspaceId: WS, machineId: "m1", resurrected: false });
    emit({ type: "workspace.status", status: { ...status, phase: "running", machineState: "running", reach: { state: "unreachable" } } });
    await screen.findByText("Waiting for the machine to answer");
    expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
    emit({ type: "workspace.status", status: { ...status, phase: "running", machineState: "running", reach: { state: "reachable" } } });
    await screen.findByText(/Working/);
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it("clears to the empty headline on a new-thread request and shows the fresh turn that follows", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: settledTurn(WS, "add a health route", "Added GET /health.") });
    const handle: { current: ChatThreadHandle | null } = { current: null };
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => { handle.current = thread; return null; }}</ChatView>);
    await screen.findByText("Added GET /health.");
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.queryByText("Added GET /health.")).toBeNull();
    sendFrom(handle.current, "second thread");
    for (const e of settledTurn(WS, "second thread", "Second answer.", 2)) emit(e);
    await screen.findByText("Second answer.");
    expect(screen.getByText("second thread")).toBeDefined();
    expect(screen.queryByText("Added GET /health.")).toBeNull();
  });

  it("keeps a new-thread request that lands before the history reply", async () => {
    const { api } = fixtureApi([workspace]);
    let release: (events: SessionEvent[]) => void = () => {};
    api.sessionHistory = () => new Promise<SessionEvent[]>(resolve => { release = resolve; });
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => <span data-testid="fresh">{String(thread.fresh)}</span>}</ChatView>);
    expect(screen.getByText("loading transcript")).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    act(() => release(settledTurn(WS, "add a health route", "Added GET /health.")));
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.queryByText("Added GET /health.")).toBeNull();
    expect(screen.getByTestId("fresh").textContent).toBe("true");
  });

  it("honours a new-thread request raised for a workspace whose chat was not mounted yet", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "beta" };
    const { api } = fixtureApi([workspace, other], {
      [WS]: settledTurn(WS, "alpha prompt", "Alpha answer."),
      [other.id]: settledTurn(other.id, "beta prompt", "Beta answer."),
    });
    const view = await setup(api);
    await screen.findByText("Alpha answer.");
    // The palette selects the workspace and requests in one handler, before beta's chat exists.
    act(() => requestNewThread({ workspaceId: other.id }));
    expect(screen.getByText("Alpha answer.")).toBeDefined();
    view.rerender(<ChatView workspaceId={other.id} />);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    expect(screen.queryByText("Beta answer.")).toBeNull();
    // Taken once: mounting alpha again shows alpha's transcript.
    view.rerender(<ChatView workspaceId={WS} />);
    await screen.findByText("Alpha answer.");
  });

  it("drops the left turn's remaining events after a new thread is requested mid-turn and is never busy for it", async () => {
    const { api, emit } = fixtureApi([workspace]);
    const handle: { current: ChatThreadHandle | null } = { current: null };
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => { handle.current = thread; return <span data-testid="busy">{String(thread.busy)}</span>; }}</ChatView>);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    await screen.findByText(/Creating the server file, then starting it\./);
    expect(screen.getByTestId("busy").textContent).toBe("true");
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.getByTestId("busy").textContent).toBe("false");
    for (const e of FIXTURE.slice(6)) emit(e);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    expect(screen.getByTestId("busy").textContent).toBe("false");
    sendFrom(handle.current, "start over");
    const fresh = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002" };
    emit({ type: "session.start", ...fresh, at: T0 + 100_000, prompt: "start over" });
    emit({ type: "session.delta", ...fresh, at: T0 + 100_500, kind: "text", text: "Fresh start." });
    await screen.findByText("Fresh start.");
    expect(screen.getByText("start over")).toBeDefined();
  });

  it("a running turn in the history reply of a pre-mount request is not the new thread's: the view stays empty and is never busy for it", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "beta" };
    const beta = { workspaceId: other.id, sessionId: "sess_beta", turnId: "turn_beta" };
    const betaHistory: SessionEvent[] = [
      { type: "session.start", ...beta, at: T0, model: "claude-sonnet-4-5", prompt: "beta prompt" },
      { type: "session.delta", ...beta, at: T0 + 300, kind: "text", text: "Beta is thinking about it." },
    ];
    const { api, emit } = fixtureApi([workspace, other], { [WS]: settledTurn(WS, "alpha prompt", "Alpha answer."), [other.id]: betaHistory });
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    const view = render(<ChatView workspaceId={WS}>{thread => <span data-testid="busy">{String(thread.busy)}</span>}</ChatView>);
    await screen.findByText("Alpha answer.");
    act(() => requestNewThread({ workspaceId: other.id }));
    view.rerender(<ChatView workspaceId={other.id}>{thread => <span data-testid="busy">{String(thread.busy)}</span>}</ChatView>);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    expect(screen.getByTestId("busy").textContent).toBe("false");
    emit({ type: "session.delta", ...beta, at: T0 + 600, kind: "text", text: " and the beta tail." });
    emit({ type: "session.done", ...beta, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/beta tail/)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    expect(screen.getByTestId("busy").textContent).toBe("false");
    emit({ type: "session.end", ...beta, at: T0 + 950, exitCode: 0, sawResult: true });
    expect(screen.getByTestId("busy").textContent).toBe("false");
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
  });

  it("records nothing as it draws: the previews store is the shell's pictures alone", async () => {
    const held = useWorkspacePreviews.getState();
    expect(Object.keys(held)).toEqual(["images", "setImages"]);
    const { api, emit } = fixtureApi([workspace], { [WS]: threaded("Ran the gate.\n\nAll 12 tests green.\n") });
    await setup(api);
    await screen.findByText(/All 12 tests green\./);
    // A whole transcript drawn and a turn streaming over it: the store the switcher reads is not written to once.
    emit({ type: "session.delta", ...THREADED_SCOPE, at: T0 + 120_000, kind: "text", text: "\nBumped the lockfile.\n" });
    await waitFor(() => expect(screen.getAllByText(/Bumped the lockfile\./).length).toBeGreaterThan(0));
    expect(useWorkspacePreviews.getState()).toBe(held);
  });

  it("virtualizes a long transcript instead of mounting every row", async () => {
    const turns = 300;
    const history = Array.from({ length: turns }, (_, i) => settledTurn(WS, `prompt ${i}`, `answer ${i}`, i)).flat();
    const { api } = fixtureApi([workspace], { [WS]: history });
    await setup(api);
    await screen.findByText("answer 299");
    const mounted = document.querySelectorAll("[data-timeline-root]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(turns);
  });
});
