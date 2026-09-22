// SPDX-License-Identifier: AGPL-3.0-only
// The three commands that give this computer a host outside its own account:
// connect spends a pairing code for a device token of this computer's own,
// default moves which host every line takes, and forget hands a token back and
// drops it. Nothing here prints a token: a line that leaked one would open the
// host to whoever read the terminal. The one listing of what this computer can
// reach is wsp hosts, which reads the account as well as these records.
import { hostname } from "node:os";
import { PAIR_NO_KEY_REFUSAL, readJoinToken, servedHostname, usageRefusal } from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { aliasFrom, checkedAlias, defaultHost, dialWindowMs, noAnswerWithin, noSuchHostLine, readHost, removeHost, READ_THE_HOSTS, setDefaultHost, writeHost, type HostAim, type HostRecord } from "./hosts.js";
import { dialHost, type DialOpts, type HostClient } from "./verbs.js";

const CONNECT_USAGE = "usage: wsp host connect <url> --code <code> [--name <alias>]";
const DEFAULT_USAGE = "usage: wsp host default <alias>";
const DISCONNECT_USAGE = "usage: wsp host forget <alias>";

/** What the commands work on: the state file this computer's own host would serve, and the home holding the hosts
 * folder they read and write. */
export interface ConnectOpts {
  statePath: string;
  home: string;
}

/** What these commands read of the world: the dial, the clock, this computer's name and how long a road is given
 * to answer. */
export interface ConnectDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  now(): number;
  /** What the host calls this computer in its own listing; the person at that terminal reads it to know who paired. */
  deviceName(): string;
  /** How long the hand back waits on the road, which is the window a dial to that host gets. */
  window(aim: HostAim): number;
}

const systemDeps: ConnectDeps = { dial: dialHost, now: Date.now, deviceName: hostname, window: dialWindowMs };

/** What wsp host connect prints: which host this computer now holds and where, never the token it holds it by. */
export function connectedLines(alias: string, record: HostRecord, madeDefault: boolean): string[] {
  return [
    `host        ${alias}`,
    `url         ${record.url}`,
    `device      ${record.deviceId}`,
    madeDefault
      ? `${alias} is now the host every wsp line runs against; --host or WSP_HOST names another.`
      : `Run a line against it with --host ${alias}, or make it the one every line takes with wsp host default ${alias}.`,
  ];
}

export async function connectCommand(io: CliIO, opts: ConnectOpts, values: { code?: string; name?: string }, args: readonly string[], deps: ConnectDeps = systemDeps): Promise<number> {
  if (args[0] === undefined || args.length !== 1) throw usageRefusal("wsp host connect takes one address.", `A host on your own account needs no code and no address: wsp login signs this computer in and wsp hosts lists them.\n\n${CONNECT_USAGE}`);
  const code = values.code;
  if (code === undefined || code.trim() === "") throw usageRefusal("wsp host connect needs the code wsp host pair printed on that computer.", `Pass it as --code <code>.\n\n${CONNECT_USAGE}`);
  const url = args[0];
  // One sentence for every address this cannot dial, and the name of the computer for one it can: the protocol's
  // reading of an address is what says which it is, so a ws or wss address, an http:// with no computer after it
  // and a word that is no address at all read alike rather than one of them reaching the URL parser and throwing
  // a line nobody can act on, and the name the alias is folded out of comes from that one parse.
  const at = servedHostname(url);
  if (at === undefined) throw usageRefusal(`wsp host connect takes the address the host is served at, and got ${JSON.stringify(url)}.`, `An address starts http:// or https:// and names the computer it runs on.\n\n${CONNECT_USAGE}`);
  // Checked before the dial, never after it: a code is spent the moment it is redeemed, and a name refused on the
  // way back would leave the host holding a device whose only token went nowhere.
  const alias = checkedAlias(values.name ?? aliasFrom(at));
  if (readHost(opts.home, alias) !== undefined) {
    throw usageRefusal(`a host named ${alias} is already connected.`, `Run wsp host forget ${alias} first, or give this one another name with --name.`);
  }
  // The code and the fingerprint of the key that host will prove, as one word off wsp host pair. A code carrying
  // no fingerprint is refused here, before the dial: nothing would tell the host that printed it from whoever
  // answers at the address a relay named, and the code would be spent finding out.
  const typed = readJoinToken(code);
  if (typed.hostKey === undefined) throw new Error(PAIR_NO_KEY_REFUSAL);
  const client = await deps.dial(opts.statePath, { host: url, home: opts.home, env: {}, redeem: { code: typed.code, name: deps.deviceName(), hostKey: typed.hostKey } });
  let paired;
  try {
    paired = client.paired;
  } finally {
    client.close();
  }
  if (paired === undefined) throw new Error(`the host at ${url} answered the pairing code with no device token; it runs another version of wsp`);
  const record: HostRecord = { url: url.replace(/\/+$/, ""), deviceId: paired.deviceId, deviceToken: paired.deviceToken, hostKey: typed.hostKey, pairedAt: new Date(deps.now()).toISOString() };
  writeHost(opts.home, alias, record);
  const madeDefault = defaultHost(opts.home) === undefined;
  if (madeDefault) setDefaultHost(opts.home, alias);
  for (const line of connectedLines(alias, record, madeDefault)) io.log(line);
  return 0;
}

