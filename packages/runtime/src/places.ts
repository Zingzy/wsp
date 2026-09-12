// SPDX-License-Identifier: AGPL-3.0-only
// The places this host holds: the computers somebody joined to it, this
// computer, and the provider it forks on. A joined computer dials in, proves
// itself with the ed25519 key this host learned at its join, and from then on
// this door holds that one socket and drives it with the daemon protocol every
// fork speaks. Nothing here listens: a place opens the socket, always.
//
// The encodings both sides sign and send are pinned in the protocol
// (PlaceNonce, PlacePublicKey, PlaceSignature) and the bytes they sign come
// from placeLinkTranscript, so this file holds the host's half of the
// handshake and no rule of its own about how it is spelled.
import { createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  LOOPBACK,
  HERE_PLACE_ID,
  NO_PLACE_INSTALLER,
  PAIR_CODE_TTL_MS,
  PLACE_KEY_REFUSAL,
  PLACE_LEAVE_LINE,
  PLACE_LINK_NONCE_BYTES,
  forkRoom,
  placeLinkTranscript,
  placeAbsentLine,
  noSuchPlaceRefusal,
  placeHoldsForksRefusal,
  placeForksNowhereLine,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeStillInstalledLine,
  BackendFacts,
  type DaemonEvent,
  type PlaceAddStep,
  type PlaceStageEvent,
  type PlaceAuthReply,
  type PlaceAuthRequest,
  type PlaceJoinReply,
  type PlaceJoinRequest,
  type PlaceEvent,
  type PlaceReport,
  type PlaceView,
  type WorkspaceSize,
} from "@wsp/protocol";
import { LinkBackend, PlaceAbsentError, SSH_STORE_VARS, isPlainPath, plainPath, type ExecResult, type MachineBackend, type MachineLink } from "@wsp/engine";
import type { WebSocket } from "ws";
import type { DeviceDoor } from "./devices.js";
import { openPlaceForward, type PlaceForward } from "./place-forward.js";
import type { PlaceBackends } from "./runtime.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import type { Store } from "./store.js";

/** One document per joined computer, keyed by the id this host knows it by. */
const PLACES = "places";
/** The one document naming which place a verb means when nobody says: the last one added. */
const DEFAULT_COLLECTION = "place-default";
const DEFAULT_ID = "default";

/** An ed25519 pair as this host keeps it: the public half base64 SPKI DER, which is what travels, and the private
 * half as pkcs8 PEM, which never does. */
export interface PlaceKeyPair {
  publicKey: string;
  privateKeyPem: string;
}

/** What the store keeps about a joined computer. The key is the whole of its identity: a computer whose key moved
 * is not this place, whatever address it dials from. */
export interface PlaceRecord {
  id: string;
  name: string;
  publicKey: string;
  joinedAt: string;
  lastSeenAt: string;
  report: PlaceReport;
  /** The workspace recorded on this computer at join, where the join could record one. */
  workspaceId?: string;
  /** What the backend this computer offers said about itself the last time it was linked. Kept on the record so a
   * fork standing on this place can be held at host start, before the computer has dialled in: the capabilities,
   * the sizes and the budgets a road reads are facts about that computer, not about this moment's socket. */
  backendFacts?: BackendFacts;
}

const isPlaceRecord = (v: unknown): v is PlaceRecord => {
  const r = v as PlaceRecord | undefined;
  return typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.publicKey === "string" && typeof r.name === "string";
};

/** What a client watching the places hears. The four shapes are the protocol's own, so the host hands them straight
 * to the runtime's event bus and the app folds them with no second spelling in between. */
export type { PlaceEvent };

/** What this computer is, as a row of the same list: the list is the whole of where work can run, so the computer
 * the host runs on is on it. The host answers, since its own name and shape are its own to read. */
export interface HerePlace {
  name: string;
  os?: string;
  shape?: WorkspaceSize;
  docker?: boolean;
  diskFreeBytes?: number;
}

/** What a host wires for the places it holds: its own key pair, what it is set up to fork on, and this computer's
 * own row. Absent, the runtime serves no place and every place op is refused. */
export interface PlaceWiring {
  /** The host's own ed25519 pair, made once beside the state file by the host and never written by the runtime. */
  hostKey: PlaceKeyPair;
  /** The one word for a provider the host is set up for, as a place; nothing when it forks nowhere. */
  provider(): { id: string; rateUsdPerHour: number } | undefined;
  here(): HerePlace;
  /** What this computer calls itself, which is what a joining computer shows its person from then on. */
  hostName(): string;
  /** How the agent is put on a computer over ssh; absent on a runtime served without the road that installs it,
   * where the printed join line is the only way in. */
  install?: PlaceInstaller;
}

/** What one install is told: where to log in, what to call the computer, the single-use code it spends on this
 * host, and the addresses that computer is to dial it at, in the order its link tries them. The addresses are the
 * door's own reading, handed down rather than read a second time here. */
export interface PlaceInstallRequest {
  address: string;
  name?: string;
  sshPort?: number;
  keyPath?: string;
  code: string;
  hostUrls: readonly string[];
}

/** What the install answers once the computer has run its own join: the name it was given, and the key its ssh
 * answered with, which a person checks against the computer in front of them. */
export interface PlaceInstalled {
  name: string;
  hostKey?: string;
}

/** How far one install has got; the words for each step are the protocol's. */
export type PlaceStaging = (step: PlaceAddStep, state: "running" | "done" | "failed", note?: string) => void;
export type PlaceInstaller = (req: PlaceInstallRequest, stage: PlaceStaging) => Promise<PlaceInstalled>;

