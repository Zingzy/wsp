// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { gapOf } from "./look.js";

const ALIGN: Record<string, string> = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" };
/** With no align set, the buttons after the row's text sit at its end. */
const ENDS = "[&>:not([data-slate-type=button])+[data-slate-type=button]]:ml-auto";

export const row: PieceView = {
  type: "row",
  component: ({ props, children }) => (
    <div
      className={cn(
        "flex min-w-0 flex-row items-center",
        gapOf(props["gap"]),
        ALIGN[String(props["align"] ?? "start")] ?? ALIGN["start"],
        props["align"] === undefined && ENDS,
        props["wrap"] === false ? "flex-nowrap *:min-w-0 *:shrink" : "flex-wrap",
      )}
    >
      {children}
    </div>
  ),
};
