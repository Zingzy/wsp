// SPDX-License-Identifier: AGPL-3.0-only
// The seal over a place link: after the two ends have proved their ed25519
// keys to each other, every frame between them travels inside one AEAD under
// a key agreed in the same handshake, so whoever carries the bytes reads
// nothing and writes nothing into the link. The carrier is real: a managed
// tunnel ends TLS on the relay operator's account, and a plain http address
// is open to anyone on the path. The daemon's twin is seal.rs and the fixture
// daemon/fixtures/place-link-seal.json holds the two to one derivation and
// one set of bytes.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";

/** One info word per direction, so the two keys of a link can never be swapped for each other. */
export const HOST_TO_PLACE_INFO = "wsp place link host to place";
export const PLACE_TO_HOST_INFO = "wsp place link place to host";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What a frame that will not open is refused with: the same sentence whichever way it failed, since a peer that
 * cannot make a frame this side accepts learns nothing from which check caught it. The socket ends on it. */
export const SEAL_REFUSAL = "a frame on this link did not open under the key both ends agreed";

/** The two keys of one link, one per direction. */
export interface SealKeys {
  hostToPlace: Buffer;
  placeToHost: Buffer;
}

/** The keys both ends derive from the agreed secret: HKDF-SHA256, the place id as the salt, one info word per
 * direction. The place id is public and is the salt rather than a secret, which is what a salt is for. */
export const sealKeys = (secret: Uint8Array, placeId: string): SealKeys => ({
  hostToPlace: Buffer.from(hkdfSync("sha256", secret, Buffer.from(placeId, "utf8"), HOST_TO_PLACE_INFO, KEY_BYTES)),
  placeToHost: Buffer.from(hkdfSync("sha256", secret, Buffer.from(placeId, "utf8"), PLACE_TO_HOST_INFO, KEY_BYTES)),
});

/** An X25519 public key as the raw 32 bytes the wire carries, base64. */
export const rawPublicKey = (key: KeyObject): string => Buffer.from((key.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("base64");

/** The same read back off the wire; throws on anything that is not 32 bytes of X25519. */
export const publicKeyOf = (raw: string): KeyObject =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw, "base64").toString("base64url") }, format: "jwk" });

/** A fresh pair for one attempt: the raw public bytes that cross the wire and the private key to agree with. One
 * per socket, never held past it, so a key that leaks later opens nothing that was said before. */
export function freshEphemeral(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync("x25519");
  return { privateKey: pair.privateKey, publicKey: rawPublicKey(pair.publicKey) };
}

/** The 32 bytes the two ephemerals agree on. */
export const sharedSecret = (privateKey: KeyObject, peer: string): Buffer => diffieHellman({ privateKey, publicKey: publicKeyOf(peer) });

/** Four zero bytes then the counter, big endian: one nonce per frame per direction, so no key ever seals two
 * frames under the same nonce and a frame moved or repeated does not open. */
export function sealNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

/** One frame sealed under a key at a counter: the ciphertext with the tag behind it, as ring writes it too. */
export function sealWith(key: Buffer, counter: bigint, text: string): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, sealNonce(counter));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
}

/** The text back, or the one refusal: a tag that does not verify, a counter out of step and a frame cut short
 * read the same. */
export function unsealWith(key: Buffer, counter: bigint, bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  if (buf.length < TAG_BYTES) throw new Error(SEAL_REFUSAL);
  const decipher = createDecipheriv("aes-256-gcm", key, sealNonce(counter));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(buf.subarray(0, buf.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(SEAL_REFUSAL);
  }
}

/** One end's view of a sealed link: what it seals outgoing frames with and what it opens incoming ones with, each
 * counting on its own. Every frame one side sends goes through one of these, so the counters follow the wire. */
export interface Seal {
  seal(text: string): Buffer;
  unseal(bytes: Uint8Array): string;
}

export function makeSeal(keys: SealKeys, side: "host" | "place"): Seal {
  const outward = side === "host" ? keys.hostToPlace : keys.placeToHost;
  const inward = side === "host" ? keys.placeToHost : keys.hostToPlace;
  let sent = 0n;
  let taken = 0n;
  return {
    seal(text) {
      const bytes = sealWith(outward, sent, text);
      sent += 1n;
      return bytes;
    },
    unseal(bytes) {
      const text = unsealWith(inward, taken, bytes);
      taken += 1n;
      return text;
    },
  };
}
