// SPDX-License-Identifier: AGPL-3.0-only
// The proposed composer: one drawer on the composer's top edge, in the task drawer's own shape, holding a row for
// every folded thing a busy lead has (the question it waits on, a usage limit, its threads, its task list, the
// messages waiting to be sent), most pressing first; a press on a row opens that thing's bar in the composer's place,
// and the bar's Write a message instead folds it back. Today these stand in four shapes in four places (a separate
// box for a folded question, a strip for the limit, cards over the box for the queue, the drawer for tasks, and the
// Threads block at the transcript's end); here they are one drawer and one bar. The Threads row is the Threads block
// moved to where the person types: the transcript keeps each child as a live tile where its lead started it.
import { LIMIT_WORDS } from "@wsp/protocol";
import { ChevronUpIcon, GaugeIcon, ListTodoIcon, ListTreeIcon, MessageCircleQuestionIcon, MessageSquareTextIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { isPromptOpen, type PermissionPrompt } from "../../src/adapt/index";
import { useComposerQueue } from "../../src/components/chat/composerDraftStore";
import { composerTasks } from "../../src/components/chat/composerTasks.logic";
import type { ChatThreadHandle } from "../../src/components/chat/useChatThread";
import { Button } from "../../src/components/ui/button";
import { cn } from "../../src/lib/utils";
import { useSidebarProjects } from "../../src/protocol/store";
import { Grid } from "../../src/settings/grid";
import { GLYPH, NOTE } from "../../src/settings/layout";
import { Row } from "../../src/settings/rows";
import { Dock } from "./Dock";
import { TreeRows, TreeSummary, useSubtree } from "./LeadThreads";

export type BarKind = "question" | "usage" | "threads" | "tasks" | "queue";
/** Which bar stands in the composer's place, none while the composer does. */
export const useBar = create<{ open: BarKind | null }>(() => ({ open: new URLSearchParams(window.location.search).get("open") as BarKind | null }));
const openBar = (kind: BarKind | null): void => useBar.setState({ open: kind });

const BUSY = new URLSearchParams(window.location.search).get("busy") === "1";

export const DRAWER_WORDS = {
  waiting: "Waiting for you",
  threads: "Threads",
  tasks: "Tasks",
  queued: (n: number) => `${n} ${n === 1 ? "message" : "messages"} waiting`,
  usageLine: "Claude Code resumes at 21:00",
  write: "Write a message instead",
} as const;

/** The prompt the latest turn waits on, where this thread's own agent raised one and nobody has answered. */
export function openPrompt(thread: ChatThreadHandle): PermissionPrompt | null {
  const turnId = thread.view.latestTurn?.turnId ?? null;
  for (const entry of thread.view.entries) if (entry.kind === "permission" && entry.permission.turnId === turnId && isPromptOpen(entry.permission)) return entry.permission;
  return null;
}

/** One row of the drawer: the thing's glyph in its tone, its name, its one line, a fact at the right, and the
 * chevron that says the row opens upward into the bar. */
function DrawerRow({ kind, glyph, ink, name, line, fact }: { kind: BarKind; glyph: LucideIcon; ink?: string; name: string; line?: string; fact?: ReactNode }) {
  const Glyph = glyph;
  return (
    <button
      type="button"
      data-drawer-row={kind}
      onClick={() => openBar(kind)}
      className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-[10px] px-2 text-left transition-colors duration-150 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Glyph aria-hidden className={cn("size-3 shrink-0", ink ?? "text-muted-foreground")} />
      <span className={cn("shrink-0", ink !== undefined ? cn("font-medium", ink) : "text-foreground")}>{name}</span>
      {line === undefined ? <span className="flex-1" /> : <span className="min-w-0 flex-1 truncate text-muted-foreground">{line}</span>}
      {fact === undefined ? null : <span className="shrink-0 text-muted-foreground tabular-nums">{fact}</span>}
      <ChevronUpIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The drawer, in the composer's shell where today's task drawer stands, with the task drawer's own frame. */
export function ComposerDrawer({ thread, threadKey }: { thread: ChatThreadHandle; threadKey: string }) {
  const prompt = openPrompt(thread);
  const queue = useComposerQueue(threadKey);
  const tree = useSubtree(threadKey);
  const tasks = composerTasks({ latestTurn: thread.view.latestTurn, running: thread.view.latestTurn?.state === "running", plan: thread.view.plan, asking: false });
  const live = tree.counts.needsYou + tree.counts.failed + tree.counts.working + tree.counts.waiting;
  const question = prompt === null ? null : prompt.toolName === "AskUserQuestion" ? ((JSON.parse(prompt.input) as { questions?: Array<{ question: string }> }).questions?.[0]?.question ?? prompt.toolName) : prompt.toolName;
  const rows = [
    question === null ? null : <DrawerRow key="q" kind="question" glyph={MessageCircleQuestionIcon} ink="text-status-input" name={DRAWER_WORDS.waiting} line={question} />,
    BUSY ? <DrawerRow key="u" kind="usage" glyph={GaugeIcon} ink="text-warning-foreground" name={LIMIT_WORDS.reached} line={DRAWER_WORDS.usageLine} /> : null,
    tree.nodes.length === 0 ? null : <DrawerRow key="t" kind="threads" glyph={ListTreeIcon} name={DRAWER_WORDS.threads} fact={live === 0 ? `${tree.counts.finished}` : <TreeSummary counts={tree.counts} />} />,
    tasks === null ? null : <DrawerRow key="k" kind="tasks" glyph={ListTodoIcon} name={DRAWER_WORDS.tasks} line={tasks.step} fact={`${tasks.done}/${tasks.total}`} />,
    queue.length === 0 ? null : <DrawerRow key="m" kind="queue" glyph={MessageSquareTextIcon} name={DRAWER_WORDS.queued(queue.length)} line={queue[0]!.prompt} />,
  ].filter(row => row !== null);
  if (rows.length === 0) return null;
  return (
    <div
      data-composer-drawer
      data-composer-banner-surface="attached"
      className="relative z-0 mx-auto -mb-px flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] flex-col rounded-t-[14px] border border-b-0 border-(--chat-composer-outline) bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--chat-composer-glass-opacity),transparent)] px-1 pt-1 pb-1 text-xs leading-4 glass-backdrop"
    >
      {rows}
    </div>
  );
}

/** The Threads bar: the lead's whole tree, the Threads block's own rows, in the bar's body; Write a message instead
 * folds it back to its drawer row. */
export function ThreadsDock({ workspaceId, threadKey }: { workspaceId: string; threadKey: string }) {
  const fleet = useSidebarProjects();
  const tree = useSubtree(threadKey);
  const rows = fleet.flatMap(runs => runs.threads.filter(thread => thread.parentThreadId === threadKey).map(thread => ({ thread, place: "" })));
  const name = fleet.find(project => project.id === workspaceId)?.workspace.name ?? workspaceId;
  return (
    <Dock
      k="threads"
      mark={<ListTreeIcon aria-hidden className={cn(GLYPH, "shrink-0")} />}
      title={DRAWER_WORDS.threads}
      aside={<TreeSummary counts={tree.counts} />}
      foot={<WriteInstead />}
    >
      <div className="-mx-3 max-h-[46vh] overflow-y-auto">
        <TreeRows lead={{ id: workspaceId, name }} tree={undefined} rows={rows} />
      </div>
    </Dock>
  );
}

/** The messages waiting to be sent, each as a settings row, in the order they will go. */
export function QueueDock({ threadKey }: { threadKey: string }) {
  const queue = useComposerQueue(threadKey);
  return (
    <Dock k="queue" mark={<MessageSquareTextIcon aria-hidden className={cn(GLYPH, "shrink-0")} />} title={DRAWER_WORDS.queued(queue.length)} foot={<WriteInstead />}>
      <Grid id="queue">
        {queue.map((row, at) => (
          <Row key={row.id} id={row.id} title={`${at + 1}`} description={row.prompt} />
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
      foot={<WriteInstead />}
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

/** The bar's way back to the composer, the question panel's own quiet word. */
export function WriteInstead() {
  return (
    <Button size="xs" variant="ghost" data-dock-write className="px-0 [:hover,[data-pressed]]:bg-transparent" onClick={() => openBar(null)}>
      {DRAWER_WORDS.write}
    </Button>
  );
}

export { openBar };
