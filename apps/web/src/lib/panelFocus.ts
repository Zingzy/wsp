// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's focus, read off the page: whether the person is working
// inside it with more than one tab to step between, and the move that puts the
// focus inside the tab just opened. The tab strip is what the person sees, so
// a side question standing over the strip leaves the panel with no tabs here.
const PANEL_SELECTOR = "[data-preview-panel-mode]";

/** Focus is inside the right panel, a terminal in it included, and its tab strip holds more than one tab. */
export function isPanelTabsFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.isConnected) return false;
  const panel = active.closest(PANEL_SELECTOR);
  return panel !== null && panel.querySelectorAll("[data-right-panel-tab-list] [data-active-tab]").length > 1;
}

/** Puts the focus inside the panel's open tab once it has drawn, unless the tab already holds it. A terminal takes
 * it itself when its surface is ready, which can land after this. */
export function focusPanelSurface(): void {
  window.requestAnimationFrame(() => {
    const content = document.querySelector<HTMLElement>(`${PANEL_SELECTOR} [data-right-panel-surface-content]`);
    if (content !== null && !content.contains(document.activeElement)) content.focus({ preventScroll: true });
  });
}
