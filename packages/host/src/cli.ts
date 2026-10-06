// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { isCancel } from "@clack/prompts";
import { collect, computeRecipe, expand, fileUsageCache, nodeHost, readLogUsage, scanProject, seedMenu, type Manifest, type Platform, type Rung } from "@wsp/collect";
import {
  HARNESS_ADAPTERS,
  createRuntime,
  hostIdentity,
  jsonFileStore,
  localExecStream,
  sqliteStore,
  stateDbPath,
  type GoldenRecipe,
  type GoldenVersion,
  type HarnessAdapterFactory,
  type HostSsh,
  type LocalWiring,
  type Machine,
  type PlaceWiring,
  type RestartDoor,
  type Runtime,
  type SeedWiring,
  type Store,
} from "@wsp/runtime";
import { writeOwn } from "@wsp/own-file";
import { CATALOG_AGENTS, GOLDEN_SETUP, GOLDEN_SMOKE, GUEST_HOME, MCP_AGENT_IDS, THREAD_AGENTS, serverValuesOf } from "@wsp/catalog";
import { authRefusal, cloudOffRefusal, PRICES_URL, STATE_STORE_ENV, holdsNothing, type McpServerSpec, hostFromEnv, jsonLine, SCOPED_MCP_ARG, scopedNoPairLine, imageHomeKeptLine, isJoinedComputer, PLACE_LEAVE_LINE, PLACE_LEAVE_VERB, DEFAULT_PORT, EXIT_CODES, EXIT_WORDS, ExitClass, fmtDuration, forksNoMachines, initJobOver, InitSetup, NO_BUILD_PLACE_LINE, isLocalWorkspace, isLoopback, type ListenAsked, listenBeyondLoopbackLine, loopbackThreadsLine, LOOPBACK, PERSON_HOME_ENV, portInsteadLine, PORT_TAKEN_REFUSAL, portsAsked, portsPickedLine, portTakenLine, runForTheList, type SealedImage, shellQuote, THIS_COMPUTER, thisComputerLine, TURN_END_WORDS, namesPlace, noSuchPlaceRefusal, type PlaceView, unknownWordLine, usageRefusal, verbFailure, foreignFlagLine } from "@wsp/protocol";
import { agentHome, checkProviderKey, type Copier, keyCheckLine, type KeyCheck, LocalBackend, type MachineBackend, providerSlot, type ProviderSlot, verbCopier } from "@wsp/engine";
import { CLOUD_ON } from "./cloud.js";
import { noMachinesLine, PROVIDER_MODULES, providerBackendFor, providerEnvWith, providerEnvWithKey, providerKeyRow, providerKeyRows, providerKeySet, providerModule, providerPlaces, wiredPlaceRow, wiredProviderId, type ProviderEnv, type ProviderModule } from "./providers.js";
import { daemonBinaryHere, webDirFor } from "./assets.js";
import { DAEMON_DEPLOYED_LINE, cappedLine, claudeEnvs, deployDaemon, doctor, doctorOverHost, hostDoctor, missingBundleFile } from "./doctor.js";
import { daemonFixLine, releaseUpdateLine } from "./daemon-fix.js";
import { agentsHere } from "./agents-here.js";
import { InitJobs } from "./init-job.js";
import { ANTHROPIC_KEY, KEY_LAYER_WORDS, envFileFor, keyIn, parseEnvFile, savedEnv, serverEnvFileFor, serverVault, vaultOf, writeEnvFile, type Keys } from "./env-keys.js";
// The writer of a host's own .env now sits beside its reader; the name stays exported here for every caller
// that already had it from this module.
export { writeEnvFile } from "./env-keys.js";
import { keychainReader } from "./init-import.js";
import { adoptLoginPath, loginEnv } from "./login-path.js";
import { CACHE_RULE } from "./project-bundle.js";
import { packSeed } from "./project-seed.js";
import { readBrewTable } from "./init-brew.js";
import { copyGoldenRecipe } from "./image-recipe.js";
import { exitCodeOf, runInit, type InitIO, type InitPricing, type InitResult } from "./init.js";
import { runMintHere } from "./init-vault.js";
import { recipePath } from "./init-recipe.js";
import { historyCache } from "./recipe-file.js";
import { alsoHere } from "./scan.js";
import { colourDepth, confirmPrompt, isTTY, muted, passwordPrompt, widthOf, wrap, type PromptOptions } from "./init-layout.js";
import { TAGLINE, builtOn, opening } from "./init-opening.js";
import { runLocalInit } from "./init-local.js";
import type { ServedAt } from "./init-serve.js";
import { askFirst } from "./init-first.js";
import { buildBesideHost } from "./init-beside.js";
import { hereAnswering, hereLines, openHere, type HereWatch } from "./place-here.js";
import { watchBlock, watchOn, type Redraw, type WatchSignals } from "./watch.js";
import { startCallbackRelay, systemOpener, type UrlOpener } from "./relay.js";
import { addressLines, hostInboxDir, hostLogPath, hostReadingsDir, hostRootsPath, hostRunDir, hostTokenPath, lockPathFor, heldOrStarted, programGone, refuseIfServed, releaseLock, rewriteLock, SERVICE_WAIT_MS, servingHost, startedByEnv, STARTED_BY_ENV, takeLock, type HostLock, type HostStarted } from "./host-lock.js";
import type { LocalDaemon, LocalDaemonOptions } from "./local-daemon.js";
import { startOnce } from "./start-once.js";
import {
  hostThereLines,
  httpProbe,
  installService,
  logTail,
  noManagerLine,
  registeredService,
  runFailureLine,
  serviceAddressHere,
  serviceEnv,
  serviceManagerFor,
  serviceReading,
  statusLines,
  stopService,
  systemRunner,
  untilLock,
  untilServing,
  type HostProbe,
  type ServiceManager,
  type ServiceRunner,
} from "./service.js";
import { serviceServesState, starterFor, type HostStarter } from "./host-start.js";
import { restartRoads, type RestartingHost, type RestartRoad } from "./restart.js";
import { stopRecordedConnector } from "./connector.js";
import { admittedDevices, hostsCommand, loginCommand, logoutCommand, readRelayRecord, relayCommand, relayOnLoopbackLine, startRelay } from "./relay-link.js";
import { aimAddress, aimName, DEFAULT_HOME, type HostPick, namedHost, stateIgnoredLine, wspHome } from "./hosts.js";
import { homeNamed, realState, servingHome } from "./serving-home.js";
import { advertiseWord, devicesCommand, hereUrl, pairCommand, type HereAt } from "./pairing.js";
import { addCommand, addFlags, dialHere, joinCommand, leaveCommand, placeWiring, removeCommand } from "./places.js";
import { agentsReader } from "./agents-reader.js";
import { skillsActs } from "./skills-acts.js";
import { serverIcons } from "./server-icons.js";
import { agentLatest } from "./agent-latest.js";
import { keptTools, recipeShelf } from "./recipes.js";
import { recipeWatch, type WatchFn } from "./recipe-watch.js";
import { serversActs } from "./servers-acts.js";
import { hostActs } from "./agents-signin.js";
import { startHost, workspaceRoads, type HostDoctorReaders, type HostHandle } from "./server.js";
import { choosePorts, type PortProbes, type PortsPicked } from "./ports.js";
import { writeThreadWsp } from "./shim.js";
import { agentsOnPath, installEach, installLines, mcpServerSpec, nextLine, refreshSkills, registeredLine, removeEach, removeLines, runningWsp, serversRefreshedLine, refreshServers, skillsRefreshedLine, toolServerLine, wspCommand, type RunningWsp } from "./mcp-install.js";
import { CLI_VERBS, cloudLineOf, COMMON, COMMON_FLAG_WORDS, hostPlatform, NO_PROJECT_YET, type DialOpts, dialHost, failed, findVerb, HELP_WIDTH, helpPage, type HostClient, jsonAsked, type Page, runVerb, takeCommon, toolName, usageLines, verbUsage, type VerbDeps } from "./verbs.js";
import { installedVersion, stateWriterHere, VERSION } from "./version.js";
import { latestWords, releaseReading, releaseWatch } from "./release.js";
import { analyticsOff, hostAnalytics } from "./analytics.js";
import { followUsage } from "./analytics-events.js";
import { type CliIO, terminalIO, jsonCliIO } from "./cli/io.js";
export { type CliIO, terminalIO, jsonCliIO } from "./cli/io.js";
import { type KeySources, keyLayers, keySources, providerEnvNow, loadKeys, keysFound, vaultNow } from "./cli/keys.js";
export { type KeySources, keySources, type NoProviderKey, type LoadedKeys, loadKeys, keysFound, vaultNow, saveQuestion } from "./cli/keys.js";
import { statePathFrom, statesHere, stateStore } from "./cli/state.js";
export { devCheckoutState, type StatePick, statePick, defaultStatePath, statesHere, stateStore } from "./cli/state.js";
import { type ServeAsked, SERVE_FLAGS, type SharedOpts, optsFor, type SharedFlags, type Options, SHARED_OPTIONS } from "./cli/flags.js";
export { type ServeAsked, SERVE_FLAGS, type SharedOpts, optsFor, SHARED_OPTIONS } from "./cli/flags.js";
import { goldenRecipe, localWiring, hostRecipeWatch, swapProvider, makeRuntime, collectThisComputer, projectFolder, workspaceEnvsFor } from "./cli/wiring.js";
export { goldenRecipe, localWorkFolder, type LocalDaemonStart, localWiring, hostRecipeWatch, providerSlotOf, swapProvider, servingWiring, makeRuntime, hostSeed, projectFolder } from "./cli/wiring.js";
import { stopOnSignals, stayOnUncaught, type ServeOptions, serve, hostFor } from "./cli/serve.js";
export { type StopProcess, OWN_FILES_POLL_MS, stopOnSignals, type UncaughtProcess, stayOnUncaught, type ServeOptions, serve, noClaudeKeyNote, hostDoctorReaders } from "./cli/serve.js";
import { upCommandFor, init } from "./cli/init.js";
export { terminalInitIO, providerBesideRefusal, upCommandFor } from "./cli/init.js";
import { up, systemService, upServiceCommand, downCommand, latestHere, statusCommand, pickUpPorts } from "./cli/service.js";
export { up, type ServiceDeps, hostRoadWord, hostStoppedLine, systemService, serviceArgv, keyOnlyInThisShell, claudeKeyOnlyInThisShell, upServiceCommand, downCommand, statusCommand, pickUpPorts } from "./cli/service.js";

