// SPDX-License-Identifier: AGPL-3.0-only
// The disk meter at the screen's bottom right, from the agents step onward: a
// 24 px ring like the app's loader, a 2 px hairline track in the border tone
// and a 2 px arc from the top, clockwise, as long as the estimate over the
// machine's disk. No text beside it; the numbers live in its tooltip. Colour
// carries meaning only: muted under 70 percent, the warning tone from 70, the
// danger tone from 90 and when over the cap, where the ring is full. The arc
// moves to its new length in 300 ms, expo-out, unless motion is reduced.
import { CLOUD_SETUP_WORDS, initDiskLine, initDiskOverLine } from "@wsp/protocol";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";

const R = 11;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** The arc's tone by the share the estimate takes of the disk. */
export function diskTone(used: number, total: number): "muted" | "warning" | "danger" {
  const share = total > 0 ? used / total : 1;
  if (share >= 0.9) return "danger";
  return share >= 0.7 ? "warning" : "muted";
}

const STROKE: Record<ReturnType<typeof diskTone>, string> = { muted: "stroke-muted-foreground", warning: "stroke-warning-foreground", danger: "stroke-destructive-foreground" };

/** The tooltip's words: what the image holds of the disk, or by how much the ticks passed it. */
export const diskWords = (used: number, total: number): string => (used > total ? initDiskOverLine(used - total) : initDiskLine(used, total));

export function DiskRing({ used, total }: { used: number; total: number }) {
  const share = total > 0 ? Math.min(1, used / total) : 0;
  const tone = diskTone(used, total);
  return (
    <Tooltip>
      <TooltipTrigger
        data-k="disk"
        data-tone={tone}
        data-used={used}
        data-total={total}
        aria-label={`${CLOUD_SETUP_WORDS.screen.disk}: ${diskWords(used, total)}`}
        className="fixed right-5 bottom-5 z-10 flex size-6 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        render={<button type="button" />}
      >
        <svg viewBox="0 0 24 24" className="size-6 -rotate-90" aria-hidden>
          <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2" className="stroke-border" />
          <circle
            data-k="disk-arc"
            cx="12"
            cy="12"
            r={R}
            fill="none"
            strokeWidth="2"
            className={cn(STROKE[tone], "transition-[stroke-dasharray,stroke] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none")}
            strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          />
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={6}>
        {diskWords(used, total)}
      </TooltipPopup>
    </Tooltip>
  );
}
