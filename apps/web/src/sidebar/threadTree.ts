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
import { ThreadSection, type ProjectView, type ThreadMarks, type ThreadPlacement } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { workspaceRowId } from "./rowGrammar.js";
import { isThreadSettleable, isThreadSettled, isThreadWorking, nestSpawnedThreads, sortSettledThreadsForSidebar, sortThreadsForSidebar, threadForest, threadSection, type ThreadNode } from "./Sidebar.logic.js";

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

/** The projects the sidebar's picker lists, in the order the person dragged them into and then in the order the host
 * holds them, each with its workspaces. A workspace whose project the host's list does not carry keeps a project of
 * its own off its own record, so a list that has not arrived, or a workspace of a project another computer holds, is
 * never left out. */
export function projectGroups(recorded: ReadonlyArray<ProjectView>, rows: ReadonlyArray<SidebarProjectSnapshot>, order: ReadonlyArray<string>): ProjectGroup[] {
  const groups = new Map<string, { project: ProjectRef; workspaces: SidebarProjectSnapshot[] }>();
  for (const project of recorded) groups.set(project.id, { project: { id: project.id, name: project.name, computer: project.computer }, workspaces: [] });
  for (const row of rows) {
    const own = row.workspace.project;
    const group = groups.get(own.id) ?? { project: { id: own.id, name: own.name, computer: own.computer }, workspaces: [] };
    groups.set(own.id, group);
    group.workspaces.push(row);
  }
  return inProjectOrder([...groups.values()], group => group.project.id, order);
}

/** Things keyed by project in the order the person dragged the projects into, an id they no longer hold skipped, and
 * then the rest as they came: the one rule every list of projects is drawn by. */
export function inProjectOrder<T>(items: ReadonlyArray<T>, idOf: (item: T) => string, order: ReadonlyArray<string>): T[] {
  const placed = order.flatMap(id => items.filter(item => idOf(item) === id));
  return [...placed, ...items.filter(item => !placed.includes(item))];
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
  /** Set on the head of the threads one send to several models opened, and nowhere else: the title they share, drawn
   * once over them. Such a head holds no thread of its own; its children are those threads. */
  readonly groupTitle?: string;
  /** Set on the root of a snoozed tree while threads of it run: how many, drawn quietly on the one tile the tree
   * keeps, so a thread working under a snooze is still reachable through its root. */
  readonly snoozedWorking?: number;
  /** Set with it: the fold keys of every thread the folded tree holds, the root first, so the root reads as selected
   * while one of them is open in the centre. */
  readonly holds?: readonly string[];
}

export type TileNode = ThreadNode<TileItem>;

/** The sections of the live list, in the order they are drawn: the pinned trees, the trees waiting on the person,
 * then every other live tree in one list, each row saying for itself whether it works or is done. */
export type SidebarSection = "pinned" | "needs-you" | "threads";
export const SIDEBAR_SECTIONS: readonly SidebarSection[] = ["pinned", "needs-you", "threads"];

/** The section a tree's state, or a placement's name, is drawn in. */
const listOf = (section: ThreadSection): SidebarSection => (section === "needs-you" ? "needs-you" : "threads");

/** One section of the live list and the roots it holds, each with its tree. */
export interface TileSection {
  readonly id: SidebarSection;
  readonly roots: TileNode[];
}

/** The sidebar's list: root tiles across every workspace newest first, each with the tiles its agents opened under
 * it, parted into the live list and the Settled fold, which holds every root whose whole tree is settled threads.
 * The live list is drawn in sections, and `live` is every root of them in the order they are drawn. A snoozed tree
 * is in neither until its snooze ends or a thread of it needs the person, but while a thread of it runs its root
 * stands alone at the foot of the list carrying how many work. Under a picked project only that project's
 * roots are listed, children kept wherever they run. */
