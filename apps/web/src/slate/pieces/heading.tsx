// SPDX-License-Identifier: AGPL-3.0-only
// A heading is a section-style quiet head at every level it names: the panel has no 18 px title and no small caps.
import type { PieceView } from "../SlateView.js";
import { SECTION_HEAD } from "../../settings/layout.js";
import { cn } from "../../lib/utils.js";
import { str } from "./look.js";

const ARIA: Record<string, number> = { title: 2, section: 3, label: 4 };

export const heading: PieceView = {
  type: "heading",
  component: ({ props }) => (
    <div role="heading" aria-level={ARIA[String(props["level"] ?? "section")] ?? 3} className={cn(SECTION_HEAD, "min-w-0 break-words")}>
      {str(props["value"])}
    </div>
  ),
};
