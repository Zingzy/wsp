// SPDX-License-Identifier: AGPL-3.0-only
// The one animation frame loop every moving canvas draws from: the crabs and the empty thread's field. Only what is
// on screen is drawn, and with nothing on screen no frame is asked for; a hidden window gets no frames from the
// browser at all. Without an IntersectionObserver everything counts as on screen.

const drawn = new Map<Element, { draw: (now: number) => void; seen: boolean }>();
let frame = 0;
let sight: IntersectionObserver | undefined;

/** How long the canvases hold still after the last scroll anywhere on the page. A window composited in software spent
 * frames of over 50 ms redrawing every crab under a scroll that was already repainting what moved. */
export const SCROLL_HOLD_MS = 150;
let scrolledAt = -Infinity;
const scrolled = (): void => {
  scrolledAt = performance.now();
};

function tick(now: number): void {
  frame = 0;
  if (now - scrolledAt >= SCROLL_HOLD_MS) for (const d of drawn.values()) if (d.seen) d.draw(now);
  wake();
}

function wake(): void {
  if (frame !== 0) return;
  for (const d of drawn.values()) {
    if (!d.seen) continue;
    frame = requestAnimationFrame(tick);
    return;
  }
}

/** Calls `draw` with the frame's time on every frame while `el` is on screen; the answer stops it. */
export function onFrame(el: Element, draw: (now: number) => void): () => void {
  sight ??=
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver(entries => {
          for (const e of entries) {
            const d = drawn.get(e.target);
            if (d !== undefined) d.seen = e.isIntersecting;
          }
          wake();
        });
  if (drawn.size === 0) document.addEventListener("scroll", scrolled, { capture: true, passive: true });
  drawn.set(el, { draw, seen: sight === undefined });
  sight?.observe(el);
  wake();
  return () => {
    drawn.delete(el);
    sight?.unobserve(el);
    if (drawn.size > 0) return;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    sight?.disconnect();
    sight = undefined;
    document.removeEventListener("scroll", scrolled, { capture: true });
  };
}
