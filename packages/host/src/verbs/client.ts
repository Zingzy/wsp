// SPDX-License-Identifier: AGPL-3.0-only
import { hostname, platform } from "node:os";
import { randomBytes } from "node:crypto";
import type { ParseArgsConfig } from "node:util";
import { Transform, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { z } from "zod";
import { agentName } from "@wsp/catalog";
import type { Platform } from "@wsp/collect";
import { freshEphemeral, keyFingerprint, makeSeal, openFrame, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, SEAL_REFUSAL, type PlaceKeyPair, type Seal } from "@wsp/keys";
import {
  AccessChoice,
  accessWordsLine,
  HOST_STOPPING_CLOSE,
  HOST_CLOSED_LINE,
  HOST_STOPPING_LINE,
  PLACE_LINK_NONCE_BYTES,
  SEAL_CLIENT,
  SealOpenReply,
  deviceAuthOldHostLine,
  pairKeyRefusal,
  placeLinkTranscript,
  PlaceView,
  PlaceSettingWord,
  NAP_AFTER_MAX_MS,
  TURN_LIMIT_MAX_MS,
  type PlaceSettingsAsk,
  ThreadView,
  authRefusal,
  authority,
  fmtBytes,
  sayOnce,
  usageRefusal,
  compareVersions,
  isLoopback,
  UP_RESTART_LINE,
  validatorRefusal,
  verbFailure,
  problemListsOf,
  fmtPrice,
  computerKindWord,
  agentsCell,
  placeDaemonBehind,
  absentComputer,
  placeRoom,
  placeSpendLimit,
  placeSettingsLine,
  type PlaceSetAlso,
  placeStateOf,
  PlaceSpend,
  RecipeView,
  RECIPE_KINDS,
  NO_RECIPE,
  type RecipeFile,
  setupWord,
  pendingWord,
  PENDING_STEP_WORDS,
  PendingComputer,
  spendMeterWord,
  namesPlace,
  noSuchPlaceRefusal,
  escapeC1,
  jsonLine,
  withoutControlChars,
  isProviderPlace,
  providerKeyName,
  AccountRow,
  UsageRange,
  UsageSplit,
  UsedAnswer,
  USAGE_WORDS,
  accountState,
  creditsWord,
  listWords,
  noSuchAccountLine,
  fmtTokens,
  freshIn,
  usedPrice,
  windowCell,
  type LimitKind,
} from "@wsp/protocol";
import type { CliIO } from "../cli.js";
import type { RelayTerminal } from "../signin-relay.js";
import { CLOUD_ON } from "../cloud.js";
import { dialAddress, heldOrStarted, hostTokenFor, hostTokenPath, POLL_MS, SERVICE_WAIT_MS, servingHost } from "../host-lock.js";
import type { HostStarter } from "../host-start.js";
import { addressNotPairedLine, aimAddress, aimHolds, aimName, aimedHost, deviceRefusedLine, dialWindowMs, noAnswerRefusal, noAnswerWithin, READ_THE_HOSTS, wsUrlOf, wspHome, writeHost, type HostAim, type HostPick } from "../hosts.js";
import { readDeviceKeyPair } from "../account.js";
import { releaseUpdateLine } from "../daemon-fix.js";
import { VERSION } from "../version.js";
import type { WatchSignals } from "../watch.js";
import type { ScanInput } from "../recipe-command.js";

export type Frame = Record<string, unknown> & { id?: string | number | null; ok?: boolean; type?: string };

export interface HostClient {
  request<T extends Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
  /** Asks for the runtime's events once; a second call is a no-op, since each subscription would push every event again. */
  events(): Promise<void>;
  /** Every frame that is not a reply: events after events(), the frames an exec pushes. */
  onFrame(fn: (frame: Frame) => void): () => void;
  /** Settles when the socket is gone, however it went, with the close code where the host sent one. */
  readonly closed: Promise<number | void>;
  /** Why the socket is gone, in the words the person reads: a host that let it go as it stopped says the turn goes
   * on, since the run is the machine's; anything else is a host that went. */
  closeWords(): string;
  /** The device token a host on the account answered this computer's key with, on the dial that proved it. */
  readonly paired?: { deviceId: string; deviceToken: string };
  close(): void;
  /** Drops the socket without waiting for the host to answer the close. A graceful close on a road that is carrying
   * nothing waits on an answer that is not coming, and the operating system holds the connection long after the
   * line has said its last word: measured on a stalled road, a close held the process 30.6 s where this took
   * 0.6 s. A caller that has given up on the road takes this rather than close. */
  terminate(): void;
}

/** The close code the runtime sends with every token refusal, the one fact an older host still carries. */
export const UNAUTHORIZED_CLOSE = 4401;
/** How long a refused auth waits for the close that follows its frame before the frame's own class stands. */
export const CLOSE_GRACE_MS = 500;

/** What a dial takes beside the state file: which host, how long to wait, and on a dial to a host on the account,
 * the key to prove instead of a token this computer does not have yet. */
export interface DialOpts extends HostPick {
  /** How long the socket and the first frame's answer may take; the road's own window when no caller names one. */
  deadlineMs?: number;
  /** Resolved already by a caller that had to read it anyway, so the hosts file is read once per line. */
  aim?: HostAim;
  /** Proves this computer's own device key as the first frame inside the seal, for a host on the account that
   * admitted it: no code is spent, and the host answers a device token of its own.
   * The name is what the host's listing calls this computer. */
  admit?: { name: string; hostKey: string; key: PlaceKeyPair };
  /** Dials a host of another release all the same: the one line that asks it to restart, which is how an older host
   * on this computer comes back on the release installed here. */
  anyRelease?: boolean;
  /** What brings a host up when none serves this state file here. A line that hands none in starts nothing and
   * reads the refusal, which is what a line about to serve a host itself wants. */
  start?: HostStarter;
  /** Where the starter's one line goes; stderr when nobody names a reader, since the line rides beside whatever
   * the verb prints on stdout. */
  say?: (line: string) => void;
}

/** No host holds this state file's lock, said once: a line that asked for none to be started reads it, and so does
 * a wait that ran out somewhere a starter could not run. It ends with the line that serves that file, as every
 * refusal ends with the command that fixes it, and the flag is always spelled: which file a bare wsp up would
 * serve is one rule and it lives where the state is picked, not in a second reading here. */
export const noHostServingLine = (statePath: string): string => `no wsp host is serving ${statePath}; start one with wsp up --state ${statePath}`;

/** A host holds this state file's lock and the token it writes beside it is not there. */
export const hostTokenMissingLine = (path: string): string => `the host's token file is missing: ${path}`;

/** Where a line dials and what it presents there: a host on this computer is the address its lock records (one
 * bound to a single address answers only there) and the token it wrote beside its state file, a host somewhere
 * else is its own address on the runtime's path and the device token this computer holds for it, and an address
 * carries the token a turn's launch left for it or none. */
export function hostAddress(statePath: string, pick: HostPick & { aim?: HostAim } = {}): { url: string; token: string } {
  const aim = pick.aim ?? aimedHost(statePath, pick);
  if (aim.kind === "url") return { url: wsUrlOf(aim.url), token: aim.token ?? "" };
  if (aim.kind === "alias") return { url: wsUrlOf(aim.record.url), token: aim.record.deviceToken };
  const lock = servingHost(statePath);
  if (lock === undefined) throw new Error(noHostServingLine(statePath));
  const token = hostTokenFor(statePath);
  if (token === undefined) throw authRefusal(hostTokenMissingLine(hostTokenPath(statePath)));
  return { url: wsUrlOf(`http://${authority(dialAddress(lock), lock.port)}`), token };
}

/** One socket to the host, and for a host on the account the one re-admission it may need on the way: a record
 * whose token that host no longer takes is a computer the account still trusts, so this computer proves its device
 * key once, writes the token the host answers into the record and carries on. The dial itself is below. */
export async function dialHost(statePath: string, opts: DialOpts = {}): Promise<HostClient> {
  const aim = opts.aim ?? aimedHost(statePath, opts);
  const home = opts.home ?? wspHome(opts.env ?? process.env);
  // A record written off the account's listing holds no token until its first dial, so the first line aimed at it
  // is admitted rather than refused: the key this computer signs with is the one the host was told to trust.
  const account = aim.kind === "alias" ? aim : undefined;
  const admitting = (): DialOpts["admit"] => {
    if (account === undefined || account.record.hostKey === undefined) return undefined;
    const key = readDeviceKeyPair(home);
    return key === undefined ? undefined : { name: hostname(), hostKey: account.record.hostKey, key };
  };
  const admit = account !== undefined && account.record.deviceToken === "" ? admitting() : undefined;
  // Which road this dial ended up taking, so a token is written into the record only where this computer proved
  // its key for it.
  let proved = admit;
  const client = await dialOnce(statePath, { ...opts, aim, ...(admit === undefined ? {} : { admit }) }, refused => {
    // The token this computer holds was taken away over there while the account still names it: one more dial,
    // this time proving the key, and the record carries what that host answers.
    if (admit !== undefined) throw refused;
    proved = admitting();
    return proved === undefined ? undefined : { ...opts, aim, admit: proved };
  });
  if (account !== undefined && proved !== undefined && client.paired !== undefined) {
    writeHost(home, account.alias, { ...account.record, deviceId: client.paired.deviceId, deviceToken: client.paired.deviceToken });
  }
  return client;
}

/** Whether a socket's close code is the host letting it go as it stopped, rather than the socket breaking. */
const hostStopping = (code: number | void | undefined): boolean => code === HOST_STOPPING_CLOSE;

/** One socket to the host: the token rides in the first frame, never in the URL; then request and reply by id.
 * Open and auth share one deadline, so a port that accepts and never answers fails in one line, and that deadline
 * is the window the road gets rather than one number for every road. `again` is the one retry above: it is handed
 * the refusal of the frame that carried the token and answers the options to dial once more with, or nothing. */
async function dialOnce(statePath: string, opts: DialOpts, again?: (refused: unknown) => DialOpts | undefined): Promise<HostClient> {
  const aim = opts.aim ?? aimedHost(statePath, opts);
  // Nothing serves this state file here and the line needs one: start it rather than telling the person to. Every
  // other aim is a host somewhere else, which this computer cannot start and must not try to.
  if (aim.kind === "here") await heldOrStarted(statePath, opts.start, opts.say ?? (line => void process.stderr.write(`${line}\n`)));
  // An address with no token beside it opens nothing: this computer holds a token only under a name.
  if (aim.kind === "url" && aim.token === undefined && opts.admit === undefined) throw usageRefusal(addressNotPairedLine(aim.url), READ_THE_HOSTS);
  const { url, token } = hostAddress(statePath, { aim });
  const deadlineMs = opts.deadlineMs ?? dialWindowMs(aim);
  const ws = new WebSocket(url);
  const opened = new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  let closeCode: number | undefined;
  const closed = new Promise<number>(done =>
    ws.once("close", code => {
      closeCode = code;
      done(code);
    }),
  );
  let next = 1;
  /** Set once the host has proved the key this computer pinned: every frame after that reply is sealed under the
   * key both ends agreed, so the token, the code and everything the line asks for cross a road whose carrier
   * reads nothing and writes nothing into it. */
  let seal: Seal | undefined;
  const pending = new Map<number, { settle: (f: Frame) => void; fail: (e: Error) => void }>();
  const listeners = new Set<(f: Frame) => void>();
  ws.on("message", raw => {
    let frame: Frame;
    try {
      frame = JSON.parse(openFrame(seal, raw)) as Frame;
    } catch {
      // A frame that will not open under that key, and one sent in the clear after the seal began, are the same
      // thing: somebody carrying the bytes writing into the socket. It ends, and every waiting reply fails with it.
      if (seal !== undefined) ws.close(1002, SEAL_REFUSAL);
      return;
    }
    const waiter = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
    if (waiter !== undefined) {
      pending.delete(frame.id as number);
      waiter.settle(frame);
      return;
    }
    for (const fn of listeners) fn(frame);
  });
  const closeWords = (): string => (hostStopping(closeCode) ? HOST_STOPPING_LINE : HOST_CLOSED_LINE);
  ws.on("close", () => {
    for (const w of pending.values()) w.fail(new Error(closeWords()));
    pending.clear();
  });
  ws.on("error", () => {});
  const request = async <T extends Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = next++;
    const frame = await new Promise<Frame>((settle, fail) => {
      pending.set(id, { settle, fail });
      const text = JSON.stringify({ ...params, id, op });
      ws.send(seal === undefined ? text : seal.seal(text));
    });
    if (frame.ok !== true) throw Object.assign(new Error(typeof frame["error"] === "string" ? frame["error"] : `${op} failed`), typeof frame["kind"] === "string" ? { kind: frame["kind"] } : {}, problemListsOf(frame));
    return frame as T;
  };
  let timer: NodeJS.Timeout | undefined;
  // What the person reads as the host's address: the authority a host on this computer answers on, and the address
  // as they gave it for one anywhere else, never the ws url the dial builds out of it.
  const where = aim.kind === "here" ? new URL(url).host : aimAddress(aim);
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(noAnswerWithin(where, deadlineMs)), deadlineMs);
  });
  let paired: { deviceId: string; deviceToken: string } | undefined;
  /** Whether the refusal that ended this dial was the answer to the frame that carried the token or the code: the
   * one refusal a second dial can do anything about, since a host that never proved the key this computer pinned
   * refuses the same way however often it is asked. */
  let refusedTheToken = false;
  /** The first frame of every dial that holds a key: this computer's nonce and its half of a fresh key agreement,
   * answered by the host with the key it proves. The fingerprint is read before the signature, since anything
   * answering at this address signs for itself perfectly well and the only thing that tells it from the host is
   * which key it is; both checks stand before a token or a code has crossed, and one refusal covers either, so a
   * stranger learns nothing from which caught it. */
  const openSeal = async (hostKey: string): Promise<Uint8Array> => {
    const mine = freshEphemeral();
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    // Whatever came back that was not the key: a refusal of the frame, a shape this computer cannot read, an
    // older host whose door does not know the op. Every one of them is a host that did not prove the key, and
    // the sentence is the same for all of them, which is also why the refusal is built here and not below,
    // where a token this computer never sent would be read as one the host took away.
    const answer = SealOpenReply.safeParse(await request("seal.open", { nonce, ephemeral: mine.publicKey }).catch(() => undefined));
    if (!answer.success) throw authRefusal(pairKeyRefusal(where));
    const { hostPublicKey, nonce: hostNonce, signature, ephemeral } = answer.data;
    if (keyFingerprint(hostPublicKey) !== hostKey) throw authRefusal(pairKeyRefusal(where));
    if (!verifyPlaceBytes(hostPublicKey, placeLinkTranscript("host", SEAL_CLIENT, nonce, hostNonce, { challenger: mine.publicKey, answerer: ephemeral }), signature)) {
      throw authRefusal(pairKeyRefusal(where));
    }
    seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, ephemeral), SEAL_CLIENT), "place");
    // The bytes the host expects this end to sign, built from the same transcript the other way round: what a
    // device on the account signs to come in, and what a joined computer signs at place.prove.
    return placeLinkTranscript("place", SEAL_CLIENT, hostNonce, nonce, { challenger: ephemeral, answerer: mine.publicKey });
  };
  /** What a refusal of the frame that carried the token or the code means to the person. A refusal whose frame
   * carries no kind is classed by the close code that follows it, so a host of an older version that sends the
   * code alone still reads as auth; a frame with a kind is the source when there is one. A host somewhere else
   * says so with its alias and the line that pairs again, since its token is this computer's to renew. Only those
   * two frames come here: a host that did not prove its key was answered before either of them was sent. */
  const tokenRefused = async (e: unknown): Promise<never> => {
    refusedTheToken = true;
    const kind = (e as { kind?: unknown }).kind;
    if (kind === undefined) {
      await Promise.race([closed, new Promise(r => setTimeout(r, CLOSE_GRACE_MS))]);
      if (closeCode !== UNAUTHORIZED_CLOSE) throw e;
      // A frame with no kind behind an unauthorized close, where this computer sent device.auth: the host's own
      // door does not know that frame, so it is an older wsp.
      if (opts.admit !== undefined) throw authRefusal(deviceAuthOldHostLine(where));
    } else if (kind !== "auth") throw e;
    // A host that refused an admission said why in its own sentence, and there is no token of this computer's to
    // pair again for: the sentence is printed as it came.
    if (opts.admit !== undefined) throw authRefusal(e instanceof Error ? e.message : String(e));
    // A host that refused an alias's token has revoked this computer, whatever words it used.
    if (aim.kind !== "alias") throw authRefusal(e instanceof Error ? e.message : String(e));
    throw authRefusal(deviceRefusedLine(aim.alias));
  };
  /** One release on both ends or nothing past the first frame: the wire's shapes drop the keys they do not know, so
   * a line and a host of two releases would misread each other rather than fail. A host that names no release is
   * one from before the answer carried it, and is not judged. */
  const sameRelease = (answer: Record<string, unknown>): void => {
    const theirs = answer["version"];
    if (opts.anyRelease === true || typeof theirs !== "string" || theirs === VERSION) return;
    const road = typeof answer["road"] === "string" ? answer["road"] : undefined;
    throw releaseRefusal(VERSION, theirs, aim.kind === "here" ? { state: statePath } : { where: aimName(aim), here: isLoopback(new URL(aimAddress(aim)).hostname) }, road);
  };
  const authed = opened
    .catch((e: unknown) => {
      throw noAnswerRefusal(where, e instanceof Error ? e.message : String(e));
    })
    .then(async () => {
      // Before the token or the code: the host proves the key this computer pinned, and everything after that
      // reply rides inside the seal both ends agreed. A host on this computer is reached over its own loopback,
      // where there is no road for anybody to stand on, and dials as it always did.
      const pinned = opts.admit?.hostKey ?? (aim.kind === "here" ? undefined : aimHolds(aim).hostKey);
      const expect = pinned === undefined ? undefined : await openSeal(pinned);
      if (opts.admit !== undefined) {
        // A computer the account admitted: it proves the key that host was told to trust over this socket's own
        // handshake, so the signature stands for this dial and no other, and takes a token of its own back.
        if (expect === undefined) throw authRefusal(pairKeyRefusal(where));
        const admitted = await request<{ deviceId: string; deviceToken: string }>("device.auth", {
          publicKey: opts.admit.key.publicKey,
          name: opts.admit.name,
          signature: signPlaceBytes(opts.admit.key.privateKeyPem, expect),
        }).catch(tokenRefused);
        paired = { deviceId: admitted.deviceId, deviceToken: admitted.deviceToken };
        sameRelease(admitted);
        return;
      }
      sameRelease(await request("auth", { token }).catch(tokenRefused));
    });
  try {
    await Promise.race([authed, deadline]);
  } catch (e) {
    ws.terminate();
    // The one road that tries again: a host that refused the token this computer holds, where the caller above
    // knows another first frame to send. Anything else, and any second refusal, is the person's to read.
    if (again !== undefined && refusedTheToken && (e as { kind?: unknown }).kind === "auth") {
      const next = again(e);
      if (next !== undefined) return dialOnce(statePath, next);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let subscribed: Promise<void> | undefined;
  return {
    request,
    events: () => (subscribed ??= request("events.subscribe").then(() => undefined)),
    onFrame: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    closed,
    closeWords,
    ...(paired !== undefined ? { paired } : {}),
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  };
}

/** Whether the host let this socket go as it stopped, which is the one close a wait dials through: that host is
 * coming back, and the turn it was waited on for goes on without it. Read once the socket is gone. */
export async function stoppedUnder(client: HostClient): Promise<boolean> {
  return hostStopping(await Promise.race([client.closed, Promise.resolve()]));
}

/** What a line waiting on a turn says on stderr while it dials a host that stopped under it. */
export const HOST_RESTARTING_LINE = "the host is restarting; waiting for it to come back";

/** A socket to the host again after it stopped under a wait: dialled until one opens within `windowMs`, each dial
 * handed what is left of it as its own deadline, so a port that accepts and never answers cannot carry the wait past
 * it. Past that the last dial's own refusal is the answer, which says what stands now: no host serving the file, or
 * one that does not answer. */
export async function hostAgain(dial: (withinMs: number) => Promise<HostClient>, windowMs: number): Promise<HostClient> {
  const until = Date.now() + windowMs;
  for (;;) {
    try {
      return await dial(Math.max(1, until - Date.now()));
    } catch (e) {
      if (Date.now() >= until) throw e;
    }
    await new Promise(r => setTimeout(r, Math.min(POLL_MS, Math.max(0, until - Date.now()))));
  }
}

/** The host that came back after it stopped under a wait, within `withinMs`: as long as a host is given to come up
 * on this computer unless the caller's own wait has less left. */
export function hostBack(deps: Pick<VerbDeps, "client" | "hostWaitMs">, withinMs: number = deps.hostWaitMs ?? SERVICE_WAIT_MS): Promise<HostClient> {
  return hostAgain(left => deps.client({ withinMs: left }), withinMs);
}

/** A follower's promise, or a failure when the host goes away first: a director waiting on a turn must never hang. */
export function untilSettled<T>(client: HostClient, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    client.closed.then((): never => {
      throw new Error(client.closeWords());
    }),
  ]);
}

