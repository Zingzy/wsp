// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { str, TONE_FILL, toneOf } from "./look.js";

export const status: PieceView = {
  type: "status",
  component: ({ id, props, slate }) => {
    const tone = toneOf(props["tone"], slate, id);
    return (
      <span data-slate-status={tone} className={cn("inline-flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-foreground", tone !== "default" && tone !== "muted" && "font-medium")}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone === "default" ? "bg-foreground/55" : TONE_FILL[tone])} />
        <span className="truncate">{str(props["value"])}</span>
      </span>
    );
  },
};
