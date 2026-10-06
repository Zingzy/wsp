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
import { HOST_STARTS_ITSELF, type Command, type CommandDeps, SYSTEM_COMMAND_DEPS, HOST_COMMANDS, HOST_WORD, HOST_LINES, findCommand, JSON_COMMANDS, MCP_COMMAND, MCP_OPTIONS, mcpInstallUsage, mcpUsage, COMMAND_LINES, SHARED_FLAGS, readers } from "./cli/commands.js";
export { HOST_STARTS_ITSELF, type HostFlag, type CommandDeps, SYSTEM_COMMAND_DEPS, DOCTOR_HANDLES_ENV, doctorKeyAsk, doctorRow, HOST_FLAG, HOST_COMMANDS, SHARED_WORDS, COMMANDS_FOR_HELP, HOST_WORD, HOST_LINES, JSON_COMMANDS, PROSE_COMMANDS, MCP_OPTIONS, type CommandLine, COMMAND_LINES, type SharedFlag, SHARED_FLAGS, readers } from "./cli/commands.js";
import { HELP, HELP_PAGES, agentPage, hostPage, devPage, commandPage } from "./cli/help.js";
export { HELP, HELP_PAGES, agentPage, hostPage, devPage, commandPage } from "./cli/help.js";


export type { Keys } from "./env-keys.js";

// The hosts file sits under the same home, so where that home is lives beside it and is re-exported here for every
// reader that already had it from the command line.
export { wspHome };

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
