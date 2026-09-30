// SPDX-License-Identifier: AGPL-3.0-only
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
import { AlarmClockIcon, FileDiffIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import type { PlaceView } from "@wsp/protocol";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { ProjectGlyph } from "../projects/look.js";
import { ComputerGlyph } from "../settings/ComputerGlyph.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { tileCardLines, tilePrIcon, type TileCardLine } from "./tileCard.js";
import type { TileCheckout } from "./tileCheckout.js";
import { SNOOZE_WORDS } from "./words.js";
import type { LinkDown } from "../terminal/paneWords.js";
import { ONE_LINE_ROW_CLASS, TILE_CLASS, TILE_ROW_ONE_CLASS, TILE_ROW_TWO_CLASS, TILE_TITLE_CLASS, threadRowId } from "./rowGrammar.js";

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

const CARD_GLYPHS: Partial<Record<TileCardLine["kind"], typeof GitBranchIcon>> = { branch: GitBranchIcon, pr: GitPullRequestIcon, changed: FileDiffIcon };

/** The card a tile opens to its right: the full title, then one line per fact with its glyph, then what holds it. */
function TileCard({ card, place, harness }: { card: ReturnType<typeof tileCardLines>; place: TilePlace; harness: string | null }) {
  return (
    <TooltipPopup side="right" align="start" sideOffset={6} data-tile-card className="max-w-72 text-left whitespace-normal">
      <div className="flex min-w-0 flex-col gap-1.5 py-1">
        <p data-tile-card-title className="font-medium text-foreground">
          {card.title}
        </p>
        <ul className="flex min-w-0 flex-col gap-1 text-muted-foreground">
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
function TileFrame({ card, place, harness, renaming, children, ...button }: ComponentProps<typeof SidebarMenuButton> & { card: ReturnType<typeof tileCardLines>; place: TilePlace; harness: string | null; renaming: boolean }) {
  const frame = <SidebarMenuButton size="sm" {...button} />;
  if (renaming) return <SidebarMenuButton size="sm" {...button}>{children}</SidebarMenuButton>;
  return (
    <Tooltip>
      <TooltipTrigger delay={CARD_DELAY_MS} render={frame} data-slot="sidebar-menu-button">
        {children}
      </TooltipTrigger>
      <TileCard card={card} place={place} harness={harness} />
    </Tooltip>
  );
}

/** The two rows every tile draws. Row two is the agent's mark and the title, then an open pull request's icon and
 * the crab while the thread works. */
function TileRows({ place, status, title, harness, pr, crab }: { place: TilePlace; status: ReactNode; title: ReactNode; harness: string | null; pr?: TileCheckout["pr"]; crab: boolean }) {
  return (
    <>
      <span className={TILE_ROW_ONE_CLASS}>
        <ProjectGlyph projectId={place.projectId} className="size-3" />
        <span data-tile-where className="min-w-0 flex-1 truncate">
          {whereWords(place)}
        </span>
        {status}
      </span>
      <span className={TILE_ROW_TWO_CLASS}>
        {harness === null ? null : <HarnessMark harness={harness} label={agentName(harness)} className="size-3" />}
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
  // A working or read row recedes unless it is the one open, as T3 Code's shouldRecede; a row that calls for the
  // person keeps the foreground ink, and the label keeps its hue either way.
  const recede = !active && (status === RESTING || status.id === "working");
  const card = tileCardLines({
    title: thread.title,
    place,
    branch: checkout.branch,
    harness: thread.harness,
    model,
    pr: checkout.pr,
    changed: checkout.changed,
    notes: [snoozed ? SNOOZE_WORDS.workingHover(snoozedWorking) : thread.asking, ...checkout.counts, checkout.why ?? null],
  });
  const frame = {
    card,
    place,
    harness: thread.harness,
    renaming,
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
      <TileFrame {...frame} data-slim="true" className={ONE_LINE_ROW_CLASS}>
        <ProjectGlyph projectId={place.projectId} className={cn("size-3 shrink-0", !active && "opacity-40 grayscale")} />
        {titleOrBox ?? (
          <span className="flex min-w-0 flex-1">
            <Title text={label ?? thread.title} idle active={active} onDoubleClick={onRenameOpen} />
          </span>
        )}
        <span className="shrink-0 text-xs text-sidebar-muted-foreground">
          <ThreadStatus thread={thread} age={time} settled />
        </span>
      </TileFrame>
    );
  return (
    <TileFrame {...frame} className={TILE_CLASS} {...(renaming || onDragStart === undefined ? {} : { draggable: true, onDragStart, onDragEnd })}>
      <TileRows
        place={place}
        status={
          snoozed ? (
            <SnoozedWorking count={snoozedWorking} />
          ) : status === RESTING && linkDown !== undefined ? (
            <span data-thread-status="link-down" title={linkDown.sentence} className="inline-flex shrink-0 items-center whitespace-nowrap">
              {linkDown.word}
            </span>
          ) : (
            <ThreadStatus thread={thread} age={time} settled={settled} />
          )
        }
        title={titleOrBox ?? <Title text={label ?? thread.title} idle={recede} active={active} onDoubleClick={onRenameOpen} />}
        harness={thread.harness}
        pr={checkout.pr}
        crab={status.crab === true}
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
  const card = tileCardLines({ title: name, place, branch: checkout.branch, harness: null, model: null, pr: checkout.pr, changed: checkout.changed, notes: [...checkout.counts, checkout.why ?? null] });
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
  const card = tileCardLines({ title: launch.title, place, branch: checkout.branch, harness: launch.harness, model: null, pr: checkout.pr, changed: checkout.changed, notes: [] });
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
