// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { ALREADY_JOINED_LINE, CGROUP_MOUNT, RUNTIME_ROOT, THREAD_CGROUPS, WORKSPACE_CGROUPS, JOIN_ADDRESS_LINE, PLACE_CODE_REFUSAL, JOIN_NO_KEY_REFUSAL, joinKeyRefusal, readJoinToken, PLACE_LINK_NONCE_BYTES, PlaceJoinDevice, PlaceJoinReply, type PlaceFile, type PlaceReport, placeDaemonPaths, workFolderIn, hostKeyRefusal, joinAddressOf, placeLinkTranscript, usageRefusal, wsUrlOf, PLACE_NEEDS_ROOT_LINE, placeLeaveUnsavedLine, placeUnreadLine } from "@wsp/protocol";
import { keyFingerprint } from "@wsp/engine";
import { freshEphemeral, makeSeal, newPlaceKeyPair, openFrame, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, type Seal } from "@wsp/runtime";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { daemonFlags, joinedLine, sshDaemonPlace } from "../doctor.js";
import { confirmedAt } from "../verbs.js";
import { daemonBinaryHere } from "../assets.js";
import { DAEMON_TARGETS, guestSystem, noPlaceSystemLine } from "../daemon-binary.js";
import { runningWsp, type RunningWsp } from "../mcp-install.js";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { CliIO } from "../cli.js";
import { joinStanding, placeFound, placeFilePath, placeKeyPath, placeLogPath, placeLogin, placeReport, readPlaceFile, sweepPlace, sweptLine, writeExclusive, type ToolFolders, writePlaceFile, wspArgvOf } from "../place-report.js";
import { installService, runFailureLine, serviceEnv, serviceManagerFor, systemRunner, type ServiceAddress, type ServiceManager, type ServiceRunner } from "../service.js";
import { JOIN_MS, NOTHING_TO_LEAVE_LINE, brokenPlaceLeftLine, joinCutByLeaveLine, joinRefusal, joinUnansweredLine, keyIs, noPlaceManagerLine } from "./add-words.js";
import { placeNameHere } from "./this-computer.js";

/** The two lines wsp join answers to, in one place, since both its refusals print them. */
const JOIN_USAGE = "usage: wsp join <address>... --code <code> [--name <name>]";

/** Which of the two things a person typed a join refusal is about, where it is about one of them: an address
 * nothing answered at, or a code the host would not take. A refusal about neither (a host that would not prove its
 * key, a computer already in a wsp) carries none. */
export type JoinRefusalAbout = "address" | "code" | "host";

/** A join that did not happen, carrying what it was about where that is known. It is thrown where the reason is
 * known, so a screen with one slot per field puts a refusal under the right field rather than reading it back out
 * of the sentence. */
export class JoinRefused extends Error {
  constructor(
    readonly about: JoinRefusalAbout,
    message: string,
  ) {
    super(message);
    this.name = "JoinRefused";
  }
}

export interface JoinFlags {
  code?: string;
  codeFile?: string;
  name?: string;
}

export interface JoinDeps {
  /** How the socket to the host is opened; the ws client unless a test hands its own. */
  dial(url: string): WebSocket;
  run: ServiceRunner;
  platform: string;
  home: string;
  now(): number;
  /** Which manager holds the unit and which login is running this, for a caller that is not this process; this
   * computer's own by default, which is what every terminal means. */
  manager?: ServiceManager;
  uid?: number;
}

const joinDeps = (): JoinDeps => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: systemRunner,
  platform: platform(),
  home: process.env["HOME"] ?? "",
  now: Date.now,
});

/** The daemon's line on a computer joined as a place: the flags every daemon under a login takes, told the place
 * kind, then the place file it dials its host off, the home it keeps its files under and sweeps on a leave, the
 * folder its turns start in, the line that runs wsp here word by word, and the agents to look for on PATH at each
 * dial, as catalog id and command. Only the list of ids is fixed at the join; PATH is read at every dial. */
export function placeDaemonFlags(home: string, file: string, run: RunningWsp = runningWsp()): string[] {
  return [
    ...daemonFlags(sshDaemonPlace({ home, path: "" })),
    "--home",
    home,
    "--work-folder",
    workFolderIn(home),
    "--place-file",
    file,
    ...wspArgvOf(run).flatMap(word => ["--wsp-argv", word]),
    "--agents",
    CATALOG_AGENTS.map(a => `${a.id}=${a.bin}`).join(","),
  ];
}

