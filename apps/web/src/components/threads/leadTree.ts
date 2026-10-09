// SPDX-License-Identifier: AGPL-3.0-only
// A lead's tree, read once for every place that draws it (the transcript's rows, the sidebar, the live tiles, the
// Threads bar): the part each child stands in and its order there, read off its whole subtree so trouble deep in the
// tree is never folded away; the line under its title; its status; the acts it takes; and what a settle of it takes.
// A place hands its own nodes in through Tree; a subagent is a node under the thread whose agent runs it, built from
// that thread's subagents, and every subagent of a thread stands flat under it whatever its depth.
import { capRunningLine, type SubagentView } from "@wsp/protocol";
import { childActions, leadActions, type ChildTarget, type ChildVerbs } from "../../actions/threadActions.js";
import { resolveActions, type ResolvedAction } from "../../actions/registry.js";
import type { SidebarThreadSnapshot } from "../../adapt/index.js";
import { isThreadSettled, isThreadWorking } from "../../sidebar/Sidebar.logic.js";
import { FINISHED } from "../status/kinds/finished.js";
import type { StatusKind, ThreadStatusInput } from "../status/kinds/index.js";
import { RESTING } from "../status/kinds/resting.js";
import { threadStatusOf } from "../status/threadStatusOf.js";

type Thread = SidebarThreadSnapshot;
export type ChildPart = "live" | "finished" | "settled";

/** A place's own nodes as the reading walks them: the thread each holds, null for one that holds none yet, and the
 * nodes under it. */
export interface Tree<N> {
  readonly threadOf: (node: N) => Thread | null;
  readonly kidsOf: (node: N) => ReadonlyArray<N>;
  readonly nowMs: number;
  readonly settleMs: number | null;
}

/** One child of the tree: a place's node with its thread, or a subagent with the thread whose agent runs it. */
export type LeadNode<N> = { readonly node: N; readonly thread: Thread | null } | { readonly subagent: SubagentView; readonly of: Thread };

const ms = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso));

/** The children under a thread: the place's own nodes, then the subagents its agent runs. */
export function leadNodes<N>(lead: Thread | null, kids: ReadonlyArray<N>, tree: Tree<N>): LeadNode<N>[] {
  return [...kids.map(node => ({ node, thread: tree.threadOf(node) })), ...(lead?.subagents ?? []).map(subagent => ({ subagent, of: lead! }))];
}

const kidsOf = <N>(node: LeadNode<N>, tree: Tree<N>): LeadNode<N>[] => ("subagent" in node ? [] : leadNodes(node.thread, tree.kidsOf(node.node), tree));

/** What a subagent's status is read off, as a thread's would be: it asks nothing and nobody reads it. */
export function subagentStatus(subagent: SubagentView): ThreadStatusInput {
  const status = subagent.state === "running" ? "running" : subagent.state === "done" ? "completed" : subagent.state === "failed" ? "failed" : "interrupted";
  return { status, asking: null, startedAt: new Date(subagent.startedAt).toISOString(), unread: false, limit: null, resumeAt: null };
}

/** A child's own part, read off it alone. A subagent is live while it runs, finished once it ends while the lead turn
 * it started in still runs, and settled once that turn is over or its thread is settled. */
function ownPart<N>(node: LeadNode<N>, tree: Pick<Tree<N>, "nowMs" | "settleMs">): ChildPart {
  if ("subagent" in node) {
    const { subagent, of } = node;
    if (subagent.state === "running") return "live";
    const inTurn = of.status === "running" && subagent.startedAt >= ms(of.startedAt);
    return inTurn && !isThreadSettled(of, tree.nowMs, false, tree.settleMs) ? "finished" : "settled";
  }
  const thread = node.thread;
  if (thread === null) return "live";
  if (isThreadSettled(thread, tree.nowMs, false, tree.settleMs)) return "settled";
  return thread.asking !== null || isThreadWorking(thread) || thread.status === "failed" ? "live" : "finished";
}

