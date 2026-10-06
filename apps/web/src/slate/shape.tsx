// SPDX-License-Identifier: AGPL-3.0-only
// A tool or resource run's result drawn by the protocol's shape decision, the one the sketch says, through the kit's
// own table, facts and text pieces.
import { SLATE_RESULT_ROWS, slateResultShape, type SlateJson, type SlatePiece, type SlatePropValue, type SlateResultShape } from "@wsp/protocol";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { facts } from "./pieces/facts.js";
import { table } from "./pieces/table.js";
import { text } from "./pieces/text.js";
import type { PieceViewProps } from "./SlateView.js";

type Shared = Pick<PieceViewProps, "id" | "slate" | "raise" | "cancel" | "sender">;

const piece = (type: string, props: Record<string, SlatePropValue> = {}): SlatePiece => ({ type, props }) as SlatePiece;

function Shape({ shape, shared }: { shape: SlateResultShape; shared: Shared }) {
  switch (shape.kind) {
    case "none":
      return null;
    case "text": {
      const Text = text.component;
      return <Text {...shared} piece={piece("text")} props={{ value: shape.text }}>{null}</Text>;
    }
    case "table": {
      const Table = table.component;
      const columns = shape.columns.map(c => ({ title: c.title, value: { bind: `item.${c.key}` } }));
      return <Table {...shared} piece={piece("table", { columns })} props={{ items: shape.rows, rows: SLATE_RESULT_ROWS }}>{null}</Table>;
    }
    case "record": {
      const Facts = facts.component;
      return (
        <div className="flex min-w-0 flex-col gap-3">
          {shape.facts.length === 0 ? null : <Facts {...shared} piece={piece("facts")} props={{ facts: shape.facts, layout: "grid" }}>{null}</Facts>}
          {shape.nested.map(n => (
            <div key={n.title} className="flex min-w-0 flex-col gap-1">
              <p className={cn("text-muted-foreground", GROUP_LABEL)}>{n.title}</p>
              <Shape shape={n.shape} shared={shared} />
            </div>
          ))}
        </div>
      );
    }
  }
}

export function ResultByShape({ value, shared }: { value: SlateJson | undefined; shared: Shared }) {
  return <Shape shape={slateResultShape(value)} shared={shared} />;
}
