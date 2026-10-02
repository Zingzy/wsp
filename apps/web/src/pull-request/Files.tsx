// SPDX-License-Identifier: AGPL-3.0-only
// The Files tab: the tree with its counts in the diff inks, and a file row opening that one file's diff under itself,
// drawn by the code view the Changes pane draws with, the comments on its lines standing on them. One file is open at
// a time; its head hands the whole branch to the Changes pane.
import { ChevronsDownUpIcon, ChevronsUpDownIcon, FileIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { PullRequestPage } from "@wsp/protocol";
import { ChangedFilesTree } from "../components/chat/ChangedFilesTree.js";
import { DiffStatLabel, hasNonZeroStat } from "../components/chat/DiffStatLabel.js";
import type { TurnDiffFileChange } from "../components/chat/adapt.js";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider.js";
import { AnnotatableCodeView, type DiffLineNote } from "../components/diffs/AnnotatableCodeView.js";
import { Button } from "../components/ui/button.js";
import { diffPanelOptions } from "../diffs/DiffSurface.js";
import { useDiffStore } from "../diffs/store.js";
import { buildFileDiffContentVersion, buildFileDiffIdentityKey, getRenderablePatch, resolveFileDiffPath } from "../lib/diffRendering.js";
import { summarizeTurnDiffStats } from "../lib/turnDiffTree.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { threadsOf, type LineComment } from "./conversation.logic.js";
import { LineCommentRow, type Agent, type SendOf } from "./Conversation.js";
import { Hover } from "./parts.js";
import { PR_WORDS } from "./words.js";

/** The diff a pull request's files open into, as its host gives the whole of it: read once, the first time a file opens. */
export type DiffRead = { state: "reading" } | { state: "read"; patch: string; left: readonly string[] } | { state: "refused"; said: string };

/** The open file's head wears the pane's neutral file glyph, not the viewer's coloured mark for its kind. */
const NEUTRAL_FILE_GLYPH = "[data-diffs-header] [data-change-icon] { display: none !important; }";

/** When a line comment was sent, which its row in the diff says. */
const sentMark = (of: SendOf | undefined, id: number): string => {
  const road = of?.({ kind: "reviewComment", id });
  return road !== undefined && "sent" in road ? String(road.sent) : "";
};

function FileDiff({ path, read, comments, theme, onOpenChanges, agent, of }: { path: string; read: DiffRead; comments: readonly LineComment[]; theme: "light" | "dark"; onOpenChanges: () => void; agent: Agent; of: SendOf | undefined }) {
  const file = useMemo(() => {
    if (read.state !== "read") return undefined;
    const parsed = getRenderablePatch(read.patch, "pr-diff");
    const fileDiff = parsed?.kind === "files" ? parsed.files.find(f => resolveFileDiffPath(f) === path) : undefined;
    return fileDiff === undefined ? undefined : { fileDiff, filePath: path, fileKey: buildFileDiffIdentityKey(fileDiff), fileVersion: buildFileDiffContentVersion(fileDiff), collapsed: false };
  }, [read, path]);
  const notes = useMemo<DiffLineNote[]>(
    () =>
      threadsOf(comments.filter(c => c.path === path && c.line !== undefined)).map(thread => ({
        id: thread.key,
        filePath: path,
        side: thread.comments[0]!.side === "LEFT" ? "deletions" : "additions",
        line: thread.line!,
        version: thread.comments.map(c => `${c.id}:${c.body}:${sentMark(of, c.id)}`).join("|"),
        render: () => (
          <div className="font-sans [&>*:first-child]:border-t-0">
            {thread.comments.map(c => (
              <LineCommentRow key={c.id} comment={c} agent={agent} of={of} />
            ))}
          </div>
        ),
      })),
    [agent, comments, of, path],
  );
  const quiet = (words: string): ReactNode => <p className="px-3 py-2.5 text-[13px] text-muted-foreground">{words}</p>;
  return (
    <div data-pr-file-diff={path} className="mt-1.5 mb-1 overflow-clip rounded-lg border border-border bg-card">
      {read.state === "reading" ? (
        quiet(PR_WORDS.reading)
      ) : read.state === "refused" ? (
        quiet(read.said)
      ) : file === undefined ? (
        quiet(read.left.includes(path) ? PR_WORDS.diffCut : PR_WORDS.noDiff)
      ) : (
        <DiffWorkerPoolProvider theme={theme}>
          <AnnotatableCodeView
            codeViewKey={`pr:${path}`}
            files={[file]}
            sectionId="pull-request"
            sectionTitle={PR_WORDS.tabs.files}
            reviewComments={[]}
            onRemoveReviewComment={() => {}}
            lineNotes={notes}
            options={diffPanelOptions(theme, "stacked")}
            unsafeCSSExtra={NEUTRAL_FILE_GLYPH}
            renderHeaderPrefix={() => <FileIcon aria-hidden data-pr-file-glyph className="size-[13px] shrink-0 text-muted-foreground/70" />}
            renderHeaderMetadata={() => (
              <Button type="button" size="xs" variant="ghost" data-pr-open-changes onClick={onOpenChanges}>
                {PR_WORDS.openInChanges}
              </Button>
            )}
          />
        </DiffWorkerPoolProvider>
      )}
    </div>
  );
}

export function Files({ workspaceId, page, theme, readDiff, read, agent, of }: { workspaceId: string; page: PullRequestPage; theme: "light" | "dark"; readDiff: () => void; read: DiffRead | null; agent: Agent; of: SendOf | undefined }) {
  const [allExpanded, setAllExpanded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const files: TurnDiffFileChange[] = useMemo(() => page.files.map(f => ({ path: f.path, kind: "modified", additions: f.additions, deletions: f.deletions })), [page.files]);
  const setScope = useDiffStore(s => s.setScope);
  const openPanel = useRightPanelStore(s => s.open);
  if (files.length === 0) return <p className="text-[13px] text-muted-foreground">{PR_WORDS.noFiles}</p>;
  const summary = summarizeTurnDiffStats(files);
  const nested = files.some(f => /[/\\]/.test(f.path));
  const press = (path: string): void => {
    setOpen(at => (at === path ? null : path));
    if (read === null) readDiff();
  };
  const openChanges = (): void => {
    setScope(workspaceId, "branch");
    openPanel(workspaceId, "diff");
  };
  const Fold = allExpanded ? ChevronsDownUpIcon : ChevronsUpDownIcon;
  return (
    <div data-pr-files className="flex flex-col gap-4">
      <div className="flex min-h-6 items-center justify-between gap-2 text-[13px]">
        <span className="flex min-w-0 items-center gap-1.5">
          {PR_WORDS.files(files.length)}
          {hasNonZeroStat(summary) ? <DiffStatLabel additions={summary.additions} deletions={summary.deletions} layout="inline" whole className="gap-1.5 text-xs" /> : null}
        </span>
        {nested ? (
          <Hover words={allExpanded ? PR_WORDS.collapseFolders : PR_WORDS.expandFolders}>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={allExpanded ? PR_WORDS.collapseFolders : PR_WORDS.expandFolders} onClick={() => setAllExpanded(v => !v)}>
              <Fold aria-hidden className="size-[15px] text-muted-foreground/70" />
            </Button>
          </Hover>
        ) : null}
      </div>
      <ChangedFilesTree
        files={files}
        look="pane"
        allDirectoriesExpanded={allExpanded}
        resolvedTheme={theme}
        statTone="diff"
        openPath={open ?? undefined}
        onOpenFile={press}
        renderUnderFile={path => (path !== open ? null : <FileDiff path={path} read={read ?? { state: "reading" }} comments={page.reviewComments} theme={theme} onOpenChanges={openChanges} agent={agent} of={of} />)}
      />
    </div>
  );
}
