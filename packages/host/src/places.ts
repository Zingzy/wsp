// SPDX-License-Identifier: AGPL-3.0-only
// The four words a person types about where their agents run: wsp add, which
// hands out a join line or takes a provider's key; wsp remove, which takes a
// place back out and sweeps wsp off it; wsp join, typed on the computer they
// are sitting at, which dials the host once and then serves the link under
// this computer's own service manager; and wsp leave, the sweep run on a
// computer whose host is gone, which wsp remove cannot reach.
//
// add and remove speak to the host on this computer, at the address its lock
// names and with the token it wrote beside its state file, so neither is a
// road a paired client or an agent can reach: a join code hands out access.
// join and leave touch this computer's own files and dial nobody's host but
// the one the person typed.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ALREADY_JOINED_LINE,
  LOOPBACK,
  PLACE_FILE_MODE,
  PLACE_LINK_NONCE_BYTES,
  PlaceJoinReply,
  PlaceView,
  type PlaceFile,
  authority,
  fmtDuration,
  hostKeyRefusal,
  isLoopback,
  placeLinkTranscript,
  relayUrlOf,
  usageRefusal,
  wsUrlOf,
} from "@wsp/protocol";
import { checkProviderKey, keyCheckLine, type KeyCheck, type MachineBackend } from "@wsp/engine";
import { newPlaceKeyPair, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair, type PlaceWiring } from "@wsp/runtime";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { CliIO } from "./cli.js";
import { servingHost } from "./host-lock.js";
import { aimName, aimedHost, wspHome, type HostAim, type HostPick } from "./hosts.js";
import { placeFilePath, placeKeyPath, placeLogPath, placeReport, readPlaceFile, stopPlaceService, sweepPlace, writePlaceFile } from "./place-report.js";
import { PROVIDER_ENV, addedProviders, providerBackendFor, providerModule, type ProviderEnv } from "./providers.js";
import { publicHostname } from "./relay-link.js";
import { pairOnLoopbackLine, reachAddresses } from "./pairing.js";
import {
  installService,
  noManagerLine,
  runFailureLine,
  serviceEnv,
  serviceManagerFor,
  systemRunner,
  type ServiceAddress,
  type ServiceRunner,
} from "./service.js";
import { dialHost, type DialOpts, type HostClient } from "./verbs.js";
import { writeEnvFile, type Keys } from "./env-keys.js";

/** What this computer is called when the person named no name: its own name lowercased, which is what they would
 * type for it on a command line. The one reading, so the row for this computer and the name a join writes agree. */
export const placeNameHere = (): string => hostname().toLowerCase();

/** Where the host keeps its own ed25519 pair: beside the state file it serves, at the person's own mode, so a
 * second state file on one computer is a second wsp with a key of its own. */
export const hostPlaceKeyPath = (statePath: string): string => join(dirname(statePath), "place-host-key.json");

const isKeyPair = (v: unknown): v is PlaceKeyPair => {
  const k = v as PlaceKeyPair | undefined;
  return typeof k === "object" && k !== null && typeof k.publicKey === "string" && typeof k.privateKeyPem === "string";
};

/** The host's pair, made on the first read and kept. It is the key every place on this host pinned at its join, so
 * losing it means every one of them has to be removed and joined again: it is written once and never rotated here. */
export function hostPlaceKey(statePath: string): PlaceKeyPair {
  const path = hostPlaceKeyPath(statePath);
  if (existsSync(path)) {
    try {
      const held: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isKeyPair(held)) return held;
    } catch {
      // A file that is there and is not a pair is not one this host wrote; a fresh pair goes over it, and every
      // place that pinned the old one refuses the link and says to join again.
    }
  }
  const made = newPlaceKeyPair();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(made, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return made;
}

/** What a host wires for its places: its own pair, the provider it is set up for as a row of the same list, and
 * this computer's own row. */
