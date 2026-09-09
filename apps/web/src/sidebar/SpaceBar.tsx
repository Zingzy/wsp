// SPDX-License-Identifier: AGPL-3.0-only
// The row at the sidebar's bottom in Spaces mode: one icon per workspace in
// the sidebar's own order, centred in the sidebar's width, and a plus at the
// right end that makes a new workspace. Each space is its glyph, the kind's
// own by default (this computer, a cloud fork, a machine over ssh; the kind
// table owns it) or the icon the person picked. The one on screen takes the
// theme's ink, the others sit muted, and a paused one dims as its row's lead
// does; every other state is the header's word, never a hue here. Every icon
// is one size in one row of one height, so the row never moves. A click jumps
// to that workspace; a right-click opens the workspace's
// own menu, the same one its row carries. The name is on the header above,
// never here; the hover text carries it for the others.
import { PlusIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { workspaceKind } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { WorkspaceGlyphMark } from "../components/workspaceLook.js";
import { cn } from "../lib/utils.js";
import { workspaceKindGlyph } from "../workspaceKindGlyph.js";

const ICON_CLASS = "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-hidden ring-ring transition-colors duration-150 hover:bg-sidebar-row-hover focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50";

export function SpaceBar({
  projects,
  currentId,
  canCreate,
  onSelect,
  onContextMenu,
  onCreate,
}: {
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  currentId: string | null;
  /** Whether the host can be asked for a workspace; the plus is dimmed while it cannot. */
  canCreate: boolean;
  onSelect: (workspaceId: string) => void;
  onContextMenu: (project: SidebarProjectSnapshot, event: MouseEvent<HTMLElement>) => void;
  onCreate: () => void;
}) {
  return (
    <div data-space-bar className="flex h-7 min-w-0 items-center justify-center gap-0.5 overflow-hidden">
      {projects.map(project => {
        const current = project.id === currentId;
        const KindGlyph = workspaceKindGlyph(workspaceKind(project.workspace));
        const glyph = project.workspace.glyph;
        return (
          <button
            key={project.id}
            type="button"
            data-space-icon={project.id}
            data-space-icon-current={current ? "" : undefined}
            aria-label={project.displayName}
            aria-current={current ? "true" : undefined}
            title={project.displayName}
            onClick={() => onSelect(project.id)}
            onContextMenu={event => onContextMenu(project, event)}
            className={cn(ICON_CLASS, current ? "text-[var(--space-tint,var(--sidebar-foreground))]" : "text-sidebar-muted-foreground/70", project.state === "paused" && "opacity-50")}
          >
            {glyph === undefined ? <KindGlyph aria-hidden data-space-kind-glyph className="size-4 shrink-0" /> : <WorkspaceGlyphMark glyph={glyph} className="size-4" />}
          </button>
        );
      })}
      <button type="button" data-space-new aria-label="New workspace" title="New workspace" disabled={!canCreate} onClick={onCreate} className={cn(ICON_CLASS, "ml-1 text-sidebar-muted-foreground/70")}>
        <PlusIcon aria-hidden className="size-4 shrink-0" />
      </button>
    </div>
  );
}
