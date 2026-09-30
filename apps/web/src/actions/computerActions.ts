// SPDX-License-Identifier: AGPL-3.0-only
// A computer's actions, one registry: what its row on the Computers list
// offers in its context menu. Today that is the icon it shows as, one entry
// per icon but the one it wears.
import { ComputerIcon } from "@wsp/protocol";
import { COMPUTER_GLYPHS, computerIconWord } from "../settings/ComputerGlyph.js";
import type { ActionEntry } from "./registry.js";

export interface ComputerTarget {
  readonly id: string;
  readonly icon: ComputerIcon;
}

export interface ComputerVerbs {
  readonly setIcon: (placeId: string, icon: ComputerIcon) => void;
}

export const computerActions: ReadonlyArray<ActionEntry<ComputerTarget, ComputerVerbs>> = ComputerIcon.options.map(icon => ({
  id: `icon-${icon}`,
  group: "icon",
  icon: () => COMPUTER_GLYPHS[icon],
  applies: target => target.icon !== icon,
  title: () => `${computerIconWord(icon)} icon`,
  refusal: () => null,
  run: (target, verbs) => verbs.setIcon(target.id, icon),
}));
