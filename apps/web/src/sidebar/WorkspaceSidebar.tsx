// SPDX-License-Identifier: AGPL-3.0-only
// The left region. Fixed at the top: the New thread row, the search row, and
// the project switcher, "All projects" or the one project the list is filtered
// to. Under them, scrolling:
// every root thread as a tile under its section (Pinned, Needs you as an inbox of
// each thread that needs the person, then the one list), newest first inside each
// across every workspace, the threads and subagents its agent opened under it on
// the rail as LeadTree draws them, folded by the host's mark, and at the foot the Settled fold
// holding every root whose whole tree is settled, by hand or by quiet after a
// read, with "Settle all read" on its own row's menu and on the list's own, which
// stands while no Settled row is drawn. A root tile is dragged
// onto another section to hold it there, onto Pinned to pin it and onto the
// fold to settle it; while one is dragged every section stands to take it. A machine
// with no thread yet is a tile of its own, a folder's record with none is no tile,
// and a workspace being made is a tile-shaped placeholder. The first tile of a copy in a tree carries every
// one of that copy's verbs in its menu after the thread's own. On a wsp with no project
// the body holds one row that points at the first run in the centre. The
// computer switcher under the project switcher narrows the list to the work on
// one computer. Keyboard
// traversal, the forget of a gone copy and the project trips' dialogs live
// here; the tiles are ThreadTile beside this file. The surface itself is the
// shell's sidebar-glass: nothing here paints a background.
import { openCommandPalette } from "../commandPaletteBus.js";
import { openProjectSettings } from "../settings/openAt.js";
import { ChevronDownIcon, CopyIcon, PlusIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HOST_ASLEEP_LINE, SETTLE_MS, copiesFolder, isHere, kindForComputer, modelOf, runsInFolder, modelPicks, workspaceKind, workspaceState, type WorkspaceState, type WorkspaceView } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { THREAD_TREE_WORKING, rebuildRefusedLine, rowNewThread } from "../actions/format.js";
import { CREATE_ASKED, CREATE_STEP_WORDS, currentStep, stepWords, stoppedStep } from "../shell/creationLog.js";
import { actionById, actionIfAny, resolveActions, type ResolvedAction } from "../actions/registry.js";
import { projectActions, type ProjectVerbs } from "../actions/projectActions.js";
import { MOVE_KEYS, settleSaying, settledFoldActions, threadActions, threadTarget, type ThreadVerbs } from "../actions/threadActions.js";
import { matchesShortcut } from "../keybindings.js";
import { useChildVerbs, useThreadVerbs, useWorkspaceVerbs } from "../actions/verbs.js";
import { childActs, finishedTake, kindOf, leadActs, leadNodes, type ChildPart } from "../components/threads/leadTree.js";
import { workspaceActions, workspaceTarget } from "../actions/workspaceActions.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { ForgetWorkspaceDialog } from "../components/ForgetWorkspaceDialog.js";
import { SidebarContent, SidebarMenuButton } from "../components/ui/sidebar.js";
import { useWarmTiles } from "../components/chat/warmTiles.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { cn } from "../lib/utils.js";
import { addNotice } from "../notices/store.js";
import { catalogIn, useLaunches, useProjectsRead, useProjectsRefused, useReady, useSelectedId, useSelectedSubagent, useSelectedThreadId, useSelectedWorkspaceId, useSidebarProjects, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { hostAsleep } from "../boot.js";
import { onAddProjectRequest, onForgetWorkspaceRequest, onProjectTripRequest, onRenameWorkspaceRequest, requestAddProject, type ProjectTripRequest } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { AddProjectDialog } from "./AddProjectDialog.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ComputerSwitcher } from "./ComputerSwitcher.js";
import { COMPUTER_PICK_KEY, PROJECT_PICK_KEY, pickCodec, underPicks } from "./picks.js";
import { CHILD_LIST_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, SETTLED_ROW_ID, sectionRowId, threadRowId, workspaceRowId } from "./rowGrammar.js";
import { NewThreadRow } from "./NewThreadRow.js";
import { SearchRow } from "./SearchRow.js";
import { resolveAdjacentThreadId, threadSection, topSidebarThread } from "./Sidebar.logic.js";
import { SIDEBAR_SECTIONS, drawnCount, drawsUnder, dropMarks, nodeOf, settleableRoots, sidebarTiles, tileTree, treeSettle, treeThreadIds, treeWorkspaceIds, type ProjectGroup, type SidebarSection, type TileNode } from "./threadTree.js";
import { LeadTree, rowsUnder, settlesOnHover } from "./LeadTree.js";
import { useTreeDrag, type DropTree } from "./treeDrag.js";
import { holdLiveRegion, moveRoot, rootPlaces } from "./treeMoves.js";
import { rootThreads } from "./treeOrder.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import { SidebarCorner } from "./SidebarCorner.js";
import { UpdateCard } from "./UpdateCard.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { CreationTile, ThreadLaunchTile, ThreadTile, WorkspaceTile, useTileHandlers, type TilePlace } from "./ThreadTile.js";
import { computerName, computerOf, copyName, placeNames } from "./workspaceRows.js";
import { tileCheckout, useCheckoutAsks } from "./tileCheckout.js";
import { restingAge } from "../components/status/restingAge.js";
import { PROJECT_WORDS, SECTION_WORDS } from "./words.js";
import { SectionRow } from "./SectionRow.js";
import { SettingUpSection } from "./SettingUpSection.js";

type Fold = SidebarSection | "settled" | "setting-up";
/** The folds a head can make: the one list has no head, so it never folds. */
const FOLDS: readonly Fold[] = ["pinned", "needs-you", "settled", "setting-up"];
/** The sections a person has folded by their heads. Settled starts folded, since it holds the tiles a person has
 * stopped looking at; every live section starts open. */
const FOLDED_KEY = "wsp:sidebar-folded";
const foldedCodec: Codec<readonly Fold[]> = {
  // A section the sidebar no longer has is dropped, not a refusal of the list: a refusal pins every fold at its
  // default and no click can store another (the cut to three sections stranded Settled folded on 2026-10-01).
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`Expected a list of section ids, got ${raw}.`);
    return parsed.filter((id): id is Fold => (FOLDS as readonly unknown[]).includes(id));
  },
  encode: value => JSON.stringify(value),
};

