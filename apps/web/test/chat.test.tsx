// SPDX-License-Identifier: AGPL-3.0-only
// The workspace thread against a fixture event stream built in the
// @wsp/protocol vocabulary; shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl (hello-world server run). No live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, isEditable, press, typeInto } from "./composer-harness.js";
import type { EventUnion, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";
import { useSelectedThreadId, useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { requestNewThread } from "../src/shell/shellRequests.js";
import { CHAT_STREAM, CHAT_T0, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));

const WS = CHAT_WS;
const CLAUDE_SID = "e16ed170-8257-4668-879e-fe836341633c";
const T0 = CHAT_T0;
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: CLAUDE_SID,
};

const FIXTURE: ReadonlyArray<EventUnion> = CHAT_STREAM;

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}, rows: SessionView[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string }> = [];
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
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
    listSessions: async id => (id === undefined ? rows : rows.filter(r => r.workspaceId === id)),
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: T0 };
    },
    interruptSession: async () => "accepted",
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit };
}

/** The center slot as the shell mounts it: the thread the store selects, so a pin the view moves reaches the mount. */
function Selected() {
  return <WorkspaceThread workspaceId={WS} threadId={useSelectedThreadId()} />;
}

async function setup(api: Api, threadId: string | null = null) {
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  useStore.getState().select(WS, threadId);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<Selected />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const sendButton = () => screen.getByRole("button", { name: /Send message|Turn in flight|Finishing the previous turn/ }) as HTMLButtonElement;
/** While a turn runs, stop stands where send was; the status row carries the reason. */
const stopButton = () => screen.getByRole("button", { name: "Stop generation" }) as HTMLButtonElement;

describe("chat tab rendering", () => {
  it("mounts the thread view: empty headline first, then the fixture conversation with its settled footer", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");

    for (const e of FIXTURE) emit(e);
    // An event for another workspace never renders.
    emit({ type: "session.delta", workspaceId: "ws_other", sessionId: "s2", kind: "text", text: "alien text" });

    // The settled turn folds everything before its final answer behind one line.
    await screen.findByText(/Server is live at :3000\./);
    expect(screen.queryByText(/Creating the server file, then starting it\./)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worked for 10s/ }));
    expect(screen.getByText(/Creating the server file, then starting it\./)).toBeDefined();
    expect(screen.queryByText("alien text")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("completed");
    expect(footer.textContent).toContain("Worked for 10s");
    expect(footer.textContent).toContain("$0.02");
    expect(screen.queryByText(/Working for/)).toBeNull();
  });

  it("renders a plain error when the session exits without a result", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    expect(screen.getByText(/Working/)).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: 137, sawResult: false });
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
    expect(screen.getByText(/session exited without a result \(exit code 137\)/i)).toBeDefined();
    expect(screen.queryByText(/Working for/)).toBeNull();
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
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText(/Working for/)).toBeNull();

    view.rerender(<WorkspaceThread workspaceId={other.id} />);
    await screen.findByText("React is on 19.1.");
    expect(screen.getByText("bump react")).toBeDefined();
    expect(screen.queryByText("Added GET /health.")).toBeNull();
  });

  it("a replay gap reloads the transcript from history: a turn that ended in the dark frees the composer", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: replay(WS, "first", "one.").slice(0, 2) };
    const { api, emit } = fixtureApi([workspace], history);
    const fetches = vi.fn(api.sessionHistory);
    api.sessionHistory = fetches;
    await setup(api);
    await screen.findByText("one.");
    expect(stopButton()).toBeDefined();
    expect(fetches).toHaveBeenCalledTimes(1);

    history[WS] = replay(WS, "first", "one.");
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe("Send message"));
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(screen.getByText("one.")).toBeDefined();
    expect(screen.queryByText(/Working for/)).toBeNull();
    // Live events land again once the reload is in.
    emit({ type: "session.start", ...scope });
    expect(stopButton()).toBeDefined();
  });

  it("a replay gap while finishing the previous turn: history shows that turn ended, so the composer opens", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [] };
    const { api, emit, started } = fixtureApi([workspace], history);
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    act(() => requestNewThread({ workspaceId: WS }));
    const editor = composerEditor();
    expect(isEditable(editor)).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Finishing the previous turn");

    // The turn ended while the socket was down for longer than the runtime replays.
    history[WS] = [...FIXTURE] as SessionEvent[];
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(isEditable(editor)).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    await typeInto(editor, "start over");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
  });

  it("a replay gap while finishing the previous turn keeps the composer closed when history shows it still running", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [] };
    const { api, emit } = fixtureApi([workspace], history);
    const fetches = vi.fn(api.sessionHistory);
    api.sessionHistory = fetches;
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    act(() => requestNewThread({ workspaceId: WS }));
    const editor = composerEditor();

    history[WS] = FIXTURE.slice(0, 7) as SessionEvent[];
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(fetches).toHaveBeenCalledTimes(2));
    await act(() => new Promise(r => setTimeout(r, 0)));
    expect(isEditable(editor)).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Finishing the previous turn");
    for (const e of FIXTURE.slice(7)) emit(e);
    expect(isEditable(editor)).toBe(true);
  });

  it("live events keep landing after hydration and the send button follows the replayed state", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: replay(WS, "first", "one.") });
    await setup(api);
    await screen.findByText("one.");
    expect(isEditable(composerEditor())).toBe(true);
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    emit({ type: "session.start", ...scope });
    emit({ type: "session.delta", ...scope, kind: "text", text: "two." });
    expect(screen.getByText("two.")).toBeDefined();
    // The editor stays open for the next prompt; only sending waits for the turn.
    expect(isEditable(composerEditor())).toBe(true);
    expect(stopButton()).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("chat tab composer", () => {
  it("enter sends exactly one turn with resume, queues the next while in flight, and sends it on done", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();

    await typeInto(editor, "fix the flaky test");
    expect(editor.textContent).toBe("fix the flaky test");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "fix the flaky test", resume: CLAUDE_SID, cwd: "/root" });

    // Local echo of the user turn; the draft is gone and the send button says why it waits.
    expect(screen.getByText("fix the flaky test")).toBeDefined();
    expect(editor.textContent).toBe("");
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
    await typeInto(editor, "again");
    await press(editor, "Enter");
    expect(started.length).toBe(1);
    expect(editor.textContent).toBe("");
    expect((screen.getByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement).value).toBe("again");

    emit({ type: "session.start", ...scope });
    expect(stopButton()).toBeDefined();
    emit({ type: "session.done", ...scope, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", ...scope, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "again", resume: "sess_0001", cwd: "/root" });
    expect(screen.queryByRole("textbox", { name: "Queued message" })).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
  });

  it("restores the draft and re-enables when startSession rejects", async () => {
    const { api } = fixtureApi([workspace]);
    api.startSession = async () => { throw new Error("workspace is napping"); };
    await setup(api);
    const editor = composerEditor();

    await typeInto(editor, "fix the flaky test");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.getByText(/workspace is napping/i)).toBeDefined());
    expect(editor.textContent).toBe("fix the flaky test");
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    expect(sendButton().disabled).toBe(false);
  });

  it("ignores empty and whitespace-only drafts", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await press(editor, "Enter");
    await typeInto(editor, "   ");
    await press(editor, "Enter");
    expect(started.length).toBe(0);
    expect(sendButton().disabled).toBe(true);
  });
});

