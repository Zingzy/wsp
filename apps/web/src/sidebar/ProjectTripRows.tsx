// SPDX-License-Identifier: AGPL-3.0-only
// The rows both project dialogs are built from: a labelled mono path input
// with the desktop shell's folder picker beside it when there is one, a fact
// row with its value flush right in mono, and the fixed list of step rows the
// runtime's events fill, and the status line under them. Every row is one
// height so nothing moves between states; only the status line may grow, since
// a refusal or a landed line is never cut.
import type { KeyboardEvent, ReactNode } from "react";
import { durationLabel } from "../components/machine/format.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { cn } from "../lib/utils.js";
import type { StatusTone, StepRow } from "./projectTrip.js";

export function FolderField({
  id,
  label,
  value,
  placeholder,
  disabled,
  autoFocus,
  onChange,
  onEnter,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
  onChange: (next: string) => void;
  onEnter?: () => void;
  /** Opens the system picker; absent in a browser tab, where the input stands alone. */
  onPick?: () => void;
}) {
  const keyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && onEnter !== undefined) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          nativeInput
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          onKeyDown={keyDown}
        />
        {onPick === undefined ? null : (
          <Button type="button" variant="outline" size="sm" className="w-28 shrink-0" disabled={disabled} onClick={onPick}>
            Choose folder
          </Button>
        )}
      </div>
    </div>
  );
}

/** A fact with its value flush right in mono; the value is cut with an ellipsis and rides its title whole. */
export function FactRow({ label, k, title, children }: { label: string; k: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono tabular-nums text-foreground" title={title ?? (typeof children === "string" ? children : undefined)} data-k={k}>
        {children}
      </span>
    </div>
  );
}

export function StepRows({ label, transfer, rows }: { label: string; transfer: string; rows: readonly StepRow[] }) {
  return (
    <ol aria-label={label} className="divide-y divide-border/40 rounded-md border border-border/60 px-2.5">
      {rows.map(r => (
        <li key={r.stage} data-step={r.stage} className="flex h-7 items-center gap-3 text-xs">
          <span data-k="step-label" className={cn("w-[5.5rem] shrink-0 font-mono text-[11px] uppercase tracking-wider", r.message === null ? "text-muted-foreground" : "text-foreground")}>{r.stage}</span>
          <span className="min-w-0 flex-1 truncate text-foreground" title={r.message ?? undefined}>
            {r.message ?? ""}
          </span>
          <span className="w-16 shrink-0">
            {r.fraction !== null ? (
              <span role="progressbar" aria-label={transfer} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.fraction * 100)} className="block h-1 w-full overflow-hidden rounded-full bg-border">
                <span className="block h-full bg-foreground/70" style={{ width: `${Math.round(r.fraction * 100)}%` }} />
              </span>
            ) : null}
          </span>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{r.elapsedMs === null ? "" : durationLabel(r.elapsedMs)}</span>
        </li>
      ))}
    </ol>
  );
}

/** What the trip has to say right now: quiet while it runs or has landed, the caution colour for a refusal that asks for a
 * replace, the error colour for one that does not. Two lines of the row's height and never cut: a sentence wraps into
 * the second line, an unbroken path breaks where it must, and a third line grows the box rather than being clipped. */
export function StatusLine({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <p role="status" className={cn("min-h-7 break-words text-[11px] leading-[14px]", tone === "quiet" ? "text-muted-foreground" : tone === "caution" ? "text-warning-foreground" : "text-destructive-foreground")} title={children}>
      {children}
    </p>
  );
}
