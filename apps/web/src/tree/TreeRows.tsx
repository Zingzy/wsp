// SPDX-License-Identifier: AGPL-3.0-only
// The THREADS list under a lead's reply: its whole tree as leadTree reads it, each child in ThreadRows' grammar. Live
// children draw first, each with its own live children on the connector under it, two levels in and then flat;
// finished ones sit behind a fold at each level, settled ones behind a second fold at the top, and both start shut.
// A child workspace's row keeps its branch and how far that branch is ahead of the lead's as the git host holds
// them, the push its computer could not make as the note, and the act there is to take once the thread is quiet:
// Merge into lead while it has commits the lead lacks, Ask the lead to merge it after a merge stopped on conflicts.
import { SETTLE_MS, TREE_WORDS, cannotPushFromLine, type PlaceView, type TreeChild, type TreeFact } from "@wsp/protocol";
import { useState, type ReactNode } from "react";
import { CHILD_WORDS } from "../actions/format.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { FoldRow } from "../components/threads/FoldRow.js";
import { childParts, childTarget, kindOf, leadNodes, noteOf, type ChildPart, type LeadNode, type Tree } from "../components/threads/leadTree.js";
import { SubagentRow, ThreadRow, ThreadRows, type ThreadRowItem } from "../components/threads/ThreadRows.js";
import { useStore } from "../protocol/store.js";
import { TRANSCRIPT_ITEM_CLASS, TRANSCRIPT_LIST_CLASS } from "../sidebar/rowGrammar.js";
import { computerName, computerOf } from "../sidebar/workspaceRows.js";
import { askLeadToMerge, mergeIntoLead } from "./acts.js";

interface Lead {
  readonly id: string;
  readonly name: string;
}

/** A child as the transcript holds it: the thread, the computer it runs on and the threads it opened. */
export interface ChildNode {
  readonly thread: SidebarThreadSnapshot;
  readonly place: string;
  readonly at?: PlaceView | undefined;
  readonly children: ReadonlyArray<ChildNode>;
}

/** How many rows an open fold mounts at a time. */
const PAGE = 20;

/** A thread with nothing running and nobody asked is one whose branch a merge can take. */
const quiet = (thread: SidebarThreadSnapshot): boolean => thread.status !== "running" && thread.asking === null;

/** The one fact beside a child's branch: its landing where it has one, else how far it stands from the lead's. */
function factOf(child: TreeChild, leadBranch: string): string {
  if (child.conflicts !== undefined && child.conflicts.length > 0) return TREE_WORDS.conflictsIn(child.conflicts.length);
  if (child.merged !== undefined && (child.aheadOfLead ?? 0) === 0) return TREE_WORDS.mergedIntoLead;
  if (child.pushed === false) return TREE_WORDS.notPushed;
  if (child.aheadOfLead === undefined) return TREE_WORDS.notCounted;
  return TREE_WORDS.aheadOf(child.aheadOfLead, leadBranch);
}

/** A thread's row with what its workspace's branch says, where the lead's tree holds that workspace. */
export function treeRowOf(lead: Lead, tree: TreeFact | undefined, row: ThreadRowItem): ThreadRowItem {
  const child = tree?.children.find(c => c.workspaceId === row.thread.workspaceId);
  if (tree === undefined || child === undefined) return row;
  const stuck = child.conflicts !== undefined && child.conflicts.length > 0;
  // Nothing counted means nothing says there is nothing to take: the merge says so itself where there was not.
  const hasMore = child.pushed !== false && (child.aheadOfLead === undefined || child.aheadOfLead > 0);
  const act = !quiet(row.thread)
    ? undefined
    : stuck
      ? { label: TREE_WORDS.askTheLead, run: () => void askLeadToMerge(lead, child.workspaceId) }
      : hasMore
        ? { label: TREE_WORDS.mergeIntoLead, run: () => void mergeIntoLead(lead, child.workspaceId) }
        : undefined;
  return {
    ...row,
    branch: { name: child.branch, fact: factOf(child, tree.leadBranch) },
    ...(child.pushRefused !== undefined ? { note: cannotPushFromLine(row.place, child.pushRefused) } : {}),
    ...(act !== undefined ? { act } : {}),
  };
}

/** Every thread under a lead at any depth off the listing the sidebar reads, each with the computer it runs on. */
export function childNodesOf(projects: ReadonlyArray<SidebarProjectSnapshot>, places: readonly PlaceView[], leadKey: string): ChildNode[] {
  const all = projects.flatMap(runs => runs.threads.map(thread => ({ thread, runs })));
  const build = (key: string, seen: ReadonlySet<string>): ChildNode[] =>
    all
      .filter(({ thread }) => thread.parentThreadId === key && !seen.has(thread.id))
      .map(({ thread, runs }) => ({ thread, place: computerName(places, runs), at: computerOf(places, runs), children: build(thread.id, new Set([...seen, thread.id])) }));
  return build(leadKey, new Set([leadKey]));
}

interface Drawing {
  readonly lead: Lead;
  readonly facts: TreeFact | undefined;
  readonly leadPlace: string;
  readonly tree: Tree<ChildNode>;
}