describe("chat tab send after a harness died before its init", () => {
  // The runtime stamps the thread it minted on every event of a turn, the done and end of one whose harness died before init included; no session.start ever carries this id.
  const dead = { workspaceId: WS, sessionId: "9b2a7c1e-0d4f-4a6b-8e3c-5f7a9d1b2c3e", turnId: "turn_dead", threadId: "thr_dead" };
  const DEATH: SessionEvent[] = [
    { type: "session.done", ...dead, result: { status: "failed", error: "claude exited before init (exit code 1)" } },
    { type: "session.end", ...dead, exitCode: 1, sawResult: true },
  ];
  const retry = { workspaceId: WS, sessionId: "sess_retry", turnId: "turn_retry", threadId: "thr_retry" };
  const RETRY: SessionEvent[] = [
    { type: "session.start", ...retry, prompt: "again" },
    { type: "session.delta", ...retry, kind: "text", text: "Second time lucky." },
    { type: "session.done", ...retry, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
    { type: "session.end", ...retry, exitCode: 0, sawResult: true },
  ];
  const STARTED: SessionEvent[] = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" }));
  // Another client's send on the same workspace: a thread this tab never queued a row in.
  const other = { workspaceId: WS, sessionId: "sess_other", turnId: "turn_other", threadId: "thr_other" };
  const OTHER: SessionEvent[] = [
    { type: "session.start", ...other, prompt: "from another tab" },
    { type: "session.delta", ...other, kind: "text", text: "Elsewhere." },
    { type: "session.done", ...other, result: { status: "completed", durationMs: 500, costUsd: 0.001 } },
    { type: "session.end", ...other, exitCode: 0, sawResult: true },
  ];
  const queueOf = (key: string) => (useComposerDraftStore.getState().queues[key] ?? []).map(r => r.prompt);

  it("on a workspace with no thread yet, the next send carries no resume, and the thread the runtime mints for it lands in the view", async () => {
    const bare: WorkspaceView = { ...workspace, claudeSessionId: undefined };
    const { api, started, emit } = fixtureApi([bare]);
    await setup(api);
    const editor = composerEditor();

    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "hello", cwd: "/root" });

    for (const e of DEATH) emit(e);
    expect(screen.getByText(/exited before init/)).toBeDefined();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");

    await typeInto(editor, "again");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "again", cwd: "/root" });
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");

    for (const e of RETRY) emit(e);
    expect(screen.getByText("Second time lucky.")).toBeDefined();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });

  it("a dead new thread read back from history starts fresh: the workspace's remembered session is not resumed into it", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: [...STARTED, ...DEATH] });
    await setup(api);
    await screen.findByText(/exited before init/);
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    const editor = composerEditor();

    await typeInto(editor, "again");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "again", cwd: "/root" });
  });

  it("pinned from the sidebar, a dead thread's next send carries no resume; the view and the pin follow the thread the runtime mints, and a reload after the follow keeps it, its queued row included", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...DEATH, ...STARTED] };
    // The runtime stamps a row's session id only when the harness announces one, so the dead row has none to resume.
    const deadRow: SessionView = { id: dead.sessionId, workspaceId: WS, harness: "claude", status: "failed", threadId: "thr_dead", prompt: "hello", startedAt: T0 };
    const { api, started, emit } = fixtureApi([workspace], history, [deadRow]);
    // The runtime records an event before it pushes it, so a reload after the follow finds the retry in the reply.
    const record = (e: SessionEvent) => { history[WS] = [...history[WS]!, e]; emit(e); };
    const queued = () => (screen.getByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement).value;
    await setup(api, "thr_dead");
    await screen.findByText(/exited before init/);
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    const editor = composerEditor();

    await typeInto(editor, "again");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "again", cwd: "/root" });
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
    await typeInto(editor, "and then this");
    await press(editor, "Enter");
    expect(useComposerDraftStore.getState().queues["thr_dead"]?.map(r => r.prompt)).toEqual(["and then this"]);

    record(RETRY[0]!);
    expect(useStore.getState().selectedThreadId).toBe("thr_retry");
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(stopButton()).toBeDefined();
    expect(useComposerDraftStore.getState().queues["thr_retry"]?.map(r => r.prompt)).toEqual(["and then this"]);
    expect(queued()).toBe("and then this");
    record(RETRY[1]!);
    expect(screen.getByText("Second time lucky.")).toBeDefined();

    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByText("Second time lucky.")).toBeDefined();
    expect(screen.queryByText(/exited before init/)).toBeNull();
    expect(stopButton()).toBeDefined();
    expect(queued()).toBe("and then this");

    for (const e of RETRY.slice(2)) record(e);
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "and then this", resume: "sess_retry", cwd: "/root" });
  });

  it("on the latest view of a dead thread, another client's start during the send is kept out; the start carrying the sent prompt is the person's own and takes the queued row", async () => {
    const { api, started, emit } = fixtureApi([workspace], { [WS]: [...STARTED, ...DEATH] });
    await setup(api);
    await screen.findByText(/exited before init/);
    const editor = composerEditor();

    await typeInto(editor, "again");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    await typeInto(editor, "and then this");
    await press(editor, "Enter");
    expect(queueOf(WS)).toEqual(["and then this"]);

    for (const e of OTHER.slice(0, 2)) emit(e);
    expect(screen.queryByText("Elsewhere.")).toBeNull();
    expect(screen.getByText("again")).toBeDefined();
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
    expect(queueOf(WS)).toEqual(["and then this"]);
    expect(queueOf("thr_other")).toEqual([]);

    for (const e of RETRY.slice(0, 2)) emit(e);
    expect(stopButton()).toBeDefined();
    expect(screen.getByText("Second time lucky.")).toBeDefined();
    expect(queueOf("thr_retry")).toEqual(["and then this"]);

    for (const e of OTHER.slice(2)) emit(e);
    expect(stopButton()).toBeDefined();
    expect(started.length).toBe(1);

    for (const e of RETRY.slice(2)) emit(e);
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "and then this", resume: "sess_retry", cwd: "/root" });
  });

  it("pinned to a dead thread, another client's start during the send moves neither the pin nor the queued row; the start carrying the sent prompt moves both", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...DEATH, ...STARTED] };
    const deadRow: SessionView = { id: dead.sessionId, workspaceId: WS, harness: "claude", status: "failed", threadId: "thr_dead", prompt: "hello", startedAt: T0 };
    const { api, started, emit } = fixtureApi([workspace], history, [deadRow]);
    const record = (e: SessionEvent) => { history[WS] = [...history[WS]!, e]; emit(e); };
    await setup(api, "thr_dead");
    await screen.findByText(/exited before init/);
    const editor = composerEditor();

    await typeInto(editor, "again");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    await typeInto(editor, "and then this");
    await press(editor, "Enter");
    expect(queueOf("thr_dead")).toEqual(["and then this"]);

    for (const e of OTHER.slice(0, 2)) record(e);
    expect(useStore.getState().selectedThreadId).toBe("thr_dead");
    expect(screen.queryByText("Elsewhere.")).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
    expect(queueOf("thr_dead")).toEqual(["and then this"]);
    expect(queueOf("thr_other")).toEqual([]);

    record(RETRY[0]!);
    expect(useStore.getState().selectedThreadId).toBe("thr_retry");
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(stopButton()).toBeDefined();
    expect(queueOf("thr_retry")).toEqual(["and then this"]);
    record(RETRY[1]!);
    expect(screen.getByText("Second time lucky.")).toBeDefined();

    for (const e of OTHER.slice(2)) record(e);
    expect(stopButton()).toBeDefined();
    expect(screen.queryByText("Elsewhere.")).toBeNull();
    expect(started.length).toBe(1);

    for (const e of RETRY.slice(2)) record(e);
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "and then this", resume: "sess_retry", cwd: "/root" });
  });

  it("on a fresh thread, another client's start during the send stays out; the start carrying the sent prompt opens the thread and takes the queued row", async () => {
    const { api, started, emit } = fixtureApi([workspace], { [WS]: STARTED });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    const editor = composerEditor();

    await typeInto(editor, "start over");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
    await typeInto(editor, "and then this");
    await press(editor, "Enter");
    expect(queueOf(WS)).toEqual(["and then this"]);

    for (const e of OTHER.slice(0, 2)) emit(e);
    expect(screen.queryByText("Elsewhere.")).toBeNull();
    expect(screen.getByText("start over")).toBeDefined();
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
    expect(queueOf(WS)).toEqual(["and then this"]);
    expect(queueOf("thr_other")).toEqual([]);

    const fresh = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" };
    emit({ type: "session.start", ...fresh, prompt: "start over" });
    emit({ type: "session.delta", ...fresh, kind: "text", text: "Fresh start." });
    expect(screen.getByText("Fresh start.")).toBeDefined();
    expect(stopButton()).toBeDefined();
    expect(queueOf("thr_b")).toEqual(["and then this"]);

    for (const e of OTHER.slice(2)) emit(e);
    expect(stopButton()).toBeDefined();
    expect(started.length).toBe(1);

    emit({ type: "session.done", ...fresh, result: { status: "completed", durationMs: 1000, costUsd: 0.001 } });
    emit({ type: "session.end", ...fresh, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "and then this", resume: "sess_0002", cwd: "/root" });
  });
});

