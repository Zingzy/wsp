// SPDX-License-Identifier: AGPL-3.0-only
// The three pieces both Add a computer and Connect a provider are drawn from:
// a row holding one fact with the glyph that copies it, the running list of
// what a road has done so far, and the two-line slot a refusal lands in. The
// slot stands whether or not it holds a sentence, so a refusal arriving moves
// nothing on the screen under it.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { copyText } from "../actions/clipboard.js";
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { cn } from "../lib/utils.js";
import { STATE_WORD } from "../sidebar/cloud-setup/rows.js";

/** How long the copy glyph stands as a check before it is a copy glyph again. */
const COPIED_MS = 1_400;

/** How wide a copy row's label column stands, so the values under each other line up whatever their labels are:
 * wide enough for ADDRESS, the longest, at 11 px caps with the tracking the label wears. */
const LABEL_WIDTH = "w-14";

/** A fact somebody has to type on another computer: its label in a fixed column, the fact in mono, and the glyph
 * that copies it. The code wears the big size, since it is read off one screen and typed on another. */
export function CopyRow({ label, value, big = false, k, children }: { label?: string; value: string; big?: boolean; k: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void copyText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {},
    );
  };
  return (
    <div data-copy-row={k} className="flex h-10 w-full items-center gap-3 rounded-md border border-border bg-card px-3">
      {label === undefined ? null : (
        <span className={cn(LABEL_WIDTH, "shrink-0 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground")}>{label}</span>
      )}
      {/* The name is on the value, not the row: a reader after the fact alone must not also get the label. */}
      <span data-k={k} className={cn("min-w-0 flex-1 truncate font-mono tabular-nums text-foreground", big ? "text-xl tracking-[0.18em]" : "text-xs")} title={value}>
        {value}
      </span>
      {children}
      <Button variant="ghost-muted" size="icon-xs" aria-label={`Copy the ${(label ?? "line").toLowerCase()}`} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** One line of what a road has done: the words at the left, and at the right end the spinner while it runs, a check
 * once it is done, or a quiet word where the line carries one. */
export interface RoadLine {
  word: string;
  state: "running" | "done" | "waiting";
  /** The figure or the word at the right end: how long a stage took, or that a line is not required. */
  fact?: string;
}

/** The list of lines under a road, one 32 px line each, in the order they happened. A line longer than the sheet is
 * cut from the right and carries the whole of itself as its hover text. */
export function RoadLines({ lines, k = "lines" }: { lines: readonly RoadLine[]; k?: string }) {
  return (
    <ul data-k={k} className="flex flex-col">
      {lines.map(line => (
        <li key={line.word} data-k="line" data-state={line.state} className="flex h-8 items-center gap-3 border-border/60 border-b last:border-transparent">
          <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", line.state === "waiting" ? "text-muted-foreground" : "text-foreground")} title={line.word}>
            {line.word}
          </span>
          {line.fact === undefined ? null : <span className={STATE_WORD}>{line.fact}</span>}
          {line.state === "running" ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          {line.state === "done" ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The slot under a field a refusal lands in: two lines at 12 px mono, standing at that height whether or not it
 * holds one. What happened is in the destructive ink; what to do about it follows in the foreground's. */
export function RefusalSlot({ k, said, fix, children }: { k: string; said?: string; fix?: string; children?: ReactNode }) {
  return (
    <p data-k={k} className="min-h-9 break-words font-mono text-xs leading-[18px] text-destructive-foreground">
      {said ?? ""}
      {fix === undefined ? null : <span className="text-foreground"> {fix}</span>}
      {children}
    </p>
  );
}
