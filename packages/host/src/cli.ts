// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { isCancel } from "@clack/prompts";
import { collect, computeRecipe, expand, nodeHost, scanProject, type Manifest, type Platform, type Rung } from "@wsp/collect";
import {
  HARNESS_ADAPTERS,
  createRuntime,
  endLocalRuns,
  goldenHead,
  hostIdentity,
  jsonFileStore,
  localExecStream,
  type GoldenRecipe,
  type GoldenVersion,
  type LocalWiring,
  type Machine,
  type Runtime,
  type SshWiring,
} from "@wsp/runtime";
import { GOLDEN_SETUP, GOLDEN_SMOKE, MCP_AGENT_IDS, THREAD_AGENTS } from "@wsp/catalog";
import { authority, authRefusal, DEFAULT_PORT, DEFAULT_WS_PORT, EXIT_CODES, EXIT_WORDS, ExitClass, FIRST_WORKSPACE, fmtDuration, forksNoMachines, initJobOver, InitSetup, isLocalWorkspace, isLoopback, type ListenAsked, listenBeyondLoopbackLine, LOOPBACK, PERSON_HOME_ENV, portsAsked, runForTheList, type SealedImage, shellQuote, THIS_COMPUTER, thisComputerLine, TURN_END_WORDS, unknownWordLine, usageRefusal, foreignFlagLine, WS_PORT_OFFSET } from "@wsp/protocol";
import { agentHome, agentHomes, checkProviderKey, keyCheckLine, type KeyCheck, LocalBackend, type MachineBackend, parseSshAddress, providerSlot, type ProviderSlot, SshBackend, SshForwards, sshIdentity, sshMachineName, sshReachOf, type SshReach } from "@wsp/engine";
import { providerBackendFor, providerEnvWith, providerEnvWithKey, providerKeyRow, providerKeyRows, providerKeySet, providerModule, providerPlaces, wiredProviderId, type ProviderEnv } from "./providers.js";
import { webDirFor } from "./assets.js";
import { DAEMON_DEPLOYED_LINE, claudeEnvs, deployDaemon, doctor, localDoctor, removeDaemon, sshDaemonPlace } from "./doctor.js";
import { agentsHere } from "./agents-here.js";
import { InitJobs } from "./init-job.js";
import { ANTHROPIC_KEY, agentKeyEnvs, keyIn, parseEnvFile, savedEnv, writeEnvFile, type Keys } from "./env-keys.js";
// The writer of the wsp home's .env now sits beside its reader; the name stays exported here for every caller
// that already had it from this module.
export { writeEnvFile } from "./env-keys.js";
import { keychainReader } from "./init-import.js";
import { adoptLoginPath } from "./login-path.js";
import { CACHE_RULE } from "./project-bundle.js";
import { readBrewTable } from "./init-brew.js";
import { copyGoldenRecipe } from "./image-recipe.js";
import { exitCodeOf, runInit, type InitIO, type InitPricing, type InitResult } from "./init.js";
import { recipePath } from "./init-recipe.js";
import { historyCache } from "./recipe-file.js";
import { scanTools } from "./scan.js";
import { colourDepth, confirmPrompt, isTTY, muted, passwordPrompt, wrap, type PromptOptions } from "./init-layout.js";
import { TAGLINE, opening } from "./init-opening.js";
import { runLocalInit } from "./init-local.js";
import { askFirst } from "./init-first.js";
import { buildBesideHost } from "./init-beside.js";
import { startCallbackRelay, systemOpener, type UrlOpener } from "./relay.js";
import { addressLines, dialAddress, hostLogPath, hostTokenPath, lockPathFor, servingHost, takeLock, type HostLock } from "./host-lock.js";
import type { LocalDaemon, LocalDaemonOptions } from "./local-daemon.js";
import { startOnce } from "./start-once.js";
import {
  hostThereLines,
  httpProbe,
  installService,
  logTail,
  noManagerLine,
  runFailureLine,
  serviceEnv,
  serviceManagerFor,
  SERVICE_WAIT_MS,
  serviceReading,
  statusLines,
  stopService,
  systemRunner,
  untilLock,
  untilServing,
  type HostProbe,
  type ServiceAddress,
  type ServiceManager,
  type ServiceRunner,
} from "./service.js";
import { startedByVerb, starterFor, type HostStarter } from "./host-start.js";
import { connectCommand, disconnectCommand, hostsCommand } from "./connect.js";
import { stopRecordedConnector } from "./connector.js";
import { publicHostname, readRelayRecord, relayCommand, relayOnLoopbackLine, startRelay } from "./relay-link.js";
import { aimAddress, aimName, DEFAULT_HOME, type HostPick, namedHost, stateIgnoredLine, wspHome } from "./hosts.js";
import { currentHome, currentHomePointer, homeNamed, servingHome } from "./serving-home.js";
import { advertiseWord, devicesCommand, hostReach, pairCommand } from "./pairing.js";
import { addCommand, addFlags, joinCommand, leaveCommand, placeWiring, removeCommand } from "./places.js";
import { startHost, workspaceRoads, type HostHandle } from "./server.js";
import { serveMcp } from "./mcp.js";
import { agentsOnPath, installEach, installLines, mcpServerCommand, mcpServerSpec, nextLine, refreshSkills, registeredLine, removeEach, removeLines, runningWsp, type RunningWsp } from "./mcp-install.js";
import { CLI_VERBS, COMMON, type DialOpts, dialHost, failed, findVerb, HELP_WIDTH, type HostClient, jsonAsked, type Page, runVerb, takeCommon, toolName, usageLines, verbUsage, type VerbDeps } from "./verbs.js";
import { VERSION } from "./version.js";

/** The computer every screen and every reader here is told it is on; the one reading, so a run, its hand-off and
 * the init job a host serves never disagree about which of the two this is. */
export const hostPlatform = (): Platform => (platform() === "darwin" ? "darwin" : "linux");

/** One line per exit class, the code first, wrapped to the help's width. */
const exitCodeHelp = (): string => ExitClass.options.map(cls => wrap(`  ${EXIT_CODES[cls]} ${cls.padEnd(8)}  ${EXIT_WORDS[cls]}`, 80, " ".repeat(14)).join("\n")).join("\n");

/** The front page, word for word: sixteen words on five nouns, the three rules, and the two pages and the flag
 * help behind them. It is a literal rather than a table of usages because the whole of it is what a person meets
 * first, and its right hand column is written for that reading; the parity test holds its sixteen words to the
 * entries that declare the front page, so a verb cannot be added to one and not the other. */
export const HELP = `wsp - ${TAGLINE}

usage: wsp <verb> <workspace> ...

  wsp init                        seal this computer into your image, once
  wsp add                         a place: user@host for a computer over ssh,
                                  <provider> for a provider, nothing for the
                                  join line another computer types
  wsp places                      your places, the default marked
  wsp remove <place>              take a place out; the computer is left as
                                  wsp found it
  wsp new <name>                  a workspace from your image; --on <place>
                                  says where, once you have more than one
  wsp import <workspace> <folder> put a folder in it; again for the next one
  wsp run <workspace> "<task>"    an agent works in it and you read its reply
  wsp pause <workspace>           sleep it now; an idle one sleeps by itself
  wsp wake <workspace>            wake it now; run, send and exec wake it anyway
  wsp delete <workspace>          gone; the image stays
  wsp workspaces                  what you have, and where each one runs
  wsp threads [<workspace>]       who is working, and in which workspace
  wsp send <thread> "<message>"   the thread's next message
  wsp stop <thread>               end the thread's running turn
  wsp status                      whether a host serves, and where
  wsp mcp                         the same verbs as tools for the agents on this
                                  computer; mcp install --agent <id> wires one

The workspace comes first on every line. The one flag you meet is --on <place>
on new, and only once you have more than one place. Sleeping is automatic;
pause and wake are for now.

wsp <verb> --help      the verb's own flags
wsp --help agent       the verbs your agents use, and up and down
wsp host --help        a host on another computer: pair, connect, link
wsp --version
`;

/** Where a key is read from, as a line says it: one wording for the screen that asks for one and for every refusal
 * that says there was nobody to ask. */
const KEY_LAYER_WORDS = "the environment, ./.env, or ~/.wsp/.env";

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  /** Raw text on stderr, no newline added: a reply as it streams in. */
  stream?(text: string): void;
  /** The same text, standing back from the reply it sits beside, as far as the stream's colours go; absent leaves it plain. */
  muted?(text: string): string;
  /** A yes-or-no question; resolves to "yes" or "no". */
  ask(question: string): Promise<string>;
  /** A person is at the keyboard (stdin and stdout are terminals); absent means an agent or a pipe, and nothing is asked. */
  isTTY?: boolean;
  /** What the stream writes and what log prints land in front of the same eyes (stdout and stderr are both
   * terminals), so text the stream has already shown is not printed a second time under it. Absent, the two part:
   * stdout carries the answer whole and the stream is somebody else's view of the work. */
  sameScreen?: boolean;
  /** A key, typed without echo. Lines after the first are shown under the question. `variable` is what a caller
   * with no terminal is told to set instead, so a refusal in a service log names the key to put in a file rather
   * than saying it. */
  askSecret(question: string, variable?: string): Promise<string>;
  /** One of a set of answers, typed while something else is running: the answer, or nothing when `until` settles
   * first, which is the question being answered somewhere else or going with what asked it. Absent where nobody is
   * at the keyboard, and a caller that reads it absent says the other road to answer on instead. */
  answerKey?(accept: readonly string[], until: Promise<unknown>): Promise<string | undefined>;
}

export type { Keys } from "./env-keys.js";

export interface KeySources {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  /** Whether the provider takes a key, the one check the app's keys step also runs. Absent means this computer can
   * answer nothing about a key, so nothing is checked and nothing is refused for it; `keySources` always carries it,
   * and a test hands over its own answer through the same field. */
  checkKey?(key: string): Promise<KeyCheck>;
}

// The hosts file sits under the same home, so where that home is lives beside it and is re-exported here for every
// reader that already had it from the command line.
export { wspHome };

type Stream<T> = T & { isTTY?: boolean };

/** Questions are clack prompts on the terminal; off a terminal there is nobody to answer them. */
export function terminalIO(input: Stream<Readable> = process.stdin, output: Stream<Writable> = process.stdout): CliIO {
  const screen = input.isTTY === true && output.isTTY === true;
  const nobodyLine = (q: string, variable?: string): string => `${q.split("\n")[0]}: no terminal to ask on; set ${variable ?? "it"} in ${KEY_LAYER_WORDS}.`;
  const nobody = (q: string): Promise<never> => Promise.reject(new Error(nobodyLine(q)));
  // A secret nobody can type is a missing key, the contract's auth class; a yes-or-no nobody can answer is not.
  const noKey = (q: string, variable?: string): Promise<never> => Promise.reject(authRefusal(nobodyLine(q, variable)));
  // The first line of a question is the question; the lines under it are its hint.
  const split = (q: string): PromptOptions => {
    const nl = q.indexOf("\n");
    return nl < 0 ? { message: q, input, output } : { message: q.slice(0, nl), hint: q.slice(nl + 1), input, output };
  };
  const answered = async <T>(prompt: Promise<T | symbol>): Promise<T> => {
    const value = await prompt;
    if (isCancel(value)) throw new Error("Nothing was changed.");
    return value as T;
  };
  return {
    log: line => console.log(line),
    error: line => console.error(line),
    stream: text => process.stderr.write(text),
    muted: text => muted(text, colourDepth(isTTY(process.stderr))),
    isTTY: screen,
    sameScreen: isTTY(output) && isTTY(process.stderr),
    ask: q => (screen ? answered(confirmPrompt(split(q))).then(yes => (yes ? "yes" : "no")) : nobody(q)),
    askSecret: (q, variable) => (screen ? answered(passwordPrompt(split(q))) : noKey(q, variable)),
    ...(screen ? { answerKey: (accept: readonly string[], until: Promise<unknown>) => readAnswerKey(input, accept, until) } : {}),
  };
}

/** One of a set of answers typed at the terminal while a turn streams beside it. The line is read as the terminal
 * gives it, never in raw mode: a turn a person may be watching for an hour must keep the ctrl-c the terminal itself
 * turns into a signal, and a raw read swallows it. A word outside the set is ignored and the question stands. */
function readAnswerKey(input: Stream<Readable>, accept: readonly string[], until: Promise<unknown>): Promise<string | undefined> {
  return new Promise(resolve => {
    const done = (value: string | undefined): void => {
      input.off("data", onData);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const typed = String(chunk).trim().toLowerCase();
      if (accept.includes(typed)) done(typed);
    };
    input.on("data", onData);
    input.resume();
    void until.then(() => done(undefined));
  });
}

/** What an init under --json speaks through: stdout carries the objects alone, so every line the run says goes to
 * stderr beside them, and a key that is not in the environment or a .env file is an error rather than a prompt on a
 * stream nobody is reading. */
export function jsonCliIO(err: Writable = process.stderr): CliIO {
  const say = (line: string): void => void err.write(`${line}\n`);
  const nobodyLine = (q: string, variable?: string): string => `${q.split("\n")[0]}: --json asks nothing; set ${variable ?? "it"} in ${KEY_LAYER_WORDS}.`;
  const nobody = (q: string): Promise<never> => Promise.reject(new Error(nobodyLine(q)));
  const noKey = (q: string, variable?: string): Promise<never> => Promise.reject(authRefusal(nobodyLine(q, variable)));
  return { log: say, error: say, stream: text => void err.write(text), ask: nobody, askSecret: noKey };
}

/** Where a key is read from, in the order they win: this process's environment, then ./.env, then the wsp home's. */
function keyLayers(sources: KeySources): Array<Record<string, string | undefined>> {
  return [sources.env, parseEnvFile(join(sources.cwd, ".env")), parseEnvFile(join(sources.home, ".env"))];
}

