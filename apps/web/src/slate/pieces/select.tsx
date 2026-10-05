// SPDX-License-Identifier: AGPL-3.0-only
// One choice of a few, written to a value: options from a bound list of strings or of { value, label }. A settings
// line: the label at the left, the select at the settings rows' one width at the right; in the toolbar, alone.
import type { SlateJson } from "@wsp/protocol";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { SELECT_WIDTH } from "../../settings/layout.js";
import type { PieceView } from "../SlateView.js";
import { getOwn } from "../paths.js";
import { heldBy, present, str } from "./look.js";
import { twoWayPath } from "./press.js";
import { isToolbar } from "./runs.js";

function optionsOf(value: SlateJson | undefined): { value: string; label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(option => {
    if (typeof option === "string" || typeof option === "number") return [{ value: String(option), label: String(option) }];
    if (option === null || typeof option !== "object" || Array.isArray(option)) return [];
    const v = str(option["value"]);
    return v === undefined ? [] : [{ value: v, label: str(option["label"]) ?? v }];
  });
}

export const select: PieceView = {
  type: "select",
  component: function SelectPiece({ id, piece, props, slate, sender, raise }) {
    const path = twoWayPath(piece.props?.["value"]);
    const options = optionsOf(Array.isArray(props["options"]) ? present(slate, piece.props?.["options"], props["options"]) : undefined);
    const current = str(path === undefined ? props["value"] : getOwn(slate.values, path)) ?? null;
    const label = str(props["label"]) ?? "";
    const held = heldBy(props["held"]);
    // In the toolbar the select is the Agents page's picker: no label beside it, as wide as its word.
    const parent = slate.parentId(id);
    const bare = parent !== undefined && isToolbar(slate, parent);
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        {bare ? null : <span className="min-w-0 text-sm leading-5 text-foreground">{label}</span>}
        <Select
          value={current}
          disabled={held !== undefined || path === undefined}
          onValueChange={next => {
            if (path === undefined || typeof next !== "string") return;
            void sender.now(path, next).then(() => (piece.on?.change !== undefined ? raise("change") : undefined));
          }}
        >
          <SelectTrigger size="sm" aria-label={label} title={held} className={bare ? "h-[30px] min-h-[30px] w-auto rounded-[7px] text-[13px] sm:text-[13px]" : SELECT_WIDTH}>
            <SelectValue placeholder={str(props["placeholder"]) ?? "Pick one"}>{(value: string | null) => options.find(o => o.value === value)?.label ?? value}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {options.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    );
  },
};
