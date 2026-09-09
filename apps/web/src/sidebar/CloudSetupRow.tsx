// SPDX-License-Identifier: AGPL-3.0-only
// The quiet row at the sidebar's bottom while no golden is sealed: a hairline
// above it, the cloud glyph and the words centred in mono, muted. The glyph
// alone carries a faint halo in the accent, the one glow the design law allows;
// the hover lifts the text one tone and the halo one step, and nothing moves at
// rest. While the init job runs with the modal shut, the words are its
// progress line. It is the one door to cloud machines in the app, and what it
// opens lives in CloudSetupDialog; a modal open when the seal lands stays up
// on its done screen, and the row goes once it is shut.
import { CLOUD_SETUP_WORDS, initJobOver, initProgressLine } from "@wsp/protocol";
import { CloudIcon } from "lucide-react";
import { useState } from "react";
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
  const running = job !== null && !initJobOver(job.phase);
  if (hasGolden !== false) return <CloudSetupDialog onClose={() => setOpen(false)} />;
  return (
    <div data-cloud-setup className="border-t border-sidebar-border/60 pt-1">
      <button
        type="button"
        data-cloud-setup-row
        aria-label={CLOUD_SETUP_WORDS.row}
        onClick={() => setOpen(true)}
        className="group flex h-8 w-full cursor-pointer items-center justify-center gap-2 rounded-md font-mono text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors duration-150 hover:text-sidebar-foreground focus-visible:ring-2"
      >
        <CloudIcon aria-hidden className={`size-3.5 shrink-0 transition-[filter] duration-150 ${HALO} ${HALO_HOVER}`} />
        <span data-cloud-setup-words className="truncate">
          {running ? initProgressLine(job) : CLOUD_SETUP_WORDS.row}
        </span>
      </button>
      {open ? <CloudSetupDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