export function placeWiring(statePath: string, keys: Keys, env: ProviderEnv): PlaceWiring {
  return {
    hostKey: hostPlaceKey(statePath),
    provider: () => {
      const module = providerModule({ keys, env });
      // A row that names no way of being added is no place to show: a host set up to fork nowhere has none.
      if (module.added === undefined) return undefined;
      const { pricing } = providerBackendFor({ keys, env });
      return { id: module.id, rateUsdPerHour: pricing.rateUsdPerHour(pricing.defaultSize) };
    },
    // This computer under the name a person would type for it, and what it is off the same read a place sends about
    // itself, so the row for the computer the host runs on carries the facts every other row carries.
    here: () => {
      const report = placeReport({ name: placeNameHere() });
      return { name: report.name, os: report.os, shape: report.shape, docker: report.docker, ...(report.diskFreeBytes !== undefined ? { diskFreeBytes: report.diskFreeBytes } : {}) };
    },
  };
}

/** How long a join gets to open the socket and finish the handshake. A person is watching, and a host that is not
 * there is a typo in the address as often as it is a network. */
const JOIN_MS = 20_000;

/** The whole of what wsp add prints with no argument: the line to type on the computer being joined, at every
 * address this host answers on, and the other two roads in one line each. */
export function addLines(code: string, expiresAt: number, now: number, addresses: readonly string[], port: number, publicAt: string | undefined): string[] {
  const join = (url: string, note?: string): string => `  wsp join ${url} --code ${code}${note === undefined ? "" : `      (${note})`}`;
  return [
    "wsp add: a computer you own joins by dialing this host. On that computer, with wsp installed:",
    ...addresses.map(at => join(`http://${authority(at, port)}`)),
    ...(publicAt === undefined ? [] : [join(relayUrlOf(publicAt), "when the host is linked to your relay")]),
    `The code is spent by the first join and stops working in ${fmtDuration(Math.max(0, expiresAt - now))}. The computer shows in wsp places within a minute of joining.`,
    "Over ssh instead: wsp add user@host --name <name> installs the agent there and joins it for you.",
    `A provider instead: ${addableProviders().map(id => `wsp add ${id}`).join(", ")}.`,
  ];
}

/** The provider ids wsp add takes, off the one table of them: every row that names how it is added. A provider
 * added tomorrow is on this line without anyone editing it. */
export function addableProviders(): string[] {
  return addedProviders().map(m => m.id);
}

/** What a provider that just became a place reads as. */
export const providerPlaceLine = (id: string, rateUsdPerHour: number): string => `place ${id} · $${rateUsdPerHour.toFixed(3)}/h · forks your image`;

/** The refusal for a word that is neither a provider wsp holds a key for nor an ssh address, naming all three roads. */
export function addRefusal(word: string): string {
  return `wsp add ${word}: that is neither a provider this wsp can be set up for (${addableProviders().join(", ")}) nor an address over ssh (user@host). wsp add with no argument prints the line to type on a computer you are sitting at.`;
}

/** The one line wsp add user@host answers with until the installer that puts the agent on a box over ssh lands: the
 * road exists and the printed join line is the one that works today. */
export const sshAddNotYetLine = (address: string): string =>
  `wsp add ${address}: putting the agent on a computer over ssh is not wired yet. Run wsp add with no argument for the line to type on that computer, or wsp new --ssh ${address} for a workspace on it without joining it.`;

/** The one line `--name` gets on `wsp add`. The flag is the ssh road's, which names the computer it installs the
 * agent on; the printed line is typed on that computer, where `wsp join --name` is what names it. */
export const ADD_NAME_REFUSAL =
  "wsp add: --name belongs to the road that installs the agent on a computer over ssh, which is not wired yet. On the computer you are sitting at, wsp join <address> --code <code> --name <name> names it.";

/** What a remove prints: what came off that computer, what the workspaces on it said as they went, and the note for
 * a place that was not connected to sweep. */
