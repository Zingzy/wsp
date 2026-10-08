// SPDX-License-Identifier: AGPL-3.0-only
// The page against a host that answers thread heads and history pages: a thread read once is drawn again from what
// the page holds, Settings and back asks the host nothing, a tile in view has its head read so a click draws the
// thread at once, a gap reads the open thread again and no other, and an event the page already holds is not drawn
// twice.
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventUnion, GoldenManifest, HistoryPage, SessionEvent, SessionView, ThreadHead, WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { TRANSCRIPT_LOADING } from "../src/transcript-words.js";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

const WS = "ws_heads";
const T0 = Date.now() - 60 * 60_000;
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }],
};

const A = { workspaceId: WS, sessionId: "sess_a", turnId: "turn_a", threadId: "thr_a" };
const B = { workspaceId: WS, sessionId: "sess_b", turnId: "turn_b", threadId: "thr_b" };
const TRANSCRIPT: SessionEvent[] = [
  { type: "session.start", ...A, at: T0, prompt: "make me a simple server" },
  { type: "session.delta", ...A, at: T0 + 300, kind: "text", text: "Added GET /health." },
  { type: "session.done", ...A, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
  { type: "session.end", ...A, at: T0 + 950, exitCode: 0, sawResult: true },
  { type: "session.start", ...B, at: T0 + 60_000, prompt: "do you have access" },
  { type: "session.delta", ...B, at: T0 + 60_300, kind: "text", text: "Checking the keychain." },
  { type: "session.done", ...B, at: T0 + 61_000, result: { status: "completed", durationMs: 1_000, costUsd: 0.002 } },
  { type: "session.end", ...B, at: T0 + 61_100, exitCode: 0, sawResult: true },
];
const ROWS: SessionView[] = [
  { id: "s_a", workspaceId: WS, harness: "claude", status: "completed", prompt: "make me a simple server", startedAt: T0, endedAt: T0 + 950, threadId: "thr_a" },
  { id: "s_b", workspaceId: WS, harness: "claude", status: "completed", prompt: "do you have access", startedAt: T0 + 60_000, endedAt: T0 + 61_100, threadId: "thr_b" },
];

/** A host that records each event with its transcript position and answers heads and pages off that transcript. */
function hostApi(more: { workspaces?: WorkspaceView[]; rows?: SessionView[] } = {}) {
  const workspaces = [workspace, ...(more.workspaces ?? [])];
  const rows = [...ROWS, ...(more.rows ?? [])];
  const history: SessionEvent[] = TRANSCRIPT.map((e, i) => ({ ...e, pos: i + 1 }));
  const asked: string[] = [];
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const newest = () => history.at(-1)?.pos ?? 0;
  const row = (threadId: string) => rows.find(r => r.threadId === threadId)!;
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspace,
    watchStatuses: async () => [],
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => caps(),
    startSession: async o => ({ id: "s_x", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async id => {
      asked.push("history");
      return history.filter(e => e.workspaceId === id);
    },
    sessionHead: async (threadId): Promise<ThreadHead> => {
      asked.push(`head ${threadId}`);
      const own = history.filter(e => e.threadId === threadId);
      const r = row(threadId);
      return { facts: { id: r.id, threadId, workspaceId: r.workspaceId, harness: r.harness, startedBy: "person", status: r.status, title: r.prompt ?? "", sessionId: r.id, turns: 1, ran: true }, events: own, pos: newest(), total: own.length };
    },
    sessionPage: async (_workspaceId, threadId, window = {}): Promise<HistoryPage> => {
      asked.push(`page ${threadId}${window.before === undefined ? "" : ` before ${window.before}`}`);
      const own = history.filter(e => e.threadId === threadId && (window.before === undefined || (e.pos ?? 0) < window.before));
      return { events: own.slice(-(window.limit ?? 200)), pos: newest(), total: history.filter(e => e.threadId === threadId).length };
    },
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async id => rows.filter(r => id === undefined || r.workspaceId === id),
    listHarnesses: async () => [TABLE_CATALOG],
    workspaceCheckout: async id => {
      asked.push(`checkout ${id}`);
      return { checkout: { branch: "main", ahead: 0, behind: 0, changed: 0, readAt: 1 } };
    },
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => manifest,
  };
  /** Pushes an event onto the bus as the host does, recorded first unless it says where it sits. */
  const emit = (e: SessionEvent) => {
    if (useStore.getState().api !== api) return;
    const placed = e.pos !== undefined ? e : { ...e, pos: newest() + 1 };
    if (e.pos === undefined) history.push(placed);
    act(() => {
      for (const fn of [...listeners]) fn(placed as EventUnion);
    });
    return placed;
  };
  return { api, asked, emit, history };
}

/** No tile observed is ever in view, as a sidebar scrolled away from the thread on screen has it. */
class NoneInView {
  constructor(private readonly fn: IntersectionObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => this.fn([{ target, isIntersecting: false } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** Every tile observed is in view the moment it is observed, as a sidebar shorter than the window has it. */
class AllInView {
  constructor(private readonly fn: IntersectionObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => this.fn([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve(): void {}
  disconnect(): void {}
}

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
  Object.assign(globalThis, { IntersectionObserver: AllInView });
});
afterAll(() => {
  restoreLayout();
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
});
beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, gaps: 0, settingsOpen: false });
  clearNotices();
});
afterEach(() => cleanup());

async function mount(more: Parameters<typeof hostApi>[0] = {}) {
  const host = hostApi(more);
  useStore.getState().bind(host.api);
  await whenAgentsAnswered();
  const { container } = render(<Shell />);
  const sidebar = () => within(container.querySelector<HTMLElement>("[data-app-sidebar]")!);
  const center = () => within(container.querySelector<HTMLElement>("[data-shell-center]")!);
  const threadRow = (title: string): HTMLElement => sidebar().getByText(title).closest<HTMLElement>("[data-sidebar-row]")!;
  // The window opens on the first workspace by id, so with more than one it is put on this one.
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
  if (more.workspaces !== undefined) act(() => useStore.getState().select(WS));
  await waitFor(() => expect(center().getByText("Checking the keychain.")).toBeDefined());
  await waitFor(() => expect(sidebar().getByText("make me a simple server")).toBeDefined());
  return { ...host, sidebar, center, threadRow };
}

describe("a thread the page holds", () => {
  it("Settings and back asks the host nothing and draws the transcript in the commit that closes Settings", async () => {
    const { asked, center, threadRow } = await mount();
    fireEvent.click(threadRow("do you have access"));
    await waitFor(() => expect(asked).toContain("page thr_b"));
    await waitFor(() => expect(asked).toContain(`checkout ${WS}`));
    const before = asked.length;
    act(() => useStore.getState().openSettings());
    // Settings stands over the thread, which is kept under it hidden rather than taken down.
    expect(center().getByText("Checking the keychain.").closest("[style*='display: none']")).not.toBeNull();
    act(() => useStore.getState().closeSettings());
    expect(center().getByText("Checking the keychain.").closest("[style*='display: none']")).toBeNull();
    expect(center().queryByText(TRANSCRIPT_LOADING)).toBeNull();
    await act(async () => await new Promise(r => setTimeout(r, 50)));
    expect(asked.slice(before)).toEqual([]);
  });

  it("a thread on screen whose workspace has no checkout and no tile in view asks for its checkout once", async () => {
    Object.assign(globalThis, { IntersectionObserver: NoneInView });
    try {
      const { asked, threadRow } = await mount();
      fireEvent.click(threadRow("do you have access"));
      await waitFor(() => expect(asked).toContain(`checkout ${WS}`));
      act(() => useStore.getState().openSettings());
      act(() => useStore.getState().closeSettings());
      await act(async () => await new Promise(r => setTimeout(r, 50)));
      expect(asked.filter(a => a.startsWith("checkout "))).toEqual([`checkout ${WS}`]);
    } finally {
      Object.assign(globalThis, { IntersectionObserver: AllInView });
    }
  });

  it("a click on a tile whose head was read in view draws that thread at once, with no loading line", async () => {
    const { asked, center, threadRow } = await mount();
    await waitFor(() => expect(asked).toContain("head thr_a"));
    fireEvent.click(threadRow("make me a simple server"));
    expect(center().getByText("Added GET /health.")).toBeDefined();
    expect(center().queryByText(TRANSCRIPT_LOADING)).toBeNull();
    // The thread left stays hidden and inert until the next one has painted.
    expect(center().getByText("Checking the keychain.").closest("[inert]")).not.toBeNull();
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve))));
    expect(center().queryByText("Checking the keychain.")).toBeNull();
  });

  it("an event the page already holds is drawn once", async () => {
    const { center, emit, history } = await mount();
    const last = history.find(e => e.type === "session.delta" && e.threadId === "thr_b")!;
    emit(last);
    expect(center().getAllByText("Checking the keychain.")).toHaveLength(1);
  });

  it("a gap reads one head and one window for the open thread, and nothing for a thread held off screen", async () => {
    const { asked, center, emit, threadRow } = await mount();
    await waitFor(() => expect(asked).toContain("head thr_a"));
    fireEvent.click(threadRow("make me a simple server"));
    await waitFor(() => expect(asked).toContain("page thr_a"));
    const before = asked.length;
    // One position past the next: an event of this workspace never reached the page.
    emit({ type: "session.delta", ...A, at: Date.now(), kind: "text", text: " And /ready.", pos: 99 });
    await waitFor(() => expect(asked.slice(before)).toHaveLength(2));
    expect(asked.slice(before).sort()).toEqual(["head thr_a", "page thr_a"]);
    await act(async () => await new Promise(r => setTimeout(r, 50)));
    expect(asked.slice(before)).toHaveLength(2);
    expect(center().getByText(/Added GET \/health\./)).toBeDefined();
  });
});

