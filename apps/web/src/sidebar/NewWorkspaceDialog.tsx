// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog: a name with a default, Enter creates, Escape
// cancels, and a refusal comes back inline with the name kept. The parent
// keys this component per opening so the initial name resets.
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { useState } from "react";
import type { CreateRefusal } from "./workspaceRows.js";

export function NewWorkspaceDialog({
  initialName,
  error,
  onCreate,
  onCancel,
}: {
  initialName: string;
  error: CreateRefusal | null;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const submit = (): void => {
    if (trimmed.length > 0) onCreate(trimmed);
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>A fresh machine forked from your golden image.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-2">
            <Label htmlFor="new-workspace-name">Name</Label>
            <Input
              id="new-workspace-name"
              nativeInput
              autoFocus
              autoComplete="off"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />
            {error ? (
              <div role="alert" className="rounded-lg border border-destructive/36 bg-destructive/6 px-3 py-2 text-sm">
                <p className="font-medium text-destructive-foreground">{error.title}</p>
                <p className="text-muted-foreground">{error.detail}</p>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
