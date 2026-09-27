// SPDX-License-Identifier: AGPL-3.0-only
// One open file, a tab of its own beside the tree: a crumb row whose folders go
// back to the tree there, then the file from fs.read as highlighted code or,
// for markdown, rendered. A line asked for is marked and scrolled to, and asked
// again it is scrolled to again. Read only; the daemon has no write op.
import type { CodeViewHandle, CodeViewItem } from "@pierre/diffs/react";
import { Code2, Eye, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, type FsReadReply } from "@wsp/protocol";
import { FileMarkdownPreview } from "../components/files/FileMarkdownPreview.js";
import { StyledDiffCodeView } from "../components/diffs/StyledDiffCodeView.js";
import { Button } from "../components/ui/button.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { Spinner } from "../components/ui/spinner.js";
import { Toggle } from "../components/ui/toggle.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { NotRunning } from "../diffs/NotRunning.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { fnv1a32, resolveDiffThemeName } from "../lib/diffRendering.js";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting.js";
import { cn } from "../lib/utils.js";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore.js";
import { fsRead } from "../terminal/daemon-fs.js";
import { isMarkdownFile } from "./entries.js";
import { FILES_NOT_RUNNING } from "./FilesSurface.js";
import { FolderCrumbRow } from "./FolderBreadcrumbs.js";
import { OpenInEditor } from "./OpenInEditor.js";
import { useRoots, useRootStore } from "./root.js";
import { useDaemonWire } from "./wire.js";

type FileSurface = Extract<RightPanelSurface, { kind: "files"; path: string }>;

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
  const { path, line, reveal } = surface;
  const wire = useDaemonWire(workspaceId);
  const roots = useRoots(workspaceId);
  const pin = useRootStore(s => s.pin);
  const openSurface = useRightPanelStore(s => s.open);
  const [read, setRead] = useState<ReadState>({ kind: "pending", last: null });
  const [renderMarkdown, setRenderMarkdown] = useLocalStorage(RENDER_MARKDOWN_KEY, true, boolean);
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);

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

  const reply = lastReply(read);
  const isMarkdown = isMarkdownFile(path);
  // A line asked for is read in the source, where it can be marked; markdown rendered has no lines to mark.
  const rendered = isMarkdown && renderMarkdown && line === null;
  const binary = reply !== null && reply.content.includes("\0");
  const items = useMemo<CodeViewItem[]>(
    () => (reply === null ? [] : [{ id: path, type: "file", file: { name: path, contents: reply.content, cacheKey: `${workspaceId}:${path}:${fnv1a32(reply.content)}` } }]),
    [reply, path, workspaceId],
  );

  useEffect(() => {
    if (line === null || items.length === 0 || rendered || binary) return;
    const frame = requestAnimationFrame(() => viewerRef.current?.scrollTo({ type: "line", id: path, lineNumber: line, align: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [line, reveal, items, path, rendered, binary]);

  if (!wire) return <NotRunning workspaceId={workspaceId} line={FILES_NOT_RUNNING} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background" data-file-preview={path} data-file-line={line ?? undefined}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-2 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7"
        data-surface-subheader
      >
        <FolderCrumbRow
          roots={roots}
          folder={path}
          onPick={folder => {
            pin(workspaceId, folder);
            openSurface(workspaceId, "files");
          }}
          className="text-xs"
        />
        {isMarkdown && line === null ? (
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
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label="Reload file" onClick={load} />}>
            <RotateCw className={cn("size-3.5", read.kind === "pending" && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup>Reload file</TooltipPopup>
        </Tooltip>
        <OpenInEditor workspaceId={workspaceId} path={path} line={line} />
      </div>
      {reply?.truncated ? (
        <p className="shrink-0 px-3 py-1.5 text-[11px] text-muted-foreground" data-file-truncated>
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
        <StyledDiffCodeView
          key={`${path}:${theme}`}
          viewerRef={viewerRef}
          className="h-full min-h-0 flex-1 overflow-auto"
          items={items}
          selectedLines={line === null ? null : { id: path, range: { start: line, end: line } }}
          options={{ disableFileHeader: true, overflow: "scroll", theme: resolveDiffThemeName(theme), preferredHighlighter: PREFERRED_HIGHLIGHTER, themeType: theme }}
        />
      )}
    </div>
  );
}
