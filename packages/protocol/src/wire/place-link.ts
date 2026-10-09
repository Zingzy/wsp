// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { DEFAULT_PLACE_PORT } from "../app-ports.js";
import { PLACE_LEAVE_LINE } from "../format.js";
import { base64, reqId } from "./helpers.js";
import { isHttpUrl, isUnderPath } from "./limits.js";
import { WorkspaceSize } from "./capabilities.js";
import { CopyWord } from "../views/place.js";

// --- places: a computer you own, joined by dialling this host ---------------

/** How many bytes each side's challenge is. Thirty-two: a nonce is what keeps a signature from being replayed, and
 * a birthday collision on it has to be out of reach for the life of a key, not for the life of one link. */
export const PLACE_LINK_NONCE_BYTES = 32;

export const PlaceNonce = base64(PLACE_LINK_NONCE_BYTES);
/** An ed25519 public key as SPKI DER, base64: 44 bytes. */
export const PlacePublicKey = base64(44);
/** An ed25519 signature, base64: 64 bytes. */
export const PlaceSignature = base64(64);
/** An X25519 public key as its raw 32 bytes, base64: what each end of a link sends to agree the key every frame
 * after the handshake is sealed under. Fresh per attempt and never held past the socket. */
export const PlaceEphemeral = base64(32);

/** The engine a project's own containers would run on: Docker first, then podman, else none. The one rule both
 * the host's own-machine report and the node agent's read off their own PATH check. */
export type PlaceEngine = "none" | "docker" | "podman";
export const engineWord = (hasDocker: boolean, hasPodman: boolean): PlaceEngine => (hasDocker ? "docker" : hasPodman ? "podman" : "none");

/** How many agents one computer may report: the list and the version map keyed by it are held to one number, and
 * the daemon's own deserialiser holds them to the same one. */
const AGENTS_REPORTED_MAX = 32;

/** What a place says about itself on every link, and once at join. Read by the host into the place record and the
 * workspace recorded on it; nothing here is trusted for paths until isPlainPath has read it. */
export const PlaceReport = z.object({
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "linux"]),
  arch: z.string().max(32),
  os: z.string().max(200),
  shape: WorkspaceSize,
  /** What is free on the volume a setup installs onto: wsp's install folder's, or the nearest folder above it that is there. */
  diskFreeBytes: z.number().int().nonnegative().optional(),
  /** The size of that same disk, off the same read: what a setup keeps free there is a share of it. */
  diskSizeBytes: z.number().int().nonnegative().optional(),
  /** Which Mac this is, as its registry names the product, else its model identifier; absent off a Mac. */
  model: z.string().max(200).optional(),
  /** HOME, USER, PATH and each harness's store variable, as the ssh read records them. */
  login: z.record(z.string()),
  /** Whether this computer's own daemon runs workspaces here: cgroup v2 with the controllers a cap needs, an
   * overlay, and root. What decides whether the place forks at all, where the docker field once did. */
  runsWorkspaces: z.boolean(),
  /** When it does not, the one kernel reason, in the daemon's own words. */
  workspacesBlocked: z.string().optional(),
  /** The engine a project's own containers would run on here; "none" until the person installs one. */
  engine: z.enum(["none", "docker", "podman"]),
  /** How this computer makes a workspace's copy of a checkout. Absent where the computer runs no workspaces. */
  copies: CopyWord.optional(),
  /** How long that computer had been up when it wrote this report. Kept on the record so a row can say what the
   * computer last was rather than nothing while it is not answering. */
  uptimeMs: z.number().int().nonnegative().optional(),
  daemonVersion: z.number().int().nonnegative(),
  /** The loopback port the place's own daemon bound, for the forward the panes ride. */
  daemonPort: z.number().int().min(1).max(65535).optional(),
  /** The line that runs wsp on this place, word by word, for the tools a turn's agent is given later. */
  wsp: z.array(z.string()).min(1),
  /** The catalog ids of the agents found on that computer's own login PATH, for the line the person reads as it
   * joins. Capped because it lands in a sentence, not in a list a person scrolls. */
  agents: z.array(z.string().max(32)).max(AGENTS_REPORTED_MAX),
  /** What each of those agents answered its own version flag with, by the same catalog id: the first line of
   * `<bin> --version`, as the computer said it. Absent on a computer whose agents have not been read yet. Under
   * the same cap as the list it is keyed by, since zod counts an object's keys nowhere else. */
  agentVersions: z
    .record(z.string().max(64))
    .refine(said => Object.keys(said).length <= AGENTS_REPORTED_MAX, `at most ${AGENTS_REPORTED_MAX} agents`)
    .optional(),
  /** The files under that computer's logins directory, each named under it: what a sign-in there wrote and every
   * workspace on it shares. Absent from a report a daemon older than this field sent, which is unknown and not
   * none; a name that walks out of that folder is refused, since the host joins it onto a folder of its own. */
  logins: z.array(z.string().max(200).refine(isUnderPath, "a name under a folder")).max(64).optional(),
  /** Whether a thread on that computer itself reaches the wsp tools: its daemon bound the socket for those threads
   * under the login's home and wrote the wsp beside it that dials it. Absent from a daemon older than that door,
   * whose threads are launched with no wsp tools. */
  wspDoor: z.boolean().optional(),
  /** When it does not, why, in the daemon's own words. */
  wspDoorBlocked: z.string().optional(),
  /** The systemd unit its daemon runs under, the one the join wrote, read off its own cgroup: what the person
   * restarts to open the door again. Absent where the daemon runs under no unit. */
  daemonUnit: z.string().max(256).regex(/^[\w@.:-]+\.service$/).optional(),
  /** Whether a leave run there takes the runtime's folder, and the copy of the image in it: only as root, with the
   * add's whole record not naming it as there before. Absent from a daemon older than this field, whose leave never
   * takes it. */
  takesRuntime: z.boolean().optional(),
  /** The daemon version the wsp in `wsp` was built with, as it said it: which `wsp leave` that computer runs, which an
   * update of its daemon alone does not move. Absent where that wsp said none, which every wsp older than this field
   * does. */
  wspDaemonVersion: z.number().int().optional(),
  /** Which of the host's addresses this link reached; the address a turn on the place is told to dial back. */
  dialed: z.string().refine(isHttpUrl, "http or https URL"),
});
export type PlaceReport = z.infer<typeof PlaceReport>;

