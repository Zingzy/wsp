// SPDX-License-Identifier: AGPL-3.0-only
// The one workspace on screen in Spaces mode, above its threads: the row's
// own line one (the lead slot with the state dot, the name, the state's word
// in muted mono off running) and under it the machine's lines, three or four
// lines once rather than repeated per row. Renaming turns the name into the
// sidebar's one name box in the same slot, as it does on a row, so the mode
// keeps one editor and one grammar. The words come from workspaceRows.ts; the
// block carries the workspace's menu, since in this mode no row of its own is
// on screen to right-click. A workspace with a glyph picked puts it in the
// lead in its own hue, and the state dot moves to the state slot at the other
// end of that line, so the running dot is never lost to a glyph. It is a row
// in every other way too: the same
// button the rows are drawn with, wearing the id the walk stops on, so Space
// and Enter both open the workspace here as they do on its row in the list,
// and the menu key reaches the actions, since a browser sends that key as a
// context menu on whatever has focus. The block takes no colour of its own:
// the hue it declares is there for the glyph to draw in, and the wash that
// says which workspace is open is painted on the sidebar, not here.
import type { MouseEvent } from "react";
import type { MemoryReading } from "@wsp/protocol";
import { openContextMenu } from "../actions/contextMenu.js";
import { WORKSPACE_WORDS } from "../actions/format.js";
import type { ResolvedAction } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { TINTED_INK, WorkspaceGlyphMark, tintAttr } from "../components/workspaceLook.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { ROW_LEAD_CLASS, ROW_META_CLASS, workspaceRowId } from "./rowGrammar.js";
import { dotClassForTone, spaceHeaderLines, stateSlotWord } from "./workspaceRows.js";

export function SpaceHeader({
  project,
  cost,
  outOfMemory,
  nowMs,
  actions,
  renaming,
  saving,
  onSelect,
  onRename,
  onRenameCancel,
  onRenameOpen,
}: {
  project: SidebarProjectSnapshot;
  cost: { readonly rateUsdPerHour: number; readonly accruedUsd: number } | null;
  /** The last memory sample from a machine whose link then dropped. */
  outOfMemory: MemoryReading | undefined;
  nowMs: number;
  actions: ReadonlyArray<ResolvedAction>;
  /** The name is being typed on this header: the name slot holds the box instead of the text. */
  renaming: boolean;
  /** That name is on its way to the runtime: the field stays exactly as it is and takes no second Enter. */
  saving: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
  /** Opens the box here, as the menu's Rename does; absent where the rename is refused, so the name is text alone. */
  onRenameOpen?: (() => void) | undefined;
}) {
  return (
    <SidebarMenuButton
      size="lg"
      // An input may not sit inside a button, so a header being renamed is a plain box with the same grammar.
      render={renaming ? <div /> : <button type="button" />}
      data-space-header
      {...tintAttr(project.workspace.tint)}
      data-sidebar-row
      data-row-id={workspaceRowId(project.id)}
      // The bottom two corners stay square so the hairline under the block runs the sidebar's width; the top two
      // carry the row's radius, which is the shape the focus ring takes.
      className="mb-1 h-auto items-start gap-[var(--sidebar-control-gap)] rounded-t-lg rounded-b-none border-b border-sidebar-border/60 px-2 pt-1.5 pb-2 text-sm"
      // A header holding the box takes no menu over it, as a row being named does not.
      {...(renaming ? {} : { onClick: onSelect, onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, actions) })}
    >
      <span aria-hidden className={ROW_LEAD_CLASS}>
        {project.workspace.glyph === undefined ? <StateDot project={project} /> : <WorkspaceGlyphMark glyph={project.workspace.glyph} className={cn("size-3.5", TINTED_INK)} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="flex items-center gap-2">
          {renaming ? (
            <RowNameInput name={project.displayName} label={WORKSPACE_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
          ) : (
            <span
              data-space-name
              className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground"
              onDoubleClick={onRenameOpen === undefined ? undefined : event => {
                event.stopPropagation();
                onRenameOpen();
              }}
            >
              {project.displayName}
            </span>
          )}
          <span data-space-state className={cn(ROW_META_CLASS, "flex shrink-0 items-center gap-1.5 text-right")}>
            {project.workspace.glyph === undefined ? null : <StateDot project={project} />}
            {stateSlotWord(project)}
          </span>
        </span>
        {spaceHeaderLines({ project, cost, outOfMemory, nowMs }).map(line => (
          <span key={line} data-space-meta className={cn(ROW_META_CLASS, "truncate")} title={line}>
            {line}
          </span>
        ))}
      </span>
    </SidebarMenuButton>
  );
}

/** The workspace's state as a dot, wherever the header puts it: the lead, or the state slot when a glyph has the lead. */
function StateDot({ project }: { project: SidebarProjectSnapshot }) {
  return <span className={cn("size-2 shrink-0 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")} />;
}