/** How pressing a child is on its own: asks or a limit, failed, works, waits, then quiet. A failed subagent is its
 * lead agent's to handle, so it is never live and ranks as quiet. */
function ownRank<N>(node: LeadNode<N>, part: ChildPart): number {
  if (part !== "live") return 4;
  if ("subagent" in node) return 2;
  const thread = node.thread;
  if (thread === null) return 2;
  if (thread.asking !== null || (thread.status === "failed" && (thread.limit ?? null) !== null)) return 0;
  if (thread.status === "failed") return 1;
  return thread.capped !== undefined ? 3 : 2;
}

function treeRank<N>(node: LeadNode<N>, tree: Tree<N>): number {
  return kidsOf(node, tree).reduce((best, kid) => Math.min(best, treeRank(kid, tree)), ownRank(node, ownPart(node, tree)));
}

/** The part a child's whole subtree stands in: live while anything in it is live, else its own. */
export function partOf<N>(node: LeadNode<N>, tree: Tree<N>): ChildPart {
  return treeRank(node, tree) < 4 ? "live" : ownPart(node, tree);
}

const startOf = <N>(node: LeadNode<N>): number => ("subagent" in node ? node.subagent.startedAt : ms(node.thread?.startedAt ?? null));
const endOf = <N>(node: LeadNode<N>): number => ("subagent" in node ? (node.subagent.endedAt ?? 0) : ms(node.thread?.endedAt ?? null));
const settleOf = <N>(node: LeadNode<N>): number => ("subagent" in node ? (node.subagent.endedAt ?? 0) : ms(node.thread?.settledAt ?? node.thread?.endedAt ?? null));

/** Children in their parts and each part's order: live by the most pressing rank in its subtree, newest first within
 * a rank; finished by newest end; settled by newest settle. */
export function childParts<N>(nodes: ReadonlyArray<LeadNode<N>>, tree: Tree<N>): Record<ChildPart, LeadNode<N>[]> {
  const parts: Record<ChildPart, LeadNode<N>[]> = { live: [], finished: [], settled: [] };
  const rank = new Map<LeadNode<N>, number>();
  for (const node of nodes) {
    rank.set(node, treeRank(node, tree));
    parts[rank.get(node)! < 4 ? "live" : ownPart(node, tree)].push(node);
  }
  parts.live.sort((a, b) => rank.get(a)! - rank.get(b)! || startOf(b) - startOf(a));
  parts.finished.sort((a, b) => endOf(b) - endOf(a));
  parts.settled.sort((a, b) => settleOf(b) - settleOf(a));
  return parts;
}

/** Every live thread and subagent in the tree at any depth by what it does, and the finished children at its top. */
export interface TreeCounts {
  readonly needsYou: number;
  readonly failed: number;
  readonly working: number;
  readonly workingSubagents: number;
  readonly waiting: number;
  readonly finished: number;
}

export function countTree<N>(nodes: ReadonlyArray<LeadNode<N>>, tree: Tree<N>): TreeCounts {
  const c = { needsYou: 0, failed: 0, working: 0, workingSubagents: 0, waiting: 0, finished: 0 };
  const walk = (node: LeadNode<N>, top: boolean): void => {
    const part = ownPart(node, tree);
    if (part === "live") {
      const rank = ownRank(node, part);
      if (rank === 0) c.needsYou++;
      else if (rank === 1) c.failed++;
      else if (rank === 3) c.waiting++;
      else if ("subagent" in node) c.workingSubagents++;
      else c.working++;
    } else if (top && part === "finished") c.finished++;
    for (const kid of kidsOf(node, tree)) walk(kid, false);
  };
  for (const node of nodes) walk(node, true);
  return { ...c, working: c.working + c.workingSubagents };
}

/** The line under a child's title: what it asks, why it failed, the threads at once that hold it, or a finished
 * child's last line. A settled child has none. */