/** Where a key is read from on this computer: the environment the run picks its provider out of, the folder it runs
 * in, and the wsp home. One answer, so a test can hand a different one through the same field rather than move the
 * process. */
export function keySources(env: ProviderEnv = process.env): KeySources {
  // The key is put to the provider this run is wired to, under that row's own variable: a person who named a
  // provider is typing that provider's key, whatever another row would have been taken by.
  return { env, cwd: process.cwd(), home: wspHome(env), checkKey: key => checkProviderKey(providerBackendFor(providerEnvWithKey(env, key))) };
}

/** The environment a run picks its provider out of, as this computer stands now: the run's own with the command
 * line's words already in it, and every registered row's key variable taken from the three layers. */
function providerEnvNow(env: ProviderEnv = process.env, cwd: string = process.cwd(), home: string = wspHome(env)): ProviderEnv {
  return providerEnvWith({}, env, keyLayers({ env, cwd, home }));
}

/** How many keys one run takes before it stops asking: a mistyped key is worth another go, an endless prompt is not. */
const KEY_TRIES = 3;

/** What no provider key means for the command that asked. `refuse` is the road every command that needs a machine
 * takes: nothing it does has any meaning without one. `offer` is wsp init's: at a terminal the key is asked for with
 * the way to skip it, and an empty answer takes the local road, since this computer is a workspace of its own. `local`
 * is the road of up, up --service and doctor --local: init already answered, so nothing is asked and
 * the run goes on with no provider. */
export type NoProviderKey = "refuse" | "offer" | "local";

/** What a run reads its keys as: the agents' keys, and the environment its provider is picked out of, carrying
 * every registered row's key variable as the layers hold it and whatever this run was told to type. */
export interface LoadedKeys {
  keys: Keys;
  env: ProviderEnv;
}

export async function loadKeys(
  io: CliIO,
  sources: KeySources = keySources(),
  ask: { anthropic: boolean; noSolari?: NoProviderKey; checkSaved?: boolean } = { anthropic: true },
): Promise<LoadedKeys> {
  const homeEnv = join(sources.home, ".env");
  const layers = keyLayers(sources);
  const env = providerEnvWith({}, sources.env, layers);
  // The row this run is wired to, which is the only one it is asked about: the variable it reads its key from is
  // the one named on the screen, written to the file and put to the provider.
  const row = providerKeyRow(env);
  const keyEnv = row?.keyEnv;
  const held = keyEnv === undefined ? undefined : keyIn(env, keyEnv);
  let anthropic = keysFound(sources, layers).anthropic;
  const loaded = (key: string | undefined): LoadedKeys => ({
    keys: anthropic !== undefined ? { anthropic } : {},
    env: keyEnv === undefined ? env : { ...env, [keyEnv]: key },
  });
  /** The provider's refusal of a key, in the words the app's keys step uses, or nothing. Only a refusal counts: a
   * check nothing answered says nothing about the key, so it is taken and the build says its own piece if it must. */
  const refusalOf = async (key: string, saved: boolean): Promise<string | undefined> => {
    if (sources.checkKey === undefined) return undefined;
    const check = await sources.checkKey(key);
    return check.state === "refused" ? keyCheckLine(check, saved) : undefined;
  };
  // The key a run is about to build with is put to the provider here, so a key it refuses is typed again on this run
  // rather than stopping the build on the far side of the confirm. Every other verb takes a saved key as it stands:
  // one of them on a computer with no road out would otherwise refuse to do work that needs no provider at all.
  let refusedSaved: string | undefined;
  if (held !== undefined) {
    refusedSaved = ask.checkSaved === true ? await refusalOf(held, true) : undefined;
    if (refusedSaved === undefined) return loaded(held);
  }
  // No key on this computer and either a road init already answered, nobody at a keyboard to type one, or a
  // provider that reads no key at all: the local road is taken without a question. Every other command still
  // refuses through its IO's own words below. The Claude key rides on either way: it is the agents' key, not the
  // provider's, and a local thread uses it as a fork would.
  // A refused key is never quietly dropped for the local road: nobody asked for this computer, the provider did.
  if (refusedSaved !== undefined && io.isTTY !== true) throw authRefusal(refusedSaved);
  if (keyEnv === undefined || ask.noSolari === "local" || (ask.noSolari === "offer" && io.isTTY !== true)) return loaded(undefined);

  // Not wrapped: the CLI's IOs already refuse a secret as the contract's auth class, so a caller with no terminal
  // to type one on exits on that code rather than on a generic failure.
  const where = row?.keyConsole !== undefined ? `\n${row.keyConsole}` : "";
  const skip = ask.noSolari === "offer" ? `\nEnter with nothing skips the cloud: ${THIS_COMPUTER} alone becomes your workspace, and nothing is sealed.` : "";
  // The variable is said once, on the line that says where a key goes so this screen is not drawn again.
  let why = refusedSaved ?? `No ${keyEnv} in ${KEY_LAYER_WORDS}.`;
  let key: string;
  for (let attempt = 1; ; attempt++) {
    const typed = (await io.askSecret(`${row?.keyName ?? keyEnv}\n${why}${where}${skip}`, keyEnv)).trim();
    if (!typed) {
      if (ask.noSolari === "offer") return loaded(undefined);
      throw authRefusal(`${keyEnv} is needed to start.`);
    }
    // Checked before it is written, so a key the provider refuses never reaches the file the whole setup reads.
    const refused = await refusalOf(typed, false);
    if (refused === undefined) {
      key = typed;
      break;
    }
    if (attempt >= KEY_TRIES) throw authRefusal(refused);
    why = refused;
  }
  const set: Record<string, string> = { [keyEnv]: key };

  if (anthropic === undefined && ask.anthropic) {
    const typed = (
      await io.askSecret("Anthropic API key\noptional, enter skips\nOn a Claude subscription, skip this and sign in with /login on the machine instead.", ANTHROPIC_KEY)
    ).trim();
    if (typed) {
      anthropic = typed;
      set[ANTHROPIC_KEY] = typed;
    }
  }

  if ((await io.ask(saveQuestion(sources.home, Object.keys(set).length))) === "yes") writeEnvFile(homeEnv, set);
  return loaded(key);
}

/** The agents' keys as the environment and the files hold them now, asking nothing: what a serving host reads when
 * the init job asks, and where loadKeys starts before it asks. */
export function keysFound(sources: KeySources = keySources(), layers: Array<Record<string, string | undefined>> = keyLayers(sources)): Keys {
  const anthropic = layers.map(l => keyIn(l, ANTHROPIC_KEY)).find(v => v !== undefined);
  return anthropic !== undefined ? { anthropic } : {};
}

/** Names the file only when WSP_HOME moved it off the default. */
export function saveQuestion(home: string, keys: number): string {
  const what = keys > 1 ? "keys" : "key";
  return home === DEFAULT_HOME ? `Save the ${what} so wsp stops asking?` : `Save the ${what} to ${join(home, ".env")} so wsp stops asking?`;
}

/** What every golden wsp init seals is made of: the harness install and its
 * smoke from the doctor, the daemon bundle deploy, and the loaded keys as envs. */
export function goldenRecipe(
  keys: Pick<Keys, "anthropic">,
  hooks: { deployDaemon?: (machine: Machine) => Promise<void | string> } = {},
): GoldenRecipe {
  return {
    setup: GOLDEN_SETUP,
    smoke: GOLDEN_SMOKE,
    envs: claudeEnvs(keys.anthropic),
    deployDaemon: hooks.deployDaemon ?? (async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE)),
  };
}

/** The state a `.env` beside the code marks: a dev checkout shares its `.wsp` state with wspx. One spelling of the
 * rule, since the bin and the desktop both apply it. */
export function devCheckoutState(cwd: string): string | undefined {
  return existsSync(join(cwd, ".env")) ? join(cwd, ".wsp", "state.json") : undefined;
}

/** A path as the file system knows it, so one folder reached by two names (/tmp and /private/tmp on a Mac) is not
 * read as two states. Where nothing has made the file or its folder yet, the path as written is all there is. */
function realState(path: string): string {
  const dir = dirname(path);
  if (existsSync(path)) return realpathSync(path);
  return existsSync(dir) ? join(realpathSync(dir), basename(path)) : path;
}

/** Which state a line runs against, and what a person should be told about the choice. */
export interface StatePick {
  path: string;
  /** The one line stderr gets when a state the person named passed over a .env beside the code. */
  note?: string;
}

const passedOverLine = (chosen: string, by: string, cwd: string, dev: string): string =>
  `this runs against ${chosen}, named by ${by}; the .env in ${cwd} marks ${dev}, which this run does not use.`;

/** The state file a run works on. A state the person chose wins: --state first, then WSP_HOME, since a state
 * somebody named is never taken off them by a file they did not name, and the choice is said out loud when a .env
 * beside the code named another. A .env marks a dev checkout only when nothing else names a state, and anywhere
 * else it is the home whose host is serving, so a line typed with no flags on a computer whose host runs under a
 * moved home reaches that host rather than a state file nothing serves. */
export function statePick(flag?: string, cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): StatePick {
  const dev = devCheckoutState(cwd);
  const home = homeNamed(env["WSP_HOME"]);
  const named = flag !== undefined ? { path: flag, by: "--state" } : home !== undefined ? { path: join(home, "state.json"), by: "WSP_HOME" } : undefined;
  if (named === undefined) return { path: dev ?? join(servingHome(env), "state.json") };
  if (dev === undefined || realState(resolve(cwd, dev)) === realState(resolve(cwd, named.path))) return { path: named.path };
  return { path: named.path, note: passedOverLine(resolve(cwd, named.path), named.by, cwd, dev) };
}

/** The state file a run that names none works on. */
export function defaultStatePath(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  return statePick(undefined, cwd, env).path;
}

/** The state file a command works on, absolute so the lock, the token and the recipe beside it name one path
 * whatever the cwd is; a caller with somewhere to say it hears which state won where two readings disagreed. */
function statePathFrom(flag?: string, env: Readonly<Record<string, string | undefined>> = process.env, note: (line: string) => void = () => {}): string {
  const pick = statePick(flag, process.cwd(), env);
  if (pick.note !== undefined) note(pick.note);
  return resolve(pick.path);
}

/** The folder every turn and every exec on this computer starts in, made when it is first used. Not the person's
 * home: a turn that starts there is one `cd` from the checkouts they work in themselves, and the first build thread
 * run on a local workspace committed inside the person's own repo from there (measured 2026-09-08). Their own
 * folders stay reachable, as they are to any shell they open, but nothing starts a turn in one. */
export const localWorkFolder = (home: string): string => join(home, "wsp-work");

/** How this host starts the daemon for its local workspace. Behind a parameter so a test can hand one that refuses
 * to start; the default loads the daemon module on the first dial, so a host nobody opens a pane on loads none of it. */
export type LocalDaemonStart = (opts: LocalDaemonOptions) => Promise<LocalDaemon>;

/** This computer as a workspace: the local backend, a real child process per turn under the turn's limits, each
 * harness's own store (the one their store variable names, else the default under the person's home), and the
 * person's own login environment for every turn, the same one wsp exec runs under, so the keys and tools a terminal
 * gives an agent reach it here too. The adapters strip their own agent-session variables from it, as they do on a
 * fork. The person's home and the folder work starts in are two facts: the stores are theirs, so a sign-in they
 * made is the one a turn uses, and the work folder is the workspace's own. */
export function localWiring(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, startDaemon: LocalDaemonStart = opts => import("./local-daemon.js").then(m => m.LocalDaemon.start(opts))): LocalWiring {
  const root = localWorkFolder(home);
  // The person whose sign-ins a turn here reads. Their login home, except under a harness serving a fixture out of
  // a home of its own: that home holds this host's files, and a turn started under it finds no sign-in at all.
  const person = homeNamed(env[PERSON_HOME_ENV]) ?? home;
  let shutting = false;
  const backend = new LocalBackend({ root, env });
  // Started on the first dial and kept: a host nobody opens a pane on starts no process, binds no port on this
  // computer and writes none of the daemon's own files under the person's home.
  const daemon = startOnce(
    () => startDaemon({ root: home, workFolder: backend.workFolder() }),
    why => `the daemon for this computer's workspace did not start, so its terminal, files and processes have nothing to dial: ${why}`,
  );
  return {
    backend,
    execStream: (o, waiting) => localExecStream({ root: backend.workFolder(), ...o }, waiting),
    home: id => agentHome(person, id, env),
    homeDir: home,
    env: () => ({ ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)), HOME: person }),
    sysSamples: async fn => (await daemon.get()).sysSamples(fn),
    daemonRoad: async () => {
      // The panes stay on the person's home: the files and terminal tabs are theirs to look around in, where a
      // turn's own folder is the workspace's.
      const started = await daemon.get();
      // A dial that lands while the host is closing must leave no socket behind: a listening one keeps this process up.
      if (shutting) {
        await started.close().catch(() => {});
        throw new Error("this host is closing; its local workspace has no daemon to dial");
      }
      return started.road;
    },
    close: async () => {
      shutting = true;
      const started = daemon.held();
      daemon.forget();
      // A turn here leads a process group of its own, so it no longer goes with the terminal's Ctrl-C: this host is
      // the only thing that knows where its turns are, and nothing can re-open one once it is gone.
      await endLocalRuns();
      await started?.then(d => d.close(), () => {});
    },
  };
}

/** The machines this computer reaches over ssh: the ssh client here dials them with the person's own key, and one
 * dial both proves a machine answers and reads what its record stands on. A record's id is the whole address, so
 * nothing is kept between dials but the forwards, which are children of this host and go with it.
 *
 * The daemon on such a machine is put under the login it answered with and binds that machine's own loopback, so
 * nothing there listens where the network can reach it; the road to it is a port on this computer carried over
 * ssh, one child per machine and reused by every dial. */
