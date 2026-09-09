// SPDX-License-Identifier: AGPL-3.0-only
// The row at the sidebar's bottom in Spaces mode: one icon per workspace in
// the sidebar's own order, centred in the sidebar's width, and a plus at the
// right end that makes a new workspace. Each space is its glyph, the kind's
// own by default (this computer, a cloud fork, a machine over ssh; the kind
// table owns it) or the icon the person picked. The one on screen takes the
// theme's ink, the others sit muted, and a paused one dims by the rule its
// row's lead dims by; every other state is the header's word, never a hue
// here. Every icon is one size in one row of one height, so the row never
// moves. The icons sit in a group of their own that scrolls sideways once
// they outgrow the footer, with the one on screen kept in view, and the plus
// stays outside the group, so neither the first icon nor the plus is ever
// cut. A click jumps to that workspace; a right-click opens the workspace's
// own menu, the same one its row carries. The name is on the header above,
// never here; the hover text carries it for the others.
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, type MouseEvent } from "react";
import { workspaceKind } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { WorkspaceGlyphMark } from "../components/workspaceLook.js";
import { cn } from "../lib/utils.js";
import { workspaceKindGlyph } from "../workspaceKindGlyph.js";
import { leadDimClass } from "./workspaceRows.js";

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
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const current = Array.from(group.current?.querySelectorAll<HTMLElement>("[data-space-icon]") ?? []).find(icon => icon.dataset["spaceIcon"] === currentId);
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [currentId]);
  return (
    <div data-space-bar className="flex h-7 min-w-0 items-center justify-center gap-1">
      <div ref={group} data-space-icons className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
              className={cn(ICON_CLASS, current ? "text-[var(--space-tint,var(--sidebar-foreground))]" : "text-sidebar-muted-foreground/70", leadDimClass(project))}
            >
              {glyph === undefined ? <KindGlyph aria-hidden data-space-kind-glyph className="size-4 shrink-0" /> : <WorkspaceGlyphMark glyph={glyph} className="size-4" />}
            </button>
          );
        })}
      </div>
      <button type="button" data-space-new aria-label="New workspace" title="New workspace" disabled={!canCreate} onClick={onCreate} className={cn(ICON_CLASS, "text-sidebar-muted-foreground/70")}>
        <PlusIcon aria-hidden className="size-4 shrink-0" />
      </button>
    </div>
  );
}