export function noteOf<N>(node: LeadNode<N>, part: ChildPart): string | undefined {
  if (part === "settled") return undefined;
  if ("subagent" in node) {
    const { subagent } = node;
    if (subagent.state === "failed") return subagent.failure;
    return subagent.state === "running" ? undefined : subagent.lastLine;
  }
  const thread = node.thread;
  if (thread === null) return undefined;
  if (thread.asking !== null) return thread.asking;
  if (thread.status === "failed") return thread.failure ?? undefined;
  if (thread.capped !== undefined) return capRunningLine(thread.capped);
  return part === "finished" ? (thread.lastLine ?? undefined) : undefined;
}

/** The status a child's row ends in: the registry's, and in the Finished fold the muted check for a finished turn
 * already read, so green stays for the unread; a settled child keeps its age alone. */
export function kindOf<N>(node: LeadNode<N>, part: ChildPart): StatusKind {
  if (part === "settled") return RESTING;
  const input = "subagent" in node ? subagentStatus(node.subagent) : node.thread;
  if (input === null) return RESTING;
  const kind = threadStatusOf(input);
  return kind === RESTING && input.status === "completed" && part === "finished" ? FINISHED : kind;
}

/** The fold keys of a thread and every thread under it; a subagent folds with its turn and is never settled by hand. */
function subtreeKeys<N>(node: LeadNode<N>, tree: Tree<N>): string[] {
  const own = "subagent" in node || node.thread === null ? [] : [node.thread.id];
  return [...own, ...kidsOf(node, tree).flatMap(kid => subtreeKeys(kid, tree))];
}

const works = <N>(node: LeadNode<N>, tree: Tree<N>): boolean =>
  ("subagent" in node ? node.subagent.state === "running" : node.thread !== null && isThreadWorking(node.thread)) || kidsOf(node, tree).some(kid => works(kid, tree));

/** What a settle of a thread takes, and whether something in it works, which holds the settle: every settle in the
 * app is read here. It sends the thread and everything under it until the host settles down a tree itself. */
export function settleTake<N>(node: LeadNode<N>, tree: Tree<N>): { threadIds: string[]; working: boolean } {
  return { threadIds: subtreeKeys(node, tree), working: works(node, tree) };
}

/** Every finished thread anywhere in the tree with all it holds, each once: what the lead's Settle N finished takes. */
export function finishedKeys<N>(nodes: ReadonlyArray<LeadNode<N>>, tree: Tree<N>): string[] {
  return nodes.flatMap(node => ("subagent" in node ? [] : partOf(node, tree) === "finished" ? settleTake(node, tree).threadIds : finishedKeys(kidsOf(node, tree), tree)));
}

/** The act registry's target for one child. */
export function childTarget<N>(node: LeadNode<N>, part: ChildPart, tree: Tree<N>): ChildTarget {
  const take = settleTake(node, tree);
  if ("subagent" in node) {
    const { subagent, of } = node;
    return { title: subagent.title, sessionId: of.sessionId, harness: of.harness, task: subagent.id, part, running: subagent.state === "running", settles: [], working: take.working };
  }
  const thread = node.thread;
  return {
    title: thread?.title ?? "",
    sessionId: thread?.sessionId ?? "",
    harness: thread?.harness ?? "",
    task: null,
    part,
    running: thread?.status === "running",
    settles: take.threadIds,
    working: take.working,
  };
}

/** Every act a child takes, in the order its hover and its menu list them. */
export function childActs<N>(node: LeadNode<N>, part: ChildPart, tree: Tree<N>, verbs: ChildVerbs): ResolvedAction[] {
  if ("node" in node && node.thread === null) return [];
  return resolveActions(childActions, childTarget(node, part, tree), verbs);
}

/** The lead's own act over its tree: Settle N finished. */
export function leadActs(lead: Thread, finished: ReadonlyArray<string>, verbs: ChildVerbs): ResolvedAction[] {
  return resolveActions(leadActions, { title: lead.title, finished }, verbs);
}
