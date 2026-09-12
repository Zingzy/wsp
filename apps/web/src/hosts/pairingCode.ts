// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for a pairing code in a field: what it looks like as a person
// types it, and what it looks like on the wire. It sits apart from the sheet
// that draws the field because two other places read it: the shell's first-run
// join screen, which is one html file with no build step and carries a copy of
// these lines with this file named beside them, and the test that holds that
// copy to this one.
import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from "@wsp/protocol";

const NOT_CODE = new RegExp(`[^${PAIR_CODE_ALPHABET}-]`, "g");

/** The code as the field shows it: upper case, the pairing alphabet and one dash, no longer than a code with a dash. */
export function shownCode(typed: string): string {
  const upper = typed.toUpperCase().replace(NOT_CODE, "");
  const dashAt = upper.indexOf("-");
  const letters = upper.replace(/-/g, "").slice(0, PAIR_CODE_LENGTH);
  return dashAt > 0 && dashAt < letters.length ? `${letters.slice(0, dashAt)}-${letters.slice(dashAt)}` : letters;
}

/** The code as the host takes it: the letters alone. */
export const sentCode = (shown: string): string => shown.replace(/-/g, "");
