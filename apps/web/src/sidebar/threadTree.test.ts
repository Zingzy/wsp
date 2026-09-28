// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { dropMarks, nextNeedsYou, placementFor, projectGroups, rootHolding, settleableRoots, sidebarTiles, threadTree, treeSettle, type TileNode } from "./threadTree";

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
  ({ id, threadId: id, sessionId: `s_${id}`, workspaceId, title: id, status: "running", startedAt: ago(1), endedAt: null, parentThreadId, asking: null, unread: false, needsYou: false, readAt: null, settledAt: null, pinnedAt: null, snoozedUntil: null, section: null, ...over }) as unknown as SidebarProjectSnapshot["threads"][number];
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
    const groups = projectGroups([project("pr_1", "spoo"), project("pr_2", "wsp")], [row("ws_a", "pr_1"), row("ws_b", "pr_1")], []);
    expect(groups.map(g => [g.project.name, g.workspaces.map(w => w.id)])).toEqual([
      ["spoo", ["ws_a", "ws_b"]],
      ["wsp", []],
    ]);
  });

  it("orders the projects the way the person dragged them, skips an id the host no longer holds, and follows with the rest in the host's order", () => {
    const recorded = [project("pr_1", "spoo"), project("pr_2", "wsp"), project("pr_3", "docs")];
    expect(projectGroups(recorded, [row("ws_a", "pr_2")], ["pr_3", "pr_gone", "pr_1"]).map(g => g.project.id)).toEqual(["pr_3", "pr_1", "pr_2"]);
    expect(projectGroups(recorded, [], []).map(g => g.project.id)).toEqual(["pr_1", "pr_2", "pr_3"]);
  });

  it("keeps a workspace whose project the host's list has not answered for, off the record the row itself carries", () => {
    const groups = projectGroups([], [row("ws_a", "pr_1")], []);
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

  it("draws the roots one send to several models opened as one group, in the order they were opened, which folds only once every one of them would", () => {
    const rows = (read: boolean) => [
      row("ws_a", "pr_1", [done("a1", "ws_a", 4, null, { attempt: "att", title: "the task", readAt: read ? ago(3) : null, unread: !read })]),
      row("ws_b", "pr_1", [done("b1", "ws_b", 3.9, null, { attempt: "att", title: "the task" })]),
      row("ws_c", "pr_1", [thread("alone", "ws_c", null, { startedAt: ago(0.5) })]),
      // An attempt down to one root, the others deleted, is that root alone again.
      row("ws_d", "pr_1", [thread("kept", "ws_d", null, { attempt: "att2", startedAt: ago(0.2) })]),
    ];
    const live = sidebarTiles(rows(false), { picked: null, nowMs: NOW }).live;
    expect(shape(live)).toEqual(["kept", "alone", ["attempt:att", ["a1", "b1"]]]);
    expect(live[2]!.thread).toMatchObject({ groupTitle: "the task", thread: null });
    const folded = sidebarTiles(rows(true), { picked: null, nowMs: NOW });
    expect(shape(folded.settled)).toEqual([["attempt:att", ["a1", "b1"]]]);
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
    expect(shape(live)).toEqual(["failed", ["stale", ["busy-child"]], "recent"]);
    expect(shape(settled)).toEqual([["quiet", ["quiet-child"]]]);
  });

  it("keeps a tree live while any finish in it is unseen, however old, and folds it once opened; a failure stays until settled by hand", () => {
    const unseen = (read: boolean) => [
      row("ws_a", "pr_1", [done("lead", "ws_a", 30), done("builder", "ws_a", 29, "lead", read ? {} : { readAt: ago(40), unread: true })]),
      row("ws_b", "pr_1", [done("broke", "ws_b", 31, null, { status: "failed", readAt: read ? ago(20) : null })]),
    ];
    expect(shape(sidebarTiles(unseen(false), { picked: null, nowMs: NOW }).live)).toEqual(["broke", ["lead", ["builder"]]]);
    const opened = sidebarTiles(unseen(true), { picked: null, nowMs: NOW });
    expect(shape(opened.settled)).toEqual([["lead", ["builder"]]]);
    expect(shape(opened.live)).toEqual(["broke"]);
  });

  it("leaves the tree of the thread open in the centre on the list while it is read, however quiet", () => {
    const rows = [row("ws_a", "pr_1", [done("lead", "ws_a", 30), done("builder", "ws_a", 29, "lead")])];
    expect(shape(sidebarTiles(rows, { picked: null, nowMs: NOW }).settled)).toEqual([["lead", ["builder"]]]);
    expect(shape(sidebarTiles(rows, { picked: null, nowMs: NOW, open: "builder" }).live)).toEqual([["lead", ["builder"]]]);
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

  it("orders roots that started in the same millisecond by id, whatever order the rows arrive in", () => {
    const at = ago(1);
    const tie = (ids: string[]) => shape(sidebarTiles([row("ws_a", "pr_1", ids.map(id => thread(id, "ws_a", null, { startedAt: at })))], { picked: null, nowMs: NOW }).live);
    expect(tie(["th_one", "th_two"])).toEqual(["th_one", "th_two"]);
    expect(tie(["th_two", "th_one"])).toEqual(["th_one", "th_two"]);
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

/** Each section of the live list by its id, with its roots drawn as shape draws them. */
const sections = (rows: SidebarProjectSnapshot[], o: Partial<Parameters<typeof sidebarTiles>[1]> = {}) =>
  sidebarTiles(rows, { picked: null, nowMs: NOW, ...o }).sections.map(section => [section.id, shape(section.roots)]);

describe("the sections the live list is drawn in", () => {
  it("files each root tree under Needs you, Working, Done or Idle by the most pressing thread in it, newest first inside each, and the live list reads them in that order", () => {
    const rows = [
      row("ws_a", "pr_1", [
        thread("asks", "ws_a", null, { asking: "Permission for Bash", needsYou: true, startedAt: ago(0.1) }),
        thread("works", "ws_a", null, { startedAt: ago(0.2) }),
        done("unseen", "ws_a", 0.3, null, { readAt: null, unread: true, needsYou: true }),
        done("read", "ws_a", 0.4),
        done("broke", "ws_a", 0.5, null, { status: "failed" }),
        done("lead", "ws_a", 0.6),
        thread("builder", "ws_a", "lead", { startedAt: ago(0.55) }),
      ]),
      row("ws_b", "pr_1"),
    ];
    expect(sections(rows)).toEqual([
      ["needs-you", ["asks", "broke"]],
      ["working", ["works", ["lead", ["builder"]]]],
      ["done", ["unseen"]],
      ["idle", ["read", "ws:ws_b"]],
    ]);
    expect(shape(sidebarTiles(rows, { picked: null, nowMs: NOW }).live)).toEqual(["asks", "broke", "works", ["lead", ["builder"]], "unseen", "read", "ws:ws_b"]);
  });

  it("puts pinned trees first whatever their state, the latest pin on top; a pinned tree never folds by time, and a settle by hand folds it all the same", () => {
    const rows = [
      row("ws_a", "pr_1", [
        thread("works", "ws_a", null, { pinnedAt: ago(3) }),
        done("old", "ws_a", 30, null, { pinnedAt: ago(1) }),
        done("put-away", "ws_a", 30, null, { pinnedAt: ago(2), settledAt: ago(29) }),
        done("other", "ws_a", 0.2),
      ]),
    ];
    const { settled } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    expect(sections(rows)).toEqual([
      ["pinned", ["old", "works"]],
      ["idle", ["other"]],
    ]);
    expect(shape(settled)).toEqual(["put-away"]);
  });

  it("holds a tree where it was dragged while its state is the one it was dragged in, and files it by its state again once that moves", () => {
    const working = thread("works", "ws_a");
    const placed = placementFor(sidebarTiles([row("ws_a", "pr_1", [working])], { picked: null, nowMs: NOW }).live[0]!, "done");
    expect(sections([row("ws_a", "pr_1", [{ ...working, section: placed }])])).toEqual([["done", ["works"]]]);
    // The turn ended: a new state, so the placement no longer holds and the finish nobody saw reads as Done anyway.
    const ended = done("works", "ws_a", 0.1, null, { section: placed });
    expect(sections([row("ws_a", "pr_1", [ended])])).toEqual([["idle", ["works"]]]);
    // A new turn on the thread is a new state too, even back in the section it was dragged out of.
    const again = thread("works", "ws_a", null, { sessionId: "s_again", section: placed });
    expect(sections([row("ws_a", "pr_1", [again])])).toEqual([["working", ["works"]]]);
  });

  it("a drop on another section places the tree there, a drop on Pinned pins it, a pinned tree dropped elsewhere loses its pin, and a drop on its own section clears a placement", () => {
    const [works, pinned, placed, idle] = sidebarTiles(
      [row("ws_a", "pr_1", [thread("works", "ws_a"), done("pinned", "ws_a", 0.2, null, { pinnedAt: ago(1) }), thread("placed", "ws_a", null, { section: { name: "done", whileState: "working:s_placed" } }), done("idle", "ws_a", 0.3)])],
      { picked: null, nowMs: NOW },
    ).live.sort((a, b) => ["works", "pinned", "placed", "idle"].indexOf(a.thread.id) - ["works", "pinned", "placed", "idle"].indexOf(b.thread.id));
    expect(dropMarks(works!, "done")).toEqual({ section: { name: "done", whileState: "working:s_works" } });
    expect(dropMarks(works!, "pinned")).toEqual({ pinned: true });
    expect(dropMarks(works!, "working")).toBeNull();
    expect(dropMarks(pinned!, "pinned")).toBeNull();
    expect(dropMarks(pinned!, "idle")).toEqual({ pinned: false, section: null });
    expect(dropMarks(pinned!, "needs-you")).toEqual({ pinned: false, section: { name: "needs-you", whileState: "idle:s_pinned" } });
    expect(dropMarks(placed!, "working")).toEqual({ section: null });
    expect(dropMarks(idle!, "idle")).toBeNull();
  });

  it("leaves a snoozed tree out of the list and the fold, and brings it back early when a thread in it needs the person", () => {
    const snoozedUntil = new Date(NOW + 3_600_000).toISOString();
    const quiet = [row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), done("child", "ws_a", 30, "away"), done("here", "ws_a", 0.1)])];
    const tiles = sidebarTiles(quiet, { picked: null, nowMs: NOW });
    expect([shape(tiles.live), shape(tiles.settled)]).toEqual([["here"], []]);
    const asked = [row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), thread("child", "ws_a", "away", { asking: "Permission for Bash", needsYou: true })])];
    expect(sections(asked)).toEqual([["needs-you", [["away", ["child"]]]]]);
  });

  it("keeps a snoozed tree reachable while a thread in it runs: its root alone at the foot of Idle, folded, carrying how many work", () => {
    const snoozedUntil = new Date(NOW + 3_600_000).toISOString();
    const running = [row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), thread("child", "ws_a", "away"), thread("grandchild", "ws_a", "child"), done("here", "ws_a", 0.1)])];
    const tiles = sidebarTiles(running, { picked: null, nowMs: NOW });
    expect(sections(running)).toEqual([["idle", ["here", "away"]]]);
    const away = tiles.live.find(node => node.thread.id === "away")!;
    expect(away.children).toEqual([]);
    expect(away.thread.snoozedWorking).toBe(2);
    // What it holds, so the root reads as selected while one of its hidden threads is open in the centre.
    expect(away.thread.holds).toEqual(["away", "child", "grandchild"]);
    // A tree that is not snoozed carries no count, and one whose threads all rest stays out, as before.
    expect(tiles.live.find(node => node.thread.id === "here")!.thread.snoozedWorking).toBeUndefined();
    expect(shape(sidebarTiles([row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), done("child", "ws_a", 30, "away")])], { picked: null, nowMs: NOW }).live)).toEqual([]);
  });

  it("the next thread that needs the person is the first after the open one in the drawn order, children included, wrapping to the top", () => {
    const rows = [
      row("ws_a", "pr_1", [
        thread("asks", "ws_a", null, { asking: "Permission for Bash", needsYou: true, startedAt: ago(0.1) }),
        thread("lead", "ws_a", null, { startedAt: ago(0.2) }),
        done("child", "ws_a", 0.15, "lead", { readAt: null, unread: true, needsYou: true }),
        done("unseen", "ws_a", 0.3, null, { readAt: null, unread: true, needsYou: true }),
        done("read", "ws_a", 0.4),
      ]),
    ];
    const { live } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    const next = (from: string | null) => nextNeedsYou(live, from)?.thread?.id ?? null;
    expect(next(null)).toBe("asks");
    expect(next("asks")).toBe("child");
    expect(next("child")).toBe("unseen");
    expect(next("unseen")).toBe("asks");
    expect(next("read")).toBe("asks");
    expect(nextNeedsYou(sidebarTiles([row("ws_a", "pr_1", [done("read", "ws_a", 0.4)])], { picked: null, nowMs: NOW }).live, null)).toBeUndefined();
  });
});