describe("chat tab pinned thread whose session.start fell off the transcript cap", () => {
  const TAIL: SessionEvent[] = CHAT_STREAM.slice(1).map(e => ({ ...e, threadId: "thr_a" }));
  const row: SessionView = { id: "sess_0001", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", threadId: "thr_a", prompt: "hello", startedAt: T0 };

  it("the next send resumes the session the thread's row remembers, not the workspace's latest", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: TAIL }, [row]);
    await setup(api, "thr_a");
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();

    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "more", resume: "sess_0001", cwd: "/root" });
  });
});

describe("chat tab new thread", () => {
  it("clears the thread on a new-thread request for this workspace, focuses the composer, and sends the next prompt without resume", async () => {
    const { api, started, emit } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);

    act(() => requestNewThread({ workspaceId: "ws_other" }));
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    const editor = composerEditor();
    expect(document.activeElement).toBe(editor);

    await typeInto(editor, "start over");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
    expect(screen.getByText("start over")).toBeDefined();

    // The fresh session's events land in the cleared thread; the store remembers its id and the next send resumes it.
    const fresh = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002" };
    emit({ type: "session.start", ...fresh, at: T0 + 100_000, prompt: "start over" });
    emit({ type: "session.delta", ...fresh, at: T0 + 100_500, kind: "text", text: "Fresh start." });
    emit({ type: "session.done", ...fresh, at: T0 + 101_000, result: { status: "completed", durationMs: 1000, costUsd: 0.001 } });
    emit({ type: "session.end", ...fresh, at: T0 + 101_100, exitCode: 0, sawResult: true });
    await screen.findByText("Fresh start.");
    await typeInto(editor, "and then");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "and then", resume: "sess_0002", cwd: "/root" });
  });
});

