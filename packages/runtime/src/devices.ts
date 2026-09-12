// SPDX-License-Identifier: AGPL-3.0-only
// Pairing codes and the device tokens they mint, kept in the state file beside
// every other collection so a restart does not lock a paired computer out. A
// code is one use and ten minutes; a device token is minted once, handed over
// once and never stored: only its sha256 is kept, and every reading of it is a
// timing safe compare of that hash.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DeviceView, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, type ThreadScope } from "@wsp/protocol";
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
  lastSeenAt: string;
  /** Set on a token the host minted into one turn's launch rather than one a person's computer redeemed a code
   * for: what that token may drive. */
  scope?: ThreadScope;
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
  lastSeenAt: record.lastSeenAt,
  ...(record.scope !== undefined ? { scope: record.scope } : {}),
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
  /** Spends a code with no device behind it, for a road that proves itself another way: a place holds a key of its
   * own from the join on, so the code buys the record and never a token. One code store, so a code spent by either
   * road is spent for both. */
  spend(code: string, now: number): Promise<boolean>;
  /** A device with no pairing code behind it: the host itself minting a token for a turn it is about to launch,
   * scoped to that turn's thread. The same door as a redeem, so a scoped token is revoked, listed and read by the
   * one road every other token takes. */
  mint(name: string, scope: ThreadScope, now: number): Promise<PairedDevice>;
  /** The device this token names, or nothing when no device holds it. Reads only: the JSON routes read a token on
   * every request, and a write there would rewrite the whole state file each time. */
  match(token: string): Promise<DeviceView | undefined>;
  /** Moves a device's last seen. The auth frame is the one road that calls this; a redeem stamps its own. */
  seen(id: string, now: number): Promise<DeviceView | undefined>;
  list(): Promise<DeviceView[]>;
  /** True when a device of that id was there to take away. */
  revoke(id: string): Promise<boolean>;
}

/** The one refusal for a runtime served without a store to keep devices in, so the ops answer plainly rather than
 * pretending nobody is paired. */
export const NO_DEVICE_DOOR = "this runtime keeps no devices; the host that serves the app wires one";

export function makeDevices(store: Store): DeviceDoor {
  const devices = async (): Promise<DeviceRecord[]> => (await store.list(DEVICES)).filter(isDevice);

  // One writer over the device and pairing records: every road that reads a record and writes it back goes through
  // this chain, so two sockets cannot each spend one code, and a revoke that lands between another road's read and
  // its write cannot be undone by that write. Reads outside it (match, list) never write, so they need no place here.
  let writes: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.then(work);
    writes = next.catch(() => undefined);
    return next;
  };

  /** One device record and the one token it will ever hand over. Both roads that make a device come through here,
   * so a scoped token is stored, hashed and named by exactly the rule a paired computer's is. */
  const admit = async (name: string, scope: ThreadScope | undefined, now: number): Promise<PairedDevice> => {
    const deviceToken = randomBytes(24).toString("base64url");
    const at = new Date(now).toISOString();
    const record: DeviceRecord = {
      // Eight bytes, not four: the id keys the store, so two devices that drew the same one would be one record
      // and the older computer's access would vanish under the newer.
      id: `d_${randomBytes(8).toString("hex")}`,
      name: name.trim() === "" ? "a paired computer" : name.trim(),
      tokenHash: hashOf(deviceToken),
      createdAt: at,
      lastSeenAt: at,
      ...(scope !== undefined ? { scope } : {}),
    };
    await store.put(DEVICES, record.id, record);
    return { deviceId: record.id, deviceToken, device: viewOf(record) };
  };

  /** The code half of a redeem, on its own: whether this host was holding it and it had not run out. Spent either
   * way, so one guess never gets two tries, and whatever the caller does with the answer. */
  const spendCode = async (code: string, now: number): Promise<boolean> => {
    const held = await store.get(PAIRINGS, code);
    if (!isPairing(held)) return false;
    await store.delete(PAIRINGS, code);
    return now <= held.expiresAt;
  };

  return {
    issue: ({ now, ttlMs }) =>
      oneAtATime(async () => {
        // A code nobody redeemed is dead weight in the state file, and minting is the one moment the list is
        // already worth reading: every host restart and every fresh code clears what has run out.
        for (const held of await store.list(PAIRINGS)) if (isPairing(held) && now > held.expiresAt) await store.delete(PAIRINGS, held.code);
        const code = mintCode();
        const expiresAt = now + ttlMs;
        await store.put(PAIRINGS, code, { code, expiresAt } satisfies PairingRecord);
        return { code, expiresAt };
      }),
    redeem: (code, name, now) => oneAtATime(async () => ((await spendCode(code, now)) ? admit(name, undefined, now) : undefined)),
    spend: (code, now) => oneAtATime(() => spendCode(code, now)),
    mint: (name, scope, now) => oneAtATime(() => admit(name, scope, now)),
    match: async token => {
      const digest = hashOf(token);
      // Every record is compared, and the first match is kept rather than returned: a loop that leaves early would
      // say by its own duration how far down the list the token sat.
      let found: DeviceRecord | undefined;
      for (const record of await devices()) if (safeEqual(digest, record.tokenHash) && found === undefined) found = record;
      return found === undefined ? undefined : viewOf(found);
    },
    // A read and a write with an await between them: through the chain, so a revoke that lands in that gap is not
    // undone by this write. A device redialing with backoff while somebody revokes it hits exactly that.
    seen: (id, now) =>
      oneAtATime(async () => {
        const held = await store.get(DEVICES, id);
        if (!isDevice(held)) return undefined;
        const moved: DeviceRecord = { ...held, lastSeenAt: new Date(now).toISOString() };
        await store.put(DEVICES, id, moved);
        return viewOf(moved);
      }),
    list: async () => (await devices()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(viewOf),
    revoke: id =>
      oneAtATime(async () => {
        const held = await store.get(DEVICES, id);
        if (!isDevice(held)) return false;
        await store.delete(DEVICES, id);
        return true;
      }),
  };
}
