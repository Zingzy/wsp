// SPDX-License-Identifier: AGPL-3.0-only
// The projects a workspace holds and the one rule for which of them a thread
// starts in. The runtime applies the rule to every start and every command,
// the composer shows its answer under the box, and the command line refuses a
// name before a machine is woken for it; all three read it from here so no
// road can start a thread somewhere another road would not.
import { THIS_COMPUTER } from "./format.js";
import type { Preferences, WorkspaceKind, WorkspaceProject, WorkspaceView } from "./index.js";
import { folderName, underProject } from "./project-path.js";
import { shellQuote } from "./shell-quote.js";
import { kindWords, workspaceKind, type WorkspaceKindWords } from "./workspace-state.js";

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

/** A path as the machine's own shell would show it: `~` for its home and anything under it, the path as given
 * elsewhere or where the home is not known. */
export function homeShortened(path: string, home: string | undefined): string {
  if (home === undefined || !underProject(path, home)) return path;
  return path === home ? "~" : `~${path.slice(home.length)}`;
}

/** The words on a workspace row while a folder is dragged over the window: what a drop there does, by the kind's
 * import road; nothing for a kind without one, whose row stays a row. */
export function dropTileLine(kind: WorkspaceKind, workspaceName: string): string | null {
  switch (kindWords(kind).imports) {
    case "copies":
      return `import to ${workspaceName}`;
    case "registers":
      return `register on ${THIS_COMPUTER}`;
    case null:
      return null;
  }
}

/** What a drop that was not a folder is refused with: a project is a folder, and a file dropped on a tile is not one. */
export const DROP_A_FOLDER_LINE = "drop a folder; a project is a folder, not a file";

/** What a register says as it starts: the folder is on this computer already, so its path is recorded and nothing moves. */
export const REGISTERING_LINE = "already on this computer, registering";

/** What a register says when it has landed. */
export function registeredLine(dest: string): string {
  return `${folderName(dest)} registered at ${dest}; nothing was copied.`;
}

/** The line under an import that named no workspace: where it goes instead, and why that one. */
export function lastTargetLine(workspaceName: string): string {
  return `importing to ${workspaceName}, the workspace the last thread started on`;
}

/** What a fork of a project golden starts with, after the created line; nothing for an image carrying none. */
export function projectsInPlace(projects: readonly WorkspaceProject[]): string {
  return projects.length === 0 ? "" : ` with ${projects.map(p => p.name).join(", ")} in place`;
}

/** The name a fork of a project golden goes by: the newest project it carries, which is also the name `new --from`
 * takes for it; the snapshot id where a manifest carries none. */
export function goldenForkName(g: { projects: readonly WorkspaceProject[]; snapshotId: string }): string {
  return g.projects.at(-1)?.name ?? g.snapshotId;
}

/** Why an import onto this computer takes no consent flags: nothing is carried, cut, sent or replaced by a register. */
export function registerTakesNoConsentLine(flags: readonly string[]): string {
  return `${flags.join(", ")} ${flags.length === 1 ? "has" : "have"} no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced`;
}

/** The first line of a thread opened from inside a repo with no workspace named: where it went. */
export function threadOpenedLine(threadId: string, workspaceName: string, folder: string): string {
  return `thread ${threadId} on ${workspaceName} in ${folder}`;
}

/** Why a run from inside a folder no workspace holds a project for opens nothing, with both roads out; `named` is the
 * caller's word for naming a workspace (`--in <workspace>` on the command line, `workspace` on the tool). */
export function noWorkspaceForFolderLine(folder: string, named: string): string {
  return `no workspace holds a project for ${folder}; name one with ${named}, or wsp import ${shellQuote(folder)} --to <workspace> lands it there`;
}

/** The workspace a folder on this computer belongs to, and the project it is there as, for a thread opened with no
 * workspace named. A kind that registers a folder holds it at its own path, so it matches by path alone, and a copy
 * registered here wins outright: the folder is that project on this computer. A kind that copies holds the folder
 * at a path of its own (a real import lands it at the same path, but that says nothing about where it last ran),
 * so it matches by the folder's name, and among the copies the workspace the last thread anywhere started in it on
 * (the target) decides, else the one whose last thread ran in it, else the first that holds it, in listing order;
 * none when no workspace has it. */
export function workspaceForFolder<W extends Pick<WorkspaceView, "id" | "kind" | "projects">>(workspaces: readonly W[], folder: string, preferences: Pick<Preferences, "project" | "target">): { workspace: W; project: WorkspaceProject } | null {
  const name = folderName(folder);
  const road = (workspace: W): WorkspaceKindWords["imports"] => kindWords(workspaceKind(workspace)).imports;
  const holds = (workspace: W, p: WorkspaceProject): boolean => (road(workspace) === "copies" ? p.name === name : p.dest === folder);
  const held = workspaces.flatMap(workspace => workspaceProjects(workspace).filter(p => holds(workspace, p)).map(project => ({ workspace, project })));
  if (held.length === 0) return null;
  const registered = held.find(h => road(h.workspace) === "registers");
  if (registered !== undefined) return registered;
  const target = preferences.target;
  const targeted = target?.project === name ? held.find(h => h.workspace.id === target.workspace) : undefined;
  return targeted ?? held.find(h => preferences.project[h.workspace.id] === h.project.name) ?? held[0]!;
}

/** Why a thread opened with no workspace named, from a folder that is not inside a repo, opens nothing; `named` is
 * the caller's word for naming one (`--in <workspace>` on the command line, `workspace` on the tool). */
export function noThreadTargetLine(named: string): string {
  return `${named} is needed outside a repo: run from inside a repo one of the workspaces holds, or name the workspace`;
}

/** Why an import that named no workspace goes nowhere before any thread has started. */
export function noLastTargetLine(named: string): string {
  return `${named} is needed: no thread has started yet, so there is no last workspace to import to`;
}