/** What the daemon on a place needs on disk before it starts: wsp's own folder, the inbox and the work folder, and
 * a token file, minted fresh here; the host replaces it through the ordinary rotation on its first reach, which is
 * the road every other daemon's token takes. */
export function preparePlaceHome(home: string): void {
  const at = placeDaemonPaths(home);
  mkdirSync(at.wsp, { recursive: true, mode: 0o700 });
  mkdirSync(at.inbox, { recursive: true, mode: 0o700 });
  mkdirSync(workFolderIn(home), { recursive: true });
  writeFileSync(at.tokenPath, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
}

/** The join token, off the flag or off the file the installer landed it in, which is deleted before the dial: a
 * token left on a computer's disk is a join somebody else could spend. It carries the code and the fingerprint of
 * the key the host is to prove; a token that names no key is refused here, before anything is dialled. */
function joinCode(flags: JoinFlags): { code: string; hostKey: string } {
  if (flags.code !== undefined && flags.codeFile !== undefined) throw usageRefusal("wsp join takes --code or --code-file, not both.", "Drop one of them.");
  if (flags.code !== undefined) return withHostKey(readJoinToken(flags.code));
  if (flags.codeFile === undefined) throw usageRefusal("wsp join needs the code the host printed.", JOIN_USAGE);
  const path = resolve(flags.codeFile);
  const read = readJoinToken(readFileSync(path, "utf8"));
  rmSync(path, { force: true });
  if (read.code === "") throw usageRefusal(`${path} held no join code.`, "Run wsp add on the host again and write the code it prints into that file.");
  return withHostKey(read);
}

/** The one rule for a token whichever road it came by: a code with no key beside it is a line this computer cannot
 * hold a host to, so it says so rather than pinning whatever answers. */
function withHostKey(read: { code: string; hostKey?: string }): { code: string; hostKey: string } {
  if (read.hostKey === undefined) throw new Error(JOIN_NO_KEY_REFUSAL);
  return { code: read.code, hostKey: read.hostKey };
}

/** Every address in turn until one answers: a host on a network answers on several, and the one a person typed or
 * an installer picked may be the one this computer cannot route to. An address that answered nothing is skipped;
 * anything the host itself said, about the code or about its own key, ends the walk, since its other addresses are
 * the same host and would say the same. */
async function handshakeAt(
  io: CliIO,
  urls: readonly string[],
  code: string,
  hostKey: string,
  name: string,
  home: string,
  client: boolean,
  dial: (url: string) => WebSocket,
): Promise<Awaited<ReturnType<typeof handshake>> & { dialed: string }> {
  let last: Error | undefined;
  for (const url of urls) {
    try {
      return { ...(await handshake(io, url, code, hostKey, name, home, client, dial)), dialed: url };
    } catch (e) {
      if (!(e instanceof JoinRefused) || e.about !== "address") throw e;
      last = e;
      // Said as it happens rather than kept: a person watching a join wants to read which address went nowhere.
      if (urls.length > 1) io.error(e.message);
    }
  }
  throw last ?? usageRefusal("wsp join needs an address to dial.", JOIN_USAGE);
}

/** One dial that joins this computer to a wsp: the key is made here, the host's own key is held to the fingerprint
 * the join line carried, and nothing is written or sent until the host has proved that key back. */
async function handshake(
  io: CliIO,
  url: string,
  code: string,
  /** The fingerprint the join line named, which the key the host answers with has to match. */
  hostKey: string,
  name: string,
  home: string,
  /** Whether this join also buys the device token this computer's own window holds; it wears `name`. */
  client: boolean,
  dial: (url: string) => WebSocket,
): Promise<{ placeId: string; hostPublicKey: string; hostName: string; privateKeyPem: string; report: PlaceReport; device?: { deviceId: string; deviceToken: string } }> {
  const pair = newPlaceKeyPair();
  const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
  // One key agreement per join, thrown away with the socket: from the prove on every frame rides inside it, so
  // the code this computer spends and the report it sends are read by the host and by nobody carrying the bytes.
  const mine = freshEphemeral();
  const report = { ...(await placeReport({ name, home })), dialed: url };
  const ws = dial(url);
  let seal: Seal | undefined;
  let answered: { placeId: string; hostPublicKey: string; hostName: string } | undefined;
  try {
    return await new Promise((done, fail) => {
      const deadline = setTimeout(() => fail(new JoinRefused("address", joinUnansweredLine(url))), JOIN_MS);
      const end = (e: Error): void => {
        clearTimeout(deadline);
        fail(e);
      };
      ws.on("error", (e: Error) => end(new JoinRefused("address", `${url} could not be reached: ${e.message}`)));
      ws.once("close", () => end(new JoinRefused("address", `${url} closed the socket before this computer had joined`)));
      // Frame one carries public values only: the key this computer will prove, its nonce and its half of the
      // agreement. Nothing of the person's crosses before the host has proved the key the join line named.
      ws.once("open", () => ws.send(JSON.stringify({ id: 1, op: "place.join", publicKey: pair.publicKey, nonce, ephemeral: mine.publicKey })));
      ws.on("message", raw => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(openFrame(seal, raw)) as Record<string, unknown>;
        } catch {
          end(new JoinRefused("address", `${url} sent something that is not a frame`));
          return;
        }
        if (frame["ok"] !== true) {
          const said = String(frame["error"] ?? `${url} refused this join`);
          // The one refusal a host has for a code it is not holding, spent or expired or never minted, is the
          // protocol's own constant; every other refusal from over there is about this computer rather than about
          // a field, and travels as the host's own sentence so a screen can print it instead of guessing.
          end(new JoinRefused(said === PLACE_CODE_REFUSAL ? "code" : "host", said));
          return;
        }
        if (frame["id"] === 1) {
          const reply = PlaceJoinReply.safeParse(frame);
          if (!reply.success) {
            end(new Error(`${url} answered the join with something this computer cannot read: ${reply.error.message.replace(/\s+/g, " ").trim()}`));
            return;
          }
          const { placeId, hostPublicKey, nonce: hostNonce, signature, ephemeral, hostName } = reply.data;
          // Nothing of this computer's is written or sent past here: not its report, not its own signature. The key
          // is read before the signature it came with, since a stranger answering at this address signs for itself
          // perfectly well and the only thing that tells it from the host is which key it is.
          if (keyFingerprint(hostPublicKey) !== hostKey) {
            end(new Error(joinKeyRefusal(url)));
            return;
          }
          if (!verifyPlaceBytes(hostPublicKey, placeLinkTranscript("host", placeId, nonce, hostNonce, { challenger: mine.publicKey, answerer: ephemeral }), signature)) {
            end(new Error(hostKeyRefusal(url)));
            return;
          }
          answered = { placeId, hostPublicKey, hostName };
          if (frame["notice"] !== undefined) io.error(String(frame["notice"]));
          // The key both signatures cover, since the transcript named both ephemerals: the prove and everything
          // after it ride inside it, and a carrier that swapped either of them has signed nothing.
          const sealed = makeSeal(sealKeys(sharedSecret(mine.privateKey, ephemeral), placeId), "place");
          ws.send(
            sealed.seal(
              JSON.stringify({
                id: 2,
                op: "place.prove",
                signature: signPlaceBytes(pair.privateKeyPem, placeLinkTranscript("place", placeId, hostNonce, nonce, { challenger: ephemeral, answerer: mine.publicKey })),
                report,
                code,
                ...(client ? { client: { name } } : {}),
              }),
            ),
          );
          seal = sealed;
          return;
        }
        if (frame["id"] === 2 && answered !== undefined) {
          clearTimeout(deadline);
          const device = PlaceJoinDevice.safeParse(frame["device"]);
          done({ ...answered, ...(device.success ? { device: device.data } : {}), privateKeyPem: pair.privateKeyPem, report });
        }
      });
    });
  } finally {
    // The join's own socket is not the link: the service that starts below dials one of its own, and this one would
    // otherwise sit as a place the host thinks is present with nothing serving it.
    ws.close(1000, "the join is done; the agent dials the link");
  }
}