/** The two roads into the runtime a place needs, handed in because both are the runtime's own: a joined computer
 * becomes a workspace at its join, and those workspaces go when the place does. */
export interface PlaceRecording {
  /** Records one workspace on the place; answers its id, and the notice where a name was already held. */
  record(place: PlaceRecord): Promise<{ workspaceId?: string; notice?: string }>;
  /** Drops every workspace standing on this place by the ordinary delete road; answers the lines it printed, in
   * that kind's own words for what a delete does to a machine. */
  drop(placeId: string): Promise<string[]>;
  /** Moves the login and the shape of the workspace standing on this place onto what it just reported. A computer
   * somebody owns is upgraded, re-installed and given new tools under wsp rather than by it, so what a turn there
   * runs under is read again at every link and not once at the join. */
  refresh(place: PlaceRecord): Promise<void>;
  /** The names of the forks standing on this place: machines wsp made there, which a remove refuses to take the
   * place out from under. The workspace the place itself is is not one of them. */
  forksOn(placeId: string): Promise<string[]>;
}

export interface PlaceDoorOptions {
  store: Store;
  /** The one code store, so a join code and a pairing code are spent by one road. */
  devices: DeviceDoor;
  wiring: PlaceWiring;
  recording: PlaceRecording;
  /** Where this host can fork beyond the computers joined to it: the provider it is wired to and every other
   * provider whose key it holds. A thunk because the runtime builds that table after this door. Absent leaves the
   * wired provider as the only one, which is what a runtime with no provider table has. */
  providers?: () => PlaceBackends;
  /** Every daemon event a place pushes; the panes and the inbox read these once they ride the link. */
  onDaemonEvent?: (placeId: string, event: DaemonEvent) => void;
  /** How far an install on a computer this host has never met has got; the runtime puts these on its own stream. */
  onStage?: (event: PlaceStageEvent) => void;
  /** How long a computer has to dial back after its join before an install gives up on it. */
  joinWaitMs?: number;
  /** How long between the writes of a linked place's last seen, so a link held for a day is not a write a second. */
  seenEveryMs?: number;
  now?: () => number;
}

/** The host's side of the place link: the records, the keys, the handshake, the live links and what a remove takes. */
export interface PlaceDoor {
  /** The first frame of a joining computer. Answers the reply and the bytes its prove must sign, or nothing when
   * the code is not one this host is holding. Throws with its own sentence for a key or a report it cannot take. */
  join(req: PlaceJoinRequest, from: string, now: number): Promise<{ reply: PlaceJoinReply; expect: Uint8Array; notice?: string } | undefined>;
  /** The first frame of a place that already joined; nothing when this host holds no place by that id. */
  auth(req: PlaceAuthRequest, now: number): Promise<{ reply: PlaceAuthReply; expect: Uint8Array } | undefined>;
  /** Checks the place's signature over `expect` with the key on record and reads the report it sent by the one rule
   * every report is read by. Answers the report `attach` is to take, or the sentence to refuse the socket with:
   * the key's or the report's own. Attaches nothing yet. */
  prove(placeId: string, signature: string, expect: Uint8Array, report: PlaceReport): Promise<{ report: PlaceReport } | { refusal: string }>;
  /** Takes the proved socket as this place's link, with the report `prove` answered; the previous link is cut. */
  attach(placeId: string, socket: WebSocket, report: PlaceReport, from: string, now: number): Promise<void>;
  link(placeId: string): DaemonReach | undefined;
  /** Reads what this host holds about its places into memory, so the backend a fork on one stands on is answered
   * without a read of the store; the hydration calls it once before it reads any workspace record. */
  load(): Promise<void>;
  /** The backend a place offers, off what it last said about it; undefined on a place that has never said. On a
   * place that is not connected the backend is still answered, so a record standing on it can be held without a
   * round trip, and every call on it rejects with PlaceAbsentError. */
  backendOf(placeId: string): MachineBackend | undefined;
  /** The same, asked of the place itself where this host has not heard yet: one frame, remembered on the record, so
   * every road after it is answered without one. Refuses with placeForksNowhereLine on a computer that offers no
   * backend at all. */
  forkingBackend(placeId: string): Promise<MachineBackend>;
  /** The name a place goes by, for the sentences a person reads; the id itself for a place this host holds no
   * record of. Answered without a read, so a refusal built while a road is running names the computer. */
  nameOf(placeId: string): string;
  /** Which backend that computer offers, by the id of the row it serves; nothing until it has said. What a fork
   * standing there was forked by, so a row names a real provider and not the one this host happens to be wired
   * for. Answered without a read, since every view of every workspace asks it. */
  offerOf(placeId: string): string | undefined;
  /** A port on this computer's loopback carried to one port on the place's own, for as long as this host runs: the
   * place's own daemon port and every fork's daemon port ride the same code. The same pair answers the same local
   * port every time, and the listener stays bound while the link is down, so nothing cached goes stale. */
  forward(placeId: string, placePort: number): Promise<{ localPort: number }>;
  /** The place a person's word names: an id, a name, or this computer itself, which is answered with no id since
   * the host's own backend is what a fork there lands on. Refuses with noSuchPlaceRefusal naming what is held. */
  placeFor(word: string): Promise<{ placeId?: string }>;
  /** Where a fork lands when nobody says: the last place added or used, or this computer when that mark names a
   * row this host no longer holds. */
  defaultPlace(): Promise<{ placeId?: string }>;
  /** Writes the default mark: the last place a fork landed on. */
  markUsed(placeId: string | undefined): Promise<void>;
  /** Puts the agent on a computer over ssh and waits for it to dial back as a place. Refused in one sentence on a
   * host that wired no installer. */
  add(req: { addId?: string; address: string; name?: string; sshPort?: number; keyPath?: string; hostUrls: readonly string[] }, now: number): Promise<PlaceAdded>;
  /** The port on this computer's loopback that carries to the daemon on a linked place, opened at the first ask
   * and held with the link. Throws with the place's name when it is not connected or has said no port. */
  road(placeId: string): Promise<number>;
  /** One command on that place over its link; the refusal names the place when it is not connected. */
  exec(placeId: string, cmd: string, opts: { timeoutMs?: number; stdin?: Uint8Array }): Promise<ExecResult>;
  /** What the place last reported about itself, off its record. */
  reportOf(placeId: string): Promise<PlaceReport | undefined>;
  /** The home the place's login lands in, which every path a turn there is built from. */
  homeOf(placeId: string): Promise<string | undefined>;
  list(now: number): Promise<PlaceView[]>;
  remove(placeId: string): Promise<PlaceRemoved>;
  /** Every place a word picks, by id or by the name the person gave it: none, one, or the two that share a name,
   * which is a refusal the caller writes with the ids in it. */
  find(ref: string): Promise<PlaceRecord[]>;
  on(fn: (e: PlaceEvent) => void): () => void;
  close(): Promise<void>;
}

