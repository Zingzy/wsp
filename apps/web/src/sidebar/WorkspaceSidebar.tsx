// SPDX-License-Identifier: AGPL-3.0-only
// The left region: workspaces (machines) first, their sessions as threads
// under each, over the adapter's SidebarProjectSnapshot. The search row, the
// Workspaces section row that shuts them all and opens the new-workspace
// dialog, the settled shelf, the Spaces body with one workspace's rows under
// its header and a dot per workspace at the bottom, the slide and the
// two-finger swipe that move between them, keyboard traversal, the
// rebuild of a zombie or gone machine, the forget of a gone one and the
// project trips' dialogs live here; the rows are WorkspaceRow and ThreadRow
// beside this file, and the logic comes from the copied t3code files. Every
// action a row carries, as a button or in its right-click menu, comes from
// the workspace and thread registries. The surface itself is the shell's
// sidebar-glass: nothing here paints a background.
import { ChevronDownIcon, MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { PROVIDER_UNREACHED_LINE, computerOffline, goldenHead, workspaceState, type WorkspaceSize, type WorkspaceState } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { actionById, resolveActions, type ResolvedAction } from "../actions/registry.js";
import { sidebarActions } from "../actions/sidebarActions.js";
import { threadActions, threadTarget, type ThreadVerbs } from "../actions/threadActions.js";
import { useThreadVerbs, useWorkspaceVerbs } from "../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../actions/workspaceActions.js";
import { deriveSidebarProjects, type SidebarProjectSnapshot, type SidebarThreadSnapshot } from "../adapt/index.js";
import { useOutOfMemoryReadings } from "../machine/live.js";
import { ForgetWorkspaceDialog } from "../components/ForgetWorkspaceDialog.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { SidebarContent, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem } from "../components/ui/sidebar.js";
import { Spinner } from "../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { cn } from "../lib/utils.js";
import { catalogIn, useCapabilities, useSelectedId, useSelectedThreadId, useSelectedWorkspaceId, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { onForgetWorkspaceRequest, onNewWorkspaceRequest, onProjectTripRequest, onRenameWorkspaceRequest, type ProjectTripRequest } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { ImportProjectDialog } from "./ImportProjectDialog.js";
import { NewWorkspaceDialog, type WorkspaceStart } from "./NewWorkspaceDialog.js";
import { ROW_LEAD_CLASS, ROW_META_CLASS, TWO_LINE_ROW_CLASS, threadRowId, workspaceRowId } from "./rowGrammar.js";
import { SearchRow } from "./SearchRow.js";
import { SectionRow } from "./SectionRow.js";
import { resolveAdjacentThreadId, resolveSettledTimestamp, splitSidebarThreads } from "./Sidebar.logic.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { useSidebarMode } from "./sidebarMode.js";
import { SpaceDots } from "./SpaceDots.js";
import { SpaceHeader } from "./SpaceHeader.js";
import { SPACE_LEAVING_SELECTOR, SpaceSlide } from "./SpaceSlide.js";
import { NO_SWIPE, readSwipe } from "./spaceSwipe.js";
import { ThreadRow } from "./ThreadRow.js";
import { WorkspaceRow } from "./WorkspaceRow.js";
import { NEW_THREAD_SHORTCUT, NEW_THREAD_TITLE, compactTimeLabel, defaultWorkspaceName } from "./workspaceRows.js";

/** Which workspaces have their idle shelf shut, so a shelf is open until this workspace's own chevron shuts it. */
const SETTLED_COLLAPSED_KEY = "wsp:sidebar-settled-collapsed";
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

/** The machine every thread of one workspace runs on: what a rename has to reach. */
interface RowMachine {
  readonly state: WorkspaceState;
  readonly goneWords?: string | undefined;
}

interface VisibleProject {
  readonly project: SidebarProjectSnapshot;
  readonly active: ReadonlyArray<SidebarThreadSnapshot>;
  readonly settled: ReadonlyArray<SidebarThreadSnapshot>;
}

/** Each workspace's threads split into the working ones and the settled shelf. */
function visibleProjects(projects: ReadonlyArray<SidebarProjectSnapshot>): VisibleProject[] {
  return projects.map(project => ({ project, ...splitSidebarThreads(project.threads) }));
}

interface DialogState {
  readonly key: number;
  readonly name: string;
  /** The golden head's size, read when the dialog opens; null until it lands or when no golden says. */
  readonly goldenSize: WorkspaceSize | null;
}

/** A project trip's dialog open for one workspace; keyed per opening so its folder and plan reset. */
interface ProjectTripState extends ProjectTripRequest {
  readonly key: number;
}

export function WorkspaceSidebar() {
  const api = useStore(s => s.api);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const costs = useStore(s => s.costs);
  const toast = useStore(s => s.toast);
  const clearToast = useStore(s => s.clearToast);
  const select = useStore(s => s.select);
  const creations = useStore(s => s.creations);
  const createWorkspace = useStore(s => s.createWorkspace);
  const capabilities = useCapabilities();
  const selectedId = useSelectedId();
  const selectedThreadId = useSelectedThreadId();
  const selectedWorkspace = useWorkspace(useSelectedWorkspaceId());
  const nowMinute = useNowMinute();
  // One clock sample per minute tick so every idle countdown reads the same now.
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const [mode, setMode] = useSidebarMode();
  const [settledCollapsed, setSettledCollapsed] = useLocalStorage(SETTLED_COLLAPSED_KEY, NOTHING_COLLAPSED, workspaceIdsCodec);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  /** Workspace id to the machine id a rebuild was asked for; the action stays disabled while that machine is still the one reported. */
  const [rebuilding, setRebuilding] = useState<Readonly<Record<string, string>>>({});
  const [forgetting, setForgetting] = useState<string | null>(null);
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

  const projects = useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  const visible = useMemo(() => visibleProjects(projects), [projects]);
  const outOfMemory = useOutOfMemoryReadings(projects);
  const sectionActions = useMemo(() => resolveActions(sidebarActions, { mode }, { setMode }), [mode, setMode]);
  // Spaces draws the selected workspace, and the first one in the sidebar's order until something is selected.
  const currentSpace = mode !== "spaces" ? null : (visible.find(v => v.project.id === selectedId) ?? visible[0] ?? null);
  const tripTarget = trip === null ? undefined : workspaces.find(w => w.id === trip.workspaceId);
  const forgetTarget = forgetting === null ? undefined : projects.find(p => p.id === forgetting);

  const openDialog = (): void => {
    const key = Date.now();
    setDialog({ key, name: defaultWorkspaceName([...workspaces.map(w => w.name), ...creations.map(c => c.name)]), goldenSize: null });
    void api?.getGolden().then(
      manifest => setDialog(d => (d?.key === key ? { ...d, goldenSize: goldenHead(manifest)?.size ?? null } : d)),
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
  useEffect(() => onProjectTripRequest(request => setTrip({ ...request, key: Date.now() })), []);

  const create = async (name: string, start: WorkspaceStart, size?: WorkspaceSize): Promise<void> => {
    setDialog(null);
    const id = await createWorkspace(name, undefined, size);
    if (start === "import" && id !== null) setTrip({ key: Date.now(), workspaceId: id, trip: "import" });
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
      useStore.setState({ toast: `${project.displayName}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const verbs = { ...defaultVerbs, rebuild: api?.rebuild ? rebuild : undefined };

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

  /** The name a person typed on a row, whichever kind of row it is: the store takes it while the field stays as it
   * is, and the field closes only once the store has it. A refusal leaves the name in the field to try again, with
   * the reason in the toast, so nothing a person typed is lost to a message. */
  const sendName = async (rowId: string, take: () => Promise<boolean>): Promise<void> => {
    setRenaming({ rowId, saving: true });
    const named = await take();
    setRenaming(open => (open?.rowId !== rowId ? open : named ? null : { rowId, saving: false }));
  };

  /** One thread's row, wherever it is listed: the active list and the idle shelf read the same props. */
  const threadRow = (thread: SidebarThreadSnapshot, time: string, machine: RowMachine) => {
    const target = threadTarget(thread, { catalog: catalogIn({ harnesses, harnessesByWorkspace }, thread.workspaceId, thread.harness), ...machine });
    const actionsOf = resolveActions(threadActions, target, threadVerbs);
    const rowId = threadRowId(thread.id);
    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        time={time}
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

  /** What both bodies need about one workspace: the actions every surface of it reads, the action that opens its
   * first thread, and the machine its threads run on. */
  const blockOf = (project: SidebarProjectSnapshot) => {
    const workspace = workspaceTarget(project.workspace, project.status);
    const actions = resolveActions(workspaceActions, workspace, verbs);
    const machine: RowMachine = { state: workspaceState(workspace), ...(workspace.reason !== null ? { goneWords: workspace.reason } : {}) };
    return { actions, newThreadAction: actionById(actions, "new-thread"), machine };
  };

  /** The rows under one workspace, whichever body draws them: the line that opens its first thread while it has
   * none, the working rows, then the idle shelf under its own header. The list and Spaces both read this, so the
   * row grammar has one home. */
  const threadsOf = ({ project, active, settled }: VisibleProject, newThreadAction: ResolvedAction, machine: RowMachine, shut: boolean) => {
    const settledOpen = !settledCollapsed.includes(project.id);
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
        {!shut && active.length + settled.length > 0 ? (
          <SidebarMenuSub>
            {active.map(thread => threadRow(thread, compactTimeLabel(thread.startedAt), machine))}
            {settled.length > 0 ? (
              <SidebarMenuSubItem data-thread-selection-safe>
                <button
                  type="button"
                  data-sidebar-row
                  data-row-id={`settled:${project.id}`}
                  aria-expanded={settledOpen}
                  onClick={() => toggleSettled(project.id)}
                  className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-hidden ring-ring focus-visible:ring-2"
                >
                  <span className="text-xs font-medium text-muted-foreground/50">
                    {settledOpen ? "Idle" : `Idle (${settled.length})`}
                  </span>
                  <span className="h-px flex-1 bg-sidebar-border/60" />
                  <ChevronDownIcon aria-hidden className={cn("size-3 text-muted-foreground/50 transition-transform", settledOpen && "rotate-180")} />
                </button>
              </SidebarMenuSubItem>
            ) : null}
            {settledOpen ? settled.map(thread => threadRow(thread, compactTimeLabel(resolveSettledTimestamp(thread)), machine)) : null}
          </SidebarMenuSub>
        ) : null}
      </>
    );
  };

  /** One workspace in the list body: its row and the rows under it. */
  const listItem = (visibleProject: VisibleProject) => {
    const { project } = visibleProject;
    const { actions, newThreadAction, machine } = blockOf(project);
    const isCollapsed = collapsed.has(project.id);
    const rebuildAsked = rebuilding[project.id] !== undefined && rebuilding[project.id] === (project.status?.machineId ?? project.workspace.machineId);
    const naming = renaming?.rowId === workspaceRowId(project.id);
    return (
      <SidebarMenuItem
        key={project.id}
        // A row holding the box takes no menu over it, as a thread row being named does not.
        {...(naming ? {} : { onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, actions, { returnTo: event.currentTarget.querySelector<HTMLElement>("[data-sidebar-row]") }) })}
      >
        <WorkspaceRow
          project={project}
          cost={costs[project.id] ?? null}
          outOfMemory={outOfMemory[project.id]}
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
        {threadsOf(visibleProject, newThreadAction, machine, isCollapsed)}
      </SidebarMenuItem>
    );
  };

  /** The one workspace the Spaces body holds: its header block, then its rows in the list's own grammar. The header
   * takes the same name box the row has, keyed the same way, so a rename asked for anywhere reaches one editor. */
  const spaceItem = (visibleProject: VisibleProject) => {
    const { project } = visibleProject;
    const { actions, newThreadAction, machine } = blockOf(project);
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
          onRename={name => void sendName(workspaceRowId(project.id), () => renameWorkspace({ workspaceId: project.id, name }))}
          onRenameCancel={() => setRenaming(null)}
          onRenameOpen={openerOf(actionById(actions, "rename"))}
        />
        {threadsOf(visibleProject, newThreadAction, machine, false)}
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

  /** A two-finger swipe over the workspaces moves a space, the way the arrows and the dots do; it rides that group
   * alone, so the search row above it and the forwards under it still scroll as they are. The gesture it belongs to
   * lives across the wheel events that make it up, so a swipe that keeps going moves one space and no more. */
  const swipe = useRef(NO_SWIPE);
  const onWheel = (e: WheelEvent<HTMLElement>): void => {
    const read = readSwipe(swipe.current, { deltaX: e.deltaX, deltaY: e.deltaY, at: e.timeStamp });
    swipe.current = read.gesture;
    if (read.step === 0) return;
    const next = resolveAdjacentThreadId({
      threadIds: visible.map(v => v.project.id),
      currentThreadId: currentSpace?.project.id ?? null,
      direction: read.step === 1 ? "next" : "previous",
    });
    if (next !== null) select(next);
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
      {offline ? (
        <p data-sidebar-offline className={cn(ROW_META_CLASS, "px-2 pt-1 leading-4")}>
          {PROVIDER_UNREACHED_LINE}
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={search}>
          <SidebarGroup className="pt-0" onWheel={mode === "spaces" ? onWheel : undefined}>
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
            {allCollapsed ? null : (
              <SidebarGroupContent>
                <SidebarMenu>
                  {creations.map(creation => (
                    <CreationRow key={creation.key} creation={creation} active={selectedId === creation.key} onSelect={() => select(creation.key)} />
                  ))}
                  {mode === "spaces" ? null : visible.map(listItem)}
                </SidebarMenu>
                {currentSpace === null ? null : (
                  <SpaceSlide currentId={currentSpace.project.id} order={visible.map(v => v.project.id)}>
                    {spacePane}
                  </SpaceSlide>
                )}
                {visible.length === 0 && creations.length === 0 ? (
                  <Empty className="py-8">
                    <EmptyHeader>
                      <EmptyTitle>No workspaces yet</EmptyTitle>
                      <EmptyDescription>Create one to fork a machine from your golden image.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
              </SidebarGroupContent>
            )}
          </SidebarGroup>
          <ForwardsList />
        </SidebarContent>
      </div>
      <SidebarChromeFooter items={[]}>
        {toast ? (
          <div
            role="status"
            aria-label={toast}
            onClick={clearToast}
            className="mb-1 cursor-pointer rounded-lg border border-sidebar-border bg-sidebar-control-surface px-3 py-2 text-xs break-words text-sidebar-foreground"
          >
            {toast}
          </div>
        ) : null}
        {mode === "spaces" && visible.length > 0 ? <SpaceDots projects={visible.map(v => v.project)} currentId={currentSpace?.project.id ?? null} onSelect={select} /> : null}
      </SidebarChromeFooter>
      {dialog ? (
        <NewWorkspaceDialog
          key={dialog.key}
          initialName={dialog.name}
          sizes={capabilities?.sizes ?? []}
          goldenSize={dialog.goldenSize}
          onCreate={(name, start, size) => void create(name, start, size)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {trip !== null && tripTarget !== undefined ? (
        trip.trip === "import" ? (
          <ImportProjectDialog key={trip.key} workspace={tripTarget} onClose={() => setTrip(null)} />
        ) : (
          <ExportProjectDialog key={trip.key} workspace={tripTarget} onClose={() => setTrip(null)} />
        )
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

/** A workspace still being created: the spinner and the runtime's latest stage, wrapped rather than cut at the sidebar's width. */
function CreationRow({ creation, active, onSelect }: { creation: Creation; active: boolean; onSelect: () => void }) {
  const failed = creation.failed !== null;
  const line = failed ? creation.failed.title : creation.lines.at(-1)?.message ?? "Asking the runtime for a fork.";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        aria-busy={failed ? undefined : "true"}
        data-sidebar-row
        data-row-id={creation.key}
        className={cn(TWO_LINE_ROW_CLASS, "h-auto min-h-11")}
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
