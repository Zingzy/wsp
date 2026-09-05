// SPDX-License-Identifier: AGPL-3.0-only
// Messages entered while a turn runs: Enter queues instead of failing, the
// rows stack above the composer and go one per turn end in order, each is
// edited in place or removed, send-now stops the turn and puts its row first,
// and the queue lives in local storage so a reload still holds it: restored
// rows wait for the person's next send. Same fixture api shape as chat.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventUnion, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, isEditable, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { requestNewThread } from "../src/shell/shellRequests.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { STEER_NOTICE } from "../src/components/chat/ComposerQueue.js";
import { CHAT_STREAM, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
});

const WS = CHAT_WS;
const STORAGE_KEY = "wsp:composer-drafts:v1";
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};
/** The runtime's row for the running turn: its own id, which sessions.interrupt takes, beside the harness id the events carry. */
const runningRow: SessionView = { id: "sess_local_1", workspaceId: WS, harness: "claude", status: "running", claudeSessionId: "sess_0001", prompt: "go", startedAt: 0 };

function fixtureApi(history: Record<string, SessionEvent[]> = {}, rows: SessionView[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string }> = [];
  const interrupted: string[] = [];
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  const hooks: { onInterrupt: () => void } = { onInterrupt: () => {} };
  const api: Api = {
    interruptSession: async id => { interrupted.push(id); hooks.onInterrupt(); return "accepted"; },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    upgrade: async () => workspace,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
    listSessions: async () => rows,
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspace,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  return { api, started, interrupted, emit, hooks };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const draft = () => useComposerDraftStore.getState().drafts[WS]?.prompt ?? "";
const queued = () => (screen.queryAllByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement[]).map(t => t.value);
const rowFor = (text: string) => (screen.getAllByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement[]).find(t => t.value === text)!.closest("li")!;
const within = (li: HTMLElement, name: string) => li.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const done = (status: "completed" | "interrupted", turnId = CHAT_TURN): EventUnion => ({ type: "session.done", ...scope, turnId, result: { status, durationMs: 900, costUsd: 0.001 } });
const end = (turnId = CHAT_TURN): EventUnion => ({ type: "session.end", ...scope, turnId, exitCode: 0, sawResult: true });

/** A fresh page: the in-memory store is empty until it reads storage back. */
async function reloadStore() {
  const stored = window.localStorage.getItem(STORAGE_KEY)!;
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  window.localStorage.setItem(STORAGE_KEY, stored);
  await useComposerDraftStore.persist.rehydrate();
}

async function enter(text: string) {
  await typeInto(composerEditor(), text);
  await press(composerEditor(), "Enter");
}

describe("composer queue", () => {
  it("enter during a turn queues the message, clears the composer and shows no banner; the turn's end sends it", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    expect(isEditable(composerEditor())).toBe(true);
    await enter("what model are you?");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("");
    expect(composerEditor().textContent).toBe("");
    expect(queued()).toEqual(["what model are you?"]);
    expect(screen.getByText("queued")).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Turn in flight/)).toBeNull();

    emit(done("completed"));
    emit(end());
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ workspaceId: WS, prompt: "what model are you?", resume: "sess_0001" });
    expect(queued()).toEqual([]);
    expect(screen.getByText("what model are you?")).toBeDefined();
  });

  it("two queued messages go one per turn end, in order", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    await enter("one");
    await enter("two");
    expect(queued()).toEqual(["one", "two"]);
    emit(done("completed"));
    emit(end());
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["one"]));
    expect(queued()).toEqual(["two"]);
    // The second waits through the send and the next turn.
    emit({ type: "session.start", ...scope, turnId: "turn_0002", prompt: "one" });
    emit({ type: "session.delta", ...scope, turnId: "turn_0002", kind: "text", text: "Sonnet." });
    expect(started).toHaveLength(1);
    expect(queued()).toEqual(["two"]);
    emit(done("completed", "turn_0002"));
    emit(end("turn_0002"));
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["one", "two"]));
    expect(queued()).toEqual([]);
  });

  it("a row is edited in place and removed by its button; what sends is the edited text", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    await enter("one");
    await enter("two");
    fireEvent.change(rowFor("two").querySelector("textarea")!, { target: { value: "two, in tokens" } });
    expect(queued()).toEqual(["one", "two, in tokens"]);
    expect(useComposerDraftStore.getState().queues[WS]?.map(r => r.prompt)).toEqual(["one", "two, in tokens"]);
    fireEvent.click(within(rowFor("one"), "Remove queued message")!);
    expect(queued()).toEqual(["two, in tokens"]);
    emit(done("completed"));
    emit(end());
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["two, in tokens"]));
  });

  it("send-now stops the turn through the runtime's session id and that row goes first once the turn ends", async () => {
    const { api, started, interrupted, emit, hooks } = fixtureApi({}, [runningRow]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    await waitFor(() => expect(useStore.getState().sessions[WS]).toHaveLength(1));
    await enter("one");
    await enter("two");
    // The runtime pushes the interrupted done and end before it answers accepted.
    hooks.onInterrupt = () => { emit(done("interrupted")); emit(end()); };
    fireEvent.click(within(rowFor("two"), "Stop the turn and send now")!);
    expect(interrupted).toEqual([runningRow.id]);
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["two"]));
    expect(queued()).toEqual(["one"]);
    expect(screen.queryByText(STEER_NOTICE)).toBeNull();
    expect(screen.getByTestId("settled-footer").textContent).toContain("interrupted");
  });

  it("send-now shows its notice and marks the row next while the stop is pending; a refused stop drops the notice and keeps the row", async () => {
    const { api, started, interrupted, emit } = fixtureApi();
    api.interruptSession = async id => { interrupted.push(id); throw new Error("runtime is busy"); };
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    await enter("one");
    await enter("two");
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    api.interruptSession = async id => { interrupted.push(id); await held; throw new Error("runtime is busy"); };
    fireEvent.click(within(rowFor("two"), "Stop the turn and send now")!);
    expect(queued()).toEqual(["two", "one"]);
    expect(screen.getByRole("status").textContent).toBe(STEER_NOTICE);
    expect(screen.getByText("next")).toBeDefined();
    expect(within(rowFor("two"), "Stop the turn and send now")!.disabled).toBe(true);
    await act(async () => { release(); await held.catch(() => {}); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Could not stop: runtime is busy"));
    expect(screen.queryByText(STEER_NOTICE)).toBeNull();
    expect(screen.queryByText("next")).toBeNull();
    expect(queued()).toEqual(["two", "one"]);
    expect(started).toHaveLength(0);
    emit(done("completed"));
    emit(end());
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["two"]));
  });

  it("send-now is disabled before the turn's start arrives, since nothing can be stopped yet, and the row does not shift when it can", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    await enter("first");
    await waitFor(() => expect(started).toHaveLength(1));
    await enter("second");
    expect(started).toHaveLength(1);
    expect(queued()).toEqual(["second"]);
    const li = rowFor("second");
    const before = li.querySelectorAll("button").length;
    expect(within(li, "Send now")!.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Remove queued message" })).toBeDefined();
    emit({ type: "session.start", ...scope, prompt: "first" });
    expect(within(rowFor("second"), "Stop the turn and send now")!.disabled).toBe(false);
    expect(rowFor("second").querySelectorAll("button").length).toBe(before);
  });

  it("a send whose harness dies before its start frees the composer at that turn's end and holds the rows that rode it; the next Enter goes first", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    await enter("first");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Turn in flight" })).toBeDefined();
    await enter("second");
    expect(queued()).toEqual(["second"]);
    const X = { workspaceId: WS, sessionId: "sess_x", turnId: "turn_x1" };
    emit({ type: "session.done", ...X, result: { status: "failed", error: "claude: command not found" } });
    emit({ type: "session.end", ...X, exitCode: 127, sawResult: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeDefined());
    expect(started).toHaveLength(1);
    expect(queued()).toEqual(["second"]);
    await enter("third");
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "third"]));
    expect(queued()).toEqual(["second"]);
    emit({ type: "session.start", ...scope, prompt: "third" });
    emit(done("completed"));
    emit(end());
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "third", "second"]));
    expect(queued()).toEqual([]);
  });

  it("a fresh thread whose harness dies before its start settles the send and shows the failure; the rows that rode it stay visible and editable and follow the next Enter", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: CHAT_STREAM.map(e => ({ ...e, sessionId: "sess_a", threadId: "thr_a" })) };
    const { api, started, emit } = fixtureApi(history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeDefined());
    await enter("first");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.resume).toBeUndefined();
    await enter("second");
    expect(queued()).toEqual(["second"]);
    const X = { workspaceId: WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    emit({ type: "session.done", ...X, result: { status: "failed", error: "claude: command not found" } });
    emit({ type: "session.end", ...X, exitCode: 127, sawResult: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeDefined());
    expect(screen.getByText(/claude: command not found/i)).toBeDefined();
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
    expect(started).toHaveLength(1);
    expect(queued()).toEqual(["second"]);
    fireEvent.change(rowFor("second").querySelector("textarea")!, { target: { value: "second, edited" } });
    expect(queued()).toEqual(["second, edited"]);
    await enter("third");
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "third"]));
    expect(started[1]?.resume).toBeUndefined();
    expect(queued()).toEqual(["second, edited"]);
    const Y = { workspaceId: WS, sessionId: "sess_y", turnId: "turn_y1", threadId: "thr_y" };
    emit({ type: "session.start", ...Y, prompt: "third" });
    expect(useComposerDraftStore.getState().queues["thr_y"]?.map(r => r.prompt)).toEqual(["second, edited"]);
    emit({ type: "session.done", ...Y, result: { status: "completed", durationMs: 500 } });
    emit({ type: "session.end", ...Y, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "third", "second, edited"]));
    expect(started[2]?.resume).toBe("sess_y");
    expect(queued()).toEqual([]);
  });

  it("a refused send from the box leaves the held rows held: none is tried, the draft comes back", async () => {
    useComposerDraftStore.getState().enqueue(WS, "one");
    useComposerDraftStore.getState().enqueue(WS, "two");
    await reloadStore();
    const { api, started } = fixtureApi({ [WS]: CHAT_STREAM.slice() });
    const accept = api.startSession;
    let refuse = true;
    api.startSession = async opts => {
      if (!refuse) return accept(opts);
      started.push(opts);
      throw new Error("machine is napping");
    };
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(queued()).toEqual(["one", "two"]);
    await enter("four");
    await waitFor(() => expect(screen.getByText(/machine is napping/i)).toBeDefined());
    await waitFor(() => expect(draft()).toBe("four"));
    expect(started.map(s => s.prompt)).toEqual(["four"]);
    expect(queued()).toEqual(["one", "two"]);
    refuse = false;
    fireEvent.click(within(rowFor("one"), "Send now")!);
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["four", "one"]));
    expect(queued()).toEqual(["two"]);
  });

  it("a refused start puts the row back at the head and holds the queue until the person acts", async () => {
    const { api, started, emit } = fixtureApi();
    const accept = api.startSession;
    let refuse = true;
    api.startSession = async opts => {
      if (!refuse) return accept(opts);
      started.push(opts);
      throw new Error("machine is napping");
    };
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    await enter("one");
    await enter("two");
    await enter("three");
    emit(done("completed"));
    emit(end());
    await waitFor(() => expect(screen.getByText(/machine is napping/i)).toBeDefined());
    expect(started.map(s => s.prompt)).toEqual(["one"]);
    expect(queued()).toEqual(["one", "two", "three"]);
    expect(draft()).toBe("");
    refuse = false;
    fireEvent.click(within(rowFor("one"), "Send now")!);
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["one", "one"]));
    expect(queued()).toEqual(["two", "three"]);
  });

  it("a reload while the runtime keeps the turn restores the row held; Enter during the turn goes first at its end and the restored row follows", async () => {
    useComposerDraftStore.getState().enqueue(WS, "what model are you?");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}").state.queues[WS]).toHaveLength(1);
    await reloadStore();
    const { api, started, emit } = fixtureApi({ [WS]: CHAT_STREAM.slice(0, 3) as SessionEvent[] });
    await setup(api);
    await screen.findByText(/Creating the server file/);
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    expect(queued()).toEqual(["what model are you?"]);
    expect(started).toHaveLength(0);
    await enter("and now?");
    expect(queued()).toEqual(["and now?", "what model are you?"]);
    for (const e of CHAT_STREAM.slice(7)) emit(e);
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["and now?"]));
    expect(queued()).toEqual(["what model are you?"]);
    emit({ type: "session.start", ...scope, turnId: "turn_0002", prompt: "and now?" });
    emit(done("completed", "turn_0002"));
    emit(end("turn_0002"));
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["and now?", "what model are you?"]));
    expect(started[1]?.resume).toBe("sess_0001");
    expect(queued()).toEqual([]);
  });

  it("a row queued while one thread's turn ran stays with that thread: a new thread shows none, the old one shows it again", async () => {
    const A = { workspaceId: WS, sessionId: "sess_a", turnId: "turn_a2", threadId: "thr_a" };
    const history: Record<string, SessionEvent[]> = { [WS]: CHAT_STREAM.map(e => ({ ...e, sessionId: "sess_a", threadId: "thr_a" })) };
    const { api, started, emit } = fixtureApi(history);
    const view = await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    emit({ type: "session.start", ...A, prompt: "go again" });
    await enter("one for a");
    expect(queued()).toEqual(["one for a"]);
    expect(useComposerDraftStore.getState().queues["thr_a"]?.map(r => r.prompt)).toEqual(["one for a"]);

    act(() => requestNewThread({ workspaceId: WS }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeDefined());
    expect(queued()).toEqual([]);
    // The left turn ends while the fresh thread is on screen: a's row must not go out from here.
    emit({ type: "session.done", ...A, result: { status: "completed", durationMs: 700 } });
    emit({ type: "session.end", ...A, exitCode: 0, sawResult: true });
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(started).toHaveLength(0);
    expect(useComposerDraftStore.getState().queues["thr_a"]?.map(r => r.prompt)).toEqual(["one for a"]);
    await enter("hello b");
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["hello b"]));
    const B = { workspaceId: WS, sessionId: "sess_b", turnId: "turn_b1", threadId: "thr_b" };
    emit({ type: "session.start", ...B, prompt: "hello b" });
    emit({ type: "session.done", ...B, result: { status: "completed", durationMs: 500 } });
    emit({ type: "session.end", ...B, exitCode: 0, sawResult: true });
    await waitFor(() => expect(screen.getByTestId("settled-footer").textContent).toContain("completed"));
    expect(started).toHaveLength(1);
    expect(queued()).toEqual([]);

    // Pinning a shows its row, which goes into a with its session.
    history[WS] = [
      ...history[WS]!,
      { type: "session.start", ...A, prompt: "go again" },
      { type: "session.done", ...A, result: { status: "completed", durationMs: 700 } },
      { type: "session.end", ...A, exitCode: 0, sawResult: true },
    ];
    view.rerender(<WorkspaceThread workspaceId={WS} threadId="thr_a" />);
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["hello b", "one for a"]));
    expect(started[1]?.resume).toBe("sess_a");
    expect(queued()).toEqual([]);
  });

  it("a row queued during a fresh thread's first send follows the thread once its start names it", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    await enter("first");
    await waitFor(() => expect(started).toHaveLength(1));
    await enter("second");
    expect(useComposerDraftStore.getState().queues[WS]?.map(r => r.prompt)).toEqual(["second"]);
    const N = { workspaceId: WS, sessionId: "sess_n", turnId: "turn_n1", threadId: "thr_new" };
    emit({ type: "session.start", ...N, prompt: "first" });
    expect(queued()).toEqual(["second"]);
    expect(useComposerDraftStore.getState().queues["thr_new"]?.map(r => r.prompt)).toEqual(["second"]);
    expect(useComposerDraftStore.getState().queues[WS]).toBeUndefined();
    emit({ type: "session.done", ...N, result: { status: "completed", durationMs: 500 } });
    emit({ type: "session.end", ...N, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "second"]));
    expect(started[1]?.resume).toBe("sess_n");
  });

  it("rows typed before a fresh thread's start are held when another thread is pinned: nothing goes into it, and the next new thread shows them waiting", async () => {
    const history: Record<string, SessionEvent[]> = {};
    const { api, started, emit } = fixtureApi(history);
    const view = await setup(api);
    await enter("first");
    await waitFor(() => expect(started).toHaveLength(1));
    await enter("second");
    await enter("third");
    expect(useComposerDraftStore.getState().queues[WS]?.map(r => r.prompt)).toEqual(["second", "third"]);
    history[WS] = CHAT_STREAM.map(e => ({ ...e, sessionId: "sess_a", threadId: "thr_a" }));
    view.rerender(<WorkspaceThread workspaceId={WS} threadId="thr_a" />);
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => expect(screen.getByTestId("settled-footer").textContent).toContain("completed"));
    expect(started).toHaveLength(1);
    expect(queued()).toEqual([]);
    expect(useComposerDraftStore.getState().queues["thr_a"]).toBeUndefined();

    view.rerender(<WorkspaceThread workspaceId={WS} />);
    act(() => requestNewThread({ workspaceId: WS }));
    await waitFor(() => expect(queued()).toEqual(["second", "third"]));
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(started).toHaveLength(1);
    fireEvent.click(within(rowFor("second"), "Send now")!);
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "second"]));
    expect(started[1]?.resume).toBeUndefined();
    expect(queued()).toEqual(["third"]);
    const N = { workspaceId: WS, sessionId: "sess_n", turnId: "turn_n1", threadId: "thr_n" };
    emit({ type: "session.start", ...N, prompt: "second" });
    expect(useComposerDraftStore.getState().queues["thr_n"]?.map(r => r.prompt)).toEqual(["third"]);
    emit({ type: "session.done", ...N, result: { status: "completed", durationMs: 500 } });
    emit({ type: "session.end", ...N, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["first", "second", "third"]));
    expect(started[2]?.resume).toBe("sess_n");
  });

  it("a reload after the turn ended restores the rows and sends nothing; the next message the person sends goes first and they follow in order", async () => {
    useComposerDraftStore.getState().enqueue(WS, "and the context window?");
    useComposerDraftStore.getState().enqueue(WS, "and the cost?");
    await reloadStore();
    const { api, started, emit } = fixtureApi({ [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => expect(screen.getByTestId("settled-footer").textContent).toContain("completed"));
    expect(started).toHaveLength(0);
    expect(queued()).toEqual(["and the context window?", "and the cost?"]);
    await enter("what model are you?");
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["what model are you?"]));
    expect(queued()).toEqual(["and the context window?", "and the cost?"]);
    emit({ type: "session.start", ...scope, turnId: "turn_0002", prompt: "what model are you?" });
    emit(done("completed", "turn_0002"));
    emit(end("turn_0002"));
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["what model are you?", "and the context window?"]));
    expect(queued()).toEqual(["and the cost?"]);
    emit({ type: "session.start", ...scope, turnId: "turn_0003", prompt: "and the context window?" });
    emit(done("completed", "turn_0003"));
    emit(end("turn_0003"));
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["what model are you?", "and the context window?", "and the cost?"]));
    expect(queued()).toEqual([]);
  });
});
