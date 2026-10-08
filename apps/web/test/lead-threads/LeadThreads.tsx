// SPDX-License-Identifier: AGPL-3.0-only
// A lead's tree, one component for its transcript's Threads block and its tree in the sidebar: the threads its agent
// started, the threads those started, and the subagents its own agent and its children's agents run. One reading
// decides everything both places draw: the part each child stands in (live, finished, settled) and its order there,
// read off its whole subtree so trouble deep in the tree is never folded away; the line under its title; and the
// acts it takes. The row is the place's own: ThreadRow's one-line row in the transcript, ThreadTile in the sidebar,
// and a subagent's one-line row in both, led by the glyph the timeline gives the call that launched it.
//
// Live children always draw, first, each with its live children indented under it on the connector, every level
// one step in; in the sidebar any tile folds its tree away. Finished ones sit behind a fold that starts shut; settled ones behind a second fold at the
// top of the transcript and nowhere else. A shut fold mounts nothing, and an open one mounts twenty rows and a row
// that mounts twenty more. A subagent is live while it runs and finished once it ends while its lead's turn goes
// on; when that turn ends it is settled, folded away like a settled thread. The transcript's whole block shuts to
// its head, which then counts what the tree holds in the status marks, over its first live row fading out; shut or
// open is remembered per lead.
//
// Prototype only. ChildRow is ThreadRow with what the build adds to ThreadRow itself: the acts the status slot
// yields to on hover, the message field that takes the note's place, the computer leading the note, and a
// subagent's glyph and card. The page's vite config puts TreeRows below in place of src/tree/TreeRows.tsx and
// LeadThreads in place of the sidebar's child list.
import { agentName } from "@wsp/catalog";
import { capRunningLine, SETTLE_MS, type PlaceView, type TreeFact } from "@wsp/protocol";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleStopIcon,
  EllipsisIcon,
  HourglassIcon,
  ListTreeIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  SquareIcon,
  type LucideIcon,
} from "lucide-react";
import { cloneElement, memo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { create } from "zustand";
import { openContextMenu } from "../../src/actions/contextMenu";
import { THREAD_WORDS } from "../../src/actions/format";
import type { ResolvedAction } from "../../src/actions/registry";
import type { SidebarThreadSnapshot } from "../../src/adapt/index";
import { HarnessMark } from "../../src/components/chat/HarnessMark";
import { Crab } from "../../src/components/status/Crab";
import type { StatusKind } from "../../src/components/status/kinds/index";
import { restingAge } from "../../src/components/status/restingAge";
import { RESTING } from "../../src/components/status/kinds/resting";
import { LINE_SLOT_CLASS, ThreadStatus } from "../../src/components/status/ThreadStatus";
import { threadStatusOf } from "../../src/components/status/threadStatusOf";
import { WorkingSince } from "../../src/components/status/WorkingSince";
import { ThreadLink } from "../../src/components/ThreadLink";
import { Button } from "../../src/components/ui/button";
import { SidebarMenuButton } from "../../src/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/components/ui/tooltip";
import { GROUP_LABEL } from "../../src/lib/microLabel";
import { cn } from "../../src/lib/utils";
import { addNotice } from "../../src/notices/store";
import { usePlaces, useSidebarProjects, useStore } from "../../src/protocol/store";
import { ComputerGlyph } from "../../src/settings/ComputerGlyph";
import { requestComposerFocus } from "../../src/shell/shellRequests";
import { isThreadSettled, isThreadWorking } from "../../src/sidebar/Sidebar.logic";
import { CHILD_LIST_CLASS, HOVER_GLYPH_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_META_CLASS, threadRowId } from "../../src/sidebar/rowGrammar";
import { RowNameInput } from "../../src/sidebar/RowNameInput";
import type { TileNode } from "../../src/sidebar/threadTree";
import { computerName, computerOf } from "../../src/sidebar/workspaceRows";
import { CHILD_FACTS, type ChildFacts } from "./fixtures";
import { setSubagentPageCheck } from "./mode";
import { TRANSCRIPT_ITEM, TRANSCRIPT_LIST } from "./rail";

type Thread = SidebarThreadSnapshot;
export type ChildPart = "live" | "finished" | "settled";

/** Ended by a stop: the glyph, its word on the hover, and the age beside it, in the row's own ink. */
export const STOPPED: StatusKind = { id: "stopped", is: () => false, glyph: CircleStopIcon, word: "Stopped", glyphOnly: true, aged: true };

/** How many rows an open fold mounts at a time. */
const PAGE = 20;
/** How long the pointer rests on a subagent's row before its card opens, the tile card's own delay. */
const CARD_DELAY_MS = 450;

const params = new URLSearchParams(window.location.search);
/** The shut block's three shapes, for the owner to compare: its head over the first live row fading out (the pick),
 * over two, or its head alone. */
const SHUT_SHAPE: "peek" | "peek2" | "line" = params.get("shut-shape") === "line" ? "line" : params.get("shut-shape") === "peek2" ? "peek2" : "peek";
const COUNT_DRAWS = params.has("renders");

export const keyOf = (thread: Pick<Thread, "id" | "threadId">): string => thread.threadId ?? thread.id;
const factsOf = (thread: Thread): ChildFacts => CHILD_FACTS[keyOf(thread)] ?? {};
export const isSubagent = (thread: Thread): boolean => factsOf(thread).subagentOf !== undefined;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const LEAD_WORDS = {
  threads: "Threads",
  finished: "Finished",
  settled: "Settled",
  send: "Send a message",
  menu: "More",
  settleFinished: (n: number) => `Settle ${n} finished`,
  settledLine: (n: number) => `Settled ${plural(n, "finished thread")}`,
  undo: "Undo",
  restartOf: (old: Thread) => `Restart of the one ${old.status === "failed" ? "that failed" : "stopped"} ${restingAge(old)} ago`,
  openReplaced: "Open the thread it replaced",
  openRestart: "Open its restart",
  messageTo: (title: string) => `Message to ${title}`,
  more: (n: number) => `${n} more`,
  stopSubagent: "Stop subagent",
  runsOn: (computer: string) => `Runs on ${computer}`,
  needsYou: (n: number) => `${n} ${n === 1 ? "thread needs" : "threads need"} you`,
  under: (words: string) => `Under it: ${words}`,
  failed: (n: number) => `${n} failed`,
  working: (n: number, threads: number, subagents: number) => (subagents === 0 ? `${n} working` : `${n} working: ${plural(threads, "thread")} and ${plural(subagents, "subagent")}`),
  waiting: (n: number) => `${n} waiting for a slot`,
  allFinished: (n: number) => `${n} finished`,
  shut: "Show the threads",
  open: "Hide the threads",
  asked: "Asked",
  lead: "Lead",
} as const;

/** A child in the tree as either place holds it: the thread, null for a workspace that holds none yet, and its
 * children. The sidebar's TileNode and the transcript's node both read through this. */
export interface Tree<N> {
  readonly threadOf: (node: N) => Thread | null;
  readonly kidsOf: (node: N) => ReadonlyArray<N>;
  /** A thread anywhere in the tree or over it, by key: what a subagent's lead and a restart's link are read off. */
  readonly byKey: ReadonlyMap<string, Thread>;
  readonly nowMs: number;
  readonly settleMs: number | null;
}

/** A child's own part, read off it alone. A subagent is live while it runs, finished once it ends while its lead's
 * turn runs, and settled once that turn is over. */
function ownPart(thread: Thread, tree: Pick<Tree<unknown>, "byKey" | "nowMs" | "settleMs">): ChildPart {
  const facts = factsOf(thread);
  if (facts.subagentOf !== undefined) {
    if (thread.status === "running") return "live";
    const lead = tree.byKey.get(facts.subagentOf);
    return facts.earlierTurn === true || lead === undefined || lead.status !== "running" ? "settled" : "finished";
  }
  if (isThreadSettled(thread, tree.nowMs, false, tree.settleMs)) return "settled";
  if (thread.asking !== null || isThreadWorking(thread) || thread.status === "failed") return "live";
  return "finished";
}

/** How pressing a child is on its own: asks, failed, works, waits, then everything quiet. A failed subagent is its
 * lead agent's to handle, so it ranks as quiet. */
function ownRank(thread: Thread, part: ChildPart): number {
  if (part !== "live") return 4;
  if (thread.asking !== null || (thread.status === "failed" && (thread.limit ?? null) !== null)) return 0;
  if (thread.status === "failed") return 1;
  return thread.capped !== undefined ? 3 : 2;
}

/** The most pressing rank in a child's subtree, itself included. */
function treeRank<N>(node: N, tree: Tree<N>): number {
  const thread = tree.threadOf(node);
  const own = thread === null ? 2 : ownRank(thread, ownPart(thread, tree));
  return tree.kidsOf(node).reduce((best, kid) => Math.min(best, treeRank(kid, tree)), own);
}

/** The part a child's whole subtree stands in: live while anything in it is live, else its own. */
export function partOf<N>(node: N, tree: Tree<N>): ChildPart {
  const thread = tree.threadOf(node);
  if (thread === null) return "live";
  return treeRank(node, tree) < 4 ? "live" : ownPart(thread, tree);
}

const at = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso));

