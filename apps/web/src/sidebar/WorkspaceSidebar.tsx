// SPDX-License-Identifier: AGPL-3.0-only
// The left region. Fixed at the top: the search row with the compose glyph that
// opens a thread in the selected workspace, and the project switcher, "All
// projects" or the one project the list is filtered to. Under them, scrolling:
// every root thread as a tile, newest first across every workspace, the
// threads its agents opened under it on the rail, and at the foot the Settled
// fold holding every root whose whole tree has been quiet a day. A workspace
// with no thread yet is a tile of its own and a workspace being made is a
// tile-shaped placeholder. The first tile of a copy in a tree carries that
// copy's verbs in its menu beside the thread's own. On a wsp with no project
// the body holds one row that points at the first run in the centre. The
// computer switcher under the project switcher narrows the list to the work on
// one computer. Keyboard
// traversal, the forget of a gone copy and the project trips' dialogs live
// here; the tiles are ThreadTile beside this file. The surface itself is the
// shell's sidebar-glass: nothing here paints a background.
import { openProjectSettings } from "../settings/openAt.js";
import { ChevronDownIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, computerOffline, creationAwaits, isLocalWorkspace, workspaceState, type WorkspaceState } from "@wsp/protocol";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { CREATION_ASKED, rebuildRefusedLine } from "../actions/format.js";
import { actionById, resolveActions, type ResolvedAction } from "../actions/registry.js";
import { projectActions, type ProjectVerbs } from "../actions/projectActions.js";
import { threadActions, threadTarget, type ThreadVerbs } from "../actions/threadActions.js";
import { useThreadVerbs, useWorkspaceVerbs } from "../actions/verbs.js";
import { workspaceActions, workspaceTarget } from "../actions/workspaceActions.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { ForgetWorkspaceDialog } from "../components/ForgetWorkspaceDialog.js";
import { SidebarContent, SidebarGroupAction, SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { MICRO_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { addNotice } from "../notices/store.js";
import { catalogIn, useLaunches, useProjectsRead, useProjectsRefused, useReady, useSelectedId, useSelectedThreadId, useSelectedWorkspaceId, useSidebarProjects, useStore, useWorkspace, type Creation } from "../protocol/store.js";
import { hostAsleep } from "../boot.js";
import { onAddProjectRequest, onForgetWorkspaceRequest, onNewWorkspaceRequest, onProjectTripRequest, onRenameWorkspaceRequest, requestAddProject, type ProjectTripRequest } from "../shell/shellRequests.js";
import { ExportProjectDialog } from "./ExportProjectDialog.js";
import { ForwardsList } from "./ForwardsList.js";
import { AddProjectDialog } from "./AddProjectDialog.js";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ComputerSwitcher } from "./ComputerSwitcher.js";
import { workspacesOn } from "./computerPick.js";
import { CHILD_LIST_CLASS, ONE_LINE_ROW_CLASS, RAIL_ITEM_CLASS, ROW_META_CLASS, ROW_PROSE_CLASS, SETTLED_ROW_ID, threadRowId, workspaceRowId } from "./rowGrammar.js";
import { SearchRow } from "./SearchRow.js";
import { resolveAdjacentThreadId, topSidebarThread } from "./Sidebar.logic.js";
import { projectGroups, sidebarTiles, type ProjectGroup, type TileNode } from "./threadTree.js";
import { SettingsRow } from "./SettingsRow.js";
import { HostFoot } from "../hosts/HostFoot.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome.js";
import { CreationTile, ThreadLaunchTile, ThreadTile, WorkspaceTile, type TilePlace } from "./ThreadTile.js";
import { NEW_THREAD_TITLE, branchLine, computerName, placeNames } from "./workspaceRows.js";
import { restingAge } from "../components/status/restingAge.js";
import { PROJECT_WORDS } from "./words.js";

/** Whether the Settled fold is open. It starts shut: it holds the tiles a person has stopped looking at. */
const SETTLED_OPEN_KEY = "wsp:sidebar-settled-open";
/** The project the list is filtered to. A view of this window alone, so it never follows a person to another one. */
const PROJECT_PICK_KEY = "wsp:sidebar-project";
/** The computer the list is filtered to, of this window alone as the project pick is. */
const COMPUTER_PICK_KEY = "wsp:sidebar-computer";
const openCodec: Codec<boolean> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "boolean") throw new Error(`Expected true or false, got ${raw}.`);
    return parsed;
  },
  encode: value => JSON.stringify(value),
};
const pickCodec: Codec<string | null> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") throw new Error(`Expected an id, got ${raw}.`);
    return parsed;
  },
  encode: value => JSON.stringify(value),
};