/** The first frame of a joining place: the key it will prove and the two public values that agree the seal.
 * Nothing of the person's rides it, since nothing has proved who is on the other end yet: the code it spends and
 * the report it carries go in the prove, inside the seal. Answered with PlaceJoinReply; the socket then continues
 * with place.prove as an auth would. */
export const PlaceJoinRequest = z.object({
  id: reqId,
  op: z.literal("place.join"),
  publicKey: PlacePublicKey,
  nonce: PlaceNonce,
  /** Absent from a computer running a wsp older than the seal, which the host refuses in its own sentence rather
   * than reading a frame it cannot answer. */
  ephemeral: PlaceEphemeral.optional(),
});
export type PlaceJoinRequest = z.infer<typeof PlaceJoinRequest>;
export const PlaceJoinReply = z.object({
  placeId: z.string(),
  hostPublicKey: PlacePublicKey,
  nonce: PlaceNonce,
  signature: PlaceSignature,
  ephemeral: PlaceEphemeral,
  /** What the primary computer calls itself, which is what the joined computer shows a person from then on. */
  hostName: z.string().min(1).max(200),
});
export type PlaceJoinReply = z.infer<typeof PlaceJoinReply>;

/** The token a join's own window was given, on the reply to its prove: the one thing of the person's a join
 * takes back, and it rides inside the seal now that the reply to frame one no longer carries it. */
export const PlaceJoinDevice = z.object({ deviceId: z.string(), deviceToken: z.string().min(1) });
export type PlaceJoinDevice = z.infer<typeof PlaceJoinDevice>;

/** The first frame of a place that already joined: names itself and challenges the host. */
export const PlaceAuthRequest = z.object({ id: reqId, op: z.literal("place.auth"), placeId: z.string().max(64), nonce: PlaceNonce, ephemeral: PlaceEphemeral.optional() });
export type PlaceAuthRequest = z.infer<typeof PlaceAuthRequest>;
export const PlaceAuthReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature, ephemeral: PlaceEphemeral });
export type PlaceAuthReply = z.infer<typeof PlaceAuthReply>;

/** What a host puts on its refusal of that frame when it holds no place by the id it named: its own key and a
 * signature over the refusal transcript. A place verifies it against the key it pinned at join and takes the long
 * wait on it, since nothing changes until a person acts; a refusal carrying neither, or one the pinned key did not
 * make, is a frame anybody who answers at the address can send and costs that computer no wait of its own. */
