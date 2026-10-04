// SPDX-License-Identifier: AGPL-3.0-only
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import type { SlateEngine } from "../engine.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { SlateIcon } from "./icon.js";
import { isSentence, present, str, TONE_INK, toneOf } from "./look.js";

interface Fact {
  label: string;
  value: string;
  tone: SlateJson | undefined;
  mono: boolean;
  icon: SlateJson | undefined;
}

function factsOf(slate: SlateEngine, raw: SlatePropValue | undefined, value: SlateJson | undefined): Fact[] {
  if (!Array.isArray(value)) return [];
  return present(slate, raw, value).flatMap(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const shown = str(entry["value"]);
    // A pair whose value is missing is left out.
    if (shown === undefined || shown === "") return [];
    return [{ label: str(entry["label"]) ?? "", value: shown, tone: entry["tone"], mono: entry["mono"] === true && !isSentence(shown), icon: entry["icon"] }];
  });
}

export const facts: PieceView = {
  type: "facts",
  component: ({ id, piece, props, slate }) => {
    const list = factsOf(slate, piece.props?.["facts"], props["facts"]);
    if (list.length === 0) return null;
    const ink = (fact: Fact) => cn(TONE_INK[toneOf(fact.tone, slate, id)], fact.mono && "font-mono text-xs tabular-nums");
    if (props["layout"] === "grid") {
      return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px] leading-5">
          {list.map((fact, at) => (
            <div key={at} className="contents">
              <dt className="flex items-center gap-1.5 text-muted-foreground"><SlateIcon name={fact.icon} className="size-3" />{fact.label}</dt>
              <dd className={cn("min-w-0 break-words", ink(fact))}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      );
    }
    return (
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] leading-5">
        {list.map((fact, at) => (
          <span key={at} className="whitespace-nowrap">
            <SlateIcon name={fact.icon} className="mr-1.5 inline size-3 align-[-1px]" />
            <span className="text-muted-foreground">{fact.label}</span> <span className={ink(fact)}>{fact.value}</span>
          </span>
        ))}
      </p>
    );
  },
};
