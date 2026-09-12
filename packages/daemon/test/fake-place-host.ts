// SPDX-License-Identifier: AGPL-3.0-only
// A host a place can dial, for tests on either side of the link: a real ws
// server with a real ed25519 pair, so the handshake a daemon runs is the one
// this answers and nothing here fakes a signature. The bytes both sides sign
// come from the protocol, as they do on the wire.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeLinkTranscript, type PlaceFile } from "@wsp/protocol";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { writePlaceFile } from "../src/link.js";

export interface PlacePair {
  publicKey: string;
  privateKeyPem: string;
}

export function placePair(): PlacePair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

const dirs: string[] = [];
const servers: WebSocketServer[] = [];

/** Everything a test made here, taken down: the ws servers and the folders the place files sit in. */
export async function closeFakePlaceHosts(): Promise<void> {
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A place file in a folder of its own, with the private key beside it. */
export function testPlaceFile(hostUrls: string[], hostPublicKey: string, keyPem: string, placeId = "p_ab12cd34"): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-link-"));
  dirs.push(dir);
  const keyPath = join(dir, "place-key.pem");
  writeFileSync(keyPath, keyPem);
  const file: PlaceFile = { placeId, name: "old-macbook", hostName: "zingzy-mbp", hostUrls, hostPublicKey, keyPath, joinedAt: new Date(0).toISOString(), awake: false };
  const path = join(dir, "place.json");
  writePlaceFile(path, file);
  return path;
}

/** A host that answers the handshake with a real signature. `wrongTranscript` signs the place's own half instead of
 * its own, which is the one thing a place must refuse. */
export interface FakeHost {
  url: string;
  /** How many sockets the place has opened to it. */
  dials: () => number;
  /** Every frame the place sent after the handshake, in order. */
  frames: Record<string, unknown>[];
  /** The socket the place is holding, once it has proved. */
  socket: Promise<ServerSocket>;
  publicKey: string;
}

export async function fakePlaceHost(opts: { key?: PlacePair; wrongTranscript?: boolean; refuse?: string } = {}): Promise<FakeHost> {
  const key = opts.key ?? placePair();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
  let dials = 0;
  let held!: (s: ServerSocket) => void;
  const socket = new Promise<ServerSocket>(done => (held = done));
  wss.on("connection", ws => {
    dials++;
    ws.on("error", () => {});
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame["op"] === "place.auth") {
        if (opts.refuse !== undefined) {
          ws.send(JSON.stringify({ id: frame["id"], ok: false, error: opts.refuse, kind: "auth" }));
          ws.close(4401, "unauthorized");
          return;
        }
        const placeId = String(frame["placeId"]);
        const placeNonce = String(frame["nonce"]);
        const nonce = Buffer.alloc(32, 9).toString("base64");
        const bytes = opts.wrongTranscript === true ? placeLinkTranscript("place", placeId, placeNonce, nonce) : placeLinkTranscript("host", placeId, placeNonce, nonce);
        const signature = sign(null, bytes, createPrivateKey(key.privateKeyPem)).toString("base64");
        ws.send(JSON.stringify({ id: frame["id"], ok: true, nonce, hostPublicKey: key.publicKey, signature }));
        return;
      }
      if (frame["op"] === "place.prove") {
        ws.send(JSON.stringify({ id: frame["id"], ok: true }));
        held(ws);
        return;
      }
      frames.push(frame);
    });
  });
  const port = await listening(wss);
  return { url: `http://127.0.0.1:${port}`, dials: () => dials, frames, socket, publicKey: key.publicKey };
}

/** The port a fresh server bound, once it has: address() answers null until the loop turns. */
export const listening = (wss: WebSocketServer): Promise<number> =>
  new Promise((done, fail) => {
    wss.once("listening", () => done((wss.address() as { port: number }).port));
    wss.once("error", fail);
  });

export const settled = (ms = 50): Promise<void> => new Promise(done => setTimeout(done, ms));
