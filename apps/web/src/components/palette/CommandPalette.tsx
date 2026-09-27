// SPDX-License-Identifier: AGPL-3.0-only
// The palette container: one dialog over the copied content and results,
// items from the store's workspaces and sessions, opened through the bus. What
// the person types is asked of the host's message search once the typing
// pauses, and the answer is kept for the query it answered.
// The workspace rows come from the workspace registry, so they run what the
// sidebar's buttons and menus run.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { isLocalWorkspace, threadMarkdown, threadMessages, type SessionSearchHit } from "@wsp/protocol";
import { useWorkspaceVerbs } from "../../actions/verbs.js";
import { isCommandPaletteOpen, onOpenCommandPalette } from "../../commandPaletteBus.js";
import type { ResolvedKeybindingsConfig } from "../../keybindingTypes.js";
import { noticeFailure } from "../../notices/store.js";
import { useSelectedThreadId, useSelectedWorkspaceId, useSidebarProjects, useStore } from "../../protocol/store.js";
import { copyText } from "../../actions/clipboard.js";
import { useRightPanelStore } from "../../rightPanelStore.js";
import { cycleThreadInSpace, goToAdjacentWorkspace, goToWorkspace } from "../../shell/shellCommands.js";
import { useKeybindings } from "../../shell/useKeybindings.js";
import { requestAddProject, requestNewWorkspace } from "../../shell/shellRequests.js";
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
const NO_HITS: ReadonlyArray<SessionSearchHit> = [];
/** How long the typing rests before the words go to the host. */
const MESSAGE_SEARCH_WAIT_MS = 200;

export function CommandPalette({ keybindings: given }: { keybindings?: ResolvedKeybindingsConfig }) {
  const live = useKeybindings();
  const keybindings = given ?? live;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const { toggleSidebar } = useSidebar();
  const api = useStore(s => s.api);
  const workspaces = useStore(s => s.workspaces);
  const places = useStore(s => s.places);
  const select = useStore(s => s.select);
  const openSettings = useStore(s => s.openSettings);
  const openAddComputer = useStore(s => s.openAddComputer);
  const selectedId = useSelectedWorkspaceId();
  const selectedThreadId = useSelectedThreadId();
  const toggleRightPanel = useRightPanelStore(s => s.toggleVisibility);
  const verbs = useWorkspaceVerbs();

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

  const projects = useSidebarProjects();
  const [found, setFound] = useState<{ query: string; hits: ReadonlyArray<SessionSearchHit> } | null>(null);
  const words = query.startsWith(">") ? "" : query.trim();
  useEffect(() => {
    const search = api?.searchMessages;
    if (!open || search === undefined || words.length < 2) return;
    let current = true;
    const wait = setTimeout(() => {
      search(words).then(
        ({ hits }) => {
          if (current) setFound({ query: words, hits });
        },
        () => {},
      );
    }, MESSAGE_SEARCH_WAIT_MS);
    return () => {
      current = false;
      clearTimeout(wait);
    };
  }, [api, open, words]);
  const messageHits = found?.query === words ? found.hits : NO_HITS;
  const handlers = useMemo<PaletteHandlers>(
    () => ({
      selectWorkspace: goToWorkspace,
      selectThread: select,
      newWorkspace: project => requestNewWorkspace(project),
      toggleSidebar,
      toggleRightPanel,
      nextWorkspace: () => goToAdjacentWorkspace(1),
      previousWorkspace: () => goToAdjacentWorkspace(-1),
      nextThread: () => cycleThreadInSpace(1),
      previousThread: () => cycleThreadInSpace(-1),
      openSettings,
      addProject: requestAddProject,
      openAddComputer,
      copyThreadMarkdown:
        api === null || selectedId === null || selectedThreadId === null
          ? null
          : async () => await copyText(threadMarkdown(threadMessages(await api.sessionHistory(selectedId), selectedThreadId))),
    }),
    [api, openAddComputer, openSettings, select, selectedId, selectedThreadId, toggleRightPanel, toggleSidebar],
  );
  const items = useMemo(
    () => buildPaletteItems({ projects, selectedId, query, messageHits, canCreate: api !== null, handlers, verbs, places }),
    [api, handlers, messageHits, places, projects, query, selectedId, verbs],
  );

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const root = buildRootGroups({ actionItems: items.actionItems, recentThreadItems: items.recentThreadItems });
    if (items.workspaceItems.length > 0) {
      root.splice(1, 0, { value: "workspaces", label: "Tasks", items: items.workspaceItems });
    }
    return filterCommandPaletteGroups({
      activeGroups: root,
      query,
      isInSubmenu: false,
      projectSearchItems: NO_ITEMS,
      threadSearchItems: items.threadSearchItems,
      messageSearchItems: items.messageSearchItems,
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
      noticeFailure(error, said => `${String(item.title)}: ${said}`);
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
