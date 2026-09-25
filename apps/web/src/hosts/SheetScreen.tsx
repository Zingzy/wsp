// SPDX-License-Identifier: AGPL-3.0-only
// The one layout a sheet over the whole window is drawn in, the first launch's
// grammar at the first launch's numbers, in three bands: the head (the title,
// one sentence when the step has one), the content, and a footer with the
// primary and a text link. The column is 560 px.
// A step whose bands fit stands centred in the window, as the first launch
// does; one that does not fit keeps 48 px over its head and 40 under its
// footer, and its card, the one thing that scrolls, gives up the rest. The
// window itself never scrolls. No step pads itself.
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";

/** The least room over the head and under the footer, once the step is taller than the window's middle. */
const TOP_MARGIN_MIN = 48;
const BOTTOM_MARGIN_MIN = 40;

export interface ScreenAction {
  word: string;
  onPress: () => void;
  disabled?: boolean;
  /** The keycap takes focus as its screen appears, so Enter advances, unless the screen has a field to type in first. */
  focus?: boolean;
  /** Why the action is disabled, as its tooltip. */
  title?: string;
  /** The keycap while the host is answering it: the arrow gives way to the spinner and the press does not repeat. */
  busy?: boolean;
}

export function SheetScreen({
  k,
  headline,
  top,
  children,
  primary,
  secondary,
  note,
}: {
  k: string;
  headline: string;
  /** The sentence under the title; a step with none has no slot for it and its content follows the title. */
  top?: string;
  children?: ReactNode;
  primary?: ScreenAction;
  secondary?: ScreenAction;
  /** One muted line above the footer, the column wide, where a step has something the footer alone does not say. */
  note?: string;
}) {
  // The keycap takes focus without scrolling to it: a long step opens on its title, not on its button.
  const keycap = useRef<HTMLButtonElement>(null);
  const focus = primary !== undefined && primary.focus !== false;
  useEffect(() => {
    if (focus) keycap.current?.focus({ preventScroll: true });
  }, [focus]);
  const held = primary !== undefined && primary.disabled === true;
  const busy = primary !== undefined && primary.busy === true;
  const keycapButton =
    primary !== undefined ? (
      <Button data-k="primary" ref={keycap} variant={held ? "outline" : "default"} onClick={primary.onPress} disabled={held || busy} data-busy={busy} className={cn("h-10 rounded-[10px] px-[22px] text-[15px] sm:h-10 sm:text-[15px]", held && "text-muted-foreground")}>
        {primary.word}
        {busy ? <Spinner data-k="busy" className="size-4" /> : <span aria-hidden>→</span>}
      </Button>
    ) : null;
  // A disabled control cannot be hovered, so its reason rides on a wrapper the tooltip reads.
  const withReason = (k: string, control: ReactNode, reason: string | undefined): ReactNode =>
    reason === undefined ? (
      control
    ) : (
      <Tooltip>
        <TooltipTrigger data-k={k} render={<span className="inline-flex" />}>
          {control}
        </TooltipTrigger>
        <TooltipPopup side="top" sideOffset={6}>
          {reason}
        </TooltipPopup>
      </Tooltip>
    );
  const secondaryHeld = secondary !== undefined && secondary.disabled === true;
  const secondaryLink =
    secondary !== undefined ? (
      <Button data-k="secondary" variant="link" onClick={secondary.onPress} disabled={secondaryHeld} className="h-auto p-0 text-[15px] text-muted-foreground hover:text-foreground disabled:opacity-50 sm:text-[15px]">
        {secondary.word}
      </Button>
    ) : null;
  return (
    <div data-k={k} className="mx-auto flex h-full w-[560px] max-w-full flex-col items-center">
      {/* The margins are two flex items sharing the room the bands leave, so a short step stands centred; each stops at its least and the middle scrolls from there. */}
      <div data-k="top" aria-hidden className="w-full" style={{ flex: "1 1 0", minHeight: TOP_MARGIN_MIN }} />
      <div data-k="head" className="mb-16 flex w-full shrink-0 flex-col items-center">
        <h2 data-k="title" className={cn("w-full text-center text-[34px] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground", top !== undefined && top !== "" ? "mb-4" : "")}>
          {headline}
        </h2>
        {top !== undefined && top !== "" ? (
          <p data-k="sentence" className="max-w-[440px] text-center text-[15px] leading-[1.5] text-muted-foreground">
            {top}
          </p>
        ) : null}
      </div>
      {/* The middle's basis is its content; a step taller than the window shrinks it, and the card inside scrolls. */}
      <div data-k="middle" className="flex min-h-0 w-full flex-[0_1_auto] flex-col">
        <div data-k="content" className="flex min-h-0 w-full flex-col">
          {children}
        </div>
      </div>
      <div data-k="foot" className="relative flex w-full shrink-0 flex-col items-center pt-14">
        {note !== undefined ? (
          <p data-k="note" className="mb-4 w-full text-center text-[13px] leading-[1.5] text-muted-foreground">
            {note}
          </p>
        ) : null}
        {primary !== undefined || secondary !== undefined ? (
          <div data-k="footer" className="flex flex-col items-center">
            {withReason("primary-reason", keycapButton, held ? primary.title : undefined)}
            {secondaryLink !== null ? (
              <div data-k="links" className={cn("flex items-center gap-3", primary !== undefined && "mt-3")}>
                {withReason("secondary-reason", secondaryLink, secondaryHeld ? secondary.title : undefined)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div data-k="bottom" aria-hidden className="w-full" style={{ flex: "1 1 0", minHeight: BOTTOM_MARGIN_MIN }} />
    </div>
  );
}
