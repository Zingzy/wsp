// SPDX-License-Identifier: AGPL-3.0-only
// Quick open and search in files, on the palette's own dialog: the open
// thread's project folder searched over its daemon with fs.search, a file by
// the letters of its name or a line by the words in it. Picking one opens it
// as its own tab in the Files pane, at the line for a line.
import { FS_SEARCH_CAP_HITS, type FsSearchMode, type FsSearchReply } from "@wsp/protocol";
import { FileIcon, TextSearchIcon } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../components/palette/CommandPalette.logic.js";
import { ITEM_ICON_CLASS } from "../components/palette/CommandPalette.logic.js";
import { CommandPaletteContent } from "../components/palette/CommandPaletteContent.js";
import { CommandPaletteResults } from "../components/palette/CommandPaletteResults.js";
import { CommandDialog, CommandDialogPopup } from "../components/ui/command.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { errorText } from "../lib/utils.js";
import { useSelectedWorkspaceId, useWorkspace } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { fsSearch } from "../terminal/daemon-fs.js";
import { joinPath } from "./entries.js";
import { fileFinderQuery, rankFilePaths } from "./fileFinder.logic.js";
import { onOpenFileFinder } from "./finderBus.js";
import { projectFolderOf } from "./root.js";
import { useDaemonWire } from "./wire.js";

export const FINDER_WORDS = {
  files: { label: "Find a file", placeholder: "Find a file by name", group: "Files", none: "No file matches." },
  text: { label: "Search in files", placeholder: "Search the files for a word", group: "Lines", none: "No line holds that." },
  typeWord: "Type a word to search the files.",
  notRunning: "Open a running thread to search its files.",
  moreFiles: "More files match than one search reads; type more of the name.",
  moreLines: `More lines match than the first ${FS_SEARCH_CAP_HITS}; type more of the word.`,
} as const;

/** How long the finder waits for the typing to rest before it asks the daemon. */
const SETTLE_MS = 120;

type Answer = { kind: "idle" } | { kind: "ready"; reply: FsSearchReply; query: string } | { kind: "error"; message: string };

export function FileFinder() {
  const [mode, setMode] = useState<FsSearchMode | null>(null);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer>({ kind: "idle" });
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const workspaceId = useSelectedWorkspaceId();
  const workspace = useWorkspace(workspaceId ?? "");
  const wire = useDaemonWire(workspaceId ?? "");
  const openFile = useRightPanelStore(s => s.openFile);
  const folder = workspace === null ? null : projectFolderOf(workspace);
  const reads = mode !== null && wire !== null && folder !== null && workspace?.phase === "running";

  useEffect(
    () =>
      onOpenFileFinder(next => {
        setMode(next);
        setQuery("");
        setAnswer({ kind: "idle" });
        setHighlighted(null);
      }),
    [],
  );

  useEffect(() => {
    if (!reads || (mode === "text" && query.trim() === "")) {
      setAnswer({ kind: "idle" });
      return;
    }
    let stale = false;
    const asked = mode === "files" ? fileFinderQuery(query) : query.trim();
    const timer = setTimeout(() => {
      fsSearch(wire, folder, asked, mode).then(
        reply => {
          if (!stale) setAnswer({ kind: "ready", reply, query });
        },
        (e: unknown) => {
          if (!stale) setAnswer({ kind: "error", message: errorText(e) });
        },
      );
    }, SETTLE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [reads, wire, folder, mode, query]);

  const close = (): void => {
    setMode(null);
    setQuery("");
    setAnswer({ kind: "idle" });
    setHighlighted(null);
  };

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    if (mode === null || answer.kind !== "ready" || workspaceId === null || folder === null) return [];
    const open = (path: string, line?: number) => async () => openFile(workspaceId, joinPath(folder, path), line);
    const items: CommandPaletteActionItem[] =
      mode === "files"
        ? rankFilePaths(
            answer.reply.hits.map(hit => hit.path),
            query,
          ).map(match => ({
            kind: "action",
            value: `file:${match.path}`,
            searchTerms: [],
            title: match.name,
            ...(match.folder !== "" ? { description: <span className="font-mono">{match.folder}</span> } : {}),
            icon: <FileIcon className={ITEM_ICON_CLASS} />,
            run: open(match.path),
          }))
        : answer.reply.hits.map(hit => ({
            kind: "action",
            value: `line:${hit.path}:${hit.line ?? 0}`,
            searchTerms: [],
            title: <span className="font-mono text-xs">{(hit.text ?? "").trim()}</span>,
            description: <span className="font-mono">{`${hit.path}:${hit.line ?? 1}`}</span>,
            icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
            run: open(hit.path, hit.line),
          }));
    return items.length === 0 ? [] : [{ value: mode, label: FINDER_WORDS[mode].group, items }];
  }, [answer, folder, mode, openFile, query, workspaceId]);

  const run = (item: CommandPaletteActionItem | { kind: string }): void => {
    if (item.kind !== "action") return;
    close();
    void (item as CommandPaletteActionItem).run();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    const all = groups.flatMap(group => group.items);
    const item = all.find(candidate => candidate.value === highlighted) ?? all[0];
    if (item === undefined) return;
    event.preventDefault();
    run(item);
  };

  if (mode === null) return null;
  const words = FINDER_WORDS[mode];
  const empty = !reads
    ? FINDER_WORDS.notRunning
    : answer.kind === "error"
      ? answer.message
      : mode === "text" && query.trim() === ""
        ? FINDER_WORDS.typeWord
        : answer.kind === "ready"
          ? words.none
          : "";
  const more = answer.kind === "ready" && answer.reply.truncated ? (mode === "files" ? FINDER_WORDS.moreFiles : FINDER_WORDS.moreLines) : null;

  return (
    <CommandDialog open onOpenChange={next => (next ? undefined : close())}>
      <CommandDialogPopup aria-label={words.label} className="overflow-hidden p-0" data-file-finder={mode} onBackdropPointerDown={close}>
        <CommandPaletteContent
          aria-label={words.label}
          footerActionLabel="Open"
          {...(more !== null ? { footerTrailing: <span className="text-xs text-muted-foreground" data-file-finder-more>{more}</span> } : {})}
          inputProps={{ placeholder: words.placeholder, onKeyDown: onInputKeyDown, ...{ "data-file-finder-input": mode } }}
          mode="none"
          onItemHighlighted={value => setHighlighted(typeof value === "string" ? value : null)}
          onValueChange={value => {
            setHighlighted(null);
            setQuery(value);
          }}
          panelClassName="max-h-[min(28rem,70vh)]"
          value={query}
        >
          <CommandPaletteResults groups={groups} emptyStateMessage={empty} highlightedItemValue={highlighted} isActionsOnly={false} keybindings={DEFAULT_RESOLVED_KEYBINDINGS} onExecuteItem={run} />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