/** The one claim about the host a person reads twice, on the front page and on wsp up's own page: which is why up
 * is for a host somebody wants to watch and not the switch that turns wsp on. Said once here, so the page and the
 * line cannot promise different things; the words that need a host and start one are the verbs, wsp add and wsp
 * remove, and wsp status and wsp down deliberately start none, which is why this says a line that needs one. */
export const HOST_STARTS_ITSELF = "A line that needs a host starts one when none serves.";

/** One line per exit class, the code first, wrapped to the help's width. */
const exitCodeHelp = (): string => ExitClass.options.map(cls => wrap(`  ${EXIT_CODES[cls]} ${cls.padEnd(8)}  ${EXIT_WORDS[cls]}`, 80, " ".repeat(14)).join("\n")).join("\n");

/** The front page, word for word: sixteen words on five nouns, the three rules, and the two pages and the flag
 * help behind them. It is a literal rather than a table of usages because the whole of it is what a person meets
 * first, and its right hand column is written for that reading; the parity test holds its sixteen words to the
 * entries that declare the front page, so a verb cannot be added to one and not the other. */
export const HELP = `wsp - ${TAGLINE}

usage: wsp <verb> ...

  wsp init                        set this computer up: your tools and sign-ins,
                                  copied so a machine starts ready
  wsp add <user@host|folder|url>  a computer over ssh (user@host or ssh alias);
                                  or a project: a folder here, or a repo cloned
                                  --into <folder> here or --on <computer>
${CLOUD_ON ? `  wsp computers                   your computers: this one, each box you added,
                                  each cloud account` : "  wsp computers                   your computers: this one, each box you added"}
  wsp remove <computer>           take a computer out; the box is left as
                                  wsp found it
  wsp projects                    your projects, each on its computer
  wsp threads [<project>]         who is working, in which folder and on which
                                  branch and computer
  wsp run <project> "<message>"   an agent works in the project's folder and
                                  you read its reply
  wsp send <thread> "<message>"   the thread's next message
  wsp stop <thread>               end the thread's running turn
  wsp pause <machine>             sleep a box's machine now; an idle one sleeps
                                  by itself
  wsp wake <machine>              wake it now; run and send wake it anyway
  wsp delete <thread>             gone with its turns; the folder stays
  wsp status                      whether a host serves, and where
  wsp mcp                         the verbs as tools for agents on this computer

A project or a thread comes right after the verb. run and send take the
agent's own flags, run --help lists them.
wsp thread read <thread> prints what a thread said.
Sleeping is automatic. ${HOST_STARTS_ITSELF}

wsp up                 serve a host in this terminal, to watch it
wsp down               stop it
wsp login              sign this computer in to your account
wsp logout             sign it out; wsp logout <id> signs another out
wsp hosts              the hosts you can reach, the one lines take marked
wsp <verb> --help      the verb's own flags
wsp --help agent       the verbs your agents use
wsp host --help        a host outside your account: pair, connect, link
wsp --version
`;


