// SPDX-License-Identifier: AGPL-3.0-only
// New thread's one choice, the project: which project Cmd+T and the new-thread
// button open on, or the palette's list of projects where the person asked to
// pick every time, the heading's picker that changes it, and the line under
// the box naming the computer the thread will run on. A thread started here
// makes its own copy of the project, so it never lands inside another
// thread's workspace. Picking another computer is --on as the command line
// reads it today: that computer's record of the same repo.
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { ProjectView } from "@wsp/protocol";
import { openCommandPalette } from "../commandPaletteBus.js";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../components/ui/menu.js";
import { usePlaces, useProjects, useStore } from "../protocol/store.js";
import { storedPicks } from "../sidebar/picks.js";
import { inProjectOrder } from "../sidebar/threadTree.js";
import { placeNames, projectComputerWord } from "../sidebar/workspaceRows.js";
import { PROJECT_WORDS } from "../sidebar/words.js";
import { requestAddProject } from "./shellRequests.js";
import { RowComputer } from "../components/chat/ComposerCheckoutRow.js";

/** The project New thread opens on: the one the sidebar is filtered to, else the last one used, which is the open
 * workspace's or the open New thread's, else the first in the person's order. */
export function newThreadProject(): string | null {
  const s = useStore.getState();
  const held = (id: string | null | undefined): id is string => id != null && s.projects.some(p => p.id === id);
  const filtered = storedPicks().project;
  const open = s.workspaces.find(w => w.id === s.selectedId)?.project.id;
  return [filtered, open, s.projectHome].find(held) ?? inProjectOrder(s.projects, p => p.id, s.preferences.projectOrder)[0]?.id ?? null;
}

export function openNewThread(): void {
  const project = newThreadProject();
  if (project === null) return;
  if (useStore.getState().preferences.newThreadIn === "ask") openCommandPalette({ page: "new-thread" });
  else useStore.getState().openProjectHome(project);
}

const pickerClass = "inline-flex max-w-64 items-baseline gap-1 border-foreground/60 border-b border-dotted align-baseline outline-none transition-colors hover:border-foreground focus-visible:border-foreground";

/** The heading's project name, which is the project picker: every project and Add a project. */
export function HomeProjectPicker({ project }: { project: ProjectView }) {
  const projects = useProjects();
  const places = usePlaces();
  const order = useStore(s => s.preferences.projectOrder);
  const open = useStore(s => s.openProjectHome);
  const named = useMemo(() => placeNames(places), [places]);
  const rows = useMemo(() => inProjectOrder(projects, p => p.id, order), [projects, order]);
  return (
    <Menu>
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
        <MenuItem onClick={requestAddProject}>
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
 * gives for the project, by its icon and name. Where another computer holds the same repo it is a picker over them. */
export function WhereItRuns({ project }: { project: ProjectView }) {
  const landing = useStore(s => s.landings[project.id]);
  const loadLanding = useStore(s => s.loadLanding);
  const projects = useProjects();
  const places = usePlaces();
  const open = useStore(s => s.openProjectHome);
  useEffect(() => void loadLanding(project.id), [loadLanding, project.id]);
  const named = useMemo(() => placeNames(places), [places]);
  const holders = useMemo(() => {
    const same = project.remote === "" ? [project] : projects.filter(p => p.remote === project.remote);
    // One row per computer: the open record where it is there, else that computer's first record of the repo.
    return places.flatMap(place => {
      const there = same.filter(p => p.computer === place.id);
      const pick = there.find(p => p.id === project.id) ?? there[0];
      return pick === undefined ? [] : [pick];
    });
  }, [places, project, projects]);
  // The landing names its computer by id; the host's own word for this computer is its id, not the name a person reads.
  const name = named.get(landing?.place ?? project.computer) ?? landing?.name;
  if (name === undefined) return null;
  const line = `Runs on ${name}`;
  const at = landing?.place ?? project.computer;
  const place = places.find(p => p.id === at);
  if (holders.length < 2) return <RunsOn at={at} name={name} />;
  return (
    <Menu>
      <MenuTrigger render={<button type="button" data-new-thread-where />} className="outline-none transition-colors hover:[&_[data-composer-computer]]:text-foreground focus-visible:[&_[data-composer-computer]]:text-foreground" aria-label={line}>
        <RowComputer name={name} place={place}>
          <ChevronDownIcon aria-hidden className="opacity-50" />
        </RowComputer>
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-56">
        <MenuRadioGroup value={project.id} onValueChange={next => typeof next === "string" && open(next)}>
          {holders.map(holder => (
            <MenuRadioItem key={holder.id} value={holder.id}>
              <span className="truncate">{named.get(holder.computer) ?? holder.computer}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
