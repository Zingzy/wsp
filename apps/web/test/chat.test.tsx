// SPDX-License-Identifier: AGPL-3.0-only
// Chat tab against a fixture event stream built in the @wsp/protocol
// vocabulary; shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl (hello-world server run). No live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installFakeLayout } from "./fake-layout.js";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatTab } from "../src/tabs/ChatTab.js";
import { ApprovalPrompt } from "../src/tabs/chat/ApprovalPrompt.js";
import { requestNewThread } from "../src/shell/shellRequests.js";
import { CHAT_STREAM, CHAT_T0, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

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
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true }),
    listSessions: async () => [],
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: T0 };
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

    view.rerender(<ChatTab workspaceId={other.id} />);
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
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(fetches).toHaveBeenCalledTimes(1);

    history[WS] = replay(WS, "first", "one.");
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(screen.getByText("one.")).toBeDefined();
    expect(screen.queryByText(/Working for/)).toBeNull();
    // Live events land again once the reload is in.
    emit({ type: "session.start", ...scope });
    expect(input.disabled).toBe(true);
  });

  it("a replay gap while finishing the previous turn: history shows that turn ended, so the composer opens", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [] };
    const { api, emit, started } = fixtureApi([workspace], history);
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    act(() => requestNewThread({ workspaceId: WS }));
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("finishing the previous turn")).toBeDefined();

    // The turn ended while the socket was down for longer than the runtime replays.
    history[WS] = [...FIXTURE] as SessionEvent[];
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.queryByText("finishing the previous turn")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    fireEvent.change(input, { target: { value: "start over" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over" });
  });

  it("a replay gap while finishing the previous turn keeps the composer closed when history shows it still running", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [] };
    const { api, emit } = fixtureApi([workspace], history);
    const fetches = vi.fn(api.sessionHistory);
    api.sessionHistory = fetches;
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    act(() => requestNewThread({ workspaceId: WS }));
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;

    history[WS] = FIXTURE.slice(0, 7) as SessionEvent[];
    act(() => useStore.getState().noteGap());
    await waitFor(() => expect(fetches).toHaveBeenCalledTimes(2));
    await act(() => new Promise(r => setTimeout(r, 0)));
    expect(input.disabled).toBe(true);
    expect(screen.getByText("finishing the previous turn")).toBeDefined();
    for (const e of FIXTURE.slice(7)) emit(e);
    expect(input.disabled).toBe(false);
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
    await waitFor(() => expect(screen.getByText(/workspace is napping/i)).toBeDefined());
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

describe("chat tab new thread", () => {
  it("clears the thread on a new-thread request for this workspace and sends the next prompt without resume", async () => {
    const { api, started, emit } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);

    act(() => requestNewThread({ workspaceId: "ws_other" }));
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "start over" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over" });
    expect(screen.getByText("start over")).toBeDefined();

    // The fresh session's events land in the cleared thread; the store remembers its id and the next send resumes it.
    const fresh = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002" };
    emit({ type: "session.start", ...fresh, at: T0 + 100_000, prompt: "start over" });
    emit({ type: "session.delta", ...fresh, at: T0 + 100_500, kind: "text", text: "Fresh start." });
    emit({ type: "session.done", ...fresh, at: T0 + 101_000, result: { status: "completed", durationMs: 1000, costUsd: 0.001 } });
    emit({ type: "session.end", ...fresh, at: T0 + 101_100, exitCode: 0, sawResult: true });
    await screen.findByText("Fresh start.");
    fireEvent.change(input, { target: { value: "and then" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "and then", resume: "sess_0002" });
  });
});

describe("chat tab new thread mid-turn", () => {
  it("keeps the composer closed as finishing the previous turn until that turn ends, then enables and focuses it", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(input.disabled).toBe(true);
    expect(screen.getByText("finishing the previous turn")).toBeDefined();
    fireEvent.change(input, { target: { value: "too early" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(started.length).toBe(0);
    for (const e of FIXTURE.slice(6, -1)) emit(e);
    expect(input.disabled).toBe(true);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    emit(FIXTURE.at(-1)!);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByText("finishing the previous turn")).toBeNull();
    fireEvent.change(input, { target: { value: "start over" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over" });
  });

  it("keeps the composer closed and the left turn out when a second request lands while finishing", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByText("finishing the previous turn")).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    expect(input.disabled).toBe(true);
    expect(screen.getByText("finishing the previous turn")).toBeDefined();
    fireEvent.change(input, { target: { value: "too early" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(started.length).toBe(0);
    for (const e of FIXTURE.slice(6, -1)) emit(e);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(input.disabled).toBe(true);
    emit(FIXTURE.at(-1)!);
    expect(input.disabled).toBe(false);
    expect(screen.queryByText("finishing the previous turn")).toBeNull();
  });

  it("treats a send whose session.start has not landed as the turn the new thread left behind", async () => {
    const { api, started, emit } = fixtureApi([workspace]);
    await setup(api);
    const input = screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText("hello")).toBeNull();
    expect(input.disabled).toBe(true);
    expect(screen.getByText("finishing the previous turn")).toBeDefined();
    // The sent turn's events arrive after the request: none of them reaches the fresh thread.
    emit({ type: "session.start", ...scope, at: T0, prompt: "hello" });
    emit({ type: "session.delta", ...scope, at: T0 + 300, kind: "text", text: "Creating the server file," });
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/Creating the server file/)).toBeNull();
    expect(input.disabled).toBe(true);
    emit({ type: "session.done", ...scope, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    expect(input.disabled).toBe(true);
    emit({ type: "session.end", ...scope, at: T0 + 950, exitCode: 0, sawResult: true });
    expect(input.disabled).toBe(false);
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    fireEvent.change(input, { target: { value: "start over" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(2));
    expect(started[1]).toEqual({ workspaceId: WS, prompt: "start over" });
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
  const prompt = () => screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;

  it("two threads in one history render as the last one, on mount and again after a replay gap", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST, ...SECOND] };
    const { api } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText("two.");
    expect(screen.getByText("second")).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.getByTestId("settled-footer").textContent).toContain("completed");
    expect(prompt().disabled).toBe(false);

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
    fireEvent.change(prompt(), { target: { value: "second" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "second" });
    for (const e of SECOND) emit(e);
    expect(screen.getByText("two.")).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(prompt().disabled).toBe(false);

    // The runtime's transcript holds both threads; the reload keeps the one the person is in.
    history[WS] = [...FIRST, ...turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "second", "two, reloaded.")];
    act(() => useStore.getState().noteGap());
    await screen.findByText("two, reloaded.");
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.getByText("second")).toBeDefined();
    expect(prompt().disabled).toBe(false);
  });

  it("a replay gap while a new thread waits over a stamped history keeps the left thread out, its running turn included", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started, emit } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(prompt().disabled).toBe(false);

    // While the socket was down a turn started in the left thread; it is the turn the new thread waits on, not the person's.
    const again = turn({ sessionId: "sess_0001", turnId: "turn_0009", threadId: "thr_a" }, "again", "still the old thread.");
    history[WS] = [...FIRST, ...again.slice(0, 2)];
    act(() => useStore.getState().noteGap());
    await screen.findByText("finishing the previous turn");
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText("still the old thread.")).toBeNull();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    for (const e of again.slice(2)) emit(e);
    expect(prompt().disabled).toBe(false);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    fireEvent.change(prompt(), { target: { value: "start over" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over" });
  });

  it("fresh thread, send, drop, gap, reload: the person's turn shows and the composer opens once it ended", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    fireEvent.change(prompt(), { target: { value: "start over" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]).toEqual({ workspaceId: WS, prompt: "start over" });
    expect(prompt().disabled).toBe(true);
    expect(screen.getByText("turn in flight")).toBeDefined();

    // The socket dropped before the fresh session.start reached the tab; the runtime ran the turn to its end.
    history[WS] = [...FIRST, ...turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "start over", "Fresh start.")];
    act(() => useStore.getState().noteGap());
    await screen.findByText("Fresh start.");
    expect(screen.getByText("start over")).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.queryByText("finishing the previous turn")).toBeNull();
    expect(prompt().disabled).toBe(false);
    expect(screen.getByTestId("settled-footer").textContent).toContain("completed");
  });

  it("fresh thread, send, drop, gap, reload while the person's turn still runs: it shows as in flight, never as the previous turn", async () => {
    const history: Record<string, SessionEvent[]> = { [WS]: [...FIRST] };
    const { api, started, emit } = fixtureApi([workspace], history);
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    act(() => requestNewThread({ workspaceId: WS }));
    fireEvent.change(prompt(), { target: { value: "start over" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    await waitFor(() => expect(started.length).toBe(1));

    const fresh = turn({ sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" }, "start over", "Fresh start.");
    history[WS] = [...FIRST, ...fresh.slice(0, 2)];
    act(() => useStore.getState().noteGap());
    await screen.findByText("Fresh start.");
    expect(screen.getByText("start over")).toBeDefined();
    expect(screen.queryByText("finishing the previous turn")).toBeNull();
    expect(screen.getByText("turn in flight")).toBeDefined();
    expect(prompt().disabled).toBe(true);
    // The rest of the turn lands live and opens the composer.
    for (const e of fresh.slice(2)) emit(e);
    expect(prompt().disabled).toBe(false);
    expect(screen.getByTestId("settled-footer").textContent).toContain("completed");
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
