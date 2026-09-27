// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's pure logic: the copied t3code sort, search, traversal and
// pill rollup over wsp thread snapshots, plus our row labels and the
// new-workspace helpers.
import { describe, expect, it } from "vitest";
import { THREAD_SETTLE_MS, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../src/adapt/index.js";
import { DisconnectedError, RequestError } from "../src/protocol/client.js";
import { openedBy, threadTree, threadsOpenedBy, workspaceOf } from "../src/sidebar/threadTree.js";
import { explainCreateRefusal } from "../src/protocol/store.js";
import {
  isThreadSettleable,
  isThreadSettled,
  isThreadWorking,
  type SettleInput,
  resolveAdjacentThreadId,
  searchSidebarThreadsByTitle,
  nestSpawnedThreads,
  threadForest,
  sidebarThreadOrder,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
  splitSidebarThreads,
  topSidebarThread,
} from "../src/sidebar/Sidebar.logic.js";
import { currentWorkspaceId } from "../src/adapt/workspaces.js";
import {
  compactTimeLabel,
  computerName,
} from "../src/sidebar/workspaceRows.js";
import { formatRelativeTimeLabel } from "../src/lib/timestampFormat.js";

const thread = (id: string, startedAt: string | null, endedAt: string | null = null) => ({ id, title: id, startedAt, endedAt });

describe("copied sort and search", () => {
  it("active threads sort newest start first, id as the tiebreak", () => {
    const sorted = sortThreadsForSidebar([
      thread("b", "2026-09-01T00:01:00Z"),
      thread("a", "2026-09-01T00:02:00Z"),
      thread("c", "2026-09-01T00:01:00Z"),
      thread("d", null),
    ]);
    expect(sorted.map(t => t.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("settled threads sort by when they ended, falling back to when they started", () => {
    const sorted = sortSettledThreadsForSidebar([
      thread("old", "2026-09-01T00:00:00Z", "2026-09-01T00:05:00Z"),
      thread("new", "2026-09-01T00:00:00Z", "2026-09-01T00:09:00Z"),
      thread("unstamped", "2026-09-01T00:07:00Z"),
    ]);
    expect(sorted.map(t => t.id)).toEqual(["new", "unstamped", "old"]);
  });

  it("title search is case-insensitive and keeps the input order; an empty query matches nothing", () => {
    const threads = [{ title: "Fix the port list" }, { title: "upgrade node" }, { title: "port forwarding" }];
    expect(searchSidebarThreadsByTitle(threads, "PORT").map(t => t.title)).toEqual(["Fix the port list", "port forwarding"]);
    expect(searchSidebarThreadsByTitle(threads, "  ")).toEqual([]);
  });
});

describe("the Settled fold's rule", () => {
  const NOW = Date.parse("2026-09-27T12:00:00Z");
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  /** A thread whose turn ended that long ago, read at or after its end unless said otherwise. */
  const quietFor = (msAgo: number, over: Partial<SettleInput> = {}): SettleInput => ({
    status: "completed",
    asking: null,
    startedAt: at(msAgo + 60_000),
    endedAt: at(msAgo),
    readAt: at(msAgo),
    settledAt: null,
    ...over,
  });

  it("a thread a person has read settles once it has been quiet THREAD_SETTLE_MS, two hours, and not a minute sooner", () => {
    expect(THREAD_SETTLE_MS).toBe(2 * 60 * 60_000);
    expect(isThreadSettled(quietFor(THREAD_SETTLE_MS - 60_000), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(THREAD_SETTLE_MS), NOW)).toBe(true);
    expect(isThreadSettled(quietFor(3 * THREAD_SETTLE_MS), NOW)).toBe(true);
    // Opened after a day away: it stays on the list while it is read, and settles two quiet hours after the opening.
    const day = 24 * 60 * 60_000;
    expect(isThreadSettled(quietFor(day, { readAt: at(60_000) }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(day, { readAt: at(THREAD_SETTLE_MS) }), NOW)).toBe(true);
    // The thread open in the centre stays however long it has been read, and still folds when settled by hand.
    expect(isThreadSettled(quietFor(day, { readAt: at(THREAD_SETTLE_MS) }), NOW, true)).toBe(false);
    expect(isThreadSettled(quietFor(day, { settledAt: at(60_000) }), NOW, true)).toBe(true);
  });

  it("a finish nobody has seen never settles by time until it is opened, and a failure never does at all", () => {
    const week = 7 * 24 * 60 * 60_000;
    expect(isThreadSettled(quietFor(week, { readAt: null }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(week, { readAt: at(week + 1) }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(week, { status: "failed", readAt: null }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(week, { status: "failed", readAt: at(week - 5) }), NOW)).toBe(false);
    // Put away by hand, a failure folds like any other.
    expect(isThreadSettled(quietFor(week, { status: "failed", readAt: at(week - 5), settledAt: at(week - 10) }), NOW)).toBe(true);
    expect(isThreadSettleable(quietFor(60_000, { readAt: null }))).toBe(false);
    expect(isThreadSettleable(quietFor(60_000))).toBe(true);
  });

  it("a thread settled by hand is settled at once, and any activity after the settle brings it back", () => {
    expect(isThreadSettled(quietFor(60_000, { settledAt: at(30_000) }), NOW)).toBe(true);
    // A settle takes an unread thread too: the person chose to put it away.
    expect(isThreadSettled(quietFor(60_000, { readAt: null, settledAt: at(30_000) }), NOW)).toBe(true);
    // A new turn after the settle: it runs, then it ends, and either way the old settle no longer covers it.
    expect(isThreadSettled(quietFor(60_000, { status: "running", endedAt: null, startedAt: at(10_000), settledAt: at(30_000) }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(5_000, { readAt: at(5_000), settledAt: at(30_000) }), NOW)).toBe(false);
  });

  it("nothing running or asked ever settles, and a thread with no readable time has no quiet to measure", () => {
    expect(isThreadSettled(quietFor(THREAD_SETTLE_MS * 3, { asking: "Permission for Bash: ls" }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(THREAD_SETTLE_MS * 3, { status: "running" }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(0, { startedAt: null, endedAt: null }), NOW)).toBe(false);
    expect(isThreadSettled(quietFor(0, { startedAt: "not a date", endedAt: "also not a date" }), NOW)).toBe(false);
  });
});

describe("copied traversal and rollup", () => {
  it("walks the row ids and stops at the ends", () => {
    const ids = ["a", "b", "c"];
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: null, direction: "next" })).toBe("a");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: null, direction: "previous" })).toBe("c");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "a", direction: "next" })).toBe("b");
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "c", direction: "next" })).toBeNull();
    expect(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: "zz", direction: "next" })).toBeNull();
  });

  it("only a running turn is working; a thread waiting on the user is idle whatever its session says", () => {
    expect(isThreadWorking({ status: "running" })).toBe(true);
    expect(isThreadWorking({ status: "completed" })).toBe(false);
    expect(isThreadWorking({ status: "interrupted" })).toBe(false);
    expect(isThreadWorking({ status: "failed" })).toBe(false);
    expect(isThreadWorking({ status: "running", hasPendingApprovals: true })).toBe(false);
    expect(isThreadWorking({ status: "running", hasPendingUserInput: true })).toBe(false);
  });
});

