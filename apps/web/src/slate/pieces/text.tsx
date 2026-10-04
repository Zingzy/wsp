// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { SlateIcon } from "./icon.js";
import type { SlateEngine } from "../engine.js";
import { isSentence, str, TEXT_SIZE, TONE_INK, toneOf } from "./look.js";

/** A row with a heading and a button in it: a text beside them is a status line, small and muted. */
function inHeaderRow(slate: SlateEngine, id: string): boolean {
  const row = slate.parent(id);
  if (row?.type !== "row") return false;
  const types = (row.children ?? []).map(child => slate.piece(child)?.type);
  return types.includes("heading") && types.includes("button");
}

export const text: PieceView = {
  type: "text",
  component: ({ id, piece, props, slate }) => {
    const value = str(props["value"]);
    const placeholder = str(props["placeholder"]);
    if (value === undefined || value === "") {
      return placeholder === undefined ? null : <p className="text-sm leading-5 text-muted-foreground">{placeholder}</p>;
    }
    const emphasis = props["emphasis"];
    const set = piece.props ?? {};
    const status = set["size"] === undefined && set["tone"] === undefined && set["emphasis"] === undefined && inHeaderRow(slate, id);
    const tone = emphasis === "quiet" || status ? "muted" : toneOf(props["tone"], slate, id);
    const size = status ? "small" : props["size"] === "large" && !slate.isLoud("large", id) ? "normal" : String(props["size"] ?? "normal");
    const lines = typeof props["lines"] === "number" ? props["lines"] : undefined;
    const body = (
      <p
        title={lines !== undefined ? value : undefined}
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words",
          TEXT_SIZE[size] ?? TEXT_SIZE["normal"],
          TONE_INK[tone],
          emphasis === "strong" && "font-medium",
          props["mono"] === true && !isSentence(value) && "font-mono tabular-nums",
          typeof props["value"] === "number" && "tabular-nums",
          lines === 1 && "truncate whitespace-nowrap",
          lines !== undefined && lines > 1 && "line-clamp-(--slate-lines)",
        )}
        style={lines !== undefined && lines > 1 ? ({ "--slate-lines": lines } as React.CSSProperties) : undefined}
      >
        {value}
      </p>
    );
    if (props["icon"] === undefined) return body;
    return (
      <div className="flex min-w-0 items-start gap-2">
        <SlateIcon name={props["icon"]} className="mt-[3px]" />
        {body}
      </div>
    );
  },
};
