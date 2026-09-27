// SPDX-License-Identifier: AGPL-3.0-only
// The pick of times a thread's snooze runs until: one line per preset, pressed
// to snooze at once, and a time of the person's own under them, held until it
// names a moment still to come.
import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogFooter, DialogHeader, DialogLine, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { THREAD_WORDS } from "../actions/format.js";
import { datetimeLocalValue, resolveCustomSnooze, resolveSnoozePresets } from "./snooze.js";
import { SNOOZE_WORDS } from "./words.js";

export function SnoozeDialog({ onSnooze, onCancel }: { onSnooze: (until: number) => void; onCancel: () => void }) {
  const now = useMemo(() => new Date(), []);
  const presets = useMemo(() => resolveSnoozePresets(now), [now]);
  const [custom, setCustom] = useState(() => datetimeLocalValue(presets[0]!.snoozedUntil));
  const until = resolveCustomSnooze(custom, new Date());
  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      <DialogPopup className="sm:row-start-1 sm:mt-36 sm:max-h-[calc(100dvh-11rem)] sm:self-start">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={e => {
            e.preventDefault();
            if (until !== null) onSnooze(until);
          }}
        >
          <DialogHeader>
            <DialogTitle>{THREAD_WORDS.snooze}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="pt-1 pb-0">
            {presets.map(preset => (
              <button
                key={preset.id}
                type="button"
                data-snooze-preset={preset.id}
                onClick={() => onSnooze(preset.snoozedUntil)}
                className="-mx-2 flex h-11 w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-[var(--control-radius)] px-2 text-left text-sm text-foreground outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{preset.label}</span>
                <span className="text-[13px] text-muted-foreground tabular-nums">{preset.whenLabel}</span>
              </button>
            ))}
            <DialogLine>
              <Label htmlFor="snooze-custom" className="shrink-0">
                {SNOOZE_WORDS.custom}
              </Label>
              <Input id="snooze-custom" nativeInput type="datetime-local" className="w-56" value={custom} onChange={e => setCustom(e.target.value)} />
            </DialogLine>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-k="snooze" held={until === null}>
              {SNOOZE_WORDS.snooze}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