export function sshWiring(forwards = new SshForwards()): SshWiring {
  const backend = new SshBackend();
  const reachOf = (machine: Machine): SshReach => {
    const reach = sshReachOf(machine);
    if (reach === undefined) throw new Error(`${machine.id} is not a machine this host reaches over ssh`);
    return reach;
  };
  return {
    backend,
    adopt: async (address, opts) => {
      const reach = parseSshAddress(address, opts);
      const { machine, login, shape, hostKey } = await backend.adopt(reach);
      return {
        machine,
        name: sshMachineName(reach),
        login,
        shape,
        // What the machine is, as the key this client holds for it says, so the same machine under another address,
        // port or key is the workspace it already is; a client holding no entry for it leaves the record on its
        // address alone.
        ...(hostKey !== undefined ? { identity: sshIdentity(hostKey, login.USER), hostKey } : {}),
      };
    },
    deployDaemon: async (machine, login) => deployDaemon(machine, { place: sshDaemonPlace(login) }).then(() => DAEMON_DEPLOYED_LINE),
    forward: (machine, remotePort) => forwards.forward(machine.id, reachOf(machine), remotePort),
    removeDaemon: (machine, login) => removeDaemon(machine, sshDaemonPlace(login)),
    dropForward: machine => forwards.drop(machine.id),
    close: () => forwards.close(),
  };
}

/** Everything a person asked a host to serve with: the port pair and the address the one rule read off the flags,
 * the state file, and the words that only a serving host reads. `wsp up --service` writes its unit out of this, so
 * what the service starts is the line that was typed. */
export interface ServeAsked extends ListenAsked {
  statePath: string;
  /** The address the person named with --advertise, as they named it: the address every machine dials this host
   * at, whatever kind it is. Absent leaves each kind to answer for its own machines, which is the default, so only
   * a word the person typed is spelled back into a service's unit. */
  advertise?: string;
  /** The machine provider this host forks on, as `--provider` named it. */
  provider?: string;
  /** The Docker daemon this host dials, as `--docker-host` named it. */
  dockerHost?: string;
  /** Whether a box linked to a relay runs its connector; false is `--no-relay`. */
  relay?: boolean;
}

/** A flag of the line a host serves on: how the shared parse reads it, and the words it is spelled back as. The
 * parse and the service's unit both come out of this one table, so a flag that shapes a serving host cannot reach a
 * terminal run and be dropped by the service that was asked for the same line. */
interface ServeFlag {
  /** The flag's word, which is a key of the shared parse: a row cannot name one the parse would not read. */
  name: Extract<keyof SharedFlags, string>;
  option: Options[string];
  words(asked: ServeAsked): string[];
}

export const SERVE_FLAGS: readonly ServeFlag[] = [
  { name: "state", option: { type: "string" }, words: a => ["--state", a.statePath] },
  { name: "port", option: { type: "string" }, words: a => ["--port", String(a.port)] },
  { name: "ws-port", option: { type: "string" }, words: a => ["--ws-port", String(a.wsPort)] },
  { name: "listen", option: { type: "string" }, words: a => ["--listen", a.address] },
  { name: "advertise", option: { type: "string" }, words: a => (a.advertise === undefined ? [] : ["--advertise", a.advertise]) },
  { name: "provider", option: { type: "string" }, words: a => (a.provider === undefined ? [] : ["--provider", a.provider]) },
  { name: "docker-host", option: { type: "string" }, words: a => (a.dockerHost === undefined ? [] : ["--docker-host", a.dockerHost]) },
  { name: "no-relay", option: { type: "boolean" }, words: a => (a.relay === false ? ["--no-relay"] : []) },
];

/** The serving flags as the parser takes them. */
const SERVE_OPTIONS: Options = Object.fromEntries(SERVE_FLAGS.map(flag => [flag.name, flag.option]));

/** What every command of the shared parse works on: what was asked of a serving host, the home the hosts file sits
 * under, and the environment the run was made in. wsp up and wsp init take theirs from this one call. */
export interface SharedOpts extends ServeAsked {
  home: string;
  /** The environment this run picks its machine provider out of: the one the caller runs in, with the provider
   * words the command line was given in front of it. */
  providerEnv: ProviderEnv;
  /** The environment the caller runs in, as given: what reads WSP_HOST and the pair a turn's launch left, so a
   * command decides where a line is aimed from the run's own environment rather than this process's. */
  env: Readonly<Record<string, string | undefined>>;
}

/** The environment the caller runs in decides the home, the same reading the verbs take, so a run with its own
 * environment cannot send wsp host connect to one folder and --host to another. It is also what the provider words
 * stand in front of, so one run picks its folder and its provider out of the same environment. */
export function optsFor(
  values: Pick<SharedFlags, "port" | "ws-port" | "listen" | "advertise" | "state" | "provider" | "docker-host" | "no-relay">,
  env: Readonly<Record<string, string | undefined>> = process.env,
  note: (line: string) => void = () => {},
): SharedOpts {
  const asked = portsAsked({ port: values.port, wsPort: values["ws-port"], listen: values.listen });
  const advertise = advertiseWord(values.advertise);
  const provider = {
    ...(values.provider !== undefined ? { provider: values.provider } : {}),
    ...(values["docker-host"] !== undefined ? { dockerHost: values["docker-host"] } : {}),
  };
  return {
    ...asked,
    ...(advertise !== undefined ? { advertise } : {}),
    ...provider,
    ...(values["no-relay"] === true ? { relay: false } : {}),
    statePath: statePathFrom(values.state, env, note),
    home: wspHome(env),
    env,
    providerEnv: providerEnvWith(provider, env, keyLayers({ env, cwd: process.cwd(), home: wspHome(env) })),
  };
}

/** The state files a host on this computer could be serving: the one this run works on and this computer's default,
 * read so a port one of them holds is named as that host rather than as a bare node process. */
export function statesHere(statePath: string): string[] {
  return [...new Set([statePath, resolve(defaultStatePath())])];
}

/** The provider slot each runtime made here was wired with, so a host can swap the module in when a key is saved. */
const PROVIDER_SLOTS = new WeakMap<Runtime, ProviderSlot>();
/** The provider pick each runtime made here stands on: the module it forks on now, which names the place its copies
 * are filed under, and the environment that module was picked out of, which is also where the other places this
 * host can build at are read from. A swap moves both, so the backend, the place and the table never say different
 * things. */
const PROVIDER_PICKS = new WeakMap<Runtime, ProviderPick>();
interface ProviderPick {
  id: string;
  env: ProviderEnv;
}
export const providerSlotOf = (rt: Runtime): ProviderSlot | undefined => PROVIDER_SLOTS.get(rt);

/** Wires the provider module the keys now on this computer name into a runtime made here, picking out of the same
 * environment that runtime was built from; a runtime made elsewhere has no slot, and a saved key it would do
 * nothing with is refused rather than taken. The saved record stands in front of that environment on purpose: this
 * is the road the app's keys step takes, where the key just written is the answer and the shell the host started in
 * is the older one. Every other road reads the layers, where the environment wins. */
export function swapProvider(rt: Runtime, keys: Readonly<Record<string, string | undefined>>): void {
  const slot = providerSlotOf(rt);
  if (slot === undefined) throw new Error("this runtime has no provider slot; a key saved now would reach no machine road until the host restarts");
  // One environment for all three: the module this host forks on, the place its copies are filed under and the
  // other places it can build at are the same pick, so they cannot drift apart when a key is saved.
  const pick = PROVIDER_PICKS.get(rt);
  const env = { ...(pick?.env ?? process.env), ...keys };
  slot.swap(providerBackendFor(env));
  if (pick !== undefined) {
    pick.id = wiredProviderId(env);
    pick.env = env;
  }
}

/** What a host serving this line tells a turn about where it answers: the address and port it binds, and the
 * address the person named with --advertise. The kind of the machine a turn runs on picks from it. */
const agentsReachOf = (opts: { address?: string; port: number; advertise?: string }): { at: { address: string; port: number }; advertise?: string } => ({
  at: { address: opts.address ?? LOOPBACK, port: opts.port },
  ...(opts.advertise !== undefined ? { advertise: opts.advertise } : {}),
});

export function makeRuntime(
  keys: Keys,
  statePath: string,
  recipe: GoldenRecipe = goldenRecipe(keys),
  env: ProviderEnv = process.env,
  agents?: { at?: { address: string; port: number }; advertise?: string; run?: RunningWsp },
): Runtime {
  const slot = providerSlot(providerBackendFor(env));
  // The place this host's copies are filed under is the provider module it forks on, read at each call: a host that
  // starts with no key swaps its module in when one is saved, and its copies belong to the module that made them.
  const pick: ProviderPick = { id: wiredProviderId(env), env };
  const rt = createRuntime({
    places: providerPlaces(
      () => pick.id,
      slot.backend,
      () => pick.env,
    ),
    backend: slot.backend,
    // What a turn's own agent needs to reach back in: what this host knows about where it answers, which each kind
    // reads for its own machines, and the same wsp command an agent's config on this computer is given, so a thread
    // on the local workspace and one on a fork run the same wsp against the same host.
    agents: {
      ...(agents?.at !== undefined ? { reach: hostReach(agents.at, agents.advertise, () => publicHostname(statePath)) } : {}),
      wspMcp: mcpServerCommand(agents?.run ?? runningWsp()),
    },
    local: localWiring(),
    ssh: sshWiring(),
    placeLinks: placeWiring(statePath, env),
    store: jsonFileStore(statePath),
    adapters: HARNESS_ADAPTERS,
    goldenRecipe: recipe,
    copyRecipe: hostCopyRecipe(statePath),
    hostId: hostIdentity(),
    vaultCaches: CACHE_RULE,
  });
  PROVIDER_SLOTS.set(rt, slot);
  PROVIDER_PICKS.set(rt, pick);
  return rt;
}

/** How a copy of the image is planned on this computer for a serving host: the same readers wsp init builds from,
 * the keys as they stand at the ask rather than at the start, and the daemon deploy every build made here gets. */
function hostCopyRecipe(statePath: string): (image: SealedImage) => Promise<GoldenRecipe> {
  return image =>
    copyGoldenRecipe(image, {
      collect: () => collectThisComputer(() => {}),
      brew: () => readBrewTable(nodeHost()),
      home: homedir(),
      platform: hostPlatform(),
      statePath,
      agentKeys: agentKeyEnvs(keysFound()),
      deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE),
    });
}

/** The init job on this computer for a serving host: wsp init's own readers and build pieces, the keys read off the
 * wsp home's .env alone at each ask (a key in this process's environment or a checkout's .env is the terminal's and
 * never reads as saved on a screen), the provider module swapped into the runtime once a key is saved, and the wsp
 * tools written by the road wsp mcp install takes, under the command this process runs as. */
function hostInitDoor(rt: Runtime, statePath: string, run: RunningWsp, openUrl: UrlOpener, log: (line: string) => void, providerEnv: ProviderEnv): InitJobs {
  const home = homedir();
  const os = hostPlatform();
  return new InitJobs({
    rt,
    statePath,
    home,
    platform: os,
    saved: () => savedEnv(wspHome()),
    saveKeys: set => writeEnvFile(join(wspHome(), ".env"), set),
    provider: saved => swapProvider(rt, saved),
    keysHeld: saved => Object.fromEntries(Object.entries(providerKeyRows()).map(([id, name]) => [id, keyIn(saved, name) !== undefined])),
    keySet: (key, provider) => providerKeySet(providerEnv, key, provider),
    keyProvider: () => providerKeyRow(providerEnv)?.id,
    checkKey: (key, provider) => checkProviderKey(providerBackendFor(providerEnvWithKey(providerEnv, key, provider))),
    // What this host's own provider charges and gives, not one provider's table: a host that forks containers has
    // no bill and no disk cap, and the screens read both off here.
    pricing: () => providerBackendFor(providerEnvNow(providerEnv)).pricing,
    agents: () => agentsHere(nodeHost(), { versions: false }),
    installTools: agents => installEach(agents, mcpServerSpec(statePath, run), home),
    mcpServer: () => mcpServerSpec(statePath, run),
    read: {
      collect: collectThisComputer,
      recipe: (onHistory, onProject, onHistoryProgress) => computeRecipe(nodeHost(), { threadAgents: THREAD_AGENTS, onHistory, onProject, onHistoryProgress, cache: historyCache(statePath) }),
      scanProject: async folder => {
        const { path, exists } = projectFolder(folder);
        return exists ? scanProject(nodeHost(), path) : undefined;
      },
      brew: () => readBrewTable(nodeHost()),
      scan: recipe => scanTools(nodeHost(), recipe),
    },
    build: {
      secrets: keychainReader(),
      relay: async (buildRt, builder, hooks) =>
        startCallbackRelay({
          runtime: buildRt,
          openUrl,
          log: line => {
            if (!hooks.onLine(line)) log(line);
          },
          autoOpen: hooks.autoOpen,
          openLine: hooks.openLine,
          builder,
        }),
      roads: () => workspaceRoads(rt, agentHomes(home), workspaceEnvsFor(keysFound())),
      recipe: recipe => ({ ...recipe, deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE) }),
    },
  });
}

/** With --json stdout carries the objects alone, so every line the run says moves to stderr beside it. */
export function terminalInitIO(json = false): InitIO {
  const os = platform();
  return {
    input: process.stdin,
    output: json ? process.stderr : process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
    open: systemOpener(os),
    signals: process,
    exit: code => process.exit(code),
    ...(json ? { json: (record: Record<string, unknown>) => void process.stdout.write(`${JSON.stringify(record)}\n`) } : {}),
  };
}

/** The collector's ladder over this laptop; onRung lets the terminal count rows as each rung lands. */
function collectThisComputer(onRung: (rung: Rung, rows: number) => void): Promise<Manifest> {
  return collect(nodeHost(), { onRung });
}

/** The signals a serving host stops on. It is the only owner of them: nothing under it registers a handler of its
 * own, so no other listener can end this process while a close runs. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** What a stop needs of the process it is ending: where signals arrive and how it exits. The default is this
 * process; a test hands in its own, since a real signal would take the test runner with it. */
