// Adapted from pingdotgg/t3code apps/web/src/components/files/FileBreadcrumbs.tsx at 57a66608 (MIT).
// Differs from upstream: the directory menus browse the daemon's per-folder listings, asking for a folder the first time it is shown.
import { ArrowLeftIcon, ChevronRightIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { parentPath } from "../../files/entries";
import type { Levels } from "../../files/listing";
import { cn } from "../../lib/utils";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import {
  type FileBreadcrumb,
  fileBreadcrumbChildren,
  fileBreadcrumbs,
} from "./filePath";

interface FileBreadcrumbsProps {
  readonly projectName: string;
  /** The daemon root, which the project crumb stands for. */
  readonly root: string;
  /** The open file, as the daemon names it. */
  readonly path: string;
  readonly levels: Levels;
  /** A menu is showing a folder; its listing is fetched the first time. */
  readonly onBrowseDirectory: (dir: string) => void;
  readonly onRefreshDirectory: (dir: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly theme: "light" | "dark";
}

function pathLabel(path: string, root: string, projectName: string): string {
  return path === root ? projectName : path.slice(path.lastIndexOf("/") + 1) || path;
}

function BreadcrumbLabel(props: {
  readonly current?: boolean;
  readonly label: string;
  readonly pathLabel: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "block max-w-40 truncate rounded-sm px-0.5",
              props.current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          />
        }
      >
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        {props.pathLabel}
      </TooltipPopup>
    </Tooltip>
  );
}

function BreadcrumbMenuContent(props: {
  readonly crumbs: FileBreadcrumbsProps;
  readonly directoryPath: string;
  readonly onDirectoryChange: (path: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly rootPath: string;
}) {
  const { crumbs, directoryPath } = props;
  const level = crumbs.levels.get(directoryPath);
  const children = useMemo(() => fileBreadcrumbChildren(crumbs.levels, directoryPath), [crumbs.levels, directoryPath]);
  const parent = parentPath(directoryPath);
  const canGoBack = directoryPath !== props.rootPath && parent !== null;

  useEffect(() => {
    crumbs.onBrowseDirectory(directoryPath);
  }, [crumbs.onBrowseDirectory, directoryPath]);

  return (
    <MenuPopup
      align="start"
      side="bottom"
      className="w-max min-w-32 max-w-[min(19rem,var(--available-width))]"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" || !canGoBack || parent === null) return;
        event.preventDefault();
        event.stopPropagation();
        props.onDirectoryChange(parent);
      }}
    >
      {canGoBack && parent !== null ? (
        <>
          <MenuItem closeOnClick={false} onClick={() => props.onDirectoryChange(parent)}>
            <ArrowLeftIcon />
            <span className="truncate">Back to {pathLabel(parent, crumbs.root, crumbs.projectName)}</span>
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuGroup key={directoryPath}>
        {children === null && level?.error ? (
          <MenuItem closeOnClick={false} onClick={() => crumbs.onRefreshDirectory(directoryPath)}>
            <RotateCwIcon />
            <span className="min-w-0 flex-1 truncate">Retry loading folder</span>
          </MenuItem>
        ) : children === null ? (
          <MenuItem disabled>
            <LoaderCircleIcon className="animate-spin" />
            Loading folder…
          </MenuItem>
        ) : children.length === 0 ? (
          <MenuItem disabled>This folder is empty.</MenuItem>
        ) : (
          children.map((entry) => {
            const isCurrentFile = entry.kind === "file" && entry.path === crumbs.path;
            return (
              <MenuItem
                key={entry.path}
                closeOnClick={entry.kind === "file"}
                aria-current={isCurrentFile ? "page" : undefined}
                className={cn(isCurrentFile && "bg-foreground/[0.08]")}
                onClick={() => {
                  if (entry.kind === "directory") {
                    props.onDirectoryChange(entry.path);
                    return;
                  }
                  props.onOpenChange(false);
                  crumbs.onOpenFile(entry.path);
                }}
              >
                <PierreEntryIcon pathValue={entry.path} kind={entry.kind} theme={crumbs.theme} />
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                    {entry.label}
                  </TooltipTrigger>
                  <TooltipPopup side="right" className="max-w-80">
                    {entry.path}
                  </TooltipPopup>
                </Tooltip>
                {entry.kind === "directory" ? <ChevronRightIcon /> : null}
              </MenuItem>
            );
          })
        )}
      </MenuGroup>
      {level?.error && children !== null ? (
        <>
          <MenuSeparator />
          <MenuItem closeOnClick={false} onClick={() => crumbs.onRefreshDirectory(directoryPath)}>
            <RotateCwIcon />
            Refresh failed, retry
          </MenuItem>
        </>
      ) : null}
      {level?.truncated ? (
        <>
          <MenuSeparator />
          <MenuItem disabled>{(level.total - (level.entries?.length ?? 0)).toLocaleString("en-US")} more entries not shown.</MenuItem>
        </>
      ) : null}
    </MenuPopup>
  );
}

function DirectoryBreadcrumb(props: FileBreadcrumbsProps & { readonly crumb: FileBreadcrumb }) {
  const [open, setOpen] = useState(false);
  const [directoryPath, setDirectoryPath] = useState(props.crumb.path);

  useEffect(() => {
    setOpen(false);
    setDirectoryPath(props.crumb.path);
  }, [props.crumb.path, props.path]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setDirectoryPath(props.crumb.path);
  };

  return (
    <Menu open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Browse ${props.crumb.label}`}
                  className="relative block max-w-40 cursor-pointer rounded-sm px-0.5 text-left text-muted-foreground outline-none pointer-coarse:after:-inset-y-3 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
                />
              }
            />
          }
        >
          <span className="block truncate">{props.crumb.label}</span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80">
          {props.crumb.path === props.root ? props.projectName : props.crumb.path}
        </TooltipPopup>
      </Tooltip>
      {open ? (
        <BreadcrumbMenuContent
          crumbs={props}
          directoryPath={directoryPath}
          onDirectoryChange={setDirectoryPath}
          onOpenChange={handleOpenChange}
          rootPath={props.crumb.path}
        />
      ) : null}
    </Menu>
  );
}

export function FileBreadcrumbs(props: FileBreadcrumbsProps) {
  const breadcrumbs = useMemo(
    () => fileBreadcrumbs(props.projectName, props.root, props.path),
    [props.projectName, props.root, props.path],
  );

  return breadcrumbs.map((crumb, index) => (
    <div
      key={crumb.path}
      className="flex min-w-0 shrink-0 items-center"
      data-current-file-crumb={crumb.kind === "file"}
    >
      {index > 0 ? (
        <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
      ) : null}
      {crumb.kind === "file" ? (
        <span aria-current="page">
          <BreadcrumbLabel current label={crumb.label} pathLabel={crumb.path} />
        </span>
      ) : (
        <DirectoryBreadcrumb {...props} crumb={crumb} />
      )}
    </div>
  ));
}
