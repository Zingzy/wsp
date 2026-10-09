// SPDX-License-Identifier: AGPL-3.0-only
// One reading of a lead's tree, ported from the locked prototype's marathon: a coordinator that opened eight live
// children, sixty finished and nine settled, three of them with threads of their own, and subagents of its own agent
// and of two children. The parts, their order, the line under each title, the acts and the counts are the
// prototype's, with the build's rule for a subagent's part read off its lead's latest turn.
import { capRunningLine, type SubagentView, type ThreadCapWait } from "@wsp/protocol";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SidebarThreadSnapshot } from "../src/adapt/index.js";
import { childActs, childParts, countTree, finishedTake, kindOf, leadActs, leadNodes, noteOf, partOf, settleTake, type LeadNode, type Tree } from "../src/components/threads/leadTree.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (m: number): number => NOW - m * 60_000;
const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

interface Node {
  readonly thread: SidebarThreadSnapshot;
  readonly kids: Node[];
}

interface Child {
  key: string;
  title?: string;
  status: SidebarThreadSnapshot["status"];
  started: number;
  ended?: number;
  read?: boolean;
  settled?: boolean;
  asking?: string;
  capped?: ThreadCapWait;
  lastLine?: string;
  failure?: string;
  subagents?: SubagentView[];
  replaces?: SidebarThreadSnapshot["replaces"];
  replacedBy?: string;
}

const thread = (c: Child): SidebarThreadSnapshot => ({
  id: `thr_${c.key}`,
  threadId: `thr_${c.key}`,
  sessionId: `s_${c.key}`,
  workspaceId: "ws_m",
  title: c.title ?? c.key,
  status: c.status,
  ran: true,
  startedAt: iso(ago(c.started)),
  endedAt: iso(c.ended === undefined ? undefined : ago(c.ended)),
  indicator: null,
  harness: "claude",
  startedBy: "agent",
  project: "wsp",
  parentThreadId: null,
  attempt: null,
  model: null,
  asking: c.asking ?? null,
  ...(c.capped !== undefined ? { capped: c.capped } : {}),
  limit: null,
  resumeAt: null,
  costUsd: null,
  unread: c.ended !== undefined && c.read !== true,
  readAt: iso(c.read === true && c.ended !== undefined ? ago(c.ended) + 30_000 : undefined),
  settledAt: iso(c.settled === true && c.ended !== undefined ? ago(c.ended) + 60_000 : undefined),
  needsYou: false,
  pinnedAt: null,
  snoozedUntil: null,
  section: null,
  subagents: c.subagents ?? [],
  lastLine: c.lastLine ?? null,
  failure: c.failure ?? null,
  foldedAt: null,
  replaces: c.replaces ?? null,
  replacedBy: c.replacedBy ?? null,
});

const subagent = (id: string, state: SubagentView["state"], started: number, ended?: number, over: Partial<SubagentView> = {}): SubagentView => ({
  id,
  title: id,
  state,
  startedAt: ago(started),
  ...(ended !== undefined ? { endedAt: ago(ended) } : {}),
  ...over,
});

const node = (c: Child, kids: Node[] = []): Node => ({ thread: thread(c), kids });

const CAP: ThreadCapWait = { placeId: "here", place: "zingzy's MacBook Pro", running: 6, atOnce: 6 };

/** The lead's own turn started five minutes ago and still runs; two of its subagents ran in an earlier turn. */
const LEAD = thread({
  key: "lead",
  status: "running",
  started: 5,
  subagents: [
    subagent("sa_map", "running", 1),
    subagent("sa_hdr", "failed", 3, 2, { failure: "WebFetch could not reach https://example.com: connect ETIMEDOUT" }),
    subagent("sa_prs", "done", 60, 58, { lastLine: "11 open, 4 approved, 7 waiting on a reviewer." }),
    subagent("sa_gate", "done", 62, 57, { lastLine: "Main is green at 4c5d84d." }),
  ],
});

