// SPDX-License-Identifier: AGPL-3.0-only
// How long the one sentence in the sidebar's foot stays, and the label on the
// glyph that takes it away sooner. A toast used to stand until another replaced
// it: one sat in the corner for four minutes, another for a whole session
// across every page its reader visited. It says what happened once and goes.
import { useEffect } from "react";

/** Long enough to read a sentence and press its button, short enough that nothing a person did not ask for is
 * still on the screen on the next page. */
export const TOAST_MS = 8_000;

export const CLOSE_TOAST_LABEL = "Close this message";

/** Clears the toast a few seconds after it appears. Keyed on the words, so a second sentence taking the slot gets
 * its own few seconds rather than the remainder of the first one's. */
export function useToastLife(toast: string | null, clear: () => void): void {
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(clear, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, clear]);
}
