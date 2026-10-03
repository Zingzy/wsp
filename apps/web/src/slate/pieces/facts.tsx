// SPDX-License-Identifier: AGPL-3.0-only
import type { SlateJson } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { str, TONE_INK, toneOf } from "./look.js";

interface Fact {
  label: string;
  value: string;
  tone: SlateJson | undefined;
  mono: boolean;
}

function factsOf(value: SlateJson | undefined): Fact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const shown = str(entry["value"]);
    // A pair whose value is missing is left out.
    if (shown === undefined || shown === "") return [];
    return [{ label: str(entry["label"]) ?? "", value: shown, tone: entry["tone"], mono: entry["mono"] === true }];
  });
}

export const facts: PieceView = {
  type: "facts",
  component: ({ id, props, slate }) => {
    const list = factsOf(props["facts"]);
    if (list.length === 0) return null;
    const ink = (fact: Fact) => cn(TONE_INK[toneOf(fact.tone, slate, id)], fact.mono && "font-mono text-xs tabular-nums");
    if (props["layout"] === "grid") {
      return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px] leading-5">
          {list.map((fact, at) => (
            <div key={at} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
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
            <span className="text-muted-foreground">{fact.label}</span> <span className={ink(fact)}>{fact.value}</span>
          </span>
        ))}
      </p>
    );
  },
};