export const PlaceAuthRefusal = z.object({ hostPublicKey: PlacePublicKey, signature: PlaceSignature });
export type PlaceAuthRefusal = z.infer<typeof PlaceAuthRefusal>;

/** The second frame, and the first one sealed: the place's answer to the host's nonce and its report as it stands
 * now. A join's prove carries the code it spends and the window it wants too, which is where they cross now that
 * the host has proved itself and nothing of the person's may travel before it. After this the socket is the place
 * link and carries daemon frames only. */
export const PlaceProveRequest = z.object({
  id: reqId,
  op: z.literal("place.prove"),
  signature: PlaceSignature,
  report: PlaceReport,
  /** A join's own: the code this computer spends, and the window it also wants a token for. Absent on a relink,
   * which spends nothing, and on a join typed in a terminal, which wants no window. */
  code: z.string().max(64).optional(),
  client: z.object({ name: z.string().min(1).max(200) }).optional(),
});
export type PlaceProveRequest = z.infer<typeof PlaceProveRequest>;

/** What both sides sign, built by one function so they cannot drift: the role of the signer, the place id, the two
 * nonces and the two ephemerals, the challenged party's first in each pair. The host signs the transcript the
 * place challenged it with and the place signs the host's, so neither side's signature can be replayed back at it
 * as the other's; the ephemerals are inside it, so the key the two ends agree is one both signatures cover and a
 * carrier that swapped either of them has signed nothing. */
export function placeLinkTranscript(role: "host" | "place", placeId: string, challenge: string, answer: string, ephemerals: { challenger: string; answerer: string }): Uint8Array {
  return new TextEncoder().encode(`wsp place link v2\n${role}\n${placeId}\n${challenge}\n${answer}\n${ephemerals.challenger}\n${ephemerals.answerer}\n`);
}

/** What a host signs to refuse a place at its first frame, built by one function so the two sides cannot drift:
 * the place id it named, the nonce it challenged with and the sentence it is refused by. The nonce is inside, so
 * one dial's refusal cannot be replayed at the next; the sentence is inside, so it cannot be bent to another. */
export function placeRefusalTranscript(placeId: string, placeNonce: string, sentence: string): Uint8Array {
  return new TextEncoder().encode(`wsp place refusal v1\n${placeId}\n${placeNonce}\n${sentence}\n`);
}

/** What stands where a place id stands for a client's seal: a client is no place and holds no record here, so the
 * word is the same on both ends and rides the transcript and the key derivation exactly as a place id does. */
export const SEAL_CLIENT = "client";

/** The first frame of a client that holds the fingerprint of this host's key: its nonce and its half of the key
 * agreement, before the code or the token it came to send. Answered with SealOpenReply, after which every frame
 * this socket carries either way is sealed under the key both ends agreed. */
export const SealOpenRequest = z.object({ id: reqId, op: z.literal("seal.open"), nonce: PlaceNonce, ephemeral: PlaceEphemeral });
export type SealOpenRequest = z.infer<typeof SealOpenRequest>;

/** The host's answer: the key it proves, its nonce, its half of the agreement and its signature over the same
 * transcript a place challenges it with, the client's word in the place id's slot. The client refuses before it
 * sends anything of the person's unless the fingerprint is the one it pinned and the signature stands. */
export const SealOpenReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature, ephemeral: PlaceEphemeral });
export type SealOpenReply = z.infer<typeof SealOpenReply>;

/** The first frame of a computer coming in through the account, inside the seal the frame above agreed: the key it
 * proves, what to call it in the listing, and its signature over the bytes the host challenged it with, which are
 * the same bytes a joined computer signs at place.prove. Answered with `{ deviceId, deviceToken }`, as a redeem is,
 * and the socket is that device from then on. */
export const DeviceAuthRequest = z.object({
  id: reqId,
  op: z.literal("device.auth"),
  publicKey: PlacePublicKey,
  name: z.string().min(1).max(200),
  signature: PlaceSignature,
});
export type DeviceAuthRequest = z.infer<typeof DeviceAuthRequest>;

/** The refusal a client gets from a host that holds no key of its own to prove: a runtime served without the
 * place wiring, which is a runtime in a test rather than any host a person starts. */
export const SEAL_UNSERVED = "this host holds no key to prove itself with; the host that serves the app wires one";

/** The refusal a line gets for aiming at a host it holds no key for: a record somebody edited by hand, or a turn
 * launched by a host older than this one. `where` names which. */
export const hostNoKeyLine = (where: string): string =>
  `${where} names a host and no key for it, so this computer cannot tell which host it would be sending its token to; run wsp hosts to read the account's hosts again`;

