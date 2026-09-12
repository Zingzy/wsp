// SPDX-License-Identifier: AGPL-3.0-only
// The providers Connect a provider offers, one row each: what a person reads,
// what the provider is in one mono line, what its cheapest workspace costs,
// the ghost in its key field, where a key comes from, and the road that puts
// the key to it. Adding a provider is a row here and nothing else; no code
// below this file compares a provider by name.
//
// The ids are the words WSP_PROVIDER holds, so this table and the host's own
// (packages/host/src/providers.ts) are keyed alike. They are two tables until
// #601 lands keyEnv and keyName on the host's rows: what is here is what a
// person reads and what is there is what a key is stored under, and the wire
// carries neither yet. The rates are what each backend quotes for its smallest
// size today (box-backend.ts BOX_CLASSES, solari-backend.ts rateUsdPerHour),
// copied because the engine is a server package the browser cannot import.
import { CLOUD_SETUP_WORDS, SOLARI_CONSOLE } from "@wsp/protocol";
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
  /** Where a key comes from, as the link under the field reads it. */
  console: string;
  /** Whether this provider's trial is live, which is what puts it first in the list. */
  trial?: boolean;
  /** Puts the typed key to the provider and saves it on this computer, or nothing where no op on the wire carries
   * this row's key yet. A row without one holds Save rather than pretending the key was saved. */
  save?(api: Api, key: string): Promise<void>;
}

export const PROVIDER_ROWS: readonly ProviderRow[] = [
  {
    id: "box",
    name: "ASCII",
    what: "always on, naps to $0",
    fromUsdPerHour: 0.018,
    placeholder: "ascii_…",
    console: "https://ascii.dev",
    trial: true,
  },
  {
    id: "solari",
    name: "Solari",
    what: "in memory, wakes fast",
    fromUsdPerHour: 0.11,
    placeholder: CLOUD_SETUP_WORDS.keys.placeholder,
    console: `https://${SOLARI_CONSOLE}`,
    save: async (api, key) => {
      await api.initKeys?.({ solari: key });
    },
  },
];

/** The rows in the order the sheet lists them: a provider whose trial is live first, the rest as the table has them. */
export const providerRows = (rows: readonly ProviderRow[] = PROVIDER_ROWS): ProviderRow[] => [...rows].sort((a, b) => Number(b.trial ?? false) - Number(a.trial ?? false));