/** What one join needs, whoever asked for it. The road below is the whole of a join, so the command line and the
 * app's shell take the same one; the app hands the shim it writes as the wsp this computer runs. */
export interface JoinPlaceOptions {
  /** The home holding place.json and the key beside it. */
  home: string;
  /** Every address this host answers on, as joinAddressOf gave them, tried in the order they are in: one host is
   * on several networks, and the first that answers is the one this computer can reach. The place file keeps them
   * all, so it keeps dialling when the one it reached stops answering. */
  addresses: readonly string[];
  code: string;
  /** The fingerprint of the key the host is to prove, as the join line carried it beside the code. A host that
   * answers with any other key is refused before this computer sends its own report or signature. */
  hostKey: string;
  /** What the host will call this computer; its own name lowercased when nobody says. */
  name?: string;
  /** Also buy a device token for this computer's own window with the same code. The device is named after the
   * place, off the one `name` below: `wsp remove` finds the token a computer still holds by that name, so the two
   * cannot be two words. An ask rather than a name, so no caller can pass a second one. */
  client?: boolean;
  /** The wsp this computer runs, which the daemon reports as the line a turn's agent is given: this process's own
   * unless the caller runs behind a shim, as the app does. */
  wsp?: RunningWsp;
  /** Which computer this is, for the manager that holds the unit and the line said where there is none; this
   * process's own unless a caller names another. */
  platform?: string;
  /** The login running the join, for the manager that says whether its unit needs root; this process's own unless
   * a caller names another. */
  uid?: number;
  /** Which manager holds the unit: the one that platform has unless the caller names another, and a caller that
   * means none names the key with nothing in it, as the sweep's own option already reads. */
  manager?: ServiceManager | undefined;
  run?: ServiceRunner;
  /** How the socket to the host is opened, and the clock the joined stamp is read off; the real ones by default. */
  dial?: (url: string) => WebSocket;
  now?: () => number;
}