/** What `hostNoKeyLine` names when the aim came out of the environment a turn was launched with rather than out of
 * a record a person named. */
export const LAUNCHED_WITH = "the launch this turn started with";

/** The refusal a join whose code this host is not holding gets. Spent, expired and never minted read the same, so
 * guessing tells a caller nothing about which; the words differ from a pairing code's only in naming the verb that
 * mints this one, since a person joining a computer never typed wsp host pair. */
export const PLACE_CODE_REFUSAL = "that join code is not one this host is waiting for; run wsp add on the host for a fresh one";

/** The refusal for a word two computers on this host answer to: ids tell them apart, and the person picks one.
 * `typed` is the word that was written, since more than one word names a computer and each says its own back. A
 * relink cannot take another computer's name, so two by one name are two a person joined under one word, and
 * every road that resolves a word reads this one sentence. */
export const twoPlacesRefusal = (typed: string, ids: readonly string[]): string =>
  `${typed}: this host holds ${ids.length} places by that name; name one by its id (${ids.join(", ")}).`;

/** The refusal a join from a computer whose wsp seals no link gets: every frame of a link after the handshake
 * travels inside a key the two ends agree, and a computer that cannot agree one would send its code and its
 * report where the carrier reads them. */
export const PLACE_UNSEALED_JOIN_REFUSAL = "that computer's wsp is older than this host and seals no link; update wsp there and join again";

/** The refusal a place gets for proving itself with a key the host does not hold for it. A key that moved is a
 * computer re-joined somewhere else or a place file copied off it, and neither is this place. */
export const PLACE_KEY_REFUSAL = "that place's key does not match the one this host learned at join; wsp remove it here and join it again";

/** The refusal a place that names an id this host holds none of gets: removed here, or a state file that is not
 * the one it joined. */
export const PLACE_UNKNOWN_REFUSAL = "this host holds no place by that id; join it with a code from wsp add";

/** The refusal a joining computer prints when the host at that address could not prove the key this computer
 * learned at join, so nothing of this computer's went to it. */
export const hostKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer learned at join; nothing was sent to it`;

/** What a remove says about a place that was not linked when it ran: the records here are gone and the daemon on
 * that computer is not, since nothing could reach it to sweep. */
export const placeStillInstalledLine = (name: string): string => `${name} is off this host, but the daemon on it is still installed; run ${PLACE_LEAVE_LINE} on that computer when it is back`;

/** What a remove took off that computer by its agent's own command: a plugin the setup put on there. */
export const pluginOffLine = (name: string): string => `plugin ${name}`;

/** What a remove says of the plugins the setup put on that computer and could not take off: they stay there. */
export const pluginsKeptLine = (name: string, plugins: readonly string[]): string =>
  `${plugins.join(", ")} ${plugins.length === 1 ? "is" : "are"} still on ${name}: wsp could not take ${plugins.length === 1 ? "it" : "them"} off`;

/** What a place that is connected but has never said which port its daemon bound is refused with: a pane needs
 * that port to carry to, and only that computer knows it. */
export const placeNoDaemonPortLine = (name: string): string => `${name} is connected but has not said which port its daemon is on, so nothing can carry a pane to it yet; it says so on its next link`;

/** What an install is refused with when the computer took the daemon and never dialled back: the join landed, so
 * the computer belongs to this wsp, and what is missing is a road from it to here. */
export const placeNoLinkLine = (name: string): string => `${name} took the daemon and has not dialled this host yet; check that it can reach this computer on the address it was given, and wsp computers shows it the moment it does`;

/** What a stage reads while the computer it is running on has no link: the requests behind it are held until that
 * computer opens a socket again, and a stage with no line of its own reads as one that stopped. */
export const placeDialBackLine = (name: string): string => `waiting for ${name} to dial back`;

/** A Browser pane asking for a port of a computer the person joined that this computer would need root to open. */
export const paneForwardFloorLine = (port: number): string => `localhost:${port} is below 1024, which this computer opens only as root; serve it on a port from 1024 up`;

/** A Browser pane asking for one port more than a workspace may hold open on this computer. */
export const paneForwardCapLine = (name: string, cap: number): string => `${name} already has ${cap} ports open on this computer; stop one in Ports first`;

/** A Browser pane asking again for a port whose forward a quiet hour ended. */
export const paneForwardQuietLine = (port: number): string => `localhost:${port} closed after an hour with nothing connecting to it; open the address again to forward it`;

/** A Browser pane asking again for a port whose forward the person stopped in Ports. */
export const paneForwardStoppedLine = (port: number): string => `localhost:${port} was stopped in Ports; open the address again to forward it`;

/** Why a build on a joined computer stopped when that computer's link went and it never dialled back in time. */
export const placeWentAwayLine = (name: string): string => `${name} went away before the build finished`;

/** The refusal wsp add over ssh gets on a host that wired no installer: the road that puts the agent on a computer
 * is the host command's, so a runtime served without one holds no way onto a machine it has never met. */
export const NO_PLACE_INSTALLER = "this host cannot install the agent on a computer over ssh; run wsp add with no argument for the line to type on that computer";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the place ops: which computers a
 * person's wsp runs on, and taking one back out, is handed out and taken away at the terminal of the computer the
 * host runs on and nowhere else. */
export const PLACES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the places this host holds; run wsp computers on the computer the host runs on";

/** The refusal for a daemon channel that named both a workspace and a computer, or neither: a channel is one
 * daemon's, and which one is the caller's to say. */
export const DAEMON_OPEN_ONE_OF = "daemon.open opens a channel to one daemon: name the workspace or the place, not both";

/** Where a computer you own dials this wsp: the port the door answers on and every address it can be reached at.
 * A host that already binds beyond this computer answers its own port and opens nothing. */
export const PlaceDoorView = z.object({
  port: z.number().int().min(1).max(65535),
  /** `http://<address>:<port>` for every address this computer answers on that leaves it, loopback left out. */
  addresses: z.array(z.string().url()).min(1),
  /** The fingerprint of the key this host proves at a join, for the token the join line carries: what tells the
   * computer being joined that the host answering at one of those addresses is the one that printed the line. */
  hostKey: z.string().min(1).max(200),
  /** The relay hostname as an https address, when the host is linked to a relay. */
  relay: z.string().url().optional(),
});
export type PlaceDoorView = z.infer<typeof PlaceDoorView>;