/** Frames pushed to the socket, held from before the request that names what to wait for: the id to match is
 * only known once the reply lands, and the host may push the first frame right behind it. A stop from inside `on`
 * drops the held frames not yet replayed too: a whole turn may sit in them when the harness answered at once. */
export function pushedFrames(client: HostClient): { follow(pick: (f: Frame) => boolean, on: (f: Frame) => void): void; stop(): void } {
  const held: Frame[] = [];
  let sink: ((f: Frame) => void) | undefined;
  const off = client.onFrame(f => (sink !== undefined ? sink(f) : held.push(f)));
  return {
    follow: (pick, on) => {
      sink = f => {
        if (pick(f)) on(f);
      };
      for (const f of held.splice(0)) sink(f);
    },
    stop: () => {
      off();
      sink = () => {};
    },
  };
}

/** Every verb speaks through this. With --json each value is one JSON line on stdout and nothing else is
 * printed; without it the line is printed when there is one, and a reply streams to stderr as it arrives. */
export interface Out {
  emit(value: unknown, line?: string): void;
  stream(text: string): void;
}

export function formatter(io: CliIO, json: boolean): Out {
  return {
    emit: (value, line) => {
      if (json) io.log(jsonLine(value));
      else if (line !== undefined) io.log(line);
    },
    stream: text => {
      if (!json) io.stream?.(text);
    },
  };
}

