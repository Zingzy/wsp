// SPDX-License-Identifier: AGPL-3.0-only
// The one frame loop the crabs draw from holds still while the page scrolls: a window composited in software spent
// frames of over 50 ms redrawing every working crab under a scrolling transcript, and none once they held still.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onFrame, SCROLL_HOLD_MS } from "../src/lib/frames.js";

let queued: FrameRequestCallback[] = [];
const runFrame = (now: number): void => {
  const run = queued;
  queued = [];
  for (const callback of run) callback(now);
};

beforeEach(() => {
  queued = [];
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queued.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {
    queued = [];
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the frame loop under a scroll", () => {
  it("draws nothing while anything on the page scrolls, and draws again once it has stood still", () => {
    const crab = document.body.appendChild(document.createElement("canvas"));
    const list = document.body.appendChild(document.createElement("div"));
    const draw = vi.fn();
    const stop = onFrame(crab, draw);
    runFrame(performance.now());
    expect(draw).toHaveBeenCalledTimes(1);
    list.dispatchEvent(new Event("scroll"));
    const at = performance.now();
    runFrame(at + 16);
    runFrame(at + SCROLL_HOLD_MS - 1);
    expect(draw).toHaveBeenCalledTimes(1);
    runFrame(at + SCROLL_HOLD_MS + 1);
    expect(draw).toHaveBeenCalledTimes(2);
    stop();
    expect(queued).toHaveLength(0);
  });
});
