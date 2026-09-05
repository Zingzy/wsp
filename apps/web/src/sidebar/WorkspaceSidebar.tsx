// SPDX-License-Identifier: AGPL-3.0-only
// The left region: workspaces (machines) first, their sessions as threads
// under each, over the adapter's SidebarProjectSnapshot. Search, the settled
// shelf, keyboard traversal, the new-workspace dialog and the zombie rebuild
// live here; rows and logic come from the copied t3code files beside this one.
// The surface itself is the shell's sidebar-glass: nothing here paints a
// background.
import { ChevronDownIcon, MessageSquareIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { deriveSidebarProjects, type SidebarProjectSnapshot, type SidebarThreadSnapshot } from "../adapt/index.js";
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
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { cn } from "../lib/utils.js";
import { useSelectedId, useStore } from "../protocol/store.js";
import { onNewWorkspaceRequest } from "../shell/shellRequests.js";
import { ForwardsList } from "./ForwardsList.js";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.js";
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
  explainCreateRefusal,
  idleCountdownLabel,
  threadPill,
  reachNote,
  textClassForTone,
  type CreateRefusal,
} from "./workspaceRows.js";

const SETTLED_EXPANDED_KEY = "wsp:sidebar-settled-expanded";
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

interface PendingCreate {
  readonly name: string;
  /** Set once the runtime answered; the row clears when that id shows up in the list. */
  readonly id: string | null;
}

interface DialogState {
  readonly key: number;
  readonly name: string;
  readonly error: CreateRefusal | null;
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
  const selectedId = useSelectedId();
  const nowMinute = useNowMinute();
  // One clock sample per minute tick so every idle countdown reads the same now.
  const nowMs = useMemo(() => Date.now(), [nowMinute]);

  const [query, setQuery] = useState("");
  const [settledExpanded, setSettledExpanded] = useLocalStorage(SETTLED_EXPANDED_KEY, true, booleanCodec);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** Workspace id to the machine id a rebuild was asked for; the action stays disabled while that machine is still the one reported. */
  const [rebuilding, setRebuilding] = useState<Readonly<Record<string, string>>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  const projects = useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => visibleProjects(projects, query), [projects, query]);

  useEffect(() => {
    if (pending?.id && workspaces.some(w => w.id === pending.id)) {
      setPending(null);
      select(pending.id);
    }
  }, [pending, workspaces, select]);

  const openDialog = (): void => {
    setDialog({ key: Date.now(), name: defaultWorkspaceName(workspaces.map(w => w.name)), error: null });
  };
  const openDialogRef = useRef(openDialog);
  openDialogRef.current = openDialog;
  useEffect(() => onNewWorkspaceRequest(() => openDialogRef.current()), []);

  const create = async (name: string): Promise<void> => {
    if (!api) return;
    setDialog(null);
    setPending({ name, id: null });
    try {
      const created = await api.createFromGoldenHead(name);
      setPending(p => (p && p.name === name ? { ...p, id: created.id } : p));
      if (created.notice !== undefined) useStore.setState({ toast: created.notice });
    } catch (e) {
      setPending(null);
      setDialog({ key: Date.now(), name, error: explainCreateRefusal(e) });
    }
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
      <SidebarChromeHeader title="wsp" />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={search}>
          <SidebarGroup>
            <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
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
                  return (
                    <SidebarMenuItem key={project.id}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={selectedId === project.id}
                        data-sidebar-row
                        data-row-id={`ws:${project.id}`}
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
                      ) : project.threads.length > 0 && !searching ? (
                        <SidebarMenuAction
                          showOnHover
                          aria-label={isCollapsed ? `Expand ${project.displayName}` : `Collapse ${project.displayName}`}
                          onClick={() => toggleCollapsed(project.id)}
                        >
                          <ChevronDownIcon className={cn("transition-transform", isCollapsed && "-rotate-90")} />
                        </SidebarMenuAction>
                      ) : null}
                      {showThreads ? (
                        <SidebarMenuSub>
                          {active.map(thread => (
                            <ThreadRow key={thread.id} thread={thread} time={compactTimeLabel(thread.startedAt)} onSelect={() => select(thread.workspaceId)} />
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
                                  onSelect={() => select(thread.workspaceId)}
                                />
                              ))
                            : null}
                        </SidebarMenuSub>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
                {pending ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton size="lg" disabled aria-busy="true" data-sidebar-row data-row-id="pending">
                      <Spinner className="size-3.5" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                        <span className="truncate text-sidebar-foreground">{pending.name}</span>
                        <span className="truncate text-[11px] font-normal text-sidebar-muted-foreground">Creating a machine from the golden image</span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
              {visible.length === 0 && !pending ? (
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
            className="mb-1 cursor-pointer rounded-lg border border-sidebar-border bg-sidebar-control-surface px-3 py-2 text-xs text-sidebar-foreground"
          >
            {toast}
          </div>
        ) : null}
      </SidebarChromeFooter>
      {dialog ? (
        <NewWorkspaceDialog
          key={dialog.key}
          initialName={dialog.name}
          error={dialog.error}
          onCreate={name => void create(name)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function ThreadRow({ thread, time, onSelect }: { thread: SidebarThreadSnapshot; time: string; onSelect: () => void }) {
  return (
    <SidebarMenuSubItem data-thread-item>
      <SidebarMenuSubButton
        render={<button type="button" />}
        data-sidebar-row
        data-row-id={`thread:${thread.id}`}
        onClick={onSelect}
        className="h-8 w-full"
      >
        <ProjectFavicon src={null} className="size-3.5 opacity-60" fallbackIcon={MessageSquareIcon} />
        <ThreadRowLeadingStatus status={threadPill(thread)} />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground/55 tabular-nums">{time}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