export function removeLines(name: string, answer: { swept: readonly string[]; dropped: readonly string[]; note?: string }): string[] {
  return [
    ...(answer.swept.length === 0 ? [] : [`removed from ${name}:`, ...answer.swept.map(line => `  ${line}`)]),
    ...answer.dropped,
    ...(answer.note === undefined ? [] : [answer.note]),
    `${name} is no longer a place in this wsp.`,
  ];
}

/** The refusal for a name two places share: ids tell them apart, and the person picks one. */
export const twoPlacesLine = (ref: string, ids: readonly string[]): string =>
  `wsp remove ${ref}: this host holds ${ids.length} places by that name; name one by its id (${ids.join(", ")}).`;

/** The refusal for a word no place answers to. */
export const noPlaceLine = (ref: string, names: readonly string[]): string =>
  `wsp remove ${ref}: this host holds no place by that name or id.${names.length === 0 ? " wsp add prints the join line." : ` It holds ${names.join(", ")}.`}`;

/** The line a join prints once the computer is in. */
export const joinedLine = (name: string, url: string): string => `${name} joined the wsp at ${url}; it dials that host on its own from now on.`;

/** The refusal wsp join --serve gets on a computer that is no place. */
export const NOT_A_PLACE_LINE = "this computer is not a place in any wsp; wsp join <address> --code <code> makes it one";

/** The refusal wsp leave gets on the same computer. */
export const NOTHING_TO_LEAVE_LINE = "this computer is not a place in any wsp, so there is nothing to leave";

interface PlaceDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  now(): number;
  run: ServiceRunner;
  platform: string;
  /** How a provider is put the key this computer holds; the one check every other road takes, unless a test hands
   * its own, since a real provider is nobody's to call from a unit test. */
  checkKey(backend: MachineBackend): Promise<KeyCheck>;
}

const systemDeps: PlaceDeps = { dial: dialHost, now: Date.now, run: systemRunner, platform: platform(), checkKey: checkProviderKey };

/** What the two host-side words work on: the state file the host on this computer serves, and where this run would
 * aim a line, which is read to refuse anywhere but here. */
export interface PlaceOpts extends HostPick {
  statePath: string;
  keys?: Keys;
  providerEnv?: ProviderEnv;
}

/** Handing out a join code and taking a place back out happen at the host's own terminal and nowhere else, the same
 * rule wsp pair and wsp devices read. */
function aimHere(word: string, opts: PlaceOpts): HostAim {
  const aim = aimedHost(opts.statePath, opts);
  if (aim.kind !== "here") {
    throw usageRefusal(
      `wsp ${word} runs on the computer the host runs on, and this line is aimed at ${aimName(aim)}.`,
      "Run it in a terminal over there. Which computers a wsp runs on is handed out and taken away at that host's own terminal.",
    );
  }
  return aim;
}

