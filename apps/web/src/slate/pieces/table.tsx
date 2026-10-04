// SPDX-License-Identifier: AGPL-3.0-only
// Rows from a list, one template of columns over them: one header row in the group heading grammar, no line
// between rows, numbers end-aligned in mono. Rows are keyed by the piece's `key`, else their index.
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import type { SlateStep } from "../model.js";
import { Button } from "../../components/ui/button.js";
import { GROUP_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";
import type { SlateEngine } from "../engine.js";
import type { PieceViewProps, PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { str, TONE_INK, toneOf } from "./look.js";
import { Outcome } from "./outcome.js";
import { usePress } from "./press.js";
import { pressTitle } from "./button.js";

type Template = Record<string, SlatePropValue>;
const records = (value: SlatePropValue | undefined): Template[] =>
  Array.isArray(value) ? value.filter((entry): entry is Template => entry !== null && typeof entry === "object" && !Array.isArray(entry)) : [];

type Row = { item: SlateJson; index: number };

function RowAction({ id, template, at, row, slate, raise }: Pick<PieceViewProps, "id" | "slate" | "raise"> & { template: Template; at: number; row: Row }) {
  const on = template["on"] as unknown as { press?: SlateStep | SlateStep[] } | undefined;
  const { busy, said, refused, press } = usePress(() => raise("press", { row, rowAction: at, ...(on?.press !== undefined ? { actions: on.press } : {}) }));
  const label = str(slate.resolve(template["label"], row)) ?? "";
  const first = str(row.item !== null && typeof row.item === "object" && !Array.isArray(row.item) ? Object.values(row.item)[0] : row.item);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button data-slate-row-action={`${id}:${at}`} variant="outline" size="xs" disabled={busy} title={pressTitle(on?.press)} aria-label={first === undefined ? label : `${label}, ${first}`} onClick={press}>
        {label}
      </Button>
      <Outcome said={said} refused={refused} />
    </span>
  );
}

function rowKey(slate: SlateEngine, key: SlatePropValue | undefined, row: Row): string {
  const value = key === undefined ? undefined : slate.resolve(key, row);
  return value === undefined || value === null ? `#${row.index}` : typeof value === "string" ? value : JSON.stringify(value);
}

export const table: PieceView = {
  type: "table",
  rowScoped: ["columns", "rowActions", "key"],
  component: function TablePiece({ id, piece, props, slate, raise }) {
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const columns = records(piece.props?.["columns"]).slice(0, 8);
    const actions = records(piece.props?.["rowActions"]).slice(0, 3);
    const cap = typeof props["rows"] === "number" ? Math.max(0, Math.floor(props["rows"])) : items.length;
    const shown = items.slice(0, cap);
    const end = (column: Template) => column["align"] === "end";
    return (
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className={cn("text-muted-foreground", GROUP_LABEL)}>
              {columns.map((column, at) => (
                <th key={at} scope="col" className={cn("pb-1 pr-4 font-normal last:pr-0", end(column) && "text-right")}>
                  {str(slate.resolve(column["title"]))}
                </th>
              ))}
              {actions.length > 0 ? <th aria-label="Actions" className="pb-1" /> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((item, index) => {
              const row = { item, index };
              return (
                <tr key={rowKey(slate, piece.props?.["key"], row)} className="align-top transition-colors duration-150 hover:bg-accent">
                  {columns.map((column, at) => {
                    const value = slate.resolve(column["value"], row);
                    const mono = column["mono"] === true || typeof value === "number";
                    return (
                      <td
                        key={at}
                        className={cn(
                          "py-1 pr-4 last:pr-0",
                          mono ? "font-mono text-xs leading-5 tabular-nums" : "text-[13px] leading-5",
                          TONE_INK[toneOf(slate.resolve(column["tone"], row), slate, id)],
                          (end(column) || (typeof value === "number" && column["align"] === undefined)) && "text-right",
                        )}
                      >
                        {str(value)}
                      </td>
                    );
                  })}
                  {actions.length > 0 ? (
                    <td className="py-1 text-right">
                      <span className="inline-flex gap-1">
                        {actions.map((template, at) =>
                          template["when"] !== undefined && !truthy(slate.resolve({ bind: String(template["when"]) }, row)) ? null : (
                            <RowAction key={at} id={id} template={template} at={at} row={row} slate={slate} raise={raise} />
                          ),
                        )}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 ? <p className="py-1 text-[13px] leading-5 text-muted-foreground">{str(props["empty"]) ?? "Nothing here"}</p> : null}
        {items.length > shown.length ? <p className="py-1 text-xs leading-4 text-muted-foreground">and {items.length - shown.length} more</p> : null}
      </div>
    );
  },
};
