// SPDX-License-Identifier: AGPL-3.0-only
// The project filter at the head of the sidebar, one project per row in the
// host's order. While one project is picked the head stands in for that
// project's row: its plus on hover is New workspace and a right-click opens
// the project's menu.
import { FolderIcon, PlusIcon } from "lucide-react";
import { useMemo, type MouseEvent } from "react";
import { SidebarMenuAction } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { ProjectGlyph } from "../projects/look.js";
import { openProjectSettings } from "../settings/openAt.js";
import { NounSwitcher, type SwitcherRow } from "./NounSwitcher.js";
import { HOVER_GLYPH_CLASS } from "./rowGrammar.js";
import type { ProjectRef } from "./threadTree.js";
import { NEW_WORKSPACE, SWITCHER_WORDS } from "./words.js";
import { projectComputerWord } from "./workspaceRows.js";

export function ProjectSwitcher({
  projects,
  named,
  pick,
  onPick,
  onNewWorkspace,
  onAddProject,
  onContextMenu,
}: {
  projects: ReadonlyArray<ProjectRef>;
  /** Every computer this host holds by id, for the word beside a project that is not on this one. */
  named: ReadonlyMap<string, string>;
  /** The project the tree is filtered to, or null for every project. */
  pick: ProjectRef | null;
  onPick: (projectId: string | null) => void;
  onNewWorkspace: (projectId: string) => void;
  onAddProject: () => void;
  /** The picked project's own menu, which the head offers while it stands in for that project's row. */
  onContextMenu: (event: MouseEvent<HTMLElement>, projectId: string) => void;
}) {
  const rows = useMemo<SwitcherRow[]>(
    () => projects.map(project => ({ id: project.id, name: project.name, meta: projectComputerWord(project, named), glyph: <ProjectGlyph projectId={project.id} /> })),
    [projects, named],
  );
  const picked = pick === null ? null : rows.find(row => row.id === pick.id) ?? null;
  return (
    <NounSwitcher
      noun="project"
      words={SWITCHER_WORDS}
      AllGlyph={FolderIcon}
      rows={rows}
      pick={picked}
      onPick={onPick}
      onAdd={onAddProject}
      onSettings={openProjectSettings}
      {...(pick === null
        ? {}
        : {
            onContextMenu: (event: MouseEvent<HTMLElement>) => onContextMenu(event, pick.id),
            action: (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuAction
                      showOnHover
                      // The room's own place: the row's 8 px inset, the 16 px chevron and the 10 px gap before it.
                      className={cn(HOVER_GLYPH_CLASS, "right-8.5")}
                      data-k="new-workspace"
                      data-project={pick.id}
                      aria-label={NEW_WORKSPACE}
                      onClick={() => onNewWorkspace(pick.id)}
                    />
                  }
                >
                  <PlusIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">{NEW_WORKSPACE}</TooltipPopup>
              </Tooltip>
            ),
          })}
    />
  );
}
