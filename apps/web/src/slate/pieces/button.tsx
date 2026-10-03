// SPDX-License-Identifier: AGPL-3.0-only
import type { SlateAction } from "@wsp/protocol";
import { Button, DANGER_BUTTON } from "../../components/ui/button.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";
import { Outcome } from "./outcome.js";
import { usePress } from "./press.js";

/** The hover title a press shows before it is pressed: the literal text it sends and the paths it carries. */
export function pressTitle(actions: SlateAction | SlateAction[] | undefined): string | undefined {
  const list = actions === undefined ? [] : Array.isArray(actions) ? actions : [actions];
  const lines = list.flatMap(action =>
    action.do === "send" || action.do === "steer" || action.do === "queue" || action.do === "fill"
      ? [`${action.text}${action.with !== undefined && action.with.length > 0 ? ` (with ${action.with.join(", ")})` : ""}`]
      : [],
  );
  return lines.length === 0 ? undefined : lines.join("\n");
}

export const button: PieceView = {
  type: "button",
  component: function ButtonPiece({ id, piece, props, slate, raise }) {
    const { busy, said, refused, press } = usePress(() => raise("press"));
    const label = str(props["label"]) ?? "";
    const held = str(props["held"]);
    const kind = props["variant"];
    const variant = kind === "primary" && slate.isLoud("primary", id) ? "default" : kind === "quiet" ? "ghost" : "outline";
    const title = held ?? str(props["note"]) ?? pressTitle(piece.on?.press);
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <Button
          variant={variant}
          size={props["size"] === "small" ? "xs" : "default"}
          className={kind === "danger" ? DANGER_BUTTON : undefined}
          held={held !== undefined}
          disabled={busy}
          aria-busy={busy || undefined}
          title={title}
          onClick={press}
        >
          {label}
        </Button>
        <Outcome said={said} refused={refused} />
      </div>
    );
  },
};
