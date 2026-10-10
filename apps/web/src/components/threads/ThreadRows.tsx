// SPDX-License-Identifier: AGPL-3.0-only
// A thread as a one-line row: the agent's mark, the title as the way to the
// thread, and the one status slot at a fixed width so times and words line up
// down the list. A lead's rows add the line under the title (what it asks, why
// it failed, what holds it, its last line), led by the computer where that is
// not the lead's; and the acts the status slot yields to on hover, from md up.
// A subagent's row is the same box, led by the glyph the timeline gives the
// call that launched it.
import { agentName } from "@wsp/catalog";
import { appHash, type PlaceView, type SubagentView } from "@wsp/protocol";
import { BotIcon, EllipsisIcon, type LucideIcon } from "lucide-react";
import { memo, useState, type MouseEvent, type ReactNode } from "react";
import { CHILD_WORDS } from "../../actions/format.js";
import { openContextMenu, runAction } from "../../actions/contextMenu.js";
import { resolveActions, type ResolvedAction } from "../../actions/registry.js";
import { childActions, type ChildTarget } from "../../actions/threadActions.js";
import { sendToThread, useChildVerbs } from "../../actions/verbs.js";
import type { SidebarThreadSnapshot } from "../../adapt/index.js";
import { cn } from "../../lib/utils.js";
import { useStore } from "../../protocol/store.js";
import { ComputerGlyph } from "../../settings/ComputerGlyph.js";
import { HOVER_GLYPH_CLASS } from "../../sidebar/rowGrammar.js";
import { RowNameInput } from "../../sidebar/RowNameInput.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import type { StatusKind } from "../status/kinds/index.js";
import { restingAge } from "../status/restingAge.js";
import { LINE_SLOT_CLASS, ThreadStatus } from "../status/ThreadStatus.js";
import { ThreadLink } from "../ThreadLink.js";
import { Button } from "../ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { subagentStatus } from "./leadTree.js";
import { SubagentCard } from "./SubagentCard.js";

export interface ThreadRowItem {
  readonly thread: SidebarThreadSnapshot;
  /** The computer the thread runs on by its name, where that is not the lead's; empty where it is. It leads the
   * second line. */
  readonly place: string;
  /** That computer's record, its glyph read off it; undefined until the places list holds it. */
  readonly at?: PlaceView | undefined;
  /** A line under the title, for what the row cannot say in its cells. */
  readonly note?: string;
}

/** How long the pointer rests on a subagent's row before its card opens, the tile card's own delay. */
const CARD_DELAY_MS = 450;

/** The acts' room from md up, as wide as the ghost buttons it holds with 4 px between, so the title's width never
 * moves when they fade in. */
const ACTS_ROOM = ["", "md:min-w-6", "md:min-w-13", "md:min-w-20"] as const;

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
            data-child-act={label}
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

/** Whether the pointer or the focus has reached the row yet. Its acts mount then and stay: a lead's tree mounts every
 * row as its thread opens, and each act is a tooltip of its own that nobody has pointed at. A row whose title is no
 * link has nothing a Tab lands on before its acts, so its acts stand mounted. */
function useWoken(): [boolean, { onPointerEnter: () => void; onFocus: () => void }] {
  const [woken, setWoken] = useState(false);
  const wake = (): void => setWoken(true);
  return [woken, { onPointerEnter: wake, onFocus: wake }];
}

/** The status slot and, where the row takes acts, the acts it yields to while the pointer or the focus is on the row
 * or its menu is open: Send a message and the state act, then More, which opens the right-click's menu. */
function Slot({ status, acts, menu, more, woken }: { status: ReactNode; acts: ReadonlyArray<ResolvedAction>; menu: (event: MouseEvent<HTMLElement>) => void; more: boolean; woken: boolean }) {
  const shown = acts.filter(act => act.refusal === null && act.icon !== undefined).slice(0, 2);
  const count = shown.length + (more ? 1 : 0);
  if (count === 0) return status;
  return (
    <span className={cn("relative flex shrink-0 items-center justify-end", ACTS_ROOM[count])}>
      <span className="inline-flex md:group-hover/row:invisible md:group-focus-within/row:invisible md:group-data-[acts=shown]/row:invisible">{status}</span>
      <span data-child-acts className={cn("absolute inset-y-0 right-0 flex items-center justify-end gap-1 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-[acts=shown]/row:opacity-100", HOVER_GLYPH_CLASS)}>
        {woken ? shown.map(act => <Act key={act.id} icon={act.icon!} label={act.title} run={() => void runAction(act)} />) : null}
        {woken && more ? <Act icon={EllipsisIcon} label={CHILD_WORDS.more} run={menu} /> : null}
      </span>
    </span>
  );
}

/** The computer a child runs on, where that is not its lead's: its glyph and its name, the second line's first fact. */
function RunsOn({ at, name }: { at: PlaceView | undefined; name: string }) {
  return (
    <span data-thread-place className="inline-flex shrink-0 items-center gap-1" title={CHILD_WORDS.runsOn(name)}>
      {at === undefined ? null : <ComputerGlyph place={at} className="size-3" />}
      {name}
    </span>
  );
}

