// SPDX-License-Identifier: AGPL-3.0-only
// The transcript's footer changes height where the list sees no row move (the Threads section shutting, in this
// window or another). The list then measures the rows that shift into view, which it had only estimated, and holds
// them still rather than the end, since its own end flag read the footer's old size. So a reader at the end as the
// footer shrinks is held there through the list's resizes for a moment, until the reader moves the view themselves.
// A footer that grows (the section opening) is left alone: it opens downward from where the reader pressed.

/** How long a reader at the end is held there after the footer shrinks, past the list's own measuring of the rows. */
export const FOOTER_SETTLE_MS = 500;

/** The reader's own hand on the view, which ends a hold at once. */
const READER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Holds the end of `scroller` through a shrink of `footer` and the resizes of `content` after it; answers the undo. */
export function holdEndOnFooterShrink(footer: HTMLElement, scroller: HTMLElement, content: Element): () => void {
  let holdUntil = 0;
  const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  // Where the reader stood at the last scroll, read off the scroller itself: the footer's resize can be told only
  // after the list has grown the rows above it, and the list's own flag reads its stale sizes.
  let lastGap = gap();
  const scrolled = () => {
    lastGap = gap();
  };
  const letGo = () => {
    holdUntil = 0;
  };
  const pin = () => {
    if (performance.now() < holdUntil) scroller.scrollTop = scroller.scrollHeight;
  };
  let height = footer.offsetHeight;
  const footerSized = new ResizeObserver(() => {
    if (footer.offsetHeight < height && (lastGap < 2 || gap() < 2)) holdUntil = performance.now() + FOOTER_SETTLE_MS;
    height = footer.offsetHeight;
    pin();
  });
  const contentSized = new ResizeObserver(pin);
  scroller.addEventListener("scroll", scrolled, { passive: true });
  for (const input of READER_INPUT) scroller.addEventListener(input, letGo, { passive: true });
  footerSized.observe(footer);
  contentSized.observe(content);
  return () => {
    scroller.removeEventListener("scroll", scrolled);
    for (const input of READER_INPUT) scroller.removeEventListener(input, letGo);
    footerSized.disconnect();
    contentSized.disconnect();
  };
}
