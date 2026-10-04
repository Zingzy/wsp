// SPDX-License-Identifier: AGPL-3.0-only
// Rows of a list as Checkbox rows in the composer task list's style; a done title muted, not struck. When editable,
// a tick writes the row's done field into the value the list binds: $items[index].<field> (05, "checklist").
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import { isSlateBinding } from "@wsp/protocol";
import { Checkbox } from "../../components/ui/checkbox.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { str } from "./look.js";
import { Quiet } from "./quiet.js";
import { twoWayPath } from "./press.js";

/** The field a row's done reads, where it binds item.<field>. */
function rowField(value: SlatePropValue | undefined): string | undefined {
  if (!isSlateBinding(value)) return undefined;
  return /^item\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(value.bind.trim())?.[1];
}

export const checklist: PieceView = {
  type: "checklist",
  rowScoped: ["key", "title", "done", "state", "note"],
  component: function ChecklistPiece({ id, piece, props, slate, sender, raise }) {
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const list = twoWayPath(piece.props?.["items"]);
    const field = rowField(piece.props?.["done"]);
    const editable = props["editable"] === true && list !== undefined && field !== undefined;
    if (items.length === 0) return <Quiet>{str(props["empty"]) ?? "Nothing here"}</Quiet>;
    return (
      <ul data-slate-checklist={id} className="flex min-w-0 flex-col gap-1.5">
        {items.map((item: SlateJson, index) => {
          const row = { item, index };
          const key = slate.resolve(piece.props?.["key"], row);
          const done = truthy(slate.resolve(piece.props?.["done"], row));
          const note = str(slate.resolve(piece.props?.["note"], row));
          return (
            <li key={key === undefined || key === null ? `#${index}` : String(key)} className="flex min-w-0 items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={done}
                disabled={!editable}
                aria-label={str(slate.resolve(piece.props?.["title"], row))}
                onCheckedChange={next => {
                  if (!editable) return;
                  void sender.now(`${list}[${index}].${field}`, next === true).then(() => (piece.on?.change !== undefined ? raise("change", { row }) : undefined));
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span className={cn("text-sm leading-5", done ? "text-muted-foreground" : "text-foreground")}>{str(slate.resolve(piece.props?.["title"], row))}</span>
                {note === undefined ? null : <span className="text-xs leading-4 text-muted-foreground">{note}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    );
  },
};
