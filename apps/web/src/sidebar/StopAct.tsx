// SPDX-License-Identifier: AGPL-3.0-only
// Stop in two presses, the one act a thread or a subagent is stopped by from its
// row: on a tile, on a subagent row and on a row of the Threads bar. The first
// press arms it and the glyph gives way to the word Stop in the danger ink for
// the arm rule's two seconds; a second press within them stops. The pointer
// leaving the row, the focus leaving it, or Escape disarms. The armed state is
// the act's own, so arming draws the act alone and nothing at rest holds a timer.
// The row it watches for the pointer and the focus leaving carries data-stop-row,
// and takes data-stop-armed while armed so its words give the word room.
import { SquareIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { THREAD_WORDS } from "../actions/format.js";
import { ARM_MS } from "../components/arm.js";
import { Button } from "../components/ui/button.js";
import { SidebarMenuAction } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { HOVER_GLYPH_CLASS, SLOT_ACT_CLASS } from "./rowGrammar.js";

/** The armed word: no fill and no border, under the pointer too, in the ink a refusal sentence wears. */
const ARMED_CLASS = "aspect-auto w-auto px-1.5 text-xs font-medium text-error-foreground hover:bg-transparent hover:text-error-foreground";

export function StopAct({ label, onStop, on, className, onArmed }: {
  /** What the act says at rest, on its tooltip and its label. */
  label: string;
  onStop: () => void;
  /** Where it stands: a sidebar row's slot, or a Threads bar row's acts. */
  on: "sidebar" | "bar";
  className?: string | undefined;
  /** Told as the act arms and disarms, for a row whose other acts give way to the armed word. */
  onArmed?: ((armed: boolean) => void) | undefined;
}) {
  const [armed, setArmed] = useState(false);
  const row = useRef<HTMLElement | null>(null);
  const told = useRef(onArmed);
  told.current = onArmed;
  useEffect(() => {
    told.current?.(armed);
    if (!armed) return;
    const at = row.current;
    const disarm = (): void => setArmed(false);
    // A tap sends its own pointerleave before its click, so only a mouse leaving disarms.
    const pointerLeft = (e: PointerEvent): void => {
      if (e.pointerType === "mouse") disarm();
    };
    // Focus that lands outside the row disarms; focus that goes nowhere inside the window (a script's blur) leaves
    // the arm to its lapse, and the window losing focus disarms.
    const focusLeft = (e: FocusEvent): void => {
      if (e.relatedTarget instanceof Node && at?.contains(e.relatedTarget) !== true) disarm();
    };
    const lapse = setTimeout(disarm, ARM_MS);
    at?.setAttribute("data-stop-armed", "");
    at?.addEventListener("pointerleave", pointerLeft);
    at?.addEventListener("focusout", focusLeft);
    window.addEventListener("blur", disarm);
    return () => {
      clearTimeout(lapse);
      at?.removeAttribute("data-stop-armed");
      at?.removeEventListener("pointerleave", pointerLeft);
      at?.removeEventListener("focusout", focusLeft);
      window.removeEventListener("blur", disarm);
    };
  }, [armed]);
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
    row.current = event.currentTarget.closest<HTMLElement>("[data-stop-row]") ?? event.currentTarget;
    if (armed) onStop();
    setArmed(!armed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!armed || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setArmed(false);
  };
  const words = armed ? THREAD_WORDS.stopAgain : label;
  const props = { "aria-label": words, "data-stop-act": "", ...(armed ? { "data-armed": "" } : {}), onClick, onKeyDown };
  const face = armed ? THREAD_WORDS.stopArmed : <SquareIcon aria-hidden className="size-3.5" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          on === "sidebar" ? (
            <SidebarMenuAction showOnHover {...props} className={cn(HOVER_GLYPH_CLASS, SLOT_ACT_CLASS, className, armed && ARMED_CLASS)} />
          ) : (
            <Button type="button" size="icon-xs" variant="ghost" {...props} className={cn(className, armed && ARMED_CLASS)} />
          )
        }
      >
        {face}
      </TooltipTrigger>
      <TooltipPopup side="top">{words}</TooltipPopup>
    </Tooltip>
  );
}