export type { Keys } from "./env-keys.js";

// The hosts file sits under the same home, so where that home is lives beside it and is re-exported here for every
// reader that already had it from the command line.
export { wspHome };

/** What a word of the shared parse does with --host. `aimed`: the line runs against the host it names. `refused`:
 * the line reads this computer's own files, so the parse refuses the flag rather than take it and aim nowhere.
 * `hostSide`: the line runs at the host's own terminal, so it takes the flag and answers the one sentence that says
 * so, which is the same answer WSP_HOST and the account's one host already get. */
export type HostFlag = "aimed" | "refused" | "hostSide";

type Command = CommandRun & ({ /** Why the MCP server has no tool for it. */ cliOnly: string } | { /** The tool it is served as, a CommandToolVerb in the verb table. */ tool: string });

interface CommandRun {
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
  run(io: CliIO, opts: SharedOpts, values: SharedFlags, args: string[], deps: CommandDeps): Promise<number>;
}

/** What a command of the shared parse reaches another host with. One dial, the one every verb takes, so a test
 * hands a fake host client where a real one would be dialled. */
export interface CommandDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  /** Which ports wsp up finds held; this computer's own, read by binding them, when absent. */
  ports?: PortProbes;
}

/** The dial every command line takes when the caller names no other. */
export const SYSTEM_COMMAND_DEPS: CommandDeps = { dial: dialHost };

/** What a command that reads where a line is aimed works on: the state file this run names, the home holding the
 * hosts folder, the environment the run was made in and the word --host gave. One reading for the three commands
 * that ask, so the flag cannot reach one of them and not another. */
function aimPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick {
  return { statePath: opts.statePath, home: opts.home, env: opts.env, ...(values.host !== undefined ? { host: values.host } : {}) };
}

/** The same pick with the run's starter on it, for wsp add and wsp remove: both do their work through the host, as
 * every verb does, so both start one when none serves and the front page's claim holds for them. wsp status reads
 * whether a host serves and must never start one, and wsp down has nothing to start, so neither takes this. */
function startingPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick & { start?: HostStarter } {
  return { ...aimPick(opts, values), ...(opts.start !== undefined ? { start: opts.start } : {}) };
}

/** The doctor's own usage line, read by its row and by every refusal that prints it. */
const DOCTOR_USAGE = "wsp doctor [<computer>] [--project <name>] [--local] [--yes]";

/** Set to 1, every road of the doctor prints what the loop still holds once it closed what it opened. A run that
 * does not end after its last line is holding something, and this is what names it. */
export const DOCTOR_HANDLES_ENV = "WSP_DOCTOR_HANDLES";

/** What the doctor's roads that touch no provider load: no key, and no question about one. The local road and the
 * computer road fork nothing and bill nothing, so a person with a computer of their own and no cloud account is
 * never asked for a cloud key; the agents' key rides along from the files either way. */
const NO_CLOUD_KEY = { anthropic: false, noProviderKey: "local" } as const;

/** Which keys one doctor road needs: a cloud row's road forks a machine at that provider and bills while it runs,
 * so its key is asked for the way every cloud road asks for one; every other road forks nothing and is handed no
 * key at all. Read after the row, since the row is what says which road this is. */
export const doctorKeyAsk = (computer?: Pick<PlaceView, "kind">): { anthropic: boolean; noProviderKey?: "local" } =>
  computer?.kind === "provider" ? { anthropic: true } : NO_CLOUD_KEY;

/** The row a word names, or the refusal naming the rows this host holds and the line that lists them. The one
 * reading every road that takes a place word makes, and it says nothing about which road the doctor then takes. */
export function doctorRow(places: readonly PlaceView[], word: string): PlaceView {
  const found = places.find(place => namesPlace(place, word));
  if (found === undefined) throw usageRefusal(noSuchPlaceRefusal(word, places.map(place => place.name)), "Run wsp computers to read the ones this host holds.");
  return found;
}

/** The one word a line of the account takes, or the refusal for a second: a word nobody reads is a line that did
 * something other than what was typed. The usage each of them prints is its own row's. */
function oneWord(words: string, usage: string, args: readonly string[]): string | undefined {
  if (args.length > 1) throw usageRefusal(`wsp ${words} takes one word, and got ${args.length}.`, `usage: ${usage}`);
  return args[0];
}

/** The commands the shared parse serves, keyed by the words that select one. A line is matched against the longest
 * key whose words open it, as a verb's words select a verb, so the plumbing folded under `host` needs no second
 * dispatch of its own. */
