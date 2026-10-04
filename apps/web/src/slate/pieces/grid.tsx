// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { groupLook } from "./look.js";

/** Columns from 360 px of the grid's own width; under it, one column. Whole class names, so Tailwind finds them. */
const COLUMNS: Record<number, string> = { 2: "@min-[360px]:grid-cols-2", 3: "@min-[360px]:grid-cols-3", 4: "@min-[360px]:grid-cols-4" };
const GAP: Record<string, string> = { tight: "gap-2", normal: "gap-4", loose: "gap-6" };
const PLACE: Record<string, string> = { start: "justify-items-start", center: "justify-items-center text-center", end: "justify-items-end text-right" };

export const grid: PieceView = {
  type: "grid",
  component: ({ props, children }) => (
    <div data-slate-grid className={cn("@container min-w-0", groupLook({ ...props, align: undefined }))}>
      <div
        data-columns={props["columns"]}
        className={cn("grid min-w-0 grid-cols-1", COLUMNS[Number(props["columns"])] ?? COLUMNS[2], GAP[String(props["gap"] ?? "normal")], PLACE[String(props["align"])])}
      >
        {children}
      </div>
    </div>
  ),
};
