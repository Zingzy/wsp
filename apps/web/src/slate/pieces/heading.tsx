// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { SlateIcon } from "./icon.js";
import { str } from "./look.js";

/** The type ladder's three heading steps: the page title, the settings section head, and a small-caps label. */
const LEVEL: Record<string, { text: string; icon: string; aria: number }> = {
  title: { text: "text-lg leading-7 font-medium tracking-[-0.01em] text-foreground", icon: "size-4 text-foreground/80", aria: 2 },
  section: { text: "text-sm leading-7 text-foreground/70", icon: "size-3.5", aria: 3 },
  label: { text: "text-[13px] leading-5 text-muted-foreground [font-variant-caps:all-small-caps] tracking-[0.04em]", icon: "size-3", aria: 4 },
};

export const heading: PieceView = {
  type: "heading",
  component: ({ props }) => {
    const level = LEVEL[String(props["level"] ?? "section")] ?? LEVEL["section"]!;
    return (
      <div role="heading" aria-level={level.aria} className={cn("flex min-w-0 items-center gap-2", level.text)}>
        <SlateIcon name={props["icon"]} className={level.icon} />
        <span className="min-w-0 break-words">{str(props["value"])}</span>
      </div>
    );
  },
};
