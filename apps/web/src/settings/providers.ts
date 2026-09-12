// SPDX-License-Identifier: AGPL-3.0-only
// The providers Connect a provider offers, one row each: what a person reads,
// what the provider is in one mono line, what its cheapest workspace costs and
// the ghost in its key field. Adding a provider is a row here and nothing else;
// no code below this file compares a provider by name.
//
// The ids are the words WSP_PROVIDER holds, so this table, the keys the host
// says it holds and the key a person saves are all keyed alike, and the sheet
// puts a key to the host under the row's own id rather than carrying a road per
// row. The two facts a person reads about a key, its name and where one comes
// from, are read off PROVIDER_KEY_WORDS, which the host's registry reads too.
// The rates are what each backend quotes for its smallest size today
// (box-backend.ts BOX_CLASSES, solari-backend.ts rateUsdPerHour), copied because
// the engine is a server package the browser cannot import; they go when a size
// listing rides the wire.
import { PROVIDER_KEY_WORDS, type InitSetup } from "@wsp/protocol";

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
}

/** Whether this computer already holds a key for this provider, off what the host says about its setup: the host
 * keys what it holds by the same word this row's id is. */
export const keyHeld = (row: ProviderRow, setup: InitSetup): boolean => setup.keys[row.id] === true;

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
  },
];

/** The rows in the order the sheet lists them: a provider whose trial is live first, the rest as the table has them. */
export const providerRows = (rows: readonly ProviderRow[] = PROVIDER_ROWS): ProviderRow[] => [...rows].sort((a, b) => Number(b.trial ?? false) - Number(a.trial ?? false));
