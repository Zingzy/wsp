// SPDX-License-Identifier: AGPL-3.0-only
// A boolean value as a Switch in a settings line: the label, a quiet note under it, the switch at the right.
import { useId } from "react";
import { Switch } from "../../components/ui/switch.js";
import type { PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { getOwn } from "../paths.js";
import { str, heldBy } from "./look.js";
import { twoWayPath } from "./press.js";

export const toggle: PieceView = {
  type: "toggle",
  component: function TogglePiece({ piece, props, slate, sender, raise }) {
    const fieldId = useId();
    const path = twoWayPath(piece.props?.["value"]);
    const on = truthy(path === undefined ? props["value"] : getOwn(slate.values, path));
    const note = str(props["note"]);
    const held = heldBy(props["held"]);
    return (
      <div className="flex min-w-0 items-center gap-3">
        <label htmlFor={fieldId} className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm leading-5 text-foreground">{str(props["label"])}</span>
          {note === undefined ? null : <span className="text-xs leading-4 text-muted-foreground">{note}</span>}
        </label>
        <Switch
          id={fieldId}
          checked={on}
          disabled={held !== undefined || path === undefined}
          title={held}
          onCheckedChange={next => {
            if (path === undefined) return;
            void sender.now(path, next).then(() => (piece.on?.change !== undefined ? raise("change") : undefined));
          }}
        />
      </div>
    );
  },
};
