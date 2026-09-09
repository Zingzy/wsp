// SPDX-License-Identifier: AGPL-3.0-only
// The projects a workspace holds and the one rule for which of them a thread
// starts in. The runtime applies the rule to every start and every command,
// the composer shows its answer under the box, and the command line refuses a
// name before a machine is woken for it; all three read it from here so no
// road can start a thread somewhere another road would not.
import type { WorkspaceProject, WorkspaceView } from "./index.js";
import { underProject } from "./project-path.js";

/** A workspace's projects as every client reads them: a record from before projects were a list carries none here,
 * and reads as none rather than as a field to guard. */
export function workspaceProjects(view: Pick<WorkspaceView, "projects">): WorkspaceProject[] {
  return view.projects ?? [];
}

/** Why a project a caller named is not on the workspace, with the ones that are. */
export function noProjectLine(name: string, projects: readonly WorkspaceProject[]): string {
  const held = projects.length === 0 ? "it has no projects" : `its projects are ${projects.map(p => p.name).join(", ")}`;
  return `no project named ${JSON.stringify(name)} on this workspace; ${held}`;
}

/** The project a thread on the workspace starts in when nothing names a folder outright: the one named, else the
 * one last used on that workspace (the preferences record's project entry), else the only one, else none, which
 * leaves the kind's own folder to the runtime. A name the caller gave is refused when the workspace lacks it, since
 * a thread started elsewhere in silence is the bug this rule exists to end; a remembered name the workspace no
 * longer holds drops through, as a stale access pick does. */
export function projectFor(projects: readonly WorkspaceProject[], pick: { named: string | undefined; last: string | undefined }): WorkspaceProject | null {
  if (pick.named !== undefined) {
    const found = projects.find(p => p.name === pick.named);
    if (found === undefined) throw new Error(noProjectLine(pick.named, projects));
    return found;
  }
  return projects.find(p => p.name === pick.last) ?? (projects.length === 1 ? projects[0]! : null);
}

/** The project a folder belongs to: the one whose folder it is or sits under, the nearest when projects nest, none
 * when it sits outside them all. The thread row's word and the runtime's memory of which project a start used both
 * read this, so a thread opened deep inside a project still counts as that project's. */
export function projectAt(projects: readonly WorkspaceProject[], folder: string | undefined): WorkspaceProject | null {
  if (folder === undefined) return null;
  let found: WorkspaceProject | null = null;
  for (const project of projects) if (underProject(folder, project.dest) && (found === null || project.dest.length > found.dest.length)) found = project;
  return found;
}

/** The count a workspace listing shows for its projects: nothing where there are none, so a row without projects
 * stays quiet, and the number where there are. */
export function projectCountCell(projects: readonly WorkspaceProject[]): string {
  return projects.length === 0 ? "" : String(projects.length);
}