/** What a join answers its caller: enough for the app to open its window on the other wsp with no second read. */
export interface JoinedPlace {
  placeId: string;
  hostName: string;
  hostUrls: string[];
  report: PlaceReport;
  device?: { deviceId: string; deviceToken: string };
}

/** The whole of a join, as a function: the key, the handshake, the two files at the person's own mode, and the unit
 * that dials again at every start. It refuses a computer that already belongs to a wsp, since a place file is the
 * one wsp this computer is in. Throws the host's own sentence on a refusal; the caller decides what a person reads. */
export async function joinPlace(io: CliIO, opts: JoinPlaceOptions): Promise<JoinedPlace> {
  const { home, addresses, code, hostKey } = opts;
  if (home === "") throw new Error("a join needs this login's home folder, and this process has none");
  const file = placeFilePath(home);
  const standing = joinRefusal(home);
  if (standing !== undefined) throw new Error(standing);
  // Before the handshake: a computer nothing would keep the daemon up on is refused with nothing written on it.
  const on = opts.platform ?? platform();
  const row = DAEMON_TARGETS.find(t => t.platform === on);
  if (row !== undefined && !guestSystem(row.system)) throw new Error(noPlaceSystemLine(row.system, "this computer"));
  const manager = "manager" in opts ? opts.manager : serviceManagerFor(on);
  if (manager === undefined) throw new Error(noPlaceManagerLine(on));
  // The agent here is the machine's own service, so a login that cannot write one reads the sentence and stops:
  // before the handshake, before the key, before the place file, before anything of wsp's is on this computer.
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  if (manager.needsRoot?.({ role: "place", statePath: file, home, uid }) === true && uid !== 0) throw new Error(PLACE_NEEDS_ROOT_LINE);
  const bin = daemonBinaryHere();
  const name = opts.name?.trim() !== undefined && opts.name.trim() !== "" ? opts.name.trim() : placeNameHere();
  const now = opts.now ?? Date.now;
  const dial = opts.dial ?? ((url: string) => new WebSocket(wsUrlOf(url)));
  const joined = await handshakeAt(io, addresses, code, hostKey, name, home, opts.client === true, dial);
  const address = joined.dialed;
  const key = placeKeyPath(home);
  const placeFile: PlaceFile = {
    placeId: joined.placeId,
    name,
    hostName: joined.hostName,
    // The one that answered first, then the rest: that is the order the link tries them in from now on.
    hostUrls: [address, ...addresses.filter(at => at !== address)],
    hostPublicKey: joined.hostPublicKey,
    keyPath: key,
    joinedAt: new Date(now()).toISOString(),
  };
  // The handshake ran since the check above, so another join may be writing meanwhile. The key is the claim: of two
  // joins one creates it and the other stops here with nothing written, and the create never follows a link. The
  // place file is the last write, so a join cut off between the two leaves a key alone, which reads as broken.
  if (!writeExclusive(key, joined.privateKeyPem)) throw new Error(ALREADY_JOINED_LINE);
  if (!writePlaceFile(file, placeFile)) {
    if (keyIs(key, joined.privateKeyPem)) rmSync(key, { force: true });
    throw new Error(joinRefusal(home) ?? ALREADY_JOINED_LINE);
  }
  if (!keyIs(key, joined.privateKeyPem)) {
    rmSync(file, { force: true });
    throw new Error(joinCutByLeaveLine);
  }
  io.log(joinedLine(name, address));
  const answer: JoinedPlace = {
    placeId: joined.placeId,
    hostName: joined.hostName,
    hostUrls: placeFile.hostUrls,
    report: joined.report,
    ...(joined.device === undefined ? {} : { device: joined.device }),
  };
  const at: ServiceAddress = { role: "place", statePath: file, home, uid };
  const logPath = placeLogPath(home);
  // HOME is stated rather than inherited: the daemon keeps every file it has under the home its place file sits in,
  // and a manager that hands it the login's own default would put them somewhere else entirely. PATH is the one a
  // login shell here gives, which is what the daemon reports and what a turn on this computer finds: a service
  // starts with almost none, and the app that asked for this join may hold a bare one itself.
  // BROWSER too, since the daemon points its terminals at the cloud's shim unless it was started with one.
  const env = { ...serviceEnv(process.env), HOME: home, PATH: (await placeLogin(process.env, home))["PATH"]!, BROWSER: placeDaemonPaths(home).openShim };
  preparePlaceHome(home);
  const { unit, installed, failure } = await installService(manager, { ...at, argv: [bin, ...placeDaemonFlags(home, file, opts.wsp)], cwd: home, env, logPath }, opts.run ?? systemRunner);
  if (failure !== undefined) {
    if (installed) io.error(`the ${manager.words} ${unit.name} is still there at ${unit.path}; wsp leave takes it away.`);
    throw new Error(runFailureLine(failure));
  }
  io.log(`${manager.words} ${unit.name} is loaded; it dials again at every start`);
  io.log(`log         ${logPath}`);
  const after = manager.afterLoad?.(at);
  if (after !== undefined) io.log(after);
  io.log("wsp leave takes this computer back out.");
  return answer;
}

