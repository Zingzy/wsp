// SPDX-License-Identifier: AGPL-3.0-only
// The Threads section under a lead's reply: its whole tree as leadTree reads it, each child in ThreadRows' grammar.
// Live children draw first, each with its own live children on the connector under it, two levels in and then flat;
// finished ones sit behind a fold at each level, settled ones behind a second fold at the top, and both start shut.
// Open, its head offers Settle N finished over every finished thread in the tree; it shuts from its head, which then
// says the tree's counts, to the most pressing live thread at any depth fading out under it, a peek that takes no act
// and opens the section on a press. Shut is the lead's entry in the host's preferences, apart from the sidebar's fold
// of the same tree, so a reload and every window agree.
// A row says nothing of a branch, a push or a merge: what a child keeps is its agent's to commit and push.
import { SETTLE_MS, type PlaceView } from "@wsp/protocol";
import { ArchiveIcon, ChevronDownIcon, ListTreeIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { runAction } from "../actions/contextMenu.js";
import { CHILD_WORDS } from "../actions/format.js";
import type { ResolvedAction } from "../actions/registry.js";
import { useChildVerbs } from "../actions/verbs.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { FoldRow } from "../components/threads/FoldRow.js";
import { childParts, childTarget, countTree, finishedTake, kindOf, leadActs, leadNodes, mostPressing, noteOf, type ChildPart, type LeadNode, type Tree, type TreeCounts as Counts } from "../components/threads/leadTree.js";
import { SubagentRow, ThreadRow } from "../components/threads/ThreadRows.js";
import { TreeCounts } from "../components/threads/TreeCounts.js";
import { Button } from "../components/ui/button.js";
import { useStore } from "../protocol/store.js";
import { TRANSCRIPT_ITEM_CLASS, TRANSCRIPT_LIST_CLASS } from "../sidebar/rowGrammar.js";
import { computerName, computerOf } from "../sidebar/workspaceRows.js";

/** A child as the transcript holds it: the thread, the computer it runs on and the threads it opened. */
export interface ChildNode {
  readonly thread: SidebarThreadSnapshot;
  readonly place: string;
  readonly at?: PlaceView | undefined;
  readonly children: ReadonlyArray<ChildNode>;
}

/** How many rows an open fold mounts at a time. */
const PAGE = 20;

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

/** One child's row with its own children under it; alone, the row without them. */
function Item({ node, part, depth, at, alone = false }: { node: LeadNode<ChildNode>; part: ChildPart; depth: number; at: Drawing; alone?: boolean }) {
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
    two = sending || note !== undefined || place !== "";
    row = <ThreadRow thread={thread} place={place} at={node.node.at} {...(note !== undefined ? { note } : {})} target={target} kind={kind} sending={sending} onSending={setSending} />;
    if (part !== "settled" && !alone) kids = leadNodes(thread, node.node.children, at.tree);
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

/** The section's head, the group label on a 32 px row as every list's head: the tree glyph in the mark column and
 * the word as the toggle, the tree's counts while shut, Settle N finished while open, and the chevron at the right. */
function Head({ counts, open, settle, onToggle }: { counts: Counts | undefined; open: boolean | undefined; settle: ResolvedAction | undefined; onToggle: () => void }) {
  const word = (
    <>
      <span className="inline-flex size-3.25 shrink-0 items-center justify-center">
        <ListTreeIcon aria-hidden className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate">{CHILD_WORDS.threads}</span>
      {counts === undefined ? null : <TreeCounts counts={counts} />}
    </>
  );
  return (
    <div data-threads-head className={cn(GROUP_LABEL, "flex h-8 w-full min-w-0 items-center gap-2.5 px-2 text-muted-foreground")}>
      {open === undefined ? (
        <span className="flex min-w-0 flex-1 items-center gap-2.5">{word}</span>
      ) : (
        <button
          type="button"
          data-threads-toggle
          aria-expanded={open}
          aria-label={open ? CHILD_WORDS.hideThreads : CHILD_WORDS.showThreads}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-[var(--control-radius)] text-left outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {word}
        </button>
      )}
      {settle === undefined ? null : (
        <Button type="button" size="xs" variant="outline" data-settle-finished disabled={settle.refusal !== null} {...(settle.refusal === null ? {} : { title: settle.refusal })} onClick={() => void runAction(settle)}>
          <ArchiveIcon aria-hidden />
          {settle.title}
        </Button>
      )}
      {open === undefined ? null : (
        <button type="button" data-threads-chevron aria-hidden tabIndex={-1} onClick={onToggle} className="inline-flex shrink-0 items-center outline-none transition-colors duration-150 hover:text-foreground">
          <ChevronDownIcon className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} />
        </button>
      )}
    </div>
  );
}

export function TreeRows({
  leadThread,
  leadPlace,
  nodes,
  className,
}: {
  /** The lead's own thread, whose subagents stand among its children and whose id keys the section's shut entry;
   * null while the listing holds none. */
  leadThread: SidebarThreadSnapshot | null;
  /** The computer the lead runs on, which a child's row leaves out. */
  leadPlace: string;
  nodes: ReadonlyArray<ChildNode>;
  className?: string;
}) {
  const settleMs = SETTLE_MS[useStore(s => s.preferences.settleAfter)];
  const leadId = leadThread?.id ?? null;
  const foldable = useStore(s => s.api?.setPreferences !== undefined) && leadId !== null;
  const shut = useStore(s => foldable && s.preferences.threadsShut?.[leadId!] === true);
  const setPreferences = useStore(s => s.setPreferences);
  const toggle = () => {
    if (leadId !== null) void setPreferences({ threadsShut: { [leadId]: shut ? null : true } });
  };
  const read: Tree<ChildNode> = { threadOf: n => n.thread, kidsOf: n => n.children, nowMs: Date.now(), settleMs };
  const at = { leadPlace, tree: read };
  const top = leadNodes(leadThread, nodes, read);
  const pressing = shut ? mostPressing(top, read) : undefined;
  const verbs = useChildVerbs();
  const [settle] = shut || leadThread === null ? [] : leadActs(leadThread, finishedTake(top, read), verbs);
  return (
    <div data-thread-rows {...(shut ? { "data-shut": "" } : {})} className={cn("flex flex-col", className)}>
      <Head counts={shut ? countTree(top, read) : undefined} open={foldable ? !shut : undefined} settle={settle} onToggle={toggle} />
      {!shut ? (
        <Level nodes={top} depth={1} at={at} top />
      ) : pressing === undefined ? null : (
        <div data-shut-peek aria-hidden onClick={toggle} className="cursor-pointer">
          <div data-shut-row inert className="mask-b-from-0%">
            <Item node={pressing} part="live" depth={1} at={at} alone />
          </div>
        </div>
      )}
    </div>
  );
}
