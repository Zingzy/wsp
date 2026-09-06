// SPDX-License-Identifier: AGPL-3.0-only
// The left region: workspaces (machines) first, their sessions as threads
// under each, over the adapter's SidebarProjectSnapshot. Search, the settled
// shelf, keyboard traversal, the new-workspace dialog and the zombie rebuild
// live here; rows and logic come from the copied t3code files beside this one.
// The surface itself is the shell's sidebar-glass: nothing here paints a
// background.
import { ChevronDownIcon, FolderInputIcon, FolderOutputIcon, MessageSquareIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { agentName } from "@wsp/catalog";
import { deriveSidebarProjects, type SidebarProjectSnapshot, type SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../components/ui/sidebar.js";
import { Spinner } from "../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { cn } from "../lib/utils.js";
import { useSelectedId, useSelectedThreadId, useStore, type Creation } from "../protocol/store.js";
import { onNewWorkspaceRequest, requestNewThread } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { ImportProjectDialog } from "./ImportProjectDialog.js";
import { NewWorkspaceDialog, type WorkspaceStart } from "./NewWorkspaceDialog.js";
import { ProjectFavicon } from "./ProjectFavicon.js";
import {
  resolveAdjacentThreadId,
  resolveSettledTimestamp,
  resolveSidebarThreadStatus,
  searchSidebarThreadsByTitle,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators.js";
import {
  compactTimeLabel,
  costLabel,
  defaultWorkspaceName,
  dotClassForTone,
  idleCountdownLabel,
  openerWord,
  provenanceLabel,
  threadPill,
  reachNote,
  textClassForTone,
} from "./workspaceRows.js";

const SETTLED_EXPANDED_KEY = "wsp:sidebar-settled-expanded";
const NEW_THREAD_SHORTCUT = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new");
const NEW_THREAD_TITLE = NEW_THREAD_SHORTCUT ? `New thread (${NEW_THREAD_SHORTCUT})` : "New thread";
const booleanCodec: Codec<boolean> = {
  decode: raw => JSON.parse(raw) === true,
  encode: value => JSON.stringify(value),
};

interface VisibleProject {
  readonly project: SidebarProjectSnapshot;
  readonly active: ReadonlyArray<SidebarThreadSnapshot>;
  readonly settled: ReadonlyArray<SidebarThreadSnapshot>;
}

/** Search flattens: matching threads under any workspace whose name or threads match; no shelf. */
function visibleProjects(projects: ReadonlyArray<SidebarProjectSnapshot>, query: string): VisibleProject[] {
  const searching = query.trim().length > 0;
  const needle = query.trim().toLowerCase();
  const out: VisibleProject[] = [];
  for (const project of projects) {
    const threads = searching ? searchSidebarThreadsByTitle(project.threads, query) : project.threads;
    if (searching && threads.length === 0 && !project.displayName.toLowerCase().includes(needle)) continue;
    const active = sortThreadsForSidebar(threads.filter(t => resolveSidebarThreadStatus(t) === "working"));
    const settled = sortSettledThreadsForSidebar(threads.filter(t => resolveSidebarThreadStatus(t) !== "working"));
    out.push({ project, active, settled });
  }
  return out;
}

interface DialogState {
  readonly key: number;
  readonly name: string;
}

/** A project dialog open for one workspace; keyed per opening so its folder and plan reset. */
interface ProjectDialogState {
  readonly key: number;
  readonly workspaceId: string;
}

/** Hover actions sit left of the new-thread plus, one slot each; the row's end padding makes room for as many as it has. */
const ACTION_SLOTS = ["right-6", "right-11", "right-16"] as const;
const ACTION_PADDING: Record<number, string> = {
  1: "group-has-data-[sidebar=menu-action]/menu-item:pe-14",
  2: "group-has-data-[sidebar=menu-action]/menu-item:pe-19",
  3: "group-has-data-[sidebar=menu-action]/menu-item:pe-24",
};

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
  const selectedId = useSelectedId();
  const selectedThreadId = useSelectedThreadId();
  const nowMinute = useNowMinute();
  // One clock sample per minute tick so every idle countdown reads the same now.
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const [query, setQuery] = useState("");
  const [settledExpanded, setSettledExpanded] = useLocalStorage(SETTLED_EXPANDED_KEY, true, booleanCodec);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [importing, setImporting] = useState<ProjectDialogState | null>(null);
  const [exporting, setExporting] = useState<ProjectDialogState | null>(null);
  const canImport = api?.planProject !== undefined && api.importProject !== undefined;
  const canExport = api?.exportProject !== undefined;
  /** Workspace id to the machine id a rebuild was asked for; the action stays disabled while that machine is still the one reported. */
  const [rebuilding, setRebuilding] = useState<Readonly<Record<string, string>>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  const projects = useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => visibleProjects(projects, query), [projects, query]);
  const importTarget = importing === null ? undefined : workspaces.find(w => w.id === importing.workspaceId);
  const exportTarget = exporting === null ? undefined : workspaces.find(w => w.id === exporting.workspaceId);

  const openDialog = (): void => {
    setDialog({ key: Date.now(), name: defaultWorkspaceName([...workspaces.map(w => w.name), ...creations.map(c => c.name)]) });
  };
  const openDialogRef = useRef(openDialog);
  openDialogRef.current = openDialog;
  useEffect(() => onNewWorkspaceRequest(() => openDialogRef.current()), []);

  const create = async (name: string, start: WorkspaceStart): Promise<void> => {
    setDialog(null);
    const id = await createWorkspace(name);
    if (start === "import" && id !== null) setImporting({ key: Date.now(), workspaceId: id });
  };

  const rebuild = async (project: SidebarProjectSnapshot): Promise<void> => {
    const machineId = project.status?.machineId ?? project.workspace.machineId;
    if (!api?.rebuild) return;
    setRebuilding(r => ({ ...r, [project.id]: machineId }));
    try {
      await api.rebuild(project.id);
    } catch (e) {
      setRebuilding(({ [project.id]: _dropped, ...rest }) => rest);
      useStore.setState({ toast: `${project.displayName}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const newThread = (id: string): void => {
    requestNewThread({ workspaceId: id });
    select(id);
  };

  const toggleCollapsed = (id: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    <div className="px-[var(--sidebar-content-inset)] pb-1">
      <SidebarInput
        type="search"
        nativeInput
        placeholder="Search threads"
        aria-label="Search threads"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault();
            setQuery("");
          }
        }}
      />
    </div>
  );

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={search}>
          <SidebarGroup>
            <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {creations.map(creation => (
                  <CreationRow key={creation.key} creation={creation} active={selectedId === creation.key} onSelect={() => select(creation.key)} />
                ))}
                {visible.map(({ project, active, settled }) => {
                  const isCollapsed = collapsed.has(project.id);
                  const zombie = project.reach === "zombie";
                  const rebuildAsked = rebuilding[project.id] !== undefined && rebuilding[project.id] === (project.status?.machineId ?? project.workspace.machineId);
                  const cost = costs[project.id] ?? null;
                  const meta = [
                    costLabel({
                      phase: project.phase,
                      rateUsdPerHour: cost?.rateUsdPerHour ?? project.status?.rateUsdPerHour ?? null,
                      accruedUsd: cost?.accruedUsd ?? null,
                    }),
                    idleCountdownLabel(project.status, nowMs),
                    reachNote(project.reach),
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · ");
                  const showThreads = !isCollapsed && active.length + settled.length > 0;
                  const collapsible = project.threads.length > 0 && !searching;
                  const actions = Number(collapsible) + Number(canImport) + Number(canExport);
                  const slots = [...ACTION_SLOTS].slice(0, actions);
                  const slotOf = (): string => slots.shift() ?? "";
                  const collapseSlot = collapsible ? slotOf() : "";
                  const importSlot = canImport ? slotOf() : "";
                  const exportSlot = canExport ? slotOf() : "";
                  return (
                    <SidebarMenuItem key={project.id}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={selectedId === project.id && selectedThreadId === null}
                        data-sidebar-row
                        data-row-id={`ws:${project.id}`}
                        className={cn(!zombie && ACTION_PADDING[actions])}
                        onClick={() => select(project.id)}
                      >
                        <span
                          aria-hidden
                          className={cn("size-2 shrink-0 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{project.displayName}</span>
                            <span className={cn("shrink-0 text-[10px] font-medium", textClassForTone(project.indicator.tone))}>{project.indicator.label}</span>
                          </span>
                          {meta.length > 0 ? (
                            <span className="truncate text-[11px] font-normal text-sidebar-muted-foreground tabular-nums">{meta}</span>
                          ) : null}
                        </span>
                      </SidebarMenuButton>
                      {zombie ? (
                        <SidebarMenuAction
                          aria-label={`Rebuild ${project.displayName}`}
                          title={project.status?.reason ?? "The machine answers nothing; rebuild it from the golden image"}
                          disabled={rebuildAsked || !api?.rebuild}
                          onClick={() => void rebuild(project)}
                        >
                          <RefreshCwIcon className={cn(rebuildAsked && "animate-spin")} />
                        </SidebarMenuAction>
                      ) : (
                        <>
                          {canExport ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <SidebarMenuAction
                                    showOnHover
                                    className={exportSlot}
                                    aria-label={`Export a project from ${project.displayName}`}
                                    onClick={() => setExporting({ key: Date.now(), workspaceId: project.id })}
                                  />
                                }
                              >
                                <FolderOutputIcon />
                              </TooltipTrigger>
                              <TooltipPopup side="bottom">Export a project to this Mac</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          {canImport ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <SidebarMenuAction
                                    showOnHover
                                    className={importSlot}
                                    aria-label={`Import a project into ${project.displayName}`}
                                    onClick={() => setImporting({ key: Date.now(), workspaceId: project.id })}
                                  />
                                }
                              >
                                <FolderInputIcon />
                              </TooltipTrigger>
                              <TooltipPopup side="bottom">Import a project from this Mac</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          {collapsible ? (
                            <SidebarMenuAction
                              showOnHover
                              className={collapseSlot}
                              aria-label={isCollapsed ? `Expand ${project.displayName}` : `Collapse ${project.displayName}`}
                              onClick={() => toggleCollapsed(project.id)}
                            >
                              <ChevronDownIcon className={cn("transition-transform", isCollapsed && "-rotate-90")} />
                            </SidebarMenuAction>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger
                              render={<SidebarMenuAction showOnHover aria-label={`New thread in ${project.displayName}`} onClick={() => newThread(project.id)} />}
                            >
                              <PlusIcon />
                            </TooltipTrigger>
                            <TooltipPopup side="bottom">{NEW_THREAD_TITLE}</TooltipPopup>
                          </Tooltip>
                        </>
                      )}
                      {!zombie && project.threads.length === 0 && !searching ? (
                        <SidebarMenuSub>
                          <SidebarMenuSubItem data-thread-selection-safe>
                            <span className="block min-h-8 px-2 py-2 text-[11px] leading-4 text-muted-foreground">
                              No threads yet.{" "}
                              <button
                                type="button"
                                onClick={() => newThread(project.id)}
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
                            />
                          ))}
                          {settled.length > 0 && active.length > 0 && !searching ? (
                            <SidebarMenuSubItem data-thread-selection-safe>
                              <button
                                type="button"
                                data-sidebar-row
                                data-row-id={`settled:${project.id}`}
                                aria-expanded={settledExpanded}
                                onClick={() => setSettledExpanded(value => !value)}
                                className="my-1 flex w-full cursor-pointer items-center gap-2 px-2 text-left outline-hidden ring-ring focus-visible:ring-2 rounded-md"
                              >
                                <span className="text-xs font-medium text-muted-foreground/50">
                                  {settledExpanded ? "Idle" : `Idle (${settled.length})`}
                                </span>
                                <span className="h-px flex-1 bg-sidebar-border/60" />
                                <ChevronDownIcon aria-hidden className={cn("size-3 text-muted-foreground/50 transition-transform", settledExpanded && "rotate-180")} />
                              </button>
                            </SidebarMenuSubItem>
                          ) : null}
                          {settledExpanded || searching || active.length === 0
                            ? settled.map(thread => (
                                <ThreadRow
                                  key={thread.id}
                                  thread={thread}
                                  time={compactTimeLabel(resolveSettledTimestamp(thread))}
                                  active={selectedId === thread.workspaceId && selectedThreadId === thread.id}
                                  onSelect={() => select(thread.workspaceId, thread.threadId)}
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
                    <EmptyTitle>{searching ? "No matches" : "No workspaces yet"}</EmptyTitle>
                    <EmptyDescription>
                      {searching ? "No workspace or thread title contains that." : "Create one to fork a machine from your golden image."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </SidebarGroupContent>
          </SidebarGroup>
          <ForwardsList />
        </SidebarContent>
      </div>
      <SidebarChromeFooter primary={{ icon: <PlusIcon />, label: "New workspace", onClick: openDialog, disabled: api === null }} items={[]}>
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
          onCreate={(name, start) => void create(name, start)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {importing !== null && importTarget !== undefined ? (
        <ImportProjectDialog key={importing.key} workspace={importTarget} onClose={() => setImporting(null)} />
      ) : null}
      {exporting !== null && exportTarget !== undefined ? (
        <ExportProjectDialog key={exporting.key} workspace={exportTarget} onClose={() => setExporting(null)} />
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
        className="h-auto min-h-12 items-start"
        onClick={onSelect}
      >
        {failed ? (
          <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive" />
        ) : (
          <Spinner className="mt-1 size-3.5" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="truncate text-sidebar-foreground">{creation.name}</span>
          <span className={cn("whitespace-normal break-words text-[11px] font-normal", failed ? "text-destructive-foreground" : "text-sidebar-muted-foreground")}>{line}</span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The metadata sits under the title so it never takes the title's room; every row is one height. */
function ThreadRow({ thread, time, active, onSelect }: { thread: SidebarThreadSnapshot; time: string; active: boolean; onSelect: () => void }) {
  const pill = threadPill(thread);
  return (
    <SidebarMenuSubItem data-thread-item>
      <SidebarMenuSubButton
        render={<button type="button" />}
        isActive={active}
        data-sidebar-row
        data-row-id={`thread:${thread.id}`}
        onClick={onSelect}
        className="h-11 w-full items-start py-1.5"
      >
        <ProjectFavicon src={null} className="mt-0.5 size-3.5 opacity-60" fallbackIcon={MessageSquareIcon} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="flex items-center gap-2">
            <span data-thread-title className="min-w-0 flex-1 truncate">
              {thread.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">{time}</span>
          </span>
          <span data-thread-meta className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground/55">
            <ThreadRowLeadingStatus status={pill} />
            {pill ? <span aria-hidden>·</span> : null}
            <Tooltip>
              <TooltipTrigger render={<span data-thread-provenance aria-label={provenanceLabel(thread)} className="inline-flex min-w-0 items-center gap-1" />}>
                <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-3" />
                <span className="truncate">{openerWord(thread.startedBy)}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{provenanceLabel(thread)}</TooltipPopup>
            </Tooltip>
          </span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
