// SPDX-License-Identifier: AGPL-3.0-only
// The proposed composer: one drawer on the composer's top edge, the shipped task drawer's own frame and own row,
// holding a row for every folded thing a busy lead has (the question it waits on, its threads, its task list, the
// messages waiting to be sent), most pressing first; a press on a row opens that thing's bar in the composer's place,
// and the bar's way back folds it again. Today these stand in four shapes in four places (a separate box for a folded
// question, cards over the box for the queue, the drawer for tasks, and the Threads block at the transcript's end);
// here they are one drawer and one bar. The Threads row is the Threads block moved to where the person types: the
// transcript keeps each child as a live tile where its lead started it. ?usage=1 adds a usage limit's row as a shape
// study: today a limit ends the turn, so it never stands beside running work.
import { LIMIT_WORDS } from "@wsp/protocol";
import { ChevronDownIcon, GaugeIcon, ListTodoIcon, ListTreeIcon, MessageCircleQuestionIcon, MessageSquareTextIcon, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { create } from "zustand";
import { isPromptOpen, type PermissionPrompt } from "../../src/adapt/index";
import { EMPTY_DRAFT, useComposerDraftStore, useComposerQueue } from "../../src/components/chat/composerDraftStore";
import { QUEUE_WORDS } from "../../src/components/chat/ComposerQueue";
import { composerTasks } from "../../src/components/chat/composerTasks.logic";
import type { ChatThreadHandle } from "../../src/components/chat/useChatThread";
import { Button } from "../../src/components/ui/button";
import { cn } from "../../src/lib/utils";
import { Grid } from "../../src/settings/grid";
import { GLYPH, NOTE } from "../../src/settings/layout";
import { Row } from "../../src/settings/rows";
import { Dock } from "./Dock";
import { ThreadsTree, TreeSummary, useSettleFinished, useSubtree, useTranscriptTree } from "./LeadThreads";

export type BarKind = "question" | "usage" | "threads" | "tasks" | "queue";
/** Which bar stands in the composer's place, none while the composer does. */
export const useBar = create<{ open: BarKind | null }>(() => ({ open: new URLSearchParams(window.location.search).get("open") as BarKind | null }));
const openBar = (kind: BarKind | null): void => useBar.setState({ open: kind });

const USAGE_STUDY = new URLSearchParams(window.location.search).get("usage") === "1";

export const DRAWER_WORDS = {
  waiting: "Waiting for you",
  threads: "Threads",
  tasks: "Tasks",
  usageLine: "Claude Code resumes at 21:00",
  write: "Write a message",
} as const;

/** The prompt the latest turn waits on, where this thread's own agent raised one and nobody has answered. */
export function openPrompt(thread: ChatThreadHandle): PermissionPrompt | null {
  const turnId = thread.view.latestTurn?.turnId ?? null;
  for (const entry of thread.view.entries) if (entry.kind === "permission" && entry.permission.turnId === turnId && isPromptOpen(entry.permission)) return entry.permission;
  return null;
}

/** One row of the drawer, the shipped task drawer's row as it is: the glyph at 14 px in the muted ink or the tone of
 * the thing it stands for (the one place a tone goes), the name muted, the line, the count in the mono, the chevron
 * pointing up into the bar. */
function DrawerRow({ kind, glyph, tone, name, line, fact }: { kind: BarKind; glyph: LucideIcon; tone?: string; name: string; line?: string; fact?: ReactNode }) {
  const Glyph = glyph;
  return (
    <button
      type="button"
      data-drawer-row={kind}
      onClick={() => openBar(kind)}
      onPointerDown={event => event.preventDefault()}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-start transition-colors duration-150 hover:bg-accent"
    >
      <Glyph aria-hidden className={cn("size-3.5 shrink-0", tone ?? "text-muted-foreground")} />
      <span className="shrink-0 text-muted-foreground">{name}</span>
      {line === undefined ? <span className="flex-1" /> : <span className="min-w-0 flex-1 truncate text-foreground/80">{line}</span>}
      {fact === undefined ? null : <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{fact}</span>}
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 rotate-180 text-muted-foreground" />
    </button>
  );
}

/** The drawer, in the composer's shell where today's task drawer stands, in the task drawer's own frame. */
export function ComposerDrawer({ thread, threadKey }: { thread: ChatThreadHandle; threadKey: string }) {
  const prompt = openPrompt(thread);
  const queue = useComposerQueue(threadKey);
  const tree = useSubtree(threadKey);
  const tasks = composerTasks({ latestTurn: thread.view.latestTurn, running: thread.view.latestTurn?.state === "running", plan: thread.view.plan, asking: false });
  const live = tree.counts.needsYou + tree.counts.failed + tree.counts.working + tree.counts.waiting;
  const question = prompt === null ? null : prompt.toolName === "AskUserQuestion" ? ((JSON.parse(prompt.input) as { questions?: Array<{ question: string }> }).questions?.[0]?.question ?? prompt.toolName) : prompt.toolName;
  const rows = [
    question === null ? null : <DrawerRow key="q" kind="question" glyph={MessageCircleQuestionIcon} tone="text-status-input" name={DRAWER_WORDS.waiting} line={question} />,
    USAGE_STUDY ? <DrawerRow key="u" kind="usage" glyph={GaugeIcon} tone="text-warning-foreground" name={LIMIT_WORDS.reached} line={DRAWER_WORDS.usageLine} /> : null,
    tree.nodes.length === 0 ? null : <DrawerRow key="t" kind="threads" glyph={ListTreeIcon} name={DRAWER_WORDS.threads} fact={live === 0 ? `${tree.counts.finished}` : <TreeSummary counts={tree.counts} quiet />} />,
    tasks === null ? null : <DrawerRow key="k" kind="tasks" glyph={ListTodoIcon} name={DRAWER_WORDS.tasks} line={tasks.step} fact={`${tasks.done}/${tasks.total}`} />,
    queue.length === 0 ? null : <DrawerRow key="m" kind="queue" glyph={MessageSquareTextIcon} name={QUEUE_WORDS.waiting(queue.length)} line={queue[0]!.prompt} />,
  ].filter(row => row !== null);
  if (rows.length === 0) return null;
  return (
    <div
      data-composer-drawer
      data-composer-banner-surface="attached"
      className="relative z-0 mx-auto -mb-px w-[calc(100%-2*var(--chat-composer-drawer-inset))] rounded-t-[14px] border border-b-0 border-(--chat-composer-outline) bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--chat-composer-glass-opacity),transparent)] px-1 pt-1 pb-1 text-xs leading-4 glass-backdrop"
    >
      {rows}
    </div>
  );
}

/** The share of the window the Threads bar's card may take before it scrolls. */
const THREADS_CARD_SHARE = 0.46;

/** Holds a scrolling card to the bottom of the last row that fits its share of the window, so its edge never slices a
 * row: the next row is either in or out. Read again when the window or the rows change size (a fold opening). */
function useWholeRows(card: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const el = card.current;
    if (el === null) return;
    const fit = (): void => {
      el.style.maxHeight = "";
      const budget = window.innerHeight * THREADS_CARD_SHARE;
      if (el.scrollHeight <= budget) return;
      const top = el.getBoundingClientRect().top - el.scrollTop;
      let cut = 0;
      for (const row of el.querySelectorAll("[data-child-row], button[data-child-fold]")) {
        const bottom = row.getBoundingClientRect().bottom - top;
        if (bottom <= budget && bottom > cut) cut = bottom;
      }
      el.style.maxHeight = `${Math.round(cut)}px`;
    };
    fit();
    const rows = new ResizeObserver(fit);
    if (el.firstElementChild !== null) rows.observe(el.firstElementChild);
    window.addEventListener("resize", fit);
    return () => {
      rows.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [card]);
}

/** The Threads bar: the lead's tree in the bar's card, its rows on the card's column, the counts at the head in the
 * drawer's quiet form, and Settle finished as the foot's act. */
export function ThreadsDock({ threadKey }: { threadKey: string }) {
  const under = useSubtree(threadKey);
  const tree = useTranscriptTree(threadKey);
  const settle = useSettleFinished(threadKey);
  const card = useRef<HTMLDivElement>(null);
  useWholeRows(card);
  const any = settle.title !== "Settle 0 finished";
  return (
    <Dock
      k="threads"
      mark={<ListTreeIcon aria-hidden className={cn(GLYPH, "shrink-0")} />}
      title={DRAWER_WORDS.threads}
      aside={<TreeSummary counts={under.counts} quiet />}
      foot={<WriteMessage />}
      acts={
        any ? (
          <Button variant="outline" data-settle-finished onClick={() => void settle.run()}>
            {settle.title}
          </Button>
        ) : null
      }
    >
      <Grid id="threads">
        <div ref={card} data-threads-card className="overflow-y-auto px-3 py-1">
          {tree.lead === undefined ? null : <ThreadsTree lead={tree.lead} leadPlace={tree.leadPlace} nodes={tree.nodes} byKey={tree.byKey} />}
        </div>
      </Grid>
    </Dock>
  );
}

/** The messages waiting to be sent, each a settings row named by its message, with today's queue's Edit and Cancel
 * at its right. Edit puts the message back in the composer. */
export function QueueDock({ workspaceId, threadKey }: { workspaceId: string; threadKey: string }) {
  const queue = useComposerQueue(threadKey);
  const cancel = (id: string): void => useComposerDraftStore.getState().removeQueued(threadKey, id);
  const edit = (id: string, prompt: string): void => {
    cancel(id);
    useComposerDraftStore.getState().setDraft(workspaceId, { ...EMPTY_DRAFT, prompt, cursor: prompt.length });
    openBar(null);
  };
  return (
    <Dock k="queue" mark={<MessageSquareTextIcon aria-hidden className={cn(GLYPH, "shrink-0")} />} title={QUEUE_WORDS.waiting(queue.length)} foot={<WriteMessage />}>
      <Grid id="queue">
        {queue.map(row => (
          <Row
            key={row.id}
            id={row.id}
            title={row.prompt}
            description=""
            control={
              <span className="flex items-center gap-2">
                <Button size="xs" variant="outline" aria-label={QUEUE_WORDS.editLabel} onClick={() => edit(row.id, row.prompt)}>
                  {QUEUE_WORDS.edit}
                </Button>
                <Button size="xs" variant="outline" aria-label={QUEUE_WORDS.cancelLabel} onClick={() => cancel(row.id)}>
                  {QUEUE_WORDS.cancel}
                </Button>
              </span>
            }
          />
        ))}
      </Grid>
    </Dock>
  );
}

/** The usage limit's bar, LimitStrip's own words and acts in the bar's frame. */
export function UsageDock() {
  return (
    <Dock
      k="usage"
      mark={<GaugeIcon aria-hidden className={cn(GLYPH, "shrink-0 text-warning-foreground")} />}
      title={LIMIT_WORDS.reached}
      note={<span className={NOTE}>{LIMIT_WORDS.stopped("Claude Code")}</span>}
      foot={<WriteMessage />}
      acts={
        <>
          <Button variant="outline" onClick={() => openBar(null)}>
            {LIMIT_WORDS.cancel}
          </Button>
          <Button onClick={() => openBar(null)}>{LIMIT_WORDS.resume}</Button>
        </>
      }
    />
  );
}

/** A bar's way back to the composer, the question panel's own quiet text button; only the question panel, which asks
 * something, says "instead". */
export function WriteMessage() {
  return (
    <Button size="xs" variant="ghost" data-dock-write className="px-0 [:hover,[data-pressed]]:bg-transparent" onClick={() => openBar(null)}>
      {DRAWER_WORDS.write}
    </Button>
  );
}

export { openBar };
