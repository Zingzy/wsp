// SPDX-License-Identifier: AGPL-3.0-only
// The tree under a tile in the sidebar, drawn over the one reading of a lead's tree: its live children first, each
// with its own, then a Finished fold, shut each time it is drawn, that pages its rows twenty at a time and whose menu
// holds Settle N finished. A subagent is a slim row of its own. Settled children are not drawn here; a tree settled
// whole folds into the sidebar's Settled section. The list nests two levels and then stands flat, so the rows a
// level draws come back as list items for the caller to place. While an ended subagent's page is open its one row
// stands under the shut fold's head, and goes when the person leaves, the fold as it was.
import { ChevronDownIcon, CircleCheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CHILD_WORDS } from "../actions/format.js";
import { openContextMenu } from "../actions/contextMenu.js";
import type { ChildVerbs } from "../actions/threadActions.js";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { childParts, childTarget, finishedTake, kindOf, leadActs, leadNodes, noteOf, partOf, type LeadNode, type Tree } from "../components/threads/leadTree.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { isThreadWorking } from "./Sidebar.logic.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { CHILD_LIST_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_META_CLASS, threadRowId } from "./rowGrammar.js";
import { SubagentRow } from "./SubagentRow.js";
import type { TileNode } from "./threadTree.js";

/** How many rows an open fold mounts at a time. */
const PAGE = 20;

/** Whether a tile offers Settle on hover: it is a thread, and nothing in it or under it works, waits or asks. A failed
 * thread holds nothing, as the menu's Settle reads it. */
export function settlesOnHover(node: TileNode, tree: Tree<TileNode>): boolean {
  const quiet = (at: LeadNode<TileNode>): boolean => {
    if ("subagent" in at) return at.subagent.state !== "running";
    const thread = at.thread;
    return thread !== null && thread.asking === null && !isThreadWorking(thread) && leadNodes(thread, at.node.children, tree).every(quiet);
  };
  return quiet({ node, thread: node.thread.thread });
}

/** How many rows a tile would draw under it at any depth: its live threads and subagents and theirs, a Finished fold
 * counting none of what it holds. What a folded tile says. */
export function liveRows(lead: SidebarThreadSnapshot, kids: ReadonlyArray<TileNode>, tree: Tree<TileNode>): number {
  const count = (nodes: ReadonlyArray<LeadNode<TileNode>>): number =>
    nodes.filter(node => partOf(node, tree) === "live").reduce((sum, node) => sum + 1 + ("subagent" in node ? 0 : count(leadNodes(node.thread, node.node.children, tree))), 0);
  return count(leadNodes(lead, kids, tree));
}

export function LeadTree({
  lead,
  kids,
  depth,
  tree,
  verbs,
  tile,
}: {
  lead: SidebarThreadSnapshot;
  kids: ReadonlyArray<TileNode>;
  /** How deep the rows it draws stand, for the keyboard's walk. */
  depth: number;
  tree: Tree<TileNode>;
  verbs: ChildVerbs;
  /** One child thread's tile with everything under it, as the sidebar draws it; a finished one is a slim row. */
  tile: (node: TileNode, part: "live" | "finished") => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  // The subagent of this lead whose page is open, by its launching call.
  const opened = useStore(s => (s.selectedSubagent !== null && s.selectedId === lead.workspaceId && s.selectedThreadId === lead.threadId ? s.selectedSubagent : null));
  const nodes = leadNodes(lead, kids, tree);
  const parts = childParts(nodes, tree);
  const at = lead.threadId === null ? undefined : { workspaceId: lead.workspaceId, threadId: lead.threadId };
  const row = (node: LeadNode<TileNode>, part: "live" | "finished", rowDepth = depth): ReactNode => {
    if (!("subagent" in node)) return tile(node.node, part);
    const rowId = `subagent:${node.of.id}:${node.subagent.id}`;
    return (
      <li key={rowId} data-thread-item data-slim className={RAIL_ITEM_CLASS}>
        <SubagentRow subagent={node.subagent} target={childTarget(node, part, tree)} kind={kindOf(node, part)} note={noteOf(node, part)} depth={rowDepth} rowId={rowId} lead={at} active={opened !== null && node.subagent.parentToolUseId === opened} />
      </li>
    );
  };
  const page = open ? parts.finished.slice(0, shown) : [];
  const rest = parts.finished.length - page.length;
  const isOpened = (node: LeadNode<TileNode>): boolean => "subagent" in node && opened !== null && node.subagent.parentToolUseId === opened;
  // An ended subagent's open page keeps its row in sight under the shut fold, or where a settled one has no fold.
  const standing = open ? undefined : (parts.finished.find(isOpened) ?? parts.settled.find(isOpened));
  return (
    <>
      {parts.live.map(node => row(node, "live"))}
      {parts.finished.length === 0 ? null : (
        <li key="fold-finished" data-slim className={RAIL_ITEM_CLASS}>
          <SidebarMenuButton
            size="sm"
            data-child-fold="finished"
            data-sidebar-row
            data-row-id={`finished:${threadRowId(lead.id)}`}
            data-depth={depth}
            aria-expanded={open}
            className={cn(ONE_LINE_ROW_CLASS, "gap-1.5")}
            onClick={() => {
              setOpen(!open);
              setShown(PAGE);
            }}
            onContextMenu={event => void openContextMenu(event, leadActs(lead, finishedTake(nodes, tree), verbs))}
          >
            <CircleCheckIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{CHILD_WORDS.finished}</span>
            <span className={cn(ROW_META_CLASS, "shrink-0")}>{parts.finished.length}</span>
            <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform duration-150", !open && "-rotate-90")} />
          </SidebarMenuButton>
          {standing === undefined ? null : <ul className={CHILD_LIST_CLASS}>{row(standing, "finished", depth + 1)}</ul>}
        </li>
      )}
      {standing !== undefined && parts.finished.length === 0 ? row(standing, "finished") : null}
      {page.map(node => row(node, "finished"))}
      {open && rest > 0 ? (
        <li key="more" data-slim className={RAIL_ITEM_CLASS}>
          <SidebarMenuButton size="sm" data-child-fold="more" data-sidebar-row data-row-id={`more:${threadRowId(lead.id)}`} data-depth={depth} className={cn(ONE_LINE_ROW_CLASS, "gap-1.5")} onClick={() => setShown(n => n + PAGE)}>
            <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{CHILD_WORDS.moreRows(rest)}</span>
          </SidebarMenuButton>
        </li>
      ) : null}
    </>
  );
}