describe("a thread listed before its first event", () => {
  const SUB = "check the fable tests";
  const running = (threadId: string, workspaceId: string): SessionView => ({ id: `s_${threadId}`, workspaceId, harness: "claude", status: "running", prompt: SUB, startedAt: Date.now() - 5_000, threadId, parentThreadId: "thr_b" });
  const neverNew = (center: () => ReturnType<typeof within>) => expect(center().queryByRole("heading", { level: 1 })).toBeNull();
  const chat = () => within(document.querySelector<HTMLElement>("[data-shell-center] [data-chat-view]")!);

  it("a sub-thread on its opener's workspace shows its prompt and a Working line, never the new-thread page", async () => {
    const { center, threadRow } = await mount({ rows: [running("thr_c", WS)] });
    fireEvent.click(threadRow(SUB));
    await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_c"));
    await waitFor(() => expect(chat().getByText(SUB)).toBeDefined());
    expect(chat().getByText(/^Working/)).toBeDefined();
    neverNew(center);
  });

  it("a sub-thread on a workspace of its own shows its prompt and a Working line, never the new-thread page", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_fable", name: "fable", machineId: "m_fable" };
    const { center, threadRow } = await mount({ workspaces: [other], rows: [running("thr_d", other.id)] });
    fireEvent.click(threadRow(SUB));
    await waitFor(() => expect(useStore.getState()).toMatchObject({ selectedId: other.id, selectedThreadId: "thr_d" }));
    await waitFor(() => expect(chat().getByText(SUB)).toBeDefined());
    expect(chat().getByText(/^Working/)).toBeDefined();
    neverNew(center);
  });

  it("with no thread picked, the view holds the thread it first drew off its row when another thread on the workspace starts first", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_fable", name: "fable", machineId: "m_fable" };
    const row = (id: string, prompt: string, ago: number): SessionView => ({ id: `s_${id}`, workspaceId: other.id, harness: "claude", status: "running", prompt, startedAt: Date.now() - ago, threadId: id });
    const { emit } = await mount({ workspaces: [other], rows: [row("thr_alpha", "alpha task", 3_000), row("thr_beta", "beta task", 1_000)] });
    act(() => useStore.getState().select(other.id));
    await waitFor(() => expect(chat().getByText("beta task")).toBeDefined());
    await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_beta"));
    emit({ type: "session.start", workspaceId: other.id, sessionId: "sess_alpha", turnId: "turn_alpha", threadId: "thr_alpha", at: Date.now(), prompt: "alpha task" });
    await act(async () => await new Promise(r => setTimeout(r, 50)));
    expect(useStore.getState().selectedThreadId).toBe("thr_beta");
    expect(chat().getByText("beta task")).toBeDefined();
    expect(chat().queryByText("alpha task")).toBeNull();
  });

  it("the Working line drawn off the row keeps counting from the row's start when the first event lands", async () => {
    const seconds = () => Number(/Working for (\d+)s/.exec(chat().getByText(/^Working for/).textContent ?? "")?.[1]);
    const { emit, threadRow } = await mount({ rows: [{ ...running("thr_c", WS), startedAt: Date.now() - 6_000 }] });
    fireEvent.click(threadRow(SUB));
    await waitFor(() => expect(chat().getByText(SUB)).toBeDefined());
    expect(seconds()).toBeGreaterThanOrEqual(6);
    emit({ type: "session.start", workspaceId: WS, sessionId: "s_thr_c", turnId: "turn_c", threadId: "thr_c", at: Date.now(), prompt: SUB });
    await waitFor(() => expect(chat().queryAllByText(SUB)).toHaveLength(1));
    expect(seconds()).toBeGreaterThanOrEqual(6);
  });

  const FORK: WorkspaceView = { ...workspace, id: "ws_fork", name: "fable", machineId: "m_fork", parentThreadId: "thr_b", rootThreadId: "thr_b", parentWorkspaceId: WS };
  // The opener's turn started 5 s back and forked the workspace 4 s back, inside it.
  const forkedNow = (): WorkspaceView => ({ ...FORK, createdAt: new Date(Date.now() - 4_000).toISOString() });

  it("a workspace an agent forked out of a thread, with no row yet, shows the loading line while its opener's turn runs, and its empty page once that turn ends", async () => {
    const opening: SessionView = { id: "s_b2", workspaceId: WS, harness: "claude", status: "running", prompt: "fork one for the tests", startedAt: Date.now() - 5_000, threadId: "thr_b" };
    const { center } = await mount({ workspaces: [forkedNow()], rows: [opening] });
    act(() => useStore.getState().select(FORK.id));
    await waitFor(() => expect(center().getByText(TRANSCRIPT_LOADING)).toBeDefined());
    neverNew(center);
    act(() => useStore.setState(s => ({ sessions: { ...s.sessions, [WS]: s.sessions[WS]!.map(r => (r.id === "s_b2" ? { ...r, status: "completed" as const } : r)) } })));
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in the-project?"));
  });

  it("a workspace forked with no task reads as its empty page during its opener's later turns", async () => {
    const opening: SessionView = { id: "s_b2", workspaceId: WS, harness: "claude", status: "running", prompt: "fork one for the tests", startedAt: Date.now() - 5_000, threadId: "thr_b" };
    const { center } = await mount({ workspaces: [forkedNow()], rows: [opening] });
    act(() => useStore.getState().select(FORK.id));
    await waitFor(() => expect(center().getByText(TRANSCRIPT_LOADING)).toBeDefined());
    act(() => useStore.setState(s => ({ sessions: { ...s.sessions, [WS]: s.sessions[WS]!.map(r => (r.id === "s_b2" ? { ...r, status: "completed" as const } : r)) } })));
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in the-project?"));
    const next: SessionView = { ...opening, id: "s_b3", prompt: "a child reported", startedAt: Date.now() };
    act(() => useStore.setState(s => ({ sessions: { ...s.sessions, [WS]: [...s.sessions[WS]!, next] } })));
    await act(async () => await new Promise(r => setTimeout(r, 50)));
    expect(center().queryByText(TRANSCRIPT_LOADING)).toBeNull();
    expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in the-project?");
  });

  it("a New thread the person opens on such a workspace is the empty page as anywhere else", async () => {
    const opening: SessionView = { id: "s_b2", workspaceId: WS, harness: "claude", status: "running", prompt: "fork one for the tests", startedAt: Date.now() - 5_000, threadId: "thr_b" };
    const { center } = await mount({ workspaces: [forkedNow()], rows: [opening] });
    act(() => useStore.getState().select(FORK.id));
    await waitFor(() => expect(center().getByText(TRANSCRIPT_LOADING)).toBeDefined());
    act(() => useStore.getState().newThread(FORK.id));
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in the-project?"));
  });

  it("a workspace an agent forked out of a thread whose turn has ended, with no row, is its empty page at once", async () => {
    const { center } = await mount({ workspaces: [FORK] });
    act(() => useStore.getState().select(FORK.id));
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in the-project?"));
  });
});