const COMMANDS: Readonly<Record<string, Command>> = {
  up: {
    page: "agent",
    usage: `wsp up [--port <n>] [--listen <addr>] [--advertise <url>]${CLOUD_ON ? " [--provider <name>]" : ""} [--no-relay] [--service]`,
    about: `serve the host in this terminal, for a host you want to watch or one that serves beyond this computer; --service hands the same line to this computer's own service manager, which starts it now and again at every login. ${HOST_STARTS_ITSELF}`,
    json: false,
    host: "refused",
    cliOnly: "starts the host on the person's computer; a tool runs against a host that is already up",
    run: async (io, opts, values, _args, deps) => {
      if (values.service === true) return upServiceCommand(io, opts, systemService());
      // The lock is read before a port is stepped, a key is read or a daemon is dialled: each of those writes under
      // the home the other host is serving, and a start that is going to be refused must leave it as it found it.
      refuseIfServed(lockPathFor(opts.statePath), opts.statePath);
      // A state file this computer's own manager is registered to serve is that service's: a host started here
      // would be a second one on it, of whichever build this line came from, which is how a state file was
      // rewritten under the host that owned it. The service's own host carries the word and passes, and a host
      // that is already serving is the lock's refusal below, which names the pid and how to stop it.
      const owned = startedByEnv(process.env) === "service" ? undefined : serviceServesState(opts.statePath, registeredService);
      if (owned !== undefined) {
        io.error(owned);
        return EXIT_CODES.provider;
      }
      // Which ports are free is settled before anything binds: a port another wsp or another program holds is one
      // sentence naming who holds it, and a pair nobody named is stepped over rather than refused.
      const picked = await pickUpPorts(io, opts, deps.ports);
      if (picked === undefined) return EXIT_CODES.provider;
      const handle = await up(io, { ...opts, ...picked.ports });
      // "Serving on 4401" is a claim about a host that serves, so it is said once one does: the state read, the
      // keys, the second lock read and the bind itself all refuse after the ports are picked.
      if (picked.moved !== undefined) io.log(portsPickedLine({ port: handle.port }, picked.moved.port, picked.moved.holder));
      stopOnSignals(handle, io);
      stayOnUncaught(io);
      return 0;
    },
  },
  down: {
    page: "agent",
    usage: "wsp down",
    about: "stop the host: the service and its unit where one holds it up, and otherwise the host the command line brought up, whether wsp up or a verb that needed one started it",
    json: false,
    host: "refused",
    cliOnly: "stops the service holding the host up on the person's computer, which a tool would be cutting the ground from under",
    run: (io, opts) => downCommand(io, opts, systemService()),
  },
  status: {
    page: "front",
    usage: "wsp status [--watch]",
    about: "whether a host serves this state file, on which ports, what keeps it there and the newest release the host last read, with a non-zero exit code when none does; on a computer joined to somebody's wsp it reads the agent there instead, what that computer is doing and what is running on it, and --watch draws the same rows again every second. --host reads a host on another computer",
    json: false,
    host: "aimed",
    cliOnly: "reads this computer's lock and service manager, the agent on a computer that joined somebody's wsp, or dials the host named beside it; a tool that answers at all is proof a host is up",
    run: (io, opts, values) =>
      statusCommand(io, { ...aimPick(opts, values), ...(values.state !== undefined ? { state: values.state } : {}), ...(values.watch === true ? { watch: true } : {}) }, systemService()),
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
    about: "the computers paired with a host and what each token is read as; revoke takes one back out. --host reads a host on your account from another computer signed in to it",
    json: false,
    host: "aimed",
    cliOnly: "lists and takes away the computers that may drive a host, from that host's terminal or from a computer paired with it; which computers hold a token is the person's to read and cut, never a thread's",
    run: (io, opts, values, args) => devicesCommand(io, aimPick(opts, values), args),
  },
  "host link": {
    page: "host",
    usage: "wsp host link [<url>] [--name <name>]",
    about: "put the host on this computer onto your account, so it is reachable from anywhere with no port open to the world; on a computer that is signed in it takes no address and asks nothing, and on one that is not it prints a code and a page to approve it on",
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
  login: {
    page: "front",
    usage: "wsp login [<relay url>|<word>|<id>]",
    about: "sign this computer in to your account, so every host on it is a line away with no code typed. With a word another computer's wsp login printed, or the id of one already signed in, it signs that computer's key for the hosts this one is trusted at; with nothing on a computer already signed in it lists the account's computers",
    json: false,
    host: "refused",
    cliOnly: "signs a person in to their own account and admits their other computers to their hosts, which is theirs to give away and never a thread's",
    run: (io, opts, _values, args) => loginCommand(io, opts, oneWord("login", "wsp login [<relay url>|<word>|<id>]", args)),
  },
  logout: {
    page: "front",
    usage: "wsp logout [<id>]",
    about: "sign this computer out of your account, which drops the hosts it reached through it; with an id it signs another of your computers out, and every host drops what it admitted for that one",
    json: false,
    host: "refused",
    cliOnly: "takes away a token of this person's and the access it bought, which belongs with the person whose account it is",
    run: (io, opts, _values, args) => logoutCommand(io, opts, oneWord("logout", "wsp logout [<id>]", args)),
  },
  hosts: {
    page: "front",
    usage: "wsp hosts",
    about: "every host on your account this computer can reach, with a live beat for each and the one every line takes marked",
    json: false,
    host: "refused",
    cliOnly: "reads which hosts this computer can reach and writes the account's into its own files, which no thread decides for the person",
    run: (io, opts, _values, args) => {
      if (args.length > 0) throw usageRefusal(`wsp hosts takes no words, and got ${args[0]!}.`, "usage: wsp hosts");
      return hostsCommand(io, opts);
    },
  },
  init: {
    page: "front",
    usage: "wsp init [--on <place>] [--recipe <path>] [--project <path>] [--first-workspace <name>] [--import <folder>] [--rebuild] [--no-local] [--yes] [--non-interactive] [--json]",
    about: "seal this computer into your image, one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build. Beside a host already serving this state file the screens are the same and the build runs in that host, on the place --on names or its default place, a computer you joined included. With no host serving and no provider key it seals nothing and records a folder here as your first project instead",
    json: true,
    host: "refused",
    cliOnly: "builds your image and serves for hours; an agent runs it from a shell and relays the sign-ins it prints",
    run: (io, opts, values) =>
      init(io, opts, {
        yes: values.yes === true,
        // --json has nobody to answer the screens: its objects are for whoever is driving the run.
        nonInteractive: values["non-interactive"] === true || values.json === true,
        json: values.json === true,
        noLocal: values["no-local"] === true,
        ...(values.rebuild === true ? { rebuild: true } : {}),
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        ...(values.project !== undefined ? { project: values.project } : {}),
        ...(values["first-workspace"] !== undefined ? { firstWorkspace: values["first-workspace"] } : {}),
        ...(values.import !== undefined ? { importFolder: values.import } : {}),
        ...(values.on !== undefined ? { on: values.on } : {}),
        upCommand: upCommandFor(opts, values),
      }),
  },
  add: {
    page: "front",
    usage:
      `wsp add [<user@host>|<ssh alias>|<folder>|<url>|<owner/repo>|${CLOUD_ON ? "<provider>|" : ""}<computer> --update|<computer> --sign-in <agent>|<computer> --resume] [--recipe <name>] [--later] [--on <computer>] [--into <folder>] [--name <name>] [--base <branch>] [--yes] [--keep <path>] [--cut <path>] [--no-memory] [--no-commits] [--remember] [--ssh-port <port>] [--ssh-key <path>] [--host-key <key>]`,
    about:
      "a computer of yours over ssh by user@host or by an alias from your ssh config, or a project: a folder on this computer, a git repo or not, whose threads run in it, or a repo cloned into an empty folder here with --into <folder> or by a computer with --on <computer>; " + (CLOUD_ON ? "<provider> takes a provider's key, " : "") + "nothing prints the join line another computer types, a computer with --update puts this wsp's daemon on one already in, and a computer with --sign-in signs that agent in there once, outside every machine on it",
    json: true,
    host: "hostSide",
    // The computer road alone: the join code and a provider's key stay at the host's own terminal, and the tool refuses them.
    tool: "add",
    run: (io, opts, values, args) =>
      addCommand(io, { ...startingPick(opts, values), providerEnv: opts.providerEnv }, args, addFlags(values.name, values["ssh-port"], values["ssh-key"], values.update, values.on, values.base, values["sign-in"], {
        ...(values.yes === true ? { yes: true } : {}),
        ...(values.keep !== undefined ? { keep: values.keep } : {}),
        ...(values.cut !== undefined ? { cut: values.cut } : {}),
        ...(values["no-memory"] === true ? { noMemory: true } : {}),
        ...(values["no-commits"] === true ? { noCommits: true } : {}),
        ...(values.remember === true ? { remember: true } : {}),
      }, values["host-key"], values.into, {
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        ...(values.later === true ? { later: true } : {}),
        ...(values.resume === true ? { resume: true } : {}),
        ...(values.json === true ? { json: true } : {}),
      })),
  },
  remove: {
    page: "front",
    usage: "wsp remove <computer>",
    about: "take a computer out; the agent and its files go, and the computer is left as wsp found it. Refused while a machine or a project stands on it, naming them",
    json: false,
    host: "hostSide",
    cliOnly: "takes a computer out of this wsp and sweeps wsp off it, which belongs with the terminal that joined it",
    run: (io, opts, values, args) => removeCommand(io, startingPick(opts, values), args),
  },
  join: {
    page: "agent",
    usage: "wsp join <url>... --code <code> [--code-file <path>] [--name <name>]",
    about: "on the computer you are sitting at: join it to the wsp at that address, then install the daemon as a systemd system unit, which dials again at every boot. A place is a Linux computer; a Mac refuses",
    json: false,
    host: "refused",
    cliOnly: "joins the computer it is typed on to somebody's wsp and keeps the key it proves itself with in this person's own files; where their computer belongs is theirs to say",
    run: (io, _opts, values, args) =>
      joinCommand(io, args, {
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values["code-file"] !== undefined ? { codeFile: values["code-file"] } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
      }),
  },
  [PLACE_LEAVE_VERB]: {
    page: "agent",
    usage: PLACE_LEAVE_LINE,
    about: "on that computer: take wsp off it, for a computer whose host is gone and cannot run wsp remove",
    json: false,
    host: "refused",
    cliOnly: "sweeps wsp off the computer it is typed on, which belongs with the terminal that joined it",
    run: (io, _opts, _values, args) => leaveCommand(io, args),
  },
  doctor: {
    page: "dev",
    usage: DOCTOR_USAGE,
    about:
      "prove a computer end to end. With no word, this computer and then every computer you added, forking nothing and billing nothing. With a computer's name, that one: a joined computer is proved by the host that computer dials, which makes a short-lived machine there and reads the recipe's tools inside it, and this line prints what the host says; a cloud account gets your image forked, wsp put on the fork, a file coming back and the teardown, which forks a live machine and bills while it runs. --local proves this computer alone: a thread here and its reply, no machine, no key. --project names the project the machine is made of, by name, on the computer named",
    json: false,
    host: "refused",
    cliOnly: "runs for minutes, makes and deletes a workspace on the computer you named, and on a cloud account forks a live machine that bills while it runs; a person decides that at a terminal",
    run: async (io, opts, values, args, deps) => {
      await adoptLoginPath(line => io.log(line));
      // One wiring for this computer, so the daemon the copy road would run and the one the doctor reads the
      // version off are the same process. Its sink keeps nothing: this is a person's screen, and what the daemon
      // says on its own stderr as it starts is not the answer they asked for.
      const local = localWiring(homedir(), process.env, undefined, opts.statePath, undefined, () => {});
      const hereDaemon = local.hereDaemon;
      const word = args[0];
      if (args.length > 1) throw usageRefusal(`wsp doctor proves one computer, and it was given ${args.length} words: ${args.map(w => JSON.stringify(w)).join(" ")}.`, DOCTOR_USAGE);
      // Read once, and printed at the end of every road: what is still open after a road closed what it opened is
      // what would hold this process after its last line.
      const showHandles = opts.env[DOCTOR_HANDLES_ENV] === "1";
      const latest = latestHere(opts.statePath, opts.env);
      const handles = (road: string): void => {
        if (showHandles) io.error(`${road} left open: ${process.getActiveResourcesInfo().join(", ") || "nothing"}`);
      };
      // The local road touches no provider, so a missing key is not asked for: it is the whole of the doctor for a
      // person whose wsp init took the local road.
      if (values.local === true) {
        if (word !== undefined) throw usageRefusal(`wsp doctor --local proves this computer alone, so there is no computer to name beside it, and it was given ${JSON.stringify(word)}.`, DOCTOR_USAGE);
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv, opts.statePath), NO_CLOUD_KEY);
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(), env, undefined, local);
        try {
          return await doctor(rt, io, { ...(hereDaemon !== undefined ? { hereDaemon } : {}), ...(latest !== undefined ? { latest } : {}) });
        } finally {
          await rt.close();
          handles("the local road");
        }
      }
      // A project is the one a workspace on the computer named is made of, so it means nothing spread over every
      // computer this host holds: a run with no word would hand it to each of them and fail on any without it.
      if (values.project !== undefined && word === undefined) throw usageRefusal("wsp doctor --project names the project the workspace on the computer you named is made of, and no computer was named.", DOCTOR_USAGE);
      const project = values.project === undefined ? {} : { project: values.project };
      /** The roads this terminal walks itself: this computer, whose files and threads are here, and a cloud
       * account, whose fork bills and whose key is asked for where a person is sitting. The runtime is this
       * process's own and is closed on the way out, pass or fail. */
      const terminalRoad = async (computer?: PlaceView): Promise<number> => {
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv, opts.statePath), doctorKeyAsk(computer));
        // One planner for this run: the recipe the tools step reads against is the one the recipe job puts on a
        // computer, read through the wiring this runtime holds its links with.
        const links = placeWiring(opts.statePath);
        const provision = links.provision;
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(), env, undefined, local, links);
        try {
          return await doctor(rt, io, {
            envs: claudeEnvs(),
            ...(values.yes === true ? { yes: true } : {}),
            ...(computer !== undefined ? { computer } : {}),
            ...project,
            ...(hereDaemon !== undefined ? { hereDaemon } : {}),
            ...(latest !== undefined ? { latest } : {}),
            vault: () => vaultNow(opts.statePath),
            ...(provision !== undefined ? { plan: () => provision.plan({ home: GUEST_HOME }) } : {}),
            statePath: opts.statePath,
          });
        } finally {
          // The version read starts the daemon for this computer's workspace where nothing had; a run that left it
          // standing would hold the terminal after its last line.
          await rt.close();
          handles(computer?.kind === "provider" ? "the cloud road" : "the local road");
        }
      };
      // This computer's own host and no other: the word in the environment and the account's one host name hosts that
      // hold no link to the computers this line proves, and --host is refused on this line for the same reason.
      const dialling = dialHere(io, opts);
      // With no word: this computer first, on a runtime of this terminal's own and closed before anything else,
      // then every computer joined to this one, each on the host that holds its link.
      if (word === undefined) {
        const here = await terminalRoad();
        const client = await deps.dial(opts.statePath, dialling);
        try {
          const rows = (await client.request<{ places: PlaceView[] }>("places.list")).places;
          const said = await doctorOverHost(client, io, rows, project);
          return said === 0 ? here : said;
        } finally {
          client.close();
          handles("the computer road");
        }
      }
      // Which row the word names is read off the host that holds the links, since a computer reads present off the
      // map of links the process it dialled is holding and a fresh runtime here holds none. A host is started for
      // it where none serves, the way wsp add --update starts one.
      const client = await deps.dial(opts.statePath, dialling);
      let computer: PlaceView | undefined;
      try {
        computer = doctorRow((await client.request<{ places: PlaceView[] }>("places.list")).places, word);
        // A computer somebody joined is proved on the host holding its link, which prints what that host says.
        if (isJoinedComputer(computer)) return await hostDoctor(client, io, computer, project);
      } finally {
        client.close();
        // Named for the road that was walked: a word that turned out to be this computer's own row or a cloud row
        // read the list over this socket and then took a road of the terminal's own, which says its own line.
        if (computer !== undefined && isJoinedComputer(computer)) handles("the computer road");
      }
      return terminalRoad(computer);
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
  scoped: { type: "boolean" },
  "no-slate": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const mcpInstallUsage = (): string => `wsp ${MCP_COMMAND} install --agent <id> [--agent <id>] [--host <alias>] [--json] [--remove]   (${MCP_AGENT_IDS})`;
