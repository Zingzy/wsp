// SPDX-License-Identifier: AGPL-3.0-only
// The one workspace on screen in Spaces mode, above its threads: the row's
// own line one (the lead slot with the state dot, the name, the state's word
// in muted mono off running) and under it the machine's lines, three or four
// lines once rather than repeated per row. Renaming turns the name into the
// sidebar's one name box in the same slot, as it does on a row, so the mode
// keeps one editor and one grammar. The words come from workspaceRows.ts; the
// block carries the workspace's menu, since in this mode no row of its own is
// on screen to right-click. It carries a row's keyboard reach with it: the id
// every row wears, so the arrow walk stops here, Enter for the action the
// row's own glyph carries, and the menu key, which a browser sends as a
// context menu on whatever has focus.
import type { KeyboardEvent, MouseEvent } from "react";
import type { MemoryReading } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { WORKSPACE_WORDS } from "../actions/format.js";
import { actionById, type ResolvedAction } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
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
  onRename: (name: string) => void;
  onRenameCancel: () => void;
  /** Opens the box here, as the menu's Rename does; absent where the rename is refused, so the name is text alone. */
  onRenameOpen?: (() => void) | undefined;
}) {
  const newThread = actionById(actions, "new-thread");
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" || newThread.refusal !== null) return;
    event.preventDefault();
    void runAction(newThread);
  };
  return (
    <div
      data-space-header
      data-sidebar-row
      data-row-id={workspaceRowId(project.id)}
      className="mb-1 flex items-start gap-[var(--sidebar-control-gap)] border-b border-sidebar-border/60 px-2 pt-1.5 pb-2 text-sm outline-hidden ring-ring focus-visible:ring-2"
      // A header holding the box is the box's own stop and takes no menu over it, as a row being named does not.
      {...(renaming ? {} : { tabIndex: 0, onKeyDown, onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, actions) })}
    >
      <span aria-hidden className={ROW_LEAD_CLASS}>
        <span className={cn("size-2 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")} />
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
          <span data-space-state className={cn(ROW_META_CLASS, "shrink-0 text-right")}>
            {stateSlotWord(project)}
          </span>
        </span>
        {spaceHeaderLines({ project, cost, outOfMemory, nowMs }).map(line => (
          <span key={line} data-space-meta className={cn(ROW_META_CLASS, "truncate")} title={line}>
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}