/** The agent's end of stdio with every C1 control escaped: JSON.stringify leaves C1 raw, where a script printing the
 * answer would hand it to a terminal. */
export function c1Escaped(out: Writable): Writable {
  const text = new StringDecoder("utf8");
  const safe = new Transform({ transform: (chunk: Buffer, _encoding, done) => done(null, escapeC1(text.write(chunk))), flush: done => done(null, escapeC1(text.end())) });
  safe.pipe(out);
  return safe;
}

/** The rows wsp places prints. Every fact is what the place last reported; a provider row carries its rate and no
 * shape, since nothing about a machine exists there until one is forked. */
export function placeLines(places: readonly PlaceView[]): string[] {
  if (places.length === 0) return ["This host holds no place. wsp add prints the join line for a computer you are sitting at."];
  const rows = places.map(p => [
    p.name,
    p.kind,
    p.shape === undefined ? "" : String(p.shape.cpu),
    p.shape === undefined ? "" : fmtBytes(p.shape.memMb * 1024 * 1024),
    p.diskFreeBytes === undefined ? "" : fmtBytes(p.diskFreeBytes),
    p.engine === undefined ? "" : p.engine,
    // How a project's files get into a workspace there: beside the engine, since both are what that computer
    // brings to a workspace rather than what the workspace asked for.
    p.copies === undefined ? "" : p.copies,
    p.kind === "provider" ? fmtPrice(p.rateUsdPerHour ?? 0) : p.present === true ? "yes" : "no",
    p.forks === undefined ? "" : `${p.forks.running} of ${p.forks.running + p.forks.room}`,
    p.kind === "provider" ? "" : (p.lastSeenAt ?? ""),
    p.default ? "default" : "",
    // The one word about a computer running an older daemon than this wsp deploys, built in the protocol so this
    // row and the app's table say it the same way; empty on a row that is level, ahead, or has never reported.
    placeDaemonBehind(p) ?? "",
    p.build ?? "",
  ]);
  return table([["PLACE", "KIND", "CORES", "MEMORY", "DISK FREE", "ENGINE", "COPIES", "PRESENT", "FORKS", "LAST SEEN", "DEFAULT", "BEHIND", "IMAGE"], ...rows]);
}

