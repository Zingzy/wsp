// SPDX-License-Identifier: AGPL-3.0-only
// The palette's item list over the sidebar's project snapshots: the shell's
// own actions, the page of projects New thread picks from, the selected
// workspace's actions from the workspace registry, one row per workspace to
// switch to, recent threads at rest, every thread
// whose title holds the typed query and every other one whose messages hold
// it, as the host found them. Pure apart from the callbacks it is handed, so
// the list is testable without the dialog.
import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, BookOpenIcon, BugIcon, ChevronDownIcon, ChevronUpIcon, FileTextIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, GithubIcon, MonitorIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { REPO } from "../../../../../packages/wspx/scripts/bundles.mjs";
import { agentName } from "@wsp/catalog";
import { HERE_PLACE_ID, PLACES_WORDS, type PlaceView, type ProjectView, type SessionSearchHit } from "@wsp/protocol";
import { THREAD_WORDS } from "../../actions/format.js";
import { resolveActions, type ResolvedAction } from "../../actions/registry.js";
import { workspaceActions, workspaceTarget, type WorkspaceVerbs } from "../../actions/workspaceActions.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../../adapt/index.js";
import { browserTabClaimsShortcut, formatShortcutLabel, matchesShortcut, type ShortcutEventLike } from "../../keybindings.js";
import { isDesktopShell } from "../../lib/desktopShell.js";
import { WORKSPACE_SELECT_SLOTS, workspaceSelectCommand, type KeybindingShortcut } from "../../keybindingTypes.js";
import { ProjectGlyph } from "../../projects/look.js";
import { SETTINGS_WORDS, onName } from "../../settings/format.js";
import { groupNames } from "../../settings/groups.js";
import { absenceOf } from "../../settings/places.js";
import { threadWalk } from "../../shell/shellCommands.js";
import { searchSidebarThreadsByTitle } from "../../sidebar/Sidebar.logic.js";
import { currentWorkspaceId } from "../../adapt/workspaces.js";
import { inProjectOrder, threadTree, workspaceOf } from "../../sidebar/threadTree.js";
import { computerName, placeNames } from "../../sidebar/workspaceRows.js";
import { NEW_WORKSPACE, PROJECT_WORDS, SWITCHER_WORDS } from "../../sidebar/words.js";
import { RowComputer } from "../chat/ComposerCheckoutRow.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Facts } from "../Facts.js";
import { restingAge } from "../status/restingAge.js";
import { LINE_SLOT_CLASS, ThreadStatus } from "../status/ThreadStatus.js";
import { CommandShortcut } from "../ui/command.js";
import { type CommandPaletteActionItem, type CommandPaletteSubmenuItem, ITEM_ICON_CLASS, RECENT_THREAD_LIMIT } from "./CommandPalette.logic.js";

export interface PaletteHandlers {
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly selectThread: (workspaceId: string, threadId: string | null) => void;
  /** New thread as Cmd+T opens it: the project the person is in, or the page of projects where they asked to pick. */
  readonly newThread: () => void;
  /** Opens one project's New thread page. */
  readonly openProjectHome: (projectId: string) => void;
  readonly toggleSidebar: () => void;
  readonly toggleRightPanel: (workspaceId: string) => void;
  /** One step down the sidebar's workspaces, and back up; both wrap. */
  readonly nextWorkspace: () => void;
  readonly previousWorkspace: () => void;
  /** The same step one level down, over the threads of the workspace on screen. */
  readonly nextThread: () => void;
  readonly previousThread: () => void;
  readonly openSettings: () => void;
  readonly addProject: () => void;
  readonly openAddComputer: () => void;
  /** Copies the thread on screen as Markdown; null while no thread is open. */
  readonly copyThreadMarkdown: (() => Promise<void>) | null;
}

export interface PaletteItemsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selectedId: string | null;
  /** What the person typed; the thread search runs over it, the at-rest list ignores it. */
  readonly query: string;
  /** The threads whose messages the host found the query in, for that query. */
  readonly messageHits: ReadonlyArray<SessionSearchHit>;
  readonly canCreate: boolean;
  /** Every project this host holds, in the person's order, which the page New thread picks from lists. */
  readonly recorded: readonly ProjectView[];
  readonly projectOrder: readonly string[];
  /** Whether New thread asks for the project every time, so its row opens the page rather than leaving. */
  readonly asks: boolean;
  readonly handlers: PaletteHandlers;
  readonly verbs: WorkspaceVerbs;
  /** The computers and providers this host holds, for the one reading of a workspace whose computer is not
   * answering: a row that named its own state read Unreachable for the computer the app is drawn on. */
  readonly places: readonly PlaceView[];
}

export interface PaletteItems {
  readonly actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  readonly workspaceItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly messageSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}

