// SPDX-License-Identifier: AGPL-3.0-only
// A thread in the sidebar as one tile of three rows: the project and the
// computer it runs on with the thread's status at the right, the title, then
// the agent's mark and the branch, with the crab at the row's end while the
// thread works. Every tile the sidebar draws takes this shape: a thread, a
// workspace that holds no thread yet, a send in flight and a workspace being
// made. A resting title takes the muted ink, so the tiles a person is waiting
// on stand out. Renaming turns the title into the sidebar's one name box in the
// same row, so the tile keeps its height while a name is typed.
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { AlarmClockIcon, GitBranchIcon, GitCommitHorizontalIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { THREAD_WORDS, WORKSPACE_WORDS } from "../actions/format.js";
import type { Launch, SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Crab } from "../components/status/Crab.js";
import type { ThreadStatusInput } from "../components/status/kinds/index.js";
import { ThreadStatus } from "../components/status/ThreadStatus.js";
import { threadStatusOf } from "../components/status/threadStatusOf.js";
import { RESTING } from "../components/status/kinds/resting.js";
import { STARTING } from "../components/status/kinds/starting.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { ProjectGlyph } from "../projects/look.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { PR_INK } from "../pull-request/words.js";
import type { TileCheckout } from "./tileCheckout.js";
import { SNOOZE_WORDS } from "./words.js";
import type { LinkDown } from "../terminal/paneWords.js";
import { ONE_LINE_ROW_CLASS, TILE_CLASS, TILE_ROW_ONE_CLASS, TILE_ROW_THREE_CLASS, TILE_TITLE_CLASS, threadRowId } from "./rowGrammar.js";

/** Where a tile's thread runs, as row one names it: the project and the computer by the names a person reads, either
 * empty while it is not known yet. */
export interface TilePlace {
  readonly projectId: string;
  readonly project: string;
  readonly computer: string;
}

const whereWords = (place: TilePlace): string => [place.project, place.computer].filter(word => word !== "").join(" @ ");

/** The tile's hover text: the title, where it runs, the agent and the reason it is held, one per line. */
export const tileHover = (title: string, place: TilePlace, harness: string | null, reason: string | null): string =>
  [title, whereWords(place), harness === null ? null : agentName(harness), reason].filter(part => part !== null && part !== "").join("\n");

/** The three rows every tile draws. Row three is the agent's mark and the branch; a workspace with no branch known
 * shows the mark alone, and a row three with neither is an empty line that keeps the tile's height. */
function TileRows({ place, status, title, harness, third, crab }: { place: TilePlace; status: ReactNode; title: ReactNode; harness: string | null; third: ReactNode; crab: boolean }) {
  return (
    <>
      <span className={TILE_ROW_ONE_CLASS}>
        <ProjectGlyph projectId={place.projectId} className="size-3" />
        <span data-tile-where className="min-w-0 flex-1 truncate">
          {whereWords(place)}
        </span>
        {status}
      </span>
      {title}
      <span className={TILE_ROW_THREE_CLASS}>
        {harness === null ? null : <HarnessMark harness={harness} label={agentName(harness)} className="size-3" />}
        {third}
        {crab ? <Crab className="ml-auto text-status-working" /> : null}
      </span>
    </>
  );
}

/** The branch a tile's workspace is on with its glyph, or the head's short commit where it is on none, then the pull
 * request's number in its state's ink, then each fact the host read beside them, spaced rather than joined; the
 * branch gives way first down to a few letters, then the facts go whole from the last, each wrapping onto a line the
 * row does not show, so no fact is ever cut mid-word. The branch's weight is lopsided so the facts' share rounds to
 * nothing until it reaches its floor. */
export function TileBranch({ branch, commit, pr, counts = [] }: { branch: string; commit?: string | undefined; pr?: TileCheckout["pr"]; counts?: readonly string[] | undefined }) {
  const named = branch !== "" || commit !== undefined;
  if (!named && pr === undefined && counts.length === 0) return null;
  return (
    <>
      {branch !== "" ? <GitBranchIcon aria-hidden className="size-3 shrink-0 text-[var(--top-row-meta)]" /> : commit !== undefined ? <GitCommitHorizontalIcon aria-hidden className="size-3 shrink-0 text-[var(--top-row-meta)]" /> : null}
      <span className="flex min-w-0 items-center">
        {branch !== "" ? (
          <span data-tile-branch className="min-w-12 shrink-[100000] truncate">
            {branch}
          </span>
        ) : commit !== undefined ? (
          <span data-tile-commit className="shrink-0 font-mono tabular-nums">
            {commit}
          </span>
        ) : null}
        {pr === undefined ? null : <PullRequestMark pr={pr} className={named ? "ms-3" : ""} />}
        {counts.length === 0 ? null : (
          // The empty first item holds the one line shown, so even the first fact can go onto the hidden one.
          <span className="flex h-lh min-w-0 flex-wrap overflow-hidden">
            <span aria-hidden className="h-lh" />
            {counts.map((count, i) => (
              <span key={count} data-tile-count className={cn(!named && pr === undefined && i === 0 ? "" : "ms-3", "shrink-0 whitespace-nowrap")}>
                {count}
              </span>
            ))}
          </span>
        )}
      </span>
    </>
  );
}

/** The pull request as its number alone, in the ink of where it stands, as T3 Code's sidebar marks it. */
const PullRequestMark = ({ pr, className }: { pr: NonNullable<TileCheckout["pr"]>; className?: string }) => (
  <span data-tile-pr data-pr-state={pr.state} className={cn("shrink-0 tabular-nums", PR_INK[pr.state], className)}>
    #{pr.number}
  </span>
);

/** The slot of a snoozed root while threads of its tree run: the snooze's glyph and how many, in the row's own ink,
 * so the tree stays reachable without calling for the person. */
const SnoozedWorking = ({ count }: { count: number }) => (
  <span data-thread-status="snoozed" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums">
    <AlarmClockIcon aria-hidden className="size-3 shrink-0" />
    {SNOOZE_WORDS.working(count)}
  </span>
);

const Title = ({ text, idle, active, onDoubleClick }: { text: string; idle: boolean; active: boolean; onDoubleClick?: (() => void) | undefined }) => (
  <span
    data-thread-title
    className={cn(TILE_TITLE_CLASS, idle ? "text-sidebar-muted-foreground" : "text-sidebar-foreground", active && "font-medium")}
    onDoubleClick={
      onDoubleClick === undefined
        ? undefined
        : event => {
            event.stopPropagation();
            onDoubleClick();
          }
    }
  >
    {text}
  </span>
);

export function ThreadTile({
  thread,
  place,
  branch,
  commit,
  pr,
  counts,
  why,
  time,
  depth,
  active,
  settled = false,
  snoozedWorking,
  linkDown,
  renaming,
  saving,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel,
  onRenameOpen,
  onDragStart,
  onDragEnd,
  label,
}: {
  thread: SidebarThreadSnapshot;
  place: TilePlace;
  /** The branch the thread's workspace is on; empty where none is known. */
  branch: string;
  /** The head's short commit, drawn in the branch's place where the branch is empty. */
  commit?: string | undefined;
  pr?: TileCheckout["pr"];
  /** The words the host read beside that branch. */
  counts?: readonly string[] | undefined;
  /** Why the pull request is not read, for the hover. */
  why?: string | undefined;
  /** How long ago a resting thread last moved, as the sidebar words it. */
  time: string;
  /** How many tiles of the tree stand over this one. */
  depth: number;
  active: boolean;
  /** The tile sits in the Settled fold: one slim row of its title, the pull request's number and its age, resting
   * whatever its state, as T3 Code's settled rows. */
  settled?: boolean;
  /** The tile stands for a snoozed tree while threads of it run: how many, said quietly in place of the status. */
  snoozedWorking?: number | undefined;
  /** The workspace's link is down: a resting tile says so in its slot in place of its age. */
  linkDown?: LinkDown | undefined;
  /** The name is being typed on this tile: row two holds the input instead of the title. */
  renaming: boolean;
  /** That name is on its way to the machine: the field stays exactly as it is and takes no second Enter. */
  saving: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onRename: (title: string) => void;
  onRenameCancel: () => void;
  /** Opens the box on this tile, as the menu's Rename does; absent where the rename is refused. */
  onRenameOpen?: (() => void) | undefined;
  /** The tile picked up to drop in another section; absent on a tile that is not dragged, one under a root. */
  onDragStart?: ((event: DragEvent<HTMLElement>) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
  /** What row two says in place of the title, where the title is already said over the tile: the model, in a group
   * of threads one send opened. */
  label?: string | undefined;
}) {
  const snoozed = snoozedWorking !== undefined;
  const status = settled || snoozed ? RESTING : threadStatusOf(thread);
  // Only a resting thread steps back; a failed one or one waiting on the person keeps the foreground ink.
  const idle = status === RESTING;
  if (settled)
    return (
      <SidebarMenuButton
        size="sm"
        render={renaming ? <div /> : <button type="button" />}
        isActive={active}
        data-sidebar-row
        data-slim="true"
        data-row-id={threadRowId(thread.id)}
        data-depth={depth}
        title={tileHover(thread.title, place, thread.harness, why ?? null)}
        className={ONE_LINE_ROW_CLASS}
        {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
      >
        <ProjectGlyph projectId={place.projectId} className={cn("size-3 shrink-0", !active && "opacity-40 grayscale")} />
        {renaming ? (
          <span className="flex h-[18px] min-w-0 flex-1">
            <RowNameInput name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
          </span>
        ) : (
          <span className="flex min-w-0 flex-1">
            <Title text={label ?? thread.title} idle active={active} onDoubleClick={onRenameOpen} />
          </span>
        )}
        {pr === undefined ? null : <PullRequestMark pr={pr} className="text-[11px] leading-[14px]" />}
        <span className="shrink-0 text-xs text-sidebar-muted-foreground">
          <ThreadStatus thread={thread} age={time} settled />
        </span>
      </SidebarMenuButton>
    );
  return (
    <SidebarMenuButton
      size="sm"
      // An input may not sit inside a button, so a tile being renamed is a plain box with the same grammar.
      render={renaming ? <div /> : <button type="button" />}
      isActive={active}
      data-sidebar-row
      data-row-id={threadRowId(thread.id)}
      data-depth={depth}
      title={tileHover(thread.title, place, thread.harness, [snoozed ? SNOOZE_WORDS.workingHover(snoozedWorking) : thread.asking, why ?? null].filter(line => line !== null).join("\n") || null)}
      className={TILE_CLASS}
      {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
      {...(renaming || onDragStart === undefined ? {} : { draggable: true, onDragStart, onDragEnd })}
    >
      <TileRows
        place={place}
        status={
          snoozed ? (
            <SnoozedWorking count={snoozedWorking} />
          ) : idle && linkDown !== undefined ? (
            <span data-thread-status="link-down" title={linkDown.sentence} className="inline-flex shrink-0 items-center whitespace-nowrap">
              {linkDown.word}
            </span>
          ) : (
            <ThreadStatus thread={thread} age={time} settled={settled} />
          )
        }
        title={
          renaming ? (
            <span className="flex h-[18px] min-w-0">
              <RowNameInput name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
            </span>
          ) : (
            <Title text={label ?? thread.title} idle={idle} active={active} onDoubleClick={onRenameOpen} />
          )
        }
        harness={thread.harness}
        third={<TileBranch branch={branch} commit={commit} pr={pr} counts={counts} />}
        crab={status.crab === true}
      />
    </SidebarMenuButton>
  );
}

/** A workspace that holds no thread yet, as a tile: its name for the title, no status and no agent, and its menu the
 * workspace's own verbs. Renaming it turns the name into the one name box, as a thread's title does. */
export function WorkspaceTile({
  rowId,
  name,
  place,
  branch,
  commit,
  pr,
  counts,
  why,
  depth,
  active,
  renaming,
  saving,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel,
}: {
  rowId: string;
  name: string;
  place: TilePlace;
  branch: string;
  commit?: string | undefined;
  pr?: TileCheckout["pr"];
  counts?: readonly string[] | undefined;
  why?: string | undefined;
  depth: number;
  active: boolean;
  renaming: boolean;
  saving: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
}) {
  return (
    <SidebarMenuButton
      size="sm"
      render={renaming ? <div /> : <button type="button" />}
      isActive={active}
      data-sidebar-row
      data-row-id={rowId}
      data-depth={depth}
      title={tileHover(name, place, null, why ?? null)}
      className={TILE_CLASS}
      {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
    >
      <TileRows
        place={place}
        status={null}
        title={
          renaming ? (
            <span className="flex h-[18px] min-w-0">
              <RowNameInput name={name} label={WORKSPACE_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
            </span>
          ) : (
            <Title text={name} idle active={active} />
          )
        }
        harness={null}
        third={<TileBranch branch={branch} commit={commit} pr={pr} counts={counts} />}
        crab={false}
      />
    </SidebarMenuButton>
  );
}

/** A send in flight is working by the fact of having been sent, read through the same status as the runtime's own
 * rows, so the two tiles cannot say different things about the same thread. */
const LAUNCHED: ThreadStatusInput = { status: "running", asking: null, startedAt: null, unread: false };

/** The send the runtime has written no row for yet, in the tile's own grammar. Not a button: the thread it stands
 * for has no id to select until the runtime answers, and the transcript the person is looking at is already it. */
export function ThreadLaunchTile({ launch, place, checkout }: { launch: Launch; place: TilePlace; checkout: TileCheckout }) {
  return (
    <SidebarMenuButton size="sm" render={<div />} data-thread-launch data-depth={0} title={tileHover(launch.title, place, launch.harness, null)} className={TILE_CLASS}>
      <TileRows
        place={place}
        status={<ThreadStatus thread={LAUNCHED} />}
        title={<Title text={launch.title} idle={false} active={false} />}
        harness={launch.harness}
        third={<TileBranch {...checkout} />}
        crab
      />
    </SidebarMenuButton>
  );
}

const CREATE_FAILED: ThreadStatusInput = { status: "failed", asking: null, startedAt: null, unread: false };
const CREATE_RUNNING: ThreadStatusInput = { status: "running", asking: null, startedAt: null, unread: false };

/** A workspace still being made, in the tile's grammar: where it will run with Starting in the slot, its name, and
 * the step the create is waiting on in row three with the crab at its end. A refused create says Failed instead. */
export function CreationTile({ rowId, name, place, line, failed, active, onSelect, onContextMenu }: { rowId: string; name: string; place: TilePlace; line: string; failed: boolean; active: boolean; onSelect: () => void; onContextMenu?: (event: MouseEvent<HTMLElement>) => void }) {
  return (
    <SidebarMenuButton size="sm" isActive={active} aria-busy={failed ? undefined : "true"} data-sidebar-row data-row-id={rowId} data-depth={0} title={tileHover(name, place, null, line)} className={TILE_CLASS} onClick={onSelect} onContextMenu={onContextMenu}>
      <TileRows
        place={place}
        status={failed ? <ThreadStatus thread={CREATE_FAILED} /> : <ThreadStatus thread={CREATE_RUNNING} kind={STARTING} />}
        title={<Title text={name} idle={false} active={active} />}
        harness={null}
        third={
          <span data-creation-line className={cn("min-w-0 truncate", failed && "text-status-failed")}>
            {line}
          </span>
        }
        crab={!failed}
      />
    </SidebarMenuButton>
  );
}