export interface StopProcess {
  on(signal: (typeof STOP_SIGNALS)[number], listener: () => void): unknown;
  exit(code: number): void;
}

/** Every way a host is told to go ends the same: the lock removed and this computer's turns ended. A turn leads a
 * process group of its own, so no signal arriving here reaches it and the close is what ends it, through the one
 * ender the wiring's own close calls. A hangup is one of these signals for that reason, and none of them is left to
 * node's default exit, which runs no close at all: a second signal, with a close still in flight, ends the turns
 * itself without their stop grace and exits at once, so a close that hangs can neither trap the terminal nor leave
 * a harness running on this computer. */
export function stopOnSignals(handle: HostHandle, io: CliIO, self: StopProcess = process): void {
  let stopping: Promise<void> | undefined;
  const stop = (sig: (typeof STOP_SIGNALS)[number]): void => {
    if (stopping !== undefined) {
      void endLocalRuns(0).then(() => self.exit(exitCodeOf(sig)));
      return;
    }
    stopping = handle.close().then(
      () => self.exit(0),
      (e: unknown) => {
        io.error(`host close failed: ${e instanceof Error ? e.message : String(e)}`);
        // A close that failed may not have reached the turns; where it did, the set is empty and this ends nothing.
        void endLocalRuns(0).then(() => self.exit(1));
      },
    );
  };
  for (const sig of STOP_SIGNALS) self.on(sig, () => stop(sig));
}

/** A folder a `~/`-relative answer or a flag named: where it is, and whether there is one there. The one place both
 * the flag and the wizard's own question resolve a folder. */
export function projectFolder(folder: string): { path: string; exists: boolean } {
  const path = resolve(expand({ home: homedir() }, folder.trim()));
  return { path, exists: existsSync(path) };
}

/** What a --project flag named: the folder, nothing when the flag was not given, or the sentence to print, since a
 * folder that is not there is a typo and not an empty project. */
type ProjectFlag = { ok: true; path?: string } | { ok: false; message: string };

function projectFlag(verb: string, folder: string | undefined): ProjectFlag {
  if (folder === undefined) return { ok: true };
  const { path, exists } = projectFolder(folder);
  return exists ? { ok: true, path } : { ok: false, message: `wsp ${verb}: no folder at ${path}` };
}

/** One state file has one writer, and while a host serves it that writer is the host: a run beside one asks its
 * screens here and builds through the host's init job. This is what is left when that door cannot take the build,
 * and it names the road that needs no pid first, since the host on a box is a service nobody can Ctrl-C. */
function initRefusal(lock: HostLock, statePath: string, why: string): string {
  return `wsp init: the wsp host serving ${statePath} (pid ${lock.pid}) cannot take this build: ${why}. Take it down first (wsp down for a service, Ctrl-C in its terminal or kill ${lock.pid} for one started by hand), run wsp init again and start it again, or point --state at a different file.`;
}

/** A serving host whose provider forks nothing: its init job would refuse at the first stage, so the run says so
 * before it reads this computer. The provider is the host's, not this terminal's: it is the process that builds. */
function noGoldenThroughHost(lock: HostLock, statePath: string): string {
  return `wsp init: the wsp host serving ${statePath} (pid ${lock.pid}) forks no machines, so there is no golden to build through it. Give that host a provider (its provider's key in the environment it starts with, or wsp up --provider) and run wsp init again.`;
}

/** What the run reads off the host serving this state before it asks anything: the door to build through, what that
 * host's provider charges for the builder, and where the app it already serves answers. */
interface BesideHost {
  client: HostClient;
  pricing: InitPricing;
  appUrl: string;
}

/** Opens the door of the host serving this state, or refuses with the way back that needs no pid. The price and the
 * builder disk come from that host: it owns the provider, so a terminal that named none (or another) still asks the
 * person about the machine the build will really boot. Its default size is the one every build here boots. */
async function besideHost(lock: HostLock, statePath: string): Promise<BesideHost> {
  const refuse = (why: string): Error => Object.assign(new Error(initRefusal(lock, statePath, why)), { kind: "conflict" });
  let client: HostClient;
  try {
    // The host holding this state file's lock and no other: WSP_HOST and the default alias aim a verb at another
    // computer, and the build belongs to the process that writes this file.
    // No starter is handed in: the lock was read before this call, and an init that started a host under itself
    // would be building through a host it is about to replace.
    client = await dialHost(statePath, { aim: { kind: "here" } });
  } catch (e) {
    throw refuse(e instanceof Error ? e.message : String(e));
  }
  try {
    const setup = InitSetup.parse((await client.request<{ setup: unknown }>("init.get")).setup);
    const job = setup.job;
    if (job !== null && !initJobOver(job.phase)) throw refuse(`a setup is already running there (${job.phase})`);
    if (setup.pricing === null) throw Object.assign(new Error(noGoldenThroughHost(lock, statePath)), { kind: "conflict" });
    const price = setup.pricing;
    return {
      client,
      pricing: { rateUsdPerHour: () => price.rateUsdPerHour, defaultSize: price.size, ...(price.builderDiskGb !== undefined ? { builderDiskGb: price.builderDiskGb } : {}) },
      appUrl: `http://${authority(dialAddress(lock), lock.port)}`,
    };
  } catch (e) {
    client.close();
    throw e;
  }
}

/** The --state a later command needs to find what this init wrote, only when the init was given one. */
const stateFlag = (opts: { statePath: string }, values: Pick<SharedFlags, "state">): string[] => (values.state !== undefined ? ["--state", shellQuote(opts.statePath)] : []);

/** The wsp up that serves what this init records: the serving flags off the one table the parse and the service's
 * unit are written out of, resolved as this run resolved them and quoted for a shell to take. Only the flags the
 * init was given, so the line names what the person said and defaults stay defaults. */
export function upCommandFor(asked: ServeAsked, values: SharedFlags): string {
  const words = SERVE_FLAGS.filter(flag => values[flag.name] !== undefined).flatMap(flag => {
    const [word, ...given] = flag.words(asked);
    // The flag's own word is wsp's; everything after it is the person's and is quoted for the shell that runs it.
    return word === undefined ? [] : [word, ...given.map(shellQuote)];
  });
  return ["wsp up", ...words].join(" ");
}

/** The wsp new that forks the first workspace from what this init records, against the host wsp up starts. */
export function forkCommandFor(opts: { statePath: string }, values: Pick<SharedFlags, "state">): string {
  return ["wsp new", FIRST_WORKSPACE, ...stateFlag(opts, values)].join(" ");
}

/** The envs a new workspace forks with: the Claude key's, when there is one. */
function workspaceEnvsFor(keys: Keys): { workspaceEnvs?: (golden: GoldenVersion) => Record<string, string> } {
  const anthropic = keys.anthropic;
  return anthropic !== undefined ? { workspaceEnvs: golden => claudeEnvs(anthropic, golden) } : {};
}

/** wsp init's flags that only mean something on the golden road, each with how it was given: the local road refuses
 * them rather than take them and do nothing. One row per flag, beside the table that parses them. */
const GOLDEN_FLAGS: readonly [string, (flags: { recipe?: string; project?: string; firstWorkspace?: string; importFolder?: string }) => boolean][] = [
  ["--recipe", f => f.recipe !== undefined],
  ["--project", f => f.project !== undefined],
  ["--first-workspace", f => f.firstWorkspace !== undefined],
  ["--import", f => f.importFolder !== undefined],
];

/** The build handed to the host serving this state: the workspace question is asked here, where the person is, and
 * everything from the first billed machine on happens in that host's job. Its own init job forks no workspace for
 * this computer, so the tick beside the question is not offered; wsp new <name> --on this computer is that road. */
async function handOffTo(beside: BesideHost, screen: InitIO, interactive: boolean, flags: { yes: boolean; firstWorkspace?: string; importFolder?: string }): Promise<number> {
  const step = await askFirst({
    interactive,
    unattended: !interactive,
    ...(flags.firstWorkspace !== undefined ? { name: flags.firstWorkspace } : {}),
    ...(flags.importFolder !== undefined ? { folder: resolve(flags.importFolder) } : {}),
    noLocal: true,
    platform: hostPlatform(),
    input: screen.input,
    output: screen.output,
  });
  const fork = typeof step === "symbol" ? undefined : step.fork;
  return buildBesideHost({ client: beside.client, io: screen, ...(fork !== undefined ? { fork } : {}), ...(flags.yes ? { yes: true } : {}), appUrl: beside.appUrl });
}

/** How a line that says this computer forks nothing offers the way out of it: the variable the row a key typed here
 * would be put to, and nothing at all where no row reads a key. */
function orSetTheKey(env: ProviderEnv): string {
  const name = providerKeyRow(env)?.keyEnv;
  return name === undefined ? "" : `, or set ${name} first`;
}

async function init(
  io: CliIO,
  opts: SharedOpts,
  flags: { yes: boolean; nonInteractive: boolean; json: boolean; noLocal: boolean; recipe?: string; project?: string; firstWorkspace?: string; importFolder?: string; upCommand: string; forkCommand: string },
): Promise<number> {
  if (flags.json && flags.yes) throw usageRefusal("wsp init: --json prints the sign-ins as they are handed to you, and --yes skips the sign-ins, so there would be nothing to print.", "Drop one of them.");
  await adoptLoginPath(line => io.log(line));
  const held = servingHost(opts.statePath);
  const flag = projectFlag("init", flags.project);
  if (!flag.ok) throw usageRefusal(flag.message, "Give --project a folder that is already here, or drop the flag and let the run ask.");
  const project = flag.path;
  // Under --json every line this run says, the host's own included, goes to stderr so stdout is the objects' alone.
  const say = flags.json ? jsonCliIO() : io;
  const screen = terminalInitIO(flags.json);
  // The objects --json prints are the build's own, and a build handed over is that host's run: its objects land on
  // its job, where wsp setup reads them, not on this stdout. Refused rather than printing an empty stream.
  if (held !== undefined && flags.json) {
    throw usageRefusal(`wsp init --json prints the build's own objects, and the host serving ${opts.statePath} (pid ${held.pid}) is what runs this build: its sign-ins and stages ride its own setup, which wsp setup --json reads.`, "Drop --json, or take that host down (wsp down) and run this again.");
  }
  // A host already serving this state file is the process that writes it and holds the provider, so this run asks
  // its screens and hands the build to that host. Read before the opening: a refusal here is the whole run, and it
  // reads better without a banner over it. Nothing is asked for a key: the host has the one that builds.
  const beside = held === undefined ? undefined : await besideHost(held, opts.statePath);
  opening(screen, { command: "init", version: VERSION, yes: flags.yes, statePath: opts.statePath });
  const { keys, env: providerEnv } =
    beside !== undefined ? { keys: keysFound(), env: opts.providerEnv } : await loadKeys(say, keySources(opts.providerEnv), { anthropic: false, noSolari: "offer", checkSaved: true });
  // A provider with no size to boot a builder on has no image to build, so the run makes this computer the workspace
  // and serves the app on it. Every flag about the golden is about a road this run does not take.
  if (beside === undefined && forksNoMachines(providerBackendFor(providerEnv).capabilities)) {
    if (flags.noLocal) throw usageRefusal(`wsp init: with no provider key ${THIS_COMPUTER} is all this run makes, so --no-local would leave it with nothing.`, `Drop it${orSetTheKey(providerEnv)}.`);
    // Every other flag is about a golden: what goes on the image, what forks from it and what lands on that fork.
    // This road builds no image, and the workspace it makes is this computer, whose files are already here.
    const aboutGolden = GOLDEN_FLAGS.filter(([, given]) => given(flags)).map(([name]) => name);
    if (aboutGolden.length > 0) {
      throw usageRefusal(`wsp init: with no provider key there is no image to build and nothing to fork, and ${THIS_COMPUTER} already has your files, so ${aboutGolden.join(", ")} would do nothing here.`, `Drop them${orSetTheKey(providerEnv)}.`);
    }
    const local = await runLocalInit(
      {
        yes: flags.yes,
        nonInteractive: flags.nonInteractive,
        statePath: opts.statePath,
        ports: { port: opts.port, wsPort: opts.wsPort, named: opts.named, states: statesHere(opts.statePath) },
        address: opts.address,
        upCommand: flags.upCommand,
        runtime: () => makeRuntime(keys, opts.statePath, goldenRecipe(keys), providerEnv, agentsReachOf(opts)),
        roads: rt => workspaceRoads(rt, agentHomes(homedir()), workspaceEnvsFor(keys)),
        host: (rt, ports) => hostFor(rt, keys, { ...opts, port: ports.port, wsPort: ports.wsPort, providerEnv }, say),
      },
      screen,
    );
    if (local.handle !== undefined) stopOnSignals(local.handle, say);
    return local.code;
  }
  // The socket the hand-off drives is closed on every road out of the run: node ends this process when the loop
  // drains, and one left open would hold the terminal after the last line.
  let result: InitResult;
  try {
    result = await runInit(
      {
        yes: flags.yes,
        nonInteractive: flags.nonInteractive,
        ...(flags.recipe !== undefined ? { recipeFile: resolve(flags.recipe) } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(flags.firstWorkspace !== undefined ? { firstWorkspace: flags.firstWorkspace } : {}),
        ...(flags.importFolder !== undefined ? { importFolder: resolve(flags.importFolder) } : {}),
        ...(flags.noLocal ? { noLocal: true } : {}),
        collect: collectThisComputer,
        recipe: (onHistory, onProject, onHistoryProgress) =>
          computeRecipe(nodeHost(), { threadAgents: THREAD_AGENTS, onHistory, onProject, onHistoryProgress, cache: historyCache(opts.statePath), ...(project !== undefined ? { folders: [project] } : {}) }),
        scanProject: async folder => {
          const { path, exists } = projectFolder(folder);
          return exists ? scanProject(nodeHost(), path) : undefined;
        },
        agentKeys: agentKeyEnvs(keys),
        pricing: beside?.pricing ?? providerBackendFor(providerEnv).pricing,
        statePath: opts.statePath,
        home: homedir(),
        secrets: keychainReader(),
        platform: hostPlatform(),
        brew: () => readBrewTable(nodeHost()),
        scan: recipe => scanTools(nodeHost(), recipe),
        runtime: recipe => makeRuntime(keys, opts.statePath, { ...recipe, deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE) }, providerEnv, agentsReachOf(opts)),
        ports: { port: opts.port, wsPort: opts.wsPort, named: opts.named, states: statesHere(opts.statePath) },
        address: opts.address,
        upCommand: flags.upCommand,
        forkCommand: flags.forkCommand,
        relay: async (rt, builder, hooks) =>
          startCallbackRelay({
            runtime: rt,
            openUrl: systemOpener(),
            log: line => {
              if (!hooks.onLine(line)) say.log(line);
            },
            autoOpen: hooks.autoOpen,
            openLine: hooks.openLine,
            builder,
          }),
        roads: rt => workspaceRoads(rt, agentHomes(homedir()), workspaceEnvsFor(keys)),
        host: (rt, ports) => hostFor(rt, keys, { ...opts, port: ports.port, wsPort: ports.wsPort, providerEnv }, say),
        ...(beside !== undefined ? { handOff: (o: { interactive: boolean }) => handOffTo(beside, screen, o.interactive, flags) } : {}),
      },
      screen,
    );
  } finally {
    beside?.client.close();
  }
  if (result.handle !== undefined) stopOnSignals(result.handle, say);
  return result.code;
}