const LIVE: Node[] = [
  node({ key: "c_ask", status: "running", started: 23, asking: "Run pnpm install --frozen-lockfile" }),
  node({ key: "c_fail", status: "failed", started: 31, ended: 4, failure: "pnpm test exited 1: 3 tests failed" }),
  node({ key: "c_sec2", status: "running", started: 7, subagents: [subagent("sa_csp", "stopped", 6, 4, { lastLine: "Running pnpm gate:csp" })] }),
  node({
    key: "c_sheet",
    status: "running",
    started: 12,
    subagents: [subagent("sa_steps", "running", 4), subagent("sa_order", "done", 9, 6, { lastLine: "add-sheet.test.tsx:41 pins the order in three cases, all green." })],
  }),
  node({ key: "c_ssh", status: "running", started: 3 }, [
    node({ key: "g_rev", status: "running", started: 2 }, [node({ key: "gg_ssh", status: "running", started: 1 })]),
    node({ key: "g_rebase", status: "completed", started: 3, ended: 2, lastLine: "Rebased onto main at 4c5d84d, no conflicts." }),
  ]),
  node({ key: "c_rev", status: "running", started: 9 }, [node({ key: "g_probe", status: "failed", started: 8, ended: 5, failure: "git worktree add exited 128" })]),
  node({ key: "c_cap1", status: "running", started: 2, capped: CAP }),
  node({ key: "c_cap2", status: "running", started: 1, capped: CAP }),
];

/** Sixty finished children, newest first: the five newest nobody has opened, three stopped mid-work, the rest read. */
const FINISHED: Node[] = Array.from({ length: 60 }, (_, i) => {
  const ended = 6 + i * 9;
  const stopped = i === 7 || i === 22 || i === 41;
  return node({ key: `f${i}`, status: stopped ? "interrupted" : "completed", started: ended + 14, ended, read: i >= 5, lastLine: `Line ${i}` });
});

const SETTLED: Node[] = [
  node({ key: "c_sec1", status: "interrupted", started: 30, ended: 8, read: true, settled: true, lastLine: "Running the gate on the CSP change" }),
  ...Array.from({ length: 8 }, (_, i) => node({ key: `s${i}`, status: "completed", started: 620 + i * 20, ended: 600 + i * 20, read: true, settled: true, lastLine: "Pushed and merged." })),
];

const KIDS = [...FINISHED.slice(0, 30), ...LIVE, ...SETTLED, ...FINISHED.slice(30)];

/** The marathon read with the quiet rule off, so every finished child stays finished as the prototype's page has it. */
const tree = (settleMs: number | null = null): Tree<Node> => ({ threadOf: n => n.thread, kidsOf: n => n.kids, nowMs: NOW, settleMs });

const keyOf = (n: LeadNode<Node>): string => ("subagent" in n ? n.subagent.id : n.node.thread.id.slice(4));
const top = (t = tree()) => leadNodes(LEAD, KIDS, t);
const find = (key: string, nodes: ReadonlyArray<LeadNode<Node>> = top()): LeadNode<Node> => {
  const found = nodes.find(n => keyOf(n) === key);
  if (found !== undefined) return found;
  for (const n of nodes) if ("node" in n) {
    const deeper = leadNodes(n.thread, n.node.kids, tree());
    const hit = deeper.find(d => keyOf(d) === key) ?? (deeper.length > 0 ? safeFind(key, deeper) : undefined);
    if (hit !== undefined) return hit;
  }
  throw new Error(`no ${key}`);
};
const safeFind = (key: string, nodes: ReadonlyArray<LeadNode<Node>>): LeadNode<Node> | undefined => {
  try {
    return find(key, nodes);
  } catch {
    return undefined;
  }
};
const under = (key: string): Record<"live" | "finished" | "settled", string[]> => {
  const n = find(key);
  if (!("node" in n)) throw new Error("a subagent holds no tree");
  const parts = childParts(leadNodes(n.thread, n.node.kids, tree()), tree());
  return { live: parts.live.map(keyOf), finished: parts.finished.map(keyOf), settled: parts.settled.map(keyOf) };
};

