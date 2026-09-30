// SPDX-License-Identifier: AGPL-3.0-only
// The THREADS list under a lead's reply as its tree of branches: each thread its agent opened, in ThreadRows' grammar,
// with its workspace's branch and how far that branch is ahead of the lead's as the git host holds them, the push its
// computer could not make as the note, and the act there is to take once the thread is quiet: Merge into lead while it
// has commits the lead lacks, Ask the lead to merge it after a merge stopped on conflicts.
import { TREE_WORDS, cannotPushFromLine, type TreeChild, type TreeFact } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { ThreadRows, type ThreadRowItem } from "../components/threads/ThreadRows.js";
import { askLeadToMerge, mergeIntoLead } from "./acts.js";

interface Lead {
  readonly id: string;
  readonly name: string;
}

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

export function TreeRows({ lead, tree, rows, className }: { lead: Lead; tree: TreeFact | undefined; rows: ReadonlyArray<ThreadRowItem>; className?: string }) {
  return <ThreadRows label="Threads" {...(className !== undefined ? { className } : {})} rows={rows.map(row => treeRowOf(lead, tree, row))} />;
}