const status = (over: Partial<WorkspaceStatus>): WorkspaceStatus => ({
  id: "ws_a", name: "api", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap", createdAt: "2026-09-01T00:00:00Z",
  machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11, ...over,
});

describe("row labels", () => {
  it("relative time: t3code's label, compacted for the row", () => {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(formatRelativeTimeLabel(threeMinutesAgo)).toBe("3m ago");
    expect(compactTimeLabel(threeMinutesAgo)).toBe("3m");
    expect(compactTimeLabel(new Date().toISOString())).toBe("now");
    expect(compactTimeLabel(null)).toBe("");
  });
});

describe("new workspace helpers", () => {
  it("a concurrency refusal keeps the runtime's words, which name the machines holding the slots, under the cap title", () => {
    const line = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";
    const explained = explainCreateRefusal(new RequestError(line, "concurrency"), "beta");
    expect(explained.title).toBe("Couldn't start beta: the provider has no room to start another now");
    expect(explained.detail).toBe(line);
  });

  it("other failures keep their message under a plain title", () => {
    expect(explainCreateRefusal(new Error("no golden image yet"), "beta")).toEqual({
      title: "Couldn't start beta",
      detail: "no golden image yet",
    });
    expect(explainCreateRefusal("boom", "beta").detail).toBe("boom");
  });

  it("names what was being made, never task or workspace", () => {
    const refusals = [new RequestError("slots full", "concurrency"), new DisconnectedError("lost"), new Error("boom")];
    for (const e of refusals) expect(explainCreateRefusal(e, "beta").title).not.toMatch(/\b(tasks?|workspaces?)\b/i);
  });
});

