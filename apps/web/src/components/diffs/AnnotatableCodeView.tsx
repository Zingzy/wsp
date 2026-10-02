// Adapted from pingdotgg/t3code apps/web/src/components/diffs/AnnotatableCodeView.tsx at 57a66608 (MIT).
import type {
  AnnotationSide,
  CodeViewCreateEditorOptions,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileContents,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useMemo, useState, type ReactNode, type Ref } from "react";

import { fnv1a32 } from "../../lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

import { nextFileCommentId } from "../files/fileCommentAnnotations";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment" | "note";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
  render?: () => ReactNode;
}

/** A comment written elsewhere, a pull request's on its host, standing on its line; its owner draws it. */
export interface DiffLineNote {
  readonly id: string;
  readonly filePath: string;
  readonly side: AnnotationSide;
  readonly line: number;
  /** What the drawing reads, so the view draws it again when it moves. */
  readonly version: string;
  readonly render: () => ReactNode;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup>;

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  sectionId: string;
  sectionTitle: string;
  /** Comments already taken for this view; the owner keeps them wherever it likes. */
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  /** Absent where nothing is written here: no line takes a new comment. */
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment: (commentId: string) => void;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  /** What a file's header carries at its right end, beside the line counts. */
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata, fileKey: string) => ReactNode;
  /** The files open in the editor, by key: their new side is edited in place. */
  editing?: ReadonlySet<string>;
  /** Every change to a file open in the editor, with its whole new contents. */
  onEditChange?: (fileKey: string, contents: string) => void;
  /** Comments already on the lines, read from elsewhere and drawn by the owner. */
  lineNotes?: ReadonlyArray<DiffLineNote>;
  /** Appended to the viewer's own stylesheet, for chrome the viewer draws that an owner restyles. */
  unsafeCSSExtra?: string;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  codeViewKey,
  files,
  sectionId,
  sectionTitle,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
  options,
  viewerRef,
  className,
  renderHeaderPrefix,
  renderHeaderMetadata,
  editing,
  onEditChange,
  lineNotes,
  unsafeCSSExtra,
}: AnnotatableCodeViewProps) {
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<{
    fileKey: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const [draftText, setDraftText] = useState("");

  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);
  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(
    () =>
      files.map(({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
        const persisted = reviewComments
          .filter(
            (comment) =>
              comment.sectionId === sectionId &&
              comment.filePath === filePath &&
              (comment.fenceLanguage ?? "diff") === "diff",
          )
          .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
            const range = restoreDiffReviewCommentRange(fileDiff, comment);
            if (!range) return annotations;
            return appendAnnotationEntry(annotations, range, {
              id: comment.id,
              kind: "comment",
              range,
              rangeLabel: comment.rangeLabel,
              text: comment.text,
            });
          }, []);
        const noted = (lineNotes ?? [])
          .filter((note) => note.filePath === filePath)
          .reduce<DiffCommentLineAnnotation[]>((annotations, note) => {
            const range: SelectedLineRange = { start: note.line, end: note.line, side: note.side };
            return appendAnnotationEntry(annotations, range, { id: note.id, kind: "note", range, rangeLabel: String(note.line), text: note.version, render: note.render });
          }, persisted);
        const annotations =
          draft?.fileKey === fileKey ? [...noted, draft.annotation] : noted;
        const edit = editing?.has(fileKey) === true;
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          ...(edit ? { edit: true } : {}),
          version: fnv1a32(
            `${fileVersion}:${collapsed ? "1" : "0"}:${edit ? "e" : ""}:${annotations
              .flatMap((annotation) =>
                annotation.metadata.entries.map(
                  (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
                ),
              )
              .join(":")}`,
          ),
        };
      }),
    [draft, editing, files, lineNotes, reviewComments, sectionId],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      setSelectedLines(null);
      if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
        setDraft(null);
        setDraftText("");
      } else {
        onRemoveReviewComment(entryId);
      }
    },
    [draft, onRemoveReviewComment],
  );

  const submitEntry = useCallback(
    (entryId: string, text: string) => {
      const entry = draft?.annotation.metadata.entries.find(
        (candidate) => candidate.id === entryId,
      );
      const file = draft ? filesByKey.get(draft.fileKey) : undefined;
      if (!entry || !file) return;
      const comment = buildDiffReviewComment({
        id: entry.id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range: entry.range,
        text,
      });
      if (comment) onAddReviewComment?.(comment);
      setSelectedLines(null);
      setDraft(null);
      setDraftText("");
    },
    [draft, filesByKey, onAddReviewComment, sectionId, sectionTitle],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      if (!range) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = filesByKey.get(item.id);
      if (!file) return;
      const id = nextFileCommentId();
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range,
        text: "",
      });
      if (!comment) return;
      setDraftText("");
      setDraft({
        fileKey: item.id,
        annotation: {
          side: annotationSide(range),
          lineNumber: range.end,
          metadata: {
            entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
          },
        },
      });
    },
    [filesByKey, sectionId, sectionTitle],
  );

  const hasOpenComment = draft !== null;
  return (
    <StyledDiffCodeView<DiffCommentAnnotationGroup>
      key={codeViewKey}
      {...(viewerRef ? { viewerRef } : {})}
      {...(className ? { className } : {})}
      {...(unsafeCSSExtra !== undefined ? { unsafeCSSExtra } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      options={{
        ...options,
        enableGutterUtility: onAddReviewComment !== undefined && !hasOpenComment,
        enableLineSelection: onAddReviewComment !== undefined && !hasOpenComment,
        onGutterUtilityClick: beginComment,
      }}
      {...(onEditChange !== undefined
        ? {
            createEditor: (editorOptions: CodeViewCreateEditorOptions<DiffCommentAnnotationGroup>) => new Editor(editorOptions),
            onItemEditChange: (item: CodeViewItem<DiffCommentAnnotationGroup>, file: FileContents) => onEditChange(item.id, file.contents),
          }
        : {})}
      {...(renderHeaderMetadata !== undefined
        ? { renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) => (item.type === "diff" ? renderHeaderMetadata(item.fileDiff, item.id) : null) }
        : {})}
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderAnnotation={(annotation) => {
        const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
        return (
          <div
            className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
          >
            {annotation.metadata.entries.map((entry) => entry.kind === "note" ? (
              <div key={entry.id}>{entry.render?.()}</div>
            ) : (
              <DiffCommentAnnotation
                key={entry.id}
                kind={entry.kind}
                rangeLabel={entry.rangeLabel}
                text={entry.kind === "draft" ? draftText : entry.text}
                onTextChange={setDraftText}
                onCancel={() => removeEntry(entry.id)}
                onComment={(text) => submitEntry(entry.id, text)}
                onDelete={() => removeEntry(entry.id)}
              />
            ))}
          </div>
        );
      }}
    />
  );
}