/** A double-click on the name opens the box the menu's Rename opens, and only where that action can run: a refused
 * rename leaves the name as text, so nothing opens a field the runtime would turn away. */
const openerOf = (rename: ResolvedAction): (() => void) | undefined => (rename.refusal === null ? () => void runAction(rename) : undefined);

/** The machine one workspace runs on, read per tile off the workspace that tile's thread runs on: what a rename has
 * to reach. */
interface RowMachine {
  readonly state: WorkspaceState;
  readonly goneWords?: string | undefined;
}

/** Whether a tree holds the thread, at any depth. */
const holds = (node: TileNode, threadId: string): boolean => node.thread.id === threadId || node.children.some(child => holds(child, threadId));

/** Every tile a settled tree holds, itself included, each drawn in the Settled fold; a group's head is no tile. */
const tileCount = (node: TileNode): number => (node.thread.groupTitle === undefined ? 1 : 0) + node.children.reduce((sum, child) => sum + tileCount(child), 0);

/** A project trip's dialog open for one workspace; keyed per opening so its folder and plan reset. */
interface ProjectTripState extends ProjectTripRequest {
  readonly key: number;
}

/** The copies one send to several models made, under one head: the sidebar's one-line row, the task's name, how many
 * copies it holds, and the chevron that folds them, so the group reads as a row a person can act on rather than a
 * title standing above a list. Its tiles keep the tile's own pitch on the rail. */
function AttemptGroup({ title, copies, root, children }: { title: string; copies: number; root?: { id: string; drags: boolean } | undefined; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <li data-thread-item data-attempt-group className={cn("min-w-0", ROOT_ITEM_CLASS)} {...(root === undefined ? {} : { "data-root": root.id })}>
      <SidebarMenuButton size="sm" data-attempt-head aria-expanded={open} className={ONE_LINE_ROW_CLASS} onClick={() => setOpen(was => !was)} {...(root?.drags === true ? { draggable: true } : {})}>
        <CopyIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span data-attempt-title className="min-w-0 flex-1 truncate text-sidebar-foreground" title={title}>
          {title}
        </span>
        <span data-attempt-count className={cn(ROW_META_CLASS, "shrink-0")}>
          {copies}
        </span>
        <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 transition-transform duration-150", !open && "-rotate-90")} />
      </SidebarMenuButton>
      {open ? <ul className={CHILD_LIST_CLASS}>{children}</ul> : null}
    </li>
  );
}

/** A root's item while its tree is dragged: its tile at half opacity and its tree folded, still mounted, so the drag
 * draws nothing and a drop or an Escape opens it again as it was. */
const ROOT_ITEM_CLASS = "data-[drag-source]:[&>:first-child]:opacity-50 data-[drag-source]:[&>ul]:hidden";
/** A head or a section that stands only while a tree is dragged: no box, so no screen reader reaches it, and its head
 * carries no row id, so the keys pass it, until the drag's frame shows it. */
const DROP_ONLY_CLASS = "hidden data-[drop-shown]:block";
/** The fill a head under a dragged tree takes, today's row hover. */
const DROP_OVER_CLASS = "rounded-[var(--control-radius)] transition-colors duration-150 data-[drop-over]:bg-sidebar-row-hover";

/** The thread's acts a tile's draw reads: Stop and Settle for its slot, Rename for a double-click on its name. */
const DRAWN_ACTS = threadActions.filter(entry => entry.id === "stop" || entry.id === "settle" || entry.id === "rename");

/** The workspace entries a project's row leaves off its folder's: renaming and removing a record no row shows. */
const FOLDER_LEFT_OFF = new Set(["edit", "remove"]);

/** The record the host makes for a project's folder here at its first thread, as the folder's entries read it before. */
const unmadeFolder = (id: string, name: string, computer: string): WorkspaceView => ({ id: "", name, machineId: "", kind: "local", phase: "running", golden: "", createdAt: "", project: { id, name, path: "", computer } });