export async function addCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], flags: { name?: string } = {}, deps: PlaceDeps = systemDeps): Promise<number> {
  const [word] = args;
  if (args.length > 1) throw usageRefusal("wsp add takes one provider or one address, or nothing at all.", "usage: wsp add\n       wsp add <provider>\n       wsp add user@host [--name <name>]");
  const aim = aimHere("add", opts);
  if (flags.name !== undefined) {
    io.error(ADD_NAME_REFUSAL);
    return 1;
  }
  if (word !== undefined && addableProviders().includes(word)) return addProvider(io, opts, word, deps);
  if (word !== undefined && word.includes("@")) {
    io.error(sshAddNotYetLine(word));
    return 1;
  }
  if (word !== undefined) {
    io.error(addRefusal(word));
    return 1;
  }
  const lock = servingHost(opts.statePath);
  const address = lock?.address ?? LOOPBACK;
  const client = await deps.dial(opts.statePath, { aim });
  try {
    const { code, expiresAt } = await client.request<{ code: string; expiresAt: number }>("pair.issue");
    const publicAt = publicHostname(opts.statePath);
    // A host on loopback alone with no relay could not be dialled by anything, so the code would open nothing.
    if (isLoopback(address) && publicAt === undefined) io.error(pairOnLoopbackLine(address));
    for (const line of addLines(code, expiresAt, deps.now(), reachAddresses(address), lock?.port ?? 0, publicAt)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

/** A provider as a place: the words name it, this computer is set up for it, and a provider that is opened by a key
 * of the person's is put the one this computer already holds before anything is written. The key itself is read
 * where they keep it and is never written here: which variable a given provider's key lives under is the key seam's
 * to declare, and until it does the row's own rule stands, which is that a missing key is the provider's own
 * refusal rather than a guess made on this side. */
async function addProvider(io: CliIO, opts: PlaceOpts, id: string, deps: PlaceDeps): Promise<number> {
  const module = addedProviders().find(m => m.id === id)!;
  const keys = opts.keys ?? {};
  const env: ProviderEnv = { ...(opts.providerEnv ?? process.env), [PROVIDER_ENV]: id };
  const backend = providerBackendFor({ keys, env });
  if (module.added === "key") {
    const check = await deps.checkKey(backend);
    const said = keyCheckLine(check, true);
    if (check.state === "refused" && said !== undefined) {
      io.error(said);
      return 1;
    }
    // A check nothing answered says nothing about the key: it is taken, and the first fork says its own piece.
    if (said !== undefined) io.error(said);
  }
  writeEnvFile(join(wspHome(opts.env), ".env"), { [PROVIDER_ENV]: id });
  const { pricing } = backend;
  io.log(providerPlaceLine(id, pricing.rateUsdPerHour(pricing.defaultSize)));
  if (servingHost(opts.statePath) !== undefined) io.log(`the host serving ${opts.statePath} reads that at its next start; wsp down and wsp up pick it up now.`);
  return 0;
}

export async function removeCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], deps: PlaceDeps = systemDeps): Promise<number> {
  const [ref] = args;
  if (ref === undefined || args.length !== 1) throw usageRefusal("wsp remove takes one place.", "usage: wsp remove <place>");
  const aim = aimHere("remove", opts);
  const client = await deps.dial(opts.statePath, { aim });
  try {
    const { places } = await client.request<{ places: PlaceView[] }>("places.list");
    const joined = places.filter(p => p.kind === "computer" && p.joinedAt !== undefined);
    const found = joined.filter(p => p.id === ref || p.name === ref);
    if (found.length === 0) {
      io.error(noPlaceLine(ref, joined.map(p => p.name)));
      return 1;
    }
    if (found.length > 1) {
      io.error(twoPlacesLine(ref, found.map(p => p.id)));
      return 1;
    }
    const place = found[0]!;
    const answer = await client.request<{ removed: boolean; swept: string[]; dropped: string[]; note?: string }>("places.remove", { placeId: place.id });
    if (!answer.removed) {
      io.error(noPlaceLine(ref, joined.map(p => p.name)));
      return 1;
    }
    for (const line of removeLines(place.name, answer)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

export interface JoinFlags {
  code?: string;
  codeFile?: string;
  name?: string;
  serve?: boolean;
}

export interface JoinDeps {
  /** How the socket to the host is opened; the ws client unless a test hands its own. */
  dial(url: string): WebSocket;
  run: ServiceRunner;
  platform: string;
  home: string;
  /** The line the service runs, word by word. */
  argv(): string[];
  now(): number;
}

const joinDeps = (): JoinDeps => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: systemRunner,
  platform: platform(),
  home: process.env["HOME"] ?? "",
  argv: () => {
    const bin = process.argv[1];
    if (bin === undefined) throw new Error("wsp join needs the path wsp was started from, and this process has none");
    return [process.execPath, resolve(bin), "join", "--serve"];
  },
  now: Date.now,
});

/** The join code, off the flag or off the file the installer landed it in, which is deleted before the dial: a code
 * left on a computer's disk is a code somebody else could spend. */
function joinCode(flags: JoinFlags): string {
  if (flags.code !== undefined && flags.codeFile !== undefined) throw usageRefusal("wsp join takes --code or --code-file, not both.", "Drop one of them.");
  if (flags.code !== undefined) return flags.code.trim();
  if (flags.codeFile === undefined) throw usageRefusal("wsp join needs the code the host printed.", "usage: wsp join <address> --code <code> [--name <name>]\n       wsp join --serve");
  const path = resolve(flags.codeFile);
  const code = readFileSync(path, "utf8").trim();
  rmSync(path, { force: true });
  if (code === "") throw usageRefusal(`${path} held no join code.`, "Run wsp add on the host again and write the code it prints into that file.");
  return code;
}

/** One dial that joins this computer to a wsp: the key is made here, the host's own key is trusted on this first use
 * because the code proved the person meant it, and nothing is written until the host has proved that key back. */
async function handshake(io: CliIO, url: string, code: string, name: string, deps: JoinDeps): Promise<{ placeId: string; hostPublicKey: string; privateKeyPem: string }> {
  const pair = newPlaceKeyPair();
  const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
  const report = { ...placeReport({ name, home: deps.home }), dialed: url };
  const ws = deps.dial(url);
  let answered: { placeId: string; hostPublicKey: string } | undefined;
  try {
    return await new Promise((done, fail) => {
      const deadline = setTimeout(() => fail(new Error(`the host at ${url} did not answer in ${Math.round(JOIN_MS / 1000)}s`)), JOIN_MS);
      const end = (e: Error): void => {
        clearTimeout(deadline);
        fail(e);
      };
      ws.on("error", (e: Error) => end(new Error(`${url} could not be reached: ${e.message}`)));
      ws.once("close", () => end(new Error(`${url} closed the socket before this computer had joined`)));
      ws.once("open", () => ws.send(JSON.stringify({ id: 1, op: "place.join", code, publicKey: pair.publicKey, nonce, report })));
      ws.on("message", raw => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          end(new Error(`${url} sent something that is not a frame`));
          return;
        }
        if (frame["ok"] !== true) {
          end(new Error(String(frame["error"] ?? `${url} refused this join`)));
          return;
        }
        if (frame["id"] === 1) {
          const reply = PlaceJoinReply.safeParse(frame);
          if (!reply.success) {
            end(new Error(`${url} answered the join with something this computer cannot read: ${reply.error.message}`));
            return;
          }
          const { placeId, hostPublicKey, nonce: hostNonce, signature } = reply.data;
          // Nothing of this computer's is written or sent past here until the host has proved the key it sent.
          if (!verifyPlaceBytes(hostPublicKey, placeLinkTranscript("host", placeId, nonce, hostNonce), signature)) {
            end(new Error(hostKeyRefusal(url)));
            return;
          }
          answered = { placeId, hostPublicKey };
          if (frame["notice"] !== undefined) io.error(String(frame["notice"]));
          ws.send(
            JSON.stringify({
              id: 2,
              op: "place.prove",
              signature: signPlaceBytes(pair.privateKeyPem, placeLinkTranscript("place", placeId, hostNonce, nonce)),
              report,
            }),
          );
          return;
        }
        if (frame["id"] === 2 && answered !== undefined) {
          clearTimeout(deadline);
          done({ ...answered, privateKeyPem: pair.privateKeyPem });
        }
      });
    });
  } finally {
    // The join's own socket is not the link: the service that starts below dials one of its own, and this one would
    // otherwise sit as a place the host thinks is present with nothing serving it.
    ws.close(1000, "the join is done; the agent dials the link");
  }
}