/** The place file as it stands on this computer, or nothing when it belongs to no wsp. */
export function placeStanding(home: string): PlaceFile | undefined {
  return readPlaceFile(placeFilePath(home));
}

/** The sweep a computer runs on itself, and the lines naming what it took. The host's own remove asks the agent for
 * this over the link; this is the road for a wsp that cannot be reached. */
export async function leavePlace(home: string, run?: ServiceRunner, forPlatform: string = platform()): Promise<string[]> {
  const manager = serviceManagerFor(forPlatform);
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), ...(run !== undefined ? { run } : {}) });
  return swept.removed;
}


/** The road wsp join takes, and the one the app's own join screen takes through the same function. A caller that
 * is not a terminal hands the parts of it that differ there (the line its service runs, the home it works under)
 * and takes the rest as it stands, so nothing about a join is written twice. */
export async function joinCommand(io: CliIO, args: readonly string[], flags: JoinFlags, given: Partial<JoinDeps> = {}): Promise<number> {
  const deps: JoinDeps = { ...joinDeps(), ...given };
  const home = deps.home;
  if (home === "") throw new Error("wsp join needs this login's home folder, and this process has none");
  if (args.length === 0) throw usageRefusal("wsp join takes one address or more.", JOIN_USAGE);
  // One host answers on several addresses, and the one an installer picked may be the one this computer cannot
  // route to: every word is read, and the join tries them in the order they were given.
  const addresses = args.map(typed => {
    const at = joinAddressOf(typed);
    if (at === undefined) throw new JoinRefused("address", `${JOIN_ADDRESS_LINE.what} ${JOIN_ADDRESS_LINE.fix}`);
    return at;
  });
  const standing = joinRefusal(home);
  if (standing !== undefined) {
    io.error(standing);
    return 1;
  }
  const { code, hostKey } = joinCode(flags);
  await joinPlace(io, {
    home,
    addresses,
    code,
    hostKey,
    ...(flags.name !== undefined ? { name: flags.name } : {}),
    platform: deps.platform,
    ...(deps.manager !== undefined ? { manager: deps.manager } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    run: deps.run,
    dial: deps.dial,
    now: deps.now,
  });
  return 0;
}

export async function leaveCommand(
  io: CliIO,
  args: readonly string[],
  /** The workspace profile the sweep takes off as root is the one every install writes unless a caller names another.
   * `unsaved` reads what the runtime's folder holds that no remote has, one line each, the daemon's own read by
   * default; nothing where it could not read it. */
  deps: LeaveDeps = { home: process.env["HOME"] ?? "", run: systemRunner, platform: platform() },
  flags: { yes?: boolean; force?: boolean; takes?: readonly string[] } = {},
): Promise<number> {
  if (args.length !== 0) throw usageRefusal("wsp leave takes no positional arguments.", "Run wsp leave on its own; it takes wsp off the computer you are sitting at.");
  const home = deps.home;
  if (home === "") throw new Error("wsp leave needs this login's home folder, and this process has none");
  const standing = joinStanding(home);
  if (standing === undefined) {
    io.error(NOTHING_TO_LEAVE_LINE);
    return 1;
  }
  const held = "joined" in standing ? standing.joined : undefined;
  const runtime = `${deps.systemRoot ?? ""}${RUNTIME_ROOT}`;
  // Before anything goes, by the read the daemon's own leave makes: the runtime's folder holds the checkouts of the
  // workspaces and the projects here, which the sweep takes whole where it runs as root and the add left a record.
  const found = placeFound(home);
  const takesRuntime = (deps.uid ?? process.getuid?.()) === 0 && found !== undefined && !found.has(runtime) && lstatSync(runtime, { throwIfNoEntry: false }) !== undefined;
  // A runtime folder that stood before the add keeps everything wsp did not make there.
  const takesOwn = (deps.uid ?? process.getuid?.()) === 0 && found?.has(runtime) === true && lstatSync(runtime, { throwIfNoEntry: false }) !== undefined;
  const lost = takesRuntime ? ((deps.unsaved ?? unsavedHere)(runtime) ?? [placeUnreadLine(runtime)]) : [];
  if (lost.length > 0 && flags.force !== true) throw usageRefusal(placeLeaveUnsavedLine(lost), LEAVE_UNSAVED_FIX);
  const name = held?.name ?? "this computer";
  const losing = lost.length > 0 ? `, and with it work no remote has: ${lost.join("; ")}` : "";
  if (!(await confirmedAt(io, flags.yes === true, `Take ${name} out of its wsp?\nwsp comes off this computer: its service, its files${takesRuntime ? ` and ${runtime}` : takesOwn ? ` and wsp's own folders in ${runtime}` : ""}${losing}.`, name))) return 1;
  const manager = serviceManagerFor(deps.platform);
  // The agent is another process from this one, so the sweep stops it before taking its unit file, and the lines
  // below say so.
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), run: deps.run, ...(deps.apparmorProfile === undefined ? {} : { apparmorProfile: deps.apparmorProfile }), ...(deps.tools === undefined ? {} : { tools: deps.tools }), ...(deps.systemRoot === undefined ? {} : { systemRoot: deps.systemRoot }), runtimeRoot: runtime, runtimeProjects: flags.takes ?? [], cgroupRoots: [WORKSPACE_CGROUPS, THREAD_CGROUPS].map(cgroup => `${deps.systemRoot ?? ""}${CGROUP_MOUNT}${cgroup}`), ...(deps.uid === undefined ? {} : { uid: deps.uid }) });
  io.log("broken" in standing ? brokenPlaceLeftLine(standing.broken) : `${standing.joined.name} left the wsp at ${standing.joined.hostUrls.join(", ")}; removed:`);
  for (const line of swept.removed) io.log(sweptLine(line));
  for (const line of swept.kept) io.log(line);
  if (held !== undefined) io.log("The host over there still lists it until somebody runs wsp remove on it.");
  return 0;
}

interface LeaveDeps {
  home: string;
  run: ServiceRunner;
  platform: string;
  apparmorProfile?: string;
  tools?: ToolFolders;
  systemRoot?: string;
  uid?: number;
  unsaved?: (runtime: string) => string[] | undefined;
}

/** The fix half of a leave stopped on work no remote has. */
const LEAVE_UNSAVED_FIX = "Copy that work off this computer from the folders named, or push its branches, then run wsp leave again; wsp leave --force removes it anyway.";

/** What the runtime's folder holds that no remote has, read by the daemon this wsp carries, which reads each checkout's
 * git folder without running git over what an agent wrote. Nothing where that binary is missing or did not answer. */
function unsavedHere(runtime: string): string[] | undefined {
  try {
    const ran = spawnSync(daemonBinaryHere(), ["unsaved", runtime], { encoding: "utf8", timeout: UNSAVED_READ_MS });
    if (ran.status !== 0) return undefined;
    return ran.stdout.split("\n").filter(line => line.trim() !== "");
  } catch {
    return undefined;
  }
}

/** How long the read of the runtime's folder may take: each checkout's walk stops at two seconds. */
const UNSAVED_READ_MS = 120_000;