/** Children in their parts and in each part's order: live by the most pressing of their subtrees, then newest;
 * finished by newest end; settled by newest settle. */
export function childParts<N>(nodes: ReadonlyArray<N>, tree: Tree<N>): Record<ChildPart, N[]> {
  const parts: Record<ChildPart, N[]> = { live: [], finished: [], settled: [] };
  for (const node of nodes) parts[partOf(node, tree)].push(node);
  const time = (node: N, of: (t: Thread) => string | null): number => {
    const thread = tree.threadOf(node);
    return thread === null ? 0 : at(of(thread));
  };
  parts.live.sort((a, b) => treeRank(a, tree) - treeRank(b, tree) || time(b, t => t.startedAt) - time(a, t => t.startedAt));
  parts.finished.sort((a, b) => time(b, t => t.endedAt) - time(a, t => t.endedAt));
  parts.settled.sort((a, b) => time(b, t => t.settledAt ?? t.endedAt) - time(a, t => t.settledAt ?? t.endedAt));
  return parts;
}

/** What the shut block counts: every live thread and subagent in the tree at any depth, by what it is doing. */
export interface TreeCounts {
  readonly needsYou: number;
  readonly failed: number;
  readonly working: number;
  readonly workingSubagents: number;
  readonly waiting: number;
  readonly finished: number;
}
export function countTree<N>(nodes: ReadonlyArray<N>, tree: Tree<N>): TreeCounts {
  const c = { needsYou: 0, failed: 0, working: 0, workingSubagents: 0, waiting: 0, finished: 0 };
  const walk = (node: N, top: boolean): void => {
    const thread = tree.threadOf(node);
    if (thread !== null) {
      const part = ownPart(thread, tree);
      if (part === "live") {
        const rank = ownRank(thread, part);
        if (rank === 0) c.needsYou++;
        else if (rank === 1) c.failed++;
        else if (rank === 3) c.waiting++;
        else if (isSubagent(thread)) c.workingSubagents++;
        else c.working++;
      } else if (top && part === "finished") c.finished++;
    }
    for (const kid of tree.kidsOf(node)) walk(kid, false);
  };
  for (const node of nodes) walk(node, true);
  return { ...c, working: c.working + c.workingSubagents };
}

/** The line under a child's title: what it asks, why it failed, what holds it, the thread it restarts, or the last
 * line of its reply. A settled child keeps one line. */
export function noteOf(thread: Thread, part: ChildPart, byKey: ReadonlyMap<string, Thread>): string | undefined {
  if (part === "settled") return undefined;
  const facts = factsOf(thread);
  if (thread.asking !== null) return thread.asking;
  if (thread.status === "failed") return facts.why;
  if (thread.capped !== undefined) return capRunningLine(thread.capped);
  if (thread.status !== "running") return facts.lastLine;
  const old = facts.replaces === undefined ? undefined : byKey.get(facts.replaces);
  return old === undefined ? undefined : LEAD_WORDS.restartOf(old);
}

/** What the page keeps between draws: which folds stand open, the row whose message field is open, and the row whose
 * acts stand shown without a pointer (its menu is open, or the page was asked to show them). One selector per row,
 * so opening one row's field draws that row alone. */
interface LeadUi {
  readonly open: Readonly<Record<string, boolean>>;
  readonly sending: string | null;
  readonly shown: string | null;
}
export const useLeadUi = create<LeadUi>(() => ({ open: {}, sending: null, shown: null }));
const foldKey = (place: "transcript" | "sidebar", parent: string, part: ChildPart): string => `${place}:${parent}:${part}`;
const toggleFold = (key: string): void => useLeadUi.setState(s => ({ open: { ...s.open, [key]: !(s.open[key] ?? false) } }));
// Leaving a thread shuts the transcript's folds and closes a message field; the sidebar's folds stay as they were.
useStore.subscribe((now, before) => {
  if (now.selectedThreadId === before.selectedThreadId) return;
  useLeadUi.setState(s => ({ open: Object.fromEntries(Object.entries(s.open).filter(([key]) => !key.startsWith("transcript:"))), sending: null, shown: null }));
});

/** Which leads' blocks the person shut, kept in the window, so a lead opens the way it was left. The build keeps it
 * with the lead's other marks on the host, so every window agrees. */
const SHUT_KEY = "wsp-proto:lead-threads-shut";
const readShut = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(SHUT_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};
export const useLeadShut = create<{ shut: Record<string, boolean> }>(() => ({ shut: readShut() }));
const toggleShut = (lead: string): void => {
  const shut = { ...useLeadShut.getState().shut, [lead]: !(useLeadShut.getState().shut[lead] ?? false) };
  localStorage.setItem(SHUT_KEY, JSON.stringify(shut));
  useLeadShut.setState({ shut });
};

const action = (id: string, title: string, icon: LucideIcon | undefined, run: () => void | Promise<void>, group = "state"): ResolvedAction => ({
  id,
  group,
  ...(icon !== undefined ? { icon } : {}),
  destructive: false,
  searchTerms: [],
  title,
  rowLabel: null,
  buttonWord: null,
  hint: null,
  refusal: null,
  run: async () => void (await run()),
});

const stop = (thread: Thread): void => void useStore.getState().api?.interruptSession?.(thread.sessionId);
const settle = (keys: string[]): void => void useStore.getState().settleThreads(keys);
const restore = (keys: string[]): void => void useStore.getState().restoreThreads(keys);
const open = (thread: Thread): void => {
  if (thread.threadId !== null) useStore.getState().select(thread.workspaceId, thread.threadId);
};
const sendTo = (thread: Thread, prompt: string): void => {
  useLeadUi.setState({ sending: null });
  void useStore.getState().api?.startSession({ workspaceId: thread.workspaceId, harness: thread.harness, prompt, ...(thread.threadId !== null ? { thread: thread.threadId } : {}) });
};