/** The computer every screen and every reader here is told it is on; the one reading, so a run, its hand-off and
 * the init job a host serves never disagree about which of the two this is. */
export const hostPlatform = (): Platform => (platform() === "darwin" ? "darwin" : "linux");

/** The rows wsp computers prints: this computer, each box joined to it and each cloud account, in the words a
 * person uses for them. Every fact is what that computer last reported; a cloud row carries its rate and no shape,
 * since nothing about a machine exists there until one is forked. No row is marked default: which computer a
 * workspace lands on is its project's to say. The platform is handed in, since what this computer is called is
 * read where the host runs and not guessed here, and so is the spend, which is a read of its own. */
export function computerLines(places: readonly PlaceView[], platform: "darwin" | "linux", spend: readonly PlaceSpend[] = [], pending: readonly PendingComputer[] = []): string[] {
  if (places.length === 0) return ["This host holds no computer. wsp add prints the join line for a computer you are sitting at."];
  const todayOf = (p: PlaceView): number | undefined => spend.find(s => s.place === p.id)?.todayUsd;
  // A computer that joined and still waits on its picks reads its add's word on its own row.
  const addOf = (p: PlaceView): PendingComputer | undefined => pending.find(a => a.placeId === p.id);
  const rows = places.map(p => [
    tableName(p),
    computerKindWord(p, platform),
    p.shape === undefined ? "" : String(p.shape.cpu),
    p.shape === undefined ? "" : fmtBytes(p.shape.memMb * 1024 * 1024),
    p.diskFreeBytes === undefined ? "" : fmtBytes(p.diskFreeBytes),
    p.engine === undefined ? "" : p.engine,
    p.copies === undefined ? "" : p.copies,
    p.kind === "provider" ? fmtPrice(p.rateUsdPerHour ?? 0) : p.present === true ? "yes" : "no",
    p.forks === undefined ? "" : `${p.forks.running} of ${p.forks.running + p.forks.room}`,
    ...capCells(p),
    spendCell(p, todayOf(p)),
    placeStateOf(p, p.present === false ? absentComputer(p.name, null) : null, todayOf(p), addOf(p)).word,
    p.kind === "provider" ? "" : (p.lastSeenAt ?? ""),
    placeDaemonBehind(p) ?? "",
    p.build ?? "",
    // The setup on that computer: what is being put on it, then what stands and what failed. Empty on a cloud and
    // on this computer, which wsp installs nothing on.
    addOf(p) === undefined ? setupWord(p.setup, p.applied) : PENDING_STEP_WORDS[addOf(p)!.step],
    // The agents on that computer, each at the version it answered with and the word for its sign-in. Empty on a
    // cloud account and on this computer, neither of which reports an agent.
    agentsCell(p),
  ]);
  // An add that has not reached Set up is a row of its own until it does: its word and how far it got.
  const waiting = pending.filter(p => p.placeId === undefined || !places.some(r => r.id === p.placeId)).map(p => {
    const word = pendingWord(p);
    return [p.name ?? p.address, "pending", "", "", "", "", "", "", "", "", "", "", word.word, "", "", "", word.sentence ?? "", ""];
  });
  return table([["COMPUTER", "KIND", "CORES", "MEMORY", "DISK FREE", "ENGINE", "COPIES", "PRESENT", "WORKSPACES", "THREADS", "MACHINES", "SPEND", "STATE", "LAST SEEN", "BEHIND", "IMAGE", "TOOLS", "AGENTS"], ...rows, ...waiting]);
}

/** What a computer set to follow a recipe prints: the recipe it follows now, or that it keeps what it has. */
export const followLine = (computer: Pick<PlaceView, "name" | "recipe" | "sync">): string =>
  computer.recipe === undefined || computer.recipe === NO_RECIPE
    ? `${computer.name} follows no recipe; it keeps what it has`
    : `${computer.name} follows ${computer.recipe}; a change to it reaches ${computer.name} on its own`;

/** wsp recipes: one row per recipe, what it holds, the day it was saved and the computers that follow it. */
export function recipeLines(recipes: readonly RecipeView[]): string[] {
  if (recipes.length === 0) return ["No recipe is saved yet. The app's Add a computer saves one, and wsp recipes save <name> --from <computer> saves what a computer was set up with."];
  return table([["RECIPE", "HOLDS", "SAVED", "COMPUTERS"], ...recipes.map(r => [r.name, r.summary, r.savedAt?.slice(0, 10) ?? "", r.machines.join(", ")])]);
}

