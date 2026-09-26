// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's tree, read once for every surface that draws it: which project
// holds which workspaces, which thread opened which, and which workspace an
// agent forked out of a thread, which is drawn under that thread.
// The runtime stamps the opener on the thread it opened and nothing else
// records it, so parentThreadId is the only field read here and a name, a
// folder or a shared workspace never stands in for it. A thread joins the rows
// of the workspace its opener is drawn among, however many steps up that is,
// while the workspace its session is filed under stays what its meta names and
// what selecting it opens: the two are the same thread's two facts and a
// surface needs both.
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { workspaceRowId } from "./rowGrammar.js";
import { isThreadArchived, isThreadWorking, nestSpawnedThreads, sortSettledThreadsForSidebar, sortThreadsForSidebar, threadForest, type ThreadNode } from "./Sidebar.logic.js";

/** One project of the sidebar: the record the host holds for it, and its workspaces. */
export interface ProjectGroup {
  readonly project: ProjectRef;
  readonly workspaces: ReadonlyArray<SidebarProjectSnapshot>;
}

/** What a project row needs to draw itself, whether the host's projects list has arrived or not: a workspace
 * carries its project's id and name, which is enough for a header, and the record adds the computer it lives on. */
export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly computer?: string;
}

/** The projects the sidebar's picker lists, in the order the host holds them, each with its workspaces. A workspace
 * whose project the host's list does not carry keeps a project of its own off its own record, so a list that has
 * not arrived, or a workspace of a project another computer holds, is never left out. */
export function projectGroups(recorded: ReadonlyArray<ProjectView>, rows: ReadonlyArray<SidebarProjectSnapshot>): ProjectGroup[] {
  const groups = new Map<string, { project: ProjectRef; workspaces: SidebarProjectSnapshot[] }>();
  for (const project of recorded) groups.set(project.id, { project: { id: project.id, name: project.name, computer: project.computer }, workspaces: [] });
  for (const row of rows) {
    const own = row.workspace.project;
    const group = groups.get(own.id) ?? { project: { id: own.id, name: own.name, computer: own.computer }, workspaces: [] };
    groups.set(own.id, group);
    group.workspaces.push(row);
  }
  return [...groups.values()];
}

/** A thread with the workspace it runs on, which is not always the workspace whose rows it is drawn among. */
export interface ThreadOnWorkspace {
  readonly thread: SidebarThreadSnapshot;
  readonly runs: SidebarProjectSnapshot;
}

/** One workspace's rows: its own threads whose opener is not on another workspace, and every thread its own
 * threads opened elsewhere. Each workspace keeps a group even when it has no rows left to draw. */
export interface ThreadTreeGroup {
  readonly project: SidebarProjectSnapshot;
  readonly threads: ReadonlyArray<SidebarThreadSnapshot>;
}

/** The workspace a thread runs on, by the id its session carries. */
export function workspaceOf(
  projects: ReadonlyArray<SidebarProjectSnapshot>,
  thread: Pick<SidebarThreadSnapshot, "workspaceId">,
): SidebarProjectSnapshot | undefined {
  return projects.find(project => project.id === thread.workspaceId);
}

/** The threads one thread's own agent opened, each with the workspace it runs on, in the order the workspaces are
 * drawn in. The transcript row and the footer's total both read this, so a thread named in one is named in both. */
export function threadsOpenedBy(projects: ReadonlyArray<SidebarProjectSnapshot>, openerThreadId: string): ThreadOnWorkspace[] {
  return projects.flatMap(project =>
    project.threads.filter(thread => thread.parentThreadId === openerThreadId).map(thread => ({ thread, runs: project })),
  );
}

/** The thread that opened this one, with the workspace it runs on, which is the other way along the same edge
 * threadsOpenedBy walks. Nothing for a thread nobody opened, and nothing while the opener's own workspace has not
 * arrived: a name is only drawn for an opener a click can reach. */
export function openedBy(
  projects: ReadonlyArray<SidebarProjectSnapshot>,
  thread: Pick<SidebarThreadSnapshot, "parentThreadId">,
): ThreadOnWorkspace | undefined {
  const opener = thread.parentThreadId;
  if (opener === null) return undefined;
  for (const project of projects) {
    const found = project.threads.find(row => row.id === opener);
    if (found !== undefined) return { thread: found, runs: project };
  }
  return undefined;
}

