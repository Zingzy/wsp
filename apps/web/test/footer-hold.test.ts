// SPDX-License-Identifier: AGPL-3.0-only
// The hold on the transcript's end through a footer that shrinks, on a scroller whose sizes the test sets: the
// browser's clamp, the list growing the rows it had only estimated, and the reader's own wheel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOOTER_SETTLE_MS, holdEndOnFooterShrink } from "../src/components/chat/footerHold.js";

const CLIENT = 800;

/** A scroller, its content and its footer, sized by hand, and each resize observer told by hand. */
function stage() {
  const observers = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly told: () => void) {}
      observe(el: Element) {
        observers.set(el, this.told);
      }
      disconnect() {}
    },
  );
  const scroller = document.createElement("div");
  const content = document.createElement("div");
  const footer = document.createElement("div");
  scroller.append(content);
  content.append(footer);
  const size = { height: 2194, top: 2194 - CLIENT, footer: 768 };
  const clamp = () => (size.top = Math.max(0, Math.min(size.top, size.height - CLIENT)));
  Object.defineProperty(scroller, "scrollHeight", { get: () => size.height });
  Object.defineProperty(scroller, "clientHeight", { get: () => CLIENT });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => size.top,
    set: (top: number) => {
      size.top = top;
      clamp();
    },
  });
  Object.defineProperty(footer, "offsetHeight", { get: () => size.footer });
  const scroll = () => scroller.dispatchEvent(new Event("scroll"));
  return {
    size,
    scroller,
    gap: () => size.height - size.top - CLIENT,
    stop: holdEndOnFooterShrink(footer, scroller, content),
    /** The footer goes from `from` to `to` high: the content with it, the browser's clamp and its scroll, then the
     * footer's resize told. */
    footerTo(to: number) {
      size.height += to - size.footer;
      size.footer = to;
      const before = size.top;
      clamp();
      if (size.top !== before) scroll();
      observers.get(footer)!();
    },
    /** The list lays out rows it had estimated: the content grows and the list keeps its rows still, a few px up. */
    listGrows(by: number, nudge = -25) {
      size.height += by;
      size.top += nudge;
      clamp();
      observers.get(content)!();
      scroll();
    },
    scroll,
  };
}

describe("the hold on the transcript's end through a footer that shrinks", () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a reader at the end there while the list grows the rows the shrink brought into view", () => {
    const s = stage();
    s.footerTo(72);
    expect(s.gap()).toBe(0);
    now += 40;
    s.listGrows(404);
    expect(s.gap()).toBe(0);
    s.stop();
  });

  it("lets go once the hold's moment is over", () => {
    const s = stage();
    s.footerTo(72);
    now += FOOTER_SETTLE_MS + 1;
    s.listGrows(404);
    expect(s.gap()).toBe(429);
    s.stop();
  });

  it("lets the reader's own wheel 30 ms after the shut keep its 400 px", () => {
    const s = stage();
    s.footerTo(72);
    now += 30;
    s.scroller.dispatchEvent(new Event("wheel"));
    s.size.top -= 400;
    s.scroll();
    now += 15;
    s.listGrows(0, 0);
    expect(s.gap()).toBe(400);
    s.stop();
  });

  it("ends on a touch, a press or a key as on a wheel", () => {
    for (const input of ["touchstart", "pointerdown", "keydown"]) {
      const s = stage();
      s.footerTo(72);
      s.scroller.dispatchEvent(new Event(input));
      s.size.top -= 400;
      s.scroll();
      s.listGrows(0, 0);
      expect(s.gap(), input).toBe(400);
      s.stop();
    }
  });

  it("holds nothing for a footer that grows, nor for a reader above the end", () => {
    const opening = stage();
    opening.footerTo(72);
    now += FOOTER_SETTLE_MS + 1;
    opening.footerTo(768);
    expect(opening.gap()).toBe(696);
    opening.listGrows(100);
    expect(opening.gap()).toBe(821);
    opening.stop();
    const above = stage();
    above.size.top -= 900;
    above.scroll();
    above.footerTo(72);
    above.listGrows(404);
    expect(above.gap()).toBe(404 + 25 + 900 - 696);
    above.stop();
  });
});