const mcpUsage = (): string => `usage: wsp ${MCP_COMMAND} [--host <alias>] [${SCOPED_MCP_ARG} [--no-slate]]\n       ${mcpInstallUsage()}`;

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
  let values: { agent?: string[]; host?: string; json?: boolean; remove?: boolean; state?: string; scoped?: boolean; "no-slate"?: boolean; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({ args: argv, options: MCP_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), usage));
  }
  if (values.help === true) {
    io.log(mcpPage(words[0] === "install"));
    return 0;
  }
  if (values["no-slate"] === true && values.scoped !== true) return failed(io, jsonAsked(argv), usageRefusal(`--no-slate goes with ${SCOPED_MCP_ARG}: it is for a thread another thread started`, usage));
  // Ahead of every reading of the state: a scoped server missing its pair would otherwise dial this computer's host
  // on the host's own token, which is acting as the person.
  if (values.scoped === true && words.length === 0 && hostFromEnv(env) === undefined) return failed(io, jsonAsked(argv), authRefusal(scopedNoPairLine));
  const statePath = statePathOf(values.state);
  if (words.length === 0) {
    const line = toolServerLine(statePath, values, run);
    if (line !== undefined) return toolServerRan(io, line, env);
    // A platform gap: a Linux host's daemon binary is the static guest build, which carries no tool server, so the
    // TypeScript server answers there. The agent starts it in its own folder, which is the folder a thread opened with
    // no workspace is placed by.
    const { serveMcp } = await import("./mcp.js");
    await serveMcp(statePath, { alsoHere, cwd: process.cwd(), env, ...starts, ...(values.host !== undefined ? { host: values.host } : {}), ...(values.scoped === true ? { scoped: true } : {}), ...(values["no-slate"] === true ? { noSlate: true } : {}) });
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
    if (json) io.log(jsonLine(gone));
    else {
      for (const agent of gone.removed) for (const line of removeLines(agent)) io.log(line);
      for (const failed of gone.failures) io.error(`wsp mcp install: ${failed.error}`);
    }
    return gone.failures.length > 0 ? 1 : 0;
  }
  const report = installEach(agents, mcpServerSpec(statePath, run, values.host !== undefined ? { host: values.host } : {}), homedir(), project);
  if (json) io.log(jsonLine(report));
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

