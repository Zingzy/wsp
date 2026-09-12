// SPDX-License-Identifier: AGPL-3.0-only
// The providers Connect a provider offers, one row each: what a person reads,
// what the provider is in one mono line, what its cheapest workspace costs,
// the ghost in its key field, and the roads that check whether a key is held
// and put a new one to the provider. Adding a provider is a row here and
// nothing else; no code below this file compares a provider by name.
//
// The ids are the words WSP_PROVIDER holds, so this table and the host's own
// registry are keyed alike, and the two facts a person reads about a key, its
// name and where one comes from, are read off PROVIDER_KEY_WORDS, which the
// host's registry reads too. The rates are what each backend quotes for its
// smallest size today (box-backend.ts BOX_CLASSES, solari-backend.ts
// rateUsdPerHour), copied because the engine is a server package the browser
// cannot import; they go when a size listing rides the wire.
import { PROVIDER_KEY_WORDS, type InitSetup } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";

export interface ProviderRow {
  /** The word WSP_PROVIDER holds for this provider. */
  id: string;
  /** What a person reads, everywhere. */
  name: string;
  /** The mono line in the pick row's slot, before the rate. */
  what: string;
  /** The hourly rate of the smallest workspace it offers. */
  fromUsdPerHour: number;
  /** The key field's ghost: the start every key of this provider's has, and no more. */
  placeholder: string;
  /** Whether this provider's trial is live, which is what puts it first in the list. */
  trial?: boolean;
  /** Whether this computer already holds a key for this provider, off what the host says about its setup. A row
   * with no reader cannot know, and the sheet asks for a key rather than claiming one is saved. */
  held?(setup: InitSetup): boolean;
  /** Puts the typed key to the provider and saves it on this computer, or nothing where no op on the wire carries
   * this row's key yet. A row without one holds Save rather than pretending the key was saved. */
  save?(api: Api, key: string): Promise<void>;
}

/** Where a person gets this provider's key, off the one table the host's registry reads. The key's own name
 * there titles the screen the terminal draws; this sheet is titled by the provider already, so its field carries
 * the plain label and nobody meets the id word. */
export const keyConsoleOf = (row: ProviderRow): string | undefined => PROVIDER_KEY_WORDS[row.id]?.keyConsole;

export const PROVIDER_ROWS: readonly ProviderRow[] = [
  {
    id: "box",
    name: "ASCII",
    what: "always on, naps to $0",
    fromUsdPerHour: 0.018,
    placeholder: "ascii_…",
    trial: true,
  },
  {
    id: "solari",
    name: "Solari",
    what: "in memory, wakes fast",
    fromUsdPerHour: 0.11,
    placeholder: "slr_live_...",
    held: setup => setup.keys.solari,
    save: async (api, key) => {
      await api.initKeys?.({ solari: key });
    },
  },
];

/** The rows in the order the sheet lists them: a provider whose trial is live first, the rest as the table has them. */
export const providerRows = (rows: readonly ProviderRow[] = PROVIDER_ROWS): ProviderRow[] => [...rows].sort((a, b) => Number(b.trial ?? false) - Number(a.trial ?? false));
