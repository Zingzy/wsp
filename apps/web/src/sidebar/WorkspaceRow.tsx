// SPDX-License-Identifier: AGPL-3.0-only
// One machine's row, three lines at every width, one fixed slot each so every
// row has the same shape and height. Line one: the kind's glyph in the lead,
// the name, and at the right edge a slot as wide as two glyphs holding the
// state's word in muted mono while the state is not running, empty while it
// is; the glyph is the one thing in the row whose hue says the state: the
// app's success green while the machine runs, muted otherwise and dimmed while
// paused, by the rule in workspaceRows.ts, in a box that never moves. Line
// two: what the machine is, its size in the kind's words. Line three: what it cost
// today, free for a computer wsp does not pay for; the one sentence a person may
// be waiting on takes that line while it lasts, cut at the row's own cap with
// the whole of it on the row's hover text. The row's actions, the collapse
// chevron and new thread on a live row, forget and rebuild on a dead one, show
// on hover in the state slot, where the word yields to them so nothing moves,
// and in the row's menu; the resting row carries none. Renaming turns the name
// into the sidebar's one name box in the same slot, opened from the menu or by
// a double-click on the name, so the row keeps its height and its grammar. The
// words come from workspaceRows.ts and the actions from the workspace registry.
// While a folder is dragged over the window the row is a dotted drop tile
// instead, the same height, saying what a drop on it does in the row's muted
// mono; the sidebar hands it the words and takes the drop.
import { ChevronDownIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState, type DragEvent } from "react";
import { needsRebuild, workspaceKind, type MemoryReading } from "@wsp/protocol";
import { runAction } from "../actions/contextMenu.js";
import { WORKSPACE_WORDS } from "../actions/format.js";
import { actionById, rowLabelOf, type ResolvedAction } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { SidebarMenuAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { workspaceKindGlyph } from "../workspaceKindGlyph.js";
import { RowNameInput } from "./RowNameInput.js";
import { ROW_LEAD_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, THREE_LINE_ROW_CLASS, rowLineCut, workspaceRowId } from "./rowGrammar.js";
import { NEW_THREAD_TITLE, glyphStateClass, machineLine, metaSentences, stateSlotWord, workspaceMetaLine } from "./workspaceRows.js";

/** The glyphs sit on line one inside the state slot, the inner one and the one at the row's inset; the kit's own place is the row's middle and edge. */
const GLYPH_CLASS = "peer-data-[size=lg]/menu-button:top-1 right-2";
const INNER_GLYPH_CLASS = cn(GLYPH_CLASS, "right-7");
/** The row's text runs to the row's own inset; the glyphs land in the state slot on hover. */
const ROW_CLASS = "group-has-data-[sidebar=menu-action]/menu-item:pe-2";
const STATE_SLOT_CLASS = "min-w-11 shrink-0 text-right transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0";
/** The kind's glyph reads at the weight of the muted meta beside it until the state's own class takes the ink over. */
const LEAD_GLYPH_CLASS = "text-muted-foreground/60";

/** What a drop on this row does, in the kind's words, and the drop itself. */
export interface DropTile {
  readonly label: string;
  readonly onDrop: (transfer: DataTransfer) => void;
}

/** The row as a drop tile: the row's own height, a dashed border, the meta line's mono, nothing else; a drag
 * over it darkens the border and the words so the target reads before the drop. */
export function WorkspaceDropTile({ rowId, tile }: { rowId: string; tile: DropTile }) {
  const [over, setOver] = useState(false);
  const claim = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setOver(true);
  };
  return (
    <div
      data-sidebar-row
      data-row-id={rowId}
      data-drop-tile
      {...(over ? { "data-drop-over": "" } : {})}
      className={cn(
        THREE_LINE_ROW_CLASS,
        ROW_META_CLASS,
        "flex w-full items-center justify-center rounded-md border border-dashed border-sidebar-border text-center transition-colors",
        over && "border-sidebar-foreground/50 text-sidebar-foreground",
      )}
      onDragEnter={claim}
      onDragOver={claim}
      onDragLeave={() => setOver(false)}
      onDrop={event => {
        event.preventDefault();
        setOver(false);
        tile.onDrop(event.dataTransfer);
      }}
    >
      {tile.label}
    </div>
  );
}

