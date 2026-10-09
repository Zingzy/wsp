// SPDX-License-Identifier: AGPL-3.0-only
// Everything waiting around the composer as one drawer on its top edge, a row
// each, most pressing first: the question the person folded, the usage limit
// that stopped the turn, the agent's step list, and the messages waiting for
// the turn to end. A press opens that row's bar in the composer's place. The
// frame and the row are the shipped task drawer's, as T3 Code's
// ComposerTasksBadge: the glyph, the name, the line, a count, the chevron up.
import { memo } from "react";
import { ChevronUpIcon, GaugeIcon, ListTodoIcon, MessageCircleQuestionIcon, MessageSquareTextIcon, type LucideIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { clockWord, LIMIT_WORDS } from "@wsp/protocol";
import { cn } from "../../lib/utils";
import { useMinuteClock } from "../status/useMinuteClock";
import { useComposerBarStore, type ComposerBar } from "./composerBar";

/** The words the drawer and its bars say that no other table holds. */
export const DRAWER_WORDS = {
  question: "Waiting for you",
  tasks: "Tasks",
  /** Every bar's way back to the composer but the question's, which says instead. */
  write: "Write a message",
} as const;

/** A row's kind: the question, or the bar it opens. */
export type DrawerKind = "question" | ComposerBar;

const GLYPHS: Record<DrawerKind, { glyph: LucideIcon; ink: string }> = {
  question: { glyph: MessageCircleQuestionIcon, ink: "text-status-input" },
  usage: { glyph: GaugeIcon, ink: "text-warning" },
  tasks: { glyph: ListTodoIcon, ink: "text-muted-foreground" },
  queue: { glyph: MessageSquareTextIcon, ink: "text-muted-foreground" },
};

/** One row: what it is, its line cut at the row's edge, and a count where it has one. Every prop is a word, so a
 * keystroke that draws the composer again draws no row. */
export const DrawerRow = memo(function DrawerRow({ kind, threadKey, name, line, count, hover }: { kind: DrawerKind; threadKey: string; name: string; line: string; count?: string; hover?: string }) {
  const { glyph: Glyph, ink } = GLYPHS[kind];
  const open = () => {
    const bars = useComposerBarStore.getState();
    if (kind === "question") bars.unfold(threadKey);
    else bars.openBar(threadKey, kind);
  };
  return (
    <button
      type="button"
      data-drawer-row={kind}
      onClick={open}
      onPointerDown={event => event.preventDefault()}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-start transition-colors duration-150 hover:bg-accent"
    >
      <Glyph aria-hidden className={cn("size-3.5 shrink-0", ink)} />
      <span data-drawer-name title={hover} className="shrink-0 text-muted-foreground">
        {name}
      </span>
      <span data-drawer-line title={line} className="min-w-0 flex-1 truncate text-foreground/80">
        {line}
      </span>
      {count === undefined ? null : (
        <span data-drawer-count className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      <ChevronUpIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
});

/** The limit's row: the clock time the agent resumes at, off the clock that moves each minute (a reset on another day
 * names its weekday until midnight), which no other row reads. */
const UsageRow = memo(function UsageRow({ threadKey, name, agent, resetsAt }: { threadKey: string; name: string; agent: string; resetsAt: number | null }) {
  const now = useMinuteClock();
  const line = resetsAt === null ? LIMIT_WORDS.stoppedUnknown(agentName(agent)) : LIMIT_WORDS.resumesAt(agentName(agent), clockWord(resetsAt, now));
  return <DrawerRow kind="usage" threadKey={threadKey} name={name} line={line} />;
});

/** What each row says, each null while it has nothing to say. */
export interface DrawerRows {
  readonly question: string | null;
  readonly usage: { readonly name: string; readonly agent: string; readonly resetsAt: number | null } | null;
  readonly tasks: { readonly step: string; readonly count: string } | null;
  readonly queue: { readonly name: string; readonly line: string; readonly hover?: string } | null;
}

export const hasRows = (rows: DrawerRows): boolean => rows.question !== null || rows.usage !== null || rows.tasks !== null || rows.queue !== null;

/** The drawer, attached to the box's top edge; drawn only while it holds a row. */
export function ComposerDrawer({ threadKey, rows }: { threadKey: string; rows: DrawerRows }) {
  if (!hasRows(rows)) return null;
  return (
    <div
      data-composer-drawer
      data-composer-banner-surface="attached"
      className="relative z-0 mx-auto -mb-px w-[calc(100%-2*var(--chat-composer-drawer-inset))] rounded-t-[14px] border border-b-0 border-(--chat-composer-outline) bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--chat-composer-glass-opacity),transparent)] px-1 pt-1 pb-1 text-xs leading-4 glass-backdrop"
    >
      {rows.question === null ? null : <DrawerRow kind="question" threadKey={threadKey} name={DRAWER_WORDS.question} line={rows.question} />}
      {rows.usage === null ? null : <UsageRow threadKey={threadKey} name={rows.usage.name} agent={rows.usage.agent} resetsAt={rows.usage.resetsAt} />}
      {rows.tasks === null ? null : <DrawerRow kind="tasks" threadKey={threadKey} name={DRAWER_WORDS.tasks} line={rows.tasks.step} count={rows.tasks.count} />}
      {rows.queue === null ? null : <DrawerRow kind="queue" threadKey={threadKey} name={rows.queue.name} line={rows.queue.line} {...(rows.queue.hover === undefined ? {} : { hover: rows.queue.hover })} />}
    </div>
  );
}
