// SPDX-License-Identifier: AGPL-3.0-only
// The card's one empty line: one quiet sentence on the one left edge, its one button in the row's slot.
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";

export const empty: PieceView = {
  type: "empty",
  component: ({ props, children }) => {
    const title = str(props["title"]) ?? "";
    const body = str(props["body"]);
    const sentence = body === undefined || body === "" ? title : `${title}${/[.!?]$/.test(title) ? "" : "."} ${body}`;
    return (
    <div data-slate-empty-line className="flex min-w-0 items-center justify-between gap-4">
      <p className="min-w-0 max-w-xl text-[13px] leading-[1.45] text-muted-foreground">{sentence}</p>
      <div className="flex shrink-0 items-center gap-2 empty:hidden">{children}</div>
    </div>
    );
  },
};
