// SPDX-License-Identifier: AGPL-3.0-only
// The two-finger swipe across the sidebar, read from the wheel events a
// trackpad sends. A wheel has no end event, so a gesture is the run of events
// with no quiet gap in it: the run's travel adds up, the crossing of the
// distance decides, and the run is spent from then on, so one swipe moves one
// space however long the fingers keep going. A run whose sideways travel does
// not clearly beat its up and down travel is somebody scrolling at an angle,
// and it moves nothing at all.

/** How far sideways a gesture travels before it counts, in the wheel's own pixels. */
export const SWIPE_TRAVEL_PX = 60;
/** How many times the up and down travel the sideways travel has to be at the crossing. */
export const SWIPE_DOMINANCE = 2;
/** The quiet that ends a gesture: a wheel event this long after the last one starts a new one. */
export const SWIPE_GAP_MS = 200;

/** What one gesture has added up so far. */
export interface SwipeGesture {
  readonly x: number;
  readonly y: number;
  /** When its last wheel event landed, on the clock the events carry. */
  readonly at: number;
  /** It moved a space, or it read as a scroll at an angle: either way it moves nothing more. */
  readonly spent: boolean;
}

export const NO_SWIPE: SwipeGesture = { x: 0, y: 0, at: 0, spent: false };

export interface WheelTravel {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly at: number;
}

/** The gesture after one wheel event, and the step it asks for: 1 for the space after this one, -1 for the one
 * before it, 0 for neither. */
export function readSwipe(gesture: SwipeGesture, wheel: WheelTravel): { gesture: SwipeGesture; step: 1 | -1 | 0 } {
  const fresh = wheel.at - gesture.at >= SWIPE_GAP_MS;
  const carried = fresh ? NO_SWIPE : gesture;
  const next: SwipeGesture = { x: carried.x + wheel.deltaX, y: carried.y + wheel.deltaY, at: wheel.at, spent: carried.spent };
  if (next.spent || Math.abs(next.x) < SWIPE_TRAVEL_PX) return { gesture: next, step: 0 };
  const sideways = Math.abs(next.x) > SWIPE_DOMINANCE * Math.abs(next.y);
  return { gesture: { ...next, spent: true }, step: sideways ? (next.x > 0 ? 1 : -1) : 0 };
}
