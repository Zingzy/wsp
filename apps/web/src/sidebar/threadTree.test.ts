// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { projectGroups, rootHolding, settleableRoots, sidebarTiles, threadTree, treeSettle, type TileNode } from "./threadTree";

const project = (id: string, name: string, computer = "here"): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-Users-dev-${name}`,
  memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`,
  createdAt: "2026-09-17T00:00:00.000Z",
});

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

const thread = (id: string, workspaceId: string, parentThreadId: string | null = null, over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot =>
  ({ id, threadId: id, sessionId: `s_${id}`, workspaceId, title: id, status: "running", startedAt: ago(1), endedAt: null, parentThreadId, asking: null, unread: false, readAt: null, settledAt: null, ...over }) as unknown as SidebarProjectSnapshot["threads"][number];
/** A thread that finished `hours` ago and that a window showed as it finished. */
const done = (id: string, workspaceId: string, hours: number, parentThreadId: string | null = null, over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot =>
  thread(id, workspaceId, parentThreadId, { status: "completed", startedAt: ago(hours + 0.1), endedAt: ago(hours), readAt: ago(hours), ...over });

const row = (id: string, projectId: string, threads: SidebarThreadSnapshot[] = [], parentThreadId?: string): SidebarProjectSnapshot =>
  ({
    id,
    displayName: id,
    threads,
    workspace: { id, createdAt: ago(2), project: { id: projectId, name: projectId, path: "/root", computer: "here" }, ...(parentThreadId === undefined ? {} : { parentThreadId }) },
  }) as unknown as SidebarProjectSnapshot;

describe("the projects the sidebar draws", () => {
  it("keeps the host's own order, holds every project's workspaces under it, and keeps a project nobody has started work on", () => {
    const groups = projectGroups([project("pr_1", "spoo"), project("pr_2", "wsp")], [row("ws_a", "pr_1"), row("ws_b", "pr_1")]);
    expect(groups.map(g => [g.project.name, g.workspaces.map(w => w.id)])).toEqual([
      ["spoo", ["ws_a", "ws_b"]],
      ["wsp", []],
    ]);
  });

  it("keeps a workspace whose project the host's list has not answered for, off the record the row itself carries", () => {
    const groups = projectGroups([], [row("ws_a", "pr_1")]);
    expect(groups.map(g => [g.project.id, g.workspaces.map(w => w.id)])).toEqual([["pr_1", ["ws_a"]]]);
  });

});

describe("the threads of a workspace an agent forked", () => {
  it("stay on that workspace rather than joining the rows of the workspace the forking thread runs on", () => {
    const lead = row("ws_a", "pr_1", [thread("lead", "ws_a")]);
    const forked = row("ws_fork", "pr_1", [thread("builder", "ws_fork", "lead")], "lead");
    expect(threadTree([lead, forked]).map(group => [group.project.id, group.threads.map(t => t.id)])).toEqual([
      ["ws_a", ["lead"]],
      ["ws_fork", ["builder"]],
    ]);
  });

  it("while a thread an agent opened on another workspace that is not a fork still joins its opener's rows", () => {
    const lead = row("ws_a", "pr_1", [thread("lead", "ws_a")]);
    const other = row("ws_b", "pr_1", [thread("helper", "ws_b", "lead")]);
    expect(threadTree([lead, other]).map(group => [group.project.id, group.threads.map(t => t.id)])).toEqual([
      ["ws_a", ["lead", "helper"]],
      ["ws_b", []],
    ]);
  });
});

/** A tree as ids, each node its id or its id with its children. */
const shape = (nodes: ReadonlyArray<TileNode>): unknown[] => nodes.map(({ thread: item, children }) => (children.length === 0 ? item.id : [item.id, shape(children)]));

describe("the sidebar's tiles", () => {
  it("lists every root thread across every workspace newest first, each with the threads its agents opened under it", () => {
    const rows = [
      row("ws_a", "pr_1", [thread("old", "ws_a", null, { startedAt: ago(5) }), thread("lead", "ws_a", null, { startedAt: ago(3) })]),
      row("ws_b", "pr_2", [thread("helper", "ws_b", "lead", { startedAt: ago(2) }), thread("mine", "ws_b", null, { startedAt: ago(1) })]),
    ];
    expect(shape(sidebarTiles(rows, { picked: null, nowMs: NOW }).live)).toEqual(["mine", ["lead", ["helper"]], "old"]);
  });

  it("hangs a forked workspace's own threads, and a forked workspace with none, under the thread that forked it", () => {
    const rows = [
      row("ws_a", "pr_1", [thread("lead", "ws_a")]),
      row("ws_fork", "pr_1", [thread("builder", "ws_fork")], "lead"),
      row("ws_empty", "pr_1", [], "lead"),
    ];
    const [lead] = sidebarTiles(rows, { picked: null, nowMs: NOW }).live;
    expect(lead!.thread.id).toBe("lead");
    expect(lead!.children.map(child => [child.thread.id, child.thread.runs.id])).toEqual([
      ["builder", "ws_fork"],
      ["ws:ws_empty", "ws_empty"],
    ]);
  });

  it("draws a workspace with no thread as a tile of its own, so no copy the host holds loses its place in the list", () => {
    const rows = [row("ws_a", "pr_1", []), row("ws_b", "pr_1", [thread("t", "ws_b")])];
    const live = sidebarTiles(rows, { picked: null, nowMs: NOW }).live;
    expect(live.map(node => [node.thread.id, node.thread.thread?.id ?? null])).toEqual([
      ["t", "t"],
      ["ws:ws_a", null],
    ]);
  });

  it("folds a root into Settled once its whole tree has been read and quiet two hours, and keeps it out while any thread in it is not", () => {
    const rows = [
      row("ws_a", "pr_1", [done("quiet", "ws_a", 3), done("quiet-child", "ws_a", 2.5, "quiet"), done("recent", "ws_a", 1.5)]),
      row("ws_b", "pr_1", [done("stale", "ws_b", 40), thread("busy-child", "ws_b", "stale"), done("failed", "ws_b", 5, null, { status: "failed" })]),
    ];
    const { live, settled } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    expect(shape(live)).toEqual(["recent", ["stale", ["busy-child"]]]);
    expect(shape(settled)).toEqual([["quiet", ["quiet-child"]], "failed"]);
  });

  it("keeps a tree live while any finish in it is unseen or any failure unopened, however old, and folds it once opened", () => {
    const unseen = (read: boolean) => [
      row("ws_a", "pr_1", [done("lead", "ws_a", 30), done("builder", "ws_a", 29, "lead", read ? {} : { readAt: ago(40), unread: true })]),
      row("ws_b", "pr_1", [done("broke", "ws_b", 31, null, { status: "failed", readAt: read ? ago(20) : null })]),
    ];
    expect(shape(sidebarTiles(unseen(false), { picked: null, nowMs: NOW }).live)).toEqual([["lead", ["builder"]], "broke"]);
    expect(shape(sidebarTiles(unseen(true), { picked: null, nowMs: NOW }).settled)).toEqual([["lead", ["builder"]], "broke"]);
  });

  it("folds a tree settled by hand at once, unread or not, and brings it back when a thread in it moves after the settle", () => {
    const settledAt = ago(0.05);
    const byHand = [row("ws_a", "pr_1", [done("lead", "ws_a", 0.1, null, { settledAt, readAt: null, unread: true }), done("builder", "ws_a", 0.2, "lead", { settledAt })])];
    expect(shape(sidebarTiles(byHand, { picked: null, nowMs: NOW }).settled)).toEqual([["lead", ["builder"]]]);
    // A message into the builder after the settle is a turn: running, then over, and the settle covers neither.
    const moved = (over: Partial<SidebarThreadSnapshot>) => [row("ws_a", "pr_1", [byHand[0]!.threads[0]!, thread("builder", "ws_a", "lead", { settledAt, ...over })])];
    expect(shape(sidebarTiles(moved({ startedAt: ago(0.01) }), { picked: null, nowMs: NOW }).live)).toEqual([["lead", ["builder"]]]);
    expect(shape(sidebarTiles(moved({ status: "completed", startedAt: ago(0.02), endedAt: ago(0.01), readAt: ago(0.01) }), { picked: null, nowMs: NOW }).live)).toEqual([["lead", ["builder"]]]);
    // So does a thread opened under it after the settle, which carries no settle of its own.
    const grown = [row("ws_a", "pr_1", [...byHand[0]!.threads, done("reviewer", "ws_a", 0.01, "builder")])];
    expect(shape(sidebarTiles(grown, { picked: null, nowMs: NOW }).live)).toEqual([["lead", [["builder", ["reviewer"]]]]]);
  });

  it("names what a settle takes: a root's whole tree, held while one of it works, and the read trees Settle all read takes", () => {
    const rows = [
      row("ws_a", "pr_1", [done("read", "ws_a", 0.5), done("read-child", "ws_a", 0.4, "read"), done("unseen", "ws_a", 0.5, null, { readAt: null, unread: true })]),
      row("ws_b", "pr_1", [done("lead", "ws_b", 0.5), thread("working", "ws_b", "lead")]),
    ];
    const { live } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    expect(settleableRoots(live).map(node => node.thread.id)).toEqual(["read"]);
    expect(treeSettle(rootHolding(live, "read-child")!)).toEqual({ threadIds: ["read", "read-child"], working: false });
    expect(treeSettle(rootHolding(live, "working")!)).toEqual({ threadIds: ["lead", "working"], working: true });
    expect(rootHolding(live, "nobody")).toBeUndefined();
  });

  it("never folds a thread stopped on a question, however long it has waited", () => {
    const rows = [row("ws_a", "pr_1", [thread("asks", "ws_a", null, { status: "completed", startedAt: ago(40), endedAt: ago(39), asking: "Permission for Bash" })])];
    const { live, settled } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    expect(shape(live)).toEqual(["asks"]);
    expect(settled).toEqual([]);
  });

  it("under a picked project lists that project's roots alone, each keeping its children on other projects", () => {
    const rows = [
      row("ws_a", "pr_1", [thread("lead", "ws_a")]),
      row("ws_b", "pr_2", [thread("helper", "ws_b", "lead"), thread("other", "ws_b")]),
    ];
    expect(shape(sidebarTiles(rows, { picked: "pr_1", nowMs: NOW }).live)).toEqual([["lead", ["helper"]]]);
    expect(shape(sidebarTiles(rows, { picked: "pr_2", nowMs: NOW }).live)).toEqual(["other"]);
  });
});
