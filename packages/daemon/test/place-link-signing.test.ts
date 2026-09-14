// SPDX-License-Identifier: AGPL-3.0-only
// The known-answer vectors the Rust place link is held to, regenerated here
// from an ed25519 implementation that is not the daemon's: node signs the two
// transcripts with the fixture's key and the bytes must come out as the file
// holds them. The Rust test reads the same file, so a change to what the
// protocol puts on the wire fails on both sides rather than agreeing with
// itself. This is the whole of what node does for a place link.
import { createPublicKey, createPrivateKey, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { placeLinkTranscript } from "@wsp/protocol";
import { fixture } from "./fixtures.js";

/** A signature over the bytes both sides build from one function; ed25519 takes no digest name, which is what the null says. */
function signPlaceBytes(privateKeyPem: string, bytes: Uint8Array): string {
  return signBytes(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether the key pinned at join made this signature. */
function verifyPlaceBytes(publicKeyBase64: string, bytes: Uint8Array, signatureBase64: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  return verifyBytes(null, bytes, key, Buffer.from(signatureBase64, "base64"));
}

interface SigningVectors {
  privateKeyPem: string;
  publicKey: string;
  placeId: string;
  placeNonce: string;
  hostNonce: string;
  hostTranscript: string;
  placeTranscript: string;
  hostSignature: string;
  placeSignature: string;
}

const FILE = "place-link-signing.json";

describe("the place link signing vectors", () => {
  it("regenerates every field of the fixture the Rust link is proven against", () => {
    const v = JSON.parse(fixture(FILE)) as SigningVectors;
    const host = placeLinkTranscript("host", v.placeId, v.placeNonce, v.hostNonce);
    const place = placeLinkTranscript("place", v.placeId, v.hostNonce, v.placeNonce);
    expect(Buffer.from(host).toString("base64")).toBe(v.hostTranscript);
    expect(Buffer.from(place).toString("base64")).toBe(v.placeTranscript);
    expect(signPlaceBytes(v.privateKeyPem, host)).toBe(v.hostSignature);
    expect(signPlaceBytes(v.privateKeyPem, place)).toBe(v.placeSignature);
    expect(verifyPlaceBytes(v.publicKey, place, v.placeSignature)).toBe(true);
    expect(verifyPlaceBytes(v.publicKey, host, v.placeSignature)).toBe(false);
  });
});