describe("what a space walks", () => {
  const row = (id: string, status: "running" | "completed", startedAt: string) => ({ id, title: id, status, startedAt, endedAt: startedAt });

  it("orders a workspace's threads the way the sidebar draws them: the working rows, then the idle shelf", () => {
    const threads = [
      row("idle-old", "completed", "2026-09-01T00:01:00Z"),
      row("working-old", "running", "2026-09-01T00:02:00Z"),
      row("idle-new", "completed", "2026-09-01T00:09:00Z"),
      row("working-new", "running", "2026-09-01T00:08:00Z"),
    ];
    expect(sidebarThreadOrder(threads).map(t => t.id)).toEqual(["working-new", "working-old", "idle-new", "idle-old"]);
    expect(topSidebarThread(threads)?.id).toBe("working-new");
    expect(sidebarThreadOrder([])).toEqual([]);
    expect(topSidebarThread([])).toBeNull();
  });

  it("draws a thread an agent spawned under the thread that spawned it, in the order it holds otherwise", () => {
    const spawned = (id: string, startedAt: string, parentThreadId?: string) => ({ ...row(id, "running", startedAt), ...(parentThreadId !== undefined ? { parentThreadId } : {}) });
    const threads = [
      spawned("lead", "2026-09-01T00:01:00Z"),
      spawned("other", "2026-09-01T00:09:00Z"),
      spawned("builder-b", "2026-09-01T00:03:00Z", "lead"),
      spawned("builder-a", "2026-09-01T00:04:00Z", "lead"),
      spawned("deeper", "2026-09-01T00:05:00Z", "builder-a"),
    ];
    // The sort puts the newest first; the tree then pulls each thread's own under it, keeping that order inside.
    expect(sidebarThreadOrder(threads).map(t => t.id)).toEqual(["other", "lead", "builder-a", "deeper", "builder-b"]);
    // A parent that is not in this list leaves the row where the sort put it rather than dropping it.
    expect(nestSpawnedThreads([spawned("orphan", "2026-09-01T00:01:00Z", "gone")]).map(t => t.id)).toEqual(["orphan"]);
    // A row naming itself as its own parent is drawn once, not forever, and two rows naming each other are both
    // drawn: a thread the sidebar leaves out is a thread nobody can reach.
    expect(nestSpawnedThreads([spawned("loop", "2026-09-01T00:01:00Z", "loop")]).map(t => t.id)).toEqual(["loop"]);
    const pair = [spawned("a", "2026-09-01T00:01:00Z", "b"), spawned("b", "2026-09-01T00:02:00Z", "a")];
    expect(nestSpawnedThreads(pair).map(t => t.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps the tree itself beside that order: each thread with the ones its agent opened under it, as deep as it went", () => {
    const spawned = (id: string, startedAt: string, parentThreadId?: string) => ({ ...row(id, "running", startedAt), ...(parentThreadId !== undefined ? { parentThreadId } : {}) });
    const threads = [spawned("lead", "2026-09-01T00:01:00Z"), spawned("builder", "2026-09-01T00:03:00Z", "lead"), spawned("reviewer", "2026-09-01T00:05:00Z", "builder"), spawned("orphan", "2026-09-01T00:02:00Z", "gone")];
    const shape = (nodes: ReadonlyArray<{ thread: { id: string }; children: ReadonlyArray<unknown> }>): unknown => nodes.map(node => [node.thread.id, shape(node.children as ReadonlyArray<{ thread: { id: string }; children: ReadonlyArray<unknown> }>)]);
    expect(shape(threadForest(threads))).toEqual([
      ["lead", [["builder", [["reviewer", []]]]]],
      ["orphan", []],
    ]);
    // The flat order is the same tree read top to bottom, so the two can never disagree.
    expect(nestSpawnedThreads(threads).map(t => t.id)).toEqual(["lead", "builder", "reviewer", "orphan"]);
  });

  it("shows the selected workspace, and the first in the sidebar's order while what is selected is not one", () => {
    const ids = ["ws_a", "ws_b"];
    expect(currentWorkspaceId(ids, "ws_b")).toBe("ws_b");
    expect(currentWorkspaceId(ids, null)).toBe("ws_a");
    expect(currentWorkspaceId(ids, "creating:1")).toBe("ws_a");
    expect(currentWorkspaceId([], "ws_a")).toBeNull();
  });
});

describe("the tree a thread's own threads make", () => {
  const thread = (id: string, workspaceId: string, parentThreadId: string | null): SidebarThreadSnapshot => ({
    id,
    threadId: id,
    sessionId: `s_${id}`,
    workspaceId,
    title: id,
    status: "running",
    ran: true,
    startedAt: "2026-09-01T00:00:00Z",
    endedAt: null,
    indicator: { label: "Working", tone: "neutral", pulse: true },
    harness: "claude",
    startedBy: parentThreadId === null ? "person" : "agent",
    project: null,
    parentThreadId,
    asking: null,
    costUsd: null,
    unread: false,
    readAt: null,
    settledAt: null,
    needsYou: false,
    pinnedAt: null,
    snoozedUntil: null,
    section: null,
  });
  /** A workspace row as the tree reads it: its own threads, and the record, which says whether an agent forked it. */
  const project = (id: string, threads: SidebarThreadSnapshot[], parentThreadId?: string): SidebarProjectSnapshot =>
    ({ id, displayName: id, threads, workspace: { id, ...(parentThreadId === undefined ? {} : { parentThreadId }) } }) as unknown as SidebarProjectSnapshot;
  const drawn = (projects: SidebarProjectSnapshot[]) => threadTree(projects).map(group => [group.project.id, group.threads.map(t => t.id)]);

  it("puts a thread an agent opened on another workspace among its opener's rows, and takes it off the workspace it runs on", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("builder", "bench", "lead")]);
    expect(drawn([mac, bench])).toEqual([
      ["mac", ["lead", "builder"]],
      ["bench", []],
    ]);
  });

  it("follows the chain to the thread a person opened, however many workspaces it crosses", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("builder", "bench", "lead")]);
    const web = project("web", [thread("helper", "web", "builder")]);
    expect(drawn([mac, bench, web])).toEqual([
      ["mac", ["lead", "builder", "helper"]],
      ["bench", []],
      ["web", []],
    ]);
  });

  it("leaves a thread whose opener this window does not hold where it runs, and never loses one to a circle", () => {
    const mac = project("mac", [thread("orphan", "mac", "gone")]);
    const bench = project("bench", [thread("a", "bench", "b"), thread("b", "bench", "a")]);
    expect(drawn([mac, bench])).toEqual([
      ["mac", ["orphan"]],
      ["bench", ["a", "b"]],
    ]);
  });

  it("answers the threads one thread opened with the workspace each runs on, whichever workspace that is", () => {
    const mac = project("mac", [thread("lead", "mac", null), thread("near", "mac", "lead")]);
    const bench = project("bench", [thread("far", "bench", "lead"), thread("other", "bench", null)]);
    expect(threadsOpenedBy([mac, bench], "lead").map(({ thread: t, runs }) => [t.id, runs.id])).toEqual([
      ["near", "mac"],
      ["far", "bench"],
    ]);
    expect(threadsOpenedBy([mac, bench], "other")).toEqual([]);
    expect(workspaceOf([mac, bench], { workspaceId: "bench" })?.id).toBe("bench");
    expect(workspaceOf([mac, bench], { workspaceId: "nowhere" })).toBeUndefined();
  });

  it("answers the thread that opened one, with the workspace that one runs on, and nothing where there is none to reach", () => {
    const mac = project("mac", [thread("lead", "mac", null)]);
    const bench = project("bench", [thread("far", "bench", "lead")]);
    const opener = openedBy([mac, bench], { parentThreadId: "lead" });
    expect([opener?.thread.id, opener?.runs.id]).toEqual(["lead", "mac"]);
    expect(openedBy([mac, bench], { parentThreadId: null })).toBeUndefined();
    // An opener on a workspace this window was never given is one no click could reach, so it is not named either.
    expect(openedBy([bench], { parentThreadId: "lead" })).toBeUndefined();
  });
});

