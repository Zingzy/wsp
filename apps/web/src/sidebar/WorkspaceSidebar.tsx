// SPDX-License-Identifier: AGPL-3.0-only
// The left region: workspaces (machines) first, their sessions as threads
// under each, over the adapter's SidebarProjectSnapshot. The search row, the
// Workspaces section row that shuts them all and opens the new-workspace
// dialog, the settled shelf, keyboard traversal, the rebuild of a zombie or
// gone machine, the forget of a gone one and the project trips' dialogs live
// here; the rows are WorkspaceRow and ThreadRow beside this file, and the
// logic comes from the copied t3code files. Every action a row carries, as a
// button or in its right-click menu, comes from the workspace and thread
// registries. The surface itself is the shell's sidebar-glass: nothing here
// paints a background.
import { ChevronDownIcon, MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { goldenHead, type WorkspaceSize } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { actionById, resolveActions } from "../actions/registry.js";
import { threadActions } from "../actions/threadActions.js";
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
import { useCapabilities, useSelectedId, useSelectedThreadId, useSelectedWorkspaceId, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { onForgetWorkspaceRequest, onNewWorkspaceRequest, onProjectTripRequest, type ProjectTripRequest } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { ImportProjectDialog } from "./ImportProjectDialog.js";
import { NewWorkspaceDialog, type WorkspaceStart } from "./NewWorkspaceDialog.js";
import { ROW_LEAD_CLASS, TWO_LINE_ROW_CLASS } from "./rowGrammar.js";
import { SearchRow } from "./SearchRow.js";
import { SectionRow } from "./SectionRow.js";
import { resolveAdjacentThreadId, resolveSettledTimestamp, splitSidebarThreads } from "./Sidebar.logic.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
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

  const [settledCollapsed, setSettledCollapsed] = useLocalStorage(SETTLED_COLLAPSED_KEY, NOTHING_COLLAPSED, workspaceIdsCodec);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  /** Workspace id to the machine id a rebuild was asked for; the action stays disabled while that machine is still the one reported. */
  const [rebuilding, setRebuilding] = useState<Readonly<Record<string, string>>>({});
  const [forgetting, setForgetting] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const threadVerbs = useThreadVerbs();
  const defaultVerbs = useWorkspaceVerbs();

  const projects = useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  const visible = useMemo(() => visibleProjects(projects), [projects]);
  const outOfMemory = useOutOfMemoryReadings(projects);
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
    </div>
  );

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={search}>
          <SidebarGroup className="pt-0">
            <SectionRow
              label="Workspaces"
              count={projects.length + creations.length}
              collapsed={allCollapsed}
              onToggle={() => setAllCollapsed(c => !c)}
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
                  {visible.map(({ project, active, settled }) => {
                    const isCollapsed = collapsed.has(project.id);
                    const settledOpen = !settledCollapsed.includes(project.id);
                    const rebuildAsked = rebuilding[project.id] !== undefined && rebuilding[project.id] === (project.status?.machineId ?? project.workspace.machineId);
                    const showThreads = !isCollapsed && active.length + settled.length > 0;
                    const actionsOf = resolveActions(workspaceActions, workspaceTarget(project.workspace, project.status), verbs);
                    const newThreadAction = actionById(actionsOf, "new-thread");
                    return (
                      <SidebarMenuItem key={project.id} onContextMenu={event => void openContextMenu(event, actionsOf, { returnTo: event.currentTarget.querySelector<HTMLElement>("[data-sidebar-row]") })}>
                        <WorkspaceRow
                          project={project}
                          cost={costs[project.id] ?? null}
                          outOfMemory={outOfMemory[project.id]}
                          nowMs={nowMs}
                          actions={actionsOf}
                          active={selectedId === project.id && selectedThreadId === null}
                          collapsed={isCollapsed}
                          rebuildAsked={rebuildAsked}
                          onSelect={() => select(project.id)}
                          onToggleCollapsed={() => toggleCollapsed(project.id)}
                        />
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
                        {showThreads ? (
                          <SidebarMenuSub>
                            {active.map(thread => (
                              <ThreadRow
                                key={thread.id}
                                thread={thread}
                                time={compactTimeLabel(thread.startedAt)}
                                active={selectedId === thread.workspaceId && selectedThreadId === thread.id}
                                onSelect={() => select(thread.workspaceId, thread.threadId)}
                                onContextMenu={event => void openContextMenu(event, resolveActions(threadActions, thread, threadVerbs))}
                              />
                            ))}
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
                            {settledOpen
                              ? settled.map(thread => (
                                  <ThreadRow
                                    key={thread.id}
                                    thread={thread}
                                    time={compactTimeLabel(resolveSettledTimestamp(thread))}
                                    active={selectedId === thread.workspaceId && selectedThreadId === thread.id}
                                    onSelect={() => select(thread.workspaceId, thread.threadId)}
                                    onContextMenu={event => void openContextMenu(event, resolveActions(threadActions, thread, threadVerbs))}
                                  />
                                ))
                              : null}
                          </SidebarMenuSub>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
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
