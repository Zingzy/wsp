// SPDX-License-Identifier: AGPL-3.0-only
// Words the composer's pickers put on their buttons.
import type { HarnessOption } from "@wsp/protocol";

/** The word the folded picker wears with nothing picked, and what its name leads with. */
export const DEFAULTS_WORD = "Defaults";

/** A value in the row's own casing: the menu row keeps the catalog's capital, the button under a row of sentence
 * case does not, since two capitals inside one label read as Title Case. A capitalised word alone moves; a word
 * the binary spells in capitals (XL, 1M) is its own name and is left as it came. */
const asValue = (word: string): string => (/^[A-Z][a-z]/.test(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word);

/** The one defaults button: the reasoning effort, then the access mode, each in its short form where the row has
 * one, since the long form of a mode named after a machine crushes the model's name beside it. The context window
 * is read in the menu alone: three words on one button left none of them readable at the narrow column. */
export function defaultsPickerLabel(effort: HarnessOption | undefined, access: HarnessOption | undefined): string {
  const parts = [effort, access].map(option => option?.short ?? option?.label).filter((word): word is string => word !== undefined);
  return parts.length === 0 ? DEFAULTS_WORD : parts.map(asValue).join(" · ");
}
