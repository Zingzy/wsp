// SPDX-License-Identifier: AGPL-3.0-only
// One open file: breadcrumbs over the listing, then the file from fs.read as
// highlighted code or, for markdown, rendered. Read-only; the daemon has no
// write op yet.
import { File, Virtualizer } from "@pierre/diffs/react";
import { Code2, Eye, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fmtBytes, type FsReadReply } from "@wsp/protocol";
import { FileBreadcrumbs } from "../components/files/FileBreadcrumbs.js";
import { FileMarkdownPreview } from "../components/files/FileMarkdownPreview.js";
import { Button } from "../components/ui/button.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { Spinner } from "../components/ui/spinner.js";
import { Toggle } from "../components/ui/toggle.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, fnv1a32, resolveDiffThemeName } from "../lib/diffRendering.js";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting.js";
import { cn } from "../lib/utils.js";
import { useWorkspace } from "../protocol/store.js";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore.js";
import { fsRead } from "../terminal/daemon-fs.js";
import { CrumbScroller } from "./CrumbScroller.js";
import { isMarkdownFile } from "./entries.js";
import { NotRunning } from "./FilesSurface.js";
import { useWorkspaceListing } from "./listing.js";
import { rootOf, useRoots } from "./root.js";
import { useDaemonWire } from "./wire.js";

type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

type ReadState =
  | { kind: "pending"; last: FsReadReply | null }
  | { kind: "ready"; reply: FsReadReply }
  | { kind: "error"; message: string; last: FsReadReply | null };

/** Reading markdown rendered is a preference, not a property of one file. */
const RENDER_MARKDOWN_KEY = "wsp:render-markdown";
const boolean: Codec<boolean> = { decode: raw => raw === "true", encode: value => String(value) };

function lastReply(state: ReadState): FsReadReply | null {
  return state.kind === "ready" ? state.reply : state.last;
}

export function FilePreviewSurface({ workspaceId, surface, theme }: { workspaceId: string; surface: FileSurface; theme: "light" | "dark" }) {
  const path = surface.relativePath;
  const workspace = useWorkspace(workspaceId);
  const wire = useDaemonWire(workspaceId);
  const roots = useRoots(workspaceId);
  const listing = useWorkspaceListing(workspaceId);
  const openFile = useRightPanelStore(s => s.openFile);
  const [read, setRead] = useState<ReadState>({ kind: "pending", last: null });
  const [renderMarkdown, setRenderMarkdown] = useLocalStorage(RENDER_MARKDOWN_KEY, true, boolean);

  const load = useCallback(() => {
    if (!wire) return;
    let gone = false;
    setRead(current => ({ kind: "pending", last: lastReply(current) }));
    fsRead(wire, path).then(
      reply => {
        if (!gone) setRead({ kind: "ready", reply });
      },
      (e: unknown) => {
        if (!gone) setRead(current => ({ kind: "error", message: e instanceof Error ? e.message : String(e), last: lastReply(current) }));
      },
    );
    return () => {
      gone = true;
    };
  }, [wire, path]);

  useEffect(() => load(), [load]);

  if (!wire) return <NotRunning />;

  const isMarkdown = isMarkdownFile(path);
  const rendered = isMarkdown && renderMarkdown;
  const reply = lastReply(read);
  const binary = reply !== null && reply.content.includes("\0");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background" data-file-preview={path}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <CrumbScroller label="File path" rowClassName="text-xs" data-file-breadcrumbs>
          <FileBreadcrumbs
            projectName={workspace?.name ?? "workspace"}
            root={rootOf(roots, path) ?? "/"}
            path={path}
            levels={listing.levels}
            onBrowseDirectory={listing.ensure}
            onRefreshDirectory={listing.refresh}
            onOpenFile={next => openFile(workspaceId, next)}
            theme={theme}
          />
        </CrumbScroller>
        {isMarkdown ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={rendered}
                  onPressedChange={pressed => setRenderMarkdown(Boolean(pressed))}
                  aria-label={rendered ? "Show markdown source" : "Show rendered markdown"}
                  variant="ghost"
                  size="sm"
                >
                  {rendered ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
                </Toggle>
              }
            />
            <TooltipPopup>{rendered ? "Show markdown source" : "Show rendered markdown"}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="Reload file" onClick={load} />}>
            <RotateCw className={cn("size-3.5", read.kind === "pending" && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup>Reload file</TooltipPopup>
        </Tooltip>
      </div>
      {reply?.truncated ? (
        <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground" data-file-truncated>
          Showing the first {fmtBytes(reply.content.length)} of {fmtBytes(reply.size)}; the daemon caps reads at 2 MB.
        </p>
      ) : null}
      {read.kind === "error" && reply === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">{read.message}</div>
      ) : reply === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      ) : binary ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          Binary file, {fmtBytes(reply.size)}. Nothing to preview.
        </div>
      ) : rendered ? (
        <ScrollArea className="min-h-0 flex-1">
          <FileMarkdownPreview text={reply.content} />
        </ScrollArea>
      ) : (
        <Virtualizer
          key={`${path}:${theme}:${reply.size}`}
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={{ name: path, contents: reply.content, cacheKey: `${workspaceId}:${path}:${fnv1a32(reply.content)}` }}
            options={{
              disableFileHeader: true,
              overflow: "scroll",
              theme: resolveDiffThemeName(theme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: theme,
              unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
            }}
            className="min-h-full"
          />
        </Virtualizer>
      )}
    </div>
  );
}