/** The second line: the computer where it is not the lead's, then the note; or the message field in its place. */
function SecondLine({ place, at, note }: { place: string; at: PlaceView | undefined; note: string | undefined }) {
  if (place === "" && note === undefined) return null;
  return (
    <span data-tree-note-line className="flex min-w-0 items-center gap-3 text-[11px] leading-[14px] text-muted-foreground">
      {place === "" ? null : <RunsOn at={at} name={place} />}
      {note === undefined ? null : (
        <span data-tree-note className="min-w-0 truncate" title={note}>
          {note}
        </span>
      )}
    </span>
  );
}

/** The row's box: the mark column, the title over its second line, then what stands at the right. One box for a
 * thread, a subagent and a fold, so the three line up down the list. */
function rowBox(twoLines: boolean, extra?: string): string {
  return cn(
    "group/row flex min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-sm transition-colors duration-150 hover:bg-accent data-[acts=shown]:bg-accent",
    twoLines ? "min-h-12 py-1.5" : "h-9",
    extra,
  );
}

type ThreadRowProps = ThreadRowItem & {
  /** The child as its acts read it, where the row stands in a lead's tree; a row outside one takes no acts. */
  readonly target?: ChildTarget;
  /** The status it ends in, where the tree reads it otherwise than the thread alone would. */
  readonly kind?: StatusKind;
  /** Whether the message field stands in the second line's place; the tree holds it, since it moves the connector. */
  readonly sending?: boolean;
  readonly onSending?: (open: boolean) => void;
  readonly className?: string;
};

/** One thread's line; a press anywhere on it opens the thread, as its title does, except on its acts and its field. */
export const ThreadRow = memo(function ThreadRow({ thread, place, at, note, target, kind, sending = false, onSending, className }: ThreadRowProps) {
  const select = useStore(s => s.select);
  const api = useStore(s => s.api);
  const verbs = useChildVerbs();
  const [shown, setShown] = useState(false);
  const [woken, wake] = useWoken();
  const threadId = thread.threadId;
  const acts = target === undefined ? [] : resolveActions(childActions, target, { ...verbs, message: onSending === undefined ? undefined : () => onSending(true) });
  const menu = (event: MouseEvent<HTMLElement>): void => {
    if (acts.length === 0) return;
    setShown(true);
    void openContextMenu(event, acts).finally(() => setShown(false));
  };
  const twoLines = sending || note !== undefined || place !== "";
  const status = <ThreadStatus thread={thread} age={restingAge(thread)} settled={target?.part === "settled"} {...(kind !== undefined ? { kind } : {})} className={LINE_SLOT_CLASS} />;
  return (
    <div
      data-thread-row={thread.id}
      {...(target !== undefined ? { "data-child-part": target.part } : {})}
      {...(shown ? { "data-acts": "shown" } : {})}
      className={rowBox(twoLines, cn(threadId !== null && "cursor-pointer", className))}
      {...(threadId === null
        ? {}
        : {
            onClick: (event: MouseEvent<HTMLDivElement>) => {
              if (!(event.target instanceof Element) || event.target.closest("a, button, input") === null) select(thread.workspaceId, threadId);
            },
          })}
      {...(acts.length > 0 ? { onContextMenu: menu } : {})}
      {...wake}
    >
      {/* The muted ink is the wrapper's, so a mark with inks of its own keeps them and a bare one takes the row's quiet ink. */}
      <span className="inline-flex shrink-0 text-muted-foreground">
        <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />
      </span>
      <span className="flex min-w-28 flex-1 flex-col">
        <ThreadLink thread={thread} className={cn("min-w-0 truncate", target?.part === "settled" ? "text-muted-foreground" : "text-foreground")} />
        {sending ? (
          <span className="flex h-4.5 min-w-0 text-xs">
            <RowNameInput
              name=""
              label={CHILD_WORDS.messageTo(thread.title)}
              placeholder={CHILD_WORDS.send}
              saving={false}
              onRename={text => {
                onSending?.(false);
                sendToThread(api, thread, text);
              }}
              onCancel={() => onSending?.(false)}
            />
          </span>
        ) : (
          <SecondLine place={place} at={at} note={note} />
        )}
      </span>
      {sending ? (
        status
      ) : (
        <Slot status={status} acts={acts} menu={menu} more={target !== undefined && target.task === null} woken={woken || shown || threadId === null} />
      )}
    </div>
  );
}, sameRow);

/** The fields of a thread a row draws or acts on: anything else moving leaves the row as it is. */
const DRAWN = ["id", "title", "status", "asking", "startedAt", "endedAt", "readAt", "settledAt", "unread", "harness", "threadId", "sessionId", "workspaceId", "resumeAt", "limit"] as const;

