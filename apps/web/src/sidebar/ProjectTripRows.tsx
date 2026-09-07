// SPDX-License-Identifier: AGPL-3.0-only
// The rows both project dialogs are built from: a section of the one container
// with its small label and the hairline above it, a labelled mono path input
// with the desktop shell's folder picker beside it when there is one, the
// desktop's picker row, a fact row with its value flush right, a row the
// person ticks, the fixed list of step rows the runtime's events fill, and the
// one slot above the footer that reads the step under way, the refusal or the
// landed line over a thin bar. Every row is one height so nothing moves
// between states; only the slot's words may grow, since a refusal or a landed
// line is never cut.
import type { KeyboardEvent, ReactNode } from "react";
import { FolderIcon } from "lucide-react";
import { durationLabel } from "../components/machine/format.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { cn } from "../lib/utils.js";
import type { StatusTone, StepRow } from "./projectTrip.js";

const SECTION_LABEL = "text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground";

/** One section of the dialog's single container: its label, and a hairline above it unless it opens the container. */
export function TripSection({ k, label, htmlFor, children }: { k: string; label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <section data-k={k} className="flex flex-col gap-1.5 border-t border-border/50 py-3 first:border-t-0 first:pt-0">
      {htmlFor === undefined ? (
        <p className={cn("font-mono", SECTION_LABEL)}>{label}</p>
      ) : (
        <Label htmlFor={htmlFor} className={cn("font-mono", SECTION_LABEL)}>
          {label}
        </Label>
      )}
      {children}
    </section>
  );
}

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
  /** The field's own label; absent when the section around it carries one. */
  label?: string;
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
  const field = (
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
  );
  if (label === undefined) return field;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className={SECTION_LABEL}>
        {label}
      </Label>
      {field}
    </div>
  );
}

/** The folder as the desktop shell's picker gave it: the glyph, the path in mono, and the one key that changes it. */
export function FolderPickerRow({ path, placeholder, disabled, onPick }: { path: string; placeholder: string; disabled: boolean; onPick: () => void }) {
  const empty = path === "";
  return (
    <div className="flex h-8 items-center gap-2">
      <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span data-k="path" className={cn("min-w-0 flex-1 truncate font-mono text-xs", empty ? "text-muted-foreground" : "text-foreground")} title={empty ? undefined : path}>
        {empty ? placeholder : path}
      </span>
      <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disabled} onClick={onPick}>
        {empty ? "Choose folder" : "Change"}
      </Button>
    </div>
  );
}

/** A fact with its value flush right; a value that is a number or a path is mono, prose is not, and either is cut with
 * an ellipsis and rides its title whole. */
export function FactRow({ label, k, title, mono = true, children }: { label: string; k: string; title?: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn("min-w-0 truncate text-right text-foreground", mono && "font-mono tabular-nums")}
        title={title ?? (typeof children === "string" ? children : undefined)}
        data-k={k}
      >
        {children}
      </span>
    </div>
  );
}

/** A row the person ticks: the tick in the neutral ramp, what it is, and whatever words the trip gives its tick. */
export function ConsentRow({
  label,
  mono,
  checked,
  disabled,
  title,
  onToggle,
  children,
}: {
  /** What the row is, its own name for a screen reader and the first thing it shows. */
  label: string;
  mono: boolean;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onToggle: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <li className="flex h-7 items-center gap-2 text-xs" {...(title === undefined ? {} : { title })}>
      <Checkbox tone="neutral" checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onToggle} />
      <span className={cn("shrink-0 truncate text-foreground", mono && "max-w-[45%] font-mono")}>{label}</span>
      {children}
    </li>
  );
}

/** How far a transfer has come, 0 to 1, as a thin bar. */
function Bar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(fraction * 100);
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="block h-1 w-full overflow-hidden rounded-full bg-border">
      <span className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </span>
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
          <span className="w-16 shrink-0">{r.fraction !== null ? <Bar fraction={r.fraction} label={transfer} /> : null}</span>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{r.elapsedMs === null ? "" : durationLabel(r.elapsedMs)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The one slot above the footer: what the trip has to say right now over a thin bar. Empty at rest, its height
 * always taken so nothing moves when the trip starts. The words are a step under way in muted mono, a quiet landed
 * line, the caution colour for a refusal that asks for a replace, the error colour for one that does not. Two lines
 * of the row's height and never cut: a sentence wraps into the second line, an unbroken path breaks where it must,
 * and a third line grows the box rather than being clipped. The bar, when there is one, is labelled by the words. */
export function TripStatus({ tone, fraction, children }: { tone: StatusTone; fraction: number | null; children: string }) {
  return (
    <div data-k="progress" className="flex flex-col gap-1.5">
      <p
        role="status"
        data-k="progress-line"
        className={cn(
          "min-h-7 break-words text-[11px] leading-[14px]",
          tone === "step" ? "font-mono text-muted-foreground" : tone === "quiet" ? "text-muted-foreground" : tone === "caution" ? "text-warning-foreground" : "text-destructive-foreground",
        )}
        title={children}
      >
        {children}
      </p>
      <div className="h-1 w-full">{fraction === null ? null : <Bar fraction={fraction} label={children} />}</div>
    </div>
  );
}