/** One row of a recipe as wsp recipes show prints it: the row's name, then what it says beyond its name. */
function recipeRowWords(kind: (typeof RECIPE_KINDS)[number], file: RecipeFile): string[] {
  const rows: [string, Record<string, unknown>][] = kind === "configs" ? Object.entries(file.configs).filter((e): e is [string, Record<string, unknown>] => e[1] !== undefined) : Object.entries(file[kind]);
  return rows.map(([name, row]) => {
    const said = Object.entries(row).flatMap(([k, v]) => (v === undefined || (Array.isArray(v) && v.length === 0) ? [] : [`${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`]));
    return said.length === 0 ? name : `${name} (${said.join("; ")})`;
  });
}

/** wsp recipes show: the recipe's name and who follows it, every kind it holds with its rows, and its hash. */
export function recipeShownLines(recipe: RecipeView, hash: string): string[] {
  return [
    `${recipe.name}: ${recipe.summary}`,
    ...RECIPE_KINDS.flatMap(kind => {
      const rows = recipeRowWords(kind, recipe.file);
      return rows.length === 0 ? [] : [`  ${kind.padEnd(8)} ${rows.join(", ")}`];
    }),
    `  followed by ${recipe.machines.length === 0 ? "no computer" : recipe.machines.join(", ")}`,
    `  hash     ${hash}`,
  ];
}

/** What a save prints: the recipe and the computer that follows it now. */
export const recipeSavedLine = (recipe: RecipeView): string => `saved ${recipe.name} (${recipe.summary})${recipe.machines.length === 0 ? "" : `, followed by ${recipe.machines.join(", ")}`}`;

/** What a remove prints: the recipe gone and the computers that follow none now. */
export const recipeRemovedLine = (recipe: RecipeView): string =>
  `removed ${recipe.name}${recipe.machines.length === 0 ? "" : `; ${recipe.machines.join(", ")} keep what it put there and follow no recipe`}`;

/** A flag that takes one word of a set, or nothing where it was left off. */
export function oneOf<T extends string>(name: string, words: readonly T[], value: string | undefined, on?: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(words as readonly string[]).includes(value)) throw usageRefusal(`${flagFor(`--${name}`, on)} takes one of ${words.join(", ")}, and got ${JSON.stringify(value)}.`, "Name one of those.");
  return value as T;
}

/** What wsp usage answers: the accounts and what was used, two reads and two answers, each as the host wrote it. */
export async function readUsage(client: HostClient, range: UsageRange, by: UsageSplit): Promise<{ accounts: unknown; used: unknown }> {
  const [accounts, used] = await Promise.all([client.request<{ accounts: unknown }>("usage.accounts"), client.request<{ used: unknown }>("usage.used", { range, split: by })]);
  return { accounts: accounts.accounts, used: used.used };
}

/** The account a person's word names: its key, else its label or the address it signed in as, in any case. */
export function accountNamed(rows: readonly AccountRow[], word: string): AccountRow {
  const exact = rows.find(r => r.key === word);
  if (exact !== undefined) return exact;
  const said = word.toLowerCase();
  const named = rows.filter(r => r.label.toLowerCase() === said || r.address?.toLowerCase() === said);
  if (named.length === 1) return named[0]!;
  if (named.length === 0) throw Object.assign(new Error(noSuchAccountLine(word)), { kind: "not-found" });
  throw usageRefusal(`${word} names ${named.length} accounts: ${listWords(named.map(r => r.key))}.`, "Name one by its key.");
}

/** wsp usage's two tables: the accounts, then a blank line, then what was used by the split asked for. */
export function usageTableLines(read: { accounts: readonly AccountRow[]; used: UsedAnswer }, now: number): string[] {
  const window = (row: AccountRow, kind: LimitKind): string => {
    const w = row.windows?.find(x => x.kind === kind);
    return w === undefined ? "" : windowCell(w, now);
  };
  const accounts =
    read.accounts.length === 0
      ? ["No agent is signed in on any computer."]
      : table([
          ["AGENT", "ACCOUNT", "COMPUTERS", "SESSION", "WEEK", "RESETS", "PLAN", "STATE"],
          ...read.accounts.map(row => [agentName(row.agent), row.label, row.computers.join(", "), window(row, "session"), window(row, "week"), row.credits === undefined ? "" : creditsWord(row.credits, now), row.plan ?? "", accountState(row)]),
        ]);
  // Two agents running one model are two rows of one name, so a model's row names its agent first.
  const byModel = read.used.split === "model";
  const used =
    read.used.rows.length === 0
      ? [`${USAGE_WORDS.noUse}.`]
      : table([
          [...(byModel ? ["AGENT"] : []), read.used.split.toUpperCase(), "FRESH IN", "WRITTEN", "CACHED", "OUT", "PRICE"],
          ...read.used.rows.map(row => {
            const price = usedPrice(row);
            return [...(byModel ? [row.agent === undefined ? "" : agentName(row.agent)] : []), row.label, fmtTokens(freshIn(row.tokens)), fmtTokens(row.tokens.cacheWrite ?? 0), fmtTokens(row.tokens.cached), fmtTokens(row.tokens.output), [price.figure, price.word].filter(Boolean).join(" ")];
          }),
        ]);
  return [...accounts, "", ...used];
}

/** What wsp computers answers: every row, and what each cloud has spent, both read on the road the list is. */
export async function readComputers(client: HostClient): Promise<{ computers: PlaceView[]; spend: PlaceSpend[]; pending: PendingComputer[] }> {
  const [listed, spent] = await Promise.all([client.request<{ places: PlaceView[]; pending?: PendingComputer[] }>("places.list"), client.request<{ places: PlaceSpend[] }>("cost.spend")]);
  return { computers: listed.places, spend: spent.places, pending: listed.pending ?? [] };
}

/** The settings a reset takes in this process: a cloud's only where a cloud is registered. */
const CLOUD_SETTINGS: readonly PlaceSettingWord[] = ["machines", "spend"];
export const SETTING_RESETS = PlaceSettingWord.options.filter(word => CLOUD_ON || !CLOUD_SETTINGS.includes(word)) as [PlaceSettingWord, ...PlaceSettingWord[]];

/** One computer's settings made and reset by the host, with its name, its login and its recipe where given, answered
 * as the row it now reads and the name it was asked by: by the id off the listing, since two computers may share a
 * name and the host keys by id. One op carries every flag, so the host checks them all before it writes any. */
export async function setComputer(client: HostClient, ref: string, set: PlaceSettingsAsk, reset: readonly PlaceSettingWord[], also: PlaceSetAlso = {}): Promise<{ computer: PlaceView; was: string }> {
  const place = await placeNamed(client, ref);
  const asked = Object.fromEntries(Object.entries(also).filter(([, value]) => value !== undefined));
  const { place: computer } = await client.request<{ place: PlaceView }>("places.set", { placeId: place.id, ...set, ...(reset.length > 0 ? { reset } : {}), ...asked });
  return { computer, was: place.name };
}

/** What wsp computers set says: a rename first, from the name it had, then the new login, then the recipe it follows,
 * then its settings where any were named or nothing else was. */
