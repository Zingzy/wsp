// SPDX-License-Identifier: AGPL-3.0-only
// The controls one changed file carries, in the tree's row and in the file's own header: the edit or its save, the
// discard and the viewed tick. One component with a slot for what a later pane adds to a file's row, so a review's
// "Send to agent" sits beside these rather than in a second row of its own.
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { cn } from "../lib/utils.js";
import { DISCARD_WORDS, EDIT_WORDS, VIEWED_WORDS } from "./words.js";

/** A file's edit as the header draws it: offered, or open with its save and its way out. */
export type EditControl = { readonly kind: "offer"; readonly onEdit: () => void } | { readonly kind: "open"; readonly onSave: () => void; readonly onCancel: () => void; readonly saving: boolean };

export function FileControls({
  name,
  viewed,
  onViewed,
  onDiscard,
  edit,
  children,
  className,
}: {
  /** The file's own name, which every control's label says. */
  name: string;
  /** Whether the file is marked viewed; absent where it cannot be, a file that is gone. */
  viewed?: boolean | undefined;
  onViewed?: (() => void) | undefined;
  onDiscard?: (() => void) | undefined;
  edit?: EditControl | undefined;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)} data-file-controls>
      {children}
      {edit?.kind === "offer" ? (
        <Button type="button" size="icon-micro" variant="ghost-muted" aria-label={EDIT_WORDS.edit(name)} onClick={event => (event.stopPropagation(), edit.onEdit())}>
          <PencilIcon className="size-3.5" />
        </Button>
      ) : null}
      {edit?.kind === "open" ? (
        <>
          <Button type="button" size="icon-micro" variant="ghost-muted" disabled={edit.saving} aria-label={EDIT_WORDS.save(name)} onClick={event => (event.stopPropagation(), edit.onSave())}>
            <CheckIcon className="size-3.5" />
          </Button>
          <Button type="button" size="icon-micro" variant="ghost-muted" disabled={edit.saving} aria-label={EDIT_WORDS.cancel(name)} onClick={event => (event.stopPropagation(), edit.onCancel())}>
            <XIcon className="size-3.5" />
          </Button>
        </>
      ) : null}
      {onDiscard === undefined ? null : (
        <Button type="button" size="icon-micro" variant="ghost-muted" className="hover:text-destructive-foreground" aria-label={DISCARD_WORDS.control(name)} onClick={event => (event.stopPropagation(), onDiscard())}>
          <Trash2Icon className="size-3.5" />
        </Button>
      )}
      {viewed === undefined || onViewed === undefined ? null : (
        <Checkbox checked={viewed} onCheckedChange={() => onViewed()} onClick={event => event.stopPropagation()} aria-label={VIEWED_WORDS.tick(name)} data-viewed-tick className="ms-1" />
      )}
    </span>
  );
}
