// SPDX-License-Identifier: AGPL-3.0-only
// Label and value pairs. In a grid, settings lines: the label 14 px at the left, the value at the right, a hairline
// between, filling the card they stand in. In a line, one row of pairs 12 px apart that wraps.
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import type { SlateEngine } from "../engine.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { placeOf } from "./runs.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { isSentence, present, str, TONE_INK, toneOf } from "./look.js";

/** A value that reads as a figure: 5.3M, $4.64, 96.3495, 13s. */
const FIGURE = /^[-+]?[$€£₹¥]?\d[\d,]*(\.\d+)?\s?(%|[A-Za-z]{1,5}(\/[A-Za-z]+)?)?$/;

interface Fact {
  label: string;
  value: string;
  tone: SlateJson | undefined;
  emphasis: SlateJson | undefined;
  mono: boolean;
}

function factsOf(slate: SlateEngine, raw: SlatePropValue | undefined, value: SlateJson | undefined): Fact[] {
  if (!Array.isArray(value)) return [];
  return present(slate, raw, value).flatMap(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const shown = str(entry["value"]);
    // A pair whose value is missing is left out.
    if (shown === undefined || shown === "") return [];
    return [{ label: str(entry["label"]) ?? "", value: shown, tone: entry["tone"], emphasis: entry["emphasis"], mono: entry["mono"] === true && !isSentence(shown) }];
  });
}

export const facts: PieceView = {
  type: "facts",
  fills: (slate, id) => slate.resolve(slate.piece(id)?.props?.["layout"]) === "grid",
  component: ({ id, piece, props, slate }) => {
    const list = factsOf(slate, piece.props?.["facts"], props["facts"]);
    if (list.length === 0) return null;
    const place = placeOf(slate, id);
    // A figure or machine text is 12 px mono in the foreground; a word is 13 px sans muted; a tone colours either.
    const ink = (fact: Fact) => {
      const mono = fact.mono || FIGURE.test(fact.value.trim());
      return cn(
        mono ? "font-mono text-xs tabular-nums text-foreground" : "text-[13px] text-muted-foreground",
        fact.emphasis === "quiet" ? "text-muted-foreground" : fact.tone !== undefined && TONE_INK[toneOf(fact.tone, slate, id)],
        fact.emphasis === "strong" && "font-medium",
      );
    };
    if (props["layout"] !== "grid") {
      return (
        <p data-slate-facts className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          {list.map((fact, at) => (
            <span key={at} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
              <span data-settings-label className="text-xs leading-4 text-muted-foreground">{fact.label}</span>
              <span data-settings-word className={ink(fact)}>{fact.value}</span>
            </span>
          ))}
        </p>
      );
    }
    return (
      <div data-slate-facts className={cn("flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border/50", place === "page" && CARD_SURFACE)}>
        {list.map((fact, at) => (
          <div key={at} className={cn("flex min-h-11 min-w-0 items-center justify-between gap-4 py-3", place === "inside" ? "" : "px-(--settings-inset,20px)")}>
            <span data-settings-label className="min-w-0 text-sm leading-5 text-foreground">{fact.label}</span>
            <span data-settings-word className={cn("min-w-0 text-right break-words", ink(fact))}>{fact.value}</span>
          </div>
        ))}
      </div>
    );
  },
};
