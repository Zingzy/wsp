// SPDX-License-Identifier: AGPL-3.0-only
// A first turn sent from New thread on a project folder's workspace reads on that
// page the way the thread's own view reads it: the error a failed turn ended with,
// and "interrupted" only for a turn somebody stopped. The folder's workspace already
// holds older threads, one of them stopped before its agent started, so its rows
// carry no start; the page reads that history while its send is in flight, as the
// dev window's doubled effects make it do, and the old thread is never taken for
// the one the send opened. The next message sent from New thread starts its turn at
// once, after a reload too, and no create's row outlives the first turn.
import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type ProjectView, type SessionEvent, type WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const WSP: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", remote: "https://github.com/dev/wsp.git", defaultBranch: "main", memoryKey: "-wsp", memoryDir: "/Users/dev/.claude/projects/-wsp/memory", createdAt: "t" };
const PLACES: PlaceView[] = [{ id: "here", kind: "computer", name: "here", label: "this Mac", default: true }];
/** The folder's own record, which a create on a folder project answers with: every thread of the folder runs on it. */
const FOLDER: WorkspaceView = { id: "ws_folder", name: "wsp", machineId: "local", project: { id: WSP.id, name: WSP.name, path: WSP.path, computer: "here" }, phase: "running", golden: "", createdAt: "2026-10-01T00:00:00Z" };
const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.283",
  models: [{ value: "claude-opus-5-5", label: "Opus 5.5", isDefault: true }],
  efforts: [],
  contextWindows: [],
  permissionModes: [],
  steers: true,
  renames: true,
  images: true,
};

const LIMIT = "You've hit your usage limit. Try again at Oct 10th, 2026 1:04 PM.";
const FIRST = "make the login test stop flaking";
const NEXT = "then look at the signup form";
const T0 = Date.parse("2026-10-06T12:03:00Z");

/** A thread stopped before its agent announced itself, nineteen hours ago: its rows hold no start. */
const OLD = { workspaceId: FOLDER.id, sessionId: "row_old", turnId: "turn_old", threadId: "thr_old" };
const STOPPED_BEFORE_START: SessionEvent[] = [
  { type: "session.done", ...OLD, result: { status: "interrupted" }, at: T0 - 19 * 3_600_000 },
  { type: "session.end", ...OLD, exitCode: null, sawResult: false, at: T0 - 19 * 3_600_000 + 14 },
  { type: "session.checkpoint", ...OLD, ref: "refs/wsp/checkpoints/old", at: T0 - 19 * 3_600_000 + 6000 },
];

/** A host for one folder project: every session event it pushes goes into the transcript a later read answers with,
 * and `holdHistory` keeps every read waiting until `releaseHistory`, which is how a read lands mid-send. */
function fakeHost() {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const history: SessionEvent[] = [...STOPPED_BEFORE_START];
  let holding = false;
  let waiting: Array<() => void> = [];
  const api: Api = {
    preferences: async () => DEFAULT_PREFERENCES,
    listHarnesses: async () => [CLAUDE],
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => {
      if (holding) await new Promise<void>(resolve => waiting.push(resolve));
      return [...history];
    },
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [FOLDER],
    getWorkspace: async () => FOLDER,
    createWorkspace: async () => FOLDER,
    nap: async () => FOLDER,
    wake: async () => FOLDER,
    capabilities: async () => caps(),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: fn => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    getGolden: async () => undefined,
    projectsList: async () => [WSP],
    placesList: async () => ({ places: PLACES, adds: [] }),
    workspacesLanding: async () => ({ name: "this Mac", capabilities: caps() }),
    startSession: async o => {
      started.push(o);
      return { id: `row_${started.length}`, workspaceId: o.workspaceId, harness: "claude", status: "running", prompt: o.prompt, startedAt: 0 };
    },
  };
  const push = (e: ProtocolEvent): void => {
    if (e.type.startsWith("session.") && e.type !== "session.held") history.push(e as SessionEvent);
    act(() => listeners.forEach(fn => fn(e)));
  };
  return {
    api,
    started,
    push,
    holdHistory: () => void (holding = true),
    releaseHistory: async () => {
      holding = false;
      const go = waiting;
      waiting = [];
      await act(async () => go.forEach(resolve => resolve()));
    },
  };
}
type Host = ReturnType<typeof fakeHost>;

/** One window of the desktop's dev build over the host: the store's modules evaluated afresh, which is what a reload
 * is, and React running every effect twice. */
async function openWindow(host: Host) {
  const { Shell } = await import("../src/App.js");
  const { useStore } = await import("../src/protocol/store.js");
  const { useComposerDraftStore } = await import("../src/components/chat/composerDraftStore.js");
  useStore.setState({ api: null, conn: "live", workspaces: [], statuses: {}, creations: [], sessions: {}, ready: false, selectedId: null, selectedThreadId: null, projectHome: null, freshThread: false, preferences: DEFAULT_PREFERENCES, projects: [], places: [], landings: {} });
  useStore.getState().bind(host.api);
  render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
  act(() => useStore.setState({ projects: [WSP], places: PLACES }));
  return { useStore, useComposerDraftStore };
}
type Window = Awaited<ReturnType<typeof openWindow>>;

