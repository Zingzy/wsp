// SPDX-License-Identifier: AGPL-3.0-only
// The messages entered while a turn ran, stacked above the composer oldest
// first, one card each: the words, the files the message goes with, the word
// Queued or Next, an edit that puts the message back in the box, and a remove.
// The head card goes when the turn ends; Ctrl+Enter in the box is what sends
// a message now, so no card carries a send of its own. Every card keeps the
// same controls in every state, so nothing shifts as the turn starts or ends.
import { FileTextIcon, PencilIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ComposerFile } from "./composerFiles";
import type { QueuedMessage } from "./composerDraftStore";

function QueuedFile({ file }: { file: ComposerFile }) {
  return (
    <li data-queued-file={file.name} title={file.name} className="flex h-6 max-w-40 items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] pe-2 ps-1 text-xs text-muted-foreground">
      {file.url !== undefined ? <img src={file.url} alt="" className="size-4 shrink-0 rounded-sm object-cover" /> : <FileTextIcon aria-hidden className="size-3.5 shrink-0" />}
      <span className="truncate">{file.name}</span>
    </li>
  );
}

export function ComposerQueue({
  rows,
  files,
  next,
  onEdit,
  onRemove,
}: {
  rows: ReadonlyArray<QueuedMessage>;
  /** Each queued message's files, keyed by its id. */
  files: Readonly<Record<string, ReadonlyArray<ComposerFile>>>;
  /** The card a send-now put at the head while its request is out; null when none. */
  next: string | null;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <ul aria-label="Queued messages" className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1" data-composer-queue="true">
      {rows.map(row => {
        const held = files[row.id] ?? [];
        return (
          <li key={row.id} data-queued-id={row.id} className="flex items-start gap-2 rounded-md border border-border bg-card py-1.5 ps-3 pe-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
              <p data-queued-text className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
                {row.prompt}
              </p>
              {held.length > 0 ? (
                <ul aria-label="Files it goes with" className="flex flex-wrap gap-1">
                  {held.map(file => (
                    <QueuedFile key={file.id} file={file} />
                  ))}
                </ul>
              ) : null}
            </div>
            <span className="w-[6ch] shrink-0 select-none py-0.5 text-end text-xs leading-5 text-muted-foreground">{row.id === next ? "Next" : "Queued"}</span>
            <Button size="icon-xs" variant="ghost-muted" aria-label="Edit queued message" title="Edit queued message" onClick={() => onEdit(row.id)}>
              <PencilIcon />
            </Button>
            <Button size="icon-xs" variant="ghost-muted" aria-label="Remove queued message" title="Remove queued message" onClick={() => onRemove(row.id)}>
              <XIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
