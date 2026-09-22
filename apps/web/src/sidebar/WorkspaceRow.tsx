// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's row, two lines at every width, one fixed slot each so every
// row has the same shape and height. Line one: the name, and at the right
// edge a slot holding the state's word while the state is not running, empty
// while it is. Line two: the branch the agent is on, or what the last bring
// back answered about it; the one sentence a person may be waiting on takes
// that line while it lasts. The slot cuts by its own width and by nothing
// else, with the whole of it on the row's hover text: a cap counted in
// characters cut a 44 character line to 30 at every width, so the half that
// says what happened was gone at 390 where the line fits whole. No figure
// stands on this row: what a machine costs and what shape it is are facts
// about the computer it runs on and live on that computer's row in Settings.
// No glyph leads the row and no hue says its state: the tree over it says
// which project and computer it belongs to, and the word in the slot says the
// rest. The row's actions, the collapse chevron on a live row with threads,
// forget and rebuild on a dead one, show on hover in the state slot, where the
// word yields to them so nothing moves, and in the row's menu; the resting row
// carries none. Renaming turns the name into the sidebar's one name box in
// the same slot, opened from the menu or by a double-click on the name, so the
// row keeps its height and its grammar. The words come from workspaceRows.ts
// and the actions from the workspace registry.
import { ChevronDownIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { needsRebuild, type MemoryReading } from "@wsp/protocol";
import { runAction } from "../actions/contextMenu.js";
import { WORKSPACE_WORDS } from "../actions/format.js";
import { actionIfAny, rowLabelOf, type ResolvedAction } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { SidebarMenuAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { useAbsentComputer, useBroughtBack } from "../protocol/store.js";
import { RowNameInput } from "./RowNameInput.js";
import { GLYPH_ROW_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, TWO_LINE_FIRST_CLASS, TWO_LINE_ROW_CLASS, TWO_LINE_SECOND_CLASS, workspaceRowId } from "./rowGrammar.js";
import { holdsStateWord, metaSentences, stateSlotWord, workspaceMetaLine, workspaceMetaTitle } from "./workspaceRows.js";

/** The glyphs sit on line one inside the state slot, the inner one and the one at the row's inset; the kit's own place is the row's middle and edge. */
const GLYPH_CLASS = "peer-data-[size=lg]/menu-button:top-1 right-2";
const INNER_GLYPH_CLASS = cn(GLYPH_CLASS, "right-7");
/** The slot holds the longest state word there is, so a word arriving or leaving never moves the name beside it:
 * Unreachable measures 72.9 px in the row's mono at 11 px, and at 44 px the slot took the 16 px it needed off the
 * name, which moved under a person reading it. */
const STATE_SLOT_CLASS = "shrink-0 text-right transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0";
/** That width on a row whose kind has a state to show. */
const STATE_SLOT_WIDTH = "min-w-[74px]";
/** The room a row that shows no state word keeps anyway: the one glyph the hover puts in the slot, so nothing a
 * person is reading ever runs under it and the name is one width at rest and on hover. */
const GLYPH_ROOM = "min-w-5";

export function WorkspaceRow({
  project,
  outOfMemory,
  nowMs,
  depth,
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
  outOfMemory: MemoryReading | undefined;
  nowMs: number;
  /** How many levels of the tree stand over this row, for the tests that read the tree's shape. */
  depth: number;
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
  const gone = project.state === "gone";
  const absent = useAbsentComputer(project.id, nowMs);
  // Whether a word can stand in the slot, read where the word itself is decided: a row that holds one keeps the
  // slot's width, and every other row keeps the glyph's room and nothing more.
  const holdsState = holdsStateWord(project, absent);
  const broughtBack = useBroughtBack(project.id);
  const meta = workspaceMetaLine({ project, absent, outOfMemory, broughtBack });
  const metaWhole = workspaceMetaTitle({ project, absent, outOfMemory, broughtBack });
  // The same slot carries the branch most of the time and a sentence when something needs reading.
  const metaIsProse = meta !== "" && metaSentences({ project, absent, outOfMemory }).includes(meta);
  // The registry decides which of these a workspace of this kind in this state takes at all; the row draws the
  // glyph for one it was handed and nothing where it was handed none.
  const forgetAction = actionIfAny(actions, "forget");
  const rebuildAction = actionIfAny(actions, "rebuild");
  // A dead row's two glyphs are the two roads out of it; a dead workspace of a kind that takes neither keeps the
  // live row's chevron rather than an empty slot.
  const deadGlyphs = dead && (forgetAction !== undefined || rebuildAction !== undefined);
  return (
    <>
      <SidebarMenuButton
        size="lg"
        // An input may not sit inside a button, so a row being renamed is a plain box with the same grammar.
        render={renaming ? <div /> : <button type="button" />}
        isActive={active}
        data-sidebar-row
        data-row-id={workspaceRowId(project.id)}
        data-depth={depth}
        className={cn(TWO_LINE_ROW_CLASS, GLYPH_ROW_CLASS)}
        {...(renaming ? {} : { onClick: onSelect })}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={TWO_LINE_FIRST_CLASS}>
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
            <span data-workspace-state className={cn(ROW_PROSE_CLASS, STATE_SLOT_CLASS, holdsState ? STATE_SLOT_WIDTH : GLYPH_ROOM)}>
              {stateSlotWord(project, absent)}
            </span>
          </span>
          <span className={TWO_LINE_SECOND_CLASS}>
            <span data-workspace-meta className={cn(metaIsProse ? ROW_PROSE_CLASS : ROW_META_CLASS, "min-w-0 flex-1 truncate")} title={absent?.sentence ?? metaWhole}>
              {meta}
            </span>
          </span>
        </span>
      </SidebarMenuButton>
      {deadGlyphs ? (
        <>
          {gone && forgetAction !== undefined ? (
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
          {rebuildAction !== undefined ? (
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
          ) : null}
        </>
      ) : project.threads.length > 0 ? (
        <SidebarMenuAction showOnHover className={GLYPH_CLASS} aria-label={collapsed ? `Expand ${project.displayName}` : `Collapse ${project.displayName}`} onClick={onToggleCollapsed}>
          <ChevronDownIcon className={cn("transition-transform", collapsed && "-rotate-90")} />
        </SidebarMenuAction>
      ) : null}
    </>
  );
}
