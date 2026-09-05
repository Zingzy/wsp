// SPDX-License-Identifier: AGPL-3.0-only
// The palette container: one dialog over the copied content and results,
// items from the store's workspaces and sessions, opened through the bus.
// Actions run the same shell commands the shortcuts do.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { deriveSidebarProjects } from "../../adapt/index.js";
import { isCommandPaletteOpen, onOpenCommandPalette } from "../../commandPaletteBus.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../../keybindingDefaults.js";
import type { ResolvedKeybindingsConfig } from "../../keybindingTypes.js";
import { useSelectedWorkspaceId, useStore } from "../../protocol/store.js";
import { useRightPanelStore } from "../../rightPanelStore.js";
import { showTerminal } from "../../shell/shellCommands.js";
import { requestNewThread, requestNewWorkspace } from "../../shell/shellRequests.js";
import { CommandDialog, CommandDialogPopup } from "../ui/command.js";
import { useSidebar } from "../ui/sidebar.js";
import {
  buildRootGroups,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic.js";
import { CommandPaletteContent } from "./CommandPaletteContent.js";
import { CommandPaletteResults } from "./CommandPaletteResults.js";
import { buildPaletteItems, type PaletteHandlers } from "./paletteItems.js";

const NO_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];

export function CommandPalette({ keybindings = DEFAULT_RESOLVED_KEYBINDINGS }: { keybindings?: ResolvedKeybindingsConfig }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const { toggleSidebar } = useSidebar();
  const api = useStore(s => s.api);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const select = useStore(s => s.select);
  const togglePhase = useStore(s => s.toggle);
  const selectedId = useSelectedWorkspaceId();
  const openSurface = useRightPanelStore(s => s.open);
  const toggleRightPanel = useRightPanelStore(s => s.toggleVisibility);

  useEffect(
    () =>
      onOpenCommandPalette(detail => {
        if (detail.toggle && isCommandPaletteOpen()) {
          setOpen(false);
          return;
        }
        setQuery(detail.query ?? "");
        setHighlightedItemValue(null);
        setOpen(true);
      }),
    [],
  );

  const projects = useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  const handlers = useMemo<PaletteHandlers>(
    () => ({
      selectWorkspace: select,
      newWorkspace: requestNewWorkspace,
      newThread: workspaceId => {
        select(workspaceId);
        requestNewThread({ workspaceId });
      },
      openTerminal: showTerminal,
      openBrowser: workspaceId => openSurface(workspaceId, "preview"),
      openMachine: workspaceId => openSurface(workspaceId, "machine"),
      togglePhase,
      rebuild: async workspaceId => {
        if (!api?.rebuild) return;
        await api.rebuild(workspaceId);
      },
      toggleSidebar,
      toggleRightPanel,
    }),
    [api, openSurface, select, toggleRightPanel, togglePhase, toggleSidebar],
  );
  const items = useMemo(
    () => buildPaletteItems({ projects, selectedId, canCreate: api !== null, canRebuild: api?.rebuild !== undefined, handlers }),
    [api, handlers, projects, selectedId],
  );

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const root = buildRootGroups({ actionItems: items.actionItems, recentThreadItems: items.recentThreadItems });
    if (items.workspaceItems.length > 0) {
      root.splice(1, 0, { value: "workspaces", label: "Workspaces", items: items.workspaceItems });
    }
    return filterCommandPaletteGroups({
      activeGroups: root,
      query,
      isInSubmenu: false,
      projectSearchItems: NO_ITEMS,
      threadSearchItems: items.threadSearchItems,
    });
  }, [items, query]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setHighlightedItemValue(null);
  };

  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void => {
    if (item.disabled || item.kind !== "action") return;
    if (!item.keepOpen) close();
    void item.run().catch((error: unknown) => {
      useStore.setState({ toast: `${String(item.title)}: ${error instanceof Error ? error.message : String(error)}` });
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    const highlighted = groups.flatMap(group => group.items).find(item => item.value === highlightedItemValue);
    if (!highlighted) return;
    event.preventDefault();
    executeItem(highlighted);
  };

  return (
    <CommandDialog open={open} onOpenChange={next => (next ? setOpen(true) : close())}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="overflow-hidden p-0"
        data-command-palette="true"
        onBackdropPointerDown={close}
      >
        <CommandPaletteContent
          aria-label="Command palette"
          footerActionLabel="Run"
          inputProps={{ placeholder: getCommandPaletteInputPlaceholder("root"), onKeyDown: onInputKeyDown }}
          mode="none"
          onItemHighlighted={value => setHighlightedItemValue(typeof value === "string" ? value : null)}
          onValueChange={value => {
            setHighlightedItemValue(null);
            setQuery(value);
          }}
          panelClassName="max-h-[min(28rem,70vh)]"
          value={query}
        >
          <CommandPaletteResults
            groups={groups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={query.startsWith(">")}
            keybindings={keybindings}
            onExecuteItem={executeItem}
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