/** Types a message on the project's New thread and sends it, as Cmd+T then Enter does. */
async function sendFromNewThread(w: Window, text: string) {
  act(() => w.useStore.getState().openProjectHome(WSP.id));
  await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
  await typeInto(composerEditor(), text);
  await press(composerEditor(), "Enter");
}

/** The first message's turn, from the thread being held to its end, with the workspace's history read landing while
 * the send is in flight and before the agent's start. `rows` are what the turn writes after its start; `started`
 * false is an agent that died before it announced itself, so the turn writes no start at all. */
async function firstTurn(w: Window, host: Host, result: { status: "completed" | "failed" | "interrupted"; error?: string }, rows: "none" | "some", started = true) {
  host.holdHistory();
  await sendFromNewThread(w, FIRST);
  await waitFor(() => expect(host.started).toHaveLength(1));
  const sent = host.started[0]!;
  const own = { workspaceId: FOLDER.id, sessionId: "row_1", turnId: "turn_1", threadId: "thr_new" };
  host.push({ type: "session.held", workspaceId: FOLDER.id, threadId: own.threadId, ...(sent.requestId !== undefined ? { requestId: sent.requestId } : {}) });
  await host.releaseHistory();
  if (started) host.push({ type: "session.start", ...own, prompt: FIRST, ...(sent.requestId !== undefined ? { requestId: sent.requestId } : {}), opensThread: true, agent: "claude", at: T0 });
  if (rows === "some") host.push({ type: "session.delta", ...own, kind: "text", text: "Reading the login test first.", line: 1, at: T0 + 2000 });
  host.push({ type: "session.done", ...own, result: { ...result, durationMs: 6400 }, at: T0 + 6400 });
  host.push({ type: "session.end", ...own, exitCode: result.status === "completed" ? 0 : 1, sawResult: true, at: T0 + 6500 });
}

const chat = () => document.querySelector<HTMLElement>("[data-chat-view]");
const footer = () => document.querySelector("[data-testid=settled-footer]")?.textContent ?? null;
const waitingCard = () => document.querySelector("[data-composer-queue]");

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("A first turn that fails on New thread", () => {
  it.each([
    ["before any output", "none"],
    ["after some output", "some"],
  ] as const)("shows the error the turn ended with %s, and nothing says it was interrupted", async (_when, rows) => {
    const host = fakeHost();
    const w = await openWindow(host);
    await firstTurn(w, host, { status: "failed", error: LIMIT }, rows);
    await waitFor(() => expect(chat()?.textContent).toContain(LIMIT));
    expect(chat()?.textContent).toContain(FIRST);
    expect(chat()?.textContent).not.toContain("interrupted");
    expect(footer()).toBeNull();
  });

  it("shows the error when the agent died before it started, and nothing says it was interrupted", async () => {
    const host = fakeHost();
    const w = await openWindow(host);
    await firstTurn(w, host, { status: "failed", error: LIMIT }, "none", false);
    await waitFor(() => expect(chat()?.textContent).toContain(LIMIT));
    expect(chat()?.textContent).toContain(FIRST);
    expect(chat()?.textContent).not.toContain("interrupted");
  });

  it.each([
    ["after a failed turn", true],
    ["after an agent that died before it started", false],
  ] as const)("the next message sent from New thread starts its turn at once %s, with no waiting card", async (_after, started) => {
    const host = fakeHost();
    const w = await openWindow(host);
    await firstTurn(w, host, { status: "failed", error: LIMIT }, "none", started);
    await sendFromNewThread(w, NEXT);
    await waitFor(() => expect(host.started.map(o => o.prompt)).toEqual([FIRST, NEXT]));
    expect(waitingCard()).toBeNull();
    expect(w.useComposerDraftStore.getState().queues[FOLDER.id] ?? []).toEqual([]);
  });

  it("the next message starts at once after a reload, and so does the one after it", async () => {
    const host = fakeHost();
    const w = await openWindow(host);
    await firstTurn(w, host, { status: "failed", error: LIMIT }, "none");
    await sendFromNewThread(w, NEXT);
    await waitFor(() => expect(host.started.map(o => o.prompt)).toEqual([FIRST, NEXT]));
    expect(waitingCard()).toBeNull();
    cleanup();
    vi.resetModules();
    const again = await openWindow(host);
    await sendFromNewThread(again, "and the password reset");
    await waitFor(() => expect(host.started.map(o => o.prompt)).toEqual([FIRST, NEXT, "and the password reset"]));
    expect(waitingCard()).toBeNull();
  });

  it.each([
    ["done", { status: "completed" as const }],
    ["failed", { status: "failed" as const, error: LIMIT }],
    ["stopped", { status: "interrupted" as const }],
  ])("leaves no create's row once the first turn has %s", async (_end, result) => {
    const host = fakeHost();
    const w = await openWindow(host);
    await firstTurn(w, host, result, "some");
    await waitFor(() => expect(host.started).toHaveLength(1));
    expect(w.useStore.getState().creations).toEqual([]);
    expect(document.querySelector("[data-k=creation-asked]")).toBeNull();
  });

  it("reads interrupted for a first turn somebody stopped", async () => {
    const host = fakeHost();
    const w = await openWindow(host);
    await firstTurn(w, host, { status: "interrupted" }, "some");
    await waitFor(() => expect(footer()).toBe("interrupted"));
    expect(chat()?.textContent).toContain("Reading the login test first.");
  });
});
