// SPDX-License-Identifier: AGPL-3.0-only
// One spelling of a key's fingerprint for everything here that names a key to a
// person: the machine key an ssh dial answered with, and the key a host proves
// at a join. Node crypto, so it cannot live in the protocol, which is bundled
// into the browser.
import { createHash } from "node:crypto";

/** A key's fingerprint as every ssh tool prints it: the SHA256 of the key's own bytes, base64 with the padding
 * dropped, under the name of the hash. The bytes are the key as it travels, base64: the blob off a known_hosts
 * line on one road, SPKI DER on a place's link key. Worked out here rather than by a second ssh-keygen, since it
 * is a hash of what the caller already holds. */
export function keyFingerprint(keyBase64: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64").replace(/=+$/, "")}`;
}
