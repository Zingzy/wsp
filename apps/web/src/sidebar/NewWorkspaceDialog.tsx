// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog: a name with a default and one choice, start
// fresh or import a project from this Mac once the machine is up. Enter
// creates, Escape cancels. The parent keys this component per opening so
// the initial name resets; a refusal shows on the creation view, not here.
import { useState } from "react";
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
import { Radio, RadioGroup } from "../components/ui/radio-group.js";

export type WorkspaceStart = "fresh" | "import";

const STARTS: ReadonlyArray<{ value: WorkspaceStart; label: string; detail: string }> = [
  { value: "fresh", label: "Start fresh", detail: "Nothing on the machine but your golden image." },
  { value: "import", label: "Import a project", detail: "Then pick a folder on this Mac; it lands at the same path, caches left behind." },
];

const isStart = (value: unknown): value is WorkspaceStart => value === "fresh" || value === "import";

export function NewWorkspaceDialog({
  initialName,
  onCreate,
  onCancel,
}: {
  initialName: string;
  onCreate: (name: string, start: WorkspaceStart) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [start, setStart] = useState<WorkspaceStart>("fresh");
  const trimmed = name.trim();
  const submit = (): void => {
    if (trimmed.length > 0) onCreate(trimmed, start);
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
          <DialogPanel className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
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
            </div>
            <RadioGroup aria-label="Start from" className="gap-2" value={start} onValueChange={value => { if (isStart(value)) setStart(value); }}>
              {STARTS.map(s => (
                <label key={s.value} className="flex h-9 cursor-pointer items-center gap-2.5 text-sm">
                  <Radio value={s.value} />
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="text-foreground">{s.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground" title={s.detail}>
                      {s.detail}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
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
