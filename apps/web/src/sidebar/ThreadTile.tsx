// SPDX-License-Identifier: AGPL-3.0-only
// A thread in the sidebar as one tile of two rows: the project and the
// computer it runs on with the thread's status at the right, the crab there
// while it works, then the agent's mark and the title, with an open pull
// request's icon at the row's end. Everything else, the branch, the model, the
// pull request's number and what holds the thread, is on the card that opens to
// the tile's right when the pointer rests on it, as T3 Code's sidebar. Every tile the sidebar draws
// takes this shape: a thread, a workspace that holds no thread yet, a send in
// flight and a workspace being made. A resting title takes the muted ink, so the
// tiles a person is waiting on stand out. Renaming turns the title into the
// sidebar's one name box in the same row, so the tile keeps its height.
// A quiet tile offers Settle beside its button on hover; a tile with a tree
// under it folds it by the control at row two's end; a tile in the Needs you
// inbox under a tree names the thread that started it in row one.
import { memo, useLayoutEffect, useRef, type ComponentProps, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { AlarmClockIcon, ArchiveIcon, ChevronDownIcon, ChevronRightIcon, CornerDownRightIcon, FileDiffIcon, FolderIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import type { PlaceView, ThreadCapWait } from "@wsp/protocol";
import { THREAD_WORDS, WORKSPACE_WORDS } from "../actions/format.js";
import type { Launch, SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import type { StatusKind, ThreadStatusInput } from "../components/status/kinds/index.js";
import { StatusLine } from "../components/status/StatusLine.js";
import { noteOf } from "../components/threads/leadTree.js";
import { ThreadStatus } from "../components/status/ThreadStatus.js";
import { threadStatusOf } from "../components/status/threadStatusOf.js";
import { FAILED } from "../components/status/kinds/failed.js";
import { RESTING } from "../components/status/kinds/resting.js";
import { STARTING } from "../components/status/kinds/starting.js";
import { SidebarMenuAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { ProjectGlyph } from "../projects/look.js";
import { ComputerGlyph } from "../settings/ComputerGlyph.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { tileCardLines, tilePrIcon, type TileCardLine } from "./tileCard.js";
import type { TileCheckout } from "./tileCheckout.js";
import { CAP_WAIT_WORDS, SNOOZE_WORDS, TREE_WORDS } from "./words.js";
import type { InboxMark } from "./threadTree.js";
import { LINK_DOWN_WORDS } from "../adapt/terminal-pane.js";
import { GLYPH_ROW_CLASS, HOVER_GLYPH_CLASS, ONE_LINE_ROW_CLASS, ROW_META_CLASS, SLOT_ACT_CLASS, SLOT_YIELDS_CLASS, TILE_CLASS, TILE_ROW_ONE_CLASS, TILE_ROW_TWO_CLASS, TILE_TITLE_CLASS, threadRowId } from "./rowGrammar.js";

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

const CARD_GLYPHS: Partial<Record<TileCardLine["kind"], typeof FolderIcon>> = { "started-by": CornerDownRightIcon, folder: FolderIcon, branch: GitBranchIcon, pr: GitPullRequestIcon, changed: FileDiffIcon };

/** The card a tile opens to its right: the full title, its status row, then one line per fact with its glyph, then
 * what holds it. */
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

/** The two rows every tile draws. Row one is the project's glyph and where the thread runs, or in the inbox the thread
 * that started it, then the status. Row two is the agent's mark and the title, then an open pull request's icon and
 * the fold's control. */
function TileRows({ place, status, title, harness, pr, startedBy, end }: { place: TilePlace; status: ReactNode; title: ReactNode; harness: string | null; pr?: TileCheckout["pr"]; startedBy?: string | undefined; end?: ReactNode }) {
  return (
    <>
      <span className={TILE_ROW_ONE_CLASS}>
        {startedBy === undefined ? (
          <ProjectGlyph projectId={place.projectId} className="size-3" />
        ) : (
          // The glyph keeps a top-level tile's slot, so row one's words do not move.
          <span data-tile-started-by className="relative flex size-3 shrink-0">
            <ProjectGlyph projectId={place.projectId} className={STARTED_BY_GLYPH_CLASS} />
            <CornerDownRightIcon aria-hidden strokeWidth={3} className={STARTED_BY_MARK_CLASS} />
          </span>
        )}
        <span data-tile-where className="min-w-0 flex-1 truncate">
          {startedBy ?? whereWords(place)}
        </span>
        {status}
      </span>
      <span className={TILE_ROW_TWO_CLASS}>
        {harness === null ? null : <HarnessMark harness={harness} label={agentName(harness)} className="size-3" />}
        {title}
        {tilePrIcon(pr) ? <GitPullRequestIcon aria-hidden data-tile-pr className="size-3 shrink-0 text-[var(--top-row-meta)]" /> : null}
        {end}
      </span>
    </>
  );
}

/** A sub-thread's glyph in the inbox gives up its top right corner to the "↳" over it: drawn on the glyph's own strokes,
 * the mark cannot be seen at 12 px. */
const STARTED_BY_GLYPH_CLASS = "size-3 [mask-image:linear-gradient(to_bottom,transparent_4px,black_4px),linear-gradient(to_right,black_6px,transparent_6px)]";
/** The "↳" as a superscript on that corner, its line thickened to a css pixel at 8 px. */
const STARTED_BY_MARK_CLASS = "absolute -top-1.25 -right-0.5 size-2 text-sidebar-muted-foreground";

/** The fold's control at row two's end: shut, how many rows the tile would draw under it and the chevron, muted; open,
 * the chevron alone on hover, its room kept so the title never moves. The tile's button says which with
 * aria-expanded, and the arrow keys fold it too, so the control is the pointer's alone. */
function FoldControl({ fold, onFold }: { fold: Fold; onFold: (() => void) | undefined }) {
  const shut = fold !== "open";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-hidden
            data-tile-fold={shut ? "shut" : "open"}
            className={cn("flex shrink-0 items-center gap-1 text-sidebar-muted-foreground transition-opacity duration-150 hover:text-sidebar-foreground", !shut && "opacity-0 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100")}
            onClick={event => {
              event.stopPropagation();
              onFold?.();
            }}
          />
        }
      >
        {shut ? <span className={ROW_META_CLASS}>{fold}</span> : null}
        {shut ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{shut ? TREE_WORDS.unfold : TREE_WORDS.fold}</TooltipPopup>
    </Tooltip>
  );
}

/** A tile's tree: open, or folded with how many rows it would draw. */
type Fold = "open" | number;

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

/** The setting that ends a held thread's wait, the card's line under the status row's reason. */
const capNotes = (capped: ThreadCapWait | undefined): string[] => (capped === undefined ? [] : [CAP_WAIT_WORDS.raise(capped.place)]);

/** What a tile is drawn from. */
type ThreadTileProps = {
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
  /** The tile stands in the Needs you inbox: where its thread hangs, which row one and the card name. */
  inboxOf?: InboxMark | undefined;
  /** The titles from its tree's top down to the thread that opened it, which the card names: set on a tile past the
   * second level, which stands at its opener's x. */
  openers?: ReadonlyArray<string> | undefined;
  /** The tile is a slim row in a Finished fold, ending in this status. */
  finished?: StatusKind | undefined;
  /** The tree under the tile, open or folded with how many rows it would draw; absent where nothing is drawn under it. */
  fold?: Fold | undefined;
  /** Settles the tile's tree, where the thread and everything under it is quiet: drawn beside the tile on hover. */
  onSettle?: (() => void) | undefined;
  /** Folds or opens the tree under the tile. */
  onFold?: (() => void) | undefined;
};

/** What a tile does when it is pressed, opened, renamed or dragged. */
export type TileHandlers = Pick<ThreadTileProps, "onSelect" | "onContextMenu" | "onRename" | "onRenameCancel" | "onRenameOpen" | "onDragStart" | "onDragEnd" | "onSettle" | "onFold">;

/** Handlers for the tiles a draw makes: each is the same function from draw to draw and calls what the latest
 * committed draw passed for its row, so a tile's memo compares them by identity and a tile it skips still acts on the
 * sidebar's latest state, where a menu built before a child finished would offer a stale Settle. An optional handler
 * is passed only while the draw has one, so a rename refused or allowed draws the tile again. */
export function useTileHandlers(): (rowId: string, handlers: TileHandlers) => TileHandlers {
  const committed = useRef(new Map<string, TileHandlers>());
  const fixed = useRef(new Map<string, Required<TileHandlers>>());
  const drawn = new Map<string, TileHandlers>();
  useLayoutEffect(() => {
    committed.current = drawn;
  });
  return (rowId, handlers) => {
    drawn.set(rowId, handlers);
    let row = fixed.current.get(rowId);
    if (row === undefined) {
      const at = (): TileHandlers => committed.current.get(rowId)!;
      row = {
        onSelect: () => at().onSelect(),
        onContextMenu: event => at().onContextMenu(event),
        onRename: title => at().onRename(title),
        onRenameCancel: () => at().onRenameCancel(),
        onRenameOpen: () => at().onRenameOpen?.(),
        onDragStart: event => at().onDragStart?.(event),
        onDragEnd: () => at().onDragEnd?.(),
        onSettle: () => at().onSettle?.(),
        onFold: () => at().onFold?.(),
      };
      fixed.current.set(rowId, row);
    }
    return {
      onSelect: row.onSelect,
      onContextMenu: row.onContextMenu,
      onRename: row.onRename,
      onRenameCancel: row.onRenameCancel,
      ...(handlers.onRenameOpen === undefined ? {} : { onRenameOpen: row.onRenameOpen }),
      ...(handlers.onDragStart === undefined ? {} : { onDragStart: row.onDragStart }),
      ...(handlers.onDragEnd === undefined ? {} : { onDragEnd: row.onDragEnd }),
      ...(handlers.onSettle === undefined ? {} : { onSettle: row.onSettle }),
      ...(handlers.onFold === undefined ? {} : { onFold: row.onFold }),
    };
  };
}

/** Whether two values are the same data: plain objects and arrays by their entries, anything else by identity. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** A tile, drawn again only when what it is given changes; the sidebar passes its handlers through `useTileHandlers`. */
export const ThreadTile = memo(function ThreadTile(props: ThreadTileProps) {
  const { thread, place, checkout = NO_CHECKOUT, model = null, time, depth, active, settled = false, snoozedWorking, renaming, saving, onSelect, onContextMenu, onRename, onRenameCancel, onRenameOpen, onDragStart, onDragEnd, label, inboxOf, openers, finished, fold, onSettle, onFold } = props;
  const snoozed = snoozedWorking !== undefined;
  const slim = settled || finished !== undefined;
  const status = settled || snoozed ? RESTING : threadStatusOf(thread);
  // A working or read row recedes unless it is the one open, as T3 Code's shouldRecede; a row that calls for the
  // person keeps the foreground ink, and the label keeps its hue either way.
  const recede = !active && (status === RESTING || status.id === "working" || status.id === "resuming" || status.id === "stopped");
  const startedBy = inboxOf === undefined || inboxOf.parent === null ? undefined : inboxOf.parent;
  const path = startedBy === undefined ? openers : inboxOf!.path;
  const card = tileCardLines({
    title: thread.title,
    place,
    ...(path === undefined ? {} : { startedBy: TREE_WORDS.startedBy(path) }),
    folder: checkout.folder, branch: checkout.branch,
    harness: thread.harness,
    model,
    pr: checkout.pr,
    changed: checkout.changed,
    notes: [snoozed ? SNOOZE_WORDS.workingHover(snoozedWorking) : null, ...capNotes(thread.capped), thread.setupRefusal ?? null, ...checkout.counts, checkout.why ?? null],
  });
  // The card leads with the status row, the reason whole under its word; a settled tile's card has none.
  const reason = noteOf({ node: null, thread }, finished !== undefined ? "finished" : "live");
  const statusRow = settled || snoozed ? undefined : <StatusLine thread={thread} {...(finished !== undefined ? { kind: finished } : {})} age={time} {...(reason !== undefined ? { reason } : {})} />;
  // An agent the host refuses to start there says so in the slot, over a resting or failed thread's own status.
  const setupRefused = thread.setupRefusal !== undefined && (status === RESTING || status.id === FAILED.id) ? thread.setupRefusal : undefined;
  const frame = {
    card,
    place,
    harness: thread.harness,
    renaming,
    status: statusRow,
    // An input may not sit inside a button, so a tile being renamed is a plain box with the same grammar.
    render: renaming ? <div /> : <button type="button" />,
    isActive: active,
    "data-sidebar-row": true,
    "data-row-id": inboxOf === undefined ? threadRowId(thread.id) : `inbox:${threadRowId(thread.id)}`,
    "data-depth": depth,
    ...(fold === undefined ? {} : { "aria-expanded": fold === "open" }),
    ...(renaming ? {} : { onClick: onSelect, onContextMenu }),
  };
  const titleOrBox = renaming ? <NameBox name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} /> : null;
  const settles = onSettle !== undefined && !renaming;
  // Settle stands beside the button, never in it, where the status slot is; the item says it has an act.
  const settle = settles ? (
    <Tooltip>
      <TooltipTrigger render={<SidebarMenuAction showOnHover data-tile-settle aria-label={THREAD_WORDS.settle} className={cn(HOVER_GLYPH_CLASS, SLOT_ACT_CLASS, !slim && "top-3.75")} onClick={onSettle} />}>
        <ArchiveIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{THREAD_WORDS.settleTip}</TooltipPopup>
    </Tooltip>
  ) : null;
  const item = (tile: ReactNode) => (
    <div className="group/menu-item relative min-w-0" {...(settles ? { "data-has-action": "" } : {})}>
      {tile}
      {settle}
    </div>
  );
  const slot = snoozed ? (
    <SnoozedWorking count={snoozedWorking} />
  ) : setupRefused !== undefined ? (
    <span data-thread-status="setup-refused" title={setupRefused} className="inline-flex shrink-0 items-center whitespace-nowrap">
      {LINK_DOWN_WORDS.refused}
    </span>
  ) : (
    <ThreadStatus thread={thread} age={time} settled={settled} />
  );
  if (slim)
    return item(
      <TileFrame {...frame} data-slim="true" className={cn(ONE_LINE_ROW_CLASS, GLYPH_ROW_CLASS)}>
        <ProjectGlyph projectId={place.projectId} className={cn("size-3 shrink-0", !active && "opacity-40 grayscale")} />
        {titleOrBox ?? (
          <span className="flex min-w-0 flex-1">
            <Title text={label ?? thread.title} idle active={active} onDoubleClick={onRenameOpen} />
          </span>
        )}
        <span className={cn("shrink-0 text-xs text-sidebar-muted-foreground", settles && SLOT_YIELDS_CLASS)}>
          {finished !== undefined ? <ThreadStatus thread={thread} age={time} kind={finished} /> : <ThreadStatus thread={thread} age={time} settled />}
        </span>
      </TileFrame>,
    );
  return item(
    <TileFrame {...frame} className={cn(TILE_CLASS, GLYPH_ROW_CLASS)} {...(renaming || onDragStart === undefined ? {} : { draggable: true, onDragStart, onDragEnd })}>
      <TileRows
        place={place}
        startedBy={startedBy}
        status={settles ? <span className={cn("flex shrink-0", SLOT_YIELDS_CLASS)}>{slot}</span> : slot}
        title={titleOrBox ?? <Title text={label ?? thread.title} idle={recede} active={active} onDoubleClick={onRenameOpen} />}
        harness={thread.harness}
        pr={checkout.pr}
        end={fold === undefined ? null : <FoldControl fold={fold} onFold={onFold} />}
      />
    </TileFrame>,
  );
}, sameData);

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
      <TileRows place={place} status={<ThreadStatus thread={LAUNCHED} />} title={<Title text={launch.title} idle={false} active={false} />} harness={launch.harness} pr={checkout.pr} />
    </TileFrame>
  );
}

const CREATE_FAILED: ThreadStatusInput = { status: "failed", asking: null, startedAt: null, unread: false };
const CREATE_RUNNING: ThreadStatusInput = { status: "running", asking: null, startedAt: null, unread: false };

/** A workspace still being made, in the tile's grammar: where it will run with Starting's crab in the slot, its name,
 * and the step the create is waiting on on its card. A refused create says Failed instead. */
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
      />
    </TileFrame>
  );
}