describe("a lead's tree, read once", () => {
  it("stands each child in its part, in the prototype's order", () => {
    const parts = childParts(top(), tree());
    // Asks first; then failed, the working reviewer with a failed probe among them, newest first; then working, the
    // lead's running subagent among the threads; then the two held for a slot.
    expect(parts.live.map(keyOf)).toEqual(["c_ask", "c_rev", "c_fail", "sa_map", "c_ssh", "c_sec2", "c_sheet", "c_cap2", "c_cap1"]);
    // Finished by newest end: the lead's failed subagent ended two minutes ago, so it stands quiet at the top.
    expect(parts.finished.map(keyOf)).toEqual(["sa_hdr", ...FINISHED.map(n => n.thread.id.slice(4))]);
    // Settled by newest settle; the subagents of the lead's earlier turn settle with that turn.
    expect(parts.settled.map(keyOf)).toEqual(["c_sec1", "sa_gate", "sa_prs", ...SETTLED.slice(1).map(n => n.thread.id.slice(4))]);
  });

  it("reads trouble deep in the tree into its child's part, and folds nothing live away", () => {
    expect(partOf(find("c_rev"), tree())).toBe("live");
    expect(under("c_rev")).toEqual({ live: ["g_probe"], finished: [], settled: [] });
    expect(under("c_ssh")).toEqual({ live: ["g_rev"], finished: ["g_rebase"], settled: [] });
    expect(under("g_rev")).toEqual({ live: ["gg_ssh"], finished: [], settled: [] });
    expect(under("c_sheet")).toEqual({ live: ["sa_steps"], finished: ["sa_order"], settled: [] });
    expect(under("c_sec2")).toEqual({ live: [], finished: ["sa_csp"], settled: [] });
    // A finished thread with a working child is live while it works.
    const parent = node({ key: "p", status: "completed", started: 30, ended: 20, read: true }, [node({ key: "k", status: "running", started: 2 })]);
    expect(partOf({ node: parent, thread: parent.thread }, tree())).toBe("live");
  });

  it("settles a subagent once its lead's turn is over, or its lead is settled", () => {
    const ended = thread({ key: "lead", status: "completed", started: 5, ended: 1, read: true, subagents: [subagent("sa_x", "done", 3, 2)] });
    expect(childParts(leadNodes(ended, [], tree()), tree()).settled.map(keyOf)).toEqual(["sa_x"]);
    const running = thread({ key: "lead", status: "running", started: 5, subagents: [subagent("sa_x", "done", 3, 2), subagent("sa_y", "failed", 6, 5)] });
    const parts = childParts(leadNodes(running, [], tree()), tree());
    expect(parts.finished.map(keyOf)).toEqual(["sa_x"]);
    expect(parts.settled.map(keyOf)).toEqual(["sa_y"]);
  });

  it("stands a nested subagent flat under the thread whose agent runs it", () => {
    const lead = thread({ key: "lead", status: "running", started: 5, subagents: [subagent("sa_a", "running", 4), subagent("sa_b", "running", 3, undefined, { depth: 2, parentToolUseId: "toolu_a" })] });
    const nodes = leadNodes(lead, [], tree());
    expect(nodes.map(keyOf)).toEqual(["sa_a", "sa_b"]);
  });

  it("settles a read finished child by the quiet rule", () => {
    const parts = childParts(top(tree(2 * 60 * 60_000)), tree(2 * 60 * 60_000));
    expect(parts.finished.map(keyOf)).toContain("f12");
    expect(parts.finished.map(keyOf)).not.toContain("f13");
    expect(parts.settled.map(keyOf)).toContain("f13");
  });

  it("writes the line under each title: what it asks, why it failed, what holds it, or a finished child's last line", () => {
    const note = (key: string): string | undefined => {
      const n = find(key);
      return noteOf(n, partOf(n, tree()));
    };
    expect(note("c_ask")).toBe("Run pnpm install --frozen-lockfile");
    expect(note("c_fail")).toBe("pnpm test exited 1: 3 tests failed");
    expect(note("g_probe")).toBe("git worktree add exited 128");
    expect(note("c_cap1")).toBe(capRunningLine(CAP));
    expect(note("c_ssh")).toBeUndefined();
    expect(note("g_rebase")).toBe("Rebased onto main at 4c5d84d, no conflicts.");
    expect(note("f3")).toBe("Line 3");
    expect(note("sa_hdr")).toBe("WebFetch could not reach https://example.com: connect ETIMEDOUT");
    expect(note("sa_order")).toBe("add-sheet.test.tsx:41 pins the order in three cases, all green.");
    expect(note("sa_map")).toBeUndefined();
    expect(note("c_sec1")).toBeUndefined();
    expect(note("sa_prs")).toBeUndefined();
  });

  it("ends a fold's row in Done's check until read, the muted check once read, and Stopped after a stop", () => {
    const kind = (key: string): string => {
      const n = find(key);
      return kindOf(n, partOf(n, tree())).id;
    };
    expect(kind("f0")).toBe("done");
    expect(kind("f5")).toBe("finished");
    expect(kind("f7")).toBe("stopped");
    expect(kind("c_sec1")).toBe("resting");
    expect(kind("sa_order")).toBe("finished");
    expect(kind("sa_hdr")).toBe("failed");
    expect(kind("sa_csp")).toBe("stopped");
    expect(kind("c_ssh")).toBe("working");
  });

  it("offers each child its acts in order: Send, then Stop, Settle or Restore; a subagent Stop subagent while it runs", () => {
    const acts = (key: string): string[] => {
      const n = find(key);
      return childActs(n, partOf(n, tree()), tree(), {}).map(a => a.id);
    };
    expect(acts("c_ask")).toEqual(["send", "stop"]);
    expect(acts("c_cap1")).toEqual(["send", "stop"]);
    expect(acts("c_ssh")).toEqual(["send", "stop"]);
    expect(acts("c_fail")).toEqual(["send", "settle"]);
    expect(acts("f0")).toEqual(["send", "settle"]);
    expect(acts("c_sec1")).toEqual(["send", "restore"]);
    expect(acts("sa_map")).toEqual(["stop-subagent"]);
    expect(acts("sa_order")).toEqual([]);
    expect(acts("sa_hdr")).toEqual([]);
  });

  it("sends a child's own id in a settle, the host taking its subtree, never a subagent, and holds it while anything under it works", () => {
    expect(settleTake(find("c_ssh"), tree())).toMatchObject({ threadIds: ["thr_c_ssh"], threads: 4 });
    expect(settleTake(find("c_sheet"), tree())).toMatchObject({ threadIds: ["thr_c_sheet"], threads: 1 });
    expect(settleTake(find("c_rev"), tree())).toEqual({ threadIds: ["thr_c_rev"], threads: 2, working: true });
    expect(settleTake(find("f0"), tree())).toEqual({ threadIds: ["thr_f0"], threads: 1, working: false });
    const parent = node({ key: "p", status: "completed", started: 30, ended: 20, read: true }, [node({ key: "k", status: "running", started: 2 })]);
    const held = childActs({ node: parent, thread: parent.thread }, "live", tree(), { settle: async () => undefined }).find(a => a.id === "settle");
    expect(held?.refusal).toBe("A thread in it is still working");
  });

  it("reads a running restart's line off the thread it replaced, stopped or failed, at its resting age, under what asks of the person", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      const at = (c: Child): LeadNode<Node> => {
        const n = node(c);
        return { node: n, thread: n.thread };
      };
      const stopped = { threadId: "thr_c_sec1", failed: false, endedAt: iso(ago(8)) };
      expect(noteOf(at({ key: "redo", status: "running", started: 2, replaces: stopped }), "live")).toBe("Restart of the one stopped 8m ago");
      expect(noteOf(at({ key: "redo", status: "running", started: 2, replaces: { ...stopped, failed: true } }), "live")).toBe("Restart of the one that failed 8m ago");
      // Under a minute the replaced row's own slot says now, and the line says just now.
      expect(noteOf(at({ key: "redo", status: "running", started: 0, replaces: { ...stopped, endedAt: iso(NOW - 12_000) } }), "live")).toBe("Restart of the one stopped just now");
      // The thread it replaced is not among the rows: the prototype draws no line.
      expect(noteOf(at({ key: "redo", status: "running", started: 2, replaces: { ...stopped, endedAt: null } }), "live")).toBeUndefined();
      expect(noteOf(at({ key: "redo", status: "running", started: 2, replaces: stopped, asking: "Run pnpm install" }), "live")).toBe("Run pnpm install");
      expect(noteOf(at({ key: "redo", status: "running", started: 2, replaces: stopped, capped: CAP }), "live")).toBe(capRunningLine(CAP));
      // Once the restart ends it reads as any finished child; the thread it replaced reads as its own.
      expect(noteOf(at({ key: "redo", status: "completed", started: 2, ended: 1, read: true, replaces: stopped, lastLine: "Pushed the fix." }), "finished")).toBe("Pushed the fix.");
      expect(noteOf(at({ key: "c_sec1", status: "interrupted", started: 30, ended: 8, read: true, replacedBy: "thr_redo", lastLine: "Running the gate" }), "finished")).toBe("Running the gate");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts every live thread and subagent at any depth by what it does, and the finished at the top", () => {
    expect(countTree(top(), tree())).toEqual({ needsYou: 1, failed: 2, working: 8, workingSubagents: 2, waiting: 2, finished: 61 });
  });

  it("gives the lead Settle N finished over every finished thread anywhere in its tree, each once, no subagent, N counting the threads they hold", () => {
    const take = finishedTake(top(), tree());
    expect(take.threadIds).toHaveLength(61);
    expect(take.threadIds).toContain("thr_g_rebase");
    expect(new Set(take.threadIds).size).toBe(take.threadIds.length);
    expect(take.threads).toBe(61);
    expect(leadActs(LEAD, take, {}).map(a => a.title)).toEqual(["Settle 61 finished"]);
    // A finished thread with a finished one under it is one id sent and two threads counted.
    const pair = node({ key: "p", status: "completed", started: 30, ended: 20, read: true }, [node({ key: "k", status: "completed", started: 25, ended: 22, read: true })]);
    expect(finishedTake([{ node: pair, thread: pair.thread }], tree())).toEqual({ threadIds: ["thr_p"], threads: 2 });
    expect(leadActs(LEAD, { threadIds: [], threads: 0 }, {})).toEqual([]);
  });

  it("ends a read, finished thread in the muted check only in its fold; one that stands live for its child keeps its own status", () => {
    const parent = node({ key: "p", status: "completed", started: 30, ended: 20, read: true }, [node({ key: "k", status: "running", started: 2 })]);
    const at: LeadNode<Node> = { node: parent, thread: parent.thread };
    expect(partOf(at, tree())).toBe("live");
    expect(kindOf(at, "live").id).toBe("resting");
    expect(kindOf(at, "finished").id).toBe("finished");
  });

  it("gathers every settle's set through settleTake, so a settle that sends the node's id alone changes one function", () => {
    const source = (path: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", path), "utf8");
    const lead = source("components/threads/leadTree.ts");
    const readers = [...lead.matchAll(/^(?:export )?function (\w+)[^]*?^}/gm)].filter(([body, name]) => name !== "subtreeKeys" && body.includes("subtreeKeys(")).map(([, name]) => name);
    expect(readers).toEqual(["settleTake"]);
    expect(lead).not.toMatch(/^export function subtreeKeys/m);
    // The sidebar's sets come through treeSettle, which reads settleTake; the bare tree walk is never what a settle sends.
    expect(source("sidebar/WorkspaceSidebar.tsx")).not.toMatch(/threadIds:\s*[^,}]*treeThreadIds/);
  });
});
