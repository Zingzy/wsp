// SPDX-License-Identifier: AGPL-3.0-only
import { stepsOf, type SlateStep } from "../model.js";
import { Button, DANGER_BUTTON } from "../../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import type { PieceView } from "../SlateView.js";
import { str, heldBy } from "./look.js";
import { SlateIcon } from "./icon.js";
import { Outcome } from "./outcome.js";
import { usePress } from "./press.js";

/** The hover title a press shows before it is pressed: what each step does, a send's literal text and the paths it
 * carries (05, "button"). */
export function pressTitle(steps: SlateStep | SlateStep[] | undefined): string | undefined {
  const lines = stepsOf(steps).map(step => {
    switch (step.do) {
      case "send":
      case "steer":
      case "queue":
      case "fill":
        return `${step.text}${step.with !== undefined && step.with.length > 0 ? ` (with ${step.with.join(", ")})` : ""}`;
      case "start":
        return `Runs ${step.run}`;
      case "cancel":
        return `Stops ${step.run}`;
      case "set":
      case "toggle":
        return `Changes ${step.path}`;
      case "open":
        return "Opens a link";
      case "copy":
        return "Copies";
      case "pane":
        return `Opens ${step.kind}`;
    }
  });
  return lines.length === 0 ? undefined : lines.join("\n");
}

export const button: PieceView = {
  type: "button",
  component: function ButtonPiece({ id, piece, props, slate, raise }) {
    const { busy, said, refused, press } = usePress(() => raise("press"));
    const label = str(props["label"]) ?? "";
    const held = heldBy(props["held"]);
    const kind = props["variant"];
    const variant = kind === "primary" && slate.isLoud("primary", id) ? "default" : kind === "quiet" ? "ghost" : "outline";
    const control = (
      <Button
        variant={variant}
        size={props["size"] === "small" ? "xs" : "default"}
        className={kind === "danger" ? DANGER_BUTTON : undefined}
        held={held !== undefined}
        disabled={busy}
        aria-busy={busy || undefined}
        title={held === undefined ? (str(props["note"]) ?? pressTitle(piece.on?.press)) : undefined}
        onClick={press}
      >
        <SlateIcon name={props["icon"]} className="size-3.5" />
        {label}
      </Button>
    );
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        {held === undefined ? (
          control
        ) : (
          // A disabled button takes no pointer, so the sentence it is held by rides a tooltip on the span around it.
          <Tooltip>
            <TooltipTrigger render={<span data-slate-held-button={held} className="inline-flex" />}>{control}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-72 text-pretty">
              {held}
            </TooltipPopup>
          </Tooltip>
        )}
        <Outcome said={said} refused={refused} />
      </div>
    );
  },
};