/** An open fold's rows, newest first: twenty mounted, and a row under them that mounts twenty more. */
function Paged({ items, render, more }: { items: ReadonlyArray<LeadNode<ChildNode>>; render: (item: LeadNode<ChildNode>) => ReactNode; more: (rest: number, show: () => void) => ReactNode }) {
  const [shown, setShown] = useState(PAGE);
  const page = items.slice(0, shown);
  const rest = items.length - page.length;
  return (
    <>
      {page.map(render)}
      {rest > 0 ? more(rest, () => setShown(n => n + PAGE)) : null}
    </>
  );
}

const keyOf = (node: LeadNode<ChildNode>): string => ("subagent" in node ? `subagent:${node.of.id}:${node.subagent.id}` : node.node.thread.id);

/** One level of the tree: its live children, then its Finished fold; the top level adds Settled. From the second
 * level on a child's own children stand at its x, in the same list. */
function Level({ nodes, depth, at, top }: { nodes: ReadonlyArray<LeadNode<ChildNode>>; depth: number; at: Drawing; top: boolean }) {
  const parts = childParts(nodes, at.tree);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const railed = depth > 1;
  const wrap = (child: ReactNode, key: string) =>
    railed ? (
      <li key={key} className={TRANSCRIPT_ITEM_CLASS}>
        {child}
      </li>
    ) : (
      <div key={key}>{child}</div>
    );
  const item = (node: LeadNode<ChildNode>, part: ChildPart) => <Item key={keyOf(node)} node={node} part={part} depth={depth} at={at} />;
  const more = (rest: number, show: () => void) => wrap(<FoldRow fold="more" label={CHILD_WORDS.moreRows(rest)} onToggle={show} />, "more");
  return (
    <>
      {parts.live.map(node => item(node, "live"))}
      {parts.finished.length > 0 ? wrap(<FoldRow fold="finished" label={CHILD_WORDS.finished} count={parts.finished.length} open={finishedOpen} onToggle={() => setFinishedOpen(open => !open)} />, "fold-finished") : null}
      {finishedOpen ? <Paged items={parts.finished} render={node => item(node, "finished")} more={more} /> : null}
      {top && parts.settled.length > 0 ? wrap(<FoldRow fold="settled" label={CHILD_WORDS.settledFold} count={parts.settled.length} open={settledOpen} onToggle={() => setSettledOpen(open => !open)} />, "fold-settled") : null}
      {top && settledOpen ? <Paged items={parts.settled} render={node => item(node, "settled")} more={more} /> : null}
    </>
  );
}

function Item({ node, part, depth, at }: { node: LeadNode<ChildNode>; part: ChildPart; depth: number; at: Drawing }) {
  const [sending, setSending] = useState(false);
  const note = noteOf(node, part);
  const target = childTarget(node, part, at.tree);
  const kind = kindOf(node, part);
  let row: ReactNode;
  let kids: LeadNode<ChildNode>[] = [];
  let two = note !== undefined;
  if ("subagent" in node) {
    row = <SubagentRow subagent={node.subagent} target={target} kind={kind} note={note} />;
  } else {
    const { thread } = node.node;
    const place = node.node.place === at.leadPlace ? "" : node.node.place;
    const item = treeRowOf(at.lead, at.facts, { thread, place, at: node.node.at, ...(note !== undefined ? { note } : {}) });
    two = sending || item.note !== undefined || place !== "";
    row = <ThreadRow {...item} target={target} kind={kind} sending={sending} onSending={setSending} />;
    if (part !== "settled") kids = leadNodes(thread, node.node.children, at.tree);
  }
  const level = kids.length === 0 ? null : <Level nodes={kids} depth={depth + 1} at={at} top={false} />;
  if (depth === 1)
    return (
      <div data-child-item>
        {row}
        {level === null ? null : <ul className={TRANSCRIPT_LIST_CLASS}>{level}</ul>}
      </div>
    );
  const own = (
    <li data-child-item {...(two ? { "data-two": "" } : {})} className={TRANSCRIPT_ITEM_CLASS}>
      {row}
    </li>
  );
  return level === null ? (
    own
  ) : (
    <>
      {own}
      {level}
    </>
  );
}

export function TreeRows({
  lead,
  tree,
  leadThread,
  leadPlace,
  nodes,
  className,
}: {
  lead: Lead;
  tree: TreeFact | undefined;
  /** The lead's own thread, whose subagents stand among its children; null while the listing holds none. */
  leadThread: SidebarThreadSnapshot | null;
  /** The computer the lead runs on, which a child's row leaves out. */
  leadPlace: string;
  nodes: ReadonlyArray<ChildNode>;
  className?: string;
}) {
  const settleMs = SETTLE_MS[useStore(s => s.preferences.settleAfter)];
  const read: Tree<ChildNode> = { threadOf: n => n.thread, kidsOf: n => n.children, nowMs: Date.now(), settleMs };
  return (
    <ThreadRows label="Threads" {...(className !== undefined ? { className } : {})}>
      <Level nodes={leadNodes(leadThread, nodes, read)} depth={1} at={{ lead, facts: tree, leadPlace, tree: read }} top />
    </ThreadRows>
  );
}
