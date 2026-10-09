// SPDX-License-Identifier: AGPL-3.0-only
// The messages entered while a turn ran, in the composer's place: how many
// wait, then a card of them oldest first, each named by its message with the
// files it goes with under it, and its Edit, which puts it back in the
// composer, and its Cancel, which takes it off the queue. A message goes now
// only where the person picked steer, so nothing here carries a send.
import { MessageSquareTextIcon } from "lucide-react";
import { Grid } from "../../../settings/grid";
import { GLYPH } from "../../../settings/layout";
import { Row } from "../../../settings/rows";
import { Button } from "../../ui/button";
import { DRAWER_WORDS } from "../ComposerDrawer";
import { Dock, DockBack } from "../Dock";
import { foldBar, useBarRoot } from "../composerBar";
import type { QueuedMessage } from "../composerDraftStore";
import type { ComposerFile } from "../composerFiles";

/** Every word the queue says. */
export const QUEUE_WORDS = {
  waiting: (count: number): string => (count === 1 ? "1 message waiting" : `${count} messages waiting`),
  /** The message a steer took, while its send is out. */
  sending: "Sending now",
  edit: "Edit",
  editLabel: "Edit queued message",
  cancel: "Cancel",
  cancelLabel: "Cancel queued message",
} as const;

/** A message as one line: its first line with words on it. */
export const firstLine = (prompt: string): string => prompt.split("\n").find(line => line.trim() !== "") ?? "";

export function QueueBar({
  rows,
  files,
  threadKey,
  workspaceId,
  onEdit,
  onRemove,
}: {
  rows: ReadonlyArray<QueuedMessage>;
  /** Each queued message's files, keyed by its id. */
  files: Readonly<Record<string, ReadonlyArray<ComposerFile>>>;
  threadKey: string;
  workspaceId: string;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const barRoot = useBarRoot(threadKey, workspaceId);
  return (
    <Dock
      {...barRoot}
      shell={{ "data-composer-bar": "queue" }}
      mark={<MessageSquareTextIcon aria-hidden className={GLYPH} />}
      title={QUEUE_WORDS.waiting(rows.length)}
      back={<DockBack word={DRAWER_WORDS.write} onClick={() => foldBar(threadKey, workspaceId)} />}
    >
      <Grid id="composer-queue">
        {rows.map(row => (
          <Row
            key={row.id}
            id={row.id}
            title={firstLine(row.prompt)}
            description={(files[row.id] ?? []).map(file => file.name)}
            attrs={{ "data-queued-id": row.id }}
            control={
              <span className="flex shrink-0 items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={QUEUE_WORDS.editLabel}
                  onClick={() => {
                    onEdit(row.id);
                    foldBar(threadKey, workspaceId);
                  }}
                >
                  {QUEUE_WORDS.edit}
                </Button>
                <Button size="xs" variant="outline" aria-label={QUEUE_WORDS.cancelLabel} onClick={() => onRemove(row.id)}>
                  {QUEUE_WORDS.cancel}
                </Button>
              </span>
            }
          />
        ))}
      </Grid>
    </Dock>
  );
}