export function sidebarTiles(
  projects: ReadonlyArray<SidebarProjectSnapshot>,
  { picked, nowMs, open = null, settleMs }: { picked: string | null; nowMs: number; /** The thread open in the centre, by fold key. */ open?: string | null; /** How long a read thread sits quiet before it settles, null for never; absent, the record's default. */ settleMs?: number | null },
): { live: TileNode[]; settled: TileNode[]; sections: TileSection[] } {
  const items = projects.flatMap((runs): TileItem[] => {
    const forkedBy = runs.workspace.parentThreadId ?? null;
    if (runs.threads.length === 0) return [{ id: workspaceRowId(runs.id), parentThreadId: forkedBy, startedAt: runs.workspace.createdAt, runs, thread: null }];
    return runs.threads.map(thread => ({ id: thread.id, parentThreadId: thread.parentThreadId ?? forkedBy, startedAt: thread.startedAt, runs, thread }));
  });
  const roots = attemptGroups(threadForest(sortThreadsForSidebar(items)).filter(node => picked === null || node.thread.runs.workspace.project.id === picked));
  const filed = new Map<SidebarSection, TileNode[]>(SIDEBAR_SECTIONS.map(id => [id, []]));
  const settled: TileNode[] = [];
  const snoozedWorking: TileNode[] = [];
  for (const node of roots) {
    if (isSnoozed(node)) {
      const working = workingIn(node);
      if (working > 0) snoozedWorking.push({ thread: { ...node.thread, snoozedWorking: working, holds: treeThreadIds(node) }, children: [] });
      continue;
    }
    const pinned = node.thread.thread?.pinnedAt != null;
    if (everyTile(node, thread => isThreadSettled(thread, nowMs, pinned || thread.id === open, settleMs))) settled.push(node);
    else filed.get(pinned ? "pinned" : listOf(sectionOf(node)))!.push(node);
  }
  filed.get("threads")!.push(...snoozedWorking);
  filed.get("pinned")!.sort((a, b) => b.thread.thread!.pinnedAt!.localeCompare(a.thread.thread!.pinnedAt!));
  const sections = SIDEBAR_SECTIONS.map(id => ({ id, roots: filed.get(id)! })).filter(section => section.roots.length > 0);
  const bySettle = new Map(settled.map(node => [node.thread.thread!, node]));
  return { live: sections.flatMap(section => section.roots), settled: sortSettledThreadsForSidebar([...bySettle.keys()]).map(thread => bySettle.get(thread)!), sections };
}

/** The roots one send to several models opened, as one node where the first of them stands in the list: a head named
 * by the thread the send opened first, and under it each of them in the order they were opened. An attempt down to
 * one root, the others deleted, is that root alone again. */
function attemptGroups(roots: ReadonlyArray<TileNode>): TileNode[] {
  const members = new Map<string, TileNode[]>();
  for (const node of roots) {
    const attempt = node.thread.thread?.attempt;
    if (attempt != null) members.set(attempt, [...(members.get(attempt) ?? []), node]);
  }
  const drawn = new Set<string>();
  return roots.flatMap((node): TileNode[] => {
    const attempt = node.thread.thread?.attempt;
    const group = attempt == null ? undefined : members.get(attempt)!;
    if (attempt == null || group === undefined || group.length < 2) return [node];
    if (drawn.has(attempt)) return [];
    drawn.add(attempt);
    const opened = [...group].sort((a, b) => (a.thread.startedAt ?? "").localeCompare(b.thread.startedAt ?? ""));
    const first = opened[0]!.thread;
    return [{ thread: { id: `attempt:${attempt}`, parentThreadId: null, startedAt: first.startedAt, runs: first.runs, thread: null, groupTitle: first.thread!.title }, children: opened }];
  });
}

const SECTION_RANK: readonly ThreadSection[] = ThreadSection.options;

/** The section a tree's state files it under: the most pressing of its threads', a workspace with no thread yet
 * resting in Idle. */
function treeSection({ thread: { thread }, children }: TileNode): ThreadSection {
  const own = thread === null ? "idle" : threadSection(thread);
  return children.map(treeSection).reduce((best, next) => (SECTION_RANK.indexOf(next) < SECTION_RANK.indexOf(best) ? next : best), own);
}

/** The state a placement holds while: the tree's section and its root's latest turn, so the tree moving to another
 * section or its root taking a new turn both lapse it. */
const placementKey = (node: TileNode): string => `${treeSection(node)}:${node.thread.thread?.sessionId ?? node.thread.id}`;

/** What dropping a root tree into a section writes: the section, held while the tree is as it is now. */
export function placementFor(node: TileNode, name: ThreadSection): ThreadPlacement {
  return { name, whileState: placementKey(node) };
}

