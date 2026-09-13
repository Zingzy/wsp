// SPDX-License-Identifier: AGPL-3.0-only
// The left region: workspaces (machines) first, their sessions as threads
// under each, over the adapter's SidebarProjectSnapshot. The search row, the
// Workspaces section row that shuts them all and opens the new-workspace
// dialog, the settled shelf with the archive nested in it, the Spaces body
// with one workspace's rows under its header and an icon per workspace at the
// bottom, the slide and the two-finger swipe that move between them,
// keyboard traversal, the
// rebuild of a zombie or gone machine, the forget of a gone one and the
// project trips' dialogs live here; the rows are WorkspaceRow and ThreadRow
// beside this file, and the logic comes from the copied t3code files. Every
// action a row carries, as a button or in its right-click menu, comes from
// the workspace and thread registries. The surface itself is the shell's
// sidebar-glass: nothing here paints a background.
import { ChevronDownIcon, MessageSquarePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { DROP_A_FOLDER_LINE, HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, cloudCreateRefusal, computerOffline, creationAwaits, dropRefusedLine, dropTileLine, goldenHead, isLocalWorkspace, kindWords, registerRequest, registeredLine, workspaceKind, workspaceState, type SealedImageCopy, type WorkspaceSize, type WorkspaceState } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { CREATION_ASKED, rebuildRefusedLine } from "../actions/format.js";
import { actionById, resolveActions, type ResolvedAction } from "../actions/registry.js";
import { sidebarActions } from "../actions/sidebarActions.js";
import { threadActions, threadTarget, type ThreadVerbs } from "../actions/threadActions.js";
import { useThreadVerbs, useWorkspaceVerbs } from "../actions/verbs.js";
import { CLOSE_TOAST_LABEL, useToastLife } from "./toastLife.js";
import { workspaceActions, workspaceTarget } from "../actions/workspaceActions.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { useOutOfMemoryReadings } from "../machine/live.js";
import { ForgetWorkspaceDialog } from "../components/ForgetWorkspaceDialog.js";
import { WorkspaceLookPopover } from "../components/look/WorkspaceLookPopover.js";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { SidebarContent, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem } from "../components/ui/sidebar.js";
import { Spinner } from "../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { cn, errorText } from "../lib/utils.js";
import { catalogIn, useCapabilities, useLabs, useReady, useSelectedId, useSelectedThreadId, useSelectedWorkspaceId, useSidebarProjects, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { hostAsleep } from "../boot.js";
import { goToAdjacentWorkspace } from "../shell/shellCommands.js";
import { onForgetWorkspaceRequest, onNewWorkspaceRequest, onProjectTripRequest, onRenameWorkspaceRequest, onWorkspaceLookRequest, type ProjectTripRequest, type WorkspaceLookRequest } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { droppedFolder, useFolderDrag, useWindowFolderDrag } from "./folderDrag.js";
import { ForwardsList } from "./ForwardsList.js";
import { ImportProjectDialog } from "./ImportProjectDialog.js";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.js";
import { ROW_LEAD_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, THREE_LINE_ROW_CLASS, groupRowId, threadRowId, workspaceRowId } from "./rowGrammar.js";
import { SearchRow } from "./SearchRow.js";
import { SectionRow } from "./SectionRow.js";
import { foldArchivedThreads, resolveAdjacentThreadId, resolveSettledTimestamp, splitSidebarThreads } from "./Sidebar.logic.js";
import { threadTree, workspaceOf } from "./threadTree.js";
import { CloudSetupRow } from "./CloudSetupRow.js";
import { SettingsRow } from "./SettingsRow.js";
import { HostFoot } from "../hosts/HostFoot.js";
import { PlaceFoot } from "../hosts/PlaceFoot.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { useSidebarMode, useSpaceWorkspaceId } from "./sidebarMode.js";
import { SpaceBar } from "./SpaceBar.js";
import { SpaceHeader } from "./SpaceHeader.js";
import { SPACE_LEAVING_SELECTOR, SpaceSlide } from "./SpaceSlide.js";
import { NO_SWIPE, readSwipe } from "./spaceSwipe.js";
import { ThreadRow } from "./ThreadRow.js";
import { WorkspaceDropTile, WorkspaceRow, type DropTile } from "./WorkspaceRow.js";
import { NEW_THREAD_SHORTCUT, NEW_THREAD_TITLE, compactTimeLabel, defaultWorkspaceName, onQuietComputer, whereWord } from "./workspaceRows.js";

/** Which workspaces have their idle shelf shut, so a shelf is open until this workspace's own chevron shuts it. */
const SETTLED_COLLAPSED_KEY = "wsp:sidebar-settled-collapsed";
/** The archive is the other way about: it holds the rows a person has stopped looking at, so it is shut until this
 * workspace's own chevron opens it, and the list remembers the ones that were opened. */
const ARCHIVED_OPEN_KEY = "wsp:sidebar-archived-open";
const NOTHING_COLLAPSED: ReadonlyArray<string> = [];
const workspaceIdsCodec: Codec<ReadonlyArray<string>> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string")) {
      throw new Error(`Expected workspace ids, got ${raw}.`);
    }
    return parsed as ReadonlyArray<string>;
  },
  encode: value => JSON.stringify(value),
};