export async function joinCommand(io: CliIO, args: readonly string[], flags: JoinFlags, deps: JoinDeps = joinDeps()): Promise<number> {
  const home = deps.home;
  if (home === "") throw new Error("wsp join needs this login's home folder, and this process has none");
  const file = placeFilePath(home);
  if (flags.serve === true) {
    if (args.length !== 0) throw usageRefusal("wsp join --serve takes no address.", "The address is the one the join already recorded; run wsp join --serve on its own.");
    const held = readPlaceFile(file);
    if (held === undefined) {
      io.error(NOT_A_PLACE_LINE);
      return 1;
    }
    const { startPlaceAgent } = await import("./place-agent.js");
    const agent = await startPlaceAgent({ file, name: held.name, home, log: line => io.log(line) });
    io.log(`serving ${held.name} as a place of the wsp at ${held.hostUrls.join(", ")}; the daemon is on ${authority(LOOPBACK, agent.port)}`);
    // The agent is the process: it holds the link and redials for as long as this runs.
    await new Promise<void>(() => {});
    return 0;
  }
  const [address] = args;
  if (address === undefined || args.length !== 1) throw usageRefusal("wsp join takes one address.", "usage: wsp join <address> --code <code> [--name <name>]\n       wsp join --serve");
  if (readPlaceFile(file) !== undefined) {
    io.error(ALREADY_JOINED_LINE);
    return 1;
  }
  const code = joinCode(flags);
  const name = flags.name?.trim() !== undefined && flags.name.trim() !== "" ? flags.name.trim() : placeNameHere();
  const joined = await handshake(io, address, code, name, deps);
  const key = placeKeyPath(home);
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  writeFileSync(key, joined.privateKeyPem, { mode: PLACE_FILE_MODE });
  chmodSync(key, PLACE_FILE_MODE);
  const placeFile: PlaceFile = {
    placeId: joined.placeId,
    name,
    hostUrls: [address],
    hostPublicKey: joined.hostPublicKey,
    keyPath: key,
    joinedAt: new Date(deps.now()).toISOString(),
  };
  writePlaceFile(file, placeFile);
  io.log(joinedLine(name, address));
  const manager = serviceManagerFor(deps.platform);
  if (manager === undefined) {
    io.error(noManagerLine(deps.platform));
    io.log("Run wsp join --serve in a terminal that stays open instead.");
    return 0;
  }
  const at: ServiceAddress = { role: "place", statePath: file, home, uid: process.getuid?.() ?? 0 };
  const logPath = placeLogPath(home);
  // HOME is stated rather than inherited: the agent keeps every file it has under the home its place file sits in,
  // and a manager that hands it the login's own default would put them somewhere else entirely.
  const env = { ...serviceEnv(process.env), HOME: home };
  const { unit, installed, failure } = await installService(manager, { ...at, argv: deps.argv(), cwd: home, env, logPath }, deps.run);
  if (failure !== undefined) {
    io.error(`wsp join: ${runFailureLine(failure)}`);
    if (installed) io.error(`the ${manager.words} ${unit.name} is still there at ${unit.path}; wsp leave takes it away.`);
    return 1;
  }
  io.log(`${manager.words} ${unit.name} is loaded; it dials again at every login`);
  io.log(`log         ${logPath}`);
  const after = manager.afterLoad?.(at);
  if (after !== undefined) io.log(after);
  io.log("wsp leave takes this computer back out.");
  return 0;
}

export async function leaveCommand(io: CliIO, args: readonly string[], deps: { home: string; run: ServiceRunner; platform: string } = { home: process.env["HOME"] ?? "", run: systemRunner, platform: platform() }): Promise<number> {
  if (args.length !== 0) throw usageRefusal("wsp leave takes no positional arguments.", "Run wsp leave on its own; it takes wsp off the computer you are sitting at.");
  const home = deps.home;
  if (home === "") throw new Error("wsp leave needs this login's home folder, and this process has none");
  const held = readPlaceFile(placeFilePath(home));
  if (held === undefined) {
    io.error(NOTHING_TO_LEAVE_LINE);
    return 1;
  }
  const manager = serviceManagerFor(deps.platform);
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), run: deps.run });
  // The agent is another process from this one, so the manager is asked to let it go here and the person reads it.
  await stopPlaceService({ home, ...(manager !== undefined ? { manager } : {}), run: deps.run });
  io.log(`${held.name} left the wsp at ${held.hostUrls.join(", ")}; removed:`);
  for (const line of swept.removed) io.log(`  ${line}`);
  for (const line of swept.kept) io.log(line);
  io.log("The host over there still lists it until somebody runs wsp remove on it.");
  return 0;
}
