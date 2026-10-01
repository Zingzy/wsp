// SPDX-License-Identifier: AGPL-3.0-only
// The messages entered while a turn ran, as one quiet row above the composer:
// how many wait, the first line of the one that goes next, and for one message
// an Edit that puts it back in the box and a Cancel that takes it off the
// queue. Several open to the list, oldest first, each with its own Edit and
// Cancel. The head goes when the turn ends; Ctrl+Enter in the box is what sends
// a message now, so nothing here carries a send of its own.
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import type { ComposerFile } from "./composerFiles";
import type { QueuedMessage } from "./composerDraftStore";

/** Every word the queue says. */
export const QUEUE_WORDS = {
  waiting: (count: number): string => (count === 1 ? "1 message waiting" : `${count} messages waiting`),
  /** The message a Ctrl+Enter took, while its send is out. */
  sending: "Sending now",
  edit: "Edit",
  editLabel: "Edit queued message",
  cancel: "Cancel",
  cancelLabel: "Cancel queued message",
  list: "Queued messages",
  files: "Files it goes with",
} as const;

const firstLine = (prompt: string): string => prompt.split("\n").find(line => line.trim() !== "") ?? "";

function QueuedFile({ file }: { file: ComposerFile }) {
  return (
    <li data-queued-file={file.name} title={file.name} className="flex h-5 min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {file.url !== undefined ? <img src={file.url} alt="" className="size-4 shrink-0 rounded-sm object-cover" /> : <FileTextIcon aria-hidden className="size-3.5 shrink-0" />}
      <span className="truncate max-sm:sr-only">{file.name}</span>
    </li>
  );
}

/** One message: its first line, its files, and its Edit and Cancel. `word` leads the row where it stands alone. */
function QueuedRow({ row, files, word, onEdit, onRemove }: { row: QueuedMessage; files: ReadonlyArray<ComposerFile>; word?: ReactNode; onEdit: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <li data-queued-id={row.id} className="flex min-h-8 items-center gap-3 ps-3 pe-1 text-[13px] leading-5">
      {word}
      <span data-queued-text className="min-w-16 flex-1 truncate text-muted-foreground" title={row.prompt}>
        {firstLine(row.prompt)}
      </span>
      {files.length > 0 ? (
        <ul aria-label={QUEUE_WORDS.files} className="flex min-w-0 max-w-[40%] shrink-[2] gap-2">
          {files.map(file => (
            <QueuedFile key={file.id} file={file} />
          ))}
        </ul>
      ) : null}
      <span className="flex shrink-0 items-center">
        <Button size="xs" variant="ghost" aria-label={QUEUE_WORDS.editLabel} onClick={() => onEdit(row.id)}>
          {QUEUE_WORDS.edit}
        </Button>
        <Button size="xs" variant="ghost" aria-label={QUEUE_WORDS.cancelLabel} onClick={() => onRemove(row.id)}>
          {QUEUE_WORDS.cancel}
        </Button>
      </span>
    </li>
  );
}

export function ComposerQueue({
  rows,
  files,
  next,
  waiting,
  onEdit,
  onRemove,
}: {
  rows: ReadonlyArray<QueuedMessage>;
  /** Each queued message's files, keyed by its id. */
  files: Readonly<Record<string, ReadonlyArray<ComposerFile>>>;
  /** The message a send-now put at the head while its request is out; null when none. */
  next: string | null;
  /** Why every message waits while the workspace is still being made, on the count's hover; null once it is up. */
  waiting: string | null;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const head = rows[0];
  if (head === undefined) return null;
  const word = (
    <span data-queued-word title={waiting ?? undefined} className="shrink-0 select-none text-foreground">
      {head.id === next ? QUEUE_WORDS.sending : QUEUE_WORDS.waiting(rows.length)}
    </span>
  );
  if (rows.length === 1) {
    return (
      <ul aria-label={QUEUE_WORDS.list} className="mx-auto mb-1 w-full max-w-3xl" data-composer-queue="true">
        <QueuedRow row={head} files={files[head.id] ?? []} word={word} onEdit={onEdit} onRemove={onRemove} />
      </ul>
    );
  }
  return (
    <details className="group/queue mx-auto mb-1 w-full max-w-3xl" data-composer-queue="true">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-3 rounded-lg ps-3 pe-3 text-[13px] leading-5 transition-colors duration-150 hover:bg-accent [&::-webkit-details-marker]:hidden">
        {word}
        <span data-queued-head className="min-w-0 flex-1 truncate text-muted-foreground group-open/queue:invisible">
          {firstLine(head.prompt)}
        </span>
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open/queue:rotate-90" />
      </summary>
      <ul aria-label={QUEUE_WORDS.list} className="flex flex-col">
        {rows.map(row => (
          <QueuedRow key={row.id} row={row} files={files[row.id] ?? []} onEdit={onEdit} onRemove={onRemove} />
        ))}
      </ul>
    </details>
  );
}
