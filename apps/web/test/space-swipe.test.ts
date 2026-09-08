// SPDX-License-Identifier: AGPL-3.0-only
// The two-finger swipe read out of a trackpad's wheel events: how far it has
// to travel, how much that travel has to beat the up and down travel by, that
// one gesture moves one space however many events it is made of, and that the
// quiet between two swipes is what tells them apart.
import { describe, expect, it } from "vitest";
import { NO_SWIPE, SWIPE_GAP_MS, SWIPE_TRAVEL_PX, readSwipe, type SwipeGesture } from "../src/sidebar/spaceSwipe.js";

/** A run of wheel events with no quiet in it, as one gesture: the steps each event asked for. */
function gesture(events: ReadonlyArray<{ x: number; y?: number }>, from: SwipeGesture = NO_SWIPE, startAt = 1_000): { steps: number[]; gesture: SwipeGesture } {
  let held = from;
  const steps = events.map((event, i) => {
    const read = readSwipe(held, { deltaX: event.x, deltaY: event.y ?? 0, at: startAt + i * 16 });
    held = read.gesture;
    return read.step;
  });
  return { steps, gesture: held };
}

describe("the swipe between spaces", () => {
  it("moves nothing until the sideways travel passes the threshold, then moves one space", () => {
    const short = gesture([{ x: 10 }, { x: 20 }, { x: 20 }]);
    expect(short.steps).toEqual([0, 0, 0]);
    expect(short.gesture.x).toBe(50);
    // The event that carries it past the threshold is the one that moves.
    const crossed = gesture([{ x: 10 }, { x: 20 }, { x: 20 }, { x: 20 }]);
    expect(crossed.steps).toEqual([0, 0, 0, 1]);
  });

  it("the direction is the way the fingers went", () => {
    expect(gesture([{ x: SWIPE_TRAVEL_PX }]).steps).toEqual([1]);
    expect(gesture([{ x: -SWIPE_TRAVEL_PX }]).steps).toEqual([-1]);
  });

  it("one gesture moves one space however long the fingers keep going", () => {
    const long = gesture([{ x: 80 }, { x: 80 }, { x: 80 }, { x: 80 }]);
    expect(long.steps).toEqual([1, 0, 0, 0]);
    expect(long.gesture.spent).toBe(true);
  });

  it("a scroll at an angle moves nothing, and keeps moving nothing as it goes on", () => {
    const diagonal = gesture([{ x: 40, y: 30 }, { x: 40, y: 30 }, { x: 80, y: 0 }]);
    expect(diagonal.steps).toEqual([0, 0, 0]);
    // A plain scroll down the sidebar never comes near it.
    expect(gesture([{ x: 0, y: 120 }, { x: 4, y: 120 }]).steps).toEqual([0, 0]);
  });

  it("the quiet between two swipes is what tells them apart", () => {
    const first = readSwipe(NO_SWIPE, { deltaX: 80, deltaY: 0, at: 1_000 });
    expect(first.step).toBe(1);
    // Still the same gesture: the travel adds up and nothing moves.
    const tail = readSwipe(first.gesture, { deltaX: 80, deltaY: 0, at: 1_000 + SWIPE_GAP_MS - 1 });
    expect(tail.step).toBe(0);
    const second = readSwipe(tail.gesture, { deltaX: 80, deltaY: 0, at: tail.gesture.at + SWIPE_GAP_MS });
    expect(second.step).toBe(1);
    expect(second.gesture.x).toBe(80);
  });
});
