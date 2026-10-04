// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { str, TEXT_SIZE, TONE_INK, toneOf } from "./look.js";

export const text: PieceView = {
  type: "text",
  component: ({ id, props, slate }) => {
    const value = str(props["value"]);
    const placeholder = str(props["placeholder"]);
    if (value === undefined || value === "") {
      return placeholder === undefined ? null : <p className="text-sm leading-5 text-muted-foreground">{placeholder}</p>;
    }
    const emphasis = props["emphasis"];
    const tone = emphasis === "quiet" ? "muted" : toneOf(props["tone"], slate, id);
    const size = props["size"] === "large" && !slate.isLoud("large", id) ? "normal" : String(props["size"] ?? "normal");
    const lines = typeof props["lines"] === "number" ? props["lines"] : undefined;
    return (
      <p
       
        title={lines !== undefined ? value : undefined}
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words",
          TEXT_SIZE[size] ?? TEXT_SIZE["normal"],
          TONE_INK[tone],
          emphasis === "strong" && "font-medium",
          props["mono"] === true && "font-mono tabular-nums",
          typeof props["value"] === "number" && "tabular-nums",
          lines === 1 && "truncate whitespace-nowrap",
          lines !== undefined && lines > 1 && "line-clamp-(--slate-lines)",
        )}
        style={lines !== undefined && lines > 1 ? ({ "--slate-lines": lines } as React.CSSProperties) : undefined}
      >
        {value}
      </p>
    );
  },
};
