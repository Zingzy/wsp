// SPDX-License-Identifier: AGPL-3.0-only
// The move from one space to the next: the body that was on screen travels
// out the way it was pushed while the one asked for comes in from the other
// side, and the sidebar's own header and its dots row stay where they are.
// The workspace that left is still drawn until the travel ends, so while it
// is on screen it is held off the accessibility tree and out of the
// keyboard's reach; the traversal skips it by the same mark. Someone who
// asked for less motion gets the swap with nothing moving.
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
}

export function SpaceSlide({ currentId, order, children }: { currentId: string; order: ReadonlyArray<string>; children: (workspaceId: string) => ReactNode }) {
  const travel = useSpaceTravel(currentId, order);
  const panes = travel === null ? [currentId] : travel.forward ? [travel.leavingId, currentId] : [currentId, travel.leavingId];
  return (
    <div data-space-slide className="overflow-x-hidden">
      <div
        data-space-track
        style={{ "--space-slide-ms": `${SPACE_SLIDE_MS}ms` } as CSSProperties}
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

/** The workspace that just left and which way it went, for as long as the body is travelling; null while it rests,
 * and for a reader who asked for less motion, whose body swaps with no travel at all. */
function useSpaceTravel(currentId: string, order: ReadonlyArray<string>): Travel | null {
  const still = useMediaQuery(REDUCED_MOTION);
  const [travel, setTravel] = useState<Travel | null>(null);
  const was = useRef(currentId);
  // The order is read at the moment a space changes, not tracked: a workspace landing elsewhere in it must not start
  // a travel of its own.
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    const leavingId = was.current;
    was.current = currentId;
    if (still || leavingId === currentId) return;
    const from = orderRef.current.indexOf(leavingId);
    const to = orderRef.current.indexOf(currentId);
    if (from === -1 || to === -1) return;
    setTravel({ leavingId, forward: to > from });
    const timer = window.setTimeout(() => setTravel(null), SPACE_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [currentId, still]);
  return travel;
}