/** What dropping a root tree on a section writes: a pin for Pinned; for any other the pin taken off where it had one,
 * and a placement there, or the placement taken off where the section is its state's own. A tree that asks, dropped
 * on the list, is placed in Idle, which the list draws. Null for a drop that changes nothing. */
export function dropMarks(node: TileNode, section: SidebarSection): ThreadMarks | null {
  const thread = node.thread.thread;
  if (thread === null) return null;
  const pinned = thread.pinnedAt != null;
  if (section === "pinned") return pinned ? null : { pinned: true };
  const own = listOf(treeSection(node)) === section;
  if (own && !pinned && thread.section == null) return null;
  return { ...(pinned ? { pinned: false } : {}), section: own ? null : placementFor(node, section === "needs-you" ? "needs-you" : "idle") };
}

/** The section a root tree is drawn in: where the person dragged it while that still holds, else its state's. */
function sectionOf(node: TileNode): ThreadSection {
  const placed = node.thread.thread?.section;
  return placed != null && placed.whileState === placementKey(node) ? placed.name : treeSection(node);
}

/** How many threads of a tree are working, the root's own included. */
const workingIn = ({ thread: { thread }, children }: TileNode): number => (thread !== null && isThreadWorking(thread) ? 1 : 0) + children.reduce((sum, child) => sum + workingIn(child), 0);

/** A tree whose root is snoozed and none of whose threads needs the person, which the list leaves out. */
function isSnoozed(node: TileNode): boolean {
  const needs = ({ thread: { thread }, children }: TileNode): boolean => thread?.needsYou === true || children.some(needs);
  return node.thread.thread?.snoozedUntil != null && !needs(node);
}

/** Every tile of the live list in the order it draws them, each tree's children under its root. */
export function drawnTiles(live: ReadonlyArray<TileNode>): TileItem[] {
  return live.flatMap(({ thread, children }) => [thread, ...drawnTiles(children)]);
}

/** The next tile after the one named, in the order the live list draws them, children included, whose thread needs
 * the person, wrapping to the top; the first there is when the one named is not drawn or none is named. */
export function nextNeedsYou(live: ReadonlyArray<TileNode>, fromId: string | null): TileItem | undefined {
  const drawn = drawnTiles(live);
  const at = drawn.findIndex(item => item.id === fromId);
  return [...drawn.slice(at + 1), ...drawn.slice(0, at + 1)].find(item => item.thread?.needsYou === true);
}

/** Every tile of the tree is a thread, and each passes the test; a workspace tile with no thread passes none. A group's
 * head is no tile, so a group passes when its threads all do. */
function everyTile({ thread: { thread, groupTitle }, children }: TileNode, test: (thread: SidebarThreadSnapshot) => boolean): boolean {
  const own = thread !== null ? test(thread) : groupTitle !== undefined;
  return own && children.every(child => everyTile(child, test));
}

/** The fold keys of every thread a tree holds, the root first: what a settle of the root sends. */
export function treeThreadIds({ thread: { thread }, children }: TileNode): string[] {
  return [...(thread === null ? [] : [thread.id]), ...children.flatMap(treeThreadIds)];
}

/** The workspaces a tree's threads run in, each once: the copies a Delete copies takes. */
export function treeWorkspaceIds(node: TileNode): string[] {
  const ids = (n: TileNode): string[] => [n.thread.runs.id, ...n.children.flatMap(ids)];
  return [...new Set(ids(node))];
}

/** What a settle of a root takes: every thread of its tree, and whether one of them is working, which holds it. */
export function treeSettle(node: TileNode): { threadIds: string[]; working: boolean } {
  const works = ({ thread: { thread }, children }: TileNode): boolean => (thread !== null && isThreadWorking(thread)) || children.some(works);
  return { threadIds: treeThreadIds(node), working: works(node) };
}

/** The live roots "Settle all read" takes: every tree whose threads have all been read and are quiet. */
export function settleableRoots(live: ReadonlyArray<TileNode>): TileNode[] {
  return live.filter(node => everyTile(node, isThreadSettleable));
}

/** The root tree a thread hangs in, among the roots given; undefined for a thread none of them holds. */
export function rootHolding(roots: ReadonlyArray<TileNode>, threadId: string): TileNode | undefined {
  const holds = (node: TileNode): boolean => node.thread.thread?.id === threadId || node.children.some(holds);
  return roots.find(holds);
}