export function WorkspaceSidebar() {
  const api = useStore(s => s.api);
  const conn = useStore(s => s.conn);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const forwards = useStore(s => s.forwards);
  const editorsAttached = useMemo(() => new Set(forwards.filter(f => f.kind === "editor").map(f => f.workspaceId)), [forwards]);
  const select = useStore(s => s.select);
  const creations = useStore(s => s.creations);
  const dismissCreation = useStore(s => s.dismissCreation);
  // Until the first list lands an empty group is unknown rather than empty, and the design spec gives this group no
  // waiting state of its own, so it holds nothing at all.
  const ready = useReady();
  const projectsRead = useProjectsRead();
  const projectsRefused = useProjectsRefused();
  const removeProject = useStore(s => s.removeProject);
  const openProjectHome = useStore(s => s.openProjectHome);
  // Where a workspace can go: the same list Settings draws, so a tile and that table never name a computer twice.
  const places = useStore(s => s.places);
  // What a workspace is made of. Named apart from the sidebar's own `projects`, which are its workspace snapshots.
  const recorded = useStore(s => s.projects);
  const loadLanding = useStore(s => s.loadLanding);
  const selectedId = useSelectedId();
  const selectedThreadId = useSelectedThreadId();
  // A subagent's page marks the subagent's row, not its lead's tile, unless the lead is folded over it.
  const selectedSubagent = useSelectedSubagent();
  const selectedWorkspace = useWorkspace(useSelectedWorkspaceId());
  const nowMinute = useNowMinute();
  // One clock sample per minute tick so every tile reads the same now and the fold moves on the minute.
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const [folded, setFolded] = useLocalStorage<readonly Fold[]>(FOLDED_KEY, ["settled"], foldedCodec);
  const toggleFold = (id: Fold): void => setFolded(ids => (ids.includes(id) ? ids.filter(at => at !== id) : [...ids, id]));
  const unfold = (id: Fold): void => setFolded(ids => ids.filter(at => at !== id));
  const settledOpen = !folded.includes("settled");
  const [pickStored, setPickStored] = useLocalStorage<string | null>(PROJECT_PICK_KEY, null, pickCodec);
  const [computerStored, setComputerStored] = useLocalStorage<string | null>(COMPUTER_PICK_KEY, null, pickCodec);
  const [addProject, setAddProject] = useState<number | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  /** The root whose snooze is being picked, by fold key. */
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const tileHandlers = useTileHandlers();
  const [forgetting, setForgetting] = useState<{ workspaceIds: ReadonlyArray<string>; act: "forget" | "delete"; copies?: true } | null>(null);
  /** The tile whose name is being typed, by the row id every tile carries, and whether that name is on its way; one
   * tile at a time, the tile is the only editor, and the field stays until the store has the name. */
  const [renaming, setRenaming] = useState<{ rowId: string; saving: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useWarmTiles(rootRef);
  useCheckoutAsks(rootRef);
  const renameThread = useStore(s => s.renameThread);
  const renameWorkspace = useStore(s => s.renameWorkspace);
  const canRename = useStore(s => s.api?.renameSession !== undefined);
  const canMark = useStore(s => s.api?.markThreads !== undefined);
  const canDelete = useStore(s => s.api?.deleteWorkspace !== undefined);
  const markThreads = useStore(s => s.markThreads);
  const settleThreads = useStore(s => s.settleThreads);
  const restoreThreads = useStore(s => s.restoreThreads);
  const setPreferences = useStore(s => s.setPreferences);
  const projectOrder = useStore(s => s.preferences.projectOrder);
  const harnesses = useStore(s => s.harnesses);
  const harnessesByWorkspace = useStore(s => s.harnessesByWorkspace);
  // The sidebar draws the tiles, so it owns the rename's opener, as it owns the forget's dialog; a client that cannot
  // send the name offers no box, and the action carries that refusal.
  const defaultThreadVerbs = useThreadVerbs();
  /** The tiles as the last committed draw holds them: what a move from the menu, the keys or a drop reads. */
  const drawnTiles = useRef<ReturnType<typeof sidebarTiles> | null>(null);
  const moveTree = (threadId: string, to: Parameters<typeof moveRoot>[2]): boolean => {
    const at = drawnTiles.current;
    const node = at?.live.find(root => root.thread.id === threadId);
    return at !== null && node !== undefined && moveRoot(at.sections, node, to);
  };
  const threadVerbs = useMemo<ThreadVerbs>(
    () => ({
      ...defaultThreadVerbs,
      ...(canRename ? { rename: (threadId: string) => setRenaming({ rowId: threadRowId(threadId), saving: false }) } : {}),
      ...(canMark ? { snooze: setSnoozing, move: (threadId: string, step: "up" | "down" | "top") => void moveTree(threadId, step) } : {}),
      ...(canDelete
        ? {
            keep: (workspaceIds: ReadonlyArray<string>) => setForgetting({ workspaceIds, act: "delete" }),
            deleteCopies: (workspaceIds: ReadonlyArray<string>) => setForgetting({ workspaceIds, act: "delete", copies: true }),
          }
        : {}),
    }),
    [canDelete, canMark, canRename, defaultThreadVerbs],
  );
  const defaultVerbs = useWorkspaceVerbs();
  const childVerbs = useChildVerbs();

  // This window is on another computer and the one running wsp has gone quiet: the tiles stand as they were last
  // known, and the line under the head says why nothing moves.
  const asleep = hostAsleep(conn);
  const fleet = useSidebarProjects();
  const { projects, groups, computer: computerPicked, picked } = useMemo(
    () => underPicks(fleet, { places, recorded, order: projectOrder, stored: { project: pickStored, computer: computerStored } }),
    [fleet, places, recorded, projectOrder, pickStored, computerStored],
  );
  const launches = useLaunches();
  const named = useMemo(() => placeNames(places), [places]);
  // The thread the centre shows, which the time fold leaves alone while it is on screen.
  const open = useMemo(() => {
    const runs = fleet.find(p => p.id === selectedId);
    if (runs === undefined) return null;
    return ((selectedThreadId === null ? undefined : runs.threads.find(t => t.threadId === selectedThreadId)) ?? topSidebarThread(runs.threads))?.id ?? null;
  }, [fleet, selectedId, selectedThreadId]);
  const settleAfter = useStore(s => s.preferences.settleAfter);
  // Nothing moves under the reader: a thread opened from the live list stays there while it is read, and one opened
  // from Settled stays in Settled, so which group it was in is read once, when it is opened.
  const [held, setHeld] = useState<{ open: string | null; held: string | null }>({ open: null, held: null });
  if (held.open !== open) {
    const folded = open !== null && sidebarTiles(projects, { picked: null, nowMs, settleMs: SETTLE_MS[settleAfter] }).settled.some(node => treeThreadIds(node).includes(open));
    setHeld({ open, held: folded ? null : open });
  }
  const tiles = useMemo(() => sidebarTiles(projects, { picked: picked?.project.id ?? null, nowMs, open: held.held, settleMs: SETTLE_MS[settleAfter] }), [projects, picked, nowMs, held.held, settleAfter]);
  const standings = useMemo(() => rootPlaces(tiles.sections), [tiles]);
  useLayoutEffect(() => {
    drawnTiles.current = tiles;
  });
  // One landing per project, for the pause mode a copy's phase verb reads. Asked here, where the tiles are drawn,
  // so no tile asks for itself.
  useEffect(() => {
    for (const group of groups) void loadLanding(group.project.id);
  }, [groups, loadLanding]);
  const tripTarget = trip === null ? undefined : workspaces.find(w => w.id === trip.workspaceId);
  const forgetTargets = forgetting === null ? [] : fleet.filter(p => forgetting.workspaceIds.includes(p.id));

  useEffect(() => onAddProjectRequest(() => setAddProject(Date.now())), []);
  useEffect(() => onForgetWorkspaceRequest(({ workspaceId, act }) => setForgetting({ workspaceIds: [workspaceId], act })), []);
  useEffect(() => onProjectTripRequest(request => setTrip({ ...request, key: Date.now() })), []);
  /** The palette's Rename on a copy: the box opens on the title of the thread the centre shows there, or its top
   * thread, the Settled fold opening if that is where the tile is; a copy with no thread names the copy itself. */
  const renameOnTile = (workspaceId: string): void => {
    const runs = fleet.find(p => p.id === workspaceId);
    if (runs === undefined) return;
    const open = (selectedId === workspaceId ? runs.threads.find(t => t.id === selectedThreadId) : undefined) ?? topSidebarThread(runs.threads);
    if (open === null) {
      setRenaming({ rowId: workspaceRowId(workspaceId), saving: false });
      return;
    }
    if (tiles.settled.some(node => holds(node, open.id))) unfold("settled");
    const holder = tiles.sections.find(section => section.roots.some(node => holds(node, open.id)));
    if (holder !== undefined) unfold(holder.id);
    setRenaming({ rowId: threadRowId(open.id), saving: false });
  };
  const renameOnTileRef = useRef(renameOnTile);
  renameOnTileRef.current = renameOnTile;
  useEffect(() => onRenameWorkspaceRequest(({ workspaceId }) => renameOnTileRef.current(workspaceId)), []);

  // A refused rebuild says so by the copy's name, which no tile carries on its face.
  const rebuild = async (workspaceId: string): Promise<void> => {
    const project = projects.find(p => p.id === workspaceId);
    if (!api?.rebuild || !project) return;
    try {
      await api.rebuild(project.id);
    } catch {
      addNotice({ kind: "error", text: rebuildRefusedLine(project.displayName), where: project.displayName });
    }
  };
  const verbs = { ...defaultVerbs, rebuild: api?.rebuild ? rebuild : undefined };
  const projectVerbs: ProjectVerbs = {
    newThread: openProjectHome,
    resumeConversation: (project: string) => openCommandPalette({ page: "conversations", project }),
    openSettings: openProjectSettings,
    ...(api?.projectsRemove === undefined ? {} : { removeProject: (project: string) => void removeProject(project) }),
  };
  /** One project's actions, as the switcher's rows offer them, then its folder's own, the entries a tile offers for the
   * copy it runs on: a folder no thread runs in draws no tile, so this row is the one way to them. The edit and remove
   * entries stay off, since they act on a record no row shows. A project here that never ran has no record yet, so its
   * entries read off the one the host would make, and the host makes it once one is chosen. An act that opens
   * something puts the folder on screen first, since a pane opened on a workspace nobody looks at shows nothing. */
  const projectActionsOf = (group: ProjectGroup): ResolvedAction[] => {
    const { project } = group;
    const own = resolveActions(projectActions, { id: project.id, name: project.name, workspaces: group.workspaces.map(w => w.displayName) }, projectVerbs);
    const held = workspaces.find(w => w.project.id === project.id && w.worktree === undefined && runsInFolder(workspaceKind(w)));
    const make = api?.projectFolder;
    const here = project.computer !== undefined && copiesFolder(kindForComputer(project.computer));
    const folder = held ?? (make !== undefined && here ? unmadeFolder(project.id, project.name, project.computer!) : undefined);
    if (folder === undefined) return own;
    const actsOn = (record: WorkspaceView): ResolvedAction[] =>
      resolveActions(workspaceActions, workspaceTarget(record, statuses[record.id] ?? null, places), verbs).filter(action => action.id !== "new-thread" && !FOLDER_LEFT_OFF.has(action.group));
    return [
      ...own,
      ...actsOn(folder).map(action => ({
        ...action,
        run: async () => {
          const at = held ?? (await make!(project.id));
          if (action.group === "open") select(at.id);
          await (at === held ? action : actsOn(at).find(made => made.id === action.id))?.run();
        },
      })),
    ];
  };

  /** The name a person typed on a tile: the store takes it while the field stays as it is, and the field closes only
   * once the store has it. A refusal leaves the name in the field to try again, with the reason in the toast. */
  const sendName = async (rowId: string, take: () => Promise<boolean>): Promise<void> => {
    setRenaming({ rowId, saving: true });
    const named = await take();
    setRenaming(open => (open?.rowId !== rowId ? open : named ? null : { rowId, saving: false }));
  };

  /** The machine one workspace runs on, as a thread's verbs read it: the state it is in and, where it is gone, the
   * words that say so. */
  const machineOf = (project: SidebarProjectSnapshot): RowMachine => {
    const workspace = workspaceTarget(project.workspace, project.status, places);
    return { state: workspaceState(workspace), ...(workspace.reason !== null ? { goneWords: workspace.reason } : {}) };
  };

  /** A copy's checkout as its tiles' card says it, with what the tree of the workspace it was forked out of holds of it. */
  const checkoutOf = (runs: SidebarProjectSnapshot) => {
    const from = runs.workspace.parentWorkspaceId;
    const tree = from === undefined ? undefined : statuses[from]?.tree;
    return tileCheckout(runs, { attached: editorsAttached.has(runs.id), ...(tree === undefined ? {} : { lead: tree }) });
  };

  /** Where a copy runs, as row one names it. */
  const placeOf = (runs: SidebarProjectSnapshot): TilePlace => ({ projectId: runs.workspace.project.id, project: runs.workspace.project.name, computer: computerName(places, runs), at: computerOf(places, runs) });

  const read = { nowMs, settleMs: SETTLE_MS[settleAfter] };
  const tree = tileTree(read);

  /** One tile's item with the tiles and subagents its agents opened under it, as LeadTree draws them, two levels in
   * and then at the second level's x, where a tile's card names the tiles over it; nothing while it is folded or
   * stands for a snoozed tree, and in the Settled fold every tile of the tree as a slim row. A tile in the Needs you
   * inbox draws nothing under it and acts as its thread's tile in the tree does. The first tile of a copy in the tree,
   * a root or a tile whose opener runs on another copy, carries every one of that copy's verbs after the thread's own.
   * A tile's verbs reach the machine its own copy runs on, so a thread on a machine that is gone is refused wherever it
   * is drawn. */
  const tileItem = (node: TileNode, depth: number, above: string | null, settled = false, group: ReadonlyArray<string> = [], part: ChildPart = "live", path: ReadonlyArray<string> = [], section?: SidebarSection): ReactNode => {
    const { thread: item, children } = node;
    const { runs, thread } = item;
    // A root of a section is an item a dragged tree lands beside, and one that moves is dragged by its tile.
    const rootOf = section === undefined ? undefined : { id: item.id, drags: canMark && !settled && item.snoozedWorking === undefined && (item.inboxOf?.parent ?? null) === null && (item.groupTitle !== undefined || thread !== null) };
    if (item.groupTitle !== undefined) {
      const copies = children.map(child => child.thread.runs.id);
      return (
        <AttemptGroup key={item.id} title={item.groupTitle} copies={children.length} root={rootOf}>
          {children.map(child => tileItem(child, depth + 1, null, settled, copies.filter(id => id !== child.thread.runs.id), "live", path))}
        </AttemptGroup>
      );
    }
    const inbox = item.inboxOf;
    const real = inbox === undefined ? node : (nodeOf(tiles.live, item.id) ?? node);
    // Read at the press: a draw of 400 tiles that resolved every copy's menu up front was most of its own cost.
    const copyActions = (): ResolvedAction[] => (above === runs.id ? [] : resolveActions(workspaceActions, workspaceTarget(runs.workspace, runs.status, places), verbs));
    const place = placeOf(runs);
    const checkout = checkoutOf(runs);
    const slim = settled || part === "finished";
    let tile: ReactNode;
    let under: ReactNode = null;
    if (thread === null) {
      tile = (
        <WorkspaceTile
          rowId={item.id}
          name={copyName(places, runs)}
          place={place}
          checkout={checkout}
          depth={depth}
          active={selectedId === runs.id && selectedThreadId === null}
          renaming={renaming?.rowId === item.id}
          saving={renaming?.rowId === item.id && renaming.saving}
          onSelect={() => select(runs.id)}
          onContextMenu={event => void openContextMenu(event, copyActions())}
          onRename={name => void sendName(item.id, () => renameWorkspace({ workspaceId: runs.id, name }))}
          onRenameCancel={() => setRenaming(null)}
        />
      );
    } else {
      const isRoot = inbox === undefined ? depth === 0 : inbox.parent === null;
      const rowId = inbox === undefined ? threadRowId(thread.id) : `inbox:${threadRowId(thread.id)}`;
      // A settle, a restore, a pin and a snooze take a root and its whole tree; a tile under one settles its own.
      const root = isRoot ? { ...treeSettle(real), workspaceIds: treeWorkspaceIds(real), pinned: thread.pinnedAt !== null, settled, place: settled ? null : (standings.get(item.id) ?? null) } : null;
      const catalog = catalogIn({ harnesses, harnessesByWorkspace }, thread.workspaceId, thread.harness);
      const target = threadTarget(thread, { catalog, ...machineOf(runs), ...(place.at !== undefined && !isHere(place.at) ? { elsewhere: place.computer } : {}) }, root, group);
      const tileVerbs = inbox === undefined || !canRename ? threadVerbs : { ...threadVerbs, rename: () => setRenaming({ rowId, saving: false }) };
      // The draw reads three of the thread's acts; the menu resolves the rest at the press.
      const actionsOf = resolveActions(DRAWN_ACTS, target, tileVerbs);
      const lead = { node: real, thread };
      const asChild = childActs(lead, part, tree, childVerbs);
      const settle = settled ? undefined : root !== null ? actionIfAny(actionsOf, "settle") : actionIfAny(asChild, "settle");
      const restore = root === null ? actionIfAny(asChild, "restore") : undefined;
      const restartOpens = asChild.filter(action => action.id === "open-replaced" || action.id === "open-restart");
      const stop = settled ? undefined : actionIfAny(root !== null ? actionsOf : asChild, "stop");
      const stops = stop !== undefined && stop.refusal === null;
      const quiet = !settled && !stops && settle !== undefined && settle.refusal === null && settlesOnHover(real, tree);
      const kids = leadNodes(thread, real.children, tree);
      const own = (): ResolvedAction[] => [...resolveActions(threadActions, target, tileVerbs), ...restartOpens, ...(root === null && settle !== undefined ? [settle] : []), ...(restore === undefined ? [] : [restore]), ...leadActs(thread, finishedTake(kids, tree), childVerbs)];
      // The tree under the tile: drawn while it stands open, counted while it is folded, and folded only where the host
      // can open it again.
      const drawsTree = !settled && part === "live" && inbox === undefined && item.snoozedWorking === undefined && drawsUnder(real, tree);
      const folds = drawsTree && canMark;
      const folded = folds && thread.foldedAt !== null;
      if (drawsTree && !folded)
        under = <LeadTree lead={thread} kids={children} depth={depth + 1} tree={tree} verbs={childVerbs} tile={(child, childPart) => tileItem(child, depth + 1, runs.id, childPart === "settled", [], childPart, [...path, thread.title])} />;
      tile = (
        <ThreadTile
          thread={thread}
          place={place}
          checkout={checkout}
          model={thread.model === null ? null : catalog === null ? thread.model : (modelOf(catalog, modelPicks(thread.model).model)?.label ?? thread.model)}
          time={restingAge(thread)}
          depth={depth}
          active={(selectedId === thread.workspaceId && (selectedThreadId === null ? thread.threadId === null : selectedThreadId === thread.id) && (selectedSubagent === null || folded)) || (selectedThreadId !== null && (item.holds?.includes(selectedThreadId) === true || (folded && holds(real, selectedThreadId))))}
          settled={settled}
          snoozedWorking={item.snoozedWorking}
          renaming={renaming?.rowId === rowId}
          saving={renaming?.rowId === rowId && renaming.saving}
          {...(inbox === undefined ? {} : { inboxOf: inbox })}
          {...(inbox === undefined && (!settled || part === "settled") && depth > 2 ? { openers: path } : {})}
          {...(part === "finished" ? { finished: kindOf(lead, "finished") } : {})}
          {...(folds ? { fold: folded ? rowsUnder(thread, children, tree) : ("open" as const) } : {})}
          {...(group.length > 0 && thread.model !== null ? { label: catalog === null ? thread.model : modelOf(catalog, modelPicks(thread.model).model)?.label } : {})}
          {...(rootOf?.drags === true ? { drags: true } : {})}
          {...(stops && real.children.length > 0 ? { stopsTree: true } : {})}
          {...tileHandlers(rowId, {
            onSelect: () => select(thread.workspaceId, thread.threadId),
            onContextMenu: event => void openContextMenu(event, [...own(), ...copyActions()]),
            onRename: title => void sendName(rowId, () => renameThread({ sessionId: thread.sessionId, workspaceId: thread.workspaceId, harness: thread.harness, title })),
            onRenameCancel: () => setRenaming(null),
            onRenameOpen: openerOf(actionById(actionsOf, "rename")),
            ...(quiet ? { onSettle: () => void runAction(settle!) } : {}),
            ...(stops ? { onStop: () => void runAction(stop) } : {}),
            ...(folds ? { onFold: () => void markThreads([thread.id], { folded: !folded }) } : {}),
          })}
        />
      );
    }
    // Past the second level a tile's own tree stands at its x, in the list it stands in.
    const nests = depth < 2;
    const li = (
      <li
        key={item.id}
        data-thread-item
        data-workspace-id={runs.id}
        {...(slim && thread !== null ? { "data-slim": "" } : {})}
        {...(rootOf === undefined ? {} : { "data-root": rootOf.id, ...(item.snoozedWorking === undefined ? {} : { "data-root-fixed": "" }) })}
        className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS, rootOf !== undefined && ROOT_ITEM_CLASS)}
      >
        {tile}
        {under !== null && nests ? <ul className={CHILD_LIST_CLASS}>{under}</ul> : null}
        {settled && children.length > 0 ? <ul className={CHILD_LIST_CLASS}>{children.map(child => tileItem(child, depth + 1, runs.id, true))}</ul> : null}
      </li>
    );
    return under !== null && !nests ? (
      <Fragment key={item.id}>
        {li}
        {under}
      </Fragment>
    ) : (
      li
    );
  };
  /** The one verb a failed create's tile carries: the row goes, and the runtime's hold on it with it. */
  const deleteCreation = (key: string): ResolvedAction => ({ id: "delete", group: "remove", icon: Trash2Icon, destructive: true, searchTerms: [], title: "Delete", rowLabel: null, buttonWord: "Delete", hint: null, refusal: null, run: async () => dismissCreation(key) });
  /** A workspace being made, where it will run once it is one. */
  const creationItem = (creation: Creation) => {
    const project = recorded.find(p => p.id === creation.project);
    const where = creation.where ?? project?.computer;
    const failed = creation.failed !== null;
    // A refused create names the step it stopped on, the name being the row above; one refused before any step says so.
    const step = failed ? stoppedStep(creation) : currentStep(creation);
    const line = step !== undefined ? stepWords(step) : failed ? CREATE_STEP_WORDS.failed : CREATE_ASKED;
    return (
      <li key={creation.key}>
        <CreationTile
          rowId={creation.key}
          name={creation.name}
          place={{ projectId: creation.project ?? "", project: project?.name ?? "", computer: where === undefined ? "" : named.get(where) ?? where }}
          line={line}
          failed={failed}
          active={selectedId === creation.key}
          onSelect={() => select(creation.key)}
          {...(failed ? { onContextMenu: event => void openContextMenu(event, [deleteCreation(creation.key)]) } : {})}
        />
      </li>
    );
  };

  /** The sends in flight whose threads the runtime has not written yet, as tiles at the top, newest work first. */
  const launchItems = projects.flatMap(runs => {
    const launch = launches[runs.id];
    if (launch === undefined || (picked !== null && runs.workspace.project.id !== picked.project.id)) return [];
    return [
      <li key={`launch:${runs.id}`} data-thread-selection-safe>
        <ThreadLaunchTile launch={launch} place={placeOf(runs)} checkout={checkoutOf(runs)} />
      </li>,
    ];
  });
  const made = creations.filter(creation => picked === null || creation.project === picked.project.id);
  /** A workspace being made files where a thread in its state does: the list while it is made, Needs you once refused. */
  const madeIn = (id: SidebarSection): Creation[] => made.filter(creation => (creation.failed === null ? "threads" : "needs-you") === id);
  /** A root dropped on a section's head or on the fold: the marks the drop writes, or the settle of its tree. A group
   * one send to several models opened goes as one: pinned or unpinned together, each of its trees settled. */
  const dropOnHead = (node: TileNode, place: SidebarSection | "settled"): void => {
    const threads = rootThreads(node);
    if (threads.length === 0) return;
    if (place === "settled") {
      // The menu's Settle is held with this sentence while the tree works, and a drop says the same.
      const trees = node.thread.groupTitle === undefined ? [treeSettle(node)] : node.children.map(treeSettle);
      if (trees.some(tree => tree.working)) addNotice({ kind: "error", text: THREAD_TREE_WORKING });
      else void settleSaying(trees.flatMap(tree => tree.threadIds), { settle: settleThreads, restore: restoreThreads });
      return;
    }
    const marks = node.thread.groupTitle === undefined ? dropMarks(node, place) : place === "pinned" ? { pinned: true } : threads.some(thread => thread.pinnedAt !== null) ? { pinned: false } : null;
    if (marks !== null) void markThreads(threads.map(thread => thread.id), marks);
  };
  /** Where a dragged root lands, read at the drop off the tiles the last draw committed. */
  const dropTree = useRef<DropTree>(() => {});
  dropTree.current = (rootId, at) => {
    const drawn = drawnTiles.current;
    const node = drawn?.live.find(root => root.thread.id === rootId);
    if (drawn === null || node === undefined) return;
    if (at.kind === "head") return dropOnHead(node, at.place);
    const roots = drawn.sections.find(section => section.id === at.section)?.roots.filter(root => root.thread.id !== rootId && root.thread.snoozedWorking === undefined) ?? [];
    const next = roots.findIndex(root => root.thread.id === at.rootId);
    if (next >= 0) moveTree(rootId, { section: at.section, at: next + (at.after ? 1 : 0) });
  };
  useTreeDrag(rootRef, dropTree);
  // Every section is drawn: one with nothing in it stands only while a tree is dragged, as a place to drop it.
  const sections = SIDEBAR_SECTIONS.map(id => tiles.sections.find(section => section.id === id) ?? { id, roots: [] });
  const standsBare = (section: { id: SidebarSection; roots: ReadonlyArray<TileNode> }): boolean => section.roots.length === 0 && madeIn(section.id).length === 0;
  /** Whether a section keeps the sections' own gap over it at rest: one stands above it, or it is a bare head itself.
   * Where neither, the gap stands only while a drag shows the bare heads above, so the list starts where it did. */
  const gapsAtRest = (index: number): boolean => standsBare(sections[index]!) || sections.slice(0, index).some(above => !standsBare(above));
  const settledCount = tiles.settled.reduce((sum, node) => sum + tileCount(node), 0);
  const settleable = settleableRoots(tiles.live);
  const settledRowActions = resolveActions(settledFoldActions, { threadIds: settleable.flatMap(root => treeSettle(root).threadIds), workspaceIds: [...new Set(tiles.settled.flatMap(treeWorkspaceIds))] }, threadVerbs);

  // The body on its way out of a slide is still drawn: its rows are not the ones the keyboard walks.
  const rows = (): HTMLElement[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []);
  const focusRow = (id: string | null): void => {
    if (id === null) return;
    rows().find(r => r.dataset["rowId"] === id)?.focus();
  };
  /** The row a move from the keys left focused, put back once the move has drawn. */
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const row = rows().find(r => r.dataset["rowId"] === id);
    if (row !== undefined && document.activeElement !== row) row.focus();
  });
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const ids = rows().map(r => r.dataset["rowId"] ?? "");
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row]")?.dataset["rowId"] ?? null;
    const step = matchesShortcut(e, MOVE_KEYS.up) ? "up" : matchesShortcut(e, MOVE_KEYS.down) ? "down" : null;
    if (step !== null) {
      const id = current?.match(/^thread:(.+)$/)?.[1];
      if (id !== undefined && moveTree(id, step)) refocus.current = current;
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        focusRow(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: current, direction: "next" }) ?? current);
        break;
      case "ArrowUp":
        if (current === null) return;
        focusRow(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: current, direction: "previous" }) ?? current);
        break;
      case "Home":
        if (current === null) return;
        focusRow(ids[0] ?? null);
        break;
      case "End":
        if (current === null) return;
        focusRow(ids.at(-1) ?? null);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        // A tile with a tree under it folds and opens it: the host's mark, so a reload and a second window agree.
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row][aria-expanded]");
        const id = row?.dataset["rowId"]?.match(/^thread:(.+)$/)?.[1];
        if (row === null || row === undefined || id === undefined) return;
        const fold = e.key === "ArrowLeft";
        if ((row.getAttribute("aria-expanded") === "false") !== fold) void markThreads([id], { folded: fold });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const header = (
    <div className="flex flex-col px-[var(--sidebar-content-inset)] pb-3" data-sidebar-search>
      <NewThreadRow />
      <SearchRow />
      <ProjectSwitcher
        projects={groups.map(group => group.project)}
        onReorder={ids => void setPreferences({ projectOrder: ids })}
        named={named}
        pick={picked?.project ?? null}
        onPick={setPickStored}
        onNewThread={openProjectHome}
        onAddProject={() => setAddProject(Date.now())}
        onContextMenu={(event, projectId) => {
          const group = groups.find(g => g.project.id === projectId);
          if (group !== undefined) void openContextMenu(event, projectActionsOf(group));
        }}
      />
      <ComputerSwitcher places={places} pick={computerPicked} onPick={setComputerStored} />
      {asleep ? (
        <p data-sidebar-asleep className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
          {HOST_ASLEEP_LINE}
        </p>
      ) : null}
    </div>
  );

  const empty = ready && projectsRead && projectsRefused === null && groups.length === 0 && creations.length === 0;

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={header} className="min-h-full" onContextMenu={event => void openContextMenu(event, settledRowActions.filter(action => action.id === "settle-read"))}>
          <ul data-sidebar-tree className="relative flex w-full min-w-0 flex-col px-[var(--sidebar-content-inset)]">
            {launchItems}
            {sections.map((section, index) => (
              <li
                key={section.id}
                data-section={section.id}
                data-thread-selection-safe
                {...(standsBare(section) ? { "data-drop-only": "" } : index > 0 && !gapsAtRest(index) ? { "data-drop-gap": "" } : {})}
                className={cn("min-w-0", DROP_OVER_CLASS, index > 0 && (gapsAtRest(index) ? "mt-3" : "data-[drop-shown]:mt-3"), standsBare(section) && DROP_ONLY_CLASS)}
              >
                {/* The one list stands bare between Needs you and Settled, as T3 Code's active list. */}
                {section.id === "threads" ? null : (
                  <SectionRow
                    label={SECTION_WORDS[section.id]}
                    count={section.roots.reduce((sum, node) => sum + drawnCount(node, read), 0) + madeIn(section.id).length}
                    collapsed={folded.includes(section.id)}
                    onToggle={() => toggleFold(section.id)}
                    rowId={standsBare(section) ? undefined : sectionRowId(section.id)}
                    head={section.id}
                  />
                )}
                {section.id !== "threads" && folded.includes(section.id) ? null : (
                  <ul className="flex min-w-0 flex-col">
                    {madeIn(section.id).map(creationItem)}
                    {section.roots.map(node => tileItem(node, 0, null, false, [], "live", [], section.id))}
                  </ul>
                )}
              </li>
            ))}
            <li data-thread-selection-safe data-drop-settled {...(tiles.settled.length === 0 ? { "data-drop-only": "" } : {})} className={cn("mt-3", DROP_OVER_CLASS, tiles.settled.length === 0 && DROP_ONLY_CLASS)}>
              <SectionRow
                label={SECTION_WORDS.settled}
                count={settledCount}
                collapsed={!settledOpen}
                onToggle={() => toggleFold("settled")}
                onContextMenu={event => void openContextMenu(event, settledRowActions)}
                rowId={tiles.settled.length === 0 ? undefined : SETTLED_ROW_ID}
              />
            </li>
            {settledOpen ? tiles.settled.map(node => tileItem(node, 0, null, true)) : null}
            {ready && groups.length > 0 && launchItems.length + tiles.live.length + tiles.settled.length + made.length === 0 ? (
              <li data-thread-selection-safe>
                <p data-k="no-workspaces" className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                  {PROJECT_WORDS.noWorkspaces}
                </p>
                {picked !== null ? (
                  <SidebarMenuButton size="sm" data-k="new-thread-in" className={ONE_LINE_ROW_CLASS} onClick={() => openProjectHome(picked.project.id)}>
                    <SquarePenIcon className="size-4" />
                    <span className="min-w-0 truncate">{rowNewThread(picked.project.name)}</span>
                  </SidebarMenuButton>
                ) : null}
              </li>
            ) : null}
            {projectsRefused !== null ? (
              <li>
                <p data-k="projects-refused" className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
                  {PROJECT_WORDS.notRead(projectsRefused.said)}
                </p>
              </li>
            ) : null}
            {empty ? (
              <li>
                <SidebarMenuButton size="sm" data-k="new-project" className={ONE_LINE_ROW_CLASS} onClick={requestAddProject}>
                  <PlusIcon className="size-4" />
                  <span>{PROJECT_WORDS.add}</span>
                </SidebarMenuButton>
              </li>
            ) : null}
            <li data-drop-line aria-hidden hidden className="pointer-events-none absolute inset-x-[var(--sidebar-content-inset)] top-0 z-10 h-0.5 bg-ring" />
          </ul>
          <ForwardsList />
          <p ref={holdLiveRegion} aria-live="polite" data-move-said className="sr-only" />
        </SidebarContent>
        <SidebarChromeFooter>
          <SettingUpSection collapsed={folded.includes("setting-up")} onToggle={() => toggleFold("setting-up")} />
          <UpdateCard />
          <SidebarCorner />
        </SidebarChromeFooter>
      </div>
      {addProject !== null ? <AddProjectDialog key={addProject} onClose={() => setAddProject(null)} /> : null}
      {snoozing !== null ? (
        <SnoozeDialog
          onSnooze={until => {
            void markThreads([snoozing], { snoozedUntil: until });
            setSnoozing(null);
          }}
          onCancel={() => setSnoozing(null)}
        />
      ) : null}
      {trip !== null && tripTarget !== undefined ? <ExportProjectDialog key={trip.key} workspace={tripTarget} onClose={() => setTrip(null)} /> : null}
      {forgetTargets.length > 0 ? (
        <ForgetWorkspaceDialog
          workspaces={forgetTargets.map(target => target.workspace)}
          threads={forgetTargets.reduce((sum, target) => sum + target.threads.length, 0)}
          act={forgetting!.act}
          copies={forgetting!.copies === true}
          open
          onOpenChange={next => {
            if (!next) setForgetting(null);
          }}
        />
      ) : null}
    </>
  );
}

