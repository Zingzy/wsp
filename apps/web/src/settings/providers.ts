// SPDX-License-Identifier: AGPL-3.0-only
// The cloud accounts this wsp can hold, keyed by the word WSP_PROVIDER names
// each by. A key is taken at the command line, and the Computers table draws a
// cloud row only once this host holds that key or a workspace stands on it, so
// no screen carries a price for an account nobody has.
import { PROVIDER_KEY_WORDS, type InitSetup } from "@wsp/protocol";

/** Whether this computer holds the key for a cloud, off what the host says about its setup: the host keys what it
 * holds by the same word a row's id is. Read by the Computers table, which draws a cloud row only for a key it
 * holds, and by the section about one cloud, which stands under the same rule. */
export const keyHeld = (id: string, setup: Pick<InitSetup, "keys"> | null): boolean => setup?.keys[id] === true;

/** The clouds this host could be given a key for: every cloud it registered, held or not, which is every cloud its
 * setup keys a row by, and none before the host has said or where the cloud is off. What Add a cloud offers, so the
 * app names no cloud the host would not take. */
export const cloudsOffered = (setup: Pick<InitSetup, "keys"> | null): string[] => Object.keys(PROVIDER_KEY_WORDS).filter(id => setup?.keys[id] !== undefined);
