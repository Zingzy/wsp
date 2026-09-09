// SPDX-License-Identifier: AGPL-3.0-only
// The one layout every step of the cloud setup is drawn in, the first launch's
// grammar at the first launch's numbers, in three bands: the head (a caps mono
// label, the title, one sentence when the step has one), a middle that scrolls
// inside itself, and a footer pinned inside the window with the primary and a
// text link. The column is 560 px, 96 px under the window's top edge; on a
// short window that margin gives way first, down to 48 px, then the middle
// shrinks and scrolls. The window itself never scrolls. No step pads itself.
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";

export const MICRO_LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground";
/** The column's top margin, and the least it gives way to on a short window. */
export const TOP_MARGIN = 96;
export const TOP_MARGIN_MIN = 48;

export interface ScreenAction {
  word: string;
  onPress: () => void;
  disabled?: boolean;
  /** The keycap takes focus as its screen appears, so Enter advances, unless the screen has a field to type in first. */
  focus?: boolean;
  /** The one quiet destructive link a step may carry. */
  destructive?: boolean;
  /** Why the action is disabled, as its tooltip. */
  title?: string;
}

export function SetupScreen({
  k,
  label,
  counter,
  headline,
  top,
  children,
  primary,
  secondary,
  note,
  refusal = null,
}: {
  k: string;
  label: string;
  counter?: string;
  headline: string;
  /** The sentence under the title; a step with none has no slot for it and its content follows the title. */
  top?: string;
  children?: ReactNode;
  primary?: ScreenAction;
  secondary?: ScreenAction;
  /** One muted sentence above the footer, where a step has something the footer alone does not say. */
  note?: string;
  /** The host's word for what it refused, under the footer, so a press that did nothing says why. */
  refusal?: string | null;
}) {
  // The keycap takes focus without scrolling to it: a long step opens on its title, not on its button.
  const keycap = useRef<HTMLButtonElement>(null);
  const focus = primary !== undefined && primary.focus !== false;
  useEffect(() => {
    if (focus) keycap.current?.focus({ preventScroll: true });
  }, [focus]);
  return (
    <div data-k={k} className="mx-auto flex h-full w-[560px] max-w-full flex-col items-center">
      {/* The top margin as a flex item that shrinks a thousand times more readily than the middle, so it gives way first. */}
      <div data-k="top" aria-hidden className="w-full grow-0" style={{ flexBasis: TOP_MARGIN, flexShrink: 1000, minHeight: TOP_MARGIN_MIN }} />
      <div data-k="head" className="flex w-full shrink-0 flex-col items-center">
        <div className="mb-[14px] flex items-center gap-3">
          <p data-k="label" className={MICRO_LABEL}>
            {label}
          </p>
          {counter !== undefined ? (
            <span data-k="counter" className={MICRO_LABEL}>
              {counter}
            </span>
          ) : null}
        </div>
        <h2 data-k="title" className="mb-3 w-full text-center text-[34px] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground">
          {headline}
        </h2>
        {top !== undefined && top !== "" ? (
          <p data-k="sentence" className="mb-8 max-w-[440px] text-center text-[15px] leading-[1.5] text-muted-foreground">
            {top}
          </p>
        ) : null}
      </div>
      {/* The middle's basis is its content, so a shortage lands on the top margin first and only then shrinks and scrolls it. */}
      <div data-k="middle" className="flex min-h-0 w-full flex-[1_1_auto] flex-col overflow-y-auto">
        <div data-k="content" className="flex w-full shrink-0 flex-col">
          {children}
        </div>
      </div>
      <div data-k="foot" className="flex w-full shrink-0 flex-col items-center pt-7 pb-10">
        {note !== undefined ? (
          <p data-k="note" className="mb-4 max-w-[440px] text-center text-[13px] leading-[1.5] text-muted-foreground">
            {note}
          </p>
        ) : null}
        {primary !== undefined || secondary !== undefined ? (
          <div data-k="footer" className="flex flex-col items-center">
            {primary !== undefined ? (
              <Button data-k="primary" ref={keycap} onClick={primary.onPress} disabled={primary.disabled === true} className="h-10 rounded-[10px] px-[22px] text-[15px] sm:h-10 sm:text-[15px]">
                {primary.word}
                <span aria-hidden>→</span>
              </Button>
            ) : null}
            {secondary !== undefined ? (
              <Button data-k="secondary" variant="link" onClick={secondary.onPress} disabled={secondary.disabled === true} title={secondary.title} className={cn("h-auto p-0 text-[15px] sm:text-[15px]", primary !== undefined ? "mt-3" : "", secondary.destructive === true ? "text-destructive-foreground" : "text-muted-foreground hover:text-foreground")}>
                {secondary.word}
              </Button>
            ) : null}
          </div>
        ) : null}
        {refusal !== null ? (
          <p data-k="refusal" className="mt-4 max-w-[440px] break-words text-center font-mono text-xs text-warning-foreground">
            {refusal}
          </p>
        ) : null}
      </div>
    </div>
  );
}