/** A double-click on the name opens the box the menu's Rename opens, and only where that action can run: a refused
 * rename leaves the name as text, so nothing opens a field the runtime would turn away. */
const openerOf = (rename: ResolvedAction): (() => void) | undefined => (rename.refusal === null ? () => void runAction(rename) : undefined);

/** The machine one workspace runs on, read per row off the workspace that row's thread runs on: what a rename has
 * to reach. */
interface RowMachine {
  readonly state: WorkspaceState;
  readonly goneWords?: string | undefined;
}

interface VisibleProject {
  readonly project: SidebarProjectSnapshot;
  readonly active: ReadonlyArray<SidebarThreadSnapshot>;
  readonly settled: ReadonlyArray<SidebarThreadSnapshot>;
  readonly archived: ReadonlyArray<SidebarThreadSnapshot>;
}

/** Each workspace's threads split into the working ones, the settled shelf, and the ones the shelf has held long
 * enough to archive. The archive is a reading of the clock, so it comes from the same minute tick the countdowns do. */
function visibleProjects(projects: ReadonlyArray<SidebarProjectSnapshot>, nowMs: number): VisibleProject[] {
  return threadTree(projects).map(({ project, threads }) => {
    const { active, settled } = splitSidebarThreads(threads);
    return { project, active, ...foldArchivedThreads(settled, nowMs) };
  });
}

const NO_COPIES: readonly SealedImageCopy[] = [];

interface DialogState {
  readonly key: number;
  readonly name: string;
  /** The image head's size, read when the dialog opens; null until it lands or when no image says. */
  readonly goldenSize: WorkspaceSize | null;
  /** The copies of the image already built, read when the dialog opens, so a row's caption says whether the image
   * is there or is built first; empty until they land and on a host that answers for none. */
  readonly copies: readonly SealedImageCopy[];
}

/** A project trip's dialog open for one workspace; keyed per opening so its folder and plan reset. */
interface ProjectTripState extends ProjectTripRequest {
  readonly key: number;
}