/** The pages about wsp itself, reached from here since Settings has no About page. */
const LINKS = [
  { value: "action:github", title: "wsp on GitHub", terms: ["github", "source", "repo", "about", "licence", "license"], Icon: GithubIcon, url: REPO },
  { value: "action:docs", title: "wsp docs", terms: ["docs", "documentation", "help", "manual"], Icon: BookOpenIcon, url: "https://wsp.apidocumentation.com" },
  { value: "action:report-bug", title: "Report a bug", terms: ["bug", "issue", "report", "feedback", "help"], Icon: BugIcon, url: `${REPO}/issues/new` },
];

const sync = (fn: () => void) => async (): Promise<void> => {
  fn();
};

/** A registry action as a palette row, whichever registry it came from: its refusal is the row's description and its
 * disabled state, and what the row says about itself otherwise is the caller's line. */
function actionItem(action: ResolvedAction, description: string): CommandPaletteActionItem {
  const Icon = action.icon;
  return {
    kind: "action",
    value: `action:${action.id}`,
    searchTerms: [action.title, ...action.searchTerms],
    icon: Icon ? <Icon className={ITEM_ICON_CLASS} /> : null,
    title: action.title,
    description: action.refusal ?? description,
    disabled: action.refusal !== null,
    ...(action.shortcutCommand !== undefined ? { shortcutCommand: action.shortcutCommand } : {}),
    run: action.run,
  };
}

/** The value of the row that opens the page of projects, which the palette also opens on straight from Cmd+T. */
export const NEW_THREAD_PAGE = "page:new-thread";

/** The chord that picks the page's nth row: the platform's mod and the row's place in the list. */
const pickShortcut = (n: number): KeybindingShortcut => ({ key: String(n), metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true });

/** Whether the page's mod digits reach it here; a browser tab keeps them for its own tabs. */
const pickKeysReach = (): boolean => isDesktopShell() || !browserTabClaimsShortcut(pickShortcut(1));

/** The row a key event picks on the page, 1 to 9, by the same chords its rows' labels name; null for any other key
 * and wherever the chords do not reach. */
export function pickedRow(event: ShortcutEventLike): number | null {
  if (!pickKeysReach()) return null;
  return WORKSPACE_SELECT_SLOTS.find(n => matchesShortcut(event, pickShortcut(n))) ?? null;
}

/** Where a project is: the computer it is on as the row under the composer names it, with its glyph where it is
 * not the one the app runs on, and its folder. */
function projectWhere(project: ProjectView, places: readonly PlaceView[], named: ReadonlyMap<string, string>): ReactNode {
  const place = project.computer === HERE_PLACE_ID ? undefined : places.find(p => p.id === project.computer);
  const computer = named.get(project.computer) ?? (project.computer === HERE_PLACE_ID ? "" : project.computer);
  // The row's own fact, without the height and inset it takes under the composer.
  const at = computer === "" ? null : <RowComputer name={computer} place={place} className="h-auto px-0 sm:h-auto" />;
  return <Facts parts={[at, project.path]} className="overflow-hidden" />;
}

/** The page New thread picks a project from: every project in the person's order, the first nine on a pick key. */
function newThreadPage(input: PaletteItemsInput): CommandPaletteSubmenuItem {
  const named = placeNames(input.places);
  const keyed = pickKeysReach();
  const items = inProjectOrder(input.recorded, project => project.id, input.projectOrder).map((project, index): CommandPaletteActionItem => ({
    kind: "action",
    value: `project:${project.id}`,
    searchTerms: [project.name, named.get(project.computer) ?? "", project.path],
    icon: <ProjectGlyph projectId={project.id} />,
    title: project.name,
    description: projectWhere(project, input.places, named),
    ...(keyed && index < WORKSPACE_SELECT_SLOTS.length ? { titleTrailingContent: <CommandShortcut>{formatShortcutLabel(pickShortcut(index + 1))}</CommandShortcut> } : {}),
    run: sync(() => input.handlers.openProjectHome(project.id)),
  }));
  return {
    kind: "submenu",
    value: NEW_THREAD_PAGE,
    searchTerms: ["new thread in", "new thread on", "pick a project", "new chat in"],
    icon: <FolderOpenIcon className={ITEM_ICON_CLASS} />,
    title: `${NEW_WORKSPACE} in...`,
    description: "Pick the project first",
    disabled: !input.canCreate || items.length === 0,
    addonIcon: <ArrowLeftIcon className="text-icon-muted" />,
    placeholder: `${SWITCHER_WORDS.search}...`,
    emptyStateMessage: "No matching projects.",
    groups: [{ value: "projects", label: SWITCHER_WORDS.list, items }],
  };
}

