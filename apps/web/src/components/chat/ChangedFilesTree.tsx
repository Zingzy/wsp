// Adapted from pingdotgg/t3code apps/web/src/components/chat/ChangedFilesTree.tsx at 57a66608 (MIT).
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { type TurnDiffFileChange, type TurnId } from "./adapt";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  FolderClosedIcon,
  GitBranchIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};
const EMPTY_MOVED: ReadonlyArray<string> = [];

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  /** Each HEAD move the turn did not write, one quiet line with no files of its own. */
  moved?: ReadonlyArray<string>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { turnId, files, moved = EMPTY_MOVED, allDirectoriesExpanded, resolvedTheme, onToggleAllDirectories, onOpenTurnDiff } = props;
  const summaryStat = useMemo(() => summarizeTurnDiffStats(files), [files]);
  const hasDirectories = files.some((file) => /[/\\]/.test(file.path));

  return (
    <div className="@container/changed-files mt-4 rounded-lg bg-secondary dark:bg-input/20" data-changed-files-state="tree">
      <div
        data-changed-files-header=""
        className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2 dark:bg-[color-mix(in_srgb,var(--input)_20%,var(--background))]"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground">
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(summaryStat) && (
            <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} layout="inline" className="text-xs leading-4" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasDirectories && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
                    data-scroll-anchor-ignore
                    onClick={onToggleAllDirectories}
                  />
                }
              >
                {allDirectoriesExpanded ? <ChevronsDownUpIcon className="size-3" /> : <ChevronsUpDownIcon className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}</TooltipPopup>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={<Button type="button" size="xs" variant="ghost" aria-label="Open diff" onClick={() => onOpenTurnDiff(turnId, files[0]?.path)} />}
            >
              <FileDiffIcon className="size-3" />
              <span className="hidden @[24rem]/changed-files:inline">Open diff</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {moved.length === 0 ? null : (
        <div data-changed-files-moved="" className="flex flex-col gap-0.5 px-3 pb-1 pt-0.5">
          {moved.map((line, index) => (
            <span key={`${index}:${line}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              {line}
            </span>
          ))}
        </div>
      )}
      {files.length === 0 ? null : (
        <div className="p-2">
          <ChangedFilesTree
            key={`${turnId}:${allDirectoriesExpanded}`}
            turnId={turnId}
            files={files}
            allDirectoriesExpanded={allDirectoriesExpanded}
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={onOpenTurnDiff}
          />
        </div>
      )}
    </div>
  );
});

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  /** A turn's changed-files card opens the row in the turn's diff; the pull request pane hands its own opener. One
   * of the two is given. */
  turnId?: TurnId;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenFile?: ((path: string) => void) | undefined;
  /** Neutral in the turn's card; the diff tone gives every count its green and red where a diff is what the reader
   * is looking at, as the pull request pane's Files tab does. */
  statTone?: "neutral" | "diff";
  /** What stands before a file row's name, as the Changes pane's commit tick does. */
  renderFileLead?: ((path: string) => ReactNode) | undefined;
  /** What stands at a file row's end, as the Changes pane's per-file controls do. */
  renderFileControls?: ((path: string) => ReactNode) | undefined;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, onOpenFile, resolvedTheme, turnId, statTone = "diff", renderFileLead, renderFileControls } = props;
  const openFile = (path: string): void => {
    if (onOpenFile !== undefined) onOpenFile(path);
    else if (onOpenTurnDiff !== undefined && turnId !== undefined) onOpenTurnDiff(turnId, path);
  };
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} tone={statTone} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const slotted = renderFileLead !== undefined || renderFileControls !== undefined;
    const row = (
      <button
        key={`file:${node.path}`}
        type="button"
        {...(slotted ? {} : { "data-changed-file": node.path })}
        className={cn(
          "group flex items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          slotted ? "min-w-0 flex-1" : "w-full hover:bg-accent/60",
        )}
        style={{ paddingLeft: slotted ? undefined : `${leftPadding}px` }}
        onClick={() => openFile(node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <PierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground/90">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} tone={statTone} />
          </span>
        )}
      </button>
    );
    if (!slotted) return row;
    // The row's own controls sit beside its button rather than inside it: a button holds no other button.
    return (
      <div key={`file:${node.path}`} data-changed-file={node.path} className="flex items-center gap-1 rounded-xl transition-colors hover:bg-accent/60" style={{ paddingLeft: `${leftPadding}px` }}>
        {renderFileLead?.(node.path)}
        {row}
        {renderFileControls?.(node.path)}
      </div>
    );
  };

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
