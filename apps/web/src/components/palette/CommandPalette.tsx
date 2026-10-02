// SPDX-License-Identifier: AGPL-3.0-only
// The palette container: one dialog over the copied content and results,
// items from the store's workspaces and sessions, opened through the bus. What
// the person types is asked of the host's message search once the typing
// pauses, and the answer is kept for the query it answered. A submenu row
// opens its page over the root, Backspace on an empty search goes back, and
// the page of projects New thread picks from takes the mod digits for its
// first nine rows while it is open.
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
import { openNewThread } from "../../shell/NewThreadPicks.js";
import { requestAddProject } from "../../shell/shellRequests.js";
import { CommandDialog, CommandDialogPopup } from "../ui/command.js";
import { useSidebar } from "../ui/sidebar.js";
import {
  buildRootGroups,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic.js";
import { CommandPaletteContent } from "./CommandPaletteContent.js";
import { CommandPaletteResults } from "./CommandPaletteResults.js";
import { NEW_THREAD_PAGE, buildPaletteItems, pickedRow, type PaletteHandlers } from "./paletteItems.js";

const NO_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];
const NO_HITS: ReadonlyArray<SessionSearchHit> = [];
/** How long the typing rests before the words go to the host. */
const MESSAGE_SEARCH_WAIT_MS = 200;
const PAGES = { "new-thread": NEW_THREAD_PAGE } as const;

export function CommandPalette({ keybindings: given }: { keybindings?: ResolvedKeybindingsConfig }) {
  const live = useKeybindings();
  const keybindings = given ?? live;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  /** The submenu pages open over the root, by their rows' values, the one on screen last. */
  const [pages, setPages] = useState<ReadonlyArray<string>>([]);
  const { toggleSidebar } = useSidebar();
  const api = useStore(s => s.api);
  const workspaces = useStore(s => s.workspaces);
  const places = useStore(s => s.places);
  const select = useStore(s => s.select);
  const openSettings = useStore(s => s.openSettings);
  const openAddComputer = useStore(s => s.openAddComputer);
  const openProjectHome = useStore(s => s.openProjectHome);
  const recorded = useStore(s => s.projects);
  const projectOrder = useStore(s => s.preferences.projectOrder);
  const asks = useStore(s => s.preferences.newThreadIn === "ask");
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
        setPages(detail.page === undefined ? [] : [PAGES[detail.page]]);
        setOpen(true);
      }),
    [],
  );

  const projects = useSidebarProjects();
  const [found, setFound] = useState<{ query: string; hits: ReadonlyArray<SessionSearchHit> } | null>(null);
  const words = pages.length > 0 || query.startsWith(">") ? "" : query.trim();
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
      newThread: openNewThread,
      openProjectHome,
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
    [api, openAddComputer, openProjectHome, openSettings, select, selectedId, selectedThreadId, toggleRightPanel, toggleSidebar],
  );
  const items = useMemo(
    () => buildPaletteItems({ projects, selectedId, query, messageHits, canCreate: api !== null, recorded, projectOrder, asks, handlers, verbs, places }),
    [api, asks, handlers, messageHits, places, projectOrder, projects, query, recorded, selectedId, verbs],
  );
  // A page whose row is gone or held, as the last project's removal leaves it, reads as the root.
  const page = useMemo(() => {
    const at = pages.at(-1);
    const row = items.actionItems.find((item): item is CommandPaletteSubmenuItem => item.kind === "submenu" && item.value === at);
    return row === undefined || row.disabled ? null : row;
  }, [items, pages]);
  const mode = getCommandPaletteMode({ currentView: page });

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    if (page !== null) return filterCommandPaletteGroups({ activeGroups: page.groups, query, isInSubmenu: true, projectSearchItems: NO_ITEMS, threadSearchItems: NO_ITEMS });
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
  }, [items, page, query]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setHighlightedItemValue(null);
    setPages([]);
  };

  const openPage = (item: CommandPaletteSubmenuItem): void => {
    setPages(open => [...open, item.value]);
    setQuery(item.initialQuery ?? "");
    setHighlightedItemValue(null);
  };

  const back = (): void => {
    setPages(open => open.slice(0, -1));
    setQuery("");
    setHighlightedItemValue(null);
  };

  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void => {
    if (item.disabled) return;
    if (item.kind === "submenu") return openPage(item);
    if (!item.keepOpen) close();
    void item.run().catch((error: unknown) => {
      noticeFailure(error, said => `${String(item.title)}: ${said}`);
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.defaultPrevented) return;
    if (page !== null && event.key === "Backspace" && query === "") {
      event.preventDefault();
      back();
      return;
    }
    const digit = page === null ? null : pickedRow(event);
    if (page !== null && digit !== null) {
      // Taken here, so the shell's own mod digits never switch the workspace under the page.
      event.preventDefault();
      const row = page.groups.flatMap(group => group.items)[digit - 1];
      const shown = groups.some(group => group.items.some(item => item.value === row?.value));
      if (row !== undefined && shown) executeItem(row);
      return;
    }
    if (event.key !== "Enter") return;
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
          footerActionLabel={page === null ? "Run" : "Select"}
          inputProps={{
            placeholder: page?.placeholder ?? getCommandPaletteInputPlaceholder(mode),
            onKeyDown: onInputKeyDown,
            ...(page === null
              ? {}
              : {
                  startAddon: (
                    <button type="button" data-k="palette-back" aria-label="Back" className="-m-1 flex cursor-pointer rounded-md p-1 transition-colors duration-150 hover:bg-accent [&_svg]:hover:text-foreground" onMouseDown={event => event.preventDefault()} onClick={back}>
                      {page.addonIcon}
                    </button>
                  ),
                }),
          }}
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
            {...(page?.emptyStateMessage === undefined ? {} : { emptyStateMessage: page.emptyStateMessage })}
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