export interface ServeOptions {
  port: number;
  wsPort: number;
  /** The address the host binds; this computer alone when absent. */
  address?: string;
  /** The address the person named with --advertise: every machine dials this host there, whatever kind it is.
   * Absent leaves each kind to answer for its own machines, which is where a turn's address comes from by
   * default, and a host no kind can reach hands its turns no token. */
  advertise?: string;
  statePath: string;
  /** What this host picks its machine provider out of; this process's own environment when the caller names none. */
  providerEnv?: ProviderEnv;
  webDir?: string;
  runtime?: Runtime;
  openUrl?: UrlOpener;
  /** Whether a box linked to a relay runs its connector; false is `wsp up --no-relay`. */
  relay?: boolean;
  /** How this process was started, which the init job's wsp tools install writes into an agent's config; the
   * desktop hands in its shim, the npm command the default reading. */
  running?: RunningWsp;
}

/** The road the desktop window brings a host up on, which is wsp up's: the state file it serves is one wsp init
 * wrote, so a computer with no provider key serves the machines it does have rather than being asked for one by a
 * window that can ask nothing. */
export async function serve(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  await adoptLoginPath(line => io.log(line));
  const { keys, env: providerEnv } = await loadKeys(io, keySources(opts.providerEnv), { anthropic: false, noSolari: "local" });
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath, goldenRecipe(keys), providerEnv, { ...agentsReachOf(opts), ...(opts.running !== undefined ? { run: opts.running } : {}) });
  return hostFor(rt, keys, { ...opts, providerEnv }, io, opts.running);
}

/** Whether the state has anything for the app to show: a sealed golden to fork from, or any workspace record, this
 * computer's included. One reading, asked by wsp up and by the desktop's first launch; what each does with the
 * answer is its own, since the app has onboarding screens to open and the command line records this computer and
 * serves at once. */
export async function servesNothing(rt: Runtime): Promise<boolean> {
  return goldenHead(await rt.golden.get()) === undefined && (await rt.workspaces.list()).length === 0;
}

export async function up(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  await adoptLoginPath(line => io.log(line));
  // A state file with nothing but this computer in it is served with no provider key: wsp init's local road is
  // what wrote it, and asking for a key to serve it would take that road away the next morning.
  const { keys, env: providerEnv } = await loadKeys(io, keySources(opts.providerEnv), { anthropic: false, noSolari: "local" });
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath, goldenRecipe(keys), providerEnv, { ...agentsReachOf(opts), ...(opts.running !== undefined ? { run: opts.running } : {}) });
  // A state with nothing in it is recorded, not refused: this computer becomes its own workspace the way the app's
  // first launch records it, so a machine the host was just installed on serves and listens for pairing at once.
  // Found or made, the shape the app's own road takes, so the three roads that record this computer read alike and
  // a runtime that already holds one is never asked for a second.
  if (await servesNothing(rt)) {
    const workspace = (await rt.workspaces.list()).find(isLocalWorkspace) ?? (await rt.workspaces.createLocal());
    io.log(thisComputerLine(workspace.name, workspace.id));
  }
  return hostFor(rt, keys, { ...opts, providerEnv }, io, opts.running);
}

/** What a host with no Claude key says as it starts. A host that forks machines gives each fork the key as an env,
 * so a missing one is a fork with no credentials; a host that forks none runs its turns under the person's own
 * login and their harness's own store, where the sign-in they already made is the one a turn uses. */
export function noClaudeKeyNote(forksNothing: boolean): string {
  const what = forksNothing ? "a thread on this computer signs in as your own agents do" : "new workspaces fork without claude credentials";
  return `note: no ANTHROPIC_API_KEY found; ${what}`;
}

async function hostFor(
  rt: Runtime,
  keys: Keys,
  opts: {
    port: number;
    wsPort: number;
    address?: string;
    statePath: string;
    webDir?: string;
    openUrl?: UrlOpener;
    /** Whether a linked box runs its connector; false is `wsp up --no-relay`, which serves without a tunnel. */
    relay?: boolean;
    /** Required here, not defaulted: the host's runtime and its init door must pick a provider out of one
     * environment, and two defaults are two places for them to drift apart. */
    providerEnv: ProviderEnv;
  },
  io: CliIO,
  run: RunningWsp = runningWsp(),
): Promise<HostHandle> {
  const address = opts.address ?? LOOPBACK;
  const lockPath = lockPathFor(opts.statePath);
  const lock = takeLock(lockPath, opts.statePath, { port: opts.port, wsPort: opts.wsPort, address, ...(startedByVerb(process.env) ? { startedBy: "verb" as const } : {}) });
  // Read before the host serves a byte: a linked box is reachable from anywhere the moment its connector is up,
  // so the page it serves must carry no token even though it binds this computer alone. This follows the record
  // alone and not the flag: a connector an earlier run left behind carries the tunnel to this same port whatever
  // this run was asked for, and --no-relay stops that one rather than serving a token past it.
  const linked = readRelayRecord(opts.statePath) !== undefined;
  // A computer that already joined dials the port its place file names, so the door binds as this host starts
  // rather than waiting for somebody to open the Add a computer sheet again.
  const joined = (await rt.places?.list(Date.now()).catch(() => []))?.some(p => p.kind === "computer" && p.joinedAt !== undefined) === true;
  try {
    const handle = await startHost({
      runtime: rt,
      port: opts.port,
      wsPort: opts.wsPort,
      listen: address,
      beyondThisComputer: linked,
      door: joined ? "open" : "closed",
      doorLine: line => io.log(line),
      webDir: opts.webDir ?? webDirFor(),
      // Read at each fork, not once at start: the init job saves a key while this host serves.
      workspaceEnvs: golden => workspaceEnvsFor(keysFound()).workspaceEnvs?.(golden) ?? {},
      ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
      log: line => io.log(line),
      recipePath: recipePath(opts.statePath),
      statePath: opts.statePath,
      init: hostInitDoor(rt, opts.statePath, run, opts.openUrl ?? systemOpener(), line => io.log(line), opts.providerEnv),
    });
    writeFileSync(lockPath, JSON.stringify({ ...lock, port: handle.port, wsPort: handle.wsPort, address }));
    // Other local tools read the token from disk; the WS never sees it in a URL.
    const tokenPath = hostTokenPath(opts.statePath);
    writeFileSync(tokenPath, handle.authToken, { mode: 0o600 });
    const home = resolve(wspHome());
    const pointer = currentHomePointer();
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, `${home}\n`);
    // A skill copy an install wrote once falls behind the binary at the next release, and the agent reading it
    // calls verbs that are gone. Every start brings the copies that are there up to this wsp's, and writes none
    // where there is none.
    for (const file of refreshSkills(homedir())) io.log(`The wsp skill in ${file} now matches this wsp`);

    for (const line of addressLines(opts.statePath, { ...handle, address })) io.log(line);
    if (!isLoopback(address)) io.log(listenBeyondLoopbackLine(address));
    else if (linked) io.log(relayOnLoopbackLine());
    if (keys.anthropic === undefined) io.log(noClaudeKeyNote(forksNoMachines(rt.backend.capabilities)));
    // The tunnel carries to this host's own app port, so a box on loopback alone is still reachable through the
    // relay and nothing else about how it binds has to change.
    const relay = linked && opts.relay !== false ? await startRelay({ statePath: opts.statePath, port: handle.port, log: line => io.log(line) }) : undefined;
    if (linked && opts.relay === false) await stopRecordedConnector(dirname(opts.statePath));
    return {
      ...handle,
      close: async () => {
        await relay?.close();
        await handle.close();
        rmSync(lockPath, { force: true });
        // A host that started later owns the pointer now.
        if (currentHome() === home) rmSync(pointer, { force: true });
      },
    };
  } catch (e) {
    rmSync(lockPath, { force: true });
    throw e;
  }
}

/** What the service commands ask of this computer: which manager writes its units, how a manager's command is run
 * here, and how long a load or a stop is given before wsp stops waiting and says what it sees. Tests hand a fake
 * manager and a fake runner through the same three fields. */
export interface ServiceDeps {
  platform: string;
  manager: ServiceManager | undefined;
  run: ServiceRunner;
  waitMs: number;
  /** The layers a key is read from, so what a service can still read once the installing shell is gone is one
   * answer a test hands over rather than the folder the test runner happens to sit in. */
  keys: KeySources;
  /** Whether the host the lock names answers on its port. */
  answers: HostProbe;
  /** The one dial, for the status of a host on another computer: nothing on this computer says whether it is up. */
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  /** Asks the pid the lock recorded to end, for a host a verb started and no terminal holds. */
  stop(pid: number): void;
}

/** What wsp down says for a host a verb brought up: the same shape the service's own stop line takes. */
export const verbHostStoppedLine = (pid: number, statePath: string): string => `stopped the host a verb started (pid ${pid}); nothing serves ${statePath} now`;

export function systemService(): ServiceDeps {
  const os = platform();
  return { platform: os, manager: serviceManagerFor(os), run: systemRunner, waitMs: SERVICE_WAIT_MS, keys: keySources(), answers: httpProbe, dial: dialHost, stop: pid => process.kill(pid, "SIGTERM") };
}

/** Which service this is: one per state file, under this person's home and this user. */
function serviceAddress(statePath: string): ServiceAddress {
  return { statePath, home: homedir(), uid: process.getuid?.() ?? 0 };
}

/** The line the service runs: this node and this wsp, serving the state file, the ports, the address and the
 * provider the install was given. Every word is spelled out, since a service has no cwd of the person's to read a
 * default from and no shell of theirs to read a variable from. */
function serviceArgv(asked: ServeAsked): string[] {
  const bin = process.argv[1];
  if (bin === undefined) throw new Error("wsp up --service needs the path wsp was started from, and this process has none");
  return [process.execPath, resolve(bin), "up", ...SERVE_FLAGS.flatMap(flag => flag.words(asked))];
}

/** A host already holds the state file, so the service would only start a second one that refuses the lock. */
function serviceRefusal(lock: HostLock, statePath: string): string {
  return `wsp up --service: a wsp host (pid ${lock.pid}) is already serving ${statePath} on port ${lock.port}. Stop it first (Ctrl-C in its terminal, or kill ${lock.pid}), then run wsp up --service again.`;
}

/** Whether a key is in one of the two `.env` files, which is all a service can still read once the shell that
 * installed it is gone. The environment layer is that shell, so it does not count. */
function keyInAFile(name: string, sources: KeySources): boolean {
  return keyLayers(sources)
    .slice(1)
    .some(layer => (layer[name] ?? "") !== "");
}

/** Whether this shell is the only place a key is: a service starts without that shell, so a key nothing else holds
 * would be gone by then. A key no shell exported is not lost by a service; there is none, and on this computer that
 * is wsp init's local road, which serves with no provider at all. One reading for both keys. */
function onlyInThisShell(name: string, sources: KeySources): boolean {
  return keyIn(sources.env, name) !== undefined && !keyInAFile(name, sources);
}

/** The line saying this provider's key would be gone by the time the service starts, or nothing when a file holds
 * it, no shell does, or the provider this run is wired to reads no key. The variable is the row's own, so a service
 * installed for a provider added tomorrow is refused in that provider's words. */
export function keyOnlyInThisShell(sources: KeySources = keySources(), env: ProviderEnv = sources.env): string | undefined {
  const name = providerKeyRow(env)?.keyEnv;
  if (name === undefined || !onlyInThisShell(name, sources)) return undefined;
  return `wsp up --service: a service starts without your shell, so it reads its provider key from a file. ${name} is only in this shell's environment; put it in ${join(sources.home, ".env")} first.`;
}

/** The Claude key is not needed to serve, so it is a word rather than a refusal; without it every workspace the
 * service forks has no claude credentials, and the installing shell is the one place the reading looks complete. */
export function claudeKeyOnlyInThisShell(sources: KeySources = keySources()): string | undefined {
  if (!onlyInThisShell("ANTHROPIC_API_KEY", sources)) return undefined;
  return `note: ANTHROPIC_API_KEY is only in this shell's environment, so the service starts without it and the workspaces it forks get no claude credentials. Put it in ${join(sources.home, ".env")} to carry it over.`;
}