export function WorkspaceSidebar() {
  const api = useStore(s => s.api);
  const conn = useStore(s => s.conn);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const costs = useStore(s => s.costs);
  const toast = useStore(s => s.toast);
  const clearToast = useStore(s => s.clearToast);
  useToastLife(toast, clearToast);
  // Keyed by the words it was set with, so a toast said since it took the slot never shows another sentence's action.
  const toastAction = useStore(s => (s.toastAction !== null && s.toastAction.for === s.toast ? s.toastAction : null));
  const select = useStore(s => s.select);
  const creations = useStore(s => s.creations);
  // Until the first list lands an empty group is unknown rather than empty, and the design spec gives this group no
  // waiting state of its own, so it holds nothing at all.
  const ready = useReady();
  const createWorkspace = useStore(s => s.createWorkspace);
  const createLocal = useStore(s => s.createLocalWorkspace);
  // One local workspace per host: the section's road to this computer says whether a pick makes it or goes to it.
  const hasLocal = useStore(s => s.workspaces.some(w => isLocalWorkspace(w)));
  const capabilities = useCapabilities();
  // Where a workspace can go: the same list Settings draws, so the dialog and that table never offer two answers.
  const places = useStore(s => s.places);
  const openAddComputer = useStore(s => s.openAddComputer);
  const hasGolden = useStore(s => s.hasGolden);
  const initJob = useStore(s => s.initJob);
  // Read on every render of the open dialog, so a build that finishes under it frees the keycap without reopening.
  const createRefusal = useMemo(() => cloudCreateRefusal({ hasGolden, job: initJob }), [hasGolden, initJob]);
  const selectedId = useSelectedId();
  const selectedThreadId = useSelectedThreadId();
  const selectedWorkspace = useWorkspace(useSelectedWorkspaceId());
  const nowMinute = useNowMinute();
  // One clock sample per minute tick so every idle countdown reads the same now.
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const [mode, setMode] = useSidebarMode();
  const labs = useLabs();
  const [settledCollapsed, setSettledCollapsed] = useLocalStorage(SETTLED_COLLAPSED_KEY, NOTHING_COLLAPSED, workspaceIdsCodec);
  const [archivedOpenIds, setArchivedOpenIds] = useLocalStorage(ARCHIVED_OPEN_KEY, NOTHING_COLLAPSED, workspaceIdsCodec);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  /** Workspace id to the machine id a rebuild was asked for; the action stays disabled while that machine is still the one reported. */
  const [rebuilding, setRebuilding] = useState<Readonly<Record<string, string>>>({});
  const [forgetting, setForgetting] = useState<string | null>(null);
  /** The look picker open for one workspace, on the fact the menu named, anchored to the element that stands for the
   * workspace when it opened: its space icon, else its row, else the sidebar itself; keyed per opening so it reopens fresh. */
  const [looking, setLooking] = useState<(WorkspaceLookRequest & { key: number; anchor: HTMLElement | null }) | null>(null);
  /** The row whose name is being typed, by the row id every row already carries, and whether that name is on its way;
   * one row at a time whatever its kind, the row is the only editor, and the field stays until the store has the name. */
  const [renaming, setRenaming] = useState<{ rowId: string; saving: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const renameThread = useStore(s => s.renameThread);
  const renameWorkspace = useStore(s => s.renameWorkspace);
  const canRename = useStore(s => s.api?.renameSession !== undefined);
  const harnesses = useStore(s => s.harnesses);
  const harnessesByWorkspace = useStore(s => s.harnessesByWorkspace);
  // The sidebar draws the rows, so it owns the rename's opener, as it owns the forget's dialog; a client that cannot
  // send the name offers no box, and the action carries that refusal.
  const defaultThreadVerbs = useThreadVerbs();
  const threadVerbs = useMemo<ThreadVerbs>(
    () => ({ ...defaultThreadVerbs, ...(canRename ? { rename: (threadId: string) => setRenaming({ rowId: threadRowId(threadId), saving: false }) } : {}) }),
    [canRename, defaultThreadVerbs],
  );
  const defaultVerbs = useWorkspaceVerbs();

  // This window is on another computer and the one running wsp has gone quiet: the rows stand as they were last
  // known, the line under the search row says why nothing moves, and the rows on that computer take no green, since
  // nothing here knows what they are doing while it sleeps.
  const asleep = hostAsleep(conn);
  const projects = useSidebarProjects();
  const visible = useMemo(() => visibleProjects(projects, nowMs), [projects, nowMs]);
  const outOfMemory = useOutOfMemoryReadings(projects);
  const sectionActions = useMemo(
    () => resolveActions(sidebarActions, { mode, hasLocal, connected: api !== null }, { setMode, newLocal: () => void createLocal() }, labs),
    [api, createLocal, hasLocal, labs, mode, setMode],
  );
  const spaceId = useSpaceWorkspaceId();
  const currentSpace = mode !== "spaces" ? null : (visible.find(v => v.project.id === spaceId) ?? null);
  const tripTarget = trip === null ? undefined : workspaces.find(w => w.id === trip.workspaceId);
  const forgetTarget = forgetting === null ? undefined : projects.find(p => p.id === forgetting);
  const lookTarget = looking === null ? undefined : workspaces.find(w => w.id === looking.workspaceId);

  const openDialog = (): void => {
    const key = Date.now();
    setDialog({ key, name: defaultWorkspaceName([...workspaces.map(w => w.name), ...creations.map(c => c.name)]), goldenSize: null, copies: NO_COPIES });
    void api?.getGolden().then(
      manifest => setDialog(d => (d?.key === key ? { ...d, goldenSize: goldenHead(manifest)?.size ?? null } : d)),
      () => {},
    );
    void api?.image?.().then(
      view => setDialog(d => (d?.key === key ? { ...d, copies: view.copies } : d)),
      () => {},
    );
  };
  const openDialogRef = useRef(openDialog);
  openDialogRef.current = openDialog;
  useEffect(() => onNewWorkspaceRequest(() => openDialogRef.current()), []);
  useEffect(() => onForgetWorkspaceRequest(({ workspaceId }) => setForgetting(workspaceId)), []);
  useEffect(
    () =>
      onRenameWorkspaceRequest(({ workspaceId }) => {
        // The row is the only editor, so a box asked for from the palette opens a section that was shut.
        setAllCollapsed(false);
        setRenaming({ rowId: workspaceRowId(workspaceId), saving: false });
      }),
    [],
  );
  useEffect(
    () =>
      onWorkspaceLookRequest(request => {
        const root = rootRef.current;
        const icon = Array.from(root?.querySelectorAll<HTMLElement>("[data-space-icon]") ?? []).find(el => el.dataset["spaceIcon"] === request.workspaceId);
        const row = Array.from(root?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []).find(el => el.dataset["rowId"] === workspaceRowId(request.workspaceId));
        setLooking({ ...request, key: Date.now(), anchor: icon ?? row ?? root });
      }),
    [],
  );
  useEffect(() => onProjectTripRequest(request => setTrip({ ...request, key: Date.now() })), []);

  const create = async (name: string, where?: string, size?: WorkspaceSize): Promise<void> => {
    setDialog(null);
    await createWorkspace(name, undefined, size, where);
  };

  // The row's rebuild spins until the status names a new machine, so it stands in for the registry's plain call.
  const rebuild = async (workspaceId: string): Promise<void> => {
    const project = projects.find(p => p.id === workspaceId);
    if (!api?.rebuild || !project) return;
    setRebuilding(r => ({ ...r, [project.id]: project.status?.machineId ?? project.workspace.machineId }));
    try {
      await api.rebuild(project.id);
    } catch (e) {
      setRebuilding(({ [project.id]: _dropped, ...rest }) => rest);
      useStore.setState({ toast: rebuildRefusedLine(project.displayName) });
    }
  };
  const verbs = { ...defaultVerbs, rebuild: api?.rebuild ? rebuild : undefined };

  // A folder dragged from the desktop: only the desktop shell can read where it is, and only a client with the import
  // ops has anywhere to put it, so a browser tab's rows stay rows.
  const droppedPath = desktopBridge()?.droppedPath;
  useWindowFolderDrag(droppedPath !== undefined && verbs.importProject !== undefined);
  const dragging = useFolderDrag(s => s.dragging);
  /** Where a dropped folder goes, by the workspace's kind: registered at once on this computer, with the result or
   * the refusal in the toast; read into the import dialog for a box. A file is neither. */
  const landDrop = async (project: SidebarProjectSnapshot, transfer: DataTransfer): Promise<void> => {
    useFolderDrag.getState().end();
    const file = droppedFolder(transfer);
    if (file === null || droppedPath === undefined) {
      useStore.setState({ toast: DROP_A_FOLDER_LINE });
      return;
    }
    const source = droppedPath(file);
    if (kindWords(workspaceKind(project.workspace)).imports !== "registers") {
      setTrip({ key: Date.now(), workspaceId: project.id, trip: "import", source });
      return;
    }
    if (api?.importProject === undefined) return;
    try {
      const landed = await api.importProject({ workspaceId: project.id, ...registerRequest(source) });
      useStore.getState().landProject(project.id, landed.project);
      useStore.setState({ toast: registeredLine(landed.dest) });
    } catch (e) {
      useStore.setState({ toast: dropRefusedLine(source) });
    }
  };
  /** The row's tile while a drag lasts, where a drop has somewhere to go: a kind with an import road, on a machine the
   * import action is not refused for, so a gone or zombie row stays a row. */
  const tileFor = (project: SidebarProjectSnapshot, actions: ReadonlyArray<ResolvedAction>): DropTile | null => {
    if (!dragging || actionById(actions, "import-project").refusal !== null) return null;
    const label = dropTileLine(workspaceKind(project.workspace), project.displayName);
    return label === null ? null : { label, onDrop: transfer => void landDrop(project, transfer) };
  };

  const toggleCollapsed = (id: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSettled = (id: string): void => {
    setSettledCollapsed(prev => (prev.includes(id) ? prev.filter(other => other !== id) : [...prev, id]));
  };

  const toggleArchived = (id: string): void => {
    setArchivedOpenIds(prev => (prev.includes(id) ? prev.filter(other => other !== id) : [...prev, id]));
  };

  /** The name a person typed on a row, whichever kind of row it is: the store takes it while the field stays as it
   * is, and the field closes only once the store has it. A refusal leaves the name in the field to try again, with
   * the reason in the toast, so nothing a person typed is lost to a message. */
  const sendName = async (rowId: string, take: () => Promise<boolean>): Promise<void> => {
    setRenaming({ rowId, saving: true });
    const named = await take();
    setRenaming(open => (open?.rowId !== rowId ? open : named ? null : { rowId, saving: false }));
  };

  /** One thread's row, wherever it is listed: the active list and the idle shelf read the same props. The row is
   * told the workspace the thread itself runs in, which is the one it is drawn under except where an agent opened
   * a thread on another workspace, and the workspace whose rows it sits among, which is what it names against.
   * Its verbs reach the machine that workspace runs on, never the one whose rows it sits among: a rename or a stop
   * travels to the thread's own machine, so a thread on a machine that is gone is refused wherever it is drawn. */
  const threadRow = (thread: SidebarThreadSnapshot, time: string, under: SidebarProjectSnapshot) => {
    const owner = workspaceOf(projects, thread) ?? under;
    const target = threadTarget(thread, { catalog: catalogIn({ harnesses, harnessesByWorkspace }, thread.workspaceId, thread.harness), ...machineOf(owner) });
    const actionsOf = resolveActions(threadActions, target, threadVerbs);
    const rowId = threadRowId(thread.id);
    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        time={time}
        runs={{ workspace: owner.displayName, where: whereWord(owner) }}
        under={under.displayName}
        active={selectedId === thread.workspaceId && selectedThreadId === thread.id}
        renaming={renaming?.rowId === rowId}
        saving={renaming?.rowId === rowId && renaming.saving}
        onSelect={() => select(thread.workspaceId, thread.threadId)}
        onContextMenu={event => void openContextMenu(event, actionsOf)}
        onRename={title => void sendName(rowId, () => renameThread({ sessionId: thread.sessionId, workspaceId: thread.workspaceId, harness: thread.harness, title }))}
        onRenameCancel={() => setRenaming(null)}
        onRenameOpen={openerOf(actionById(actionsOf, "rename"))}
      />
    );
  };

  /** The machine one workspace runs on, as a thread's verbs read it: the state its row shows and, where it is gone,
   * the words that say so. Read per thread off the workspace the thread itself runs on. */
  const machineOf = (project: SidebarProjectSnapshot): RowMachine => {
    const workspace = workspaceTarget(project.workspace, project.status, places);
    return { state: workspaceState(workspace), ...(workspace.reason !== null ? { goneWords: workspace.reason } : {}) };
  };

  /** What both bodies need about one workspace: the actions every surface of it reads, and the action that opens
   * its first thread. */
  const blockOf = (project: SidebarProjectSnapshot) => {
    const actions = resolveActions(workspaceActions, workspaceTarget(project.workspace, project.status, places), verbs, labs);
    return { actions, newThreadAction: actionById(actions, "new-thread") };
  };

  /** The rows under one workspace, whichever body draws them: the line that opens its first thread while it has
   * none, the working rows, then the idle shelf under its own header with the archive nested inside it. The list
   * and Spaces both read this, so the row grammar has one home. */
  const threadsOf = ({ project, active, settled, archived }: VisibleProject, newThreadAction: ResolvedAction, shut: boolean) => {
    const settledOpen = !settledCollapsed.includes(project.id);
    const archivedOpen = archivedOpenIds.includes(project.id);
    /** Everything the shelf holds, the archived rows included, since shutting it hides the archive with them: the
     * count on a shut shelf is what it took away, not only the rows it draws itself. */
    const shelved = settled.length + archived.length;
    return (
      <>
        {newThreadAction.refusal === null && project.threads.length === 0 ? (
          <SidebarMenuSub>
            <SidebarMenuSubItem data-thread-selection-safe>
              <span className="block min-h-8 px-2 py-2 text-[11px] leading-4 text-muted-foreground">
                No threads yet.{" "}
                <button
                  type="button"
                  onClick={() => void runAction(newThreadAction)}
                  className="cursor-pointer rounded-sm outline-hidden ring-ring hover:text-sidebar-foreground focus-visible:ring-2"
                >
                  New thread {NEW_THREAD_SHORTCUT}
                </button>
              </span>
            </SidebarMenuSubItem>
          </SidebarMenuSub>
        ) : null}
        {!shut && active.length + shelved > 0 ? (
          <SidebarMenuSub>
            {active.map(thread => threadRow(thread, compactTimeLabel(thread.startedAt), project))}
            {shelved > 0 ? (
              <ThreadGroupRow rowId={groupRowId("settled", project.id)} label="Idle" count={shelved} open={settledOpen} onToggle={() => toggleSettled(project.id)} />
            ) : null}
            {settledOpen ? settled.map(thread => threadRow(thread, compactTimeLabel(resolveSettledTimestamp(thread)), project)) : null}
            {settledOpen && archived.length > 0 ? (
              <ThreadGroupRow rowId={groupRowId("archived", project.id)} label="Archived" count={archived.length} open={archivedOpen} onToggle={() => toggleArchived(project.id)} />
            ) : null}
            {settledOpen && archivedOpen ? archived.map(thread => threadRow(thread, compactTimeLabel(resolveSettledTimestamp(thread)), project)) : null}
          </SidebarMenuSub>
        ) : null}
      </>
    );
  };

  /** One workspace in the list body: its row and the rows under it. */
  const listItem = (visibleProject: VisibleProject) => {
    const { project } = visibleProject;
    const { actions, newThreadAction } = blockOf(project);
    const isCollapsed = collapsed.has(project.id);
    const rebuildAsked = rebuilding[project.id] !== undefined && rebuilding[project.id] === (project.status?.machineId ?? project.workspace.machineId);
    const naming = renaming?.rowId === workspaceRowId(project.id);
    const tile = tileFor(project, actions);
    return (
      <SidebarMenuItem
        key={project.id}
        // A row holding the box takes no menu over it, as a thread row being named does not.
        {...(naming ? {} : { onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, actions, { returnTo: event.currentTarget.querySelector<HTMLElement>("[data-sidebar-row]") }) })}
      >
        {tile !== null ? (
          <WorkspaceDropTile rowId={workspaceRowId(project.id)} tile={tile} />
        ) : (
        <WorkspaceRow
          project={project}
          cost={costs[project.id] ?? null}
          outOfMemory={outOfMemory[project.id]}
          quiet={onQuietComputer(project, asleep)}
          nowMs={nowMs}
          actions={actions}
          active={selectedId === project.id && selectedThreadId === null}
          collapsed={isCollapsed}
          rebuildAsked={rebuildAsked}
          renaming={naming}
          saving={naming && renaming?.saving === true}
          onSelect={() => select(project.id)}
          onToggleCollapsed={() => toggleCollapsed(project.id)}
          onRename={name => void sendName(workspaceRowId(project.id), () => renameWorkspace({ workspaceId: project.id, name }))}
          onRenameCancel={() => setRenaming(null)}
          onRenameOpen={openerOf(actionById(actions, "rename"))}
        />
        )}
        {threadsOf(visibleProject, newThreadAction, isCollapsed)}
      </SidebarMenuItem>
    );
  };

  /** The one workspace the Spaces body holds: its header block, then its rows in the list's own grammar. The header
   * takes the same name box the row has, keyed the same way, so a rename asked for anywhere reaches one editor. */
  const spaceItem = (visibleProject: VisibleProject) => {
    const { project } = visibleProject;
    const { actions, newThreadAction } = blockOf(project);
    const naming = renaming?.rowId === workspaceRowId(project.id);
    return (
      <SidebarMenuItem key={project.id}>
        <SpaceHeader
          project={project}
          cost={costs[project.id] ?? null}
          outOfMemory={outOfMemory[project.id]}
          nowMs={nowMs}
          actions={actions}
          renaming={naming}
          saving={naming && renaming?.saving === true}
          onSelect={() => select(project.id)}
          onRename={name => void sendName(workspaceRowId(project.id), () => renameWorkspace({ workspaceId: project.id, name }))}
          onRenameCancel={() => setRenaming(null)}
          onRenameOpen={openerOf(actionById(actions, "rename"))}
        />
        {threadsOf(visibleProject, newThreadAction, false)}
      </SidebarMenuItem>
    );
  };

  /** One space's whole body, drawn for the workspace on screen and, while a slide runs, for the one leaving too. */
  const spacePane = (workspaceId: string) => {
    const pane = visible.find(v => v.project.id === workspaceId);
    return pane === undefined ? null : <SidebarMenu>{spaceItem(pane)}</SidebarMenu>;
  };

  // The body on its way out of a slide is still drawn: its rows are not the ones the keyboard walks.
  const rows = (): HTMLElement[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []).filter(row => row.closest(SPACE_LEAVING_SELECTOR) === null);
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

  /** A two-finger swipe over the sidebar moves a space, and it lands where the arrows land, through the one verb
   * they run: the swipe is another way to ask, not another rule. It rides the whole body under the search row, the
   * empty room under the rows and the space bar included, since a hand swipes where it is and not on a row; a
   * scroll is left alone, since the read never takes the event. The gesture it belongs to lives across the wheel
   * events that make it up, so a swipe that keeps going moves one space and no more. */
  const swipe = useRef(NO_SWIPE);
  const onWheel = (e: WheelEvent<HTMLElement>): void => {
    const read = readSwipe(swipe.current, { deltaX: e.deltaX, deltaY: e.deltaY, at: e.timeStamp });
    swipe.current = read.gesture;
    if (read.step !== 0) goToAdjacentWorkspace(read.step);
  };

  const offline = useMemo(() => computerOffline(Object.values(statuses)), [statuses]);
  const search = (
    <div className="px-[var(--sidebar-content-inset)] pt-3 pb-1" data-sidebar-search>
      <div className="relative">
        <SearchRow
          action={
            selectedWorkspace !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarGroupAction
                      className="top-1.5 text-sidebar-muted-foreground transition-colors duration-150"
                      aria-label="New thread"
                      onClick={() => verbs.newThread(selectedWorkspace.id)}
                    />
                  }
                >
                  <MessageSquarePlusIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">{NEW_THREAD_TITLE}</TooltipPopup>
              </Tooltip>
            ) : undefined
          }
        />
      </div>
      {asleep ? (
        <p data-sidebar-asleep className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
          {HOST_ASLEEP_LINE}
        </p>
      ) : offline ? (
        <p data-sidebar-offline className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
          {PROVIDER_UNREACHED_LINE}
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} onWheel={mode === "spaces" ? onWheel : undefined} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={search}>
          <SidebarGroup className="pt-0" {...(mode === "spaces" ? { onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, sectionActions) } : {})}>
            {mode === "spaces" ? null : (
              <SectionRow
                label="Workspaces"
                count={projects.length + creations.length}
                collapsed={allCollapsed}
                onToggle={() => setAllCollapsed(c => !c)}
                onContextMenu={event => void openContextMenu(event, sectionActions)}
                action={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarGroupAction
                          data-k="new-workspace"
                          className="top-1.5 text-sidebar-muted-foreground transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50"
                          aria-label="New workspace"
                          disabled={api === null}
                          onClick={openDialog}
                        />
                      }
                    >
                      <PlusIcon />
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">New workspace</TooltipPopup>
                  </Tooltip>
                }
              />
            )}
            {allCollapsed && mode !== "spaces" ? null : (
              <SidebarGroupContent>
                <SidebarMenu>
                  {mode === "spaces" ? null : visible.map(listItem)}
                  {/* Under the rows and not over them: a workspace being made is the newest of them, so its row waits
                      where it will stand once it is one and nothing already drawn moves when it lands. */}
                  {creations.map(creation => (
                    <CreationRow key={creation.key} creation={creation} active={selectedId === creation.key} onSelect={() => select(creation.key)} />
                  ))}
                </SidebarMenu>
                {currentSpace === null ? null : (
                  <SpaceSlide currentId={currentSpace.project.id} order={visible.map(v => v.project.id)}>
                    {spacePane}
                  </SpaceSlide>
                )}
                {ready && visible.length === 0 && creations.length === 0 ? (
                  <Empty className="py-8">
                    <EmptyHeader>
                      <EmptyTitle>No workspaces yet</EmptyTitle>
                      <EmptyDescription>Add a computer or connect a provider, then create one.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
              </SidebarGroupContent>
            )}
          </SidebarGroup>
          <ForwardsList />
        </SidebarContent>
        <SidebarChromeFooter>
          {toast ? (
            <div
              role="status"
              aria-label={toast}
              onClick={clearToast}
              className="mb-1 flex cursor-pointer items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-control-surface px-3 py-2 text-xs break-words text-sidebar-foreground"
            >
              <span className="min-w-0 flex-1">{toast}</span>
              {toastAction !== null ? (
                <Button
                  data-toast-action
                  size="xs"
                  variant="outline"
                  className="shrink-0 font-mono"
                  onClick={event => {
                    event.stopPropagation();
                    toastAction.run();
                    clearToast();
                  }}
                >
                  {toastAction.word}
                </Button>
              ) : null}
              <Button
                data-toast-close
                size="icon-xs"
                variant="ghost-muted"
                aria-label={CLOSE_TOAST_LABEL}
                className="shrink-0"
                onClick={event => {
                  event.stopPropagation();
                  clearToast();
                }}
              >
                <XIcon />
              </Button>
            </div>
          ) : null}
          {mode === "spaces" ? (
            <SpaceBar
              projects={visible.map(v => v.project)}
              currentId={currentSpace?.project.id ?? null}
              canCreate={api !== null}
              onSelect={select}
              onContextMenu={(project, event) => void openContextMenu(event, blockOf(project).actions)}
              onCreate={openDialog}
            />
          ) : null}
          <CloudSetupRow />
          <SettingsRow />
          <PlaceFoot />
          <HostFoot />
        </SidebarChromeFooter>
      </div>
      {dialog ? (
        <NewWorkspaceDialog
          key={dialog.key}
          initialName={dialog.name}
          places={places}
          copies={dialog.copies}
          sizes={capabilities?.sizes ?? []}
          goldenSize={dialog.goldenSize}
          refusal={createRefusal?.line ?? null}
          onCreate={(name, where, size) => void create(name, where, size)}
          onCancel={() => setDialog(null)}
          onAddComputer={() => {
            setDialog(null);
            openAddComputer();
          }}
        />
      ) : null}
      {trip !== null && tripTarget !== undefined ? (
        trip.trip === "import" ? (
          <ImportProjectDialog key={trip.key} workspace={tripTarget} {...(trip.source !== undefined ? { initialSource: trip.source } : {})} onClose={() => setTrip(null)} />
        ) : (
          <ExportProjectDialog key={trip.key} workspace={tripTarget} onClose={() => setTrip(null)} />
        )
      ) : null}
      {looking !== null && lookTarget !== undefined ? (
        <WorkspaceLookPopover key={looking.key} workspace={lookTarget} part={looking.part} anchor={looking.anchor} onClose={() => setLooking(null)} />
      ) : null}
      {forgetTarget !== undefined ? (
        <ForgetWorkspaceDialog
          workspace={forgetTarget.workspace}
          threads={forgetTarget.threads.length}
          open
          onOpenChange={next => {
            if (!next) setForgetting(null);
          }}
        />
      ) : null}
    </>
  );
}

