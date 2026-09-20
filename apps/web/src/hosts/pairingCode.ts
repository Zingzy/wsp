// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for what a person pastes into a pairing field: what it looks
// like as they type it, whether it holds a whole code, and what it looks like
// on the wire. It sits apart from the sheet that draws the field because the
// sheet reads it three times, once per field, keycap and ask, and a test reads
// it with no window at all.
import { JOIN_TOKEN_MARK, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, readJoinToken } from "@wsp/protocol";

const NOT_CODE = new RegExp(`[^${PAIR_CODE_ALPHABET}-]`, "g");

/** The code half as the field shows it: upper case, the pairing alphabet and one dash, no longer than a code with
 * a dash. */
const shownHalf = (typed: string): string => {
  const upper = typed.toUpperCase().replace(NOT_CODE, "");
  const dashAt = upper.indexOf("-");
  const letters = upper.replace(/-/g, "").slice(0, PAIR_CODE_LENGTH);
  return dashAt > 0 && dashAt < letters.length ? `${letters.slice(0, dashAt)}-${letters.slice(dashAt)}` : letters;
};

/** What wsp host pair prints is one word, the code and the fingerprint of the key that host proves, and the whole
 * of it has to reach the command line: the computer pairing holds the host to that key before the code leaves it.
 * So the field shapes the code half as it always did and carries the fingerprint behind the mark exactly as it was
 * pasted, since base64 is case sensitive and none of its symbols is the pairing alphabet's. */
export function shownCode(typed: string): string {
  const at = typed.indexOf(JOIN_TOKEN_MARK);
  return at === -1 ? shownHalf(typed) : `${shownHalf(typed.slice(0, at))}${JOIN_TOKEN_MARK}${typed.slice(at + 1).trim()}`;
}

/** The token as the host takes it: the code's letters alone, and the fingerprint behind them where the person
 * pasted the whole word. A word with no fingerprint travels as it always did and is refused before any dial. */
export function sentCode(shown: string): string {
  const { code, hostKey } = readJoinToken(shown);
  return hostKey === undefined ? code : `${code}${JOIN_TOKEN_MARK}${hostKey}`;
}

/** Whether what was typed carries a whole pairing code, which is what the sheet waits for before it offers to
 * connect. The fingerprint is not asked for here: a word without one is refused with its own sentence, which says
 * what is missing, rather than by a button that never lights. */
export const codeIsWhole = (shown: string): boolean => readJoinToken(shown).code.length === PAIR_CODE_LENGTH;
