// SPDX-License-Identifier: AGPL-3.0-only
// The locked dialog's head, body and foot, as Add a computer draws them, in one
// place so every dialog or dock drawn as one of its steps reads them from here.
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/** The dialog's width. */
export const STEP_WIDTH = "max-w-[560px]";
/** The head: the title and its one line at the left, the step's count as a quiet fact at the right. */
export const STEP_HEAD = "flex flex-row items-start justify-between gap-6 px-5 pt-4 pb-3";
/** The body: cards, one under the other. */
export const STEP_BODY = "flex flex-col gap-5 px-5 pt-2 pb-5";
/** The foot: a quiet state at the left, the acts at the right. Under 640 px the acts stack with the primary on top
 * and the state stands under them. */
export const STEP_FOOT = "flex flex-col-reverse gap-2 px-5 pt-3 pb-4 sm:flex-row sm:items-center sm:justify-end";

/** The foot with its state at the left; no keyboard hint stands in it. */
export function StepFoot({ left, children, className, ...props }: { left: ReactNode; children: ReactNode } & Omit<ComponentProps<"div">, "children">) {
  return (
    <div data-slot="dialog-footer" className={cn(STEP_FOOT, className)} {...props}>
      <span className="flex min-h-5 items-center max-sm:justify-center sm:me-auto">{left}</span>
      {children}
    </div>
  );
}