/** The tool server run on this process's own stdio until the agent closes it, and the code it exits with. */
function toolServerRan(io: CliIO, line: McpServerSpec, env: Readonly<Record<string, string | undefined>>): Promise<number> {
  return new Promise(done => {
    const child = spawn(line.command, [...line.args], { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    child.once("error", e => {
      io.error(`${line.command}: ${e.message}`);
      done(EXIT_CODES.provider);
    });
    child.once("exit", code => done(code ?? EXIT_CODES.provider));
  });
}

const without = (options: Options, names: readonly string[]): Options => Object.fromEntries(Object.entries(options).filter(([name]) => !names.includes(name)));

/** The flags of the shared parse every line answers, which the readers table names no line for. */
const EVERY_LINE: ReadonlySet<string> = new Set(["help", "json", "host"]);

/** The flags a line of the shared parse takes, read off the command that runs it: a line of two words or more is
 * selected by its first word, so it advertises exactly what that word's `json` and `host` say and never a list
 * written out beside it, which is how a flag added to the shared parse reached seven lines that refuse it. A flag
 * the readers table gives to other lines alone is refused on this one, so it is not advertised here either. */
function optionsFor(words: string): Options {
  const found = findCommand(words.split(" "));
  if (found === undefined) throw new Error(`wsp ${words} is in the command lines and no command answers it`);
  const { command } = found;
  const shared = without(SHARED_OPTIONS, [...(command.json ? [] : ["json"]), ...(command.host === "refused" ? ["host"] : [])]);
  return Object.fromEntries(Object.entries(shared).filter(([name]) => EVERY_LINE.has(name) || readers(name).includes(words)));
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
  // The flags are read when asked for, since the table of who reads which is written below this one.
  ...Object.entries(COMMANDS).map(([words, command]) => ({
    words,
    usage: command.usage,
    about: command.about,
    page: command.page,
    get options(): Options {
      return optionsFor(words);
    },
    ...("tool" in command ? { tool: command.tool } : { cliOnly: command.cliOnly }),
  })),
  // The two lines a word of the host page opens: they print inside their parent's usage, so they carry no page of
  // their own to print on, and they are here for the parity table and for the flags they take.
  {
    words: "host devices revoke",
    get options(): Options {
      return optionsFor("host devices revoke");
    },
    page: "host" as const,
    usage: "wsp host devices revoke <id>",
    about: "take one computer's token away",
    cliOnly: "takes away a computer's token, from the host's terminal or from a computer paired with it; who may drive a host is the person's to cut, never a thread's",
  },
];

/** What a caller reads after `wsp --help`: the page it names, or the front page when it names none. */
export const HELP_PAGES = ["agent", "dev"] as const;

/** The verbs an agent reaches for, one page in: every line whose entry says so, then the flags every verb takes,
 * the exit codes and the notes on how a turn ends. */
export function agentPage(): string {
  return [
    "the verbs an agent on this computer reaches for, and the lines you type yourself:",
    "up and down for the host, recipe and image for what a workspace starts from.",
    pageLines("agent"),
    "",
    "  wsp run and wsp send stream the reply as it arrives and print it once: on a",
    "  terminal the streamed copy is the reply, and into a pipe stdout carries it whole",
    "  at the end.",
    wrap(`  ${TURN_END_WORDS}.`, 80).join("\n"),
    "  wsp exec streams the command's output and exits with its code. run, send and",
    "  exec wake a paused workspace first, with one line on stderr saying so.",
    "",
    "every verb takes:",
    ...(["json", "state", "host"] as const).flatMap(name => wrap(`  ${`--${name}`.padEnd(15)}${COMMON_FLAG_WORDS[name]}`, HELP_WIDTH, " ".repeat(17))),
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
      "You need these only for a host on a computer that is not the one you are sitting at: wsp login signs this computer in to your account and wsp hosts lists the hosts on it, which need no code at all. pair hands out the code a browser on another computer types to open a host, and it runs at that host's own terminal; devices lists the computers that hold a token for a host and takes one back out, from that terminal or from any computer signed in to it; link and unlink put the host on this computer onto your account, so it is reachable with no port open to the world.",
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
 * that do, so the sentences live beside the rule rather than in a page nobody reads to the end.
 *
 * One word can have a row per command where it means different things there: a flag's readers are every row that
 * names it, and each command's own help prints the row written for it. A single row answering for two commands
 * put both meanings in one paragraph, which is a page teaching rather than reminding. */
export interface SharedFlag {
  name: Extract<keyof SharedFlags, string>;
  /** The words of every command that reads it. */
  on: readonly string[];
  says: string;
}

export const SHARED_FLAGS: readonly SharedFlag[] = [
  { name: "state", on: SHARED_WORDS, says: `the state file: this word first, else WSP_HOME's state.json, else ./.wsp/state.json when the current directory is a checkout of wsp, else state.json in the home the running host serves` },
  { name: "version", on: ["up"], says: "print the version of this wsp and stop; typed alone, it is the whole line" },
  { name: "port", on: ["up"], says: `the port the app and the runtime websocket are served on (default ${DEFAULT_PORT})` },
  { name: "listen", on: ["up"], says: `the address to bind (default ${LOOPBACK}, this computer alone). No page carries the host's token on any address: the desktop attaches by the token file beside the state, the browser wsp init opens is let in by init, and every other browser pairs for a device token of its own` },
  { name: "advertise", on: ["up"], says: "the address a computer being joined dials this host at; without it, the relay's name or what this computer answers on" },
  { name: "no-relay", on: ["up"], says: "serve without the tunnel, on a computer that is linked to a relay" },
  { name: "service", on: ["up"], says: "install the host as a launchd agent on a Mac or a systemd user unit on Linux, which serves now and again at every login. The keys are not written into it: it reads the same .env a terminal run reads, so they have to be in a file" },
  ...(CLOUD_ON ? [{ name: "provider" as const, on: ["up", "init"], says: "which machine provider this computer forks on; without it, a key saved under a provider's own variable wires that provider" }] : []),
  { name: "code", on: ["join"], says: "the code the other computer printed: wsp add on the host" },
  { name: "code-file", on: ["join"], says: "read the code off this file and delete the file before dialing, so a code never sits on a disk" },
  { name: "watch", on: ["status"], says: "draw the same rows again every second where they stand, until Ctrl-C; it needs a terminal to redraw on, and reads nothing but this computer's own agent" },
  { name: "name", on: ["host link", "add", "join"], says: "the name to call the computer by here; what its address calls it without one" },
  { name: "ssh-port", on: ["add"], says: "the port ssh dials that computer on (default 22)" },
  { name: "ssh-key", on: ["add"], says: "the key file ssh logs in with; whatever your own ssh config and agent already use without it" },
  { name: "host-key", on: ["add"], says: "the host key of a computer this one has never dialled, as you read it on that computer; without it the add shows you the key that computer answers with and asks, and off a terminal it refuses rather than trusting whatever answers" },
  { name: "recipe", on: ["add"], says: "the saved recipe a computer added over ssh is set up from once it joins, or with --resume the one it is set up from now; wsp recipes lists them. Without it a computer joins and waits on what goes on it, with the base tools going on meanwhile" },
  { name: "later", on: ["add"], says: "go on past a sign-in that waits on you and leave it waiting, rather than waiting here for it; wsp add <computer> --resume follows it again, and asks for a fresh page and code only where the last one ran out" },
  { name: "resume", on: ["add"], says: "the computer named is already added, or joined and waits on what goes on it: set it up, from --recipe where given, else from what it holds, running only what is missing" },
  { name: "update", on: ["add"], says: "the place named is already in this wsp: put the daemon this wsp deploys on it, over the link it is holding or over the ssh road it was added on, restart its agent and keep the workspaces standing on it" },
  { name: "sign-in", on: ["add"], says: "the agent to sign in on the place named, once, outside every workspace on it: the sign-in runs on that computer and every workspace there shares the one login. Offered by the join itself; this is the same road for a computer already in" },
  { name: "yes", on: ["init"], says: "take every default and ask nothing, which a run off a terminal needs; a login with a browser or device sign-in, or one held in the Keychain, is left to the first time you need it on the workspace unless a saved recipe answered copy, so macOS has nothing to ask either and the build waits on nobody" },
  { name: "yes", on: ["doctor"], says: "also delete the snapshots and templates this host left behind, which is not reversible" },
  { name: "recipe", on: ["init"], says: "tick the agents and tools from this recipe (wsp recipe writes it) and go straight to the sign-ins" },
  { name: "project", on: ["init"], says: "the project folder you are bringing first; its own files say what it needs, and those rows are ticked first" },
  { name: "on", on: ["init"], says: "the computer the image is built on, by the name wsp computers lists, a box you joined included; the default place without it" },
  { name: "on", on: ["add"], says: "the computer a project lives on, by the name wsp computers lists: a repo a computer clones needs one, and a folder here or a repo cloned --into a folder here takes none" },
  { name: "into", on: ["add"], says: "the empty folder on this computer to clone a repo into, one that does not exist yet or holds nothing; the project is then that folder, worked where it sits" },
  { name: "base", on: ["add"], says: "the branch a workspace of the project starts on; the remote's own default branch at the clone without it" },
  { name: "yes", on: ["add"], says: "send the ticked rows of the seed menu; without it a folder seeding a project on another computer prints the menu and sends nothing, since what git ignores in your folder is yours" },
  { name: "keep", on: ["add"], says: "one more path off the seed menu that travels, however the catalogue ticked it; given once per path" },
  { name: "cut", on: ["add"], says: "one path off the seed menu that does not travel; given once per path" },
  { name: "no-memory", on: ["add"], says: "leave this folder's Claude Code memory here; the project's own memory on that computer then starts empty" },
  { name: "no-commits", on: ["add"], says: "leave the commits the remote does not have here; the computer's clone then starts at the remote's own tip" },
  { name: "remember", on: ["add"], says: "keep these ticks for this folder, so the next add of it starts with them rather than the catalogue's" },
  { name: "first-workspace", on: ["init"], says: "fork the first workspace under this name once the image seals, without asking (default first)" },
  { name: "import", on: ["init"], says: "import this folder's project onto that first workspace, with the consent the app's import starts from" },
  { name: "rebuild", on: ["init"], says: "seal the next version from a fresh machine rather than from your image plus the changes, which is the question a run at a terminal is asked; without it a run that asks nothing takes whichever road the changes call for" },
  { name: "no-local", on: ["init"], says: "leave this computer alone; the workspace step ticks it by default, since a workspace here forks nothing and bills nothing" },
  { name: "non-interactive", on: ["init"], says: "ask nothing, but still run the sign-ins on the machine: each prints the page to open on this computer, the code when the flow shows one, and the command that opens it, then waits for you" },
  { name: "local", on: ["doctor"], says: "prove this computer alone: a thread here and its reply, with no machine, no key, nothing forked and nothing billed" },
  { name: "project", on: ["doctor"], says: "the project the doctor's workspace is made of, by name, on the computer named; the first project there whose checkout stands when absent" },
];

/** Every command that reads one flag, over each of its rows: a word with a row per command is read by all of them,
 * so nothing refuses a flag one of its own rows names. */
export const readers = (name: string): string[] => SHARED_FLAGS.filter(f => f.name === name).flatMap(f => f.on);

/** What one command's own `--help` prints: its usage, what it does, and its own flags, one line each. */
export function commandPage(words: string, command: Command): string {
  return helpPage(command.usage, wrap(`  ${command.about}`, HELP_WIDTH, "  "), [
    ...SHARED_FLAGS.filter(f => f.on.includes(words)).map(f => [`--${f.name}`, f.says] as const),
    ...(command.json ? [["--json", COMMON_FLAG_WORDS.json] as const] : []),
    ...(command.host === "refused" ? [] : [["--host", command.host === "hostSide" ? COMMON_FLAG_WORDS.hostSide : COMMON_FLAG_WORDS.host] as const]),
  ]);
}

/** What each flag the tool server reads says on its own page. Its parse is its own, so its words are too; the page
 * they print on is the one every other line prints on. */
const MCP_FLAG_WORDS: Readonly<Record<string, string>> = {
  agent: `the agent to write the server, this skill and wsp's own section of AGENTS.md into, by catalog id (${MCP_AGENT_IDS}); repeats, and off a terminal every agent whose own command is on this computer's PATH takes it`,
  remove: "take the server, the skill and that section back out of those agents instead",
  json: "print what each agent took as one JSON object",
  state: COMMON_FLAG_WORDS.state,
  host: "write the server against a host on your account, by the name wsp hosts lists it under, so the tools drive that host",
  scoped: "what the host puts on a thread's own tools: without the launch pair in the environment the server refuses rather than dial this computer's host on its own token",
  "no-slate": "what the host puts beside it for a thread another thread started, which has no slate: the server's instructions say nothing of one",
};

/** The tool server's own two pages, each with the flags it reads. `wsp mcp` alone serves; `wsp mcp install` writes
 * an agent's config. Both were two usage lines and no words until a person asked what --agent took. */
function mcpPage(install: boolean): string {
  const line = COMMAND_LINES.find(l => l.words === (install ? `${MCP_COMMAND} install` : MCP_COMMAND))!;
  const flags = install ? ["agent", "remove", "json", "state", "host"] : ["state", "host", "scoped", "no-slate"];
  return helpPage(line.usage, wrap(`  ${line.about}`, HELP_WIDTH, "  "), flags.map(name => [`--${name}`, MCP_FLAG_WORDS[name]!] as const));
}

/** `run` is how this process was started, which the MCP install writes into an agent's config as the way to start it
 * again; the desktop's bundled command hands in its shim, the npm command the default reading. `env` is the
 * environment the verbs run with, this process's for a real command line and its own for a test. `start` is what
 * brings a host up when none serves the state file: the one built from `run` unless a caller says otherwise, and
 * `false` for a caller that wants a line with no host to refuse rather than start one. `caller` is where the line was
 * typed: the folder, which a thread with no workspace is placed by, and whether that place is somewhere other than
 * this computer, which is what every rule that would read a path here reads. This process's own folder and here by
 * default; a line typed inside a machine says both. */
export async function cli(
  argv: string[],
  io: CliIO = terminalIO(),
  run: RunningWsp = runningWsp(),
  given: Readonly<Record<string, string | undefined>> = process.env,
  start?: HostStarter | false,
  caller: { cwd?: string; elsewhere?: boolean } = {},
  deps: CommandDeps = SYSTEM_COMMAND_DEPS,
): Promise<number> {
  const env = given;
  const starter = start ?? starterFor(run, env);
  const starts = starter === false ? {} : { start: starter };
  // One reading for every road out of this process, and the sentence about it said once: a verb, a command and the
  // tool server all pick their state here, so none of them can run against a state another of them named.
  const chooseState = (flag?: string): string => statePathFrom(flag, env, line => io.error(line));
  // The flags every line shares are taken off the whole line here, before the words that select the line are read,
  // so one of them binds wherever it was typed and what is left reaches its own parse in the order it was given.
  const { common, rest } = takeCommon(argv);
  const cloudLine = cloudLineOf(rest);
  if (cloudLine !== undefined) return failed(io, jsonAsked(argv), cloudOffRefusal(cloudLine));
  const verb = findVerb(rest);
  if (verb !== undefined) {
    const words = verb.name.split(" ");
    return runVerb(verb, [...words, ...common, ...rest.slice(words.length)], io, chooseState, { alsoHere, cwd: caller.cwd ?? process.cwd(), env, open: systemOpener(), ...starts, ...(caller.elsewhere === true ? { elsewhere: true } : {}) });
  }
  if (rest[0] === MCP_COMMAND) {
    const argv = [...common, ...rest.slice(1)];
    return mcp(io, argv, chooseState, run, env, starts);
  }
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
  const opts = { ...optsFor(values, env, line => io.error(line)), ...starts, running: run };
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
  const cloudFlag = CLOUD_ON ? undefined : SERVE_FLAGS.find(f => f.cloud === true && values[f.name] !== undefined);
  if (cloudFlag !== undefined) return failed(io, json, cloudOffRefusal(`wsp ${words} --${cloudFlag.name}`));
  // A flag another command of the shared parse reads: the union is one parse, so the line that does not read it is
  // told which lines do rather than taking it and doing nothing with it.
  const foreign = SHARED_FLAGS.find(f => values[f.name] !== undefined && !readers(f.name).includes(words));
  if (foreign !== undefined) {
    return failed(io, json, usageRefusal(foreignFlagLine(`--${foreign.name}`, readers(foreign.name).map(w => `wsp ${w}`), `wsp ${words}`), `usage: ${command.usage}`));
  }
  try {
    return await command.run(io, opts, values, asked.slice(words.split(" ").length), deps);
  } catch (e) {
    return failed(io, json, e);
  }
}
