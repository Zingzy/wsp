// SPDX-License-Identifier: AGPL-3.0-only
// Pairing codes and the device tokens they mint, kept in the state file beside
// every other collection so a restart does not lock a paired computer out. A
// code is one use and ten minutes; a device token is minted once, handed over
// once and never stored: only its sha256 is kept, and every reading of it is a
// timing safe compare of that hash.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DeviceView, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from "@wsp/protocol";
import type { Store } from "./store.js";

/** One document per paired computer, keyed by its id. */
const DEVICES = "devices";
/** One document per unspent pairing code, keyed by the code itself, so a redeem is one read. */
const PAIRINGS = "pairings";

/** Two strings of the same bytes, in a time that does not say where they first differ. The one compare every road
 * into this host makes, whether it holds the host's own token or a device's hash. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** What the store keeps for a device: never the token, only the digest a presented one is compared against. */
interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
}

interface PairingRecord {
  code: string;
  expiresAt: number;
}

const isDevice = (v: unknown): v is DeviceRecord =>
  typeof v === "object" && v !== null && typeof (v as DeviceRecord).id === "string" && typeof (v as DeviceRecord).tokenHash === "string";

const isPairing = (v: unknown): v is PairingRecord =>
  typeof v === "object" && v !== null && typeof (v as PairingRecord).code === "string" && typeof (v as PairingRecord).expiresAt === "number";

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A code of the alphabet's symbols. 256 is a whole number of 32s, so a byte masked to five bits picks one symbol
 * with no bias and no rejection loop. */
function mintCode(): string {
  const bytes = randomBytes(PAIR_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += PAIR_CODE_ALPHABET[byte & 31];
  return code;
}

const viewOf = (record: DeviceRecord): DeviceView => ({
  id: record.id,
  name: record.name,
  createdAt: record.createdAt,
  ...(record.lastSeenAt !== undefined ? { lastSeenAt: record.lastSeenAt } : {}),
});

/** What a redeem hands back: the token, once, and the record every later listing shows. */
export interface PairedDevice {
  deviceId: string;
  deviceToken: string;
  device: DeviceView;
}

/** The pairing door the protocol server calls. Every method takes the clock's reading rather than reading one, so
 * the server's own injectable clock is the only one in the system. */
export interface DeviceDoor {
  /** A fresh code, and when it stops being one. */
  issue(at: { now: number; ttlMs: number }): Promise<{ code: string; expiresAt: number }>;
  /** Spends the code for a device of that name, or nothing when the host holds no such unexpired code. A spent or
   * expired code is deleted either way, so one guess never gets two tries. */
  redeem(code: string, name: string, now: number): Promise<PairedDevice | undefined>;
  /** The device this token names, its last seen moved to now, or nothing when no device holds it. */
  match(token: string, now: number): Promise<DeviceView | undefined>;
  list(): Promise<DeviceView[]>;
  /** True when a device of that id was there to take away. */
  revoke(id: string): Promise<boolean>;
}

/** The one refusal for a runtime served without a store to keep devices in, so the ops answer plainly rather than
 * pretending nobody is paired. */
export const NO_DEVICE_DOOR = "this runtime keeps no devices; the host that serves the app wires one";

export function makeDevices(store: Store): DeviceDoor {
  const devices = async (): Promise<DeviceRecord[]> => (await store.list(DEVICES)).filter(isDevice);

  // Redeems run one after another: two sockets spending one code at the same moment would each read the pairing
  // before the other's delete and each be handed a device.
  let redeems: Promise<unknown> = Promise.resolve();

  const spend = async (code: string, name: string, now: number): Promise<PairedDevice | undefined> => {
    const held = await store.get(PAIRINGS, code);
    if (!isPairing(held)) return undefined;
    await store.delete(PAIRINGS, code);
    if (now > held.expiresAt) return undefined;
    const deviceToken = randomBytes(24).toString("base64url");
    const record: DeviceRecord = {
      id: `d_${randomBytes(4).toString("hex")}`,
      name: name.trim() === "" ? "a paired computer" : name.trim(),
      tokenHash: hashOf(deviceToken),
      createdAt: new Date(now).toISOString(),
    };
    await store.put(DEVICES, record.id, record);
    return { deviceId: record.id, deviceToken, device: viewOf(record) };
  };

  return {
    issue: async ({ now, ttlMs }) => {
      // A code nobody redeemed is dead weight in the state file, and minting is the one moment the list is already
      // worth reading: every host restart and every fresh code clears what has run out.
      for (const held of await store.list(PAIRINGS)) if (isPairing(held) && now > held.expiresAt) await store.delete(PAIRINGS, held.code);
      const code = mintCode();
      const expiresAt = now + ttlMs;
      await store.put(PAIRINGS, code, { code, expiresAt } satisfies PairingRecord);
      return { code, expiresAt };
    },
    redeem: (code, name, now) => {
      const work = redeems.then(() => spend(code, name, now));
      redeems = work.catch(() => undefined);
      return work;
    },
    match: async (token, now) => {
      const digest = hashOf(token);
      // Every record is compared, and the first match is kept rather than returned: a loop that leaves early would
      // say by its own duration how far down the list the token sat.
      let found: DeviceRecord | undefined;
      for (const record of await devices()) if (safeEqual(digest, record.tokenHash) && found === undefined) found = record;
      if (found === undefined) return undefined;
      const seen: DeviceRecord = { ...found, lastSeenAt: new Date(now).toISOString() };
      await store.put(DEVICES, seen.id, seen);
      return viewOf(seen);
    },
    list: async () => (await devices()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(viewOf),
    revoke: async id => {
      const held = await store.get(DEVICES, id);
      if (!isDevice(held)) return false;
      await store.delete(DEVICES, id);
      return true;
    },
  };
}