function actionItems(input: PaletteItemsInput): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const { handlers, selectedId } = input;
  const selected = selectedId === null ? null : (input.projects.find(project => project.id === selectedId) ?? null);
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:new-thread",
      searchTerms: ["new thread", "new chat", "new task", "create task"],
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      title: NEW_WORKSPACE,
      description: !input.canCreate ? "Not connected to the runtime" : input.recorded.length === 0 ? "Add a project first" : "One piece of work on one project",
      disabled: !input.canCreate || input.recorded.length === 0,
      // Asking keeps the palette up, on the page of projects.
      ...(input.asks ? { keepOpen: true } : {}),
      run: sync(handlers.newThread),
    },
    newThreadPage(input),
    {
      kind: "action",
      value: "action:add-project",
      searchTerms: ["add a project", "project", "folder", "repository", "clone", "record a project"],
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      title: PROJECT_WORDS.add,
      description: "One folder or repository address on one computer",
      run: sync(handlers.addProject),
    },
  ];
  if (handlers.copyThreadMarkdown !== null) {
    items.push({
      kind: "action",
      value: "action:copy-markdown",
      searchTerms: ["copy", "markdown", "export thread", "copy chat"],
      icon: <FileTextIcon className={ITEM_ICON_CLASS} />,
      title: THREAD_WORDS.copyMarkdown,
      description: "The thread on screen, as the host holds it",
      run: handlers.copyThreadMarkdown,
    });
  }
  if (selected !== null) {
    // The one New thread row is the one above, which opens on a project; the copy's own act stays off the palette.
    items.push(...resolveActions(workspaceActions, workspaceTarget(selected.workspace, selected.status, input.places), input.verbs).filter(action => action.id !== "new-thread").map(action => actionItem(action, selected.displayName)));
  }

  const oneWorkspace = input.projects.length < 2;
  const walk = threadWalk(input.projects, selectedId);
  const oneThread = walk.length < 2;
  // A walk steps inside the workspace on screen, and the thread lists under these rows hold every workspace's, so a
  // held Next thread over a list of four has to name the workspace it is walking and say the four are not in it.
  // Nothing to step to covers both ways the walk can come up empty: no rows under that workspace at all, and rows
  // the runtime stamped no thread id on, which pin the workspace alone and so are no step.
  const walkingIn = walkedWorkspace(input);
  const threadWalkDescription =
    walk.length > 0 ? "Only one thread" : walkingIn === null ? "No threads to walk" : `Nothing to step to on ${walkingIn}; a walk stays inside one task`;
  items.push(
    {
      kind: "action",
      value: "action:next-workspace",
      searchTerms: ["next task", "switch task", "cycle tasks"],
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      title: "Next task",
      shortcutCommand: "workspace.next",
      ...(oneWorkspace ? { disabled: true, description: "Only one task" } : {}),
      run: sync(handlers.nextWorkspace),
    },
    {
      kind: "action",
      value: "action:previous-workspace",
      searchTerms: ["previous task", "switch task", "cycle tasks"],
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      title: "Previous task",
      shortcutCommand: "workspace.previous",
      ...(oneWorkspace ? { disabled: true, description: "Only one task" } : {}),
      run: sync(handlers.previousWorkspace),
    },
    {
      kind: "action",
      value: "action:next-thread",
      searchTerms: ["next thread", "switch thread", "cycle threads"],
      icon: <ChevronDownIcon className={ITEM_ICON_CLASS} />,
      title: "Next thread",
      shortcutCommand: "thread.next",
      ...(oneThread ? { disabled: true, description: threadWalkDescription } : {}),
      run: sync(handlers.nextThread),
    },
    {
      kind: "action",
      value: "action:previous-thread",
      searchTerms: ["previous thread", "switch thread", "cycle threads"],
      icon: <ChevronUpIcon className={ITEM_ICON_CLASS} />,
      title: "Previous thread",
      shortcutCommand: "thread.previous",
      ...(oneThread ? { disabled: true, description: threadWalkDescription } : {}),
      run: sync(handlers.previousThread),
    },
    {
      kind: "action",
      value: "action:toggle-sidebar",
      searchTerms: ["toggle sidebar", "hide sidebar", "show sidebar"],
      icon: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
      title: "Toggle sidebar",
      shortcutCommand: "sidebar.toggle",
      run: sync(handlers.toggleSidebar),
    },
    {
      kind: "action",
      value: "action:add-computer",
      searchTerms: ["add a computer", "join", "box", "another mac", "laptop", "linux", "ssh"],
      icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
      title: PLACES_WORDS.addComputer,
      description: `${PLACES_WORDS.section} in ${SETTINGS_WORDS.title}`,
      run: sync(handlers.openAddComputer),
    },
    {
      kind: "action",
      value: "action:settings",
      searchTerms: ["settings", "preferences", "computers", "projects", "devices", "account", "privacy", "keybindings", "appearance", "theme", "sidebar width", "terminal size"],
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      title: SETTINGS_WORDS.title,
      description: groupNames(),
      shortcutCommand: "settings.toggle",
      run: sync(handlers.openSettings),
    },
    ...LINKS.map(({ value, title, terms, Icon, url }) => ({
      kind: "action" as const,
      value,
      searchTerms: terms,
      icon: <Icon className={ITEM_ICON_CLASS} />,
      title,
      description: url.replace("https://", ""),
      run: sync(() => void window.open(url, "_blank", "noopener,noreferrer")),
    })),
    {
      kind: "action",
      value: "action:toggle-right-panel",
      searchTerms: ["toggle right panel", "hide panel", "show panel"],
      icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "rightPanel.toggle",
      title: "Toggle right panel",
      description: selected ? selected.displayName : "Select a task first",
      disabled: selected === null,
      run: async () => {
        if (selected) handlers.toggleRightPanel(selected.id);
      },
    },
  );
  return items;
}

