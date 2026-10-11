// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for an act that cannot be undone and takes two presses with no
// dialog: the first press arms it, and a second within ARM_MS confirms. The
// Processes pane's kill and every Stop on a row read it.

export const ARM_MS = 2000;

/** Whether an arm taken at `at` still stands at `now`. */
export const stillArmed = (at: number, now: number): boolean => now - at < ARM_MS;