/** The one refusal for a runtime served without places wired, so the ops answer plainly rather than pretending
 * this host holds none. */
export const NO_PLACE_DOOR = "this runtime holds no places; the host that serves the app wires them";

/** What an install answers once the computer has dialled in: which stream of steps it was, the place it became,
 * and the key its ssh answered with. */
export interface PlaceAdded {
  addId: string;
  place: PlaceView;
  hostKey?: string;
}

/** What a remove answers: whether a place of that id was there, what the sweep took off that computer, what the
 * workspaces standing on it said as they went, and the one line for a place that was not connected to sweep. */
export interface PlaceRemoved {
  removed: boolean;
  swept: string[];
  dropped: string[];
  note?: string;
}

/** One promise with a bound of its own: a place that took a frame and went quiet fails the call rather than
 * leaving a road waiting on a socket nothing is coming back on. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} was not answered in ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
    work.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** A fresh ed25519 pair in the two spellings the link uses. The one road that makes one, so the host's own key and
 * a joining computer's are the same kind of key written the same way. */
export function newPlaceKeyPair(): PlaceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** A signature over the bytes both sides build from one function; ed25519 takes no digest name. The host signs its
 * half with its own key here, and wsp join signs a joining computer's half with the key it just made.
 *
 * The other copy of this pair is `signPlaceBytes` and `verifyPlaceBytes` in `packages/daemon/src/link.ts`, which is
 * the place's half. The boundary that forces it: the protocol is the one package both sides import and it is
 * bundled into the browser, so it can hold no node crypto. What could drift, the bytes that are signed and the
 * encodings they are sent in, is in the protocol (`placeLinkTranscript`, `PlaceSignature`, `PlacePublicKey`). */