/** The copy verbs a tile's menu carries for the copy it runs on: its state, its rebuild and its end. The rest of the
 * copy's verbs are the palette's and the machine surface's. */
const TILE_COPY_VERBS: ReadonlySet<string> = new Set(["phase", "rebuild", "delete", "forget"]);

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

/** Every tile a tree holds, itself included. */
const tileCount = (node: TileNode): number => 1 + node.children.reduce((sum, child) => sum + tileCount(child), 0);

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

export function WorkspaceSidebar() {
  const api = useStore(s => s.api);
  const conn = useStore(s => s.conn);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const select = useStore(s => s.select);
  const creations = useStore(s => s.creations);
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

  const [settledOpen, setSettledOpen] = useLocalStorage(SETTLED_OPEN_KEY, false, openCodec);
  const [pickStored, setPickStored] = useLocalStorage<string | null>(PROJECT_PICK_KEY, null, pickCodec);
  const [computerStored, setComputerStored] = useLocalStorage<string | null>(COMPUTER_PICK_KEY, null, pickCodec);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [addProject, setAddProject] = useState<number | null>(null);
  const [trip, setTrip] = useState<ProjectTripState | null>(null);
  const [forgetting, setForgetting] = useState<{ workspaceId: string; act: "forget" | "delete" } | null>(null);
  /** The tile whose name is being typed, by the row id every tile carries, and whether that name is on its way; one
   * tile at a time, the tile is the only editor, and the field stays until the store has the name. */
  const [renaming, setRenaming] = useState<{ rowId: string; saving: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const renameThread = useStore(s => s.renameThread);
  const renameWorkspace = useStore(s => s.renameWorkspace);
  const canRename = useStore(s => s.api?.renameSession !== undefined);
  const harnesses = useStore(s => s.harnesses);
  const harnessesByWorkspace = useStore(s => s.harnessesByWorkspace);
  // The sidebar draws the tiles, so it owns the rename's opener, as it owns the forget's dialog; a client that cannot
  // send the name offers no box, and the action carries that refusal.
  const defaultThreadVerbs = useThreadVerbs();
  const threadVerbs = useMemo<ThreadVerbs>(
    () => ({ ...defaultThreadVerbs, ...(canRename ? { rename: (threadId: string) => setRenaming({ rowId: threadRowId(threadId), saving: false }) } : {}) }),
    [canRename, defaultThreadVerbs],
  );
  const defaultVerbs = useWorkspaceVerbs();

  // This window is on another computer and the one running wsp has gone quiet: the tiles stand as they were last
  // known, and the line under the head says why nothing moves.
  const asleep = hostAsleep(conn);
  const fleet = useSidebarProjects();
  // A pick for a computer this host no longer holds reads as every computer.
  const computerPicked = places.some(place => place.id === computerStored) ? computerStored : null;
  const projects = useMemo(() => workspacesOn(fleet, places, computerPicked), [fleet, places, computerPicked]);
  const launches = useLaunches();
  const groups = useMemo(() => projectGroups(recorded, projects), [recorded, projects]);
  const named = useMemo(() => placeNames(places), [places]);
  // A pick for a project this host no longer holds reads as every project.
  const picked = pickStored === null ? null : groups.find(group => group.project.id === pickStored) ?? null;
  const tiles = useMemo(() => sidebarTiles(projects, { picked: picked?.project.id ?? null, nowMs }), [projects, picked, nowMs]);
  // One landing per project, for the pause mode a copy's phase verb reads. Asked here, where the tiles are drawn,
  // so no tile asks for itself.
  useEffect(() => {
    for (const group of groups) void loadLanding(group.project.id);
  }, [groups, loadLanding]);
  const tripTarget = trip === null ? undefined : workspaces.find(w => w.id === trip.workspaceId);
  const forgetTarget = forgetting === null ? undefined : fleet.find(p => p.id === forgetting.workspaceId);

  const openDialog = (project: string | null): void => setDialog({ key: Date.now(), project });
  // The palette's New workspace lands on the project the head names while one is picked, as the head's plus does.
  const openDialogForPick = (project?: string): void => openDialog(project ?? picked?.project.id ?? null);
  const openDialogRef = useRef(openDialogForPick);
  openDialogRef.current = openDialogForPick;
  useEffect(() => onNewWorkspaceRequest(({ project }) => openDialogRef.current(project)), []);
  useEffect(() => onAddProjectRequest(() => setAddProject(Date.now())), []);
  useEffect(() => onForgetWorkspaceRequest(({ workspaceId, act }) => setForgetting({ workspaceId, act })), []);
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
    if (tiles.settled.some(node => holds(node, open.id))) setSettledOpen(true);
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
  const placeOf = (runs: SidebarProjectSnapshot): TilePlace => ({ projectId: runs.workspace.project.id, project: runs.workspace.project.name, computer: computerName(places, runs) });

  /** One tile's item with the tiles its agents opened under it. The first tile of a copy in the tree, a root or a
   * tile whose opener runs on another copy, carries that copy's verbs after the thread's own. A tile's verbs reach
   * the machine its own copy runs on, so a thread on a machine that is gone is refused wherever it is drawn. */
  const tileItem = (node: TileNode, depth: number, above: string | null): ReactNode => {
    const { thread: item, children } = node;
    const { runs, thread } = item;
    const copyActions = above === runs.id ? [] : resolveActions(workspaceActions, workspaceTarget(runs.workspace, runs.status, places), verbs).filter(action => TILE_COPY_VERBS.has(action.id));
    const place = placeOf(runs);
    const branch = branchLine(runs);
    let tile: ReactNode;
    if (thread === null) {
      tile = (
        <WorkspaceTile
          rowId={item.id}
          // The workspace that is this computer itself, not a copy beside a folder, is named by its host name.
          name={isLocalWorkspace(runs.workspace) && runs.workspace.copy === undefined ? place.computer : runs.displayName}
          place={place}
          branch={branch}
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
      const target = threadTarget(thread, { catalog: catalogIn({ harnesses, harnessesByWorkspace }, thread.workspaceId, thread.harness), ...machineOf(runs) });
      const actionsOf = resolveActions(threadActions, target, threadVerbs);
      const rowId = threadRowId(thread.id);
      tile = (
        <ThreadTile
          thread={thread}
          place={place}
          branch={branch}
          time={restingAge(thread)}
          depth={depth}
          active={selectedId === thread.workspaceId && (selectedThreadId === null ? thread.threadId === null : selectedThreadId === thread.id)}
          renaming={renaming?.rowId === rowId}
          saving={renaming?.rowId === rowId && renaming.saving}
          onSelect={() => select(thread.workspaceId, thread.threadId)}
          onContextMenu={event => void openContextMenu(event, [...actionsOf, ...copyActions])}
          onRename={title => void sendName(rowId, () => renameThread({ sessionId: thread.sessionId, workspaceId: thread.workspaceId, harness: thread.harness, title }))}
          onRenameCancel={() => setRenaming(null)}
          onRenameOpen={openerOf(actionById(actionsOf, "rename"))}
        />
      );
    }
    return (
      <li key={item.id} data-thread-item className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS)}>
        {tile}
        {children.length > 0 ? <ul className={CHILD_LIST_CLASS}>{children.map(child => tileItem(child, depth + 1, runs.id))}</ul> : null}
      </li>
    );
  };
  /** A workspace being made, where it will run once it is one. */
  const creationItem = (creation: Creation) => {
    const project = recorded.find(p => p.id === creation.project);
    const where = creation.where ?? project?.computer;
    const failed = creation.failed !== null;
    const line = failed ? creation.failed.title : creation.lines.findLast(l => creationAwaits(l.stage))?.message ?? CREATION_ASKED;
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
        <ThreadLaunchTile launch={launch} place={placeOf(runs)} branch={branchLine(runs)} />
      </li>,
    ];
  });
  const made = creations.filter(creation => picked === null || creation.project === picked.project.id);
  const settledCount = tiles.settled.reduce((sum, node) => sum + tileCount(node), 0);

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

  const offline = useMemo(() => computerOffline(Object.values(statuses)), [statuses]);
  /** The one add control at rest: a new thread in the selected workspace, held while none is selected. Held by
   * aria-disabled rather than the disabled attribute, so the pointer still reaches it and the tooltip can say what
   * it is in the one state a person might ask why it is held. */
  const compose = (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarGroupAction
            className="text-sidebar-muted-foreground transition-colors duration-150 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-sidebar-muted-foreground"
            aria-label="New thread"
            aria-disabled={selectedWorkspace === null || undefined}
            onClick={() => {
              if (selectedWorkspace !== null) verbs.newThread(selectedWorkspace.id);
            }}
          />
        }
      >
        <SquarePenIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{NEW_THREAD_TITLE}</TooltipPopup>
    </Tooltip>
  );
  const header = (
    <div className="flex flex-col px-[var(--sidebar-content-inset)] pb-1" data-sidebar-search>
      <div className="relative">
        <SearchRow action={compose} />
      </div>
      <ProjectSwitcher
        projects={groups.map(group => group.project)}
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
      ) : offline ? (
        <p data-sidebar-offline className={cn(ROW_PROSE_CLASS, "px-2 pt-1 leading-4")}>
          {PROVIDER_UNREACHED_LINE}
        </p>
      ) : null}
    </div>
  );

  const empty = ready && projectsRead && projectsRefused === null && groups.length === 0 && creations.length === 0;

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={header}>
          <ul data-sidebar-tree className="flex w-full min-w-0 flex-col px-[var(--sidebar-content-inset)] pt-1">
            {launchItems}
            {tiles.live.map(node => tileItem(node, 0, null))}
            {made.map(creationItem)}
            {tiles.settled.length > 0 ? (
              <li data-thread-selection-safe className="mt-3">
                <button
                  type="button"
                  data-sidebar-row
                  data-row-id={SETTLED_ROW_ID}
                  aria-expanded={settledOpen}
                  aria-label={settledOpen ? "Settled" : `Settled ${settledCount}`}
                  onClick={() => setSettledOpen(open => !open)}
                  className="group/fold flex h-9 w-full items-center gap-3 rounded-[var(--control-radius)] px-2 text-left text-sidebar-muted-foreground outline-none transition-colors duration-150 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span data-group-word className={cn(MICRO_LABEL, "min-w-0 flex-1")}>
                    Settled
                  </span>
                  {settledOpen ? null : (
                    <span data-group-count className={cn(ROW_META_CLASS, "shrink-0")}>
                      {settledCount}
                    </span>
                  )}
                  <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-150", !settledOpen && "-rotate-90")} />
                </button>
              </li>
            ) : null}
            {settledOpen ? tiles.settled.map(node => tileItem(node, 0, null)) : null}
            {ready && groups.length > 0 && launchItems.length + tiles.live.length + tiles.settled.length + made.length === 0 ? (
              <li data-thread-selection-safe>
                <p data-k="no-workspaces" className="flex h-9 items-center px-2 text-[13px] text-muted-foreground">
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
          <SettingsRow />
          <HostFoot />
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
      {trip !== null && tripTarget !== undefined ? <ExportProjectDialog key={trip.key} workspace={tripTarget} onClose={() => setTrip(null)} /> : null}
      {forgetTarget !== undefined ? (
        <ForgetWorkspaceDialog
          workspace={forgetTarget.workspace}
          threads={forgetTarget.threads.length}
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
