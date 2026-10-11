// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { ABOVE_TOP_MS, BELOW_LAST_MS, keyAt, moveMarks, type MoveMark } from "./treeOrder";
import { drawnCount, dropMarks, nextNeedsYou, placementFor, projectGroups, rootHolding, settleableRoots, sidebarTiles, threadTree, treeSettle, type TileNode } from "./threadTree";

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
const agoMs = (hours: number): number => NOW - hours * 3_600_000;

const thread = (id: string, workspaceId: string, parentThreadId: string | null = null, over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot =>
  ({ id, threadId: id, sessionId: `s_${id}`, workspaceId, title: id, status: "running", startedAt: ago(1), endedAt: null, parentThreadId, asking: null, unread: false, needsYou: false, readAt: null, settledAt: null, pinnedAt: null, order: null, snoozedUntil: null, section: null, subagents: [], foldedAt: null, ...over }) as unknown as SidebarProjectSnapshot["threads"][number];
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

  it("draws no tile for a folder on this computer that holds no thread, whatever made its record", () => {
    const here = (id: string, threads: SidebarThreadSnapshot[]): SidebarProjectSnapshot => {
      const r = row(id, "pr_1", threads);
      return { ...r, workspace: { ...r.workspace, kind: "local" } };
    };
    const rows = [here("ws_folder", []), here("ws_tree", [thread("t", "ws_tree")]), row("ws_fork", "pr_1", [])];
    expect(sidebarTiles(rows, { picked: null, nowMs: NOW }).live.map(node => node.thread.id)).toEqual(["t", "ws:ws_fork"]);
  });

  it("folds a root into Settled once its whole tree has been read and quiet two hours, and keeps it out while any thread in it is not", () => {
    const rows = [
      row("ws_a", "pr_1", [done("quiet", "ws_a", 3), done("quiet-child", "ws_a", 2.5, "quiet"), done("recent", "ws_a", 1.5)]),
      row("ws_b", "pr_1", [done("stale", "ws_b", 40), thread("busy-child", "ws_b", "stale"), done("failed", "ws_b", 5, null, { status: "failed" })]),
    ];
    const { live, settled } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    expect(shape(live)).toEqual(["failed", "recent", ["stale", ["busy-child"]]]);
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

  it("folds a quiet tree on the person's settle pick, and keeps it on the list where they picked never", () => {
    const rows = [row("ws_a", "pr_1", [done("lead", "ws_a", 30), done("builder", "ws_a", 29, "lead")])];
    expect(shape(sidebarTiles(rows, { picked: null, nowMs: NOW, settleMs: null }).live)).toEqual([["lead", ["builder"]]]);
    expect(sidebarTiles(rows, { picked: null, nowMs: NOW, settleMs: null }).settled).toEqual([]);
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
    expect(treeSettle(rootHolding(live, "read-child")!)).toEqual({ threadIds: ["read"], working: false });
    expect(treeSettle(rootHolding(live, "working")!)).toEqual({ threadIds: ["lead"], working: true });
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
  it("files a tree waiting on the person under Needs you and every other live tree in one list, newest first, whatever it is doing", () => {
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
      ["threads", ["works", "unseen", "read", ["lead", ["builder"]], "ws:ws_b"]],
    ]);
    expect(shape(sidebarTiles(rows, { picked: null, nowMs: NOW }).live)).toEqual(["asks", "broke", "works", "unseen", "read", ["lead", ["builder"]], "ws:ws_b"]);
  });

  it("puts pinned trees first whatever their state, the latest pin on top; a pinned tree never folds by time, and a settle by hand folds it all the same", () => {
    const rows = [
      row("ws_a", "pr_1", [
        thread("works", "ws_a", null, { pinnedAt: agoMs(3) }),
        done("old", "ws_a", 30, null, { pinnedAt: agoMs(1) }),
        done("put-away", "ws_a", 30, null, { pinnedAt: agoMs(2), settledAt: ago(29) }),
        done("other", "ws_a", 0.2),
      ]),
    ];
    const { settled } = sidebarTiles(rows, { picked: null, nowMs: NOW });
    expect(sections(rows)).toEqual([
      ["pinned", ["old", "works"]],
      ["threads", ["other"]],
    ]);
    expect(shape(settled)).toEqual(["put-away"]);
  });

  it("holds a tree where it was dragged while its state is the one it was dragged in, and files it by its state again once that moves", () => {
    const working = thread("works", "ws_a");
    const placed = placementFor(sidebarTiles([row("ws_a", "pr_1", [working])], { picked: null, nowMs: NOW }).live[0]!, "needs-you");
    expect(sections([row("ws_a", "pr_1", [{ ...working, section: placed }])])).toEqual([["needs-you", ["works"]]]);
    // The turn ended: a new state, so the placement no longer holds.
    const ended = done("works", "ws_a", 0.1, null, { section: placed });
    expect(sections([row("ws_a", "pr_1", [ended])])).toEqual([["threads", ["works"]]]);
    // A new turn on the thread is a new state too.
    const again = thread("works", "ws_a", null, { sessionId: "s_again", section: placed });
    expect(sections([row("ws_a", "pr_1", [again])])).toEqual([["threads", ["works"]]]);
    // A placement an older sidebar wrote into Working, Done or Idle draws in the one list.
    expect(sections([row("ws_a", "pr_1", [{ ...working, section: { name: "done", whileState: "working:s_works" } }])])).toEqual([["threads", ["works"]]]);
  });

  it("a drop on another section places the tree there, a drop on Pinned pins it, a pinned tree dropped elsewhere loses its pin, and a drop on its own section clears a placement", () => {
    const order = ["works", "pinned", "placed", "idle", "asks"];
    const [works, pinned, placed, idle, asks] = sidebarTiles(
      [
        row("ws_a", "pr_1", [
          thread("works", "ws_a"),
          done("pinned", "ws_a", 0.2, null, { pinnedAt: agoMs(1) }),
          thread("placed", "ws_a", null, { section: { name: "needs-you", whileState: "working:s_placed" } }),
          done("idle", "ws_a", 0.3),
          thread("asks", "ws_a", null, { asking: "Permission for Bash", needsYou: true }),
        ]),
      ],
      { picked: null, nowMs: NOW },
    ).live.sort((a, b) => order.indexOf(a.thread.id) - order.indexOf(b.thread.id));
    expect(dropMarks(works!, "needs-you")).toEqual({ section: { name: "needs-you", whileState: "working:s_works" } });
    expect(dropMarks(works!, "pinned")).toEqual({ pinned: true });
    expect(dropMarks(works!, "threads")).toBeNull();
    expect(dropMarks(pinned!, "pinned")).toBeNull();
    expect(dropMarks(pinned!, "threads")).toEqual({ pinned: false, section: null });
    expect(dropMarks(pinned!, "needs-you")).toEqual({ pinned: false, section: { name: "needs-you", whileState: "idle:s_pinned" } });
    expect(dropMarks(placed!, "threads")).toEqual({ section: null });
    expect(dropMarks(idle!, "threads")).toBeNull();
    // A tree that asks, dropped on the list, is held there while it asks.
    expect(dropMarks(asks!, "threads")).toEqual({ section: { name: "idle", whileState: "needs-you:s_asks" } });
  });

  it("leaves a snoozed tree out of the list and the fold, and brings it back early when a thread in it needs the person", () => {
    const snoozedUntil = new Date(NOW + 3_600_000).toISOString();
    const quiet = [row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), done("child", "ws_a", 30, "away"), done("here", "ws_a", 0.1)])];
    const tiles = sidebarTiles(quiet, { picked: null, nowMs: NOW });
    expect([shape(tiles.live), shape(tiles.settled)]).toEqual([["here"], []]);
    const asked = [row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), thread("child", "ws_a", "away", { asking: "Permission for Bash", needsYou: true })])];
    expect(sections(asked)).toEqual([
      ["needs-you", ["child"]],
      ["threads", [["away", ["child"]]]],
    ]);
  });

  it("keeps a snoozed tree reachable while a thread in it runs: its root alone at the foot of the list, folded, carrying how many work", () => {
    const snoozedUntil = new Date(NOW + 3_600_000).toISOString();
    const running = [row("ws_a", "pr_1", [done("away", "ws_a", 30, null, { snoozedUntil }), thread("child", "ws_a", "away"), thread("grandchild", "ws_a", "child"), done("here", "ws_a", 0.1)])];
    const tiles = sidebarTiles(running, { picked: null, nowMs: NOW });
    expect(sections(running)).toEqual([["threads", ["here", "away"]]]);
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

describe("Needs you as an inbox", () => {
  /** The marathon's shape: a lead working, two of its children asking or failed, a grandchild failed under a
   * reviewer, a root of its own asking, and threads that no longer need the person. */
  const marathon = () => [
    row("ws_a", "pr_1", [
      thread("relay", "ws_a", null, { title: "Probe: relay", asking: "Fetch the metrics", needsYou: true, startedAt: ago(0.09) }),
      thread("lead", "ws_a", null, { title: "Coordinator", startedAt: ago(0.03) }),
      thread("c-ask", "ws_a", "lead", { title: "Build: box thread", asking: "Run pnpm install", needsYou: true, startedAt: ago(0.4) }),
      done("c-fail", "ws_a", 0.07, "lead", { title: "Fix: the smoke", status: "failed", startedAt: ago(0.5), needsYou: true }),
      thread("c-rev", "ws_a", "lead", { title: "Review 1822", startedAt: ago(0.15) }),
      done("g-probe", "ws_a", 0.08, "c-rev", { title: "Probe: the carry", status: "failed", startedAt: ago(0.13), needsYou: true }),
      thread("c-answered", "ws_a", "lead", { title: "Answered", startedAt: ago(0.2) }),
      done("c-put-away", "ws_a", 0.3, "lead", { title: "Put away", status: "failed", settledAt: ago(0.2) }),
      done("c-resumes", "ws_a", 0.3, "lead", { title: "Resumes at reset", status: "failed", resumeAt: NOW + 3_600_000 }),
    ]),
  ];

  it("stands every thread that asks or failed, at any depth, as its own tile with nothing under it, in the order the trees draw them, and the trees stay in the list", () => {
    expect(sections(marathon())).toEqual([
      ["needs-you", ["g-probe", "c-ask", "c-fail", "relay"]],
      ["threads", [["lead", [["c-rev", ["g-probe"]], "c-answered", "c-ask", "c-put-away", "c-resumes", "c-fail"]]]],
    ]);
    const inbox = sidebarTiles(marathon(), { picked: null, nowMs: NOW }).sections[0]!.roots;
    // One under a tree names the thread that started it and the whole path down to it; a root that stands nowhere else
    // is its own tile there, with no mark.
    expect(inbox.map(node => node.thread.inboxOf)).toEqual([
      { parent: "Review 1822", path: ["Coordinator", "Review 1822"] },
      { parent: "Coordinator", path: ["Coordinator"] },
      { parent: "Coordinator", path: ["Coordinator"] },
      undefined,
    ]);
  });

  it("keeps every live root once in live, a root alone in the inbox included, so the walks and the drop find each tree", () => {
    expect(shape(sidebarTiles(marathon(), { picked: null, nowMs: NOW }).live).map(node => (Array.isArray(node) ? node[0] : node))).toEqual(["relay", "lead"]);
  });

  it("lets a thread leave once it is answered or settled: nothing left to ask, the inbox holds none", () => {
    const answered = marathon().map(r => ({ ...r, threads: r.threads.map(t => ({ ...t, asking: null, status: t.status === "failed" ? ("completed" as const) : t.status, needsYou: false })) }));
    expect(sections(answered).map(([id]) => id)).toEqual(["threads"]);
  });

  it("a root that asks with a tree under it stands in the inbox and in the list both", () => {
    const rows = [row("ws_a", "pr_1", [thread("lead", "ws_a", null, { asking: "Which ticket next?", needsYou: true }), thread("child", "ws_a", "lead")])];
    expect(sections(rows)).toEqual([
      ["needs-you", ["lead"]],
      ["threads", [["lead", ["child"]]]],
    ]);
  });

  it("a head counts the tiles a tree draws: its live threads at any depth, none under a folded tile and none in a Finished fold", () => {
    const lead = sidebarTiles(marathon(), { picked: null, nowMs: NOW }).live.find(node => node.thread.id === "lead")!;
    const read = { nowMs: NOW, settleMs: null };
    // Every thread but the one settled by hand, which the sidebar does not draw.
    expect(drawnCount(lead, read)).toBe(7);
    const folded = { ...lead, thread: { ...lead.thread, thread: { ...lead.thread.thread!, foldedAt: ago(0.01) } } };
    expect(drawnCount(folded, read)).toBe(1);
  });
});

describe("the order a person moves trees into", () => {
  /** The keys a host would hold after these marks, laid over the rows: what a reload brings back. */
  const marked = (rows: SidebarProjectSnapshot[], moves: ReadonlyArray<MoveMark>): SidebarProjectSnapshot[] =>
    rows.map(r => ({
      ...r,
      threads: r.threads.map(t => {
        const hits = moves.filter(m => m.threadIds.includes(t.id)).map(m => m.marks);
        return hits.reduce<SidebarThreadSnapshot>(
          (at, marks) => ({
            ...at,
            ...(marks.order !== undefined ? { order: marks.order } : {}),
            ...(typeof marks.pinned === "number" ? { pinnedAt: marks.pinned } : marks.pinned === false ? { pinnedAt: null } : marks.pinned === true ? { pinnedAt: NOW } : {}),
          }),
          t,
        );
      }),
    }));
  const listed = (rows: SidebarProjectSnapshot[], section: "pinned" | "threads" = "threads") => sidebarTiles(rows, { picked: null, nowMs: NOW }).sections.find(s => s.id === section)?.roots ?? [];
  /** Moves the root named to `at` in its section, as a drop there writes it. */
  const move = (rows: SidebarProjectSnapshot[], id: string, to: "pinned" | "threads", at: number): MoveMark[] => {
    const all = sidebarTiles(rows, { picked: null, nowMs: NOW }).live;
    const node = all.find(n => n.thread.id === id)!;
    const roots = listed(rows, to).filter(n => n !== node && n.thread.id !== id);
    return moveMarks(node, to, roots, at, dropMarks(node, "threads"));
  };

  it("sorts Pinned by its key and the list by its order or else its start, largest first and ties by id, and Needs you follows the trees", () => {
    const rows = [
      row("ws_a", "pr_1", [
        done("p-old", "ws_a", 3, null, { pinnedAt: agoMs(5) }),
        done("p-new", "ws_a", 2, null, { pinnedAt: agoMs(4) }),
        done("a", "ws_a", 0.5),
        done("b", "ws_a", 0.6, null, { order: agoMs(0.1) }),
        done("c", "ws_a", 0.7, null, { order: agoMs(0.8) }),
        done("d", "ws_a", 0.7, null, { order: agoMs(0.8) }),
        thread("asks-low", "ws_a", null, { asking: "Permission for Bash", needsYou: true, startedAt: ago(0.9), order: agoMs(0.95) }),
        thread("asks-high", "ws_a", null, { asking: "Permission for Bash", needsYou: true, startedAt: ago(0.9), order: agoMs(0.05) }),
      ]),
    ];
    expect(sections(rows)).toEqual([
      ["pinned", ["p-new", "p-old"]],
      ["needs-you", ["asks-high", "asks-low"]],
      ["threads", ["b", "a", "c", "d"]],
    ]);
  });

  it("puts a new thread on top of the list and a menu pin on top of Pinned; an unpin, a settle, a restore and a snooze keep the place", () => {
    const base = [done("one", "ws_a", 0.3), done("two", "ws_a", 0.2), done("three", "ws_a", 0.1)];
    let rows = [row("ws_a", "pr_1", base)];
    rows = marked(rows, move(rows, "one", "threads", 0));
    expect(shape(listed(rows))).toEqual(["one", "three", "two"]);
    // A thread started now is later than every key, so it lands on top with no write.
    const fresh = [row("ws_a", "pr_1", [...rows[0]!.threads, thread("fresh", "ws_a", null, { startedAt: ago(0) })])];
    expect(shape(listed(fresh))).toEqual(["fresh", "one", "three", "two"]);
    // A pin from the menu stamps now, which is over every pin's key.
    let pins = marked(rows, [{ threadIds: ["two"], marks: { pinned: agoMs(10) } }]);
    pins = marked(pins, [{ threadIds: ["three"], marks: { pinned: true } }]);
    expect(shape(listed(pins, "pinned"))).toEqual(["three", "two"]);
    // Unpinned, "one" was never pinned, and "three" goes back to its start: the list keeps the place a move gave.
    const moved = marked(rows, [{ threadIds: ["one"], marks: { pinned: true } }]);
    expect(shape(listed(moved))).toEqual(["three", "two"]);
    const back = marked(moved, [{ threadIds: ["one"], marks: { pinned: false } }]);
    expect(shape(listed(back))).toEqual(["one", "three", "two"]);
    // Settled by hand, it sorts by its end in the fold, then a restore puts it back where it was moved to.
    const settled = [row("ws_a", "pr_1", rows[0]!.threads.map(t => (t.id === "one" ? { ...t, settledAt: ago(0.01) } : t)))];
    const tiles = sidebarTiles(settled, { picked: null, nowMs: NOW });
    expect(shape(tiles.settled)).toEqual(["one"]);
    expect(shape(listed(settled))).toEqual(["three", "two"]);
    expect(shape(listed(rows))).toEqual(["one", "three", "two"]);
    const ended = sidebarTiles([row("ws_a", "pr_1", [done("e-late", "ws_a", 0.1, null, { settledAt: ago(0.05), order: agoMs(9) }), done("e-early", "ws_a", 0.2, null, { settledAt: ago(0.05), order: agoMs(0.01) })])], { picked: null, nowMs: NOW });
    expect(shape(ended.settled)).toEqual(["e-late", "e-early"]);
    // A snoozed tree is out of the list and keeps its key, so it comes back to its place.
    const snoozed = [row("ws_a", "pr_1", rows[0]!.threads.map(t => (t.id === "one" ? { ...t, snoozedUntil: ago(-1) } : t)))];
    expect(shape(listed(snoozed))).toEqual(["three", "two"]);
    expect(snoozed[0]!.threads.find(t => t.id === "one")!.order).toBe(rows[0]!.threads.find(t => t.id === "one")!.order);
  });

  it("writes the neighbours' midpoint between two trees, the top's key plus 1 ms above it and the last's less a minute below it", () => {
    expect(keyAt([3000, 1000], 1)).toEqual({ key: 2000, rekeyed: [] });
    expect(keyAt([3000, 1000], 0)).toEqual({ key: 3000 + ABOVE_TOP_MS, rekeyed: [] });
    expect(keyAt([3000, 1000], 2)).toEqual({ key: 1000 - BELOW_LAST_MS, rekeyed: [] });
    expect(ABOVE_TOP_MS).toBe(1);
    expect(BELOW_LAST_MS).toBe(60_000);
  });

  it("lands each of thirty drops into one gap where it was dropped, re-keying the trees under it once the gap runs out", () => {
    const top = NOW - 1000;
    let rows = [row("ws_a", "pr_1", [done("top", "ws_a", 0, null, { startedAt: new Date(top).toISOString() }), done("bottom", "ws_a", 0, null, { startedAt: new Date(top - 1000).toISOString() })])];
    const expected = ["top", "bottom"];
    let rekeys = 0;
    for (let i = 0; i < 30; i++) {
      const id = `drop-${i}`;
      rows = [row("ws_a", "pr_1", [...rows[0]!.threads, done(id, "ws_a", 0, null, { startedAt: new Date(top - 5000 - i).toISOString() })])];
      // Each drop lands right under the top, so every new one squeezes into the gap the last one left.
      const marks = move(rows, id, "threads", 1);
      if (marks.length > 1) rekeys++;
      for (const mark of marks.slice(1)) expect(mark.threadIds).toHaveLength(1);
      rows = marked(rows, marks);
      expected.splice(1, 0, id);
      expect(shape(listed(rows))).toEqual(expected);
    }
    expect(rekeys).toBeGreaterThan(0);
  });

  it("re-keys the trees under a gap that ran out, down to the first gap of a millisecond, one mark each", () => {
    const keys = [5000, 5000, 5000, 4999.9999, 3000];
    const { key, rekeyed } = keyAt(keys, 1);
    expect(rekeyed.map(r => r.index)).toEqual([1, 2, 3]);
    const after = [keys[0]!, key, ...rekeyed.map(r => r.key), keys[4]!];
    for (let i = 1; i < after.length; i++) expect(after[i]!).toBeLessThan(after[i - 1]!);
  });

  it("sends one mark across sections: a pin key into Pinned, the pin off with the order out of it; a group moves as one key", () => {
    const rows = [
      row("ws_a", "pr_1", [done("p1", "ws_a", 0.3, null, { pinnedAt: agoMs(5) }), done("p2", "ws_a", 0.2, null, { pinnedAt: agoMs(6) }), done("l1", "ws_a", 0.5), done("l2", "ws_a", 0.6)]),
      row("ws_b", "pr_1", [done("g1", "ws_b", 0.4, null, { attempt: "att", title: "task" })]),
      row("ws_c", "pr_1", [done("g2", "ws_c", 0.3, null, { attempt: "att", title: "task" })]),
    ];
    const into = move(rows, "l1", "pinned", 1);
    expect(into).toEqual([{ threadIds: ["l1"], marks: { pinned: (agoMs(5) + agoMs(6)) / 2 } }]);
    const out = move(rows, "p1", "threads", 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.marks).toMatchObject({ pinned: false, order: expect.any(Number) });
    expect(shape(listed(marked(rows, out)))).toEqual([["attempt:att", ["g1", "g2"]], "p1", "l1", "l2"]);
    const group = move(rows, "attempt:att", "threads", 3);
    expect(group).toHaveLength(1);
    expect(group[0]!.threadIds.sort()).toEqual(["g1", "g2"]);
    expect(shape(listed(marked(rows, group)))).toEqual(["l1", "l2", ["attempt:att", ["g1", "g2"]]]);
  });
});
