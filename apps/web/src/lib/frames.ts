// SPDX-License-Identifier: AGPL-3.0-only
// The one animation frame loop every moving canvas draws from: the crabs and the empty thread's field. Only what is
// on screen is drawn, and with nothing on screen no frame is asked for; a hidden window gets no frames from the
// browser at all. Without an IntersectionObserver everything counts as on screen.

const drawn = new Map<Element, { draw: (now: number) => void; seen: boolean }>();
let frame = 0;
let sight: IntersectionObserver | undefined;

function tick(now: number): void {
  frame = 0;
  for (const d of drawn.values()) if (d.seen) d.draw(now);
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
  };
}