export function computerSetLines(computer: PlaceView, was: string, also: PlaceSetAlso, settled: boolean): string[] {
  return [
    ...(also.name !== undefined && was !== computer.name ? [`${was} is ${computer.name} now`] : []),
    ...(also.ssh !== undefined ? [`${computer.name} is reached over ssh as ${also.ssh.trim()} from now`] : []),
    ...(also.recipe !== undefined ? [followLine(computer)] : []),
    ...(settled || Object.values(also).every(value => value === undefined) ? [placeSettingsLine(computer)] : []),
  ];
}

/** A flag as a refusal names it: with the computer it was set for, where the line names one. */
export function flagFor(flagName: string, on: string | undefined): string {
  return on === undefined ? flagName : `${flagName} for ${on}`;
}

/** A --nap word as minutes: whole ones up to the longest window, or off, which is none. */
export function napAsked(word: string, on: string): number {
  if (word === "off") return 0;
  const minutes = Number(word);
  if (!/^\d+$/.test(word) || minutes < 1 || minutes * 60_000 > NAP_AFTER_MAX_MS) throw usageRefusal(`${flagFor("--nap", on)} takes whole minutes from 1 to ${NAP_AFTER_MAX_MS / 60_000}, or off, and got ${JSON.stringify(word)}.`, "Write it as --nap 20 or --nap off.");
  return minutes;
}

/** A --turn-limit word as hours: whole ones up to the longest limit, or off, which is none. */
export function turnLimitAsked(word: string, on: string): number {
  if (word === "off") return 0;
  const hours = Number(word);
  if (!/^\d+$/.test(word) || hours < 1 || hours * 3_600_000 > TURN_LIMIT_MAX_MS) throw usageRefusal(`${flagFor("--turn-limit", on)} takes whole hours from 1 to ${TURN_LIMIT_MAX_MS / 3_600_000}, or off, and got ${JSON.stringify(word)}.`, "Write it as --turn-limit 6 or --turn-limit off.");
  return hours;
}

/** A --spend figure: dollars, zero or more. */
export function dollarsAsked(word: string, on: string): number {
  const usd = Number(word);
  if (word.trim() === "" || !Number.isFinite(usd) || usd < 0) throw usageRefusal(`${flagFor("--spend", on)} takes dollars a day, zero or more, and got ${JSON.stringify(word)}.`, "Write it as --spend 10.");
  return usd;
}

/** The SPEND cell: what the row spent today against its spend per day, empty where its kind has no spend limit or
 * no spend was read, since a figure is never guessed. */
function spendCell(p: PlaceView, todayUsd: number | undefined): string {
  const limit = placeSpendLimit(p);
  return limit === undefined || todayUsd === undefined ? "" : spendMeterWord(todayUsd, limit);
}

/** The THREADS and MACHINES cells: what the row's cap counts against the cap, under the column named for what it counts. */
function capCells(p: PlaceView): string[] {
  const room = placeRoom(p);
  return ["thread", "machine"].map(noun => (room?.noun === noun ? `${room.running}/${room.atOnce}` : ""));
}