describe("chat tab new thread mid-turn", () => {
  const finishing = () => screen.queryByRole("status")?.textContent ?? null;

  it("keeps the composer closed as finishing the previous turn until that turn ends, then enables and focuses it", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    const editor = composerEditor();
    expect(isEditable(editor)).toBe(true);
    expect(stopButton()).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(isEditable(editor)).toBe(false);
    expect(finishing()).toBe("Finishing the previous turn");
    expect(sendButton().getAttribute("aria-label")).toBe("Finishing the previous turn");
    await typeInto(editor, "too early");
    await press(editor, "Enter");
    expect(started.length).toBe(0);
    expect(editor.textContent).toBe("");
    for (const e of FIXTURE.slice(6, -1)) emit(e);
    expect(isEditable(editor)).toBe(false);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    emit(FIXTURE.at(-1)!);
    expect(isEditable(editor)).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect(finishing()).toBeNull();
    await typeInto(editor, "start over");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
  });

  it("keeps the composer closed and the left turn out when a second request lands while finishing", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    const editor = composerEditor();
    act(() => requestNewThread({ workspaceId: WS }));
    expect(finishing()).toBe("Finishing the previous turn");
    act(() => requestNewThread({ workspaceId: WS }));
    expect(isEditable(editor)).toBe(false);
    expect(finishing()).toBe("Finishing the previous turn");
    await press(editor, "Enter");
    expect(started.length).toBe(0);
    for (const e of FIXTURE.slice(6, -1)) emit(e);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(isEditable(editor)).toBe(false);
    emit(FIXTURE.at(-1)!);
    expect(isEditable(editor)).toBe(true);
    expect(finishing()).toBeNull();
  });

  it("treats a send whose session.start has not landed as the turn the new thread left behind", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText("hello")).toBeNull();
    expect(isEditable(editor)).toBe(false);
    expect(finishing()).toBe("Finishing the previous turn");
    // The sent turn's events arrive after the request: none of them reaches the fresh thread.
    emit({ type: "session.start", ...scope, at: T0, prompt: "hello" });
    emit({ type: "session.delta", ...scope, at: T0 + 300, kind: "text", text: "Creating the server file," });
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/Creating the server file/)).toBeNull();
    expect(isEditable(editor)).toBe(false);
    emit({ type: "session.done", ...scope, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    expect(isEditable(editor)).toBe(false);
    emit({ type: "session.end", ...scope, at: T0 + 950, exitCode: 0, sawResult: true });
    expect(isEditable(editor)).toBe(true);
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    await typeInto(editor, "start over");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
  });
});

