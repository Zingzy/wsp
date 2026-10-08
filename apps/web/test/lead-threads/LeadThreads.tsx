// SPDX-License-Identifier: AGPL-3.0-only
// A lead's children, one component for its transcript's Threads block and its tree in the sidebar. One reading of
// each child decides everything both places draw: which part it stands in (live, finished, settled), its order
// there, the line under its title, and the acts it takes. The row is the place's own: ThreadRow's one-line row in
// the transcript, ThreadTile in the sidebar. Live children always draw, first. Finished ones sit behind a fold
// that starts shut, and settled ones behind a second fold in the transcript and nowhere in the sidebar; a shut fold
// mounts nothing, and an open one mounts twenty rows and a row that mounts twenty more. A fold opens downward, so
// the live rows above it never move; the transcript's folds shut again when the person opens another thread, so a
// lead is always opened on its live rows.
//
// Prototype only. ChildRow is ThreadRow with the two things the build adds to ThreadRow itself: the acts the status
// slot yields to on hover, and the message field that takes the note's place. The page's vite config puts
// TreeRows below in place of src/tree/TreeRows.tsx and LeadThreads in place of the sidebar's child list.
import { agentName } from "@wsp/catalog";
import { capRunningLine, SETTLE_MS, type TreeFact } from "@wsp/protocol";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, CircleStopIcon, EllipsisIcon, MessageSquareIcon, SquareIcon, type LucideIcon } from "lucide-react";
import { cloneElement, memo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { create } from "zustand";
import { openContextMenu } from "../../src/actions/contextMenu";
import { THREAD_WORDS } from "../../src/actions/format";
import type { ResolvedAction } from "../../src/actions/registry";
import type { SidebarThreadSnapshot } from "../../src/adapt/index";
import { HarnessMark } from "../../src/components/chat/HarnessMark";
import type { StatusKind } from "../../src/components/status/kinds/index";
import { restingAge } from "../../src/components/status/restingAge";
import { LINE_SLOT_CLASS, ThreadStatus } from "../../src/components/status/ThreadStatus";
import { ThreadLink } from "../../src/components/ThreadLink";
import { Button } from "../../src/components/ui/button";
import { SidebarMenuButton } from "../../src/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/components/ui/tooltip";
import { GROUP_LABEL } from "../../src/lib/microLabel";
import { cn } from "../../src/lib/utils";
import { addNotice } from "../../src/notices/store";
import { usePlaces, useSidebarProjects, useStore } from "../../src/protocol/store";
import { requestComposerFocus } from "../../src/shell/shellRequests";
import { isThreadSettled, isThreadWorking } from "../../src/sidebar/Sidebar.logic";
import { CHILD_LIST_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_META_CLASS, threadRowId } from "../../src/sidebar/rowGrammar";
import { RowNameInput } from "../../src/sidebar/RowNameInput";
import type { TileNode } from "../../src/sidebar/threadTree";
import { computerName } from "../../src/sidebar/workspaceRows";
import { CHILD_FACTS } from "./fixtures";

type Thread = SidebarThreadSnapshot;
export type ChildPart = "live" | "finished" | "settled";

/** Ended by a stop: the glyph, its word on the hover, and the age beside it, in the row's own ink. */
const STOPPED: StatusKind = { id: "stopped", is: () => false, glyph: CircleStopIcon, word: "Stopped", glyphOnly: true, aged: true };

/** How many rows an open fold mounts at a time. */
const PAGE = 20;

const keyOf = (thread: Pick<Thread, "id" | "threadId">): string => thread.threadId ?? thread.id;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
export const LEAD_WORDS = {
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
} as const;

/** Which part a child stands in: settled by hand or by the quiet rule the sidebar folds by, live while it asks,
 * works, waits or failed, and finished once it ended any other way. */
export function partOf(thread: Thread, nowMs: number, settleMs: number | null): ChildPart {
  if (isThreadSettled(thread, nowMs, false, settleMs)) return "settled";
  if (thread.asking !== null || isThreadWorking(thread) || thread.status === "failed") return "live";
  return "finished";
}

/** A live child's place in its part: what asks for the person, then what failed, then what works, then what waits. */
const liveRank = (t: Thread): number => (t.asking !== null || (t.status === "failed" && (t.limit ?? null) !== null) ? 0 : t.status === "failed" ? 1 : t.capped !== undefined ? 3 : 2);
const at = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso));