/** The fold keys of a thread and every thread under it, what a settle of it takes; subagents fold with their turn
 * and are never settled by hand. */
export function subtreeKeys<N>(node: N, tree: Tree<N>): string[] {
  const thread = tree.threadOf(node);
  const own = thread === null || isSubagent(thread) ? [] : [thread.id];
  return [...own, ...tree.kidsOf(node).flatMap(kid => subtreeKeys(kid, tree))];
}

/** Every act a child takes, in the order its menu lists them; the transcript's row puts the first two on its hover.
 * A message is typed in the transcript's row, and in the sidebar in the child's own composer. A subagent takes Stop
 * while it runs and nothing after: no message reaches it until its lead can relay one (#1613 step 2). */
export function childActs(thread: Thread, part: ChildPart, place: "transcript" | "sidebar", byKey: ReadonlyMap<string, Thread>, subtree: () => string[]): ResolvedAction[] {
  const key = keyOf(thread);
  const facts = factsOf(thread);
  if (facts.subagentOf !== undefined) return thread.status === "running" ? [action("stop", LEAD_WORDS.stopSubagent, SquareIcon, () => stop(thread))] : [];
  const send = action("send", LEAD_WORDS.send, MessageSquareIcon, () => {
    if (place === "transcript") useLeadUi.setState({ sending: key });
    else {
      open(thread);
      requestComposerFocus(thread.workspaceId);
    }
  }, "talk");
  const state =
    part === "settled"
      ? action("restore", THREAD_WORDS.restore, ArchiveRestoreIcon, () => restore(subtree()))
      : isThreadWorking(thread) || thread.asking !== null
        ? action("stop", THREAD_WORDS.stop, SquareIcon, () => stop(thread))
        : action("settle", THREAD_WORDS.settle, ArchiveIcon, () => settle(subtree()));
  const replaced = facts.replaces === undefined ? undefined : byKey.get(facts.replaces);
  const restart = facts.replacedBy === undefined ? undefined : byKey.get(facts.replacedBy);
  return [
    send,
    state,
    ...(replaced !== undefined ? [action("open-replaced", LEAD_WORDS.openReplaced, undefined, () => open(replaced), "open")] : []),
    ...(restart !== undefined ? [action("open-restart", LEAD_WORDS.openRestart, undefined, () => open(restart), "open")] : []),
  ];
}

/** Every finished thread anywhere in the tree with all it holds, each once: what Settle finished takes. */
function finishedKeys<N>(nodes: ReadonlyArray<N>, tree: Tree<N>): string[] {
  return nodes.flatMap(node => {
    const thread = tree.threadOf(node);
    if (thread !== null && !isSubagent(thread) && partOf(node, tree) === "finished") return subtreeKeys(node, tree);
    return finishedKeys(tree.kidsOf(node), tree);
  });
}

/** Settles every finished thread at once, with the way back on the toast. */
function settleFinished(lead: string, keys: string[]): ResolvedAction {
  return action("settle-finished", LEAD_WORDS.settleFinished(keys.length), ArchiveIcon, async () => {
    await useStore.getState().settleThreads(keys);
    addNotice({ kind: "done", text: LEAD_WORDS.settledLine(keys.length), where: lead, action: { word: LEAD_WORDS.undo, run: () => restore(keys) } });
  });
}