/** The workspace a walk steps inside, by the name the list under these rows shows for it; null while the sidebar
 * has no workspace on screen, where there is no walk to explain. The same rule the walk itself takes its threads
 * from, so the name and the list can never name two workspaces. */
function walkedWorkspace(input: PaletteItemsInput): string | null {
  const id = currentWorkspaceId(input.projects.map(project => project.id), input.selectedId);
  return input.projects.find(project => project.id === id)?.displayName ?? null;
}

function workspaceItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  return input.projects.map((project, index) => {
    // Where it runs, in the one word the sidebar row reads for it: a person picks a workspace by its state and the
    // computer it is on, never by the id wsp holds the machine under. The state word is the row's own, which on a
    // computer that is not answering is that computer's word and not the wire's.
    const absent = absenceOf(input.places, project.workspace, project.status, null);
    const current = project.id === input.selectedId;
    // The projects arrive in sidebar order, so a row's index is the slot its chord jumps to.
    const slot = WORKSPACE_SELECT_SLOTS[index];
    return {
      kind: "action",
      value: `workspace:${project.id}`,
      searchTerms: [project.displayName],
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      title: project.displayName,
      description: `${absent?.word ?? project.indicator.label}${onName(computerName(input.places, project))}`,
      ...(current ? { titleTrailingContent: <span className="shrink-0 text-muted-foreground text-xs">Current task</span> } : {}),
      ...(slot === undefined ? {} : { shortcutCommand: workspaceSelectCommand(slot) }),
      run: sync(() => input.handlers.selectWorkspace(project.id)),
    };
  });
}

function threadItem(thread: SidebarThreadSnapshot, project: SidebarProjectSnapshot, places: readonly PlaceView[], handlers: PaletteHandlers): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `thread:${thread.id}`,
    searchTerms: [thread.title],
    icon: <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-4" />,
    title: thread.title,
    // The workspace it runs on and where that runs: a thread an agent opened somewhere else is told apart from its
    // opener by these two words and nothing else.
    description: <Facts parts={[project.displayName, computerName(places, project)]} className="overflow-hidden" />,
    titleTrailingContent: <ThreadStatus thread={thread} age={restingAge(thread)} crab className={LINE_SLOT_CLASS} />,
    run: sync(() => handlers.selectThread(thread.workspaceId, thread.threadId)),
  };
}

export function buildPaletteItems(input: PaletteItemsInput): PaletteItems {
  // The same tree the sidebar draws, read through the one rule for which thread opened which: every thread is
  // listed once, under the workspace whose rows it is drawn among, and each still names the workspace it runs on.
  const threads = threadTree(input.projects).flatMap(group =>
    group.threads.map(thread => ({ ...thread, workspace: workspaceOf(input.projects, thread) ?? group.project })),
  );
  const item = (thread: (typeof threads)[number]) => threadItem(thread, thread.workspace, input.places, input.handlers);
  const latest = [...threads].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const byTitle = searchSidebarThreadsByTitle(threads, input.query);
  // A thread its title already finds is listed there once; a hit on a thread the sidebar does not hold opens nothing.
  const byMessage = input.messageHits.flatMap(hit => {
    const thread = threads.find(t => t.threadId === hit.threadId && t.workspaceId === hit.workspaceId);
    return thread === undefined || byTitle.includes(thread) ? [] : [{ ...item(thread), value: `message:${thread.id}`, searchTerms: [input.query, hit.snippet], description: hit.snippet }];
  });
  return {
    actionItems: actionItems(input),
    workspaceItems: workspaceItems(input),
    recentThreadItems: latest.slice(0, RECENT_THREAD_LIMIT).map(item),
    threadSearchItems: byTitle.map(item),
    messageSearchItems: byMessage,
  };
}
