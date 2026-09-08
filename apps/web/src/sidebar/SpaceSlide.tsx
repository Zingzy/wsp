// SPDX-License-Identifier: AGPL-3.0-only
// The move from one space to the next: the body that was on screen travels
// out the way it was pushed while the one asked for comes in from the other
// side, and the sidebar's own header and its dots row stay where they are.
// The workspace that left is still drawn until the travel ends, so while it
// is on screen it is held off the accessibility tree and out of the
// keyboard's reach; the traversal skips it by the same mark. A space asked
// for while a travel is still running turns that travel around from where the
// track has got to. Someone who asked for less motion gets the swap with
// nothing moving.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { cn } from "../lib/utils.js";

/** How long the body travels. The clock that ends the travel and the animation that draws it are one number, so it
 * has one home: the track carries it into the stylesheet as a custom property. */
export const SPACE_SLIDE_MS = 200;

/** The mark on the body that is leaving, which the sidebar's keyboard traversal walks past. */
export const SPACE_LEAVING_SELECTOR = "[data-space-leaving]";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

interface Travel {
  readonly leavingId: string;
  /** The space asked for sits after the one leaving in the sidebar's order, so the body travels left. */
  readonly forward: boolean;
  /** Where the track already is, when this travel turned a running one around; null starts it at the far side,
   * which is where a track at rest is drawn anyway. */
  readonly from: string | null;
}

export function SpaceSlide({ currentId, order, children }: { currentId: string; order: ReadonlyArray<string>; children: (workspaceId: string) => ReactNode }) {
  const still = useMediaQuery(REDUCED_MOTION);
  const track = useRef<HTMLDivElement>(null);
  const [travel, setTravel] = useState<Travel | null>(null);
  const [shown, setShown] = useState(currentId);

  // The travel is worked out in the render that first sees the new workspace, never in an effect a second change can
  // outrun: a travel still naming the workspace now on screen would draw that one body as both panes, under one key.
  // The track is read here for the same reason, since by the time an effect runs the animation it was drawn by is
  // already gone.
  if (shown !== currentId) {
    setShown(currentId);
    setTravel(still ? null : travelBetween(shown, currentId, order, travel, track.current));
  }

  useEffect(() => {
    if (travel === null) return;
    const timer = window.setTimeout(() => setTravel(null), SPACE_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [travel]);

  const panes = travel === null ? [currentId] : travel.forward ? [travel.leavingId, currentId] : [currentId, travel.leavingId];
  const style = {
    "--space-slide-ms": `${SPACE_SLIDE_MS}ms`,
    ...(travel !== null && travel.from !== null ? { "--space-slide-from": travel.from } : {}),
  } as CSSProperties;
  return (
    <div data-space-slide className="overflow-x-clip">
      <div
        ref={track}
        data-space-track
        style={style}
        className={cn("flex w-[200%]", travel !== null && (travel.forward ? "animate-space-slide-forward" : "animate-space-slide-back"))}
      >
        {panes.map(id => {
          const leaving = id !== currentId;
          return (
            <div key={id} data-space-pane data-space-leaving={leaving ? "" : undefined} aria-hidden={leaving || undefined} inert={leaving} className="w-1/2 shrink-0">
              {children(id)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The travel from the workspace that was on screen to the one asked for: which way it goes in the sidebar's order,
 * and where it starts. Null when the order has lost either of them, since neither pane would have a place to be. */
function travelBetween(leavingId: string, currentId: string, order: ReadonlyArray<string>, running: Travel | null, track: HTMLElement | null): Travel | null {
  const from = order.indexOf(leavingId);
  const to = order.indexOf(currentId);
  if (from === -1 || to === -1) return null;
  // Turning a running travel around leaves the two bodies in the places they already hold, so the new one starts
  // where the track has got to; a travel to a third space has no such place to pick up from.
  const turning = running !== null && running.leavingId === currentId;
  const at = turning ? trackOffset(track) : null;
  return { leavingId, forward: to > from, from: at === null ? null : `${at}px` };
}

/** How far the running animation has drawn the track from its own origin; null where nothing has moved it, or where
 * the browser reports a shape this cannot read, and the travel starts at the far side instead. */
function trackOffset(track: HTMLElement | null): number | null {
  if (track === null) return null;
  const matrix = /^matrix\(([^)]*)\)$/.exec(getComputedStyle(track).transform);
  const x = matrix === null ? Number.NaN : Number(matrix[1]?.split(",")[4]);
  return Number.isFinite(x) ? x : null;
}