/** An open fold's rows, newest first: twenty mounted, and a row under them that mounts twenty more. */
function Paged<T>({ items, render, more }: { items: ReadonlyArray<T>; render: (item: T) => ReactNode; more: (rest: number, show: () => void) => ReactNode }) {
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

/** One of the row's acts on its hover: a ghost glyph button, its word on the tooltip. */
function Act({ icon: Icon, label, run }: { icon: LucideIcon; label: string; run: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            onClick={event => {
              event.stopPropagation();
              run(event);
            }}
          />
        }
      >
        <Icon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A subagent's card, the tile card's skin: its task, what it was asked, what it said once it ended, its model and
 * how long it ran. The build exports TileCard from ThreadTile and gives it these lines. */
function SubagentCard({ thread, kind }: { thread: Thread; kind: StatusKind }) {
  const facts = factsOf(thread);
  // The tile card's line: a 12 px glyph, then the words on the column the status row's word stands on. What it was
  // asked has the message's glyph, named for a screen reader; what it said is the status row's reason once it is done;
  // the agent line is its mark.
  const lines: Array<{ id: string; glyph: ReactNode; text: string; clamp?: boolean }> = [
    ...(facts.prompt === undefined ? [] : [{ id: "asked", glyph: <MessageSquareTextIcon role="img" aria-label={LEAD_WORDS.asked} className="size-3" />, text: facts.prompt, clamp: true }]),
    { id: "agent", glyph: <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-3" />, text: facts.model ?? agentName(thread.harness) },
  ];
  return (
    <TooltipPopup side="right" align="start" sideOffset={6} data-subagent-card className="max-w-72 text-left whitespace-normal">
      <div className="flex min-w-0 flex-col gap-1.5 py-1">
        <p className="font-medium text-foreground">{thread.title}</p>
        <ul className="flex min-w-0 flex-col gap-1 text-muted-foreground">
          <StatusLine thread={thread} kind={kind} />
          {lines.map(line => (
            <li key={line.id} data-tile-card-line={line.id} className="flex min-w-0 items-start gap-2">
              <span className="mt-[3px] flex shrink-0">{line.glyph}</span>
              <span className={cn("min-w-0 break-words", line.clamp === true && "line-clamp-3")}>{line.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </TooltipPopup>
  );
}

/** The computer a child runs on, where that is not its lead's: its glyph and its name, the first fact of the row's
 * second line, as a tile's first row names it. */
function RunsOn({ at, name }: { at: PlaceView | undefined; name: string }) {
  return (
    <span data-child-runs-on className="inline-flex shrink-0 items-center gap-1" title={LEAD_WORDS.runsOn(name)}>
      {at === undefined ? null : <ComputerGlyph place={at} className="size-3" />}
      {name}
    </span>
  );
}

interface ChildRowProps {
  readonly thread: Thread;
  readonly part: ChildPart;
  /** The computer it runs on, empty where that is the lead's own. */
  readonly place: string;
  readonly at: PlaceView | undefined;
  readonly note: string | undefined;
  readonly byKey: ReadonlyMap<string, Thread>;
  readonly subtree: () => string[];
  /** Drawn as the shut block's peek: no acts, no menu, no card. */
  readonly peek?: boolean;
}

const DRAWN = ["title", "status", "asking", "startedAt", "endedAt", "readAt", "settledAt", "unread", "harness", "threadId", "resumeAt"] as const;
/** A row draws again only when something it draws moved, so a status change elsewhere in the list leaves it alone. */
const sameRow = (a: ChildRowProps, b: ChildRowProps): boolean =>
  a.part === b.part && a.place === b.place && a.note === b.note && a.peek === b.peek && DRAWN.every(field => a.thread[field] === b.thread[field]) && a.thread.capped?.running === b.thread.capped?.running;

/** Whether a row stands two lines high: a note, a computer that is not the lead's, or the message field open. */
const twoLinesOf = (note: string | undefined, place: string, sending: boolean): boolean => sending || note !== undefined || place !== "";

/** ThreadRow, with the acts its status slot yields to on hover, the message field that takes its note's place, the
 * computer leading its second line, and for a subagent the launching call's glyph and the card on rest. */
const ChildRow = memo(function ChildRow({ thread, part, place, at, note, byKey, subtree, peek = false }: ChildRowProps) {
  const key = keyOf(thread);
  const sending = useLeadUi(s => !peek && s.sending === key);
  const shown = useLeadUi(s => !peek && s.shown === key);
  const draws = useRef(0);
  draws.current += 1;
  const subagent = isSubagent(thread);
  const acts = peek ? [] : childActs(thread, part, "transcript", byKey, subtree);
  const menu = (event: MouseEvent<HTMLElement>): void => {
    if (acts.length === 0) return;
    useLeadUi.setState({ shown: key });
    void openContextMenu(event, acts).finally(() => useLeadUi.setState(s => (s.shown === key ? { shown: null } : s)));
  };
  const kind = kindOf(thread, part === "settled", part === "finished");
  const twoLines = twoLinesOf(note, place, sending);
  // The slot's status gives way to the acts while the pointer or the focus is on the row, or its menu is open; a row
  // with no act to take keeps its status.
  const yields = !sending && acts.length > 0;
  const title = <ThreadLink thread={thread} className={cn("min-w-0 truncate", part === "settled" ? "text-muted-foreground" : "text-foreground")} />;
  return (
    <div
      data-child-row={key}
      data-child-part={part}
      {...(subagent ? { "data-subagent": "" } : {})}
      {...(shown ? { "data-acts": "shown" } : {})}
      {...(COUNT_DRAWS ? { "data-draws": draws.current } : {})}
      className={cn(
        "group/child flex min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-sm transition-colors duration-150",
        !peek && "hover:bg-accent data-[acts=shown]:bg-accent",
        twoLines ? "min-h-12 py-1.5" : "h-9",
        !peek && thread.threadId !== null && "cursor-pointer",
      )}
      {...(peek
        ? {}
        : {
            onClick: (event: MouseEvent<HTMLDivElement>) => {
              if (!(event.target instanceof Element) || event.target.closest("a, button, input") === null) open(thread);
            },
            onContextMenu: menu,
          })}
    >
      <span className="inline-flex shrink-0 text-muted-foreground">
        {subagent ? <BotIcon aria-hidden data-subagent-mark className="size-[13px]" /> : <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />}
      </span>
      <span className="flex min-w-28 flex-1 flex-col">
        {subagent && !peek ? (
          <Tooltip>
            <TooltipTrigger delay={CARD_DELAY_MS} render={<span className="flex min-w-0" />}>
              {title}
            </TooltipTrigger>
            <SubagentCard thread={thread} kind={kind} />
          </Tooltip>
        ) : (
          title
        )}
        {sending ? (
          <span className="flex h-[18px] min-w-0 text-[13px]" ref={el => el?.querySelector("input")?.setAttribute("placeholder", LEAD_WORDS.send)}>
            <RowNameInput name="" label={LEAD_WORDS.messageTo(thread.title)} saving={false} onRename={text => sendTo(thread, text)} onCancel={() => useLeadUi.setState({ sending: null })} />
          </span>
        ) : twoLines ? (
          <span data-child-note className="flex min-w-0 items-center gap-3 text-[11px] leading-[14px] text-muted-foreground">
            {place === "" ? null : <RunsOn at={at} name={place} />}
            {note === undefined ? null : (
              <span className="min-w-0 truncate" title={note}>
                {note}
              </span>
            )}
          </span>
        ) : null}
      </span>
      {/* The acts' room is kept as the sidebar keeps its hover glyph's, from md up, where the acts are drawn at all. */}
      <span className={cn("relative flex shrink-0 items-center justify-end", yields && (acts.length > 1 ? "md:min-w-20" : "md:min-w-6"))}>
        <span className={cn("inline-flex min-w-4 shrink-0 items-center justify-end text-xs text-muted-foreground", yields && "md:group-hover/child:invisible md:group-focus-within/child:invisible md:group-data-[acts=shown]/child:invisible")}>
          <StatusIcon thread={thread} kind={kind} tip={!peek} />
        </span>
        {yields ? (
          <span data-child-acts className={cn("absolute inset-y-0 right-0 flex items-center justify-end gap-1 transition-opacity duration-150 group-hover/child:opacity-100 group-focus-within/child:opacity-100 group-data-[acts=shown]/child:opacity-100", HOVER_GLYPH_CLASS)}>
            {acts.slice(0, 2).map(act => (
              <Act key={act.id} icon={act.icon!} label={act.title} run={() => void act.run()} />
            ))}
            {acts.length > 1 ? <Act icon={EllipsisIcon} label={LEAD_WORDS.menu} run={menu} /> : null}
          </span>
        ) : null}
      </span>
    </div>
  );
}, sameRow);

/** A fold in the transcript, the sidebar fold row's shape in ThreadRow's box: the part's icon in the mark column
 * (the check the sidebar's Finished row wears, the archive Settle wears), the part's word, then its count with the
 * chevron beside it at the right, turning as the sidebar's does. A row that mounts more rows wears the double chevron. */
function FoldRow({ part, label, count, open: isOpen, onToggle, onContextMenu }: { part: ChildPart | "more"; label: string; count?: number; open?: boolean; onToggle: () => void; onContextMenu?: (event: MouseEvent<HTMLElement>) => void }) {
  const Icon = part === "settled" ? ArchiveIcon : part === "more" ? ChevronsDownIcon : CircleCheckIcon;
  return (
    <button
      type="button"
      data-child-fold={part}
      {...(isOpen !== undefined ? { "aria-expanded": isOpen } : {})}
      onClick={onToggle}
      {...(onContextMenu !== undefined ? { onContextMenu } : {})}
      className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-left text-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="inline-flex size-[13px] shrink-0 items-center justify-center">
        <Icon aria-hidden className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined && isOpen === undefined ? null : (
        <span className={cn(LINE_SLOT_CLASS, "inline-flex items-center gap-1")}>
          {count}
          {isOpen === undefined ? null : <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-150", !isOpen && "-rotate-90")} />}
        </span>
      )}
    </button>
  );
}

/** The shut block's count of the tree, in the status marks' own glyphs and inks, each word on its hover: asks,
 * failed, works, waits; with nothing live, how many finished, in the row's ink. */
export function TreeSummary({ counts, quiet = false }: { counts: TreeCounts; quiet?: boolean }) {
  const marks: Array<{ id: string; n: number; ink: string; glyph: ReactNode; word: string }> = [
    { id: "needs-you", n: counts.needsYou, ink: "text-status-input", glyph: <MessageCircleQuestionIcon aria-hidden className="size-3" />, word: LEAD_WORDS.needsYou(counts.needsYou) },
    { id: "failed", n: counts.failed, ink: "text-status-failed", glyph: <CircleAlertIcon aria-hidden className="size-3" />, word: LEAD_WORDS.failed(counts.failed) },
    { id: "working", n: counts.working, ink: "text-status-working", glyph: <Crab />, word: LEAD_WORDS.working(counts.working, counts.working - counts.workingSubagents, counts.workingSubagents) },
    { id: "waiting", n: counts.waiting, ink: "text-muted-foreground", glyph: <HourglassIcon aria-hidden className="size-3" />, word: LEAD_WORDS.waiting(counts.waiting) },
  ].filter(mark => mark.n > 0);
  if (marks.length === 0) return <span className="text-xs text-muted-foreground tabular-nums">{counts.finished > 0 ? LEAD_WORDS.allFinished(counts.finished) : null}</span>;
  return (
    <span data-tree-summary className="inline-flex items-center gap-3 text-xs tabular-nums">
      {marks.map(mark => (
        <Tooltip key={mark.id}>
          <TooltipTrigger render={<span data-tree-count={mark.id} className={cn("inline-flex items-center gap-1", quiet ? "font-normal text-muted-foreground" : cn("font-medium", mark.ink))} />}>
            {mark.id === "working" ? (
              <>
                {mark.n}
                <span className={cn("inline-flex", mark.ink)}>{mark.glyph}</span>
              </>
            ) : (
              <>
                <span className={cn("inline-flex", mark.ink)}>{mark.glyph}</span>
                {mark.n}
              </>
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">{mark.word}</TooltipPopup>
        </Tooltip>
      ))}
    </span>
  );
}

/** A finished child once seen: the check Done wears, in the row's own ink, so every row of a Finished fold ends in
 * the same mark whether or not a window has opened it. */
export const FINISHED: StatusKind = { id: "finished", is: () => false, glyph: CircleCheckIcon, word: "Done", glyphOnly: true };

/** The status a thread reads as, the registry's, with Stopped for a turn a stop ended once nothing else is news, and
 * in a Finished fold the check for a finished turn already seen. */
export function kindOf(thread: Thread, settled = false, finished = false): StatusKind {
  if (settled) return RESTING;
  const kind = threadStatusOf(thread);
  if (thread.status === "interrupted" && (kind.id === "resting" || kind.id === "done")) return STOPPED;
  return finished && kind.id === "resting" && thread.status === "completed" ? FINISHED : kind;
}

/** A status's one word, the hover and the screen reader's: the kind's own, or for a thread at rest how it ended. */
export function statusWord(thread: Thread, kind: StatusKind): string {
  if (kind.word !== undefined) return kind.word;
  if (kind.wordOf !== undefined) return kind.wordOf(thread, Date.now());
  return thread.status === "failed" ? "Failed" : "Done";
}

/** Why a thread stands where it does, in one line: what it asks, why it failed, what holds it, or its last line. */
export function statusReason(thread: Thread, kind: StatusKind): string | undefined {
  const facts = factsOf(thread);
  if (thread.asking !== null) return thread.asking;
  if (kind.id === "failed") return facts.why;
  if (thread.capped !== undefined) return capRunningLine(thread.capped);
  if (kind.id === "working" || kind.id === "resuming" || kind.id === "limited") return undefined;
  return facts.lastLine;
}

/** A status as its icon alone, its word on the hover (where the surface has no card of its own) and to a screen
 * reader: the transcript's row and the tile's first row. Working is the crab; a thread at rest with nothing to say
 * keeps its age, the one figure that tells it apart. */
export function StatusIcon({ thread, kind, tip = true, crab = true }: { thread: Thread; kind: StatusKind; tip?: boolean; crab?: boolean }) {
  const word = statusWord(thread, kind);
  const working = kind.id === "working" || kind.id === "starting";
  if (working && !crab) return null;
  if (!working && kind.glyph === undefined) return <span data-thread-status={kind.id} className="tabular-nums">{restingAge(thread)}</span>;
  const Glyph = kind.glyph;
  const mark = (
    <span data-thread-status={kind.id} role="img" aria-label={word} className={cn("inline-flex shrink-0 items-center", working ? "text-status-working" : (kind.ink ?? "text-muted-foreground"))}>
      {working || Glyph === undefined ? <Crab /> : <Glyph aria-hidden className="size-3" />}
    </span>
  );
  if (!tip) return mark;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{mark}</TooltipTrigger>
      <TooltipPopup side="top">
        <span className="inline-flex items-center gap-1.5">
          {word}
          {working ? <WorkingSince since={thread.startedAt} /> : kind.glyph !== undefined && thread.status !== "running" ? <span className="text-muted-foreground">{restingAge(thread)}</span> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The status row a tile's card leads with: the icon, the word in its tone, the reason cut to one line, and the
 * time, ticking while it works. */
export function StatusLine({ thread, kind }: { thread: Thread; kind: StatusKind }) {
  const working = kind.id === "working";
  const reason = statusReason(thread, kind);
  const Glyph = kind.glyph;
  const ink = working ? "text-status-working" : kind.ink;
  return (
    <li data-tile-card-line="status" className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("flex w-3 shrink-0 justify-center", ink ?? "text-muted-foreground")}>{working ? <Crab /> : Glyph === undefined ? <CircleCheckIcon aria-hidden className="size-3" /> : <Glyph aria-hidden className="size-3" />}</span>
        <span className={cn("shrink-0", ink !== undefined && "font-medium", ink ?? "text-foreground")}>{statusWord(thread, kind)}</span>
        <span className="ms-auto shrink-0 tabular-nums">{working ? <WorkingSince since={thread.startedAt} /> : thread.status === "running" ? null : restingAge(thread)}</span>
      </span>
      {reason === undefined ? null : <span data-status-reason className="line-clamp-3 min-w-0 ps-5 break-words">{reason}</span>}
    </li>
  );
}

/** What a folded tile says of everything under it, at any depth: the glyph of the most pressing thing under it that
 * needs the person and that the tile's own status does not already show, asking before failed, in its own ink, with no
 * number. It stands in row one's leading slot, over the fold's chevron, in the project glyph's place: the fold's column,
 * which never holds a tile's own state, so it cannot be read as the tile's. Every kind and its count is on the card,
 * and the glyph's name for a screen reader says them all. Undefined when nothing under it needs the person. */
export function rollupMark(counts: TreeCounts, own: string): ReactNode | undefined {
  const mark = [
    { id: "needs-you", n: counts.needsYou, ink: "text-status-input", glyph: <MessageCircleQuestionIcon aria-hidden className="size-3" /> },
    { id: "failed", n: counts.failed, ink: "text-status-failed", glyph: <CircleAlertIcon aria-hidden className="size-3" /> },
  ].find(kind => kind.n > 0 && kind.id !== own);
  if (mark === undefined) return undefined;
  return (
    <span data-rollup={mark.id} role="img" aria-label={LEAD_WORDS.under(rollupWords(counts))} className={cn("inline-flex size-3 shrink-0", mark.ink)}>
      {mark.glyph}
    </span>
  );
}

/** The whole count of a folded tile's tree, for its card: every live status in words. */
export function rollupWords(counts: TreeCounts): string {
  return [
    counts.needsYou > 0 ? LEAD_WORDS.needsYou(counts.needsYou) : null,
    counts.failed > 0 ? LEAD_WORDS.failed(counts.failed) : null,
    counts.working > 0 ? LEAD_WORDS.working(counts.working, counts.working - counts.workingSubagents, counts.workingSubagents) : null,
    counts.waiting > 0 ? LEAD_WORDS.waiting(counts.waiting) : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** A thread as the sidebar's fleet holds it, with every thread and subagent under it. */
export interface FleetNode {
  readonly thread: Thread;
  readonly kids: ReadonlyArray<FleetNode>;
}

/** Everything under one thread off the fleet the sidebar reads, its counts, and what a settle of it takes. */
export function useSubtree(key: string): { nodes: FleetNode[]; tree: Tree<FleetNode>; counts: TreeCounts; drawn: boolean } {
  const fleet = useSidebarProjects();
  const settleMs = useSettleMs();
  const all = fleet.flatMap(project => project.threads);
  const byKey = new Map(all.map(thread => [keyOf(thread), thread] as const));
  const build = (at: string, seen: ReadonlySet<string>): FleetNode[] =>
    all.filter(thread => thread.parentThreadId === at && !seen.has(keyOf(thread))).map(thread => ({ thread, kids: build(keyOf(thread), new Set([...seen, keyOf(thread)])) }));
  const nodes = build(key, new Set([key]));
  const tree: Tree<FleetNode> = { threadOf: node => node.thread, kidsOf: node => node.kids, byKey, nowMs: Date.now(), settleMs };
  return { nodes, tree, counts: countTree(nodes, tree), drawn: nodes.some(node => partOf(node, tree) !== "settled") };
}

/** Whether a tile's tree under it stands folded in the sidebar, and the toggle; each tile folds on its own. */
export const foldedKey = (thread: string): string => `fold:${thread}`;
export const toggleFolded = (thread: string): void => toggleFold(foldedKey(thread));

/** How many tiles a root draws, itself and every live child down the tree it shows, none under a folded tile: what
 * a sidebar section's head counts. */
export function drawnCount(node: TileNode): number {
  if (node.thread.groupTitle !== undefined) return node.children.reduce((sum, child) => sum + drawnCount(child), 0);
  const thread = node.thread.thread;
  if (thread === null) return 1;
  if (useLeadUi.getState().open[foldedKey(thread.id)] === true) return 1;
  const all = useStore.getState();
  const byKey = new Map(Object.values(all.sessions).flat().map(row => [row.threadId ?? row.id, row as unknown as Thread] as const));
  const tree: Tree<TileNode> = { threadOf: n => n.thread.thread, kidsOf: n => n.children, byKey, nowMs: Date.now(), settleMs: SETTLE_MS[all.preferences.settleAfter] };
  return 1 + node.children.filter(child => partOf(child, tree) === "live").reduce((sum, child) => sum + drawnCount(child), 0);
}

/** Whether the page open is a subagent's: it has no folder, terminal or changes of its own, so the lead's panels and
 * the header's buttons that open them stand hidden while it is open, mounted as they were. */
export const useSubagentPage = (): boolean => useStore(s => s.selectedThreadId !== null && CHILD_FACTS[s.selectedThreadId]?.subagentOf !== undefined);
setSubagentPageCheck(() => {
  const open = useStore.getState().selectedThreadId;
  return open !== null && CHILD_FACTS[open]?.subagentOf !== undefined;
});

/** A child where its lead started it, in the lead's transcript: its own row from the Threads block, live, its status
 * moving in place, at the point of the call that started it (a wsp run or fork, or the Agent call of a subagent). */
export function SpawnTiles({ childKeys }: { childKeys: ReadonlyArray<string> }) {
  return (
    <div data-spawn-tiles className="flex min-w-0 flex-col">
      {childKeys.map(key => (
        <SpawnTile key={key} childKey={key} />
      ))}
    </div>
  );
}

export function SpawnTile({ childKey }: { childKey: string }) {
  const fleet = useSidebarProjects();
  const places = usePlaces();
  const settleMs = useSettleMs();
  const all = fleet.flatMap(runs => runs.threads.map(thread => ({ thread, runs })));
  const found = all.find(({ thread }) => keyOf(thread) === childKey);
  if (found === undefined) return null;
  const byKey = new Map(all.map(({ thread }) => [keyOf(thread), thread] as const));
  const lead = found.thread.parentThreadId === null ? undefined : all.find(({ thread }) => keyOf(thread) === found.thread.parentThreadId);
  const part = ownPart(found.thread, { byKey, nowMs: Date.now(), settleMs });
  const place = computerName(places, found.runs);
  const leadPlace = lead === undefined ? place : computerName(places, lead.runs);
  return (
    <div data-spawn-tile={childKey} className="min-w-0">
      <ChildRow thread={found.thread} part={part === "settled" ? "finished" : part} place={place === leadPlace ? "" : place} at={computerOf(places, found.runs)} note={noteOf(found.thread, part === "settled" ? "finished" : part, byKey)} byKey={byKey} subtree={() => [found.thread.id]} />
    </div>
  );
}

/** A child in the transcript: the thread, where it runs, and its children. */
interface TranscriptNode {
  readonly thread: Thread;
  readonly place: string;
  readonly at: PlaceView | undefined;
  readonly children: ReadonlyArray<TranscriptNode>;
}

type TranscriptProps = { readonly in: "transcript"; readonly lead: Thread; readonly leadPlace: string; readonly nodes: ReadonlyArray<TranscriptNode>; readonly byKey: ReadonlyMap<string, Thread>; readonly className?: string };
type SidebarProps = { readonly in: "sidebar"; readonly lead: string; readonly depth: number; readonly nodes: ReadonlyArray<TileNode>; readonly tile: (node: TileNode, slim: boolean) => ReactNode };

/** A lead's tree, in its transcript or under its tile. */
export function LeadThreads(props: TranscriptProps | SidebarProps) {
  return props.in === "transcript" ? <TranscriptThreads {...props} /> : <SidebarThreads {...props} />;
}

export function useSettleMs(): number | null {
  return SETTLE_MS[useStore(s => s.preferences.settleAfter)];
}

/** One level of the transcript's tree: live children, each with its own level under it, then the level's Finished
 * fold; the top level adds Settled. */
function TranscriptLevel({ parent, nodes, depth, tree, leadPlace, top }: { parent: string; nodes: ReadonlyArray<TranscriptNode>; depth: number; tree: Tree<TranscriptNode>; leadPlace: string; top: boolean }) {
  const parts = childParts(nodes, tree);
  const finishedOpen = useLeadUi(s => s.open[foldKey("transcript", parent, "finished")] ?? false);
  const settledOpen = useLeadUi(s => s.open[foldKey("transcript", parent, "settled")] ?? false);
  const railed = depth > 1;
  const item = (node: TranscriptNode, part: ChildPart) => <TranscriptItem key={node.thread.id} node={node} part={part} depth={depth} tree={tree} leadPlace={leadPlace} railed={railed} />;
  const wrap = (child: ReactNode, key: string) => (railed ? <li key={key} className={TRANSCRIPT_ITEM}>{child}</li> : <div key={key}>{child}</div>);
  const moreRow = (rest: number, show: () => void) => wrap(<FoldRow part="more" label={LEAD_WORDS.more(rest)} onToggle={show} />, "more");
  return (
    <>
      {parts.live.map(node => item(node, "live"))}
      {parts.finished.length > 0
        ? wrap(<FoldRow part="finished" label={LEAD_WORDS.finished} count={parts.finished.length} open={finishedOpen} onToggle={() => toggleFold(foldKey("transcript", parent, "finished"))} />, "fold-finished")
        : null}
      {finishedOpen ? <Paged items={parts.finished} render={node => item(node, "finished")} more={moreRow} /> : null}
      {top && parts.settled.length > 0
        ? wrap(<FoldRow part="settled" label={LEAD_WORDS.settled} count={parts.settled.length} open={settledOpen} onToggle={() => toggleFold(foldKey("transcript", parent, "settled"))} />, "fold-settled")
        : null}
      {top && settledOpen ? <Paged items={parts.settled} render={node => item(node, "settled")} more={moreRow} /> : null}
    </>
  );
}

function TranscriptItem({ node, part, depth, tree, leadPlace, railed }: { node: TranscriptNode; part: ChildPart; depth: number; tree: Tree<TranscriptNode>; leadPlace: string; railed: boolean }) {
  const { thread } = node;
  const place = node.place === leadPlace ? "" : node.place;
  const note = noteOf(thread, part, tree.byKey);
  const sending = useLeadUi(s => s.sending === keyOf(thread));
  const row = <ChildRow thread={thread} part={part} place={place} at={node.at} note={note} byKey={tree.byKey} subtree={() => subtreeKeys(node, tree)} />;
  const kids = node.children.length === 0 || part === "settled" ? null : <TranscriptLevel parent={keyOf(thread)} nodes={node.children} depth={depth + 1} tree={tree} leadPlace={leadPlace} top={false} />;
  const two = twoLinesOf(note, place, sending);
  if (!railed)
    return (
      <div data-child-item>
        {row}
        {kids === null ? null : <ul className={TRANSCRIPT_LIST}>{kids}</ul>}
      </div>
    );
  return (
    <>
      <li data-child-item className={TRANSCRIPT_ITEM} {...(two ? { "data-two": "" } : {})}>
        {row}
        {kids === null ? null : <ul className={TRANSCRIPT_LIST}>{kids}</ul>}
      </li>
    </>
  );
}

/** The lead's tree without the block's head, for the Threads bar: the bar's own head names it and its foot holds
 * Settle. */
export function ThreadsTree({ lead, leadPlace, nodes, byKey }: Omit<TranscriptProps, "in" | "className">) {
  const settleMs = useSettleMs();
  const tree: Tree<TranscriptNode> = { threadOf: n => n.thread, kidsOf: n => n.children, byKey, nowMs: Date.now(), settleMs };
  return <TranscriptLevel parent={keyOf(lead)} nodes={nodes} depth={1} tree={tree} leadPlace={leadPlace} top />;
}

/** What Settle finished takes under a lead, for the Threads bar's foot. */
export function useSettleFinished(leadKey: string): ResolvedAction {
  const under = useSubtree(leadKey);
  const title = useSidebarProjects().flatMap(p => p.threads).find(t => keyOf(t) === leadKey)?.title ?? "";
  return settleFinished(title, finishedKeys(under.nodes, under.tree));
}

function TranscriptThreads({ lead, leadPlace, nodes, byKey, className }: TranscriptProps) {
  const settleMs = useSettleMs();
  const leadKey = keyOf(lead);
  const tree: Tree<TranscriptNode> = { threadOf: n => n.thread, kidsOf: n => n.children, byKey, nowMs: Date.now(), settleMs };
  const shut = useLeadShut(s => s.shut[leadKey] ?? false);
  const settleAll = settleFinished(lead.title, finishedKeys(nodes, tree));
  // The head takes the fold rows' shape: its icon in the mark column, its word, what it says at the right, and the
  // chevron last, turning as theirs does; the word and the chevron both shut and open the block.
  const chevron = (
    <button type="button" data-threads-chevron aria-hidden tabIndex={-1} onClick={() => toggleShut(leadKey)} className="inline-flex shrink-0 items-center outline-none transition-colors duration-150 hover:text-foreground">
      <ChevronDownIcon className={cn("size-3.5 transition-transform duration-150", shut && "-rotate-90")} />
    </button>
  );
  const head = (
    <div data-thread-rows-head className={cn(GROUP_LABEL, "flex h-8 items-center gap-2 px-2 text-muted-foreground")}>
      <button type="button" data-threads-toggle aria-expanded={!shut} aria-label={shut ? LEAD_WORDS.shut : LEAD_WORDS.open} onClick={() => toggleShut(leadKey)} className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span className="inline-flex size-[13px] shrink-0 items-center justify-center">
          <ListTreeIcon aria-hidden className="size-3" />
        </span>
        <span className="min-w-0 flex-1">{LEAD_WORDS.threads}</span>
        {shut ? <TreeSummary counts={countTree(nodes, tree)} /> : null}
      </button>
      {!shut && settleAll.title !== LEAD_WORDS.settleFinished(0) ? (
        <Button type="button" size="xs" variant="outline" data-settle-finished onClick={() => void settleAll.run()}>
          <ArchiveIcon aria-hidden />
          {settleAll.title}
        </Button>
      ) : null}
      {chevron}
    </div>
  );
  if (shut) {
    const peek = SHUT_SHAPE === "line" ? [] : childParts(nodes, tree).live.slice(0, SHUT_SHAPE === "peek2" ? 2 : 1);
    return (
      <div data-lead-threads="transcript" data-shut className={cn("flex flex-col", className)}>
        {head}
        {peek.length === 0 ? null : (
          // The live rows fade into the page under one mask on one element: a cue that more is here, which mounts
          // only the rows it shows and opens the block on a press.
          <div data-threads-peek aria-hidden className="cursor-pointer [mask-image:linear-gradient(to_bottom,black,transparent)]" onClick={() => toggleShut(leadKey)}>
            <div inert className="pointer-events-none">
              {peek.map(node => (
                <ChildRow key={node.thread.id} thread={node.thread} part="live" place={node.place === leadPlace ? "" : node.place} at={node.at} note={noteOf(node.thread, "live", byKey)} byKey={byKey} subtree={() => []} peek />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div data-lead-threads="transcript" className={cn("flex flex-col", className)}>
      {head}
      <TranscriptLevel parent={leadKey} nodes={nodes} depth={1} tree={tree} leadPlace={leadPlace} top />
    </div>
  );
}

/** A child's item as the sidebar draws it, with the child's own menu over the tile's: the menu a child takes is the
 * transcript row's, and a press inside the child's own children is theirs. */
function withMenu(item: ReactNode, node: TileNode, part: ChildPart, tree: Tree<TileNode>): ReactNode {
  const thread = node.thread.thread;
  if (thread === null || item === null || typeof item !== "object" || !("props" in item)) return item;
  return cloneElement(item as ReactElement<{ onContextMenuCapture?: (event: MouseEvent<HTMLElement>) => void }>, {
    onContextMenuCapture: (event: MouseEvent<HTMLElement>) => {
      const row = event.target instanceof Element ? event.target.closest("[data-row-id]") : null;
      if (row?.getAttribute("data-row-id") !== threadRowId(thread.id)) return;
      void openContextMenu(event, childActs(thread, part, "sidebar", tree.byKey, () => subtreeKeys(node, tree)));
    },
  });
}

/** A subagent in the sidebar: the slim row a tile becomes in the Settled fold, since a subagent has no project or
 * computer of its own for a tile's first row to name, led by the launching call's glyph, its card on rest, and Stop
 * alone in its menu while it runs. */
function SubagentSidebarRow({ thread, part, depth, tree }: { thread: Thread; part: ChildPart; depth: number; tree: Tree<TileNode> }) {
  const key = keyOf(thread);
  const active = useStore(s => s.selectedThreadId === key);
  const acts = childActs(thread, part, "sidebar", tree.byKey, () => []);
  const working = thread.status === "running";
  return (
    <li data-thread-item data-slim className={RAIL_ITEM_CLASS}>
      <Tooltip>
        <TooltipTrigger
          delay={CARD_DELAY_MS}
          render={
            <SidebarMenuButton
              size="sm"
              isActive={active}
              data-sidebar-row
              data-row-id={threadRowId(thread.id)}
              data-depth={depth}
              data-subagent
              className={cn(ONE_LINE_ROW_CLASS, "group/tile gap-1.5")}
              onClick={() => open(thread)}
              {...(acts.length > 0 ? { onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, acts) } : {})}
            />
          }
        >
          <BotIcon aria-hidden data-subagent-mark className="size-3 shrink-0 text-sidebar-muted-foreground" />
          <span className={cn("min-w-0 flex-1 truncate", active ? "font-medium text-sidebar-foreground" : "text-sidebar-muted-foreground")}>{thread.title}</span>
          <span className={cn("relative flex shrink-0 items-center text-xs", !working && "text-sidebar-muted-foreground")}>
            <span className={cn("flex", working && "group-hover/tile:invisible")}>
              <StatusIcon thread={thread} kind={kindOf(thread, part === "settled", part === "finished")} tip={false} />
            </span>
            {working ? (
              // A subagent's one act, on hover where its status stood, as T3 Code puts Stop on a subagent's row: it
              // takes no message, and its page holds no Stop of its own.
              <span
                role="button"
                tabIndex={-1}
                data-subagent-stop
                aria-label={LEAD_WORDS.stopSubagent}
                title={LEAD_WORDS.stopSubagent}
                className="invisible absolute top-1/2 right-[-4px] flex size-5 -translate-y-1/2 items-center justify-center rounded-[6px] text-sidebar-muted-foreground transition-colors duration-150 hover:bg-sidebar-row-hover hover:text-sidebar-foreground group-hover/tile:visible"
                onClick={event => {
                  event.stopPropagation();
                  stop(thread);
                }}
              >
                <SquareIcon aria-hidden className="size-3" />
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <SubagentCard thread={thread} kind={kindOf(thread, part === "settled", part === "finished")} />
      </Tooltip>
    </li>
  );
}

function SidebarThreads({ lead, depth, nodes, tile }: SidebarProps) {
  const folded = useLeadUi(s => s.open[foldedKey(lead)] ?? false);
  return folded ? null : <SidebarTree lead={lead} depth={depth} nodes={nodes} tile={tile} />;
}

function SidebarTree({ lead, depth, nodes, tile }: Omit<SidebarProps, "in">) {
  const settleMs = useSettleMs();
  const fleet = useSidebarProjects();
  const byKey = new Map(fleet.flatMap(p => p.threads.map(t => [keyOf(t), t] as const)));
  const tree: Tree<TileNode> = { threadOf: n => n.thread.thread, kidsOf: n => n.children, byKey, nowMs: Date.now(), settleMs };
  const parts = childParts(nodes, tree);
  const key = foldKey("sidebar", lead, "finished");
  const finishedOpen = useLeadUi(s => s.open[key] ?? false);
  // The page open is a finished child of this tile's: while it is open its one row stands under the shut fold's head,
  // so the person sees where they are without the fold opening on its own or staying open after they leave.
  const opened = useStore(s => (s.selectedThreadId !== null && parts.finished.some(node => node.thread.thread !== null && keyOf(node.thread.thread) === s.selectedThreadId) ? s.selectedThreadId : null));
  const openedNode = finishedOpen || opened === null ? undefined : parts.finished.find(node => node.thread.thread !== null && keyOf(node.thread.thread) === opened);
  const leadName = byKey.get(lead)?.title ?? fleet.flatMap(p => p.threads).find(t => t.id === lead)?.title ?? "";
  const settleAll = settleFinished(leadName, finishedKeys(nodes, tree));
  const row = (node: TileNode, part: ChildPart, slim: boolean, at: number) => {
    const thread = node.thread.thread;
    if (thread !== null && isSubagent(thread)) return <SubagentSidebarRow key={node.thread.id} thread={thread} part={part} depth={at} tree={tree} />;
    return withMenu(tile(node, slim), node, part, tree);
  };
  return (
    <ul data-lead-threads="sidebar" className={CHILD_LIST_CLASS}>
      {parts.live.map(node => row(node, "live", false, depth))}
      {parts.finished.length > 0 ? (
        <li data-child-fold="finished" data-slim className={RAIL_ITEM_CLASS}>
          <SidebarMenuButton size="sm" aria-expanded={finishedOpen} data-sidebar-row data-row-id={`fold:${lead}`} data-depth={depth} className={cn(ONE_LINE_ROW_CLASS, "gap-1.5")} onClick={() => toggleFold(key)} onContextMenu={event => void openContextMenu(event, [settleAll])}>
            <CircleCheckIcon aria-hidden className="size-3 shrink-0 text-sidebar-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{LEAD_WORDS.finished}</span>
            <span className={cn(ROW_META_CLASS, "shrink-0")}>{parts.finished.length}</span>
            <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform duration-150", !finishedOpen && "-rotate-90")} />
          </SidebarMenuButton>
          {finishedOpen ? (
            <ul className={CHILD_LIST_CLASS}>
              <Paged
                items={parts.finished}
                render={node => row(node, "finished", true, depth + 1)}
                more={(rest, show) => (
                  <li key="more" data-child-fold="more" data-slim className={RAIL_ITEM_CLASS}>
                    <SidebarMenuButton size="sm" className={cn(ONE_LINE_ROW_CLASS, "gap-1.5")} onClick={show}>
                      <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{LEAD_WORDS.more(rest)}</span>
                    </SidebarMenuButton>
                  </li>
                )}
              />
            </ul>
          ) : openedNode !== undefined ? (
            <ul className={CHILD_LIST_CLASS}>{row(openedNode, "finished", true, depth + 1)}</ul>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}

/** The tree under a lead as the transcript draws it, off the fleet the sidebar reads. */
export function useTranscriptTree(leadKey: string): { lead: Thread | undefined; leadPlace: string; nodes: TranscriptNode[]; byKey: ReadonlyMap<string, Thread> } {
  const places = usePlaces();
  const fleet = useSidebarProjects();
  const all = fleet.flatMap(runs => runs.threads.map(thread => ({ thread, runs })));
  const byKey = new Map(all.map(({ thread }) => [keyOf(thread), thread] as const));
  const found = all.find(({ thread }) => keyOf(thread) === leadKey);
  const build = (key: string, seen: ReadonlySet<string>): TranscriptNode[] =>
    all
      .filter(({ thread }) => thread.parentThreadId === key && !seen.has(keyOf(thread)))
      .map(({ thread, runs }) => ({ thread, place: computerName(places, runs), at: computerOf(places, runs), children: build(keyOf(thread), new Set([...seen, keyOf(thread)])) }));
  return { lead: found?.thread, leadPlace: found === undefined ? "" : computerName(places, found.runs), nodes: build(leadKey, new Set([leadKey])), byKey };
}

/** The transcript's Threads block, put in place of src/tree/TreeRows.tsx by this page's vite config: the same props
 * ChatView hands the shipped one. It reads the whole tree under the lead, not the lead's own children alone. */
export function TreeRows({ lead, rows, className }: { lead: { id: string; name: string }; tree: TreeFact | undefined; rows: ReadonlyArray<{ thread: Thread; place: string }>; className?: string }) {
  const places = usePlaces();
  const fleet = useSidebarProjects();
  const leadKey = rows[0]?.thread.parentThreadId ?? null;
  const all = fleet.flatMap(runs => runs.threads.map(thread => ({ thread, runs })));
  const byKey = new Map(all.map(({ thread }) => [keyOf(thread), thread] as const));
  const leadThread = leadKey === null ? undefined : byKey.get(leadKey);
  const leadRuns = fleet.find(project => project.id === lead.id);
  if (leadKey === null || leadThread === undefined) return null;
  const build = (key: string, seen: ReadonlySet<string>): TranscriptNode[] =>
    all
      .filter(({ thread }) => thread.parentThreadId === key && !seen.has(keyOf(thread)))
      .map(({ thread, runs }) => ({ thread, place: computerName(places, runs), at: computerOf(places, runs), children: build(keyOf(thread), new Set([...seen, keyOf(thread)])) }));
  return (
    <LeadThreads
      in="transcript"
      lead={leadThread}
      leadPlace={leadRuns === undefined ? "" : computerName(places, leadRuns)}
      nodes={build(leadKey, new Set([leadKey]))}
      byKey={byKey}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
