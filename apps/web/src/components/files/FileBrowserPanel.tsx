// Adapted from pingdotgg/t3code apps/web/src/components/files/FileBrowserPanel.tsx at 57a66608 (MIT).
// Differs from upstream: the tree fills in one folder at a time as folders
// are expanded, over the daemon's per-folder listing, instead of one deep
// walk; the expand-all control and the preview reveal sync are gone with it.
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { joinPath } from "../../files/entries";
import type { Levels } from "../../files/listing";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { fileTreeRows, sortTreeRows } from "./fileTreeRows";

interface FileBrowserPanelProps {
  projectName: string;
  /** The folder the tree is rooted at, as the daemon names it. */
  root: string;
  levels: Levels;
  /** A folder row was opened whose listing nobody asked for yet. */
  onExpandDirectory: (dir: string) => void;
  onOpenFile: (path: string) => void;
  /** Called with every folder the tree currently shows a listing for. */
  onRefresh: (dirs: string[]) => void;
  theme: "light" | "dark";
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  projectName,
  root,
  levels,
  onExpandDirectory,
  onOpenFile,
  onRefresh,
  theme,
}: FileBrowserPanelProps) {
  const rootLevel = levels.get(root);
  const rows = useMemo(() => fileTreeRows(root, levels), [root, levels]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const expandRef = useRef(onExpandDirectory);
  expandRef.current = onExpandDirectory;
  // The tree model reads its options once, so the selection handler goes through refs for the current root and opener.
  const openRef = useRef({ root, onOpenFile });
  openRef.current = { root, onOpenFile };
  const previousRef = useRef<{ root: string; paths: readonly string[] } | null>(null);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    icons: { set: "complete", colored: true },
    onSelectionChange: (selectedPaths) => {
      const selected = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selected && rowsRef.current.kinds.get(selected) === "file") openRef.current.onOpenFile(joinPath(openRef.current.root, selected));
    },
    paths: [],
    search: false,
    sort: sortTreeRows,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };

  useEffect(() => {
    if (rootLevel?.entries == null) return;
    const previous = previousRef.current;
    if (previous?.root === root && previous.paths === rows.paths) return;
    previousRef.current = { root, paths: rows.paths };
    if (previous === null || previous.root !== root) {
      model.resetPaths(rows.paths);
      return;
    }
    const updates = buildFileTreePathUpdates(previous.paths, rows.paths);
    if (updates.length > 0) model.batch(updates);
  }, [model, root, rootLevel?.entries, rows.paths]);

  // The tree has no lazy-load hook, so every change is checked for a folder that is open without a listing.
  useEffect(
    () =>
      model.subscribe(() => {
        for (const [treePath, dir] of rowsRef.current.directories) {
          if (levelsRef.current.has(dir)) continue;
          const item = model.getItem(treePath);
          if (item !== null && "isExpanded" in item && item.isExpanded()) expandRef.current(dir);
        }
      }),
    [model],
  );

  const showError = rootLevel?.error !== null && rootLevel?.error !== undefined && rootLevel.entries === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-file-browser-panel={projectName} data-file-browser-root={root}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={rootLevel?.isPending ?? false} onRefresh={() => onRefresh(rows.loaded.length > 0 ? rows.loaded : [root])} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
      </div>
      {showError ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{rootLevel.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: theme,
            ["--trees-fg-override" as string]: "var(--contrast-foreground)",
          }}
        />
      )}
    </div>
  );
}