export async function upServiceCommand(io: CliIO, opts: ServeAsked, deps: ServiceDeps): Promise<number> {
  const manager = deps.manager;
  if (manager === undefined) {
    io.error(noManagerLine(deps.platform));
    return 1;
  }
  const held = servingHost(opts.statePath);
  if (held !== undefined) {
    io.error(serviceRefusal(held, opts.statePath));
    return 1;
  }
  await adoptLoginPath(line => io.log(line));
  const shellOnly = keyOnlyInThisShell(deps.keys, providerEnvWith(opts, deps.keys.env));
  if (shellOnly !== undefined) {
    io.error(shellOnly);
    return 1;
  }
  const claudeOnly = claudeKeyOnlyInThisShell(deps.keys);
  if (claudeOnly !== undefined) io.log(claudeOnly);
  const at = serviceAddress(opts.statePath);
  const logPath = hostLogPath(opts.statePath);
  const { unit, installed, failure } = await installService(manager, { ...at, argv: serviceArgv(opts), cwd: process.cwd(), env: serviceEnv(process.env), logPath }, deps.run);
  if (failure !== undefined) {
    io.error(`wsp up --service: ${runFailureLine(failure)}`);
    if (installed) io.error(`the ${manager.words} ${unit.name} is still there at ${unit.path}; wsp down takes it away.`);
    return 1;
  }
  const lock = await untilServing(opts.statePath, deps.waitMs, deps.answers);
  if (lock === undefined) {
    io.error(
      `the ${manager.words} ${unit.name} loaded, but nothing answered on port ${opts.port} for ${opts.statePath} within ${fmtDuration(deps.waitMs)}. Its log is ${logPath}, and wsp down takes the service away.`,
    );
    for (const line of logTail(logPath)) io.error(line);
    return 1;
  }
  io.log(`${manager.words} ${unit.name} is loaded; it serves again at every login`);
  for (const line of addressLines(opts.statePath, lock)) io.log(line);
  if (!isLoopback(opts.address)) io.log(listenBeyondLoopbackLine(opts.address));
  io.log(`log         ${logPath}`);
  const after = manager.afterLoad?.(at);
  if (after !== undefined) io.log(after);
  io.log("Stop it with wsp down.");
  return 0;
}

export async function downCommand(io: CliIO, opts: { statePath: string }, deps: ServiceDeps): Promise<number> {
  const manager = deps.manager;
  if (manager === undefined) {
    io.error(noManagerLine(deps.platform));
    return 1;
  }
  const at = serviceAddress(opts.statePath);
  const unit = manager.unit(at);
  // The manager is asked even with no unit file: a file somebody removed, or an install that took the file back,
  // still leaves the manager holding the service, and that is the one thing wsp down is for.
  const installed = existsSync(unit.path);
  const { held, unsure, failure } = await stopService(manager, at, deps.run);
  if (unsure !== undefined) {
    const stands = installed ? `Its unit file is still ${unit.path}; nothing was changed.` : "Nothing was changed.";
    io.error(`wsp down: ${runFailureLine(unsure)}, so wsp cannot tell whether the ${manager.words} ${unit.name} is still loaded. ${stands}`);
    return 1;
  }
  if (failure !== undefined) {
    io.error(`wsp down: ${runFailureLine(failure)}`);
    return 1;
  }
  if (!held && !installed) {
    const serving = servingHost(opts.statePath);
    // A host a verb started for itself is nobody's terminal to stop, so this is the one line that stops it: the pid
    // comes off the lock that host wrote, never off a search for a process that looks like it.
    if (serving?.startedBy === "verb") {
      deps.stop(serving.pid);
      const left = await untilLock(opts.statePath, false, deps.waitMs);
      if (left !== undefined) {
        io.error(`wsp down: the host a verb started (pid ${left.pid}) is still serving ${opts.statePath}.`);
        return 1;
      }
      io.log(verbHostStoppedLine(serving.pid, opts.statePath));
      return 0;
    }
    io.error(
      serving === undefined
        ? `wsp down: no ${manager.words} for ${opts.statePath}, and no host is serving it.`
        : `wsp down: no ${manager.words} for ${opts.statePath}; the host serving it (pid ${serving.pid}) was started by hand. Stop it with Ctrl-C in its terminal, or kill ${serving.pid}.`,
    );
    return 1;
  }
  const lock = await untilLock(opts.statePath, false, deps.waitMs);
  if (lock !== undefined) {
    io.error(`the ${manager.words} ${unit.name} is gone, but the host it started (pid ${lock.pid}) is still serving ${opts.statePath}.`);
    return 1;
  }
  io.log(`${manager.words} ${unit.name} stopped; nothing serves ${opts.statePath} now`);
  return 0;
}

export async function statusCommand(io: CliIO, opts: { statePath: string; state?: string } & HostPick, deps: ServiceDeps): Promise<number> {
  // The one line that leaves this computer only when a person named a host: --host or WSP_HOST and nothing else.
  // A verb has a host to speak to whatever the line said, so it follows the fallbacks under those two, the default
  // alias among them; this line is the question whether the host here is serving, and an alias answering for a box
  // would hide the one thing it was run to learn.
  const aim = namedHost(opts);
  if (aim !== undefined) {
    // The same note the verbs leave, in the same words: a line that named both a file here and a host over there
    // reads neither one from the other.
    if (opts.state !== undefined) io.error(stateIgnoredLine(aimName(aim)));
    // A host on another computer keeps its own lock and its own service manager, neither of which is a file here:
    // what this computer can say is where it answers and whether it did, which is one dial and nothing else. A road
    // that carried nothing is the reading; anything the host itself said stands as this line's own failure.
    const unreached = await deps.dial(opts.statePath, { aim }).then(
      client => {
        client.close();
        return undefined;
      },
      (e: unknown) => {
        if ((e as { kind?: unknown }).kind !== "unreachable") throw e;
        return e instanceof Error ? e.message : String(e);
      },
    );
    for (const line of hostThereLines(aimName(aim), aimAddress(aim), unreached)) io.log(line);
    return unreached === undefined ? 0 : 1;
  }
  const reading = await serviceReading(deps.manager, serviceAddress(opts.statePath), deps.run, deps.platform);
  const lock = servingHost(opts.statePath);
  const host = lock === undefined ? undefined : { lock, answering: await deps.answers(lock) };
  for (const line of statusLines(opts.statePath, host, reading)) io.log(line);
  return host?.answering === true ? 0 : 1;
}

/** The flags the shared parse reads; a command that answers on its own word (mcp, recipe) parses its own. */
interface SharedFlags {
  version?: boolean;
  help?: boolean;
  port?: string;
  "ws-port"?: string;
  listen?: string;
  advertise?: string;
  state?: string;
  yes?: boolean;
  "non-interactive"?: boolean;
  json?: boolean;
  recipe?: string;
  project?: string;
  "first-workspace"?: string;
  import?: string;
  "no-local"?: boolean;
  local?: boolean;
  service?: boolean;
  code?: string;
  "code-file"?: string;
  "ssh-port"?: string;
  "ssh-key"?: string;
  awake?: boolean;
  name?: string;
  relay?: string;
  host?: string;
  "no-relay"?: boolean;
  provider?: string;
  "docker-host"?: string;
}

/** What a word of the shared parse does with --host. `aimed`: the line runs against the host it names. `refused`:
 * the line reads this computer's own files, so the parse refuses the flag rather than take it and aim nowhere.
 * `hostSide`: the line runs at the host's own terminal, so it takes the flag and answers the one sentence that says
 * so, which is the same answer WSP_HOST and the default alias already get. */
export type HostFlag = "aimed" | "refused" | "hostSide";

interface Command {
  /** Which page it prints on, as every verb declares one. */
  page: Page;
  /** The shape of the line, as its own help prints it. */
  usage: string;
  /** One phrase on what it does, as every page prints it under the usage. */
  about: string;
  /** Whether stdout is objects under --json; a command without it refuses the flag rather than hand prose to whoever reads them. */
  json: boolean;
  /** What --host means for this word. One parse reads the flag for every word, so this is what keeps the ones that
   * have nothing to do with it from swallowing it, and what sends the two that run over there to their own line. */
  host: HostFlag;
  /** Why the MCP server has no tool for it. */
  cliOnly: string;
  run(io: CliIO, opts: SharedOpts, values: SharedFlags, args: string[]): Promise<number>;
}

/** What a command that reads where a line is aimed works on: the state file this run names, the home holding the
 * hosts folder, the environment the run was made in and the word --host gave. One reading for the three commands
 * that ask, so the flag cannot reach one of them and not another. */
function aimPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick {
  return { statePath: opts.statePath, home: opts.home, env: opts.env, ...(values.host !== undefined ? { host: values.host } : {}) };
}

/** The commands the shared parse serves, keyed by the words that select one. A line is matched against the longest
 * key whose words open it, as a verb's words select a verb, so the plumbing folded under `host` needs no second
 * dispatch of its own. */
const COMMANDS: Readonly<Record<string, Command>> = {
  up: {
    page: "agent",
    usage: "wsp up [--port <n>] [--ws-port <n>] [--listen <addr>] [--advertise <url>] [--provider <name>] [--docker-host <url>] [--no-relay] [--service]",
    about: "serve the host in this terminal, for a host you want to watch or one that serves beyond this computer; --service hands the same line to this computer's own service manager, which starts it now and again at every login. Every other line starts a host for itself when none serves",
    json: false,
    host: "refused",
    cliOnly: "starts the host on the person's computer; a tool runs against a host that is already up",
    run: async (io, opts, values) => {
      if (values.service === true) return upServiceCommand(io, opts, systemService());
      stopOnSignals(await up(io, opts), io);
      return 0;
    },
  },
  down: {
    page: "agent",
    usage: "wsp down",
    about: "stop the host: the service and its unit where one holds it up, and the host a verb started otherwise",
    json: false,
    host: "refused",
    cliOnly: "stops the service holding the host up on the person's computer, which a tool would be cutting the ground from under",
    run: (io, opts) => downCommand(io, opts, systemService()),
  },
  status: {
    page: "front",
    usage: "wsp status",
    about: "whether a host serves this state file, on which ports and what keeps it there, with a non-zero exit code when none does; --host reads a host on another computer instead",
    json: false,
    host: "aimed",
    cliOnly: "reads this computer's lock and service manager, or dials the host named beside it; a tool that answers at all is proof a host is up",
    run: (io, opts, values) =>
      statusCommand(io, { ...aimPick(opts, values), ...(values.state !== undefined ? { state: values.state } : {}) }, systemService()),
  },
  "host pair": {
    page: "host",
    usage: "wsp host pair",
    about: "a one time code another computer redeems for a token of its own, when the host listens beyond this computer",
    json: false,
    host: "hostSide",
    cliOnly: "hands out a code that lets another computer drive this host; only a person at the host's own terminal gives that away",
    run: (io, opts, values, args) => pairCommand(io, aimPick(opts, values), args),
  },
  "host devices": {
    page: "host",
    usage: "wsp host devices [revoke <id>]",
    about: "the computers paired with this host; revoke takes one back out",
    json: false,
    host: "hostSide",
    cliOnly: "lists and takes away the computers that may drive this host, which belongs with the terminal that handed them the code",
    run: (io, opts, values, args) => devicesCommand(io, aimPick(opts, values), args),
  },
  "host connect": {
    page: "host",
    usage: "wsp host connect <url> --code <code> [--name <alias>] [--relay <host>]",
    about: "redeem a code from a host on another computer for a token of this one's own; --name is what every later line calls that host, and --relay reaches it through your relay by the name it has there",
    json: false,
    host: "refused",
    cliOnly: "spends a pairing code and keeps the token it buys in this person's own files; where their wsp points is theirs to say",
    run: (io, opts, values, args) => connectCommand(io, opts, values, args),
  },
  "host list": {
    page: "host",
    usage: "wsp host list",
    about: "the hosts on other computers this computer holds, the default marked",
    json: false,
    host: "refused",
    cliOnly: "reads which host every line on this computer runs against, which no thread decides for the person",
    run: (io, opts, _values, args) => hostsCommand(io, opts, args),
  },
  "host default": {
    page: "host",
    usage: "wsp host default <alias>",
    about: "move which host every line on this computer runs against",
    json: false,
    host: "refused",
    cliOnly: "moves which host every line on this computer runs against, which no thread decides for the person",
    run: (io, opts, _values, args) => hostsCommand(io, opts, ["default", ...args]),
  },
  "host forget": {
    page: "host",
    usage: "wsp host forget <alias>",
    about: "hand that host its token back and forget it here",
    json: false,
    host: "refused",
    cliOnly: "hands a host back the token this computer drives it by, which belongs with the terminal that took it",
    run: (io, opts, _values, args) => disconnectCommand(io, opts, args),
  },
  "host link": {
    page: "host",
    usage: "wsp host link <url> [--name <name>]",
    about: "put this computer on your relay account, so it is reachable from anywhere with no port open to the world; it prints a code and a page to approve it on",
    json: false,
    host: "refused",
    cliOnly: "puts this computer on a person's relay account, which is theirs to give away",
    run: (io, opts, values, args) => relayCommand(io, opts, ["link", ...args], values),
  },
  "host unlink": {
    page: "host",
    usage: "wsp host unlink",
    about: "take this computer off the relay account and stop its tunnel",
    json: false,
    host: "refused",
    cliOnly: "takes this computer off a person's relay account and stops the tunnel, which belongs with the terminal that put it there",
    run: (io, opts, values, args) => relayCommand(io, opts, ["unlink", ...args], values),
  },
  "host linked": {
    page: "host",
    usage: "wsp host linked [<url>]",
    about: "the boxes on your relay account, from whichever computer you are at",
    json: false,
    host: "refused",
    cliOnly: "signs this person in to their relay and lists the boxes on their account, which no thread does for them",
    run: (io, opts, values, args) => relayCommand(io, opts, ["linked", ...args], values),
  },
  "host clients": {
    page: "host",
    usage: "wsp host clients [revoke <id>]",
    about: "which computers hold a token for your relay account; revoke signs one out",
    json: false,
    host: "refused",
    cliOnly: "reads and takes away the computers holding a token for this person's relay account, which belongs with the person whose account it is",
    run: (io, opts, values, args) => relayCommand(io, opts, ["clients", ...args], values),
  },
  init: {
    page: "front",
    usage: "wsp init [--recipe <path>] [--project <path>] [--first-workspace <name>] [--import <folder>] [--no-local] [--yes] [--non-interactive] [--json]",
    about: "seal this computer into your image, one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build. With no provider key it seals nothing and makes this computer your workspace instead. Beside a host already serving this state file the screens are the same and the build runs in that host",
    json: true,
    host: "refused",
    cliOnly: "builds the golden and serves for hours; an agent runs it from a shell and relays the sign-ins it prints",
    run: (io, opts, values) =>
      init(io, opts, {
        yes: values.yes === true,
        // --json has nobody to answer the screens: its objects are for whoever is driving the run.
        nonInteractive: values["non-interactive"] === true || values.json === true,
        json: values.json === true,
        noLocal: values["no-local"] === true,
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        ...(values.project !== undefined ? { project: values.project } : {}),
        ...(values["first-workspace"] !== undefined ? { firstWorkspace: values["first-workspace"] } : {}),
        ...(values.import !== undefined ? { importFolder: values.import } : {}),
        upCommand: upCommandFor(opts, values),
        forkCommand: forkCommandFor(opts, values),
      }),
  },
  add: {
    page: "front",
    usage: "wsp add [<provider>|user@host] [--name <name>] [--ssh-port <port>] [--ssh-key <path>]",
    about: "a place: user@host for a computer over ssh, <provider> for a provider, nothing for the join line another computer types",
    json: false,
    host: "hostSide",
    cliOnly: "hands out a code that lets another computer join this wsp, or takes a provider's key into this person's own files; both belong with the terminal the host runs at",
    run: (io, opts, values, args) =>
      addCommand(io, { ...aimPick(opts, values), providerEnv: opts.providerEnv }, args, addFlags(values.name, values["ssh-port"], values["ssh-key"])),
  },
  remove: {
    page: "front",
    usage: "wsp remove <place>",
    about: "take a place out; the agent, its files and the workspaces standing on it go, and the computer is left as wsp found it",
    json: false,
    host: "hostSide",
    cliOnly: "takes a computer out of this wsp and sweeps wsp off it, which belongs with the terminal that joined it",
    run: (io, opts, values, args) => removeCommand(io, aimPick(opts, values), args),
  },
  join: {
    page: "agent",
    usage: "wsp join <url>... --code <code> [--code-file <path>] [--name <name>] [--awake]",
    about: "on the computer you are sitting at: join it to the wsp at that address, then install the daemon under this computer's own service manager, which dials again at every login",
    json: false,
    host: "refused",
    cliOnly: "joins the computer it is typed on to somebody's wsp and keeps the key it proves itself with in this person's own files; where their computer belongs is theirs to say",
    run: (io, _opts, values, args) =>
      joinCommand(io, args, {
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values["code-file"] !== undefined ? { codeFile: values["code-file"] } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.awake === true ? { awake: true } : {}),
      }),
  },
  leave: {
    page: "agent",
    usage: "wsp leave",
    about: "on that computer: take wsp off it, for a computer whose host is gone and cannot run wsp remove",
    json: false,
    host: "refused",
    cliOnly: "sweeps wsp off the computer it is typed on, which belongs with the terminal that joined it",
    run: (io, _opts, _values, args) => leaveCommand(io, args),
  },
  doctor: {
    page: "dev",
    usage: "wsp doctor [--local] [--yes]",
    about: "run the reach loop end to end against one live machine; --local proves the other half instead, a thread on this computer and its reply, with no machine and no key",
    json: false,
    host: "refused",
    cliOnly: "forks a live machine and bills while it runs, or with --local runs a thread on this computer; a person decides that at a terminal",
    run: async (io, opts, values) => {
      await adoptLoginPath(line => io.log(line));
      // The local road touches no provider, so a missing key is not asked for: it is the whole of the doctor for a
      // person whose wsp init took the local road.
      if (values.local === true) {
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv), { anthropic: false, noSolari: "local" });
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(keys), env);
        try {
          return await localDoctor(rt, io);
        } finally {
          await rt.close();
        }
      }
      const { keys, env } = await loadKeys(io, keySources(opts.providerEnv));
      const rt = makeRuntime(keys, opts.statePath, goldenRecipe(keys), env);
      return doctor(rt, io, {
        ...(keys.anthropic !== undefined ? { envs: claudeEnvs(keys.anthropic) } : {}),
        ...(values.yes === true ? { yes: true } : {}),
        statePath: opts.statePath,
      });
    },
  },
};