/** Columns padded to their widest cell, two spaces apart; the last column is never padded. */
export function table(rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const widths = rows.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
  return rows.map(row => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

export type Flags = Record<string, string | boolean | string[] | undefined>;

/** What both doors are handed beside the line or the arguments: the state file the host serves, which the recipe
 * verbs write beside, and the scanner for tools outside the catalog when the caller has one (it reaches the engine,
 * which the MCP server may not import, so each door decides whether it runs). */
export interface VerbDeps {
  statePath: string;
  alsoHere?: ScanInput["alsoHere"];
  /** The folder the caller runs in: the shell's for the command line, the client's for the tool server, which the
   * agent starts in its own folder. What a thread opened with no workspace named is placed by. Absent where the
   * caller has none. */
  cwd?: string;
  /** The environment the caller runs in, which is where the token of the turn a verb is running inside comes from.
   * Both doors hand in this process's; a test hands in the one it means, never the shell that started it. */
  env: Readonly<Record<string, string | undefined>>;
  /** The socket to the host: a verb's own dial, closed when it returns; a tool server's one dial across calls.
   * `again` is the dial after the host let the last socket go as it stopped, within the time the wait has left:
   * whatever restarts that host brings it back, so this one starts nothing, since a host it started would hold the
   * lock the returning one needs. */
  client(again?: { withinMs: number }): Promise<HostClient>;
  /** How long a line whose host stopped under it waits for that host to come back: the time a host is given to
   * start, unless a test hands in a shorter one. */
  hostWaitMs?: number;
  /** What brings the host up when nothing serves the state file here; both doors hand in the one built from how
   * this process was started. Absent starts nothing, which is what a caller with no wsp to spawn has. */
  start?: HostStarter;
  /** Where a --watch's stop arrives. This process by default; a test hands in its own, since a real signal would
   * take the test runner with it. */
  signals?: WatchSignals;
  /** How the socket to the host is opened. dialHost by default; a caller hands in its own to count the dials a line
   * makes, which is the whole of whether a watch holds one socket or opens one per frame. */
  dial?: typeof dialHost;
  /** Whether the caller is somewhere other than the computer this process runs on: a line or a tool call typed
   * inside a machine and carried here over the guest road. Every rule that would read a path or resolve a folder
   * against this computer reads it, since what such a caller names is on its own machine and answering off this
   * one would hand it the person's files. */
  elsewhere?: boolean;
  /** The terminal a sign-in run on a computer is shown in, and what opens its page here; this process's own
   * terminal and this computer's opener by default, which a test replaces. */
  terminal?: RelayTerminal;
  open?(url: string): Promise<boolean>;
}

/** What a person names when they record a machine of their own: where it is, and the port, key and name they give
 * it where those are not what the address and the machine already say. */
export interface SshAsked {
  name?: string;
  port?: number;
  keyPath?: string;
}

export interface VerbContext extends VerbDeps {
  args: string[];
  flags: Flags;
  io: CliIO;
  out: Out;
  /** Which host this line runs against, read once by the command line; the verbs that can work without one read it
   * to tell a state file nothing serves from a host somewhere else, which is served and is not this computer's. */
  aim: HostAim;
  /** The verb's own usage, for the fix half of a refusal about what the line takes: the shape of the line is the
   * answer to a line with the wrong number of words, and it is written once, in the table above. */
  usage: string;
}

/** The fix half of a refusal about what a line takes: the verb's own usage, as the help prints it. */
export const usageIs = (ctx: VerbContext): string => `usage: ${ctx.usage}`;

/** The verb as an MCP tool: what it does in the agent's words, the zod shape of what it takes and of what it
 * answers, and the call. The shapes are what tools/list serves and what the parity test holds the skill to. */
export interface Tool {
  description: string;
  input: z.ZodRawShape;
  output: z.ZodRawShape;
  /** The output fields the command line prints as frames under --json, one per line ahead of the result, which leaves
   * them out; a result with nothing left is not printed. */
  stream?: readonly string[];
  call(args: Record<string, unknown>, deps: VerbDeps): Promise<CallToolResult>;
}

/** Types the call's arguments from the input shape, then lets the entry sit in the table beside every other. */
export function tool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(spec: {
  description: string;
  input: In;
  output: Out;
  stream?: readonly (keyof Out & string)[];
  call(args: z.objectOutputType<In, z.ZodTypeAny>, deps: VerbDeps): Promise<CallToolResult>;
}): Tool {
  return spec;
}

/** Which page a line prints on. `front` is the sixteen words a person meets; `agent` the verbs an agent reaches
 * for, behind `wsp --help agent`; `host` the plumbing under `wsp host`; `dev` the doctor, behind `wsp --help dev`;
 * `app` a line the app's own screens stand on, printed on no page, still parsed and still served as a tool. Every
 * line declares one, so a line added prints somewhere or says in the table that it prints nowhere. */
export type Page = "front" | "agent" | "host" | "dev" | "app";

/** A verb on both doors: the words that select it on the command line, its usage and one phrase on what it does in
 * every help, the page it prints on, the flags it reads beside COMMON, its run, and its tool. */
/** One flag of a verb's table: the parser's own row, and `valueWith` where the flag's value is optional: alone it
 * stands bare, and it takes the word after it as its value only on a line that also carries the flag named there. */
export type FlagRow = NonNullable<ParseArgsConfig["options"]>[string] & { valueWith?: string };
export type FlagTable = Readonly<Record<string, FlagRow>>;

/** The line with each flag whose row makes its value optional written `--<flag>=` where it stands bare, so the parser
 * reads it alone: where its row's other flag is not on the line, or no word follows it. */
export function optionalValues(argv: readonly string[], table: FlagTable): string[] {
  const cut = argv.indexOf("--");
  const words = cut === -1 ? argv : argv.slice(0, cut);
  const has = (name: string): boolean => words.some(w => w === `--${name}` || w.startsWith(`--${name}=`));
  const bare = new Set<number>();
  for (const [name, row] of Object.entries(table)) {
    if (row.valueWith === undefined) continue;
    const alone = !has(row.valueWith);
    words.forEach((w, i) => {
      if (w === `--${name}` && (alone || words[i + 1] === undefined || words[i + 1]!.startsWith("-"))) bare.add(i);
    });
  }
  return argv.map((w, i) => (bare.has(i) ? `${w}=` : w));
}

export interface CliVerb {
  name: string;
  usage: string;
  about: string;
  page: Page;
  options: FlagTable;
  run(ctx: VerbContext): Promise<number>;
  tool: Tool;
  readsHere?: string;
  /** Why this line dials only a host already up and never starts one: with none serving its state it refuses. */
  startsNoHost?: string;
  /** Why this line dials a host of another release rather than refusing it, as every other line does. */
  anyRelease?: string;
  /** Only means something on a cloud: with none registered the line prints on no page, its tool is not served, and
   * typing it is refused by the flag. */
  cloud?: true;
  /** The flags that only mean something on a cloud, each named as the tool's input is too: with none registered they
   * leave the verb's table, usage and tool, and typing one is refused by the flag. */
  cloudFlags?: readonly string[];
}

/** A verb the tool door alone offers, with why the command line has no such line. */
export interface ToolOnlyVerb {
  name: string;
  tool: Tool;
  toolOnly: string;
  readsHere?: string;
}

/** A verb the command line alone offers, with why no tool serves it: a line only a person at this terminal has any
 * business running. The parity test holds the reason as it holds a tool-only verb's. */
export interface CliOnlyVerb extends Omit<CliVerb, "tool"> {
  cliOnly: string;
  /** Why this line runs at its own host's terminal and nowhere else. The flag is still parsed, so a typed --host
   * reads this sentence rather than the parser's unknown option, and so does WSP_HOST and the account's one host. */
  hostSide?: string;
}

/** A tool whose command line is one of the shared parse's own commands, which runs that line at the terminal: one
 * capability on both doors, the line's flags the tool's inputs. */
export interface CommandToolVerb {
  name: string;
  tool: Tool;
  command: true;
}

export type Verb = CliVerb | ToolOnlyVerb | CliOnlyVerb | CommandToolVerb;

/** Why a verb's work is on the computer the wsp process runs on rather than on the host it drives: it reads this
 * computer's own package managers, agent history or terminal config. Read by the doors that serve a caller which is
 * not on this computer, since there "this computer" would be the person's and not the machine the caller is on. */
export function readsHere(verb: Verb): string | undefined {
  return "readsHere" in verb ? verb.readsHere : undefined;
}

/** Whether this verb is served as a tool; a cli-only one says in its own words why not. */
export function hasTool<V extends Verb>(verb: V): verb is Extract<V, { tool: Tool }> {
  return "tool" in verb;
}

/** The one rule that names a verb's tool: its words joined by underscores, so `thread read` is `thread_read`. */
export function toolName(words: string): string {
  return words.replace(/ /g, "_");
}

/** The flags every verb takes beside its own. */
export const COMMON: NonNullable<ParseArgsConfig["options"]> = {
  host: { type: "string" },
  state: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

/** The letter each shared flag also answers to. */
const COMMON_SHORTS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(COMMON).flatMap(([name, option]) => (typeof option.short === "string" ? [[option.short, name]] : [])));

/** The shared flags read off a whole line, each with the value it carries, and the rest of the words in the order
 * they were typed. This runs before the verb's words select it, so a shared flag sits as readily in front of them as
 * behind, and whatever is left is the verb's to parse: a word this pass does not know stays where it was typed, for
 * the parse that does know the line to refuse by name. From `--` on the words are the line's own, never flags. */
export function takeCommon(argv: ReadonlyArray<string>): { common: string[]; rest: string[] } {
  const common: string[] = [];
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--") {
      rest.push(...argv.slice(at));
      break;
    }
    const name = word.startsWith("--") ? word.slice(2).split("=")[0]! : word.startsWith("-") ? COMMON_SHORTS[word.slice(1)] : undefined;
    const option = name === undefined ? undefined : COMMON[name];
    if (option === undefined) {
      rest.push(word);
      continue;
    }
    const value = option.type === "string" && !word.includes("=") ? argv[at + 1] : undefined;
    // A flag needing a value and given none by the end of the line stays where it was typed: moved in front of the
    // words that follow it, the parse would read one of them as its value instead of refusing the flag by name.
    if (option.type === "string" && !word.includes("=") && value === undefined) {
      rest.push(word);
      continue;
    }
    common.push(word);
    if (value !== undefined) common.push(argv[++at]!);
  }
  return { common, rest };
}

/** The model, effort and access mode flags, on every verb that opens a thread. */
export const PICK_FLAGS = ["model", "effort", "access"] as const;
/** What a message into a thread that has run may name. Its access is not one: a thread's access is the thread's
 * own, changed where the person changes it and never by a message, so the flag reads here as a flag this verb
 * does not take rather than as a pick that is quietly dropped. */
const SEND_FLAGS = ["model", "effort"] as const;
const optionsFor = (names: readonly string[]): NonNullable<ParseArgsConfig["options"]> => Object.fromEntries(names.map(name => [name, { type: "string" }]));
export const PICK_OPTIONS = optionsFor(PICK_FLAGS);
export const SEND_OPTIONS = optionsFor(SEND_FLAGS);

export const flag = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
export const flagList = (flags: Flags, name: string): string[] => (Array.isArray(flags[name]) ? (flags[name] as string[]) : []);

/** What a table calls a computer: the name a person types for it, and a provider by the name the app gives it, never
 * the id stored state holds; either one names it after --on. */
export const tableName = (p: PlaceView): string => (isProviderPlace(p) ? providerKeyName(p.name) : p.name);

export const PLACES_FIX = "Run wsp places.";

/** The place a word names, by the name or the id the list carries; a word nothing holds is refused with the names
 * there are. One reading, so the verb and the tool answer an unknown place alike. */
