// SPDX-License-Identifier: AGPL-3.0-only
// Words the composer's pickers put on their buttons.
import type { HarnessOption } from "@wsp/protocol";

/** The word the folded picker wears with nothing picked, and what its name leads with. */
export const DEFAULTS_WORD = "Defaults";

/** The one defaults button: the reasoning effort, then the access mode, each in its short form where the row has
 * one, since the long form of a mode named after a machine crushes the model's name beside it. The context window
 * is read in the menu alone: three words on one button left none of them readable at the narrow column. */
export function defaultsPickerLabel(effort: HarnessOption | undefined, access: HarnessOption | undefined): string {
  const parts = [effort, access].map(option => option?.short ?? option?.label).filter((word): word is string => word !== undefined);
  return parts.length === 0 ? DEFAULTS_WORD : parts.join(" · ");
}
