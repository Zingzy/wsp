// SPDX-License-Identifier: AGPL-3.0-only
// The left region. Fixed at the top: the search row with the compose glyph that
// opens a thread in the selected workspace, and the project switcher, "All
// projects" or the one project the list is filtered to. Under them, scrolling:
// every root thread as a tile under its section (Pinned, Needs you, Working,
// Done, Idle), newest first inside each across every workspace, the threads
// its agents opened under it on the rail, and at the foot the Settled fold
// holding every root whose whole tree is settled, by hand or by quiet after a
// read, with "Settle all read" on its own row's menu. A root tile is dragged
// onto another section to hold it there, onto Pinned to pin it and onto the
// fold to settle it; while one is dragged every section stands to take it. A workspace
// with no thread yet is a tile of its own and a workspace being made is a
// tile-shaped placeholder. The first tile of a copy in a tree carries every
// one of that copy's verbs in its menu after the thread's own. On a wsp with no project
// the body holds one row that points at the first run in the centre. The
// computer switcher under the project switcher narrows the list to the work on
// one computer. Keyboard
// traversal, the forget of a gone copy and the project trips' dialogs live
// here; the tiles are ThreadTile beside this file. The surface itself is the
// shell's sidebar-glass: nothing here paints a background.
import { openProjectSettings } from "../settings/openAt.js";
import { ChevronDownIcon, CopyIcon, PlusIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { HOST_ASLEEP_LINE, modelOf, workspaceState, type WorkspaceState } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { THREAD_TREE_WORKING, rebuildRefusedLine } from "../actions/format.js";
import { CREATE_ASKED, CREATE_STEP_WORDS, currentStep, stepWords, stoppedStep } from "../shell/creationLog.js";
import { actionById, resolveActions, type ResolvedAction } from "../actions/registry.js";
import { projectActions, type ProjectVerbs } from "../actions/projectActions.js";
import { settledFoldActions, threadActions, threadTarget, type ThreadVerbs } from "../actions/threadActions.js";
import { useThreadVerbs, useWorkspaceVerbs } from "../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../actions/workspaceActions.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { ForgetWorkspaceDialog } from "../components/ForgetWorkspaceDialog.js";
import { modelPicks } from "../components/chat/composerPicks.js";
import { SidebarContent, SidebarGroupAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { cn } from "../lib/utils.js";
import { addNotice } from "../notices/store.js";
import { catalogIn, useLaunches, useProjectsRead, useProjectsRefused, useReady, useSelectedId, useSelectedThreadId, useSelectedWorkspaceId, useSidebarProjects, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { hostAsleep } from "../boot.js";
import { onAddProjectRequest, onForgetWorkspaceRequest, onNewWorkspaceRequest, onProjectTripRequest, onRenameWorkspaceRequest, requestAddProject, type ProjectTripRequest } from "../shell/shellRequests.js";
import { useShortcutLabel } from "../shell/useKeybindings.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { AddProjectDialog } from "./AddProjectDialog.js";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ComputerSwitcher } from "./ComputerSwitcher.js";
import { COMPUTER_PICK_KEY, PROJECT_PICK_KEY, pickCodec, underPicks } from "./picks.js";
import { CHILD_LIST_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, SETTLED_ROW_ID, sectionRowId, threadRowId, workspaceRowId } from "./rowGrammar.js";
import { SearchRow } from "./SearchRow.js";
import { resolveAdjacentThreadId, threadSection, topSidebarThread } from "./Sidebar.logic.js";
import { SIDEBAR_SECTIONS, dropMarks, settleableRoots, sidebarTiles, treeSettle, treeThreadIds, type ProjectGroup, type SidebarSection, type TileNode } from "./threadTree.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import { SidebarCorner } from "./SidebarCorner.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { CreationTile, ThreadLaunchTile, ThreadTile, WorkspaceTile, type TilePlace } from "./ThreadTile.js";
import { useLinkDowns } from "../terminal/paneWords.js";
import { newThreadTitle, computerName, computerOf, copyName, placeNames } from "./workspaceRows.js";
import { CheckoutAsk, tileCheckout } from "./tileCheckout.js";
import { restingAge } from "../components/status/restingAge.js";
import { PROJECT_WORDS, SECTION_WORDS } from "./words.js";
import { SectionRow } from "./SectionRow.js";

type Fold = SidebarSection | "settled";
/** The folds a head can make: the one list has no head, so it never folds. */
const FOLDS: readonly Fold[] = ["pinned", "needs-you", "settled"];
/** The sections a person has folded by their heads. Settled starts folded, since it holds the tiles a person has
 * stopped looking at; every live section starts open. */
const FOLDED_KEY = "wsp:sidebar-folded";
const foldedCodec: Codec<readonly Fold[]> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(id => (FOLDS as readonly unknown[]).includes(id))) throw new Error(`Expected a list of section ids, got ${raw}.`);
    return parsed as Fold[];
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

/** Every tile a tree holds, itself included; a group's head is no tile. */
const tileCount = (node: TileNode): number => (node.thread.groupTitle === undefined ? 1 : 0) + node.children.reduce((sum, child) => sum + tileCount(child), 0);

/** The new-workspace dialog open on one project, keyed per opening so its field resets. */
interface DialogState {
  readonly key: number;
  /** The project the plus was pressed on; the dialog picks it, and with none it picks the first there is. */
  readonly project: string | null;
}

/** A project trip's dialog open for one workspace; keyed per opening so its folder and plan reset. */
interface ProjectTripState extends ProjectTripRequest {
  readonly key: number;
}

/** The copies one send to several models made, under one head: the sidebar's one-line row, the task's name, how many
 * copies it holds, and the chevron that folds them, so the group reads as a row a person can act on rather than a
 * title standing above a list. Its tiles keep the tile's own pitch on the rail. */
function AttemptGroup({ title, copies, children }: { title: string; copies: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <li data-thread-item data-attempt-group className="min-w-0">
      <SidebarMenuButton size="sm" data-attempt-head aria-expanded={open} className={ONE_LINE_ROW_CLASS} onClick={() => setOpen(was => !was)}>
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

export function WorkspaceSidebar() {
  const api = useStore(s => s.api);
  const conn = useStore(s => s.conn);
  const workspaces = useStore(s => s.workspaces);
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
  const createWorkspace = useStore(s => s.createWorkspace);
  const removeProject = useStore(s => s.removeProject);
  // Where a workspace can go: the same list Settings draws, so a tile and that table never name a computer twice.
  const places = useStore(s => s.places);
  // What a workspace is made of. Named apart from the sidebar's own `projects`, which are its workspace snapshots.
  const recorded = useStore(s => s.projects);
  const landings = useStore(s => s.landings);
  const loadLanding = useStore(s => s.loadLanding);
  const selectedId = useSelectedId();
  const selectedThreadId = useSelectedThreadId();
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
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [addProject, setAddProject] = useState<number | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  /** The root whose snooze is being picked, by fold key. */
  const [snoozing, setSnoozing] = useState<string | null>(null);
  /** The root tile being dragged, by fold key, and the place under the pointer it would land in. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<SidebarSection | "settled" | null>(null);
  const [forgetting, setForgetting] = useState<{ workspaceIds: ReadonlyArray<string>; act: "forget" | "delete" } | null>(null);
  /** The tile whose name is being typed, by the row id every tile carries, and whether that name is on its way; one
   * tile at a time, the tile is the only editor, and the field stays until the store has the name. */
  const [renaming, setRenaming] = useState<{ rowId: string; saving: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const renameThread = useStore(s => s.renameThread);
  const renameWorkspace = useStore(s => s.renameWorkspace);
  const canRename = useStore(s => s.api?.renameSession !== undefined);
  const canMark = useStore(s => s.api?.markThreads !== undefined);
  const canDelete = useStore(s => s.api?.deleteWorkspace !== undefined);
  const markThreads = useStore(s => s.markThreads);
  const settleThreads = useStore(s => s.settleThreads);
  const setPreferences = useStore(s => s.setPreferences);
  const projectOrder = useStore(s => s.preferences.projectOrder);
  const harnesses = useStore(s => s.harnesses);
  const harnessesByWorkspace = useStore(s => s.harnessesByWorkspace);
  // The sidebar draws the tiles, so it owns the rename's opener, as it owns the forget's dialog; a client that cannot
  // send the name offers no box, and the action carries that refusal.
  const defaultThreadVerbs = useThreadVerbs();
  const threadVerbs = useMemo<ThreadVerbs>(
    () => ({
      ...defaultThreadVerbs,
      ...(canRename ? { rename: (threadId: string) => setRenaming({ rowId: threadRowId(threadId), saving: false }) } : {}),
      ...(canMark ? { snooze: setSnoozing } : {}),
      ...(canDelete ? { keep: (workspaceIds: ReadonlyArray<string>) => setForgetting({ workspaceIds, act: "delete" }) } : {}),
    }),
    [canDelete, canMark, canRename, defaultThreadVerbs],
  );
  const defaultVerbs = useWorkspaceVerbs();

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
  const tiles = useMemo(() => sidebarTiles(projects, { picked: picked?.project.id ?? null, nowMs, open }), [projects, picked, nowMs, open]);
  // One landing per project, for the pause mode a copy's phase verb reads. Asked here, where the tiles are drawn,
  // so no tile asks for itself.
  useEffect(() => {
    for (const group of groups) void loadLanding(group.project.id);
  }, [groups, loadLanding]);
  const tripTarget = trip === null ? undefined : workspaces.find(w => w.id === trip.workspaceId);
  const forgetTargets = forgetting === null ? [] : fleet.filter(p => forgetting.workspaceIds.includes(p.id));

  const openDialog = (project: string | null): void => setDialog({ key: Date.now(), project });
  // The palette's New workspace lands on the project the head names while one is picked, as the head's plus does.
  const openDialogForPick = (project?: string): void => openDialog(project ?? picked?.project.id ?? null);
  const openDialogRef = useRef(openDialogForPick);
  openDialogRef.current = openDialogForPick;
  useEffect(() => onNewWorkspaceRequest(({ project }) => openDialogRef.current(project)), []);
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

  const create = async (name: string, project: string): Promise<void> => {
    setDialog(null);
    await createWorkspace(project, name);
  };

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
    newWorkspace: project => openDialog(project),
    openSettings: openProjectSettings,
    ...(api?.projectsRemove === undefined ? {} : { removeProject: (project: string) => void removeProject(project) }),
  };
  /** One project's actions, as the switcher's rows offer them. */
  const projectActionsOf = (group: ProjectGroup): ResolvedAction[] =>
    resolveActions(projectActions, { id: group.project.id, name: group.project.name, workspaces: group.workspaces.map(w => w.displayName) }, projectVerbs);

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

  /** Where a copy runs, as row one names it. */
  const linksDown = useLinkDowns();
  const placeOf = (runs: SidebarProjectSnapshot): TilePlace => ({ projectId: runs.workspace.project.id, project: runs.workspace.project.name, computer: computerName(places, runs), at: computerOf(places, runs) });

  /** One tile's item with the tiles its agents opened under it. The first tile of a copy in the tree, a root or a
   * tile whose opener runs on another copy, carries every one of that copy's verbs after the thread's own. A tile's verbs reach
   * the machine its own copy runs on, so a thread on a machine that is gone is refused wherever it is drawn. */
  const tileItem = (node: TileNode, depth: number, above: string | null, settled = false, group: ReadonlyArray<string> = []): ReactNode => {
    const { thread: item, children } = node;
    const { runs, thread } = item;
    if (item.groupTitle !== undefined) {
      const copies = children.map(child => child.thread.runs.id);
      return (
        <AttemptGroup key={item.id} title={item.groupTitle} copies={children.length}>
          {children.map(child => tileItem(child, depth + 1, null, settled, copies.filter(id => id !== child.thread.runs.id)))}
        </AttemptGroup>
      );
    }
    const copyActions = above === runs.id ? [] : resolveActions(workspaceActions, workspaceTarget(runs.workspace, runs.status, places), verbs);
    const place = placeOf(runs);
    const checkout = tileCheckout(runs, { attached: editorsAttached.has(runs.id) });
    let tile: ReactNode;
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
          onContextMenu={event => void openContextMenu(event, copyActions)}
          onRename={name => void sendName(item.id, () => renameWorkspace({ workspaceId: runs.id, name }))}
          onRenameCancel={() => setRenaming(null)}
        />
      );
    } else {
      // A settle, a restore, a pin and a snooze take a root and its whole tree; a tile under one goes where it goes.
      const root = depth === 0 ? { ...treeSettle(node), pinned: thread.pinnedAt !== null, settled } : null;
      const catalog = catalogIn({ harnesses, harnessesByWorkspace }, thread.workspaceId, thread.harness);
      const target = threadTarget(thread, { catalog, ...machineOf(runs) }, root, group);
      const actionsOf = resolveActions(threadActions, target, threadVerbs);
      const rowId = threadRowId(thread.id);
      tile = (
        <ThreadTile
          thread={thread}
          {...(linksDown[thread.workspaceId] !== undefined ? { linkDown: linksDown[thread.workspaceId] } : {})}
          place={place}
          checkout={checkout}
          model={thread.model === null ? null : catalog === null ? thread.model : (modelOf(catalog, modelPicks(thread.model).model)?.label ?? thread.model)}
          time={restingAge(thread)}
          depth={depth}
          active={(selectedId === thread.workspaceId && (selectedThreadId === null ? thread.threadId === null : selectedThreadId === thread.id)) || (selectedThreadId !== null && item.holds?.includes(selectedThreadId) === true)}
          settled={settled}
          snoozedWorking={item.snoozedWorking}
          renaming={renaming?.rowId === rowId}
          saving={renaming?.rowId === rowId && renaming.saving}
          onSelect={() => select(thread.workspaceId, thread.threadId)}
          onContextMenu={event => void openContextMenu(event, [...actionsOf, ...copyActions])}
          onRename={title => void sendName(rowId, () => renameThread({ sessionId: thread.sessionId, workspaceId: thread.workspaceId, harness: thread.harness, title }))}
          onRenameCancel={() => setRenaming(null)}
          onRenameOpen={openerOf(actionById(actionsOf, "rename"))}
          {...(group.length > 0 && thread.model !== null ? { label: catalog === null ? thread.model : modelOf(catalog, modelPicks(thread.model).model)?.label } : {})}
          {...(depth === 0 && !settled
            ? {
                onDragStart: (event: DragEvent<HTMLElement>) => {
                  event.dataTransfer.setData("text/plain", thread.title);
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(item.id);
                },
                onDragEnd: () => {
                  setDragging(null);
                  setOver(null);
                },
              }
            : {})}
        />
      );
    }
    return (
      <li key={item.id} data-thread-item className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS)}>
        {tile}
        {children.length > 0 ? <ul className={CHILD_LIST_CLASS}>{children.map(child => tileItem(child, depth + 1, runs.id, settled))}</ul> : null}
      </li>
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
        <ThreadLaunchTile launch={launch} place={placeOf(runs)} checkout={tileCheckout(runs, { attached: editorsAttached.has(runs.id) })} />
      </li>,
    ];
  });
  const made = creations.filter(creation => picked === null || creation.project === picked.project.id);
  /** A workspace being made files where a thread in its state does: the list while it is made, Needs you once refused. */
  const madeIn = (id: SidebarSection): Creation[] => made.filter(creation => (creation.failed === null ? "threads" : "needs-you") === id);
  /** A root dropped on a section or on the fold: the marks the drop writes, or the settle of its tree. */
  const drop = (rootId: string, place: SidebarSection | "settled"): void => {
    const node = tiles.live.find(root => root.thread.id === rootId);
    if (node === undefined || node.thread.thread === null) return;
    if (place === "settled") {
      // The menu's Settle is held with this sentence while the tree works, and a drop says the same.
      const tree = treeSettle(node);
      if (tree.working) addNotice({ kind: "error", text: THREAD_TREE_WORKING });
      else void settleThreads(tree.threadIds);
      return;
    }
    const marks = dropMarks(node, place);
    if (marks !== null) void markThreads([node.thread.thread.id], marks);
  };
  /** What makes a section, or the fold, a place a dragged root lands in. */
  const dropZone = (place: SidebarSection | "settled") => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragging === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== place) setOver(place);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const rootId = dragging;
      setDragging(null);
      setOver(null);
      if (rootId !== null) drop(rootId, place);
    },
  });
  // While a root is dragged every section stands, the empty ones too, so any of them can take it.
  const sections = SIDEBAR_SECTIONS.flatMap(id => {
    const found = tiles.sections.find(section => section.id === id);
    return found !== undefined ? [found] : dragging !== null || madeIn(id).length > 0 ? [{ id, roots: [] }] : [];
  });
  const settledCount = tiles.settled.reduce((sum, node) => sum + tileCount(node), 0);
  const settleable = settleableRoots(tiles.live);
  const settledRowActions = resolveActions(settledFoldActions, { threadIds: settleable.flatMap(treeThreadIds) }, threadVerbs);

  // The body on its way out of a slide is still drawn: its rows are not the ones the keyboard walks.
  const rows = (): HTMLElement[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []);
  const focusRow = (id: string | null): void => {
    if (id === null) return;
    rows().find(r => r.dataset["rowId"] === id)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const ids = rows().map(r => r.dataset["rowId"] ?? "");
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row]")?.dataset["rowId"] ?? null;
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
      default:
        return;
    }
    e.preventDefault();
  };

  const newThreadShortcut = useShortcutLabel("chat.new");
  /** The one add control at rest: New thread on a project, which needs no workspace selected, held while there is no
   * project to open one on. Held by aria-disabled rather than the disabled attribute, so the pointer still reaches it
   * and the tooltip can say what it is. */
  const compose = (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarGroupAction
            className="text-sidebar-muted-foreground transition-colors duration-150 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-sidebar-muted-foreground"
            aria-label="New thread"
            aria-disabled={recorded.length === 0 || undefined}
            onClick={verbs.newThread}
          />
        }
      >
        <SquarePenIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{newThreadTitle(newThreadShortcut)}</TooltipPopup>
    </Tooltip>
  );
  const header = (
    <div className="flex flex-col px-[var(--sidebar-content-inset)] pb-1" data-sidebar-search>
      <div className="relative">
        <SearchRow action={compose} />
      </div>
      <ProjectSwitcher
        projects={groups.map(group => group.project)}
        onReorder={ids => void setPreferences({ projectOrder: ids })}
        named={named}
        pick={picked?.project ?? null}
        onPick={setPickStored}
        onNewWorkspace={openDialog}
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
      {projects.map(runs => (
        <CheckoutAsk key={runs.id} workspaceId={runs.id} />
      ))}
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={header}>
          <ul data-sidebar-tree className="flex w-full min-w-0 flex-col px-[var(--sidebar-content-inset)]">
            {launchItems}
            {sections.map((section, index) => (
              <li
                key={section.id}
                data-section={section.id}
                data-thread-selection-safe
                className={cn("min-w-0 rounded-[var(--control-radius)] transition-colors duration-150", index > 0 && "mt-3", over === section.id && "bg-sidebar-row-hover")}
                {...dropZone(section.id)}
              >
                {/* The one list stands bare between Needs you and Settled, as T3 Code's active list. */}
                {section.id === "threads" ? null : (
                  <SectionRow
                    label={SECTION_WORDS[section.id]}
                    count={section.roots.reduce((sum, node) => sum + tileCount(node), 0) + madeIn(section.id).length}
                    collapsed={folded.includes(section.id)}
                    onToggle={() => toggleFold(section.id)}
                    rowId={sectionRowId(section.id)}
                    head={section.id}
                  />
                )}
                {section.id !== "threads" && folded.includes(section.id) ? null : (
                  <ul className="flex min-w-0 flex-col">
                    {madeIn(section.id).map(creationItem)}
                    {section.roots.map(node => tileItem(node, 0, null))}
                  </ul>
                )}
              </li>
            ))}
            {tiles.settled.length > 0 || settleable.length > 0 || dragging !== null ? (
              <li data-thread-selection-safe className={cn("mt-3 rounded-[var(--control-radius)] transition-colors duration-150", over === "settled" && "bg-sidebar-row-hover")} {...dropZone("settled")}>
                <SectionRow
                  label={SECTION_WORDS.settled}
                  count={settledCount}
                  collapsed={!settledOpen}
                  onToggle={() => toggleFold("settled")}
                  onContextMenu={event => void openContextMenu(event, settledRowActions)}
                  rowId={SETTLED_ROW_ID}
                />
              </li>
            ) : null}
            {settledOpen ? tiles.settled.map(node => tileItem(node, 0, null, true)) : null}
            {ready && groups.length > 0 && launchItems.length + tiles.live.length + tiles.settled.length + made.length === 0 ? (
              <li data-thread-selection-safe>
                <p data-k="no-workspaces" className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                  {PROJECT_WORDS.noWorkspaces}
                </p>
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
                  <span>{PROJECT_WORDS.new}</span>
                </SidebarMenuButton>
              </li>
            ) : null}
          </ul>
          <ForwardsList />
        </SidebarContent>
        <SidebarChromeFooter>
          <SidebarCorner />
        </SidebarChromeFooter>
      </div>
      {dialog ? (
        <NewWorkspaceDialog
          key={dialog.key}
          projects={recorded}
          landings={landings}
          places={places}
          picked={dialog.project}
          onCreate={(name, project) => void create(name, project)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
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
          open
          onOpenChange={next => {
            if (!next) setForgetting(null);
          }}
        />
      ) : null}
    </>
  );
}

