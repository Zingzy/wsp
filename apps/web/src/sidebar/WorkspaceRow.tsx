// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's row, three lines at every width, one fixed slot each so every
// row has the same shape and height. Line one: the kind's glyph in the lead,
// the name, and at the right edge a slot as wide as two glyphs holding the
// state's word in muted mono while the state is not running, empty while it
// is; the glyph is the one thing in the row whose hue says the state: the
// app's success green while the machine runs, muted otherwise and dimmed while
// paused, by the rule in workspaceRows.ts, in a box that never moves. Line
// two: what this workspace is made of, off the protocol's word table. Line
// three: the branch the agent is on, or what the last bring back answered about
// it; the one sentence a person may be waiting on takes that line while it
// lasts, cut at the row's own cap with the whole of it on the row's hover text. No figure stands on this row: what a machine
// costs and what shape it is are facts about the computer it runs on and live
// on that computer's row in Settings. The row's actions, the collapse
// chevron and new thread on a live row, forget and rebuild on a dead one, show
// on hover in the state slot, where the word yields to them so nothing moves,
// and in the row's menu; the resting row carries none. Renaming turns the name
// into the sidebar's one name box in the same slot, opened from the menu or by
// a double-click on the name, so the row keeps its height and its grammar. The
// words come from workspaceRows.ts and the actions from the workspace registry.
import { ChevronDownIcon, PlayIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { needsRebuild, workspaceKind, type Capabilities, type MemoryReading } from "@wsp/protocol";
import { runAction } from "../actions/contextMenu.js";
import { WORKSPACE_WORDS } from "../actions/format.js";
import { actionById, rowLabelOf, type ResolvedAction } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { SidebarMenuAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { useAbsentComputer, useBroughtBack } from "../protocol/store.js";
import { workspaceKindGlyph } from "../workspaceKindGlyph.js";
import { RowNameInput } from "./RowNameInput.js";
import { ROW_LEAD_CLASS, ROW_MADE_OF_SLOT, ROW_META_CLASS, ROW_PROSE_CLASS, THREE_LINE_ROW_CLASS, rowLineCut, workspaceRowId } from "./rowGrammar.js";
import { NEW_THREAD_TITLE, glyphStateClass, holdsStateWord, madeOfLine, metaSentences, stateSlotWord, workspaceMetaLine } from "./workspaceRows.js";

/** The glyphs sit on line one inside the state slot, the inner one and the one at the row's inset; the kit's own place is the row's middle and edge. */
const GLYPH_CLASS = "peer-data-[size=lg]/menu-button:top-1 right-2";
const INNER_GLYPH_CLASS = cn(GLYPH_CLASS, "right-7");
/** The row's text runs to the row's own inset; the glyphs land in the state slot on hover. */
const ROW_CLASS = "group-has-data-[sidebar=menu-action]/menu-item:pe-2";
/** The slot holds the longest state word there is, so a word arriving or leaving never moves the name beside it:
 * Unreachable measures 72.9 px in the row's mono at 11 px, and at 44 px the slot took the 16 px it needed off the
 * name, which moved under a person reading it. */
const STATE_SLOT_CLASS = "shrink-0 text-right transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0";
/** That width on a row whose kind has a state to show. */
const STATE_SLOT_WIDTH = "min-w-[74px]";
/** The room a row that shows no state word keeps anyway: the two glyphs the hover puts in the slot, so nothing a
 * person is reading ever runs under them and the name is one width at rest and on hover. A workspace of this
 * computer is such a row: wsp neither pauses nor wakes it, so its slot held 74 px of nothing and took them off an
 * 18 character name. */
const GLYPH_ROOM = "min-w-[52px]";
/** The kind's glyph reads at the weight of the muted meta beside it until the state's own class takes the ink over. */
const LEAD_GLYPH_CLASS = "text-muted-foreground/60";

export function WorkspaceRow({
  project,
  landing,
  computer,
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
  /** What the computer this workspace's project lands on offers, for the network half of line two; null until the
   * host has answered for that project, and on one whose landing it refused. */
  landing: Pick<Capabilities, "copies" | "ownNetwork"> | null;
  /** The computer this workspace stands on, by the name the person gave it; null where that is the computer this
   * window runs on, which the row says nothing about. */
  computer: string | null;
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
  const madeOf = madeOfLine({ project, landing, computer });
  const absent = useAbsentComputer(project.id, nowMs);
  // Whether a word can stand in the slot, read where the word itself is decided: a row that holds one keeps the
  // slot's width, and every other row keeps the glyphs' room and nothing more.
  const holdsState = holdsStateWord(project, absent);
  const broughtBack = useBroughtBack(project.id);
  const meta = workspaceMetaLine({ project, absent, outOfMemory, broughtBack });
  // The same slot carries the branch most of the time and a sentence when something needs reading.
  const metaIsProse = meta !== "" && metaSentences({ project, absent, outOfMemory }).includes(meta);
  const forgetAction = actionById(actions, "forget");
  const rebuildAction = actionById(actions, "rebuild");
  const newThreadAction = actionById(actions, "new-thread");
  const startDaemonAction = actionById(actions, "start-daemon");
  // The row's line says start it, so the row's own glyph is that start while the reading carries one; the thread
  // it stands in for is a key and a menu row away, and the reading is what every surface offers this off.
  const startable = startDaemonAction.refusal === null;
  const glyphAction = startable ? startDaemonAction : newThreadAction;
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
            <span data-workspace-state className={cn(ROW_META_CLASS, STATE_SLOT_CLASS, holdsState ? STATE_SLOT_WIDTH : GLYPH_ROOM)}>
              {stateSlotWord(project, absent)}
            </span>
          </span>
          <span data-workspace-made-of className={cn(ROW_META_CLASS, ROW_MADE_OF_SLOT)} title={madeOf}>
            {madeOf}
          </span>
          <span data-workspace-meta className={cn(metaIsProse ? ROW_PROSE_CLASS : ROW_META_CLASS, "truncate")} title={absent?.sentence ?? meta}>
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
            <TooltipTrigger render={<SidebarMenuAction showOnHover className={GLYPH_CLASS} aria-label={rowLabelOf(glyphAction)} onClick={() => void runAction(glyphAction)} />}>
              {startable ? <PlayIcon /> : <PlusIcon />}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{startable ? startDaemonAction.title : NEW_THREAD_TITLE}</TooltipPopup>
          </Tooltip>
        </>
      )}
    </>
  );
}
