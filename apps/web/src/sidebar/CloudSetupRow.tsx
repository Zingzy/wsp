// SPDX-License-Identifier: AGPL-3.0-only
// The one button in the sidebar's foot while no golden is sealed: the kit's
// keycap at full width, the cloud glyph and the words centred in mono, muted.
// The glyph alone carries a faint halo in the accent, the one glow the design
// law allows; the hover lifts the fill one step and the words one tone, and
// nothing moves. While the init job runs with the modal shut the button is
// alive: the app's spinner in the glyph's place, the words its stage and count,
// and a 2 px line inside the bottom edge as far as the stages done; a job that
// waits on the person pauses the spinner and says so. Reduced motion stops the
// spinner and keeps the line. It is the one door to cloud machines in the app, and what it
// opens lives in CloudSetupDialog; a modal open when the seal lands stays up
// on its done screen, and the button goes once it is shut.
import { CLOUD_SETUP_WORDS, initButtonLine, initJobOver, initProgressState } from "@wsp/protocol";
import { CloudIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { CloudSetupDialog } from "./CloudSetupDialog.js";

/** The halo at rest and on hover: the accent at low alpha, 6 px soft, then a step brighter and wider. */
const HALO = "drop-shadow-[0_0_6px_color-mix(in_oklab,var(--primary)_35%,transparent)]";
const HALO_HOVER = "group-hover:drop-shadow-[0_0_8px_color-mix(in_oklab,var(--primary)_60%,transparent)]";

export function CloudSetupRow() {
  const hasGolden = useStore(s => s.hasGolden);
  const job = useStore(s => s.initJob);
  const [open, setOpen] = useState(false);
  if (hasGolden !== false && !open) return null;
  if (hasGolden !== false) return <CloudSetupDialog onClose={() => setOpen(false)} />;
  const live = job !== null && !initJobOver(job.phase) ? { line: initButtonLine(job), ...initProgressState(job) } : null;
  return (
    <div data-cloud-setup className="p-1">
      <Button
        variant="keycap"
        data-cloud-setup-row
        aria-label={CLOUD_SETUP_WORDS.row}
        onClick={() => setOpen(true)}
        className="group h-8 w-full gap-1.5 overflow-hidden px-1.5 font-mono text-[13px] font-normal text-sidebar-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-sidebar-foreground sm:text-[13px]"
      >
        {live !== null ? (
          <Spinner aria-hidden className={cn("size-3.5 shrink-0 motion-reduce:animate-none", live.waitingOnYou && "[animation-play-state:paused]")} />
        ) : (
          <CloudIcon aria-hidden className={`size-3.5 shrink-0 transition-[filter] duration-150 ${HALO} ${HALO_HOVER}`} />
        )}
        <span data-cloud-setup-words className="truncate">
          {live !== null ? live.line : CLOUD_SETUP_WORDS.row}
        </span>
        {live !== null ? (
          <span
            data-cloud-setup-progress
            role="progressbar"
            aria-label={live.line}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(live.fraction * 100)}
            className="absolute bottom-0 left-0 h-0.5 bg-sidebar-muted-foreground transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${Math.round(live.fraction * 100)}%` }}
          />
        ) : null}
      </Button>
      {open ? <CloudSetupDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
