// SPDX-License-Identifier: AGPL-3.0-only
// The palette's item list over the sidebar's project snapshots: actions for
// the selected workspace, one row per workspace to switch to, recent threads.
// Pure apart from the callbacks it is handed, so the list is testable without
// the dialog.
import {
  GlobeIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { needsRebuild } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../../adapt/index.js";
import { cn } from "../../lib/utils.js";
import { compactTimeLabel, dotClassForTone } from "../../sidebar/workspaceRows.js";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS, RECENT_THREAD_LIMIT } from "./CommandPalette.logic.js";

export interface PaletteHandlers {
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly newWorkspace: () => void;
  readonly newThread: (workspaceId: string) => void;
  readonly openTerminal: (workspaceId: string) => Promise<void>;
  readonly openBrowser: (workspaceId: string) => void;
  readonly openMachine: (workspaceId: string) => void;
  /** Pauses a running workspace, wakes a paused one. */
  readonly togglePhase: (workspaceId: string) => Promise<void>;
  readonly rebuild: (workspaceId: string) => Promise<void>;
  readonly toggleSidebar: () => void;
  readonly toggleRightPanel: (workspaceId: string) => void;
}

export interface PaletteItemsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selectedId: string | null;
  readonly canCreate: boolean;
  readonly canRebuild: boolean;
  readonly handlers: PaletteHandlers;
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

function actionItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  const { handlers, selectedId } = input;
  const selected = selectedId === null ? null : (input.projects.find(project => project.id === selectedId) ?? null);
  const scoped = (title: string, run: (workspaceId: string) => void | Promise<void>) => ({
    title,
    description: selected ? selected.displayName : "Select a workspace first",
    disabled: selected === null,
    run: async () => {
      if (selected) await run(selected.id);
    },
  });

  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:new-workspace",
      searchTerms: ["new workspace", "create workspace", "fork"],
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      title: "New workspace",
      description: input.canCreate ? "A fresh machine forked from your golden image" : "Not connected to the runtime",
      disabled: !input.canCreate,
      run: sync(handlers.newWorkspace),
    },
    {
      kind: "action",
      value: "action:new-thread",
      searchTerms: ["new thread", "new chat", "new session"],
      icon: <MessageSquarePlusIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.new",
      ...scoped("New thread", handlers.newThread),
    },
    {
      kind: "action",
      value: "action:open-terminal",
      searchTerms: ["open terminal", "new terminal", "shell"],
      icon: <SquareTerminalIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "terminal.toggle",
      ...scoped("Open terminal", handlers.openTerminal),
    },
    {
      kind: "action",
      value: "action:open-browser",
      searchTerms: ["open browser", "preview", "ports"],
      icon: <GlobeIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "preview.toggle",
      ...scoped("Open browser", handlers.openBrowser),
      ...(selected && selected.phase !== "running"
        ? { disabled: true, description: `${selected.displayName} is not running` }
        : {}),
    },
    {
      kind: "action",
      value: "action:open-machine",
      searchTerms: ["open machine", "usage", "lineage", "upgrade"],
      icon: <ServerIcon className={ITEM_ICON_CLASS} />,
      ...scoped("Open machine", handlers.openMachine),
    },
  ];

  if (selected?.phase === "running") {
    items.push({
      kind: "action",
      value: "action:pause",
      searchTerms: ["pause workspace", "nap", "sleep", "stop"],
      icon: <PauseIcon className={ITEM_ICON_CLASS} />,
      ...scoped("Pause workspace", handlers.togglePhase),
    });
  } else if (selected?.phase === "napping" || selected?.phase === "pausing") {
    items.push({
      kind: "action",
      value: "action:wake",
      searchTerms: ["wake workspace", "resume", "start"],
      icon: <PlayIcon className={ITEM_ICON_CLASS} />,
      ...scoped("Wake workspace", handlers.togglePhase),
    });
  }

  if (selected !== null && needsRebuild(selected)) {
    items.push({
      kind: "action",
      value: "action:rebuild",
      searchTerms: ["rebuild machine", "zombie", "gone", "replace"],
      icon: <RefreshCwIcon className={ITEM_ICON_CLASS} />,
      ...scoped("Rebuild machine", handlers.rebuild),
      description: input.canRebuild ? "Replaces the machine with a fresh fork of the golden image" : "This client cannot rebuild machines",
      disabled: !input.canRebuild,
    });
  }

  items.push(
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
      ...scoped("Toggle right panel", handlers.toggleRightPanel),
    },
  );
  return items;
}

function workspaceItems(input: PaletteItemsInput): CommandPaletteActionItem[] {
  return input.projects.map(project => {
    const machineId = project.status?.machineId ?? project.workspace.machineId;
    const parts = [project.indicator.label, machineId];
    if (project.id === input.selectedId) parts.push("Current workspace");
    return {
      kind: "action",
      value: `workspace:${project.id}`,
      searchTerms: [project.displayName, project.id, machineId, project.indicator.label],
      icon: (
        <span
          aria-hidden
          className={cn("mx-1 size-2 shrink-0 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")}
        />
      ),
      title: project.displayName,
      description: parts.join(" · "),
      run: sync(() => input.handlers.selectWorkspace(project.id)),
    };
  });
}

function threadItem(thread: SidebarThreadSnapshot, project: SidebarProjectSnapshot, handlers: PaletteHandlers): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `thread:${thread.id}`,
    searchTerms: [thread.title, project.displayName, thread.id],
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    title: thread.title,
    description: project.displayName,
    timestamp: compactTimeLabel(thread.startedAt),
    run: sync(() => handlers.selectWorkspace(thread.workspaceId)),
  };
}

export function buildPaletteItems(input: PaletteItemsInput): PaletteItems {
  const threads = input.projects
    .flatMap(project => project.threads.map(thread => ({ thread, project })))
    .sort((a, b) => (b.thread.startedAt ?? "").localeCompare(a.thread.startedAt ?? ""))
    .map(({ thread, project }) => threadItem(thread, project, input.handlers));
  return {
    actionItems: actionItems(input),
    workspaceItems: workspaceItems(input),
    recentThreadItems: threads.slice(0, RECENT_THREAD_LIMIT),
    threadSearchItems: threads,
  };
}
