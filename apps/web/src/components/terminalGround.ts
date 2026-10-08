// SPDX-License-Identifier: AGPL-3.0-only
import { type RefObject, useLayoutEffect } from "react";

/** The terminal viewports that show the window's glass through their canvas. Every element above one carries
 * data-terminal-ground, which index.css clears so the glass reaches the canvas: a :has() asking each element instead
 * restyled the whole page on every keystroke. */
const viewports = new Set<HTMLElement>();

function markGrounds(): void {
  for (const element of document.querySelectorAll("[data-terminal-ground]")) element.removeAttribute("data-terminal-ground");
  for (const viewport of viewports) {
    for (let element = viewport.parentElement; element !== null; element = element.parentElement) element.setAttribute("data-terminal-ground", "");
  }
}

export function useTerminalGround(ref: RefObject<HTMLElement | null>, translucent: boolean): void {
  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!translucent || viewport === null) return;
    viewports.add(viewport);
    markGrounds();
    return () => {
      viewports.delete(viewport);
      markGrounds();
    };
  }, [ref, translucent]);
}
