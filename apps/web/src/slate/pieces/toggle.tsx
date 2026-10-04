// SPDX-License-Identifier: AGPL-3.0-only
// A boolean value as the General page's line: the title 14 px 500 with its note under it, the switch in the slot. In
// the slate's toolbar beside a select it filters the list under it, so it is the two-segment control instead.
import { useId } from "react";
import { SegmentedControl } from "../../components/ui/segmented-control.js";
import { Switch } from "../../components/ui/switch.js";
import type { SlateEngine } from "../engine.js";
import type { PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { getOwn } from "../paths.js";
import { str, heldBy } from "./look.js";
import { twoWayPath } from "./press.js";
import { isToolbar } from "./runs.js";

const ALL = "All";

/** A toggle in the toolbar beside a select. */
function filters(slate: SlateEngine, id: string): boolean {
  const parent = slate.parentId(id);
  if (parent === undefined || !isToolbar(slate, parent)) return false;
  return (slate.piece(parent)?.children ?? []).some(child => slate.piece(child)?.type === "select");
}

export const toggle: PieceView = {
  type: "toggle",
  component: function TogglePiece({ id, piece, props, slate, sender, raise }) {
    const fieldId = useId();
    const path = twoWayPath(piece.props?.["value"]);
    const on = truthy(path === undefined ? props["value"] : getOwn(slate.values, path));
    const label = str(props["label"]) ?? "";
    const note = str(props["note"]);
    const held = heldBy(props["held"]);
    const set = (next: boolean) => {
      if (path === undefined) return;
      void sender.now(path, next).then(() => (piece.on?.change !== undefined ? raise("change") : undefined));
    };
    if (filters(slate, id)) {
      return (
        <SegmentedControl
          aria-label={label}
          title={held}
          disabled={held !== undefined || path === undefined}
          value={on ? "on" : "off"}
          segments={[{ value: "off", label: ALL }, { value: "on", label }]}
          onChange={next => set(next === "on")}
          className="h-8 gap-0.5 rounded-[10px] border-input bg-input-fill shadow-[inset_0_1px_0_var(--keycap-top)]"
          segmentClassName="h-[26px] rounded-lg px-2.5"
        />
      );
    }
    return (
      <div className="flex min-w-0 items-center justify-between gap-4">
        <label htmlFor={fieldId} className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm leading-5 font-medium text-foreground">{label}</span>
          {note === undefined ? null : <span className="text-[13px] leading-[1.45] text-muted-foreground">{note}</span>}
        </label>
        <Switch id={fieldId} checked={on} disabled={held !== undefined || path === undefined} title={held} onCheckedChange={set} />
      </div>
    );
  },
};
