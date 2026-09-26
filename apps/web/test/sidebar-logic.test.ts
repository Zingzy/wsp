// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's pure logic: the copied t3code sort, search, traversal and
// pill rollup over wsp thread snapshots, plus our row labels and the
// new-workspace helpers.
import { describe, expect, it } from "vitest";
import { THREAD_ARCHIVE_MS, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../src/adapt/index.js";
import { RequestError } from "../src/protocol/client.js";
import { openedBy, threadTree, threadsOpenedBy, workspaceOf } from "../src/sidebar/threadTree.js";
import { explainCreateRefusal } from "../src/protocol/store.js";
import {
  foldArchivedThreads,
  isThreadArchived,
  isThreadWorking,
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

describe("the archive fold", () => {
  const NOW = Date.parse("2026-09-08T12:00:00Z");
  const idleFor = (id: string, ms: number) => thread(id, new Date(NOW - ms - 60_000).toISOString(), new Date(NOW - ms).toISOString());

  it("the threshold is the protocol's one word: a thread idle just under it stays on the shelf, one idle at it or past it archives", () => {
    expect(isThreadArchived(idleFor("just-under", THREAD_ARCHIVE_MS - 60_000), NOW)).toBe(false);
    expect(isThreadArchived(idleFor("exactly", THREAD_ARCHIVE_MS), NOW)).toBe(true);
    expect(isThreadArchived(idleFor("well-past", 3 * THREAD_ARCHIVE_MS), NOW)).toBe(true);
  });

  it("a thread with no readable timestamp has no idleness to measure, so it stays on the shelf", () => {
    expect(isThreadArchived(thread("blank", null, null), NOW)).toBe(false);
    expect(isThreadArchived(thread("malformed", "not a date", "also not a date"), NOW)).toBe(false);
  });

  it("the fold counts each side and keeps the order the shelf sorted them into", () => {
    const shelf = [idleFor("a", 60_000), idleFor("b", 2 * THREAD_ARCHIVE_MS), idleFor("c", 3 * 60_000), idleFor("d", 5 * THREAD_ARCHIVE_MS)];
    const { settled, archived } = foldArchivedThreads(shelf, NOW);
    expect(settled.map(t => t.id)).toEqual(["a", "c"]);
    expect(archived.map(t => t.id)).toEqual(["b", "d"]);
  });

  it("a thread that takes a new turn leaves the archive on its own: it is working, so the split never offers it to the fold", () => {
    const woken = { ...idleFor("woken", 5 * THREAD_ARCHIVE_MS), status: "running" as const };
    const stale = { ...idleFor("stale", 5 * THREAD_ARCHIVE_MS), status: "completed" as const };
    const { active, settled } = splitSidebarThreads([woken, stale]);
    expect(active.map(t => t.id)).toEqual(["woken"]);
    expect(foldArchivedThreads(settled, NOW).archived.map(t => t.id)).toEqual(["stale"]);
    // And once that turn settles, its fresh end stamp keeps it out of the archive with no flag to clear.
    const replied = { ...woken, status: "completed" as const, endedAt: new Date(NOW - 1_000).toISOString() };
    expect(isThreadArchived(replied, NOW)).toBe(false);
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
    const explained = explainCreateRefusal(new RequestError(line, "concurrency"));
    expect(explained.title).toMatch(/no more tasks/i);
    expect(explained.detail).toBe(line);
  });

  it("other failures keep their message under a plain title", () => {
    expect(explainCreateRefusal(new Error("no golden image yet"))).toEqual({
      title: "Could not create the task",
      detail: "no golden image yet",
    });
    expect(explainCreateRefusal("boom").detail).toBe("boom");
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

