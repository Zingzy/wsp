// SPDX-License-Identifier: AGPL-3.0-only
// Prototype copy of src/sidebar/ThreadTile.tsx as on main at 4c5d84dc4, put in its place by this page's vite config,
// with four changes the build makes to the shipped tile: the status slot shows each status as its icon alone, the
// working crab among them at the end of the first row, a thread at rest keeping its age; the card leads with a status row, the
// icon, the word, the reason and the time; on hover the slot gives way to Settle where a settle can run; and a tile
// with threads under it folds them away, its agent mark turning into the fold's chevron on hover and staying the
// chevron while folded, the folded tile carrying over that chevron, in the project glyph's place, the glyph of the
// most pressing thing under it that needs the person and that its own status does not show, every count on its card. ?tile=before draws the shipped tile, for the owner to compare.
// A thread in the sidebar as one tile of two rows: the project and the
// computer it runs on with the thread's status at the right, then the agent's
// mark and the title, with an open pull request's icon and the crab at the
// row's end. Everything else, the branch, the model, the pull request's number
// and what holds the thread, is on the card that opens to the tile's right when
// the pointer rests on it, as T3 Code's sidebar. Every tile the sidebar draws
// takes this shape: a thread, a workspace that holds no thread yet, a send in
// flight and a workspace being made. A resting title takes the muted ink, so the
// tiles a person is waiting on stand out. Renaming turns the title into the
// sidebar's one name box in the same row, so the tile keeps its height.
import type { ComponentProps, DragEvent, MouseEvent, ReactNode } from "react";
import { AlarmClockIcon, ArchiveIcon, ChevronDownIcon, ChevronRightIcon, FileDiffIcon, FolderIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { capRunningLine, type PlaceView, type ThreadCapWait } from "@wsp/protocol";
import { THREAD_WORDS, WORKSPACE_WORDS } from "../../src/actions/format.js";
import type { Launch, SidebarThreadSnapshot } from "../../src/adapt/index.js";
import { HarnessMark } from "../../src/components/chat/HarnessMark.js";
import { Crab } from "../../src/components/status/Crab.js";
import type { ThreadStatusInput } from "../../src/components/status/kinds/index.js";
import { ThreadStatus } from "../../src/components/status/ThreadStatus.js";
import { threadStatusOf } from "../../src/components/status/threadStatusOf.js";
import { FAILED } from "../../src/components/status/kinds/failed.js";
import { RESTING } from "../../src/components/status/kinds/resting.js";
import { STARTING } from "../../src/components/status/kinds/starting.js";
import { SidebarMenuButton } from "../../src/components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/components/ui/tooltip.js";
import { ProjectGlyph } from "../../src/projects/look.js";
import { ComputerGlyph } from "../../src/settings/ComputerGlyph.js";
import { cn } from "../../src/lib/utils.js";
import { RowNameInput } from "../../src/sidebar/RowNameInput.js";
import { tileCardLines, tilePrIcon, type TileCardLine } from "../../src/sidebar/tileCard.js";
import type { TileCheckout } from "../../src/sidebar/tileCheckout.js";
import { CAP_WAIT_WORDS, SNOOZE_WORDS } from "../../src/sidebar/words.js";
import { LINK_DOWN_WORDS } from "../../src/adapt/terminal-pane.js";
import { ONE_LINE_ROW_CLASS, TILE_CLASS, TILE_ROW_ONE_CLASS, TILE_ROW_TWO_CLASS, TILE_TITLE_CLASS, threadRowId } from "../../src/sidebar/rowGrammar.js";
import { useStore } from "../../src/protocol/store.js";
import { StatusIcon, StatusLine, isSubagent, kindOf, partOf, rollupMark, rollupWords, subtreeKeys, toggleFolded, foldedKey, useLeadUi, useSubtree } from "./LeadThreads";

const BEFORE = new URLSearchParams(window.location.search).get("tile") === "before";
const TILE_WORDS = { settle: "Settle thread", fold: "Fold its threads", unfold: "Show its threads" } as const;

/** Where a tile's thread runs, as row one names it: the project and the computer by the names a person reads, either
 * empty while it is not known yet. */
export interface TilePlace {
  readonly projectId: string;
  readonly project: string;
  readonly computer: string;
  /** The computer's own record, which its icon is read off; undefined until the places list holds it. */
  readonly at?: PlaceView | undefined;
}

const whereWords = (place: TilePlace): string => [place.project, place.computer].filter(word => word !== "").join(" @ ");

/** How long the pointer rests on a tile before its card opens, so a pass of the pointer down the list opens none. */
const CARD_DELAY_MS = 450;

const CARD_GLYPHS: Partial<Record<TileCardLine["kind"], typeof FolderIcon>> = { folder: FolderIcon, branch: GitBranchIcon, pr: GitPullRequestIcon, changed: FileDiffIcon };

/** The card a tile opens to its right: the full title, then one line per fact with its glyph, then what holds it. */
function TileCard({ card, place, harness, status }: { card: ReturnType<typeof tileCardLines>; place: TilePlace; harness: string | null; status?: ReactNode }) {
  return (
    <TooltipPopup side="right" align="start" sideOffset={6} data-tile-card className="max-w-72 text-left whitespace-normal">
      <div className="flex min-w-0 flex-col gap-1.5 py-1">
        <p data-tile-card-title className="font-medium text-foreground">
          {card.title}
        </p>
        <ul className="flex min-w-0 flex-col gap-1 text-muted-foreground">
          {status}
          {card.lines.map(line => {
            const Glyph = CARD_GLYPHS[line.kind];
            const glyph =
              line.kind === "project" ? (
                <ProjectGlyph projectId={place.projectId} className="size-3" />
              ) : line.kind === "computer" ? (
                place.at === undefined ? null : <ComputerGlyph place={place.at} className="size-3" />
              ) : line.kind === "agent" && harness !== null ? <HarnessMark harness={harness} label={agentName(harness)} className="size-3" /> : Glyph !== undefined ? <Glyph aria-hidden className="size-3" /> : null;
            return (
              <li key={`${line.kind}:${line.text}`} data-tile-card-line={line.kind} className="flex min-w-0 items-start gap-2">
                {glyph === null ? null : <span className="mt-[3px] flex shrink-0">{glyph}</span>}
                <span className="min-w-0 break-words">{line.text}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </TooltipPopup>
  );
}

/** The tile's button and, once the pointer rests on it, its card. A tile being renamed opens no card. */
function TileFrame({ card, place, harness, renaming, status, children, ...button }: ComponentProps<typeof SidebarMenuButton> & { card: ReturnType<typeof tileCardLines>; place: TilePlace; harness: string | null; renaming: boolean; status?: ReactNode }) {
  const frame = <SidebarMenuButton size="sm" {...button} />;
  if (renaming) return <SidebarMenuButton size="sm" {...button}>{children}</SidebarMenuButton>;
  return (
    <Tooltip>
      <TooltipTrigger delay={CARD_DELAY_MS} render={frame} data-slot="sidebar-menu-button">
        {children}
      </TooltipTrigger>
      <TileCard card={card} place={place} harness={harness} status={status} />
    </Tooltip>
  );
}

/** The two rows every tile draws. Row two is the agent's mark and the title, then an open pull request's icon and
 * the crab while the thread works. */
function TileRows({ place, status, title, harness, pr, crab, mark, lead }: { place: TilePlace; status: ReactNode; title: ReactNode; harness: string | null; pr?: TileCheckout["pr"]; crab: boolean; mark?: ReactNode; lead?: ReactNode }) {
  return (
    <>
      <span className={TILE_ROW_ONE_CLASS}>
        {lead ?? <ProjectGlyph projectId={place.projectId} className="size-3" />}
        <span data-tile-where className="min-w-0 flex-1 truncate">
          {whereWords(place)}
        </span>
        {status}
      </span>
      <span className={TILE_ROW_TWO_CLASS}>
        {mark ?? (harness === null ? null : <HarnessMark harness={harness} label={agentName(harness)} className="size-3" />)}
        {title}
        {tilePrIcon(pr) ? <GitPullRequestIcon aria-hidden data-tile-pr className="size-3 shrink-0 text-[var(--top-row-meta)]" /> : null}
        {crab ? <Crab className="shrink-0 text-status-working" /> : null}
      </span>
    </>
  );
}

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
    className={cn(TILE_TITLE_CLASS, "flex-1", idle ? "text-sidebar-muted-foreground" : "text-sidebar-foreground", active && "font-medium")}
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

const NameBox = ({ name, label, saving, onRename, onCancel }: { name: string; label: string; saving: boolean; onRename: (name: string) => void; onCancel: () => void }) => (
  <span className="flex h-[18px] min-w-0 flex-1">
    <RowNameInput name={name} label={label} saving={saving} onRename={onRename} onCancel={onCancel} />
  </span>
);

const NO_CHECKOUT: TileCheckout = { branch: "", counts: [] };

/** A held thread's reason and the setting that ends its wait, the card's lines while its computer holds it back. */
const capNotes = (capped: ThreadCapWait | undefined): string[] => (capped === undefined ? [] : [capRunningLine(capped), CAP_WAIT_WORDS.raise(capped.place)]);

export function ThreadTile({
  thread,
  place,
  checkout = NO_CHECKOUT,
  model = null,
  time,
  depth,
  active,
  settled = false,
  snoozedWorking,
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
  /** What the host read of the thread's workspace: the card's branch, pull request and changes, and the icon. */
  checkout?: TileCheckout | undefined;
  /** The thread's model by its catalog label, for the card. */
  model?: string | null | undefined;
  /** How long ago a resting thread last moved, as the sidebar words it. */
  time: string;
  /** How many tiles of the tree stand over this one. */
  depth: number;
  active: boolean;
  /** The tile sits in the Settled fold: one slim row of its title and its age, resting whatever its state, as T3
   * Code's settled rows. */
  settled?: boolean;
  /** The tile stands for a snoozed tree while threads of it run: how many, said quietly in place of the status. */
  snoozedWorking?: number | undefined;
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
  const kind = kindOf(thread, settled || snoozed);
  const under = useSubtree(thread.threadId ?? thread.id);
  const folded = useLeadUi(s => s.open[foldedKey(thread.id)] ?? false);
  const folds = !BEFORE && !settled && under.drawn;
  // Settle stands on hover where it can run: nothing in the thread or under it is live, and it is a thread, not a
  // subagent, which folds with its lead's turn. A working or asking thread offers nothing there: Stop is one slip
  // from a lost turn, and it stays in the menu and the composer.
  const quiet = !isSubagent(thread) && thread.status !== "running" && thread.asking === null && under.counts.needsYou + under.counts.failed + under.counts.working + under.counts.waiting === 0;
  const settleKeys = (): string[] => [thread.id, ...under.nodes.flatMap(node => subtreeKeys(node, under.tree))];
  const part = partOf({ thread, kids: under.nodes }, under.tree);
  const settleHere = !BEFORE && !snoozed && quiet && (settled ? part === "finished" : part !== "settled");
  const settleButton = settleHere ? (
    <span
      role="button"
      tabIndex={-1}
      data-tile-settle
      aria-label={TILE_WORDS.settle}
      title={TILE_WORDS.settle}
      className="invisible absolute top-1/2 right-[-4px] flex size-5 -translate-y-1/2 items-center justify-center rounded-[6px] text-sidebar-muted-foreground transition-colors duration-150 hover:bg-sidebar-row-selected hover:text-sidebar-foreground group-hover/tile:visible"
      onClick={event => {
        event.stopPropagation();
        void useStore.getState().settleThreads(settleKeys());
      }}
    >
      <ArchiveIcon aria-hidden className="size-3.5" />
    </span>
  ) : null;
  // A working or read row recedes unless it is the one open, as T3 Code's shouldRecede; a row that calls for the
  // person keeps the foreground ink, and the label keeps its hue either way.
  const recede = !active && (status === RESTING || status.id === "working" || status.id === "resuming");
  const card = tileCardLines({
    title: thread.title,
    place,
    folder: checkout.folder, branch: checkout.branch,
    harness: thread.harness,
    model,
    pr: checkout.pr,
    changed: checkout.changed,
    notes: [snoozed ? SNOOZE_WORDS.workingHover(snoozedWorking) : thread.asking, ...capNotes(thread.capped), thread.setupRefusal ?? null, ...checkout.counts, checkout.why ?? null],
  });
  // An agent the host refuses to start there says so in the slot, over a resting or failed thread's own status.
  const setupRefused = thread.setupRefusal !== undefined && (status === RESTING || status.id === FAILED.id) ? thread.setupRefusal : undefined;
  const frame = {
    card,
    place,
    harness: thread.harness,
    renaming,
    ...(BEFORE || settled
      ? {}
      : {
          status: (
            <>
              <StatusLine thread={thread} kind={kind} />
              {folded && rollupWords(under.counts) !== "" ? (
                <li data-tile-card-line="under" className="min-w-0 break-words">
                  {rollupWords(under.counts)}
                </li>
              ) : null}
            </>
          ),
        }),
    // An input may not sit inside a button, so a tile being renamed is a plain box with the same grammar.
    render: renaming ? <div /> : <button type="button" />,
    isActive: active,
    "data-sidebar-row": true,
    "data-row-id": threadRowId(thread.id),
    "data-depth": depth,
    ...(renaming ? {} : { onClick: onSelect, onContextMenu }),
  };
  const titleOrBox = renaming ? <NameBox name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} /> : null;
  if (settled)
    return (
      <TileFrame {...frame} data-slim="true" className={cn(ONE_LINE_ROW_CLASS, "group/tile", !BEFORE && "gap-1.5")}>
        <ProjectGlyph projectId={place.projectId} className={cn("size-3 shrink-0", !active && "opacity-40 grayscale")} />
        {titleOrBox ?? (
          <span className="flex min-w-0 flex-1">
            <Title text={label ?? thread.title} idle active={active} onDoubleClick={onRenameOpen} />
          </span>
        )}
        <span className="relative flex shrink-0 items-center text-xs text-sidebar-muted-foreground">
          <span className={cn("flex", settleHere && "group-hover/tile:invisible")}>
            {!BEFORE && part === "finished" ? <StatusIcon thread={thread} kind={kindOf(thread, false, true)} tip={false} /> : <ThreadStatus thread={thread} age={time} settled />}
          </span>
          {settleButton}
        </span>
      </TileFrame>
    );
  return (
    <TileFrame {...frame} className={cn(TILE_CLASS, "group/tile")} {...(renaming || onDragStart === undefined ? {} : { draggable: true, onDragStart, onDragEnd })}>
      <TileRows
        place={place}
        {...(folds
          ? {
              mark: (
                <span className="relative flex size-3 shrink-0 items-center justify-center">
                  <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className={cn("size-3", folded ? "invisible" : "group-hover/tile:invisible")} />
                  <span
                    role="button"
                    tabIndex={-1}
                    data-tile-fold
                    aria-expanded={!folded}
                    aria-label={folded ? TILE_WORDS.unfold : TILE_WORDS.fold}
                    className={cn("absolute inset-0 flex items-center justify-center text-sidebar-muted-foreground hover:text-sidebar-foreground", !folded && "invisible group-hover/tile:visible")}
                    onClick={event => {
                      event.stopPropagation();
                      toggleFolded(thread.id);
                    }}
                  >
                    {folded ? <ChevronRightIcon aria-hidden className="size-3.5" /> : <ChevronDownIcon aria-hidden className="size-3.5" />}
                  </span>
                </span>
              ),
            }
          : {})}
        status={
          BEFORE ? (
            <ThreadStatus thread={thread} age={time} settled={settled} />
          ) : (
            <span className="relative flex shrink-0 items-center gap-2">
              <span className={cn("flex items-center", settleHere && "group-hover/tile:invisible")}>
                {snoozed ? <SnoozedWorking count={snoozedWorking} /> : setupRefused !== undefined ? <span data-thread-status="setup-refused" title={setupRefused}>{LINK_DOWN_WORDS.refused}</span> : <StatusIcon thread={thread} kind={kind} tip={false} />}
              </span>
              {settleButton}
            </span>
          )
        }
        title={titleOrBox ?? <Title text={label ?? thread.title} idle={recede} active={active} onDoubleClick={onRenameOpen} />}
        harness={thread.harness}
        pr={checkout.pr}
        crab={BEFORE && status.crab === true}
        {...(folds && folded ? { lead: rollupMark(under.counts, kind.id) } : {})}
      />
    </TileFrame>
  );
}

/** A workspace that holds no thread yet, as a tile: its name for the title, no status and no agent, and its menu the
 * workspace's own verbs. Renaming it turns the name into the one name box, as a thread's title does. */
export function WorkspaceTile({
  rowId,
  name,
  place,
  checkout = NO_CHECKOUT,
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
  checkout?: TileCheckout | undefined;
  depth: number;
  active: boolean;
  renaming: boolean;
  saving: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
}) {
  const card = tileCardLines({ title: name, place, folder: checkout.folder, branch: checkout.branch, harness: null, model: null, pr: checkout.pr, changed: checkout.changed, notes: [...checkout.counts, checkout.why ?? null] });
  return (
    <TileFrame
      card={card}
      place={place}
      harness={null}
      renaming={renaming}
      render={renaming ? <div /> : <button type="button" />}
      isActive={active}
      data-sidebar-row
      data-row-id={rowId}
      data-depth={depth}
      className={TILE_CLASS}
      {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
    >
      <TileRows
        place={place}
        status={null}
        title={renaming ? <NameBox name={name} label={WORKSPACE_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} /> : <Title text={name} idle active={active} />}
        harness={null}
        pr={checkout.pr}
        crab={false}
      />
    </TileFrame>
  );
}

/** A send in flight is working by the fact of having been sent, read through the same status as the runtime's own
 * rows, so the two tiles cannot say different things about the same thread. */
const LAUNCHED: ThreadStatusInput = { status: "running", asking: null, startedAt: null, unread: false };

/** The send the runtime has written no row for yet, in the tile's own grammar. Not a button: the thread it stands
 * for has no id to select until the runtime answers, and the transcript the person is looking at is already it. */
export function ThreadLaunchTile({ launch, place, checkout }: { launch: Launch; place: TilePlace; checkout: TileCheckout }) {
  const card = tileCardLines({ title: launch.title, place, folder: checkout.folder, branch: checkout.branch, harness: launch.harness, model: null, pr: checkout.pr, changed: checkout.changed, notes: [] });
  return (
    <TileFrame card={card} place={place} harness={launch.harness} renaming={false} render={<div />} data-thread-launch data-depth={0} className={TILE_CLASS}>
      <TileRows place={place} status={<ThreadStatus thread={LAUNCHED} />} title={<Title text={launch.title} idle={false} active={false} />} harness={launch.harness} pr={checkout.pr} crab />
    </TileFrame>
  );
}

const CREATE_FAILED: ThreadStatusInput = { status: "failed", asking: null, startedAt: null, unread: false };
const CREATE_RUNNING: ThreadStatusInput = { status: "running", asking: null, startedAt: null, unread: false };

/** A workspace still being made, in the tile's grammar: where it will run with Starting in the slot, its name with the
 * crab at its end, and the step the create is waiting on on its card. A refused create says Failed instead. */
export function CreationTile({ rowId, name, place, line, failed, active, onSelect, onContextMenu }: { rowId: string; name: string; place: TilePlace; line: string; failed: boolean; active: boolean; onSelect: () => void; onContextMenu?: (event: MouseEvent<HTMLElement>) => void }) {
  const card = tileCardLines({ title: name, place, branch: "", harness: null, model: null, notes: [line] });
  return (
    <TileFrame
      card={card}
      place={place}
      harness={null}
      renaming={false}
      isActive={active}
      aria-busy={failed ? undefined : "true"}
      data-sidebar-row
      data-row-id={rowId}
      data-depth={0}
      data-creation-line={line}
      className={TILE_CLASS}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <TileRows
        place={place}
        status={failed ? <ThreadStatus thread={CREATE_FAILED} /> : <ThreadStatus thread={CREATE_RUNNING} kind={STARTING} />}
        title={<Title text={name} idle={false} active={active} />}
        harness={null}
        crab={!failed}
      />
    </TileFrame>
  );
}
