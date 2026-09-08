// SPDX-License-Identifier: AGPL-3.0-only
// The palette's item list over the sidebar's project snapshots: the shell's
// own actions, the selected workspace's actions from the workspace registry,
// one row per workspace to switch to, recent threads at rest and every thread
// whose title holds the typed query. Pure apart from the callbacks it is
// handed, so the list is testable without the dialog.
import { ArrowDownIcon, ArrowUpIcon, MessageSquareIcon, PanelLeftIcon, PanelRightIcon, PlusIcon } from "lucide-react";
import { resolveActions, type ResolvedAction } from "../../actions/registry.js";
import { sidebarActions } from "../../actions/sidebarActions.js";
import { workspaceActions, workspaceTarget, type WorkspaceVerbs } from "../../actions/workspaceActions.js";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../../adapt/index.js";
import { WORKSPACE_SELECT_SLOTS, workspaceSelectCommand } from "../../keybindingTypes.js";
import { cn } from "../../lib/utils.js";
import { searchSidebarThreadsByTitle } from "../../sidebar/Sidebar.logic.js";
import type { SidebarMode } from "../../sidebar/sidebarMode.js";
import { compactTimeLabel, dotClassForTone } from "../../sidebar/workspaceRows.js";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS, RECENT_THREAD_LIMIT } from "./CommandPalette.logic.js";

export interface PaletteHandlers {
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly selectThread: (workspaceId: string, threadId: string | null) => void;
  readonly newWorkspace: () => void;
  readonly toggleSidebar: () => void;
  readonly toggleRightPanel: (workspaceId: string) => void;
  /** One step down the sidebar's workspaces, and back up; both wrap. */
  readonly nextWorkspace: () => void;
  readonly previousWorkspace: () => void;
  /** Which body the sidebar draws; the row that runs this comes from the sidebar registry, as the section menu's does. */
  readonly setSidebarMode: (mode: SidebarMode) => void;
}

export interface PaletteItemsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selectedId: string | null;
  /** What the person typed; the thread search runs over it, the at-rest list ignores it. */
  readonly query: string;
  readonly canCreate: boolean;
  readonly sidebarMode: SidebarMode;
  readonly handlers: PaletteHandlers;
  readonly verbs: WorkspaceVerbs;
}

export interface PaletteItems {
  readonly actionItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly workspaceItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}

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

function actionItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  const { handlers, selectedId } = input;
  const selected = selectedId === null ? null : (input.projects.find(project => project.id === selectedId) ?? null);
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:new-workspace",
      searchTerms: ["new workspace", "create workspace"],
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      title: "New workspace",
      description: input.canCreate ? "A fresh machine forked from your golden image" : "Not connected to the runtime",
      disabled: !input.canCreate,
      run: sync(handlers.newWorkspace),
    },
  ];
  if (selected !== null) {
    items.push(...resolveActions(workspaceActions, workspaceTarget(selected.workspace, selected.status), input.verbs).map(action => actionItem(action, selected.displayName)));
  }

  items.push(...resolveActions(sidebarActions, { mode: input.sidebarMode }, { setMode: handlers.setSidebarMode }).map(action => actionItem(action, action.hint ?? "")));

  const oneWorkspace = input.projects.length < 2;
  items.push(
    {
      kind: "action",
      value: "action:next-workspace",
      searchTerms: ["next workspace", "switch workspace", "cycle workspaces"],
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      title: "Next workspace",
      shortcutCommand: "workspace.next",
      ...(oneWorkspace ? { disabled: true, description: "Only one workspace" } : {}),
      run: sync(handlers.nextWorkspace),
    },
    {
      kind: "action",
      value: "action:previous-workspace",
      searchTerms: ["previous workspace", "switch workspace", "cycle workspaces"],
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      title: "Previous workspace",
      shortcutCommand: "workspace.previous",
      ...(oneWorkspace ? { disabled: true, description: "Only one workspace" } : {}),
      run: sync(handlers.previousWorkspace),
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
      value: "action:toggle-right-panel",
      searchTerms: ["toggle right panel", "hide panel", "show panel"],
      icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "rightPanel.toggle",
      title: "Toggle right panel",
      description: selected ? selected.displayName : "Select a workspace first",
      disabled: selected === null,
      run: async () => {
        if (selected) handlers.toggleRightPanel(selected.id);
      },
    },
  );
  return items;
}

function workspaceItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  return input.projects.map((project, index) => {
    const machineId = project.status?.machineId ?? project.workspace.machineId;
    const parts = [project.indicator.label, machineId];
    if (project.id === input.selectedId) parts.push("Current workspace");
    // The projects arrive in sidebar order, so a row's index is the slot its chord jumps to.
    const slot = WORKSPACE_SELECT_SLOTS[index];
    return {
      kind: "action",
      value: `workspace:${project.id}`,
      searchTerms: [project.displayName],
      icon: (
        <span
          aria-hidden
          className={cn("mx-1 size-2 shrink-0 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")}
        />
      ),
      title: project.displayName,
      description: parts.join(" · "),
      ...(slot === undefined ? {} : { shortcutCommand: workspaceSelectCommand(slot) }),
      run: sync(() => input.handlers.selectWorkspace(project.id)),
    };
  });
}

function threadItem(thread: SidebarThreadSnapshot, project: SidebarProjectSnapshot, handlers: PaletteHandlers): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `thread:${thread.id}`,
    searchTerms: [thread.title],
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    title: thread.title,
    description: project.displayName,
    timestamp: compactTimeLabel(thread.startedAt),
    run: sync(() => handlers.selectThread(thread.workspaceId, thread.threadId)),
  };
}

export function buildPaletteItems(input: PaletteItemsInput): PaletteItems {
  const threads = input.projects
    .flatMap(project => project.threads.map(thread => ({ ...thread, project })))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const item = (thread: (typeof threads)[number]) => threadItem(thread, thread.project, input.handlers);
  return {
    actionItems: actionItems(input),
    workspaceItems: workspaceItems(input),
    recentThreadItems: threads.slice(0, RECENT_THREAD_LIMIT).map(item),
    threadSearchItems: searchSidebarThreadsByTitle(threads, input.query).map(item),
  };
}
