// SPDX-License-Identifier: AGPL-3.0-only
// Words the composer's pickers put on their buttons.
import type { HarnessOption } from "@wsp/protocol";

/** The effort button: "<effort> · <context>", effort first; one alone when the model takes no other; the picker's name when neither resolves. */
export function effortPickerLabel(effort: HarnessOption | undefined, contextWindow: HarnessOption | undefined): string {
  const parts = [effort?.label, contextWindow?.label].filter((label): label is string => label !== undefined);
  return parts.length === 0 ? "Effort" : parts.join(" · ");
}
