// SPDX-License-Identifier: AGPL-3.0-only
// A short fact: a word in the foreground, 12 px from its neighbour, never framed.
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";

export const chip: PieceView = {
  type: "chip",
  component: ({ props }) => {
    const text = str(props["value"]);
    if (text === undefined || text === "") return null;
    return (
      <span data-slate-chip className="inline-flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-foreground">
        <span className="min-w-0 break-words">{text}</span>
      </span>
    );
  },
};
