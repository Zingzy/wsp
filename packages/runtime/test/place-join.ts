// SPDX-License-Identifier: AGPL-3.0-only
// A computer joining a host as its daemon would: the wiring a host holds for
// its places, the report a computer sends, and the handshake with real ed25519
// signatures and the seal its frames ride inside.
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { expect } from "vitest";
import { PLACE_LINK_NONCE_BYTES, placeLinkTranscript, type PlaceReport } from "@wsp/protocol";
import { freshEphemeral, makeSeal, newPlaceKeyPair, sealKeys, sharedSecret, type PlaceKeyPair } from "@wsp/keys";
import type { PlaceUpdater, PlaceWiring } from "../src/places.js";
import { WsClient } from "./ws-client.js";

/** The addresses a joining computer is told to dial, as the host's own door answers them: the install is handed
 * them rather than reading them a second time. */
export const DOOR = ["http://192.168.1.20:4400"];

export const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, engine: "docker" as const, mac: "mac-mini" as const };

export function wiring(hostKey: PlaceKeyPair, provider?: { id: string; rateUsdPerHour: number }, update?: PlaceUpdater): PlaceWiring {
  return { hostKey, provider: () => provider, here: () => HERE, hostName: () => "zingzys-mac", ...(update === undefined ? {} : { update }) };
}

export const report = (name = "old-macbook", over: Partial<PlaceReport> = {}): PlaceReport => ({
  name,
  platform: "linux",
  arch: "x64",
  os: "Ubuntu 24.04",
  shape: { cpu: 4, memMb: 4096 },
  diskFreeBytes: 831 * 1024 * 1024 * 1024,
  login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
  runsWorkspaces: true,
  engine: "none",
  daemonVersion: 17,
  agents: [],
  wsp: ["/home/maya/.npm-global/bin/wsp"],
  dialed: "http://192.168.1.20:14621",
  ...over,
});

export const nonce = (): string => randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
export const signWith = (pem: string, bytes: Uint8Array): string => sign(null, bytes, createPrivateKey(pem)).toString("base64");

/** The computer's half of the key agreement, the one helper both the join and the relink speak it through: the
 * ephemeral that rides frame one, and the seal every frame from the prove on travels inside once the host has
 * answered with its own. */
export function agreeing(): { ephemeral: string; sealFrom: (client: WsClient, placeId: string, reply: Record<string, unknown>) => void } {
  const mine = freshEphemeral();
  return {
    ephemeral: mine.publicKey,
    sealFrom: (client, placeId, reply) => {
      client.seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, String(reply["ephemeral"])), placeId), "place");
    },
  };
}

/** One join, as a computer would make it: the frame, the check of the host's own signature, and the prove. */
export async function joinAt(
  port: number,
  hostKey: PlaceKeyPair,
  opts: { code: string; name?: string; client?: { name: string }; report?: PlaceReport; proveReport?: PlaceReport; expectProved?: boolean; answers?: (c: WsClient) => void } = { code: "" },
): Promise<{ client: WsClient; placeId: string; reply: Record<string, unknown>; proved: Record<string, unknown>; pair: PlaceKeyPair }> {
  const client = await WsClient.connect(port);
  // What this computer answers is on the socket before the handshake is: the host may send its first frame the
  // moment the prove lands, and a computer that only starts listening afterwards would miss it.
  opts.answers?.(client);
  const pair = newPlaceKeyPair();
  const mine = nonce();
  const sent = opts.report ?? report(opts.name);
  const agreed = agreeing();
  const reply = await client.request("place.join", { publicKey: pair.publicKey, nonce: mine, ephemeral: agreed.ephemeral });
  if (reply.ok !== true) return { client, placeId: "", reply, proved: {}, pair };
  const placeId = String(reply["placeId"]);
  expect(reply["hostPublicKey"]).toBe(hostKey.publicKey);
  agreed.sealFrom(client, placeId, reply);
  const proved = await client.request("place.prove", {
    signature: signWith(pair.privateKeyPem, placeLinkTranscript("place", placeId, String(reply["nonce"]), mine, { challenger: String(reply["ephemeral"]), answerer: agreed.ephemeral })),
    // The second frame carries a report of its own, which a computer may send with anything in it, and the code
    // this join spends: both ride inside the seal, after the host proved the key the join line named.
    report: opts.proveReport ?? sent,
    code: opts.code,
    ...(opts.client === undefined ? {} : { client: opts.client }),
  });
  if (opts.expectProved !== false) expect(proved.ok, String(proved["error"])).toBe(true);
  return { client, placeId, reply, proved, pair };
}


/** A place that already joined, dialling in again: the handshake it runs on every attempt. */
export async function relinkAt(
  port: number,
  hostKey: PlaceKeyPair,
  placeId: string,
  pair: PlaceKeyPair,
  sent: PlaceReport = report(),
  answers?: (c: WsClient) => void,
): Promise<{ client: WsClient; proved: Record<string, unknown> }> {
  const client = await WsClient.connect(port);
  answers?.(client);
  const mine = nonce();
  const agreed = agreeing();
  const challenged = await client.request("place.auth", { placeId, nonce: mine, ephemeral: agreed.ephemeral });
  expect(challenged.ok, String(challenged["error"])).toBe(true);
  expect(challenged["hostPublicKey"]).toBe(hostKey.publicKey);
  agreed.sealFrom(client, placeId, challenged);
  const proved = await client.request("place.prove", {
    signature: signWith(pair.privateKeyPem, placeLinkTranscript("place", placeId, String(challenged["nonce"]), mine, { challenger: String(challenged["ephemeral"]), answerer: agreed.ephemeral })),
    report: sent,
  });
  return { client, proved };
}