/** Every workspace with the threads its rows draw, each spawned thread behind the thread that opened it. A surface
 * that sorts the rows itself (the sidebar parts the working ones from the idle shelf) nests them again after; one
 * that lists them as they come reads the tree from here. */
export function threadTree(projects: ReadonlyArray<SidebarProjectSnapshot>): ThreadTreeGroup[] {
  const byId = new Map<string, SidebarThreadSnapshot>();
  for (const project of projects) for (const thread of project.threads) byId.set(thread.id, thread);
  // A workspace an agent forked has a row of its own under the thread that forked it, so its threads stay on it
  // rather than joining the rows of the workspace that thread runs on: the row is already one step in there.
  const forks = new Set(projects.filter(project => project.workspace.parentThreadId !== undefined).map(project => project.id));
  const groups = new Map<string, SidebarThreadSnapshot[]>(projects.map(project => [project.id, []]));
  for (const project of projects) {
    // drawnUnder answers the workspace of a thread one of these projects holds, so every group it names is here.
    for (const thread of project.threads) groups.get(drawnUnder(thread, byId, forks))!.push(thread);
  }
  return projects.map(project => ({ project, threads: nestSpawnedThreads(groups.get(project.id)!) }));
}

/** The workspace whose rows a thread joins: its own where that workspace is a fork with a row of its own, else
 * the one its opener joins, up the chain to the thread a person or the command line opened. A chain that leads
 * round in a circle leaves the thread on its own workspace, since a thread nobody can reach is worse than one
 * drawn where it runs. */
function drawnUnder(thread: SidebarThreadSnapshot, byId: ReadonlyMap<string, SidebarThreadSnapshot>, forks: ReadonlySet<string>): string {
  if (forks.has(thread.workspaceId)) return thread.workspaceId;
  const seen = new Set<string>([thread.id]);
  let at = thread;
  for (;;) {
    const opener = at.parentThreadId === null ? undefined : byId.get(at.parentThreadId);
    if (opener === undefined) return at.workspaceId;
    if (seen.has(opener.id)) return thread.workspaceId;
    seen.add(opener.id);
    at = opener;
  }
}

/** One tile of the sidebar: a thread with the workspace it runs on, or a workspace that holds no thread yet, which
 * is drawn as a tile of its own so no copy the host holds is out of reach. `parentThreadId` is the thread it hangs
 * under: its opener, else the thread that forked its workspace. */
export interface TileItem {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly startedAt: string | null;
  readonly runs: SidebarProjectSnapshot;
  readonly thread: SidebarThreadSnapshot | null;
}

export type TileNode = ThreadNode<TileItem>;

/** The sidebar's list: root tiles across every workspace newest first, each with the tiles its agents opened under
 * it, parted into the live list and the Settled fold, which holds every root whose whole tree is threads that have
 * been quiet a day. Under a picked project only that project's roots are listed, children kept wherever they run. */
export function sidebarTiles(projects: ReadonlyArray<SidebarProjectSnapshot>, { picked, nowMs }: { picked: string | null; nowMs: number }): { live: TileNode[]; settled: TileNode[] } {
  const items = projects.flatMap((runs): TileItem[] => {
    const forkedBy = runs.workspace.parentThreadId ?? null;
    if (runs.threads.length === 0) return [{ id: workspaceRowId(runs.id), parentThreadId: forkedBy, startedAt: runs.workspace.createdAt, runs, thread: null }];
    return runs.threads.map(thread => ({ id: thread.id, parentThreadId: thread.parentThreadId ?? forkedBy, startedAt: thread.startedAt, runs, thread }));
  });
  const roots = threadForest(sortThreadsForSidebar(items)).filter(node => picked === null || node.thread.runs.workspace.project.id === picked);
  const live: TileNode[] = [];
  const settled: TileNode[] = [];
  for (const node of roots) (isQuiet(node, nowMs) ? settled : live).push(node);
  const bySettle = new Map(settled.map(node => [node.thread.thread!, node]));
  return { live, settled: sortSettledThreadsForSidebar([...bySettle.keys()]).map(thread => bySettle.get(thread)!) };
}

/** Every tile of the tree is a thread with nothing running, nothing asked and a day since it last moved. */
function isQuiet({ thread: { thread }, children }: TileNode, nowMs: number): boolean {
  if (thread === null || thread.asking !== null || isThreadWorking(thread) || !isThreadArchived(thread, nowMs)) return false;
  return children.every(child => isQuiet(child, nowMs));
}