export function signPlaceBytes(privateKeyPem: string, bytes: Uint8Array): string {
  return signBytes(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether the key given made this signature: the key on a place's record here, and at a join the key the host sent
 * with its own challenge. A key that will not even parse is a refusal rather than a throw: it came off the wire. */
export function verifyPlaceBytes(publicKeyBase64: string, bytes: Uint8Array, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return verifyBytes(null, bytes, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** Whether a public key off the wire is an ed25519 one this host can verify against later. Read before the code is
 * spent, so a key that opens nothing never costs somebody their join code. */
function readsAsEd25519(publicKeyBase64: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** The one sentence a join whose key this host cannot verify against is refused with. */
export const PLACE_BAD_KEY_REFUSAL = "that join sent a key this host cannot verify a signature against; a place's key is ed25519, as SPKI DER in base64";

/** The one sentence a report naming a home wsp cannot build a path under is refused with, on a join and on every
 * link after it. Everything a turn there runs is built from that path, so it is held to the rule every machine's
 * home is held to. */
export const placeHomeRefusal = (said: string | undefined): string =>
  `that computer reported ${said === undefined || said === "" ? "no home folder" : `${JSON.stringify(said)}, which is not a plain path`} for its login, so nothing on it could be reached; wsp holds a machine's home to a plain absolute path`;

/** Every report this host will build a path out of goes through here, and a report reaches this host on three
 * frames: the join, the prove that follows it, and the prove of every relink after that. The rule is the ssh read's
 * own, since what is in a report lands in the commands the host runs on that computer: the home a path is built
 * from is refused when it is not a plain path, the PATH is held to the folders that are ones, and a harness's store
 * folder is kept only where it is one. Answers the report this host will keep, or throws the refusal.
 *
 * The door's two entry points for a report, `join` and `prove`, are its only callers; `attach` takes what `prove`
 * answered, so no road can hand this host a report nothing read. */
export function takenReport(report: PlaceReport): PlaceReport {
  const home = report.login["HOME"];
  if (home === undefined || !isPlainPath(home)) throw new Error(placeHomeRefusal(home));
  const login: Record<string, string> = { ...report.login, HOME: home, PATH: plainPath(report.login["PATH"]) };
  for (const name of SSH_STORE_VARS) {
    const folder = login[name];
    if (folder !== undefined && !isPlainPath(folder)) delete login[name];
  }
  return { ...report, login };
}

/** How long between writes of a linked place's last seen. */
const SEEN_EVERY_MS = 60_000;

/** What a socket is closed with when a newer link for the same place arrives: a laptop that slept and came back is
 * the common case, and the old socket is a connection nothing is on the other end of. */
const REPLACED = "replaced by a newer link";

interface Live {
  socket: WebSocket;
  reach: DaemonReach;
  seen: NodeJS.Timeout;
  /** The loopback port carrying to that computer's daemon, opened at the first pane that asks for one. */
  forward?: Promise<PlaceForward>;
}

/** One port on this computer carried to one port on a place: the listener, which stays bound while the link comes
 * and goes, and the connections riding it right now by the id the far side knows each by. */
interface Forward {
  server: Server;
  localPort: number;
  conns: Map<string, Socket>;
}

/** How long a machine frame waits for its answer when the caller named no bound of its own. A link that dies fails
 * every frame on it at once, so this is the backstop for a place that took the frame and went quiet. */
const LINK_FRAME_MS = 300_000;

/** How long a place gets to say what its backend is, and how long the table asking what room it has left waits;
 * a person is watching both, and a place that does not answer in time shows what this host already knows. */
const BACKEND_FACTS_MS = 10_000;
const CAPACITY_MS = 5_000;
/** How long a computer has to dial back after its own join wrote its place file. A join that landed and a link
 * that never arrives is a network between the two, which is what the sentence says. */
const JOIN_WAIT_MS = 90_000;

export function makePlaceDoor(opts: PlaceDoorOptions): PlaceDoor {
  const { store, devices, wiring, recording } = opts;
  const clockNow = opts.now ?? Date.now;
  const seenEveryMs = opts.seenEveryMs ?? SEEN_EVERY_MS;
  const live = new Map<string, Live>();
  /** The records as they stand, by id: `load` fills it and every write below keeps it, so the one road that must
   * answer without waiting (which backend a fork's record stands on) can. */
  const kept = new Map<string, PlaceRecord>();
  /** The backend each place offers, built once from what that place said about it and swapped when it says
   * something else; the link under it is the door's, so the same object serves a place that comes and goes. */
  const backends = new Map<string, MachineBackend>();
  const forwards = new Map<string, Forward>();
  /** The read of one place's backend facts that is in flight, so two roads asking at once send one frame. */
  const asking = new Map<string, Promise<MachineBackend>>();
  const watchers = new Set<(e: PlaceEvent) => void>();
  let tunnelSeq = 0;
  const emit = (e: PlaceEvent): void => {
    for (const fn of watchers) fn(e);
  };

  const records = async (): Promise<PlaceRecord[]> => (await store.list(PLACES)).filter(isPlaceRecord).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  /** The provider this host forks on when nobody names a place: the place a record with no place word stands on.
   * The wiring is what says whether this host forks on a provider at all; a runtime served with no wiring of its
   * own has a one-row table standing for its backend, which is no place a person names. */
  const wiredProvider = (): string | undefined => wiring.provider()?.id;
  /** Every provider a fork can land at, in the table's own order, the wired one among them. A host wired to one
   * cloud that holds the key for another can fork at either, so both are rows a person names. */
  const providerIds = (): readonly string[] => {
    const wired = wiredProvider();
    if (wired === undefined) return [];
    const table = opts.providers?.().list() ?? [];
    return table.includes(wired) ? table : [wired];
  };
  /** The backend of a provider row, or nothing when the word names no provider this host holds a key for. */
  const providerBackend = (placeId: string): MachineBackend | undefined => opts.providers?.().backend(placeId);
  /** What one provider charges an hour for its default size, read off the backend the host built for it, so a row
   * added by saving a key carries its price with no second table. */
  const providerRate = (placeId: string): number | undefined => {
    const at = placeId === wiredProvider() ? undefined : providerBackend(placeId);
    if (at === undefined) return placeId === wiredProvider() ? wiring.provider()?.rateUsdPerHour : undefined;
    return at.pricing.rateUsdPerHour(at.pricing.defaultSize);
  };
  const recordOf = async (placeId: string): Promise<PlaceRecord | undefined> => {
    const found = await store.get(PLACES, placeId);
    return isPlaceRecord(found) ? found : undefined;
  };
  /** The one write of a place record: the store and the memory the sync roads read both move, so a backend answered
   * without a read is never answered off a record the store has moved past. */
  const keep = async (record: PlaceRecord): Promise<void> => {
    kept.set(record.id, record);
    await store.put(PLACES, record.id, record);
  };
  const defaultId = async (): Promise<string | undefined> => {
    const held = (await store.get(DEFAULT_COLLECTION, DEFAULT_ID)) as { placeId?: unknown } | undefined;
    return typeof held?.placeId === "string" ? held.placeId : undefined;
  };
  const markDefault = (placeId: string): Promise<void> => store.put(DEFAULT_COLLECTION, DEFAULT_ID, { placeId });

  /** The host's half of the handshake, the one place it is built: a fresh nonce, the signature over the transcript
   * the place challenged with, and the bytes the place's own signature must cover. */
  const challenge = (placeId: string, placeNonce: string): { nonce: string; signature: string; expect: Uint8Array } => {
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    return {
      nonce,
      signature: signPlaceBytes(wiring.hostKey.privateKeyPem, placeLinkTranscript("host", placeId, placeNonce, nonce)),
      expect: placeLinkTranscript("place", placeId, nonce, placeNonce),
    };
  };

  const writeSeen = async (placeId: string, at: number): Promise<void> => {
    const held = await recordOf(placeId);
    if (held === undefined) return;
    await keep({ ...held, lastSeenAt: new Date(at).toISOString() });
  };

  /** The road the engine drives one place's machines over: one frame and its answer, and the loopback forward a
   * route into a machine there is taken by. A place that is not connected is PlaceAbsentError on every call, which
   * is the one answer every road on an absent place reads. */
  const linkTo = (placeId: string): MachineLink => ({
    request: async (op, params, o) => {
      const reach = live.get(placeId)?.reach;
      if (reach === undefined) throw new PlaceAbsentError(placeAbsentLine(kept.get(placeId)?.name ?? placeId));
      return bounded(reach.request(op, params), o?.timeoutMs ?? LINK_FRAME_MS, `${op} on ${kept.get(placeId)?.name ?? placeId}`);
    },
    forward: placePort => door.forward(placeId, placePort),
  });

  /** The backend a place offers, off the facts it last sent. Built once per place and kept: the link under it reads
   * the live socket at every call, so one backend serves a computer that comes and goes. */
  const backendFrom = (placeId: string, facts: BackendFacts): MachineBackend => {
    const made = LinkBackend.of(linkTo(placeId), facts);
    backends.set(placeId, made);
    return made;
  };

  /** A frame the forward owns rather than the panes: the bytes of one connection riding a tunnel, or its end.
   * Answers whether it was taken. */
  const tunnelled = (placeId: string, e: DaemonEvent): boolean => {
    if (e.type !== "tunnel.data" && e.type !== "tunnel.end") return false;
    const conn = connOf(placeId, e.tunnelId);
    if (e.type === "tunnel.data") conn?.write(Buffer.from(e.data, "base64"));
    else conn?.end();
    return true;
  };
  const connOf = (placeId: string, tunnelId: string): Socket | undefined => {
    for (const [key, f] of forwards) {
      if (!key.startsWith(`${placeId}:`)) continue;
      const conn = f.conns.get(tunnelId);
      if (conn !== undefined) return conn;
    }
    return undefined;
  };

  /** Frees what this host holds about one link: the poller, the reach and the socket. The place's own redial is
   * what brings the next one. */
  const cut = (placeId: string, reason: string): void => {
    const held = live.get(placeId);
    if (held === undefined) return;
    live.delete(placeId);
    clearInterval(held.seen);
    void held.forward?.then(f => f.close()).catch(() => undefined);
    held.reach.close();
    held.socket.close(1000, reason);
  };

  /** The installs waiting on a computer to dial in, keyed by the code each handed it: the join notes which place
   * the code became and the attach that follows wakes the install. */
  const awaiting = new Map<string, { placeId?: string; woken?: (placeId: string) => void }>();
  /** How many forks a place holds and how many more it takes, off what its own backend says about the computer it
   * runs on. Only what this host already knows is waited for: a table is something a person is watching, so a place
   * that has not yet said what it forks with shows nothing in that column and is asked behind the listing, and one
   * that does not answer in time shows nothing rather than a guess. */
  const forksOf = async (record: PlaceRecord): Promise<{ running: number; room: number } | undefined> => {
    const linked = live.has(record.id) && record.report.docker;
    const backend = linked ? door.backendOf(record.id) : undefined;
    if (backend === undefined) {
      if (linked) void door.forkingBackend(record.id).catch(() => undefined);
      return undefined;
    }
    if (backend.capacity === undefined) return undefined;
    try {
      const capacity = await bounded(backend.capacity(), CAPACITY_MS, `machine.capacity on ${record.name}`);
      const image = capacity.images.reduce((most, i) => Math.max(most, i.sizeBytes), 0);
      return {
        // Every fork that computer is holding, napping ones included: a row that says napping is a machine the
        // person still has there, so this column and the workspace list cannot disagree about how many.
        running: capacity.machines.running + capacity.machines.paused,
        // What a fork takes there, not what it would be asked for: a computer clamps a machine to its own share.
        room: forkRoom(capacity, Math.min(backend.pricing.defaultSize.memMb, capacity.machineMemMb), image === 0 ? undefined : image),
      };
    } catch {
      return undefined;
    }
  };

  const viewOf = (record: PlaceRecord, defaulted: string | undefined): PlaceView => ({
    id: record.id,
    kind: "computer",
    name: record.name,
    default: defaulted === record.id,
    os: record.report.os,
    shape: record.report.shape,
    ...(record.report.diskFreeBytes !== undefined ? { diskFreeBytes: record.report.diskFreeBytes } : {}),
    docker: record.report.docker,
    present: live.has(record.id),
    joinedAt: record.joinedAt,
    lastSeenAt: record.lastSeenAt,
    daemonVersion: record.report.daemonVersion,
    agents: record.report.agents,
    // A joined computer forks only where it has a Docker of its own; without one it runs the person's agents as
    // its own one workspace and that is the whole of it.
    takesForks: record.report.docker === true,
    ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
  });

  const door: PlaceDoor = {
    async join(req, from, at) {
      // The key and the report are read before the code is spent, so a join that was never going to stand does not
      // cost the person their code.
      if (!readsAsEd25519(req.publicKey)) throw new Error(PLACE_BAD_KEY_REFUSAL);
      const taken = takenReport(req.report);
      if (!(await devices.spend(req.code, at))) return undefined;
      // Eight bytes: the id keys the store, so two places that drew the same one would be one record and the older
      // computer's link would replace the newer's on every dial.
      const id = `p_${randomBytes(8).toString("hex")}`;
      const stamp = new Date(at).toISOString();
      const record: PlaceRecord = { id, name: taken.name, publicKey: req.publicKey, joinedAt: stamp, lastSeenAt: stamp, report: taken };
      await keep(record);
      // Last added is the default, which is what makes the computer somebody just joined the one a verb means.
      await markDefault(id);
      const recorded = await recording.record(record);
      const held: PlaceRecord = recorded.workspaceId === undefined ? record : { ...record, workspaceId: recorded.workspaceId };
      if (recorded.workspaceId !== undefined) await keep(held);
      // One code buys the place and, when the app asked, the token the joining computer's own window holds: the
      // person's intent was one act. The socket stays the place link and is bound to no device.
      const client = req.client === undefined ? undefined : await devices.admit(req.client.name, at);
      const { nonce, signature, expect } = challenge(id, req.nonce);
      // An install that handed this computer the code is waiting on the link it will open next.
      const waiting = awaiting.get(req.code);
      if (waiting !== undefined) waiting.placeId = id;
      emit({ type: "place.joined", place: viewOf(held, id), from });
      return {
        reply: {
          placeId: id,
          hostPublicKey: wiring.hostKey.publicKey,
          nonce,
          signature,
          hostName: wiring.hostName(),
          ...(client === undefined ? {} : { device: { deviceId: client.deviceId, deviceToken: client.deviceToken } }),
        },
        expect,
        ...(recorded.notice !== undefined ? { notice: recorded.notice } : {}),
      };
    },

    async auth(req) {
      if ((await recordOf(req.placeId)) === undefined) return undefined;
      const { nonce, signature, expect } = challenge(req.placeId, req.nonce);
      return { reply: { nonce, hostPublicKey: wiring.hostKey.publicKey, signature }, expect };
    },

    async prove(placeId, signature, expect, report) {
      const held = await recordOf(placeId);
      if (held === undefined || !verifyPlaceBytes(held.publicKey, expect, signature)) return { refusal: PLACE_KEY_REFUSAL };
      // The report on this frame is the one the record and the workspace take, on a join's second frame and on every
      // relink alike, so it is read by the same rule the join's own frame was.
      try {
        return { report: takenReport(report) };
      } catch (e) {
        return { refusal: e instanceof Error ? e.message : String(e) };
      }
    },

    async attach(placeId, socket, report, from, at) {
      // A second link replaces the first: a laptop that slept and came back dials before the host has noticed the
      // old socket is a connection to nothing.
      cut(placeId, REPLACED);
      const held = await recordOf(placeId);
      if (held === undefined) {
        socket.close(1000, "this host no longer holds that place");
        return;
      }
      const moved: PlaceRecord = { ...held, name: report.name, report, lastSeenAt: new Date(at).toISOString() };
      await keep(moved);
      // What a turn there runs under is this link's report and not the join's: a person installs a tool on their own
      // computer and the next link is where wsp learns it.
      await recording.refresh(moved);
      const reach = connectDaemon({
        socket,
        onEvent: e => {
          // A tunnel's bytes belong to the connection riding the forward that opened it and to nothing else on
          // this host: the road a fork's daemon is reached by reads its own frames, the pane's road reads the
          // rest, and neither is pushed at every watcher of the place.
          if (tunnelled(placeId, e)) return;
          void live.get(placeId)?.forward?.then(f => f.event(e)).catch(() => undefined);
          opts.onDaemonEvent?.(placeId, e);
        },
      });
      const seen = setInterval(() => void writeSeen(placeId, clockNow()).catch(() => undefined), seenEveryMs);
      // The poller must not hold a host that is otherwise done open.
      seen.unref?.();
      live.set(placeId, { socket, reach, seen });
      // A computer that says it no longer forks is taken at its word at once: what it said before is not a fact
      // about the computer that is here now. One that says it does is asked what it forks with behind the attach
      // and not in front of it, so the link is held whether or not that answer comes and the first listing after a
      // join carries the room it has left.
      if (!moved.report.docker) backends.delete(placeId);
      else void door.forkingBackend(placeId).catch((e: unknown) => console.warn(`${moved.name} did not say what it forks with: ${e instanceof Error ? e.message : String(e)}`));
      socket.once("close", () => {
        const mine = live.get(placeId);
        if (mine?.socket !== socket) return;
        live.delete(placeId);
        clearInterval(seen);
        // The port this host opened for that computer's panes goes with the link that carried them: a listener
        // left standing would answer a pane with a connection to nothing.
        void mine.forward?.then(f => f.close()).catch(() => undefined);
        reach.close();
        void writeSeen(placeId, clockNow()).catch(() => undefined);
        emit({ type: "place.absent", placeId });
      });
      emit({ type: "place.present", placeId, from });
      // Not taken off the list here: the join's own socket attaches and closes before the agent's link dials, and
      // an install that has not reached its wait yet would otherwise never be woken by the link that follows.
      for (const waiting of awaiting.values()) {
        if (waiting.placeId === placeId) waiting.woken?.(placeId);
      }
    },

    link: placeId => live.get(placeId)?.reach,

    async load() {
      for (const record of await records()) {
        kept.set(record.id, record);
        if (record.backendFacts !== undefined && !backends.has(record.id)) backendFrom(record.id, record.backendFacts);
      }
    },

    nameOf: placeId => kept.get(placeId)?.name ?? placeId,

    offerOf: placeId => kept.get(placeId)?.backendFacts?.offer ?? (providerIds().includes(placeId) ? placeId : undefined),

    backendOf(placeId) {
      const made = backends.get(placeId);
      if (made !== undefined) return made;
      const facts = kept.get(placeId)?.backendFacts;
      if (facts !== undefined) return backendFrom(placeId, facts);
      // No record and no facts: the word names a provider row rather than a computer, and its backend is the one
      // the host built for that provider.
      return kept.has(placeId) ? undefined : providerBackend(placeId);
    },

    async forkingBackend(placeId) {
      const record = (await recordOf(placeId)) ?? kept.get(placeId);
      // A place that is no joined computer is a provider row: it forks by its own module and there is no link to
      // ask what it forks with.
      if (record === undefined) {
        const at = providerBackend(placeId);
        if (at !== undefined) return at;
      }
      const name = record?.name ?? placeId;
      if (record === undefined || !record.report.docker) {
        backends.delete(placeId);
        throw new Error(placeForksNowhereLine(name));
      }
      const made = door.backendOf(placeId);
      if (made !== undefined) return made;
      // The first fork on this computer is where the host learns what it forks with; every road after it reads the
      // answer off the record, so this frame is sent once per computer and not once per fork.
      const inflight = asking.get(placeId);
      if (inflight !== undefined) return inflight;
      const read = (async () => {
        const answer = await bounded(linkTo(placeId).request("machine.backend"), BACKEND_FACTS_MS, `machine.backend on ${name}`);
        const facts = BackendFacts.parse(answer);
        await keep({ ...record, backendFacts: facts });
        return backendFrom(placeId, facts);
      })().finally(() => asking.delete(placeId));
      asking.set(placeId, read);
      return read;
    },

    async forward(placeId, placePort) {
      const key = `${placeId}:${placePort}`;
      const already = forwards.get(key);
      if (already !== undefined) return { localPort: already.localPort };
      const conns = new Map<string, Socket>();
      const server = createServer(conn => {
        const tunnelId = `p${++tunnelSeq}`;
        const reach = live.get(placeId)?.reach;
        conn.on("error", () => {});
        if (reach === undefined) {
          // The listener stays bound while the place is away: the route this host handed out keeps its port, and a
          // connection made meanwhile is refused rather than held.
          conn.destroy();
          return;
        }
        conns.set(tunnelId, conn);
        conn.pause();
        conn.on("close", () => {
          conns.delete(tunnelId);
          void reach.request("tunnel.close", { tunnelId }).catch(() => undefined);
        });
        reach.request("tunnel.open", { tunnelId, port: placePort }).then(
          () => {
            conn.on("data", (d: Buffer) => void reach.request("tunnel.write", { tunnelId, data: d.toString("base64") }).catch(() => conn.destroy()));
            conn.resume();
          },
          () => {
            conns.delete(tunnelId);
            conn.destroy();
          },
        );
      });
      const localPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
          server.unref();
          const addr = server.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
        });
      });
      forwards.set(key, { server, localPort, conns });
      return { localPort };
    },

    async placeFor(word) {
      const all = await records();
      const found = all.find(r => r.id === word || r.name === word);
      if (found !== undefined) return { placeId: found.id };
      const here = wiring.here().name;
      const providers = providerIds();
      // The wired provider is where a record with no place word already stands, so naming it is that same road and
      // the record stays as every record before joined computers existed.
      if (word === HERE_PLACE_ID || word === here || word === wiredProvider()) return {};
      if (providers.includes(word)) return { placeId: word };
      throw new Error(noSuchPlaceRefusal(word, [here, ...all.map(r => r.name), ...providers]));
    },

    async defaultPlace() {
      const marked = await defaultId();
      if (marked === undefined) return {};
      const found = (await records()).find(r => r.id === marked);
      if (found !== undefined) return { placeId: found.id };
      // A provider the last fork landed on that is not the one this host is wired to is still that place.
      return marked !== wiredProvider() && providerIds().includes(marked) ? { placeId: marked } : {};
    },

    async markUsed(placeId) {
      await markDefault(placeId ?? wiredProvider() ?? HERE_PLACE_ID);
    },

    async add(req, at) {
      const install = wiring.install;
      if (install === undefined) throw new Error(NO_PLACE_INSTALLER);
      const addId = req.addId ?? `a_${randomBytes(6).toString("hex")}`;
      let step: PlaceAddStep = "connect";
      const stage: PlaceStaging = (which, state, note) => {
        step = which;
        opts.onStage?.({ type: "place.stage", addId, step: which, state, ...(note !== undefined ? { note } : {}) });
      };
      const { code } = await devices.issue({ now: at, ttlMs: PAIR_CODE_TTL_MS });
      const waiting: { placeId?: string; woken?: (placeId: string) => void } = {};
      awaiting.set(code, waiting);
      try {
        const { addId: _stream, ...asked } = req;
        const installed = await install({ ...asked, code }, stage);
        stage("join", "running");
        const placeId = await new Promise<string>((woken, fail) => {
          // The link may already be up: the computer dials the moment its own join has written its place file, and
          // that can land before the install's own ssh command has answered.
          if (waiting.placeId !== undefined && live.has(waiting.placeId)) {
            woken(waiting.placeId);
            return;
          }
          const timer = setTimeout(() => fail(new Error(placeNoLinkLine(installed.name))), opts.joinWaitMs ?? JOIN_WAIT_MS);
          timer.unref?.();
          waiting.woken = id => {
            clearTimeout(timer);
            woken(id);
          };
        });
        const held = await recordOf(placeId);
        if (held === undefined) throw new Error(placeNoLinkLine(installed.name));
        // The size the box reported is not here: every road that draws this line draws the box's row beside it, and
        // a fact already in the row costs the line the room it needs to read whole.
        stage("join", "done", `docker ${held.report.docker ? "yes" : "no"}`);
        return { addId, place: viewOf(held, await defaultId()), ...(installed.hostKey !== undefined ? { hostKey: installed.hostKey } : {}) };
      } catch (e) {
        // The step the install was on when it stopped is the one that failed, so a person reads the sentence
        // against the line it belongs to rather than under the list.
        stage(step, "failed", e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        awaiting.delete(code);
      }
    },

    async road(placeId) {
      const held = live.get(placeId);
      const name = (await recordOf(placeId))?.name ?? placeId;
      if (held === undefined) throw new Error(placeAbsentLine(name));
      const port = (await recordOf(placeId))?.report.daemonPort;
      if (port === undefined) throw new Error(placeNoDaemonPortLine(name));
      // One port per link, opened at the first pane that asks and closed with the link it rides.
      held.forward ??= openPlaceForward(held.reach, port);
      try {
        return (await held.forward).port;
      } catch (e) {
        if (live.get(placeId) === held) delete held.forward;
        throw e;
      }
    },

    async exec(placeId, cmd, execOpts) {
      const reach = live.get(placeId)?.reach;
      if (reach === undefined) throw new Error(placeAbsentLine((await recordOf(placeId))?.name ?? placeId));
      const answer = await reach.request("exec", {
        cmd,
        ...(execOpts.timeoutMs !== undefined ? { timeoutMs: execOpts.timeoutMs } : {}),
        ...(execOpts.stdin !== undefined ? { stdin: Buffer.from(execOpts.stdin).toString("base64") } : {}),
      });
      return { exitCode: Number(answer["exitCode"] ?? -1), stdout: String(answer["stdout"] ?? ""), stderr: String(answer["stderr"] ?? "") };
    },

    reportOf: async placeId => (await recordOf(placeId))?.report,
    homeOf: async placeId => (await recordOf(placeId))?.report.login["HOME"],

    async list() {
      const defaulted = await defaultId();
      const here = wiring.here();
      const providers = providerIds();
      const held = await records();
      // This computer first, the computers joined to it after, the providers last; exactly one default, which falls
      // to this computer when the mark names a row that is no longer here.
      const marked = held.some(r => r.id === defaulted) || (defaulted !== undefined && providers.includes(defaulted)) ? defaulted : HERE_PLACE_ID;
      const room = new Map(await Promise.all(held.map(async r => [r.id, await forksOf(r)] as const)));
      return [
        {
          id: HERE_PLACE_ID,
          kind: "computer" as const,
          name: here.name,
          default: marked === HERE_PLACE_ID,
          ...(here.os !== undefined ? { os: here.os } : {}),
          ...(here.shape !== undefined ? { shape: here.shape } : {}),
          ...(here.diskFreeBytes !== undefined ? { diskFreeBytes: here.diskFreeBytes } : {}),
          ...(here.docker !== undefined ? { docker: here.docker } : {}),
          present: true,
          // This computer is where the person's own agents run, never something the host forks into: a copy of the
          // image on a Docker here is the provider row's, which is the one that says it forks.
          takesForks: false,
        },
        ...held.map(r => {
          const forks = room.get(r.id);
          return { ...viewOf(r, marked), ...(forks !== undefined ? { forks } : {}) };
        }),
        ...providers.map(id => {
          const rate = providerRate(id);
          return { id, kind: "provider" as const, name: id, default: marked === id, takesForks: true, ...(rate !== undefined ? { rateUsdPerHour: rate } : {}) };
        }),
      ];
    },

    async remove(placeId) {
      const held = await recordOf(placeId);
      if (held === undefined) return { removed: false, swept: [], dropped: [] };
      // The forks on it are wsp's own machines and the person's to delete: a place taken out from under them would
      // leave containers on that computer nothing here can name again.
      const forks = await recording.forksOn(placeId);
      if (forks.length > 0) throw new Error(placeHoldsForksRefusal(held.name, forks));
      const reach = live.get(placeId)?.reach;
      let swept: string[] = [];
      let note: string | undefined;
      if (reach === undefined) note = placeStillInstalledLine(held.name);
      else {
        // The sweep is the place's own: it knows its service manager and where the installer put things. The agent
        // ends itself once it has answered, so nothing brings it back.
        try {
          const answer = await reach.request("place.leave");
          swept = Array.isArray(answer["swept"]) ? (answer["swept"] as unknown[]).map(String) : [];
        } catch (e) {
          note = `${held.name} was connected but did not finish the sweep: ${e instanceof Error ? e.message : String(e)}; run ${PLACE_LEAVE_LINE} on that computer`;
        }
        cut(placeId, "removed from this host");
      }
      // The workspaces standing on it go by the ordinary delete road, so their threads and transcripts go with them.
      const dropped = await recording.drop(placeId);
      kept.delete(placeId);
      backends.delete(placeId);
      await store.delete(PLACES, placeId);
      if ((await defaultId()) === placeId) await store.delete(DEFAULT_COLLECTION, DEFAULT_ID);
      emit({ type: "place.removed", placeId });
      return { removed: true, swept, dropped, ...(note !== undefined ? { note } : {}) };
    },

    find: async ref => (await records()).filter(r => r.id === ref || r.name === ref),

    on: fn => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },

    close: async () => {
      for (const placeId of [...live.keys()]) cut(placeId, "this host is stopping");
      for (const [key, f] of forwards) {
        for (const conn of f.conns.values()) conn.destroy();
        f.conns.clear();
        f.server.close();
        forwards.delete(key);
      }
      awaiting.clear();
    },
  };
  return door;
}