const sameTarget = (a: ChildTarget | undefined, b: ChildTarget | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.part === b.part &&
    a.running === b.running &&
    a.working === b.working &&
    a.task === b.task &&
    a.title === b.title &&
    a.sessionId === b.sessionId &&
    a.replaces === b.replaces &&
    a.replacedBy === b.replacedBy &&
    a.settles.join("\n") === b.settles.join("\n"));

/** A row draws again only when something it draws moved, so a status change elsewhere in the list leaves it alone. */
function sameRow(a: ThreadRowProps, b: ThreadRowProps): boolean {
  return (
    DRAWN.every(field => a.thread[field] === b.thread[field]) &&
    a.thread.capped?.running === b.thread.capped?.running &&
    a.place === b.place &&
    a.at === b.at &&
    a.note === b.note &&
    a.kind === b.kind &&
    a.className === b.className &&
    a.sending === b.sending &&
    a.onSending === b.onSending &&
    sameTarget(a.target, b.target)
  );
}

type SubagentRowProps = {
  subagent: SubagentView;
  target: ChildTarget;
  kind: StatusKind;
  note: string | undefined;
  /** The lead thread whose page holds the subagent's lines, where a press on the row opens its page. */
  lead?: { workspaceId: string; threadId: string } | undefined;
};

/** One of an agent's own subagents, in the row's box under the thread whose agent runs it: the launching call's
 * glyph, its title with its card on rest, its status, and Stop subagent on hover while it runs. A press on it, but on
 * its acts, opens its page where it names its lead. */
export const SubagentRow = memo(function SubagentRow({ subagent, target, kind, note, lead }: SubagentRowProps) {
  const verbs = useChildVerbs();
  const [woken, wake] = useWoken();
  const acts = resolveActions(childActions, target, verbs);
  const menu = (event: MouseEvent<HTMLElement>): void => {
    if (acts.length > 0) void openContextMenu(event, acts);
  };
  const ended = subagent.endedAt === undefined ? null : new Date(subagent.endedAt).toISOString();
  const call = subagent.parentToolUseId;
  const opens = lead === undefined || call === undefined ? undefined : () => useStore.getState().select(lead.workspaceId, lead.threadId, call);
  const titleInk = target.part === "settled" ? "text-muted-foreground" : "text-foreground";
  const status = (
    <ThreadStatus thread={subagentStatus(subagent)} age={restingAge({ startedAt: new Date(subagent.startedAt).toISOString(), endedAt: ended })} kind={kind} className={LINE_SLOT_CLASS} />
  );
  return (
    <div
      data-subagent-row={subagent.id}
      data-child-part={target.part}
      className={rowBox(note !== undefined, opens === undefined ? undefined : "cursor-pointer")}
      {...(acts.length > 0 ? { onContextMenu: menu } : {})}
      {...wake}
      {...(opens === undefined
        ? {}
        : {
            onClick: (event: MouseEvent<HTMLDivElement>) => {
              if (!(event.target instanceof Element) || event.target.closest("a, button, input") === null) opens();
            },
          })}
    >
      <span className="inline-flex shrink-0 text-muted-foreground">
        <BotIcon aria-hidden data-subagent-mark className="size-3.25" />
      </span>
      <span className="flex min-w-28 flex-1 flex-col">
        <Tooltip>
          <TooltipTrigger delay={CARD_DELAY_MS} render={<span className="flex min-w-0" />}>
            {lead === undefined || call === undefined ? (
              <span className={cn("min-w-0 truncate", titleInk)}>{subagent.title}</span>
            ) : (
              <a
                data-subagent-open
                href={appHash({ workspaceId: lead.workspaceId, threadId: lead.threadId, subagent: call })}
                className={cn("min-w-0 truncate underline-offset-2 hover:underline", titleInk)}
                onClick={event => {
                  event.preventDefault();
                  opens?.();
                }}
              >
                {subagent.title}
              </a>
            )}
          </TooltipTrigger>
          <SubagentCard subagent={subagent} harness={target.harness} workspaceId={lead?.workspaceId ?? null} kind={kind} reason={note} />
        </Tooltip>
        <SecondLine place="" at={undefined} note={note} />
      </span>
      <Slot status={status} acts={acts} menu={menu} more={false} woken={woken || opens === undefined} />
    </div>
  );
}, (a, b) => a.lead?.workspaceId === b.lead?.workspaceId && a.lead?.threadId === b.lead?.threadId && sameSubagentRow(a, b));

const SUBAGENT_DRAWN = ["id", "title", "state", "startedAt", "endedAt", "asked", "model", "lastLine", "failure"] as const;

export function sameSubagentRow(a: { subagent: SubagentView; target: ChildTarget; kind: StatusKind; note: string | undefined }, b: typeof a): boolean {
  return SUBAGENT_DRAWN.every(field => a.subagent[field] === b.subagent[field]) && a.kind === b.kind && a.note === b.note && a.target.harness === b.target.harness && sameTarget(a.target, b.target);
}
