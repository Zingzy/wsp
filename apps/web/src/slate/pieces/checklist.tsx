// SPDX-License-Identifier: AGPL-3.0-only
// Rows of a list as rows of the card, each a 16 px checkbox, the title and its note; a done title muted, not struck. When editable,
// a tick writes the row's done field into the value the list binds: $items[index].<field> (05, "checklist").
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import { isSlateBinding } from "@wsp/protocol";
import { Checkbox } from "../../components/ui/checkbox.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { str } from "./look.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { placeOf } from "./runs.js";
import { twoWayPath } from "./press.js";

/** The field a row's done reads, where it binds item.<field>. */
function rowField(value: SlatePropValue | undefined): string | undefined {
  if (!isSlateBinding(value)) return undefined;
  return /^item\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(value.bind.trim())?.[1];
}

export const checklist: PieceView = {
  type: "checklist",
  fills: true,
  rowScoped: ["key", "title", "done", "state", "note"],
  component: function ChecklistPiece({ id, piece, props, slate, sender, raise }) {
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const list = twoWayPath(piece.props?.["items"]);
    const field = rowField(piece.props?.["done"]);
    const editable = props["editable"] === true && list !== undefined && field !== undefined;
    const place = placeOf(slate, id);
    const inset = place === "inside" ? "" : "px-(--settings-inset,20px)";
    if (items.length === 0) return <p className={cn("flex min-h-11 items-center py-3 text-[13px] leading-5 text-muted-foreground", inset, place === "page" && CARD_SURFACE)}>{str(props["empty"]) ?? "Nothing here"}</p>;
    return (
      <ul data-slate-checklist={id} className={cn("flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border/50", place === "page" && CARD_SURFACE)}>
        {items.map((item: SlateJson, index) => {
          const row = { item, index };
          const key = slate.resolve(piece.props?.["key"], row);
          const done = truthy(slate.resolve(piece.props?.["done"], row));
          const note = str(slate.resolve(piece.props?.["note"], row));
          // A row that is a plain word is its own title; a title written once would name every row alike.
          const title = typeof item === "string" || typeof item === "number" ? String(item) : str(slate.resolve(piece.props?.["title"], row));
          return (
            <li key={key === undefined || key === null ? `#${index}` : String(key)} className={cn("flex min-h-11 min-w-0 items-start gap-3 py-3", inset)}>
              <Checkbox
                className="mt-0.5"
                checked={done}
                disabled={!editable}
                aria-label={title}
                onCheckedChange={next => {
                  if (!editable) return;
                  void sender.now(`${list}[${index}].${field}`, next === true).then(() => (piece.on?.change !== undefined ? raise("change", { row }) : undefined));
                }}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("text-sm leading-5", done ? "text-muted-foreground" : "text-foreground")}>{title}</span>
                {note === undefined ? null : <span className="text-[13px] leading-5 text-muted-foreground">{note}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    );
  },
};