/** One line a computer you own joins this host by, as joinRoads writes it: the address it dials, the whole command
 * typed there, and the note for the relay's address, which answers only while the host is linked. */
export const JoinRoad = z.object({ url: z.string().url(), line: z.string().min(1), note: z.string().optional() });
export type JoinRoad = z.infer<typeof JoinRoad>;

/** What places.mint answers: a fresh code, written into every line this host can be joined by, and when it stops
 * working. The code is the one wsp add prints, off the same mint and the same expiry. */
export const JoinMint = z.object({ joins: z.array(JoinRoad).min(1), expiresAt: z.string().datetime() });
export type JoinMint = z.infer<typeof JoinMint>;

/** A computer the person's own ssh already knows, offered where a computer is added over ssh: a Host block of their
 * ssh config, or a name their known_hosts holds. Only host, hostname, user and port words are taken from what those
 * files name, so a key file an Include reaches yields nothing. */
export const SshHostSuggestion = z.object({
  alias: z.string().min(1).max(300),
  hostName: z.string().max(300).optional(),
  user: z.string().max(300).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  from: z.enum(["config", "known_hosts"]),
});
export type SshHostSuggestion = z.infer<typeof SshHostSuggestion>;

/** The git hosts a person's ssh knows for pushing, never a computer to add: hidden from the ssh hosts offered, with
 * every subdomain of each. */
export const GIT_FORGE_HOSTS: readonly string[] = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "sr.ht", "ssh.dev.azure.com", "vs-ssh.visualstudio.com"];

/** A url's host as a name: lowercase, without its port or a trailing root dot. */
export const bareHost = (host: string): string => host.replace(/:\d*$/, "").toLowerCase().replace(/\.$/, "");

/** Whether a host is the domain or a host under it, in any case, with a port or a root dot or neither. */
export function hostUnder(host: string, domain: string): boolean {
  const name = bareHost(host);
  return name === domain || name.endsWith(`.${domain}`);
}

/** Whether a host name is one of GIT_FORGE_HOSTS or under one. */
export function isGitForge(host: string): boolean {
  return GIT_FORGE_HOSTS.some(forge => hostUnder(host, forge));
}

/** The refusal a socket that is not the host's own gets for minting a join code: the code lets a computer in, so
 * only this computer's own window may ask, as wsp add on its terminal does. */
export const MINT_JOIN_REFUSAL = "only a socket holding this host's own token may mint a join code; run wsp add on the computer the host runs on";

