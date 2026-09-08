// SPDX-License-Identifier: AGPL-3.0-only
// The thin row at the sidebar's bottom in Spaces mode: one dot per workspace
// in the sidebar's own order, in that workspace's own hue where one is picked
// and in its state colour where none is, the current one wider because it
// carries its glyph and its name; a click jumps to that workspace. The row
// never wraps, so the names of the others stay in their hover text.
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { WorkspaceGlyphMark, tintAttr } from "../components/workspaceLook.js";
import { cn } from "../lib/utils.js";
import { ROW_META_CLASS } from "./rowGrammar.js";
import { dotClassForTone } from "./workspaceRows.js";

export function SpaceDots({
  projects,
  currentId,
  onSelect,
}: {
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  currentId: string | null;
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <div data-space-dots className="flex min-w-0 items-center gap-1 overflow-hidden">
      {projects.map(project => {
        const current = project.id === currentId;
        const { tint, glyph } = project.workspace;
        return (
          <button
            key={project.id}
            type="button"
            data-space-dot
            data-space-dot-current={current ? "" : undefined}
            {...tintAttr(tint)}
            aria-label={project.displayName}
            aria-current={current ? "true" : undefined}
            title={project.displayName}
            onClick={() => onSelect(project.id)}
            className={cn(
              "flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 outline-hidden ring-ring transition-colors duration-150 hover:bg-sidebar-row-hover focus-visible:ring-2",
              current && "min-w-0 shrink",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                tint === undefined ? dotClassForTone(project.indicator.tone) : "bg-[var(--space-tint)]",
                project.indicator.pulse && "animate-status-pulse",
              )}
            />
            {current && glyph !== undefined ? <WorkspaceGlyphMark glyph={glyph} className="size-3.5" /> : null}
            {current ? <span className={cn(ROW_META_CLASS, "min-w-0 truncate text-sidebar-foreground")}>{project.displayName}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
