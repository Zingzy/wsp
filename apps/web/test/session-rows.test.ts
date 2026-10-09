// SPDX-License-Identifier: AGPL-3.0-only
// A thread's start, end, prompt or mark reaches the store as that thread's one row, pushed by the host: the store
// patches it in and never reads the workspace's whole list again. A builder's project holds 400 threads whose rows
// each repeat an 11 KB brief, and one listing of it was 2.2 MB, read again for every start and end.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldThreads, type SessionRowEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const WS = "ws_boat";
const BRIEF = "Build the ticket. ".repeat(600);
const workspace: WorkspaceView = {
  id: WS,
  name: "boat",
  machineId: "m_boat",
  project: { id: "pr_1", name: "lab", path: "/root/lab", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};
const row = (k: number, over: Partial<SessionView> = {}): SessionView => ({
  id: `s${k}`,
  workspaceId: WS,
  harness: "claude",
  status: "completed",
  threadId: `thr_${k}`,
  claudeSessionId: `c${k}`,
  prompt: `${k} ${BRIEF}`,
  startedAt: 1_000 + k,
  endedAt: 2_000 + k,
  ...over,
});

function fakeApi(rows: SessionView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const read = { calls: 0, bytes: 0 };
  let held: Promise<void> | undefined;
  const api = {
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    watchStatuses: async () => [],
    capabilities: async () => caps(),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    getGolden: async () => undefined,
    listSessions: async (id?: string) => {
      read.calls++;
      const answer = rows.filter(r => id === undefined || r.workspaceId === id).map(r => ({ ...r }));
      await held;
      read.bytes += Buffer.byteLength(JSON.stringify({ sessions: answer }));
      return answer;
    },
    subscribe: (fn: (e: ProtocolEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Api;
  let heardBytes = 0;
  const emit = (e: Record<string, unknown>) => {
    heardBytes += Buffer.byteLength(JSON.stringify(e));
    for (const fn of [...listeners]) fn(e as ProtocolEvent);
  };
  /** Holds every listing's answer until the returned call lets them go. */
  const holdReads = (): (() => void) => {
    let go!: () => void;
    held = new Promise(r => (go = r));
    return () => {
      held = undefined;
      go();
    };
  };
  return { api, emit, read, holdReads, heard: () => heardBytes };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const pushed = (r: SessionView, over: Partial<SessionRowEvent> = {}): SessionRowEvent => {
  const { prompt: _told, ...rest } = r;
  return { type: "session.row", workspaceId: r.workspaceId, threadId: r.threadId, id: r.id, row: rest, ...over };
};

beforeEach(() => {
  useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, spending: {}, selectedId: null, selectedThreadId: null, sessions: {}, launches: {}, ready: false });
});
afterEach(() => {
  window.location.hash = "";
});

describe("a pushed row", () => {
  it("in a workspace of 400 threads, a turn's hold, start, prompt and end read no listing, and its end is under 5 KB", async () => {
    const rows = Array.from({ length: 400 }, (_, k) => row(k, { id: `c${k}` }));
    const { api, emit, read, heard } = fakeApi(rows);
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().sessions[WS]).toHaveLength(400);
    expect(read.bytes).toBeGreaterThan(2_000_000);
    read.calls = 0;
    read.bytes = 0;

    // A send into thread 7 as the host tells it: its next turn is held under the turn's id, then resumes the harness's
    // session, whose row it takes over, and the held row goes; it asks, is answered and ends.
    const { prompt: _told, ...turn } = { ...rows[7]!, status: "running" as const, startedAt: 9_000, endedAt: undefined };
    useStore.getState().launching(WS, { requestId: "req_1", title: "go on", harness: "claude" });
    emit({ type: "session.held", workspaceId: WS, threadId: "thr_7", requestId: "req_1" });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_7", id: "t_next", row: { id: "t_next", workspaceId: WS, harness: "claude", status: "running", threadId: "thr_7", prompt: "go on", startedAt: 9_000 } });
    emit({ type: "session.start", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", prompt: "go on" });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_7", id: "t_next" });
    emit(pushed(turn));
    emit({ type: "session.capped", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", running: 1, cap: 4 });
    emit({ type: "session.subagent", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", toolUseId: "toolu_1", state: "running", description: "look" });
    emit({ type: "session.permission", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", askId: "a1", toolName: "Read", input: "{}", options: [] });
    emit(pushed({ ...turn, asking: "Read" }));
    emit({ type: "session.permission.closed", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", askId: "a1", outcome: "answered" });
    emit({ type: "thread.marked", workspaceId: WS, threadIds: ["thr_7"] });
    emit(pushed(turn));
    emit({ type: "session.delta", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", kind: "tool_use", toolName: "mcp__wsp__threads_wait", toolUseId: "toolu_2", text: JSON.stringify({ threads: ["thr_8"] }) });
    const before = heard();
    emit({ type: "session.end", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", exitCode: 0, sawResult: true });
    emit(pushed({ ...turn, status: "completed", endedAt: 9_500 }));
    await flush();

    expect({ calls: read.calls, bytes: read.bytes }).toEqual({ calls: 0, bytes: 0 });
    expect(heard() - before).toBeLessThan(5_000);
    expect(useStore.getState().launches[WS]).toBeUndefined();
    const held = useStore.getState().sessions[WS]!;
    expect(held).toHaveLength(400);
    expect(held[7]).toMatchObject({ id: "c7", status: "completed", endedAt: 9_500, prompt: rows[7]!.prompt });
    const thread = foldThreads(held).find(t => t.threadId === "thr_7")!;
    expect(thread).toMatchObject({ status: "completed", turns: 1, title: foldThreads([rows[7]!])[0]!.title });
  });

  it("keeps the opening prompt the row it moves already holds, and takes a row the host dropped out", async () => {
    const rows = [row(1), row(2)];
    const { api, emit, read } = fakeApi(rows);
    useStore.getState().bind(api);
    await flush();
    read.calls = 0;
    emit(pushed({ ...rows[0]!, status: "running" }));
    expect(useStore.getState().sessions[WS]![0]).toMatchObject({ id: "s1", status: "running", prompt: rows[0]!.prompt });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_2", id: "s2" });
    expect(useStore.getState().sessions[WS]!.map(r => r.id)).toEqual(["s1"]);
    expect(read.calls).toBe(0);
  });

  it("lands again on a reconnect's read that was asked before it and answers after it", async () => {
    const rows = [row(1)];
    const { api, emit, holdReads } = fakeApi(rows);
    useStore.getState().bind(api);
    await flush();
    const release = holdReads();
    const reading = useStore.getState().refresh();
    await flush();
    emit(pushed({ ...rows[0]!, status: "running", endedAt: undefined }));
    emit(pushed(row(2, { status: "running", endedAt: undefined })));
    release();
    await reading;
    expect(useStore.getState().sessions[WS]!.map(r => [r.id, r.status])).toEqual([
      ["s1", "running"],
      ["s2", "running"],
    ]);
  });

  it("drops a held row on a reconnect's read asked before it was held, once the launch moved it", async () => {
    const first = row(1, { id: "c1", claudeSessionId: "c1" });
    const { api, emit, holdReads } = fakeApi([first]);
    useStore.getState().bind(api);
    await flush();
    const release = holdReads();
    const reading = useStore.getState().refresh();
    await flush();
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_1", id: "t_next", row: { id: "t_next", workspaceId: WS, harness: "claude", status: "running", threadId: "thr_1", prompt: "go on", startedAt: 9_000 } });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_1", id: "t_next" });
    const { prompt: _told, ...started } = { ...first, status: "running" as const, startedAt: 9_000, endedAt: undefined };
    emit(pushed(started));
    release();
    await reading;
    const held = useStore.getState().sessions[WS]!;
    expect(held.map(r => [r.id, r.status, r.prompt])).toEqual([["c1", "running", first.prompt]]);
    expect(foldThreads(held)[0]).toMatchObject({ status: "running", turns: 1 });
  });

  it("folds a thread's second turn as the host lists it once it ends", async () => {
    const first = row(7, { id: "c7", claudeSessionId: "c7" });
    const { api, emit } = fakeApi([first]);
    useStore.getState().bind(api);
    await flush();
    // What the host sends for a send into thread 7: the held row under the turn's id, then the launched turn under the
    // harness's session id, which takes over the thread's row, and the held row goes.
    emit({ type: "session.held", workspaceId: WS, threadId: "thr_7" });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_7", id: "t_next", row: { id: "t_next", workspaceId: WS, harness: "claude", status: "running", threadId: "thr_7", prompt: "go on", startedAt: 9_000 } });
    emit({ type: "session.start", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", prompt: "go on" });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_7", id: "t_next" });
    const { prompt: _p, ...started } = { ...first, status: "running" as const, startedAt: 9_000, endedAt: undefined };
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_7", id: "c7", row: started });
    emit({ type: "session.end", workspaceId: WS, sessionId: "c7", turnId: "t_next", threadId: "thr_7", exitCode: 0, sawResult: true });
    emit({ type: "session.row", workspaceId: WS, threadId: "thr_7", id: "c7", row: { ...started, status: "completed", endedAt: 9_500 } });
    await flush();
    const held = useStore.getState().sessions[WS]!;
    expect(held.map(r => [r.id, r.status])).toEqual([["c7", "completed"]]);
    expect(foldThreads(held)[0]).toMatchObject({ status: "completed", turns: 1 });
  });

  it("for a workspace whose rows were never read, reads them whole", async () => {
    const { api, emit, read } = fakeApi([]);
    useStore.getState().bind(api);
    await flush();
    const other = row(3, { workspaceId: "ws_new" });
    useStore.setState(s => {
      const { ws_new: _gone, ...rest } = s.sessions;
      return { sessions: rest };
    });
    read.calls = 0;
    emit(pushed(other));
    emit(pushed(other));
    await flush();
    expect(read.calls).toBe(1);
  });
});