/** The refusal for reading the person's ssh hosts on any socket but this computer's own window: which computers
 * they reach is theirs, and a paired device, a relayed socket or a thread learns none of it. */
export const SSH_HOSTS_REFUSAL = "only a socket holding this host's own token may read the ssh hosts on this computer; open wsp on the computer the host runs on";

/** The refusal a socket let in on a ticket gets for opening the door computers you own dial: the same rule the
 * device and place ops read, since the door is who may reach this wsp. */
export const PLACE_DOOR_REFUSAL = "a socket let in on a ticket cannot open the door computers you own dial; run wsp add on the computer the host runs on";

/** The refusal for a host that serves no such door at all: wsp up serves one, a bare runtime does not. */
export const PLACE_DOOR_UNSERVED = "this host opens no door for computers you own; wsp up serves one";

/** A refusal in two halves: what happened, which the app draws in the destructive ink, and what to do about it,
 * which it draws in the foreground ink. One shape, so every screen that refuses reads the same way. */
export const TwoPartRefusal = z.object({ what: z.string(), fix: z.string() });
export type TwoPartRefusal = z.infer<typeof TwoPartRefusal>;

export const JOIN_ADDRESS_LINE: TwoPartRefusal = {
  what: "That is not an address.",
  fix: `Type it as the other screen shows it, like 192.168.1.20:${DEFAULT_PLACE_PORT}.`,
};

/** How long the code on the Add a computer sheet is good for, said in the words beside it. */
export const CODE_GOOD_LINE = "the code is good for 10 minutes";
export const CODE_EXPIRED_LINE = "the code expired; press New code";

/** What the sheet says when somebody else already holds the door's port: a fixed port, since the place file on the
 * other computer names it for good, so a fallback port would be a computer that can never dial back. */
export const doorPortHeldLine = (port: number): string =>
  `port ${port} is held by another program on this computer, so no computer you own can reach this wsp; free it and open Add a computer again`;

/** Said when the door port of a host's last start is taken and it opens on another: a computer joined at the old one
 * dials it for good. */
export const doorPortMovedLine = (port: number): string =>
  `port ${port}, where computers you joined last reached this wsp, is held by another program, so the door opened on another; free it and start this wsp again`;

/** What a computer joined as a place keeps about the wsp it belongs to, in the file the join writes and the agent
 * reads on every attempt: the id its host knows it by, the addresses to dial in order, the host's public key pinned
 * at that join, and where its own private key is. The shape and the two readings of it live here because the join
 * writes it on one side of the wire and the agent reads it on the other. */
export interface PlaceFile {
  placeId: string;
  name: string;
  /** What the wsp this computer joined calls itself, learned at the join: the one word the joined computer shows. */
  hostName: string;
  /** LAN address first, the host's tunnel hostname after it; dialled in this order on every attempt. */
  hostUrls: string[];
  hostPublicKey: string;
  keyPath: string;
  joinedAt: string;
}

/** The mode the place file and the private key beside it are kept at: the person's own and nobody else's. A key any
 * account on that computer could read is a key that joins their wsp for them. */
export const PLACE_FILE_MODE = 0o600;

/** The place file a text holds, or nothing when that text is not one. A file that is there and is not one reads the
 * same as none: the one road that writes it is wsp join, and anything else there is not a place to dial with. */
export function parsePlaceFile(text: string): PlaceFile | undefined {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }
  const f = held as PlaceFile | undefined;
  const ok =
    typeof f === "object" &&
    f !== null &&
    typeof f.placeId === "string" &&
    typeof f.name === "string" &&
    typeof f.hostName === "string" &&
    Array.isArray(f.hostUrls) &&
    f.hostUrls.every(u => typeof u === "string") &&
    typeof f.hostPublicKey === "string" &&
    typeof f.keyPath === "string";
  return ok ? f : undefined;
}

/** Whether a place file names one of these computers and this host's key: the one test every road over a computer's
 * ssh login holds the machine it reached to before it changes anything there. */
export const placeFileNames = (file: PlaceFile | undefined, placeIds: readonly string[], hostPublicKey: string): file is PlaceFile =>
  file !== undefined && placeIds.includes(file.placeId) && file.hostPublicKey === hostPublicKey;

/** The text the file holds, which parsePlaceFile reads back. */
export const placeFileText = (file: PlaceFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** The refusal a second join on one computer gets: a place file is the one wsp this computer belongs to. */
export const ALREADY_JOINED_LINE = `this computer is already a place in a wsp; ${PLACE_LEAVE_LINE} first`;
