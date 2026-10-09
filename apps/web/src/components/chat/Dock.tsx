// SPDX-License-Identifier: AGPL-3.0-only
// What stands in the composer's place, drawn in the composer's own frame as one
// step of a settings dialog: the question panel and every bar a drawer row
// opens. A head (a mark, the title, the lines under it, and an aside at the
// right), the body's settings cards, and the dialog's foot with the way back
// to the composer at the left and the acts at the right.
import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import { STEP_BODY, STEP_HEAD, StepFoot } from "../../settings/add/StepDialog";
import { FACT } from "../../settings/format";
import { Button } from "../ui/button";
import { ComposerSurface } from "./ComposerSurface";

/** The title a step larger than a dialog's, as the question panel was locked. */
const TITLE_CLASS = "text-base leading-6 font-semibold text-foreground";
/** The foot as the question panel was locked: no top padding and pb-5, where the dialog's foot has pt-3 pb-4. */
const DOCK_FOOT = "pt-0 pb-5";

type Attrs = Record<`data-${string}`, string | boolean | undefined>;

export function Dock({
  shell,
  rootRef,
  root,
  mark,
  title,
  titleAttrs,
  under,
  aside,
  children,
  back,
  acts,
}: {
  /** The attributes the tests and the screenshot list reach this dock by. */
  shell: Attrs;
  rootRef?: Ref<HTMLDivElement>;
  /** The root's own props, where the dock takes keys. */
  root?: Omit<ComponentProps<"div">, "ref" | "className" | "children"> & Attrs;
  mark: ReactNode;
  title: ReactNode;
  titleAttrs?: Attrs;
  /** The lines under the title. */
  under?: ReactNode;
  /** A quiet figure at the head's right: a count, a step of a form. */
  aside?: ReactNode;
  /** The settings cards. */
  children?: ReactNode;
  /** The way back to the composer, at the foot's left. */
  back: ReactNode;
  /** The foot's buttons, the primary last. */
  acts?: ReactNode;
}) {
  return (
    <div className="px-3 pb-3 sm:px-4 sm:pb-4">
      <ComposerSurface.Shell {...shell}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div ref={rootRef} {...root} className="flex min-w-0 flex-col outline-none">
              <div data-slot="dialog-header" className={STEP_HEAD}>
                <div className="flex min-w-0 flex-col gap-1">
                  <div role="heading" aria-level={2} data-dock-title {...titleAttrs} className={cn(TITLE_CLASS, "flex min-w-0 items-center gap-2")}>
                    {mark}
                    <span className="min-w-0 break-words">{title}</span>
                  </div>
                  {under}
                </div>
                {aside === undefined || aside === null ? null : (
                  <span data-dock-aside className={cn(FACT, "shrink-0")}>
                    {aside}
                  </span>
                )}
              </div>
              {children === undefined ? null : (
                <div data-slot="dialog-panel" className={STEP_BODY}>
                  {children}
                </div>
              )}
              <StepFoot data-dock-foot className={DOCK_FOOT} left={back}>
                {acts}
              </StepFoot>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/** The foot's way back to the composer: a quiet word with no padding, so its text edge is its box edge. */
export function DockBack({ word, onClick, attrs }: { word: string; onClick: () => void; attrs?: Attrs }) {
  return (
    <Button size="xs" variant="ghost" data-dock-back {...attrs} className="px-0 [:hover,[data-pressed]]:bg-transparent" onClick={onClick}>
      {word}
    </Button>
  );
}
