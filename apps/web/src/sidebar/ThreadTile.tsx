// SPDX-License-Identifier: AGPL-3.0-only
// A thread in the sidebar as one tile of three rows: the project and the
// computer it runs on with the thread's status at the right, the title, then
// the agent's mark and the branch, with the crab at the row's end while the
// thread works. Every tile the sidebar draws takes this shape: a thread, a
// workspace that holds no thread yet, a send in flight and a workspace being
// made. A resting title takes the muted ink, so the tiles a person is waiting
// on stand out. Renaming turns the title into the sidebar's one name box in the
// same row, so the tile keeps its height while a name is typed.
import type { MouseEvent, ReactNode } from "react";
import { GitBranchIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { THREAD_WORDS, WORKSPACE_WORDS } from "../actions/format.js";
import type { Launch, SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Crab } from "../components/status/Crab.js";
import type { ThreadStatusInput } from "../components/status/kinds/index.js";
import { ThreadStatus } from "../components/status/ThreadStatus.js";
import { threadStatusOf } from "../components/status/threadStatusOf.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { ProjectGlyph } from "../projects/look.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { TILE_CLASS, TILE_ROW_ONE_CLASS, TILE_ROW_THREE_CLASS, TILE_TITLE_CLASS, threadRowId } from "./rowGrammar.js";
import { isThreadWorking } from "./Sidebar.logic.js";

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

/** The three rows every tile draws. Row three is the agent's mark and the branch; a copy with no branch shows the
 * mark alone, and a row three with neither is an empty line that keeps the tile's height. */
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

/** The branch a tile's copy is on, with its glyph; nothing where the copy carries none. */
export function TileBranch({ branch }: { branch: string }) {
  if (branch === "") return null;
  return (
    <>
      <GitBranchIcon aria-hidden className="size-3 shrink-0 text-[var(--top-row-meta)]" />
      <span data-tile-branch className="min-w-0 truncate">
        {branch}
      </span>
    </>
  );
}

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
  time,
  depth,
  active,
  renaming,
  saving,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel,
  onRenameOpen,
}: {
  thread: SidebarThreadSnapshot;
  place: TilePlace;
  /** The branch the thread's copy is on; empty on a copy that carries none. */
  branch: string;
  /** How long ago a resting thread last moved, as the sidebar words it. */
  time: string;
  /** How many tiles of the tree stand over this one. */
  depth: number;
  active: boolean;
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
}) {
  const idle = !isThreadWorking(thread);
  return (
    <SidebarMenuButton
      size="sm"
      // An input may not sit inside a button, so a tile being renamed is a plain box with the same grammar.
      render={renaming ? <div /> : <button type="button" />}
      isActive={active}
      data-sidebar-row
      data-row-id={threadRowId(thread.id)}
      data-depth={depth}
      title={tileHover(thread.title, place, thread.harness, thread.asking)}
      className={TILE_CLASS}
      {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
    >
      <TileRows
        place={place}
        status={<ThreadStatus thread={thread} age={time} />}
        title={
          renaming ? (
            <span className="flex h-[18px] min-w-0">
              <RowNameInput name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
            </span>
          ) : (
            <Title text={thread.title} idle={idle} active={active} onDoubleClick={onRenameOpen} />
          )
        }
        harness={thread.harness}
        third={<TileBranch branch={branch} />}
        crab={threadStatusOf(thread).crab === true}
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
      title={tileHover(name, place, null, null)}
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
        third={<TileBranch branch={branch} />}
        crab={false}
      />
    </SidebarMenuButton>
  );
}

/** A send in flight is working by the fact of having been sent, read through the same status as the runtime's own
 * rows, so the two tiles cannot say different things about the same thread. */
const LAUNCHED: ThreadStatusInput = { status: "running", asking: null, startedAt: null };

/** The send the runtime has written no row for yet, in the tile's own grammar. Not a button: the thread it stands
 * for has no id to select until the runtime answers, and the transcript the person is looking at is already it. */
export function ThreadLaunchTile({ launch, place, branch }: { launch: Launch; place: TilePlace; branch: string }) {
  return (
    <SidebarMenuButton size="sm" render={<div />} data-thread-launch data-depth={0} title={tileHover(launch.title, place, launch.harness, null)} className={TILE_CLASS}>
      <TileRows
        place={place}
        status={<ThreadStatus thread={LAUNCHED} />}
        title={<Title text={launch.title} idle={false} active={false} />}
        harness={launch.harness}
        third={<TileBranch branch={branch} />}
        crab
      />
    </SidebarMenuButton>
  );
}

const CREATE_FAILED: ThreadStatusInput = { status: "failed", asking: null, startedAt: null };

/** A workspace still being made, in the tile's grammar: where it will run, its name, and the step the create is
 * waiting on in row three, with the whole of it on the hover text. A refused create says Failed in the slot. */
export function CreationTile({ rowId, name, place, line, failed, active, onSelect }: { rowId: string; name: string; place: TilePlace; line: string; failed: boolean; active: boolean; onSelect: () => void }) {
  return (
    <SidebarMenuButton size="sm" isActive={active} aria-busy={failed ? undefined : "true"} data-sidebar-row data-row-id={rowId} data-depth={0} title={tileHover(name, place, null, line)} className={TILE_CLASS} onClick={onSelect}>
      <TileRows
        place={place}
        status={failed ? <ThreadStatus thread={CREATE_FAILED} /> : null}
        title={<Title text={name} idle={false} active={active} />}
        harness={null}
        third={
          <span data-creation-line className="min-w-0 truncate">
            {line}
          </span>
        }
        crab={false}
      />
    </SidebarMenuButton>
  );
}