/** Which host every line on this computer takes, moved by name. The name is one this computer holds a record for,
 * whether a code paired it or wsp hosts wrote it off the account. */
export async function hostDefaultCommand(io: CliIO, opts: ConnectOpts, args: readonly string[]): Promise<number> {
  const alias = args[0];
  if (alias === undefined || args.length !== 1) throw usageRefusal("wsp host default takes one alias.", DEFAULT_USAGE);
  if (readHost(opts.home, alias) === undefined) throw usageRefusal(noSuchHostLine(alias, opts.home), READ_THE_HOSTS);
  setDefaultHost(opts.home, alias);
  io.log(`${alias} is now the host every wsp line runs against; --host or WSP_HOST names another.`);
  return 0;
}

/** A reply, or the host's own words for a road that went quiet once the window is out. A socket that opened and
 * then carried nothing has nothing to close it, so a wait with no window of its own is as long as the operating
 * system holds the connection, which on a relayed road is minutes of a line saying nothing. The race is what
 * leaves the abandoned reply handled: a socket closed behind it fails it with nobody waiting, and a bare timer
 * beside the reply rather than racing it would end the line on that rejection. */
async function answerWithin<T>(work: Promise<T>, windowMs: number, where: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(noAnswerWithin(where, windowMs)), windowMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function disconnectCommand(io: CliIO, opts: ConnectOpts, args: readonly string[], deps: ConnectDeps = systemDeps): Promise<number> {
  const alias = args[0];
  if (alias === undefined || args.length !== 1) throw usageRefusal("wsp host forget takes one alias.", DISCONNECT_USAGE);
  const record = readHost(opts.home, alias);
  if (record === undefined) throw usageRefusal(noSuchHostLine(alias, opts.home), READ_THE_HOSTS);
  // One window for the whole act, read once off the road this host is on: the dial and the reply that hands the
  // token back are two halves of one hand back, and a reply nobody waits for is a device left standing over there.
  const aim: HostAim = { kind: "alias", alias, record };
  const windowMs = deps.window(aim);
  const handBack = async (): Promise<void> => {
    // One reading of an address, the file's own: a record holds whatever a hand wrote into it, and a word that is
    // no address must not reach the URL parser, whose line says nothing a person can act on.
    if (servedHostname(record.url) === undefined) throw new Error(`${JSON.stringify(record.url)} is not an address this computer can dial, so there was nothing to hand the token back to`);
    const client = await deps.dial(opts.statePath, { aim, home: opts.home, env: {}, deadlineMs: windowMs });
    try {
      await answerWithin(client.request("devices.revoke", { deviceId: record.deviceId }), windowMs, record.url);
    } catch (e) {
      // The window is out, so this road is carrying nothing: a close waits on an answer that is not coming and the
      // socket holds the line long after its last word, where dropping it costs the person nothing.
      client.terminate();
      throw e;
    }
    client.close();
  };
  // The record goes whatever the host says: a host that is off, gone or unreachable must not leave this computer
  // holding a token it cannot use, and the line below says what is left to do over there.
  let refused: unknown;
  // Twice at most, and only for a road that did not answer: this is the one act nobody can redo from this computer
  // once the record is gone, and a cold edge or a box that answered a moment late is not a host that is gone.
  // Anything the host itself said, a token it has taken away or a refusal, stands on the first answer.
  for (let tries = 2; tries > 0; tries--) {
    refused = await handBack().then(
      () => undefined,
      (e: unknown) => e,
    );
    if (refused === undefined || (refused as { kind?: unknown }).kind !== "unreachable") break;
    // A road that is dead for both tries is half a minute of a line saying nothing, so it says what it is waiting
    // on and how long this try has before it gives up.
    if (tries > 1) io.error(`still asking the host at ${record.url}; this try waits up to ${windowMs} ms`);
  }
  removeHost(opts.home, alias);
  io.log(`disconnected from ${alias}; this computer no longer holds a token for ${record.url}`);
  if (refused === undefined) return 0;
  // A host that refuses the token has already taken this device away, so there was nothing left to hand back; any
  // other answer leaves the device standing over there and the person is the only one who can say so.
  if ((refused as { kind?: unknown }).kind === "auth") io.log(`${alias} had already taken this computer's token away, so there was nothing to hand back`);
  else {
    io.error(refused instanceof Error ? refused.message : String(refused));
    io.error(`the host may still hold this computer as a device; run wsp host devices revoke ${record.deviceId} on that computer.`);
  }
  return 0;
}
