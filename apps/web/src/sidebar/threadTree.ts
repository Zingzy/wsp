// SPDX-License-Identifier: AGPL-3.0-only
// Which thread opened which, read once for every surface that draws the tree.
// The runtime stamps the opener on the thread it opened and nothing else
// records it, so parentThreadId is the only field read here and a name, a
// folder or a shared workspace never stands in for it. A thread joins the rows
// of the workspace its opener is drawn among, however many steps up that is,
// while the workspace its session is filed under stays what its meta names and
// what selecting it opens: the two are the same thread's two facts and a
// surface needs both.
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { nestSpawnedThreads } from "./Sidebar.logic.js";

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

/** Every workspace with the threads its rows draw, each spawned thread behind the thread that opened it. A surface
 * that sorts the rows itself (the sidebar parts the working ones from the idle shelf) nests them again after; one
 * that lists them as they come reads the tree from here. */
export function threadTree(projects: ReadonlyArray<SidebarProjectSnapshot>): ThreadTreeGroup[] {
  const byId = new Map<string, SidebarThreadSnapshot>();
  for (const project of projects) for (const thread of project.threads) byId.set(thread.id, thread);
  const groups = new Map<string, SidebarThreadSnapshot[]>(projects.map(project => [project.id, []]));
  for (const project of projects) {
    // drawnUnder answers the workspace of a thread one of these projects holds, so every group it names is here.
    for (const thread of project.threads) groups.get(drawnUnder(thread, byId))!.push(thread);
  }
  return projects.map(project => ({ project, threads: nestSpawnedThreads(groups.get(project.id)!) }));
}

/** The workspace whose rows a thread joins: its own, or the one its opener joins, up the chain to the thread a
 * person or the command line opened. A chain that leads round in a circle leaves the thread on its own workspace,
 * since a thread nobody can reach is worse than one drawn where it runs. */
function drawnUnder(thread: SidebarThreadSnapshot, byId: ReadonlyMap<string, SidebarThreadSnapshot>): string {
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