export async function placeNamed(client: HostClient, word: string): Promise<PlaceView> {
  const places = (await client.request<{ places: PlaceView[] }>("places.list")).places;
  const found = places.find(p => namesPlace(p, word));
  if (found === undefined) throw usageRefusal(noSuchPlaceRefusal(word, places.map(p => p.name)), PLACES_FIX);
  return found;
}

/** A path a caller named, refused unless absolute: whoever reads it has a working folder of its own that the caller
 * cannot see, so a relative path resolves somewhere neither of them meant. `named` opens the line. */
export function absolutePath(named: string, path: string): string {
  if (!path.startsWith("/")) throw usageRefusal(`${named}, absolute, and got ${JSON.stringify(path)}.`, "Give a path that opens with /, since whoever reads it works in a folder this line cannot see.");
  return path;
}

/** A folder named for a thread, refused unless absolute: the harness would run a relative one against its own home
 * and fail inside the guest, where the person reads it as a harness failure. */
export function absoluteFolder(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : absolutePath("--cwd is a path on the machine", cwd);
}

/** wsp's access word off a line or a tool, refused before anything is asked where it is no word of the four: a
 * harness's own spelling among them, since one word means one thing on every agent. */
export function accessWordOf(given: string): AccessChoice {
  const word = AccessChoice.safeParse(given);
  if (!word.success) throw usageRefusal(`${accessWordsLine(given)}.`, "Name one of those; which of its own modes each one is, is the agent's row's to say.");
  return word.data;
}

/** Whether a path is the folder or inside it. */
export const under = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/** The words of the refusal a line and a host of two releases meet: the node line's and, through the record, the
 * daemon binary's, so both say the one sentence. */
export const RELEASE_WORDS = {
  said: (mine: string, host: string, theirs: string): string => `this line runs wsp ${mine} and ${host} runs wsp ${theirs}:`,
  hostHere: (state: string): string => `the host serving ${state}`,
  hostAt: (where: string): string => `the host at ${where}`,
  restart: "restart that host with wsp restart.",
  reopenApp: (mine: string): string => `quit and reopen the app that holds it once the app is on wsp ${mine}.`,
  restartUp: UP_RESTART_LINE,
  initFinish: "let the wsp init that serves it finish, then run this line again.",
  updateThere: (mine: string): string => `update wsp to ${mine} on that computer and restart its host there.`,
  updateHere: (line: string, theirs: string): string => `${line} on this computer brings this line to ${theirs}.`,
};

/** Which host a release refusal names: the one serving this computer's state file, or one by its alias or its
 * address, which `here` says is on this computer all the same, as a turn's launch pair is. */
export type ReleaseHost = { state: string } | { where: string; here: boolean };

/** What brings an older host on this computer level, off the road it names beside its release (`hostRoadOf`): the
 * app's host comes back on the app's own release, a terminal's wsp up and init's host refuse a restart, and every
 * other host takes one. */
export function releaseHereFix(mine: string, road: string | undefined): string {
  const W = RELEASE_WORDS;
  return road === "app" ? W.reopenApp(mine) : road === "up" ? W.restartUp : road === "init" ? W.initFinish : W.restart;
}

/** What a line and a host of two releases read, in one sentence: both releases, and what to run on the older end. */
export function releaseRefusal(mine: string, theirs: string, host: ReleaseHost, road?: string): Error {
  const W = RELEASE_WORDS;
  const said = W.said(mine, "state" in host ? W.hostHere(host.state) : W.hostAt(host.where), theirs);
  if (compareVersions(mine, theirs) < 0) return usageRefusal(said, W.updateHere(releaseUpdateLine({ argv: process.argv }, theirs), theirs));
  const fix = "state" in host || host.here ? releaseHereFix(mine, road) : W.updateThere(mine);
  return usageRefusal(said, fix);
}

/** A reply the protocol schema refuses: the host process predates or postdates this command's build. */
export const otherVersion = (op: string): string => `the host answered ${op} in a shape this wsp does not read; it runs another version of wsp, restart it with wsp restart`;

/** The runtime's thread id of a row, the one its events carry; a row from before threads had ids is its own. */
export const threadIdOf = (t: ThreadView): string => t.threadId ?? t.id;

/** What the verbs take in place of the whole id, said beside the id the moment a person first meets one: the ids
 * are 36 characters and nobody retypes one, so the line that hands one over says the shorthand that already works
 * rather than leaving it to be found. It names the verb that reads a thread back as well, since a person holding a
 * thread id wants what the agent said and nothing else on the page they read said which word does that. */
export const THREAD_PREFIX_WORD = "wsp thread read, wsp send and wsp stop take its first characters";

/** The first line a thread's opening prints: its id, and where it went when no workspace was named. */
export const openedThreadLine = (threadId: string, opened: ((threadId: string, folder?: string) => string) | undefined, folder?: string): string => (opened === undefined ? `thread ${threadId}` : opened(threadId, folder));

/** The same line at a terminal, where a person has to retype the id to say anything else to the thread. The tool
 * door prints it without the clause: an agent holding the id passes it whole. */
export const openedThreadSaid = (threadId: string, opened: ((threadId: string, folder?: string) => string) | undefined, folder?: string): string => `${openedThreadLine(threadId, opened, folder)}  ${THREAD_PREFIX_WORD}`;

/** Text off skills.sh as a terminal may print it: no control character but newline and tab, so no escape sequence. */
export const printable = (s: string): string => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** A name a line prints: on one line, so a folder name cannot draw a row of its own, and with no control character. */
export const cell = (s: string): string => withoutControlChars(s.replace(/[\n\t]/g, " "));

/** The fields given, without the ones left out, so an absent input never rides the wire as undefined. */
export function pick<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The one line a refusal or a failure leaves on stderr, the failure object under --json and the prose behind its
 * prefix otherwise, and the exit code the failure's class owns. The prefix is where the command's name is printed,
 * so a sentence that names itself is printed alone rather than behind a second copy of its own name. */
export function failed(io: CliIO, json: boolean, e: unknown, prefix = ""): number {
  const failure = verbFailure(e);
  io.error(json ? jsonLine(failure) : sayOnce(prefix, failure.error));
  return failure.exit;
}

/** A tool call's failure: the text the agent reads, and the object a --json run prints, marked as an error. A
 * refusal the host's own validator wrote reads here as it reads at a terminal, with the tool's own line under it:
 * an agent given the wire's issue list learns this host's every op and nothing about its call. */
export function toolFailure(e: unknown, usage?: string): CallToolResult {
  const failure = verbFailure(usage === undefined ? e : hostSchemaRefusal(e, usage) ?? e);
  return { content: [{ type: "text", text: failure.error }], structuredContent: failure, isError: true };
}

/** Whether a line asked for JSON, read off the words before any `--`, for the refusal of a line the parser would not read. */
export function jsonAsked(argv: ReadonlyArray<string>): boolean {
  const cut = argv.indexOf("--");
  return argv.slice(0, cut === -1 ? argv.length : cut).includes("--json");
}

/** A refusal the host's own validator wrote, turned into the one line a person can act on: what it would not read,
 * and the form the verb takes. The issue list it arrives as carries the wire's field names and every op the host
 * serves, and none of that is a person's to read. Nothing for every other failure, which is already a sentence. */
export function hostSchemaRefusal(e: unknown, usage: string): Error | undefined {
  const said = e instanceof Error ? validatorRefusal(e.message) : undefined;
  return said === undefined ? undefined : usageRefusal(said, `usage: ${usage}`);
}