describe("chat tab threads", () => {
  const turn = (sc: { sessionId: string; turnId: string; threadId?: string }, prompt: string, text: string): SessionEvent[] => {
    const s = { workspaceId: WS, ...sc };
    return [
      { type: "session.start", ...s, prompt },
      { type: "session.delta", ...s, kind: "text", text },
      { type: "session.done", ...s, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
      { type: "session.end", ...s, exitCode: 0, sawResult: true },
    ];
  };
  const FIRST: SessionEvent[] = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" }));
  const SECOND = turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "second", "two.");
  const THIRD = turn({ sessionId: "sess_0003", turnId: "turn_0003", threadId: "thr_c" }, "third", "three.");
  const status = () => screen.queryByRole("status")?.textContent ?? null;

  it("two threads in one history render as the last one, on mount and again after a replay gap", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST, ...SECOND] };
    const { api } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText("two.");
    expect(screen.getByText("second")).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.getByTestId("settled-footer").textContent).toContain("completed");
    expect(isEditable(composerEditor())).toBe(true);
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");

    history[WS] = [...FIRST, ...SECOND, ...THIRD];
    act(() => useStore.getState().noteGap());
    await screen.findByText("three.");
    expect(screen.queryByText("two.")).toBeNull();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
  });

  it("a history without thread ids renders whole", async () => {
    const legacy = [...turn({ sessionId: "sess_0001", turnId: "turn_0001" }, "first", "one."), ...turn({ sessionId: "sess_0001", turnId: "turn_0002" }, "second", "two.")];
    const { api } = fixtureApi([workspace], { [WS]: legacy });
    await setup(api);
    await screen.findByText("two.");
    expect(screen.getByText("one.")).toBeDefined();
    expect(screen.getByText("first")).toBeDefined();
    expect(screen.getByText("second")).toBeDefined();
  });

  it("a live new thread is unchanged, and a replay gap after it reloads that thread alone", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started, emit } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    await typeInto(composerEditor(), "second");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "second", cwd: "/root" });
    for (const e of SECOND) emit(e);
    expect(screen.getByText("two.")).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");

    // The runtime's transcript holds both threads; the reload keeps the one the person is in.
    history[WS] = [...FIRST, ...turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "second", "two, reloaded.")];
    act(() => useStore.getState().noteGap());
    await screen.findByText("two, reloaded.");
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.getByText("second")).toBeDefined();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });

  it("a send whose start never lands frees the new thread waiting on it when its harness dies, and nothing of it lands there", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    act(() => requestNewThread({ workspaceId: WS }));
    expect(status()).toBe("Finishing the previous turn");
    const X = { workspaceId: WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    emit({ type: "session.done", ...X, at: T0 + 900, result: { status: "failed", error: "claude: command not found" } });
    expect(isEditable(editor)).toBe(false);
    emit({ type: "session.end", ...X, at: T0 + 950, exitCode: 127, sawResult: true });
    expect(isEditable(editor)).toBe(true);
    expect(status()).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/claude: command not found/)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
  });

  it("a new thread asked for after a send died before its start waits on nothing", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    const X = { workspaceId: WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    emit({ type: "session.done", ...X, at: T0 + 900, result: { status: "failed", error: "claude: command not found" } });
    emit({ type: "session.end", ...X, at: T0 + 950, exitCode: 127, sawResult: true });
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe("Send message"));
    expect(screen.getByText("hello")).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(isEditable(editor)).toBe(true);
    expect(status()).toBeNull();
  });

  it("a replay gap while a new thread waits over a stamped history keeps the left thread out, its running turn included", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started, emit } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(isEditable(composerEditor())).toBe(true);

    // While the socket was down a turn started in the left thread; it is the turn the new thread waits on, not the person's.
    const again = turn({ sessionId: "sess_0001", turnId: "turn_0009", threadId: "thr_a" }, "again", "still the old thread.");
    history[WS] = [...FIRST, ...again.slice(0, 2)];
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(status()).toContain("Finishing the previous turn"));
    await waitFor(() => expect(isEditable(composerEditor())).toBe(false));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText("still the old thread.")).toBeNull();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    for (const e of again.slice(2)) emit(e);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(status()).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    await typeInto(composerEditor(), "start over");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
  });

  it("fresh thread, send, drop, gap, reload: the person's turn shows and the composer opens once it ended", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    await typeInto(composerEditor(), "start over");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over", cwd: "/root" });
    expect(sendButton().getAttribute("aria-label")).toBe("Turn in flight");
    expect(status()).toBeNull();

    // The socket dropped before the fresh session.start reached the tab; the runtime ran the turn to its end.
    history[WS] = [...FIRST, ...turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "start over", "Fresh start.")];
    act(() => useStore.getState().noteGap());
    await screen.findByText("Fresh start.");
    expect(screen.getByText("start over")).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(status()).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    expect(screen.getByTestId("settled-footer").textContent).toContain("completed");
  });

  it("fresh thread, send, drop, gap, reload while the person's turn still runs: it shows as in flight, never as the previous turn", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started, emit } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    await typeInto(composerEditor(), "start over");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started.length).toBe(1));

    const fresh = turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "start over", "Fresh start.");
    history[WS] = [...FIRST, ...fresh.slice(0, 2)];
    act(() => useStore.getState().noteGap());
    await screen.findByText("Fresh start.");
    expect(screen.getByText("start over")).toBeDefined();
    expect(status()).toBeNull();
    expect(stopButton()).toBeDefined();
    expect(isEditable(composerEditor())).toBe(true);
    // The rest of the turn lands live and opens the composer.
    for (const e of fresh.slice(2)) emit(e);
    expect(status()).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    expect(screen.getByTestId("settled-footer").textContent).toContain("completed");
  });
});
