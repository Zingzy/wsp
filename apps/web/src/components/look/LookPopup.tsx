// SPDX-License-Identifier: AGPL-3.0-only
// The popover both pickers sit in, anchored to the space icon or the row the
// menu was opened on: the fact's word as a caps mono heading with the
// workspace's name beside it in the meta voice, then the picker's own rows.
import type { ReactNode } from "react";
import { ROW_META_CLASS } from "../../sidebar/rowGrammar.js";
import { Popover, PopoverPopup } from "../ui/popover.js";

export function LookPopup({ title, name, anchor, onClose, children, ...marks }: { title: string; name: string; anchor: HTMLElement | null; onClose: () => void; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <Popover
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <PopoverPopup anchor={anchor} side="top" align="start" className="w-72" viewportClassName="flex flex-col gap-3 py-3 [--viewport-inline-padding:--spacing(3)]" role="dialog" aria-label={`${title}: ${name}`} {...marks}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
          <span className={`${ROW_META_CLASS} min-w-0 truncate`}>{name}</span>
        </div>
        {children}
      </PopoverPopup>
    </Popover>
  );
}