export function WorkspaceRow({
  project,
  cost,
  outOfMemory,
  quiet,
  nowMs,
  actions,
  active,
  collapsed,
  rebuildAsked,
  renaming,
  saving,
  onSelect,
  onToggleCollapsed,
  onRename,
  onRenameCancel,
  onRenameOpen,
}: {
  project: SidebarProjectSnapshot;
  cost: { readonly rateUsdPerHour: number; readonly accruedUsd: number } | null;
  outOfMemory: MemoryReading | undefined;
  /** This workspace's own computer has gone quiet, so nothing here is known right now: the glyph takes no green. */
  quiet: boolean;
  nowMs: number;
  actions: ReadonlyArray<ResolvedAction>;
  active: boolean;
  collapsed: boolean;
  rebuildAsked: boolean;
  /** The name is being typed on this row: the name slot holds the box instead of the text. */
  renaming: boolean;
  /** That name is on its way to the runtime: the field stays exactly as it is and takes no second Enter. */
  saving: boolean;
  onSelect: () => void;
  onToggleCollapsed: () => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
  /** Opens the box on this row, as the menu's Rename does; absent where the rename is refused, so the name is text alone. */
  onRenameOpen?: (() => void) | undefined;
}) {
  const dead = needsRebuild({ phase: project.phase, machineState: project.machineState, reach: project.reach, wakeRefused: project.workspace.wakeRefused });
  const KindGlyph = workspaceKindGlyph(workspaceKind(project.workspace));
  const gone = project.state === "gone";
  const machine = machineLine(project) ?? "";
  const meta = workspaceMetaLine({ project, cost, outOfMemory, nowMs });
  // The same slot carries the cost most of the time and a sentence when something needs reading.
  const metaIsProse = metaSentences({ project, outOfMemory }).includes(meta);
  const forgetAction = actionById(actions, "forget");
  const rebuildAction = actionById(actions, "rebuild");
  const newThreadAction = actionById(actions, "new-thread");
  return (
    <>
      <SidebarMenuButton
        size="lg"
        // An input may not sit inside a button, so a row being renamed is a plain box with the same grammar.
        render={renaming ? <div /> : <button type="button" />}
        isActive={active}
        data-sidebar-row
        data-row-id={workspaceRowId(project.id)}
        className={cn(THREE_LINE_ROW_CLASS, ROW_CLASS)}
        {...(renaming ? {} : { onClick: onSelect })}
      >
        <span aria-hidden className={ROW_LEAD_CLASS} data-workspace-lead>
          <KindGlyph className={cn("size-3.5", LEAD_GLYPH_CLASS, glyphStateClass(project, quiet))} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
          <span className="flex items-center gap-2">
            {renaming ? (
              <RowNameInput name={project.displayName} label={WORKSPACE_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
            ) : (
              <span
                data-workspace-name
                className="min-w-0 flex-1 truncate text-sidebar-foreground"
                onDoubleClick={onRenameOpen === undefined ? undefined : event => {
                  event.stopPropagation();
                  onRenameOpen();
                }}
              >
                {project.displayName}
              </span>
            )}
            <span data-workspace-state className={cn(ROW_META_CLASS, STATE_SLOT_CLASS)}>
              {stateSlotWord(project)}
            </span>
          </span>
          <span data-workspace-machine className={cn(ROW_META_CLASS, "truncate")} title={machine}>
            {machine}
          </span>
          <span data-workspace-meta className={cn(metaIsProse ? ROW_PROSE_CLASS : ROW_META_CLASS, "truncate")} title={meta}>
            {rowLineCut(meta)}
          </span>
        </span>
      </SidebarMenuButton>
      {dead ? (
        <>
          {gone ? (
            <SidebarMenuAction
              showOnHover
              className={INNER_GLYPH_CLASS}
              aria-label={rowLabelOf(forgetAction)}
              title={forgetAction.refusal ?? forgetAction.hint ?? undefined}
              disabled={forgetAction.refusal !== null}
              onClick={() => void runAction(forgetAction)}
            >
              <Trash2Icon />
            </SidebarMenuAction>
          ) : null}
          <SidebarMenuAction
            showOnHover
            className={GLYPH_CLASS}
            aria-label={rowLabelOf(rebuildAction)}
            title={rebuildAction.refusal ?? rebuildAction.hint ?? undefined}
            disabled={rebuildAsked || rebuildAction.refusal !== null}
            onClick={() => void runAction(rebuildAction)}
          >
            <RefreshCwIcon className={cn(rebuildAsked && "animate-spin")} />
          </SidebarMenuAction>
        </>
      ) : (
        <>
          {project.threads.length > 0 ? (
            <SidebarMenuAction showOnHover className={INNER_GLYPH_CLASS} aria-label={collapsed ? `Expand ${project.displayName}` : `Collapse ${project.displayName}`} onClick={onToggleCollapsed}>
              <ChevronDownIcon className={cn("transition-transform", collapsed && "-rotate-90")} />
            </SidebarMenuAction>
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<SidebarMenuAction showOnHover className={GLYPH_CLASS} aria-label={rowLabelOf(newThreadAction)} onClick={() => void runAction(newThreadAction)} />}>
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{NEW_THREAD_TITLE}</TooltipPopup>
          </Tooltip>
        </>
      )}
    </>
  );
}
