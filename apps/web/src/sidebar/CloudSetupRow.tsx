// SPDX-License-Identifier: AGPL-3.0-only
// The one button in the sidebar's foot while this computer is the only one a
// person has: the kit's keycap at full width, the cloud glyph and the words
// centred in mono, muted. It opens Settings with the Add a computer sheet over
// it, and it goes once a second computer or a provider exists, since from then
// on that road is in Settings where the rest of them are. Nothing is drawn until
// the host has said what it has: a foot that fills and empties on every load is
// worse than one that fills a moment late. The glyph alone
// carries a faint halo in the accent, the one glow the design law allows; the
// hover lifts the fill one step and the words one tone, and nothing moves.
//
// While the image build runs with its screens shut the button is that build
// instead: the app's spinner in the glyph's place, the words its stage and
// count, a 2 px line inside the bottom edge as far as the stages done, and a
// press that opens the screens it is running under. A job that waits on the
// person turns the whole keycap to the warning tone, pauses the spinner and
// says so. Reduced motion stops the spinner and keeps the line. A running build
// keeps the keycap on the foot whatever else a person has, since nothing else
// in the window carries it.
import { PLACES_WORDS, initButtonLine, initJobOver, initProgressState } from "@wsp/protocol";
import { CloudIcon } from "lucide-react";
import { Button, WARN_BUTTON } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { askToNotify } from "../shell/needsYou.js";
import { CloudSetupDialog } from "./CloudSetupDialog.js";

/** The halo at rest and on hover: the accent at low alpha, 6 px soft, then a step brighter and wider. */
const HALO = "drop-shadow-[0_0_6px_color-mix(in_oklab,var(--primary)_35%,transparent)]";
const HALO_HOVER = "group-hover:drop-shadow-[0_0_8px_color-mix(in_oklab,var(--primary)_60%,transparent)]";

export function CloudSetupRow() {
  const places = useStore(s => s.places);
  const placesRead = useStore(s => s.placesRead);
  const job = useStore(s => s.initJob);
  const open = useStore(s => s.setupOpen);
  const openSetup = useStore(s => s.openSetup);
  const openAddComputer = useStore(s => s.openAddComputer);
  const closeSetup = useStore(s => s.closeSetup);
  const live = job !== null && !initJobOver(job.phase) ? { line: initButtonLine(job), ...initProgressState(job) } : null;
  // This computer is always the first row, so a second one is a computer joined or a provider connected. Until the
  // host has answered about that list there is nothing to draw: a keycap drawn on a guess appears on every load and
  // goes again a moment later on every wsp that has a second row.
  const alone = placesRead && places.length < 2;
  if (!alone && live === null) return open ? <CloudSetupDialog onClose={closeSetup} /> : null;
  return (
    <div data-cloud-setup className="p-1">
      <Button
        variant="keycap"
        data-cloud-setup-row
        data-waiting-on-you={live?.waitingOnYou === true ? "" : undefined}
        aria-label={live !== null ? live.line : PLACES_WORDS.addComputer}
        onClick={() => {
          // The press is the gesture a browser wants before it will really ask about notifications, and the build
          // this button can carry goes through it.
          askToNotify();
          if (live !== null) openSetup();
          else openAddComputer();
        }}
        className={cn(
          "group h-8 w-full gap-1.5 overflow-hidden px-1.5 font-mono text-[13px] font-normal transition-[color,background-color,box-shadow] duration-150 sm:text-[13px]",
          live?.waitingOnYou === true ? WARN_BUTTON : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
        )}
      >
        {live !== null ? (
          <Spinner aria-hidden className={cn("size-3.5 shrink-0 motion-reduce:animate-none", live.waitingOnYou && "[animation-play-state:paused]")} />
        ) : (
          <CloudIcon aria-hidden className={`size-3.5 shrink-0 transition-[filter] duration-150 ${HALO} ${HALO_HOVER}`} />
        )}
        <span data-cloud-setup-words className="truncate">
          {live !== null ? live.line : PLACES_WORDS.addComputer}
        </span>
        {live !== null ? (
          <span
            data-cloud-setup-progress
            role="progressbar"
            aria-label={live.line}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(live.fraction * 100)}
            className={cn("absolute bottom-0 left-0 h-0.5 transition-[width] duration-300 motion-reduce:transition-none", live.waitingOnYou ? "bg-warning" : "bg-sidebar-muted-foreground")}
            style={{ width: `${Math.round(live.fraction * 100)}%` }}
          />
        ) : null}
      </Button>
      {open ? <CloudSetupDialog onClose={closeSetup} /> : null}
    </div>
  );
}
