// SPDX-License-Identifier: AGPL-3.0-only
// New thread's one choice, the project: which project the chord and the New
// thread controls open on, or the palette's list of projects where the person
// asked to pick every time and holds more than one, the heading's picker that
// changes it, and the line under the box naming the computer the thread will
// run on. A thread started here on this computer works in the project's folder
// itself.
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Preferences, ProjectView } from "@wsp/protocol";
import { openCommandPalette } from "../commandPaletteBus.js";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../components/ui/menu.js";
import { usePlaces, useProjects, useSidebarProjects, useStore } from "../protocol/store.js";
import { useLocalStorage } from "../hooks/useLocalStorage.js";
import { PROJECT_PICK_KEY, pickCodec, storedPicks } from "../sidebar/picks.js";
import { inPickOrder, inProjectOrder } from "../sidebar/threadTree.js";
import { placeNames, projectComputerWord } from "../sidebar/workspaceRows.js";
import { PROJECT_WORDS } from "../sidebar/words.js";
import { requestAddProject } from "./shellRequests.js";
import { RowComputer } from "../components/chat/ComposerCheckoutRow.js";

/** The projects New thread puts first, in this order: the one the sidebar is filtered to, the open workspace's, then
 * the last one used, which is the open New thread page's. Each is one this host still holds. */
function newThreadLeads(projects: ReadonlyArray<ProjectView>, filtered: string | null, open: string | null | undefined, home: string | null): string[] {
  return [filtered, open, home].filter((id, at, all): id is string => id != null && all.indexOf(id) === at && projects.some(p => p.id === id));
}

/** The project New thread opens on: the first of the leads, else the first in the person's order. */
export function newThreadProject(): string | null {
  const s = useStore.getState();
  const open = s.workspaces.find(w => w.id === s.selectedId)?.project.id;
  return newThreadLeads(s.projects, storedPicks().project, open, s.projectHome)[0] ?? inProjectOrder(s.projects, p => p.id, s.preferences.projectOrder)[0]?.id ?? null;
}

/** Whether New thread asks for its project first: where the person asked to pick every time and there is more than one
 * to pick, since a list of one is a confirm with nothing to choose. */
export const newThreadAsks = (s: { readonly preferences: Pick<Preferences, "newThreadIn">; readonly projects: ReadonlyArray<ProjectView> }): boolean => s.preferences.newThreadIn === "ask" && s.projects.length > 1;

/** Opens New thread on its project, or the list to pick one from where it asks. */
export function openNewThread(): void {
  const project = newThreadProject();
  if (project === null) return;
  const s = useStore.getState();
  if (newThreadAsks(s)) openCommandPalette({ page: "new-thread" });
  else s.openProjectHome(project);
}

const pickerClass = "inline-flex max-w-64 items-baseline gap-1 border-foreground/60 border-b border-dotted align-baseline outline-none transition-colors hover:border-foreground focus-visible:border-foreground";

/** The projects a new thread is picked from, for every list that offers them: the leads New thread opens on first,
 * then by recent turns. While the list is open its order holds, so a turn starting elsewhere never moves a row under
 * the person's pointer or key; a project added meanwhile joins at the end. */
export function useNewThreadPicks(open: boolean): ProjectView[] {
  const projects = useProjects();
  const rows = useSidebarProjects();
  const [filtered] = useLocalStorage<string | null>(PROJECT_PICK_KEY, null, pickCodec);
  const inWorkspace = useStore(s => s.workspaces.find(w => w.id === s.selectedId)?.project.id);
  const home = useStore(s => s.projectHome);
  const order = useStore(s => s.preferences.projectOrder);
  const ranked = useMemo(() => inPickOrder(projects, rows, newThreadLeads(projects, filtered, inWorkspace, home), order), [projects, rows, filtered, inWorkspace, home, order]);
  const [held, setHeld] = useState<readonly string[] | null>(null);
  if (open && held === null) setHeld(ranked.map(project => project.id));
  if (!open && held !== null) setHeld(null);
  return useMemo(() => (held === null ? ranked : [...held.flatMap(id => projects.filter(project => project.id === id)), ...projects.filter(project => !held.includes(project.id))]), [held, projects, ranked]);
}

/** The heading's project name, which is the project picker: every project, then Add a project, whose dialog opens the
 * project it records. */
export function HomeProjectPicker({ project }: { project: ProjectView }) {
  const places = usePlaces();
  const open = useStore(s => s.openProjectHome);
  const named = useMemo(() => placeNames(places), [places]);
  const [shown, setShown] = useState(false);
  const rows = useNewThreadPicks(shown);
  return (
    <Menu open={shown} onOpenChange={setShown}>
      <MenuTrigger render={<button type="button" />} className={pickerClass} aria-label={`Project: ${project.name}`} data-new-thread-project={project.id}>
        <span className="truncate">{project.name}</span>
      </MenuTrigger>
      <MenuPopup align="center" className="w-64">
        <MenuRadioGroup value={project.id} onValueChange={next => typeof next === "string" && open(next)}>
          {rows.map(row => {
            const computer = projectComputerWord(row, named);
            return (
              <MenuRadioItem key={row.id} value={row.id} data-new-thread-project-row={row.id}>
                <span className="truncate">{row.name}</span>
                {computer === null ? null : <span className="ms-2 truncate text-xs text-muted-foreground">{computer}</span>}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={requestAddProject} data-new-thread-add-project>
          <PlusIcon />
          {PROJECT_WORDS.add}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** The computer a thread will run on, as the row under the box names it: its icon and its name, no picker. */
export function RunsOn({ at, name }: { at: string; name: string }) {
  const place = usePlaces().find(p => p.id === at);
  return (
    <span data-new-thread-where title={`Runs on ${name}`}>
      <RowComputer name={name} place={place} />
    </span>
  );
}

/** The first item of the row under the box: the computer the thread will run on, the placement rule's answer the host
 * gives for the project, by its icon and name. A project is one folder on one computer, so there is nothing to switch:
 * the same repo on another computer is another project. */
export function WhereItRuns({ project }: { project: ProjectView }) {
  const landing = useStore(s => s.landings[project.id]);
  const loadLanding = useStore(s => s.loadLanding);
  const places = usePlaces();
  useEffect(() => void loadLanding(project.id), [loadLanding, project.id]);
  const named = useMemo(() => placeNames(places), [places]);
  // The landing names its computer by id; the host's own word for this computer is its id, not the name a person reads.
  const name = named.get(landing?.place ?? project.computer) ?? landing?.name;
  if (name === undefined) return null;
  return <RunsOn at={landing?.place ?? project.computer} name={name} />;
}