/** What each line of the shared parse does with --host, the one fact the parse, its refusal and the usage table read. */
export const HOST_FLAG: Readonly<Record<string, HostFlag>> = Object.fromEntries(Object.entries(COMMANDS).map(([words, command]) => [words, command.host]));

/** The lines of the shared parse that run against a host somewhere else, the one fact its refusal reads. The two
 * that take the flag only to say they run at that host's own terminal are not among them: a person told to read
 * this list wants the words that answer for a host over there. */
export const HOST_COMMANDS: readonly string[] = Object.keys(HOST_FLAG).filter(w => HOST_FLAG[w] === "aimed");

/** Every line the shared parse serves, by its words: what a flag row names when it is read by all of them. */
export const SHARED_WORDS: readonly string[] = Object.keys(COMMANDS);

/** The table itself, for whatever reads a line's own help without running it. */
export const COMMANDS_FOR_HELP: Readonly<Record<string, Command>> = COMMANDS;

/** The word the plumbing folds under, and the lines it opens: one reading for the dispatch, the help and the
 * refusal that meets somebody who typed the word on its own. */
export const HOST_WORD = "host";
export const HOST_LINES: readonly string[] = Object.keys(COMMANDS).filter(w => w.startsWith(`${HOST_WORD} `));

/** The command a line of positionals selects: the longest key whose words open it, the same rule findVerb reads. */
function findCommand(words: readonly string[]): { words: string; command: Command } | undefined {
  const key = Object.keys(COMMANDS)
    .filter(k => k.split(" ").every((w, i) => words[i] === w))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : { words: key, command: COMMANDS[key]! };
}

/** The words that take --json on the shared parse and those that refuse it, the one fact the refusal and its test read. */
export const JSON_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => COMMANDS[w]!.json);
export const PROSE_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => !COMMANDS[w]!.json);

type Options = NonNullable<ParseArgsConfig["options"]>;

/** What else a package manager on this computer has, for the recipe verbs on both doors: the scanner reaches the
 * engine, so the command line hands it in rather than the verb table importing it. */
const alsoHere: VerbDeps["alsoHere"] = recipe => scanTools(nodeHost(), recipe);

/** The word `mcp` opens the command, as a verb's words open a verb: its flags are its own, so it is dispatched on
 * that word before the shared parse ever sees them. */
const MCP_COMMAND = "mcp";

/** The flags `wsp mcp` and `wsp mcp install` parse. */
export const MCP_OPTIONS: Options = {
  agent: { type: "string", multiple: true },
  host: { type: "string" },
  json: { type: "boolean" },
  remove: { type: "boolean" },
  state: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const mcpInstallUsage = (): string => `wsp ${MCP_COMMAND} install --agent <id> [--agent <id>] [--host <alias>] [--json] [--remove]   (${MCP_AGENT_IDS})`;
const mcpUsage = (): string => `usage: wsp ${MCP_COMMAND} [--host <alias>]\n       ${mcpInstallUsage()}`;

/** The usage of the command a line stopped short of, whether it is a verb, `mcp` or the word the plumbing folds
 * under; none when no command owns the word. `mcp` needs its own answer here because it is not in the verb table
 * and its flags follow the word. */
function commandUsage(word: string): string | undefined {
  if (word === MCP_COMMAND) return mcpUsage();
  if (word === HOST_WORD) return HOST_LINES.map(words => `usage: wsp ${words}`).join("\n");
  return verbUsage(word);
}

/** `wsp mcp` serves until the agent closes its stdin; `wsp mcp install --agent <id>` writes the agent's config,
 * once per `--agent` given, and answers with the lines or, with `--json`, the report as one line. Its flags are
 * parsed here rather than in the table every command shares, so a command that has no JSON to print refuses
 * `--json` instead of taking it and printing prose. */
async function mcp(io: CliIO, argv: string[], statePathOf: (flag?: string) => string, run: RunningWsp, env: Readonly<Record<string, string | undefined>>, starts: { start?: HostStarter }): Promise<number> {
  const usage = mcpUsage();
  let values: { agent?: string[]; host?: string; json?: boolean; remove?: boolean; state?: string; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({ args: argv, options: MCP_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), usage));
  }
  if (values.help === true) {
    io.log(usage);
    return 0;
  }
  const statePath = statePathOf(values.state);
  if (words.length === 0) {
    // The agent starts the server in its own folder, which is the folder a thread opened with no workspace is placed by.
    await serveMcp(statePath, { alsoHere, cwd: process.cwd(), env, ...starts, ...(values.host !== undefined ? { host: values.host } : {}) });
    return 0;
  }
  const json = values.json === true;
  if (words[0] !== "install" || words.length !== 1) return failed(io, json, usageRefusal(unknownWordLine(`${MCP_COMMAND} ${words.join(" ")}`), runForTheList(`wsp ${MCP_COMMAND} --help`)));
  // Nobody named an agent: at a terminal that is a line half typed, but an agent running this has no terminal to be
  // asked at, so every agent whose own command is on this computer's PATH takes it.
  const agents = values.agent ?? (io.isTTY === true ? [] : agentsOnPath(run.PATH));
  if (agents.length === 0) {
    const none =
      io.isTTY !== true
        ? "wsp mcp install: no agent of the catalog's is on this computer's PATH."
        : "wsp mcp install writes the config of the agents it is given, and was given none.";
    return failed(io, json, usageRefusal(none, `Name one with --agent.\n\nusage: ${mcpInstallUsage()}`));
  }
  const project = process.cwd();
  if (values.remove === true) {
    const gone = removeEach(agents, project);
    if (json) io.log(JSON.stringify(gone));
    else {
      for (const agent of gone.removed) for (const line of removeLines(agent)) io.log(line);
      for (const failed of gone.failures) io.error(`wsp mcp install: ${failed.error}`);
    }
    return gone.failures.length > 0 ? 1 : 0;
  }
  const report = installEach(agents, mcpServerSpec(statePath, run, values.host !== undefined ? { host: values.host } : {}), homedir(), project);
  if (json) io.log(JSON.stringify(report));
  else {
    for (const placed of report.installed) for (const line of installLines(placed)) io.log(line);
    const registered = registeredLine(report);
    if (registered !== undefined) io.log(registered);
    for (const failed of report.failures) io.error(`wsp mcp install: ${failed.error}`);
    const next = nextLine(report);
    if (next !== undefined) io.log(next);
  }
  return report.failures.length > 0 ? 1 : 0;
}

/** The flags the shared parse reads for up, init and doctor. The ones that shape a serving host come from the table
 * the service's unit is written out of, so neither road can read a flag the other has never heard of. */
export const SHARED_OPTIONS: Options = {
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  ...SERVE_OPTIONS,
  yes: { type: "boolean", short: "y" },
  "non-interactive": { type: "boolean" },
  json: { type: "boolean" },
  recipe: { type: "string" },
  project: { type: "string" },
  "first-workspace": { type: "string" },
  import: { type: "string" },
  "no-local": { type: "boolean" },
  local: { type: "boolean" },
  service: { type: "boolean" },
  code: { type: "string" },
  "code-file": { type: "string" },
  "ssh-port": { type: "string" },
  "ssh-key": { type: "string" },
  awake: { type: "boolean" },
  name: { type: "string" },
  relay: { type: "string" },
  host: { type: "string" },
};

const without = (options: Options, names: readonly string[]): Options => Object.fromEntries(Object.entries(options).filter(([name]) => !names.includes(name)));

/** The flags a line of the shared parse takes, read off the command that runs it: a line of two words or more is
 * selected by its first word, so it advertises exactly what that word's `json` and `host` say and never a list
 * written out beside it, which is how a flag added to the shared parse reached seven lines that refuse it. */
function optionsFor(words: string): Options {
  const found = findCommand(words.split(" "));
  if (found === undefined) throw new Error(`wsp ${words} is in the command lines and no command answers it`);
  const { command } = found;
  return without(SHARED_OPTIONS, [...(command.json ? [] : ["json"]), ...(command.host === "refused" ? ["host"] : [])]);
}

/** A line `wsp` answers: the words after `wsp` that select it, the shape of the line and one phrase on what it
 * does, the page it prints on, every flag it parses (anything else is a usage error), and its other door: the MCP
 * tool it is served as, or why it has none. */
export type CommandLine = { words: string; options: Options; page: Page; usage: string; about: string } & ({ tool: string } | { cliOnly: string });

/** Every line `wsp` answers, with the flags it takes and the page it prints on: what the pages, the skill's
 * examples and the MCP tools are all held to. */
