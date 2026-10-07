// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { ThreadScope, type WorkspaceOrigin } from "../views/workspace.js";
import { DaemonResponse } from "./machine-link.js";

// --- runtime wire protocol (serveRuntime) ------------------------------------

/** What a single-use ticket opens the next socket for: `connect`, another client of the person's own, or `relay`,
 * the road a machine's requests reach this host by. The purpose is what a socket's origin is read off, so a relayed
 * socket is one this host minted a relay ticket for and nothing a client says on the wire can make one. */
export const TicketPurpose = z.enum(["connect", "relay"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

/** Where a socket redeeming a ticket of each purpose reached the host from, named for every purpose there is. The
 * host stamps this over whatever the client's own frames say, so a purpose that names none would be a socket whose
 * origin its holder decides: the door refuses one rather than falling back to the wire, and a purpose added later
 * has to say what it is here before any socket may redeem it. */
export const TICKET_ORIGIN: Record<TicketPurpose, WorkspaceOrigin> = { connect: "here", relay: "relayed" };

/** How a device this host admitted through the account got in: the computer it is on the relay, the key it proved
 * and the key that signed its admission. The public key is kept because a device admitted here may itself sign the
 * admission of the next one, and the fingerprint because a revoke is remembered by the key rather than by the id a
 * relay mints afresh at every sign-in. Nothing secret: a public key and two fingerprints. */
export const DeviceVia = z.object({
  kind: z.literal("account"),
  /** The id that device has on the relay, which is what a listing of the account's computers names it by. */
  relayDeviceId: z.string(),
  fingerprint: z.string(),
  publicKey: z.string(),
  /** The fingerprint of the key whose admission let it in. */
  admittedBy: z.string(),
});
export type DeviceVia = z.infer<typeof DeviceVia>;

/** A computer that redeemed a pairing code and holds a token of its own, as devices.list answers and wsp host devices
 * prints it. The token is never here: the host keeps only its hash, so a listing can leak nothing that opens a
 * socket. */
export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** When this device last authed. Set by the redeem that minted it and moved by every later auth frame, never by
   * a JSON route reading the same token, so a listing says when the computer last dialled rather than last asked. */
  lastSeenAt: z.string(),
  /** What this device may do, when it is not a computer of the person's: a token the host minted into one turn's
   * environment, which drives only the tree that turn's thread is in. Absent is a paired computer, which drives
   * everything this host holds. */
  scope: ThreadScope.optional(),
  /** Set on the browser wsp init opened on the computer the host runs on: its code was minted by init itself, so
   * the device is read as the owner on the socket and the JSON routes alike, and is still listed and revoked like
   * every other. Absent is a computer or a browser that took a code from wsp host pair. */
  here: z.literal(true).optional(),
  /** How this device got in, where it did not redeem a pairing code: the account both computers are signed in to.
   * Absent is a code, so one record, one listing and one revoke answer for both roads. */
  via: DeviceVia.optional(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** How long a pairing code stands before the host forgets it: long enough to read off one screen and type into
 * another, short enough that a code left in a terminal buffer is worth nothing by the time anyone reads it. */
export const PAIR_CODE_TTL_MS = 10 * 60_000;

/** How many characters a pairing code is, out of the 32 the alphabet holds: 40 bits, single use and ten minutes
 * long, which no reachable host answers enough guesses of. */
export const PAIR_CODE_LENGTH = 8;

/** A pairing code as every screen shows it: the alphabet's letters in two halves, which is how a person reads one
 * across a room. The one grouping, so the sheet that shows a code and the field that takes one agree. */
export function shownPairCode(code: string): string {
  const letters = code.replace(/-/g, "").toUpperCase().slice(0, PAIR_CODE_LENGTH);
  const half = Math.ceil(PAIR_CODE_LENGTH / 2);
  return letters.length <= half ? letters : `${letters.slice(0, half)}-${letters.slice(half)}`;
}

/** A pairing code as the host takes it, whichever screen it was copied off: the letters alone, upper case. A
 * person copies the code they can read, so the dash the screens put in it is one this reading takes back out. */
export const sentPairCode = (shown: string): string => shown.replace(/-/g, "").toUpperCase();

/** The symbols a pairing code is written in: the digits and the letters, less the four that a person reading one
 * screen and typing into another confuses (I, L, O, U). Thirty-two of them, so each character is five bits and a
 * random byte masked to five bits is uniform. */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Whether a code as the host takes it could be one a host is holding: the alphabet's characters at the length a code
 * is. What tells a code from a paste that caught a label, a space for the dash or a character too many. */
export const isPairCode = (code: string): boolean => code.length === PAIR_CODE_LENGTH && [...code].every(c => PAIR_CODE_ALPHABET.includes(c));

/** What a field that takes a pairing code says for a paste that is none, before any host is asked. */
export const PAIR_CODE_SHAPE_REFUSAL = `that is not a pairing code, which is ${PAIR_CODE_LENGTH} letters and digits like ABCD-EFGH; paste only the code wsp host pair printed`;

/** What this wsp knows about the account it is on, read off this computer's own records alone: the relay is never
 * asked for it, so the row draws at once and draws the same whether or not the relay is up. Signed in is a record
 * on disk; the name beside it is the one the relay gave when the sign-in was approved, which a relay that names
 * none leaves absent, and then the state word alone is the answer. */
export const AccountView = z.object({
  signedIn: z.boolean(),
  login: z.string().optional(),
});
export type AccountView = z.infer<typeof AccountView>;

/** The refusal a socket let in on a ticket gets for reading the account: who this wsp is signed in to is read at
 * the terminal of the computer it runs on, as the devices and the places are. */
export const ACCOUNT_TICKET_REFUSAL = "a socket let in on a ticket cannot see the account this host is signed in to; run wsp login on the computer the host runs on";

/** The relay wsp signs in to when a person names none: the one this project runs, opt in as every account road is,
 * and the only address the lines carry by default. Another relay is named on the line that signs in. */
export const DEFAULT_RELAY = "https://relay.usewsp.com";

/** What one computer already on the account signs for another: the key it admits, its own key, and the moment.
 * The relay stores these bytes and can make none of them, since it holds no device's private key; every host
 * verifies the signature itself against the keys it already trusts. `issuedAt` travels and is stored as the
 * string it was signed with, byte for byte, since the transcript is built from that spelling. */
export const Admission = z.object({
  device: z.string(),
  by: z.string(),
  issuedAt: z.string(),
  signature: z.string(),
});
export type Admission = z.infer<typeof Admission>;

/** One computer on the account as a host reads it off its heartbeat's reply: which key it proves and which
 * admissions were signed for it. The signature rides along; the fingerprints alone would prove nothing. */
export const AccountDevice = z.object({
  id: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  admissions: z.array(Admission.omit({ device: true })),
});
export type AccountDevice = z.infer<typeof AccountDevice>;

/** What the account's devices are as the last heartbeat listed them, and nothing when this host has heard no list
 * at all: an absent list is unknown and never empty, so a relay that is down, one that answers an older shape and
 * a beat that was refused admit nobody new and revoke nobody. */
export const AccountDevices = z.object({ devices: z.array(AccountDevice) });

/** What a device signs to prove it may come in through the account: the key admitted, the key that signed for it
 * and the moment, built by one function so the wsp that signs and the host that verifies cannot drift. The host
 * is not inside it: one admission stands at every host on the account whose trust the signer already has, which
 * is what saves a person a code per host. */
export function deviceAdmissionTranscript(device: string, by: string, issuedAt: string): Uint8Array {
  return new TextEncoder().encode(`wsp device admission v1\n${device}\n${by}\n${issuedAt}\n`);
}

/** The refusal a device.auth gets that this host will not admit: a key the account's listing does not hold, an
 * admission signed by nobody it trusts, or a signature that does not stand. One sentence for all of them, since a
 * caller that cannot come in learns nothing from which check caught it, and it names the road in: a computer
 * already on the account signs this one's key. */
export const DEVICE_AUTH_REFUSAL =
  "this host admits a computer on the account only on an admission signed by a key it already trusts; run wsp login to read this computer's id on a computer that is already in, then wsp login <id> there, and dial again";

/** The refusal a device this host revoked gets when it dials again through the account: the key is remembered, so
 * an admission it still holds admits it nowhere here. A code from the host's own terminal is the way back. */
export const DEVICE_REVOKED_REFUSAL = "this host took this computer's token away; it is admitted through the account no longer, and wsp host pair on the host is the way back in";

/** The refusal a device.auth gets from a host that is on no account: nothing there names the keys it would trust,
 * so pairing with a code is the whole road to it. */
export const DEVICE_ACCOUNT_UNSERVED = "this host is on no account, so it admits no computer through one; run wsp host link on the computer it runs on to put it on yours";

/** What a computer reads when the host it dialled answered device.auth with its own request schema's refusal: a
 * host of an older wsp, whose door knows no road in for a computer on the account. Told apart from a refusal of this build by
 * the kind on the frame, which an older host's schema refusal carries none of, so a token this computer never sent
 * is never read as one that was taken away. */
export const deviceAuthOldHostLine = (where: string): string =>
  `the host at ${where} runs an older wsp, whose door does not know how a computer on the account comes in; update wsp on that computer and run wsp up there again`;

/** The refusal wsp login gives a word that carries no key: every word wsp login prints carries the fingerprint of
 * the key being admitted, so a word without one was written by hand or cut in half, and nothing is posted. */
export const LOGIN_NO_KEY_REFUSAL = "that word names no key for the computer signing in, so nothing here could say which key it would be admitting; run wsp login there again and copy the whole word it prints";

/** The refusal for a host that keeps no records of its own to read an account from, which a bare runtime does not. */
export const ACCOUNT_UNSERVED = "this host keeps no account records; wsp up serves them";

/** The refusal a socket that is not the host's own gets for asking to mint a pairing code: a code lets a stranger
 * in, so only the process holding the host token, on this computer, may hand one out. */
export const PAIR_ISSUE_REFUSAL = "only a socket holding this host's own token may mint a pairing code; run wsp host pair on the computer the host runs on";

/** The refusal a redeemed code that this host is not holding gets: spent, expired, or never minted read the same,
 * so guessing tells a caller nothing about which. */
export const PAIR_CODE_REFUSAL = "that pairing code is not one this host is waiting for; run wsp host pair on the host for a fresh one";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the device ops, whether the ticket
 * was the road a machine's requests arrive by or another client's. Who may drive this host is handed out at the
 * terminal of the computer it runs on, and read and taken away there or from a computer paired with it. */
export const DEVICES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the devices paired with this host; run wsp host devices on the computer the host runs on";

/** The refusal the JSON routes answer with when a request carries no token this host takes: reaching the port,
 * the loopback one included, names nobody, since another login on the same computer reaches it too. */
export const API_UNAUTHORIZED = "this route needs a token in an Authorization header, the host's own from the token file beside its state or a paired device's; run wsp host pair on the computer the host runs on for one";

/** The refusal a write route and a browser's upgrade answer with when the page that sent them was loaded at
 * another name than the one this host was reached at. A page may only drive the host it was served by, and the
 * hostname is the whole of the reading: a page on the app's port dialling the runtime's is the same page. */
export function crossOriginRefusal(origin: string, host: string): string {
  return `this request came from ${origin} and this host was reached at ${host}; the page and its socket open from the address the host answers at`;
}

/** A frame the page sends a daemon through the host: the daemon's own op and params, no id. The host numbers
 * frames on its socket to the daemon and hands the daemon's answer back under the request that carried the frame,
 * so a page's ids never reach a machine. auth is refused: the host sent the auth frame when it opened the channel. */
export const DaemonFrame = z.object({ op: z.string().refine(op => op !== "auth", "the host authenticates the channel") }).passthrough();
export type DaemonFrame = z.infer<typeof DaemonFrame>;

export const DaemonOpenReply = z.object({ channel: z.string() });
export type DaemonOpenReply = z.infer<typeof DaemonOpenReply>;
/** The daemon's reply as it sent it; id is the host's number on its own socket and means nothing to the page. */
export const DaemonSendReply = z.object({ reply: DaemonResponse });
export type DaemonSendReply = z.infer<typeof DaemonSendReply>;

/** What the host pushes to the one socket that opened a channel. Never on the event bus, never sequenced, never
 * replayed: a pty chunk is not history. event is the daemon's frame untouched; the page validates it against
 * DaemonEvent as it always did, since a daemon of another version may push a type this host does not know and
 * the host acts on none of them. daemon.closed says the daemon socket ended without the page asking: code and
 * reason are the WebSocket close the host saw, 4401 with the daemon's sentence when it refused the token. */
export const DaemonChannelEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.event"), channel: z.string(), event: z.object({ type: z.string() }).passthrough() }),
  z.object({ type: z.literal("daemon.closed"), channel: z.string(), code: z.number().int(), reason: z.string() }),
]);
export type DaemonChannelEvent = z.infer<typeof DaemonChannelEvent>;

/** What separates the two halves of the one token a join line carries. Neither half can hold it: a code is
 * written in PAIR_CODE_ALPHABET with the dash the screens group it with, and a fingerprint is base64. */
export const JOIN_TOKEN_MARK = ".";

/** The one word a person copies off a join line: the single-use code and the fingerprint of the key the host will
 * prove, as one string, so a join stays two things to copy and the screens keep the fields they have. */
export const joinToken = (code: string, hostKey: string): string => `${shownPairCode(code)}${JOIN_TOKEN_MARK}${hostKey}`;

/** The same token read back on the computer being joined, whichever road it came by: a person's paste, the flag,
 * or the file an install over ssh landed. The code is taken as any screen's code is taken; the fingerprint is left
 * exactly as it was written, since its own alphabet is case sensitive. A token that carries no fingerprint answers
 * none, and the caller refuses rather than dialling. */
export function readJoinToken(typed: string): { code: string; hostKey?: string } {
  const trimmed = typed.trim();
  const at = trimmed.indexOf(JOIN_TOKEN_MARK);
  if (at === -1) return { code: sentPairCode(trimmed) };
  const hostKey = trimmed.slice(at + 1).trim();
  const code = sentPairCode(trimmed.slice(0, at));
  return hostKey === "" ? { code } : { code, hostKey };
}

/** The refusal a join gets for a line that named no key: every line wsp add prints carries one, so a line without
 * one was written by hand or cut in half on its way over. Nothing is dialled. */
export const JOIN_NO_KEY_REFUSAL = "that join line names no key for the host, so this computer cannot tell which host it is joining; run wsp add on the host again and copy the whole code it prints";

/** The refusal a join gets when the host at that address proved a key that is not the one the join line named:
 * something answered where the host was expected. Nothing of this computer's went to it. */
export const joinKeyRefusal = (url: string): string => `the host at ${url} proved a key the join line did not name, so it is not the host that printed that line; nothing was sent to it`;

/** The one word a person copies off wsp host pair, which is the join line's token under the name the pairing road
 * reads it by: the code and the fingerprint of the key the host will prove, so a client pins that key before it
 * spends the code. `readJoinToken` reads both roads' tokens, since they are one shape. */
export const pairToken = joinToken;

/** The refusal a dial gets when whatever answered at that address did not prove the key this computer holds that
 * host to, whether it proved another one or signed nothing this computer could verify: it is not that host,
 * whichever check caught it, and no token of this computer's went to it. */
export const pairKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer holds for it, so it is not that host; nothing was sent to it`;
