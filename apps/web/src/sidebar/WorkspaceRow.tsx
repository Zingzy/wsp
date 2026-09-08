// SPDX-License-Identifier: AGPL-3.0-only
// One machine's row, two lines at every width. Line one: the lead slot, the
// name, and at the right edge a slot as wide as two glyphs holding the
// state's word in muted mono only while the state is not running (the dot
// says running). The lead holds the state dot for a machine wsp drives and
// the kind's own glyph for one it does not, which has no state to report.
// On hover the word yields and the row's two glyphs, the
// collapse chevron and new thread, take the slot, so nothing moves. Line
// two: the one mono meta line over the row's whole width, cut from the right
// and whole in its title. Renaming turns the name into the sidebar's one name
// box in the same slot, opened from the menu or by a double-click on the
// name, so the row keeps its height and its grammar. A dead row's glyphs are
// its recovery and always show, so that row makes room for them beside the
// word: a gone row's forget and rebuild, a zombie's rebuild alone. The words
// come from workspaceRows.ts and the actions from the workspace registry.
import { ChevronDownIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
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
import { ROW_LEAD_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, TWO_LINE_ROW_CLASS, workspaceRowId } from "./rowGrammar.js";
import { NEW_THREAD_TITLE, dotClassForTone, metaSentences, stateSlotWord, workspaceMetaLine } from "./workspaceRows.js";

/** The glyphs sit on line one inside the state slot, the inner one and the one at the row's inset; the kit's own place is the row's middle and edge. */
const GLYPH_CLASS = "peer-data-[size=lg]/menu-button:top-1 right-2";
const INNER_GLYPH_CLASS = cn(GLYPH_CLASS, "right-7");
/** A live row's text runs to the row's own inset; the glyphs land in the state slot. A dead row keeps two glyphs' room. */
const LIVE_ROW_CLASS = "group-has-data-[sidebar=menu-action]/menu-item:pe-2";
const DEAD_ROW_CLASS = "group-has-data-[sidebar=menu-action]/menu-item:pe-14";
const STATE_SLOT_CLASS = "min-w-11 shrink-0 text-right";
/** A kind's own glyph reads at the weight of the neutral dot it stands in for, so no row's lead is louder than another's. */
const LEAD_GLYPH_CLASS = "text-muted-foreground/60";
const YIELDING_SLOT_CLASS = "transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0";

export function WorkspaceRow({
  project,
  cost,
  outOfMemory,
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
  const dead = needsRebuild({ phase: project.phase, machineState: project.machineState, reach: project.reach });
  const KindGlyph = workspaceKindGlyph(workspaceKind(project.workspace));
  const gone = project.state === "gone";
  const meta = workspaceMetaLine({ project, cost, outOfMemory, nowMs });
  // The same slot carries counts most of the time and a sentence when something needs reading.
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
        className={cn(TWO_LINE_ROW_CLASS, dead ? DEAD_ROW_CLASS : LIVE_ROW_CLASS)}
        {...(renaming ? {} : { onClick: onSelect })}
      >
        <span aria-hidden className={ROW_LEAD_CLASS} data-workspace-lead={KindGlyph === null ? "dot" : "glyph"}>
          {KindGlyph === null ? (
            <span className={cn("size-2 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")} />
          ) : (
            <KindGlyph className={cn("size-3.5", LEAD_GLYPH_CLASS)} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
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
            <span data-workspace-state className={cn(ROW_META_CLASS, STATE_SLOT_CLASS, !dead && YIELDING_SLOT_CLASS)}>
              {stateSlotWord(project)}
            </span>
          </span>
          <span data-workspace-meta className={cn(metaIsProse ? ROW_PROSE_CLASS : ROW_META_CLASS, "truncate")} title={meta}>
            {meta}
          </span>
        </span>
      </SidebarMenuButton>
      {dead ? (
        <>
          {gone ? (
            <SidebarMenuAction
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
