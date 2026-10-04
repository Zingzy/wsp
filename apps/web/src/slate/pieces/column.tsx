// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { gapOf, groupLook } from "./look.js";

const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" };

export const column: PieceView = {
  type: "column",
  component: ({ props, children }) => (
    <div className={cn("flex min-w-0 flex-col", gapOf(props["gap"]), ALIGN[String(props["align"] ?? "stretch")] ?? ALIGN["stretch"], groupLook({ pad: props["pad"], surface: props["surface"] }))}>{children}</div>
  ),
};