/** Every child in its part and in the part's order: live by rank then newest, finished by newest end, settled by
 * newest settle. */
export function childParts<T>(items: ReadonlyArray<T>, threadOf: (item: T) => Thread | null, nowMs: number, settleMs: number | null): Record<ChildPart, T[]> {
  const parts: Record<ChildPart, T[]> = { live: [], finished: [], settled: [] };
  for (const item of items) {
    const thread = threadOf(item);
    parts[thread === null ? "live" : partOf(thread, nowMs, settleMs)].push(item);
  }
  const by = (score: (t: Thread) => number) => (a: T, b: T) => score(threadOf(b)!) - score(threadOf(a)!);
  parts.live.sort((a, b) => {
    const ta = threadOf(a);
    const tb = threadOf(b);
    if (ta === null || tb === null) return ta === null ? 1 : -1;
    return liveRank(ta) - liveRank(tb) || at(tb.startedAt) - at(ta.startedAt);
  });
  parts.finished.sort(by(t => at(t.endedAt)));
  parts.settled.sort(by(t => at(t.settledAt ?? t.endedAt)));
  return parts;
}

/** The line under a child's title: what it asks, why it failed, what holds it, the thread it restarts, or the last
 * line of its reply. A settled child keeps one line. */
export function noteOf(thread: Thread, part: ChildPart, byKey: ReadonlyMap<string, Thread>): string | undefined {
  if (part === "settled") return undefined;
  const facts = CHILD_FACTS[keyOf(thread)] ?? {};
  if (thread.asking !== null) return thread.asking;
  if (thread.status === "failed") return facts.why;
  if (thread.capped !== undefined) return capRunningLine(thread.capped);
  if (part === "finished") return facts.lastLine;
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
const foldKey = (place: "transcript" | "sidebar", lead: string, part: ChildPart): string => `${place}:${lead}:${part}`;
const toggleFold = (key: string): void => useLeadUi.setState(s => ({ open: { ...s.open, [key]: !(s.open[key] ?? false) } }));
// Leaving a thread shuts the transcript's folds and closes a message field; the sidebar's folds stay as they were.
useStore.subscribe((now, before) => {
  if (now.selectedThreadId === before.selectedThreadId) return;
  useLeadUi.setState(s => ({ open: Object.fromEntries(Object.entries(s.open).filter(([key]) => !key.startsWith("transcript:"))), sending: null, shown: null }));
});

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

/** Every act a child takes, in the order its menu lists them; the transcript's row puts the first two on its hover.
 * A message is typed in the transcript's row, and in the sidebar in the child's own composer. */
export function childActs(thread: Thread, part: ChildPart, place: "transcript" | "sidebar", byKey: ReadonlyMap<string, Thread>): ResolvedAction[] {
  const key = keyOf(thread);
  const facts = CHILD_FACTS[key] ?? {};
  const send = action("send", LEAD_WORDS.send, MessageSquareIcon, () => {
    if (place === "transcript") useLeadUi.setState({ sending: key });
    else {
      open(thread);
      requestComposerFocus(thread.workspaceId);
    }
  }, "talk");
  const state =
    part === "settled"
      ? action("restore", THREAD_WORDS.restore, ArchiveRestoreIcon, () => restore([thread.id]))
      : isThreadWorking(thread) || thread.asking !== null
        ? action("stop", THREAD_WORDS.stop, SquareIcon, () => stop(thread))
        : action("settle", THREAD_WORDS.settle, ArchiveIcon, () => settle([thread.id]));
  const replaced = facts.replaces === undefined ? undefined : byKey.get(facts.replaces);
  const restart = facts.replacedBy === undefined ? undefined : byKey.get(facts.replacedBy);
  return [
    send,
    state,
    ...(replaced !== undefined ? [action("open-replaced", LEAD_WORDS.openReplaced, undefined, () => open(replaced), "open")] : []),
    ...(restart !== undefined ? [action("open-restart", LEAD_WORDS.openRestart, undefined, () => open(restart), "open")] : []),
  ];
}

/** Settles every finished child at once, with the way back on the toast. */
function settleFinished(lead: string, finished: ReadonlyArray<Thread>): ResolvedAction {
  const keys = finished.map(thread => thread.id);
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

interface ChildRowProps {
  readonly thread: Thread;
  readonly part: ChildPart;
  /** The computer it runs on, empty where that is the lead's own. */
  readonly place: string;
  readonly note: string | undefined;
  readonly byKey: ReadonlyMap<string, Thread>;
}

const DRAWN = ["title", "status", "asking", "startedAt", "endedAt", "readAt", "settledAt", "unread", "harness", "threadId", "resumeAt"] as const;
/** A row draws again only when something it draws moved, so a status change elsewhere in the list leaves it alone. */
const sameRow = (a: ChildRowProps, b: ChildRowProps): boolean =>
  a.part === b.part && a.place === b.place && a.note === b.note && DRAWN.every(field => a.thread[field] === b.thread[field]) && a.thread.capped?.running === b.thread.capped?.running;

const COUNT_DRAWS = new URLSearchParams(window.location.search).has("renders");

/** ThreadRow, with the acts its status slot yields to on hover and the message field that takes its note's place. */
const ChildRow = memo(function ChildRow({ thread, part, place, note, byKey }: ChildRowProps) {
  const key = keyOf(thread);
  const sending = useLeadUi(s => s.sending === key);
  const shown = useLeadUi(s => s.shown === key);
  const draws = useRef(0);
  draws.current += 1;
  const acts = childActs(thread, part, "transcript", byKey);
  const menu = (event: MouseEvent<HTMLElement>): void => {
    useLeadUi.setState({ shown: key });
    void openContextMenu(event, acts).finally(() => useLeadUi.setState(s => (s.shown === key ? { shown: null } : s)));
  };
  const kind = part !== "settled" && thread.status === "interrupted" ? STOPPED : undefined;
  const twoLines = sending || note !== undefined;
  // The slot's status gives way to the acts while the pointer or the focus is on the row, or its menu is open.
  const yields = !sending;
  return (
    <div
      data-child-row={key}
      data-child-part={part}
      {...(shown ? { "data-acts": "shown" } : {})}
      {...(COUNT_DRAWS ? { "data-draws": draws.current } : {})}
      className={cn(
        "group/child flex min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-sm transition-colors duration-150 hover:bg-accent data-[acts=shown]:bg-accent",
        twoLines ? "min-h-12 py-1.5" : "h-9",
        thread.threadId !== null && "cursor-pointer",
      )}
      onClick={event => {
        if (!(event.target instanceof Element) || event.target.closest("a, button, input") === null) open(thread);
      }}
      onContextMenu={menu}
    >
      <span className="inline-flex shrink-0 text-muted-foreground">
        <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />
      </span>
      <span className="flex min-w-28 flex-1 flex-col">
        <ThreadLink thread={thread} className={cn("min-w-0 truncate", part === "settled" ? "text-muted-foreground" : "text-foreground")} />
        {sending ? (
          <span className="flex h-[18px] min-w-0 text-[13px]" ref={el => el?.querySelector("input")?.setAttribute("placeholder", LEAD_WORDS.send)}>
            <RowNameInput name="" label={LEAD_WORDS.messageTo(thread.title)} saving={false} onRename={text => sendTo(thread, text)} onCancel={() => useLeadUi.setState({ sending: null })} />
          </span>
        ) : note !== undefined ? (
          <span data-child-note className="truncate text-[11px] leading-[14px] text-muted-foreground" title={note}>
            {note}
          </span>
        ) : null}
      </span>
      {place === "" ? null : (
        <span data-thread-place className="max-w-[220px] shrink-0 truncate text-muted-foreground text-xs">
          {place}
        </span>
      )}
      <span className="relative flex shrink-0 items-center">
        <ThreadStatus
          thread={thread}
          age={restingAge(thread)}
          crab
          settled={part === "settled"}
          {...(kind !== undefined ? { kind } : {})}
          className={cn(LINE_SLOT_CLASS, yields && "group-hover/child:invisible group-focus-within/child:invisible group-data-[acts=shown]/child:invisible")}
        />
        {yields ? (
          <span data-child-acts className="invisible absolute inset-y-0 right-0 flex items-center gap-1 group-hover/child:visible group-focus-within/child:visible group-data-[acts=shown]/child:visible">
            {acts.slice(0, 2).map(act => (
              <Act key={act.id} icon={act.icon!} label={act.title} run={() => void act.run()} />
            ))}
            <Act icon={EllipsisIcon} label={LEAD_WORDS.menu} run={menu} />
          </span>
        ) : null}
      </span>
    </div>
  );
}, sameRow);

/** A fold in the transcript: ThreadRow's box, the transcript fold's chevron where the mark stands, the part's word,
 * and its count in the status slot. */
function FoldRow({ part, label, count, open: isOpen, onToggle, onContextMenu }: { part: ChildPart | "more"; label: string; count?: number; open?: boolean; onToggle: () => void; onContextMenu?: (event: MouseEvent<HTMLElement>) => void }) {
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
        {isOpen === undefined ? null : <ChevronRightIcon aria-hidden className={cn("size-3 transition-transform duration-150", isOpen && "rotate-90")} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : <span className={cn(LINE_SLOT_CLASS, "inline-flex")}>{count}</span>}
    </button>
  );
}

type TranscriptProps = { readonly in: "transcript"; readonly leadName: string; readonly leadPlace: string; readonly threads: ReadonlyArray<{ thread: Thread; place: string }>; readonly className?: string };
type SidebarProps = { readonly in: "sidebar"; readonly lead: string; readonly nodes: ReadonlyArray<TileNode>; readonly tile: (node: TileNode, slim: boolean) => ReactNode };

/** A lead's children, in its transcript or under its tile. */
export function LeadThreads(props: TranscriptProps | SidebarProps) {
  return props.in === "transcript" ? <TranscriptThreads {...props} /> : <SidebarThreads {...props} />;
}

function useSettleMs(): number | null {
  return SETTLE_MS[useStore(s => s.preferences.settleAfter)];
}

function TranscriptThreads({ leadName, leadPlace, threads, className }: TranscriptProps) {
  const settleMs = useSettleMs();
  const lead = threads[0]?.thread.parentThreadId ?? "";
  const byKey = new Map(threads.map(({ thread }) => [keyOf(thread), thread]));
  const parts = childParts(threads, row => row.thread, Date.now(), settleMs);
  const finishedOpen = useLeadUi(s => s.open[foldKey("transcript", lead, "finished")] ?? false);
  const settledOpen = useLeadUi(s => s.open[foldKey("transcript", lead, "settled")] ?? false);
  const settleAll = settleFinished(leadName, parts.finished.map(row => row.thread));
  const moreRow = (rest: number, show: () => void) => <FoldRow part="more" label={LEAD_WORDS.more(rest)} onToggle={show} />;
  const row = ({ thread, place }: { thread: Thread; place: string }, part: ChildPart) => (
    <ChildRow key={thread.id} thread={thread} part={part} place={place === leadPlace ? "" : place} note={noteOf(thread, part, byKey)} byKey={byKey} />
  );
  return (
    <div data-lead-threads="transcript" className={cn("flex flex-col", className)}>
      <div data-thread-rows-head className={cn(GROUP_LABEL, "flex h-8 items-center gap-2 px-2 text-muted-foreground")}>
        <span className="min-w-0 flex-1">Threads</span>
        {parts.finished.length > 0 ? (
          <Button type="button" size="xs" variant="outline" data-settle-finished onClick={() => void settleAll.run()}>
            <ArchiveIcon aria-hidden />
            {settleAll.title}
          </Button>
        ) : null}
      </div>
      {parts.live.map(item => row(item, "live"))}
      {parts.finished.length > 0 ? (
        <FoldRow
          part="finished"
          label={LEAD_WORDS.finished}
          count={parts.finished.length}
          open={finishedOpen}
          onToggle={() => toggleFold(foldKey("transcript", lead, "finished"))}
          onContextMenu={event => void openContextMenu(event, [settleAll])}
        />
      ) : null}
      {finishedOpen ? <Paged items={parts.finished} render={item => row(item, "finished")} more={moreRow} /> : null}
      {parts.settled.length > 0 ? <FoldRow part="settled" label={LEAD_WORDS.settled} count={parts.settled.length} open={settledOpen} onToggle={() => toggleFold(foldKey("transcript", lead, "settled"))} /> : null}
      {settledOpen ? <Paged items={parts.settled} render={item => row(item, "settled")} more={moreRow} /> : null}
    </div>
  );
}

/** A child's item as the sidebar draws it, with the child's own menu over the tile's: the menu a child takes is the
 * transcript row's, and a press inside the child's own children is theirs. */
function withMenu(item: ReactNode, node: TileNode, part: ChildPart, byKey: ReadonlyMap<string, Thread>): ReactNode {
  const thread = node.thread.thread;
  if (thread === null || item === null || typeof item !== "object" || !("props" in item)) return item;
  return cloneElement(item as ReactElement<{ onContextMenuCapture?: (event: MouseEvent<HTMLElement>) => void }>, {
    onContextMenuCapture: (event: MouseEvent<HTMLElement>) => {
      const row = event.target instanceof Element ? event.target.closest("[data-row-id]") : null;
      if (row?.getAttribute("data-row-id") !== threadRowId(thread.id)) return;
      void openContextMenu(event, childActs(thread, part, "sidebar", byKey));
    },
  });
}

function SidebarThreads({ lead, nodes, tile }: SidebarProps) {
  const settleMs = useSettleMs();
  const byKey = new Map(nodes.flatMap(node => (node.thread.thread === null ? [] : [[keyOf(node.thread.thread), node.thread.thread] as const])));
  const parts = childParts(nodes, node => node.thread.thread, Date.now(), settleMs);
  const key = foldKey("sidebar", lead, "finished");
  const finishedOpen = useLeadUi(s => s.open[key] ?? false);
  const leadName = useSidebarProjects().flatMap(p => p.threads).find(t => t.id === lead)?.title ?? "";
  const settleAll = settleFinished(leadName, parts.finished.map(node => node.thread.thread!));
  return (
    <ul data-lead-threads="sidebar" className={CHILD_LIST_CLASS}>
      {parts.live.map(node => withMenu(tile(node, false), node, "live", byKey))}
      {parts.finished.length > 0 ? (
        <li data-child-fold="finished" className={cn("min-w-0", RAIL_ITEM_CLASS, "after:top-[18px] last:before:h-[18px]")}>
          <SidebarMenuButton size="sm" aria-expanded={finishedOpen} className={ONE_LINE_ROW_CLASS} onClick={() => toggleFold(key)} onContextMenu={event => void openContextMenu(event, [settleAll])}>
            <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{LEAD_WORDS.finished}</span>
            <span className={cn(ROW_META_CLASS, "shrink-0")}>{parts.finished.length}</span>
            <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-sidebar-muted-foreground transition-transform duration-150", !finishedOpen && "-rotate-90")} />
          </SidebarMenuButton>
          {finishedOpen ? (
            <ul className={CHILD_LIST_CLASS}>
              <Paged
                items={parts.finished}
                render={node => withMenu(tile(node, true), node, "finished", byKey)}
                more={(rest, show) => (
                  <li data-child-fold="more" className={cn("min-w-0", RAIL_ITEM_CLASS, "after:top-[18px] last:before:h-[18px]")}>
                    <SidebarMenuButton size="sm" className={ONE_LINE_ROW_CLASS} onClick={show}>
                      <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{LEAD_WORDS.more(rest)}</span>
                    </SidebarMenuButton>
                  </li>
                )}
              />
            </ul>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}

/** The transcript's Threads block, put in place of src/tree/TreeRows.tsx by this page's vite config: the same props
 * ChatView hands the shipped one. */
export function TreeRows({ lead, rows, className }: { lead: { id: string; name: string }; tree: TreeFact | undefined; rows: ReadonlyArray<{ thread: Thread; place: string }>; className?: string }) {
  const places = usePlaces();
  const runs = useSidebarProjects().find(project => project.id === lead.id);
  const leadPlace = runs === undefined ? "" : computerName(places, runs);
  const leadName = rows[0] === undefined ? lead.name : (runs?.threads.find(t => keyOf(t) === rows[0]!.thread.parentThreadId)?.title ?? lead.name);
  return <LeadThreads in="transcript" leadName={leadName} leadPlace={leadPlace} threads={rows} {...(className !== undefined ? { className } : {})} />;
}