/** The header over one group of thread rows, which shuts and opens it: the word alone while the group is open, the
 * word with its count while it is shut, so a shut group still says how much it holds. The idle shelf and the archive
 * under it are one row, so neither can drift from the other. */
function ThreadGroupRow({ rowId, label, count, open, onToggle }: { rowId: string; label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <SidebarMenuSubItem data-thread-selection-safe>
      <button
        type="button"
        data-sidebar-row
        data-row-id={rowId}
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-hidden ring-ring focus-visible:ring-2"
      >
        <span className="text-xs font-medium text-sidebar-whisper/50">{open ? label : `${label} (${count})`}</span>
        <span className="h-px flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon aria-hidden className={cn("size-3 text-sidebar-whisper/50 transition-transform", open && "rotate-180")} />
      </button>
    </SidebarMenuSubItem>
  );
}

/** A workspace still being created: the spinner and the step the create is waiting on, wrapped rather than cut at
 * the sidebar's width. A note on a step already taken stays in the log: this line is the create's state. */
function CreationRow({ creation, active, onSelect }: { creation: Creation; active: boolean; onSelect: () => void }) {
  const failed = creation.failed !== null;
  const line = failed ? creation.failed.title : creation.lines.findLast(l => creationAwaits(l.stage))?.message ?? CREATION_ASKED;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        aria-busy={failed ? undefined : "true"}
        data-sidebar-row
        data-row-id={creation.key}
        className={cn(THREE_LINE_ROW_CLASS, "h-auto min-h-15")}
        onClick={onSelect}
      >
        <span aria-hidden className={ROW_LEAD_CLASS}>
          {failed ? <span className="size-2 rounded-full bg-destructive" /> : <Spinner className="size-3.5" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="truncate text-sidebar-foreground">{creation.name}</span>
          <span className={cn("whitespace-normal break-words text-[11px] font-normal", failed ? "text-destructive-foreground" : "text-sidebar-muted-foreground")}>{line}</span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