describe("where a workspace runs", () => {
  const runs = (over: Partial<WorkspaceStatus>, view: Partial<WorkspaceView> = {}) => ({ status: status(over), workspace: { ...status(over), ...view } });

  it("where a workspace runs: the provider the record carries, the kind's own word where it has one, and the name wsp holds for the machine where it has neither", () => {
    expect(computerName([], runs({}, { kind: "local" }))).toBe("");
    // A fork runs at the provider its own record names, never the opaque id that provider minted for the machine,
    // and never a word read off the kind: this host is wired to one provider of several and only the record says which.
    expect(computerName([], runs({ machineId: "sb_9f2c1d8a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "solari" }))).toBe("solari");
    expect(computerName([], runs({ machineId: "bx_4c11e0", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "box" }))).toBe("box");
    expect(computerName([], runs({ machineId: "wsp-api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "docker" }))).toBe("docker");
    // A record from before the provider rode the wire says what the machine is; the id the provider minted for it
    // names nothing to the person reading the row, and no row anywhere shows one.
    expect(computerName([], runs({ machineId: "sb_9f2c1d8a" }))).toBe("a provider");
    expect(computerName([], runs({ machineId: "dev@box" }, { kind: "ssh" }))).toBe("dev@box");
    expect(computerName([], { status: null, workspace: { ...status({}), kind: "ssh", machineId: "m_recorded" } })).toBe("m_recorded");
  });
});

