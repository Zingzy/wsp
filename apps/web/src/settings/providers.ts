// SPDX-License-Identifier: AGPL-3.0-only
// The cloud accounts this wsp can hold, as two entries: the word WSP_PROVIDER
// keys each by, and the name a person reads on its row. Nothing else: a key is
// taken at the command line, and the Computers table draws a cloud row only
// once this host holds that key or a workspace stands on it, so no screen
// carries a price for an account nobody has.
import type { InitSetup } from "@wsp/protocol";

export interface CloudName {
  /** The word WSP_PROVIDER holds for this cloud, which is also what the host names its row by. */
  id: string;
  /** What a person reads, everywhere. */
  name: string;
}

export const CLOUD_NAMES: readonly CloudName[] = [
  { id: "box", name: "ASCII" },
  { id: "solari", name: "Solari" },
];

/** Whether this computer holds the key for a cloud, off what the host says about its setup: the host keys what it
 * holds by the same word a row's id is. Read by the Computers table, which draws a cloud row only for a key it
 * holds, and by the section about one cloud, which stands under the same rule. */
export const keyHeld = (id: string, setup: Pick<InitSetup, "keys"> | null): boolean => setup?.keys[id] === true;