export const COMMAND_LINES: readonly CommandLine[] = [
  ...CLI_VERBS.map(v => ({ words: v.name, usage: v.usage, about: v.about, page: v.page, options: { ...COMMON, ...v.options }, ...("cliOnly" in v ? { cliOnly: v.cliOnly } : { tool: toolName(v.name) }) })),
  { words: MCP_COMMAND, options: MCP_OPTIONS, page: "front" as const, usage: mcpUsage().replace(/^usage: /, ""), about: "serve the verbs as tools over stdio to an agent on this computer", cliOnly: "is the tool server itself" },
  {
    words: `${MCP_COMMAND} install`,
    options: MCP_OPTIONS,
    page: "agent" as const,
    usage: mcpInstallUsage(),
    about: `put the wsp tools, this skill and wsp's own section of this folder's AGENTS.md into that agent (${MCP_AGENT_IDS}); --agent repeats, --remove takes it back out, and --json prints what each agent took`,
    cliOnly: "writes an agent's own config and skills folder, which is done once from a shell",
  },
  ...Object.entries(COMMANDS).map(([words, command]) => ({ words, usage: command.usage, about: command.about, page: command.page, options: optionsFor(words), cliOnly: command.cliOnly })),
  // The two lines a word of the host page opens: they print inside their parent's usage, so they carry no page of
  // their own to print on, and they are here for the parity table and for the flags they take.
  { words: "host devices revoke", options: optionsFor("host devices revoke"), page: "host" as const, usage: "wsp host devices revoke <id>", about: "take one computer's token away", cliOnly: "takes away a computer's token, which belongs with the terminal that handed it the code" },
  { words: "host clients revoke", options: optionsFor("host clients revoke"), page: "host" as const, usage: "wsp host clients revoke <id>", about: "sign one computer out of your relay account", cliOnly: "signs another of this person's computers out of their relay, which no thread decides for them" },
];

/** What a caller reads after `wsp --help`: the page it names, or the front page when it names none. */
export const HELP_PAGES = ["agent", "dev"] as const;

/** The verbs an agent reaches for, one page in: every line whose entry says so, then the flags every verb takes,
 * the exit codes and the notes on how a turn ends. */
export function agentPage(): string {
  return [
    "the verbs your agents use, and the two lines that serve a host by hand:",
    pageLines("agent"),
    "",
    "  wsp send streams the reply to stderr as it arrives and prints the last message",
    "  on stdout when the reply is complete.",
    wrap(`  ${TURN_END_WORDS}.`, 80).join("\n"),
    "  wsp exec streams the command's output and exits with its code. run, send and",
    "  exec wake a paused workspace first, with one line on stderr saying so.",
    "",
    "every verb takes:",
    `  --json         print the raw protocol values, one JSON object per line`,
    `  --state PATH   the state file the host serves`,
    `  --host NAME    run the line against a host on another computer, by the name`,
    `                 wsp host connect gave it; WSP_HOST names one for a whole shell`,
    "",
    "exit codes; every failure is one line on stderr, the failure object with --json:",
    exitCodeHelp(),
  ].join("\n");
}

/** The plumbing for a host on a computer you are not sitting at, and the one paragraph on when a person needs it. */
export function hostPage(): string {
  return [
    pageLines("host"),
    "",
    ...wrap(
      "You need these only for a host serving on a computer that is not the one you are sitting at, or for one outside your own account: pair and devices hand out and take back the codes that let another computer drive a host, and they run at that host's own terminal; connect, list, default and forget hold the hosts this computer drives; link, unlink, linked and clients put a computer on your relay, so it is reachable with no port open to the world.",
      HELP_WIDTH,
      "",
    ),
  ].join("\n");
}

/** The line a builder reaches for and nobody else, so the front page does not carry it. */
export function devPage(): string {
  return pageLines("dev");
}

/** Every line of one page: its usage, then what it does indented under it, so no line runs wide. */
function pageLines(page: Page): string {
  return COMMAND_LINES.filter(line => line.page === page)
    .map(line => [...usageLines(line.usage, "    "), ...wrap(`      ${line.about}`, HELP_WIDTH, "      ")].join("\n"))
    .join("\n");
}

/** A shared flag: the word, the commands that read it, and the sentence its own command's help prints. One parse
 * reads the union of them, and a flag typed on a command whose row does not name it is refused naming the ones
 * that do, so the sentences live beside the rule rather than in a page nobody reads to the end. */
export interface SharedFlag {
  name: Extract<keyof SharedFlags, string>;
  /** The words of every command that reads it. */
  on: readonly string[];
  says: string;
}

export const SHARED_FLAGS: readonly SharedFlag[] = [
  { name: "state", on: SHARED_WORDS, says: `the state file: this word first, else WSP_HOME's state.json, else ./.wsp/state.json when the current directory has a .env, else state.json in the home the running host serves` },
  { name: "port", on: ["up"], says: `the app port (default ${DEFAULT_PORT}); the runtime websocket port follows ${WS_PORT_OFFSET} above it` },
  { name: "ws-port", on: ["up"], says: `the runtime websocket port on its own (default ${DEFAULT_WS_PORT}); --port alone moves both` },
  { name: "listen", on: ["up"], says: `the address to bind (default ${LOOPBACK}, this computer alone). On any other address the page is served without the host token and every client pairs for a device token of its own` },
  { name: "advertise", on: ["up"], says: "the address every machine dials this host at, whatever kind it is; each kind answers for its own machines without it" },
  { name: "no-relay", on: ["up"], says: "serve without the tunnel, on a computer that is linked to a relay" },
  { name: "service", on: ["up"], says: "install the host as a launchd agent on a Mac or a systemd user unit on Linux, which serves now and again at every login. The keys are not written into it: it reads the same .env a terminal run reads, so they have to be in a file" },
  { name: "provider", on: ["up", "init"], says: "which machine provider this computer forks on; without it, a key saved under a provider's own variable wires that provider" },
  { name: "docker-host", on: ["up", "init"], says: "the Docker daemon to dial, as DOCKER_HOST words it; this computer's own socket without it" },
  { name: "code", on: ["host connect", "join"], says: "the code the other computer printed: wsp host pair for a host, wsp add for a place" },
  { name: "code-file", on: ["join"], says: "read the code off this file and delete the file before dialing, so a code never sits on a disk" },
  { name: "awake", on: ["join"], says: "hold this computer out of idle sleep while it is joined, for as long as the agent runs" },
  { name: "name", on: ["host connect", "host link", "add", "join"], says: "the name to call the computer by here; what its address calls it without one" },
  { name: "relay", on: ["host connect"], says: "reach that host through your relay by the name it has there, instead of giving an address" },
  { name: "ssh-port", on: ["add"], says: "the port ssh dials that computer on (default 22)" },
  { name: "ssh-key", on: ["add"], says: "the key file ssh logs in with; whatever your own ssh config and agent already use without it" },
  { name: "yes", on: ["init", "doctor"], says: "init: take every default and ask nothing, which a run off a terminal needs; a login with a browser or device sign-in, or one held in the Keychain, defaults to sign in on the machine unless a saved recipe answered copy, so macOS has nothing to ask either and the sign-ins wait for the app's terminal. doctor: also delete the snapshots and templates this host left behind, which is not reversible" },
  { name: "recipe", on: ["init"], says: "tick the agents and tools from this recipe (wsp recipe writes it) and go straight to the sign-ins" },
  { name: "project", on: ["init"], says: "the project folder you are bringing first; its own files say what it needs, and those rows are ticked first" },
  { name: "first-workspace", on: ["init"], says: "fork the first workspace under this name once the image seals, without asking (default first)" },
  { name: "import", on: ["init"], says: "import this folder's project onto that first workspace, with the consent the app's import starts from" },
  { name: "no-local", on: ["init"], says: "leave this computer alone; the workspace step ticks it by default, since a workspace here forks nothing and bills nothing" },
  { name: "non-interactive", on: ["init"], says: "ask nothing, but still run the sign-ins on the machine: each prints the page to open on this computer, the code when the flow shows one, and the command that opens it, then waits for you" },
  { name: "local", on: ["doctor"], says: "prove a thread on this computer and its reply instead of the reach loop, which needs no provider key, forks nothing and bills nothing" },
];

/** What one command's own `--help` prints: its usage, what it does, and its own flags, one line each. */
export function commandPage(words: string, command: Command): string {
  const rows = [
    ...SHARED_FLAGS.filter(f => f.on.includes(words)).map(f => [`--${f.name}`, f.says] as const),
    ...(command.json ? [["--json", "print the raw values, one JSON object per line, with everything else on stderr"] as const] : []),
    ...(command.host === "refused" ? [] : [["--host", command.host === "hostSide" ? "read to say this line runs at its own host's terminal; it dials no other" : "run the line against a host on another computer, by the name wsp host connect gave it"] as const]),
  ];
  const width = Math.max(...rows.map(([flag]) => flag.length), 0) + 4;
  return [
    ...usageLines(command.usage, "       ").map((line, at) => (at === 0 ? `usage: ${line.trimStart()}` : line)),
    ...wrap(`  ${command.about}`, HELP_WIDTH, "  "),
    ...(rows.length === 0 ? [] : ["", ...rows.flatMap(([flag, says]) => wrap(`  ${flag.padEnd(width)}${says}`, HELP_WIDTH, " ".repeat(width + 2)))]),
  ].join("\n");
}

/** `run` is how this process was started, which the MCP install writes into an agent's config as the way to start it
 * again; the desktop's bundled command hands in its shim, the npm command the default reading. `env` is the
 * environment the verbs run with, this process's for a real command line and its own for a test. `start` is what
 * brings a host up when none serves the state file: the one built from `run` unless a caller says otherwise, and
 * `false` for a caller that wants a line with no host to refuse rather than start one. */
export async function cli(
  argv: string[],
  io: CliIO = terminalIO(),
  run: RunningWsp = runningWsp(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  start: HostStarter | false = starterFor(run, env),
): Promise<number> {
  const starts = start === false ? {} : { start };
  // One reading for every road out of this process, and the sentence about it said once: a verb, a command and the
  // tool server all pick their state here, so none of them can run against a state another of them named.
  const chooseState = (flag?: string): string => statePathFrom(flag, env, line => io.error(line));
  // The flags every line shares are taken off the whole line here, before the words that select the line are read,
  // so one of them binds wherever it was typed and what is left reaches its own parse in the order it was given.
  const { common, rest } = takeCommon(argv);
  const verb = findVerb(rest);
  if (verb !== undefined) {
    const words = verb.name.split(" ");
    return runVerb(verb, [...words, ...common, ...rest.slice(words.length)], io, chooseState, { alsoHere, cwd: process.cwd(), env, ...starts });
  }
  if (rest[0] === MCP_COMMAND) return mcp(io, [...common, ...rest.slice(1)], chooseState, run, env, starts);
  let values: SharedFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...common, ...rest], options: SHARED_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), runForTheList("wsp --help")));
  }
  if (values.version) {
    io.log(`wsp ${VERSION}`);
    return 0;
  }
  // `help` is the word for the flag: a person reaching for it types one as readily as the other, and answering the
  // word with a typo's refusal is the tool arguing about punctuation. A line that opens with it is that same line
  // with the flag on it, so what follows selects a page or a command as it would either way. A line with no word at
  // all asks the same question: typing the program's name asks what it is, and answering by serving made a second
  // host of it.
  const asked = positionals[0] === "help" ? positionals.slice(1) : positionals;
  const wantsHelp = values.help === true || positionals[0] === "help" || asked.length === 0;
  const word = asked[0];
  // The word the plumbing folds under prints its own page, by itself or with the flag every other line answers to.
  if (word === HOST_WORD && asked.length === 1) {
    io.log(hostPage());
    return 0;
  }
  if (wantsHelp && findCommand(asked) === undefined) {
    // A command asking for its own help falls through to the parse below; only a word no command answers to is
    // read as the name of a page.
    if (word === undefined) {
      io.log(HELP);
      return 0;
    }
    const page = HELP_PAGES.find(p => p === word);
    if (page !== undefined) {
      io.log(page === "agent" ? agentPage() : devPage());
      return 0;
    }
    if (word === HOST_WORD) {
      io.log(hostPage());
      return 0;
    }
    // A word that opens lines rather than being one answers with the lines it opens, as it does without the flag.
    const opens = commandUsage(word);
    if (opens !== undefined) {
      io.log(opens);
      return 0;
    }
    return failed(io, values.json === true, usageRefusal(`wsp --help takes a page, and got ${word}.`, `The pages are ${HELP_PAGES.map(p => `wsp --help ${p}`).join(", ")} and wsp host --help.`));
  }
  const opts = optsFor(values, env, line => io.error(line));
  const found = findCommand(asked);
  const json = values.json === true;
  if (found === undefined) {
    // A word that opens a line but is no line of its own gets the lines it opens; one no command answers to gets
    // the pointer, since the help behind it runs to hundreds of rows.
    const usage = commandUsage(word!);
    const refusal = usage === undefined ? usageRefusal(unknownWordLine(word!), runForTheList("wsp --help")) : usageRefusal(`wsp ${word!} opens a line rather than being one.`, usage);
    return failed(io, json, refusal);
  }
  const { words, command } = found;
  // The line's own help, in place of the whole front page: its usage, what it does and its own flags.
  if (wantsHelp) {
    io.log(commandPage(words, command));
    return 0;
  }
  if (json && !command.json) {
    return failed(io, json, usageRefusal(`Unknown option '--json' for wsp ${words}: it answers in prose.`, `That flag belongs to ${JSON_COMMANDS.map(w => `wsp ${w}`).join(", ")}, and to every verb.`));
  }
  if (values.host !== undefined && command.host === "refused") {
    return failed(io, json, usageRefusal(`Unknown option '--host' for wsp ${words}: it runs on this computer.`, `That flag belongs to ${HOST_COMMANDS.map(w => `wsp ${w}`).join(", ")}, and to every verb.`));
  }
  // A flag another command of the shared parse reads: the union is one parse, so the line that does not read it is
  // told which lines do rather than taking it and doing nothing with it.
  const foreign = SHARED_FLAGS.find(f => values[f.name] !== undefined && !f.on.includes(words));
  if (foreign !== undefined) {
    return failed(io, json, usageRefusal(foreignFlagLine(`--${foreign.name}`, foreign.on.map(w => `wsp ${w}`), `wsp ${words}`), `usage: ${command.usage}`));
  }
  try {
    return await command.run(io, opts, values, asked.slice(words.split(" ").length));
  } catch (e) {
    return failed(io, json, e);
  }
}
