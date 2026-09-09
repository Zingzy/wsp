// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar every screen of the cloud setup modal is drawn in: a caps
// mono micro-label with the screen's counter beside it, one headline, one
// muted subline at most, the body in one bordered card of rows one height
// each, then one primary keycap and a text link under it. State is a muted
// mono word, never a chip; nothing moves at rest.
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";

export const MICRO_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
export const STATE_WORD = "shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground";
export const CARD = "w-full rounded-md border border-border/60";
export const ROW = "flex h-9 items-center gap-3 px-3";
export const ROW_LINE = "border-t border-border/50 first:border-t-0";

export function SetupFrame({
  k,
  label,
  counter,
  headline,
  top,
  children,
  primary,
  secondary,
  refusal = null,
}: {
  k: string;
  label: string;
  counter?: string;
  headline: string;
  top?: string;
  children?: ReactNode;
  /** The one keycap; absent while the screen has nothing to press. It takes focus as its screen appears, so Enter
   * advances, unless the screen has a field to type in first. */
  primary?: { word: string; onPress: () => void; disabled?: boolean; focus?: boolean };
  secondary?: { word: string; onPress: () => void };
  /** The host's word for what it refused, under the keycap, so a press that did nothing says why. */
  refusal?: string | null;
}) {
  return (
    <div data-k={k} className="flex w-full flex-col items-center gap-4 px-6 pt-6 pb-5">
      <div className="flex items-center gap-3">
        <p className={MICRO_LABEL}>{label}</p>
        {counter !== undefined ? (
          <span data-k="counter" className={MICRO_LABEL}>
            {counter}
          </span>
        ) : null}
      </div>
      <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">{headline}</h2>
      {top !== undefined ? <p className="max-w-md text-center text-sm text-muted-foreground">{top}</p> : null}
      {children !== undefined ? <div className="w-full">{children}</div> : null}
      {primary !== undefined || secondary !== undefined ? (
        <div className="flex flex-col items-center gap-2 pt-1">
          {primary !== undefined ? (
            <Button data-k="primary" autoFocus={primary.focus !== false} onClick={primary.onPress} disabled={primary.disabled === true}>
              {primary.word}
              <span aria-hidden>→</span>
            </Button>
          ) : null}
          {secondary !== undefined ? (
            <Button data-k="secondary" variant="link" size="sm" className="text-muted-foreground" onClick={secondary.onPress}>
              {secondary.word}
            </Button>
          ) : null}
        </div>
      ) : null}
      {refusal !== null ? (
        <p data-k="refusal" className="max-w-md break-words text-center font-mono text-[11px] text-warning-foreground">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}

/** A section's caps label inside the card, over its rows. */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(MICRO_LABEL, "px-3 pt-3 pb-1", className)}>{children}</p>;
}
