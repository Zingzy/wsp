// SPDX-License-Identifier: AGPL-3.0-only
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { computeRecipe, nodeHost, scanProject } from "@wsp/collect";
import { THREAD_AGENTS } from "@wsp/catalog";
import { jsonLine, imageHomeKeptLine, forksNoMachines, initJobOver, InitSetup, NO_BUILD_PLACE_LINE, shellQuote, THIS_COMPUTER, usageRefusal } from "@wsp/protocol";
import { providerBackendFor, providerKeyRow, wiredProviderId, type ProviderEnv } from "../providers.js";
import { DAEMON_DEPLOYED_LINE, deployDaemon, missingBundleFile } from "../doctor.js";
import { envFileFor, writeEnvFile } from "../env-keys.js";
import { keychainReader } from "../init-import.js";
import { adoptLoginPath } from "../login-path.js";
import { readBrewTable } from "../init-brew.js";
import { runInit, type InitIO, type InitPricing, type InitResult } from "../init.js";
import { runMintHere } from "../init-vault.js";
import { historyCache } from "../recipe-file.js";
import { alsoHere } from "../scan.js";
import { builtOn, opening } from "../init-opening.js";
import { runLocalInit } from "../init-local.js";
import type { ServedAt } from "../init-serve.js";
import { askFirst } from "../init-first.js";
import { buildBesideHost } from "../init-beside.js";
import { startCallbackRelay, systemOpener } from "../relay.js";
import { hostRunDir, heldOrStarted, servingHost, type HostLock } from "../host-lock.js";
import { placeWiring } from "../places.js";
import { workspaceRoads } from "../server.js";
import { hostPlatform, dialHost, type HostClient } from "../verbs.js";
import { VERSION } from "../version.js";
import { type CliIO, jsonCliIO } from "./io.js";
import { keySources, loadKeys, keysFound, vaultNow } from "./keys.js";
import { statesHere } from "./state.js";
import { type ServeAsked, SERVE_FLAGS, type SharedOpts, type SharedFlags } from "./flags.js";
import { goldenRecipe, makeRuntime, collectThisComputer, projectFolder, workspaceEnvsFor } from "./wiring.js";
import { stopOnSignals, stayOnUncaught, hostFor } from "./serve.js";

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
    atExit: fn => void process.once("exit", fn),
    ...(json ? { json: (record: Record<string, unknown>) => void process.stdout.write(`${jsonLine(record)}\n`) } : {}),
  };
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

/** A serving host that can start no build: its init job would refuse at the first stage, so the run says so before
 * it reads this computer, in the host's own sentence for why. The places are the host's, not this terminal's: it is
 * the process that builds. */
function noGoldenThroughHost(lock: HostLock, statePath: string, why: string): string {
  return `wsp init: the wsp host serving ${statePath} (pid ${lock.pid}) can build no image: ${why}. Then run wsp init again.`;
}

/** What the run reads off the host serving this state before it asks anything: the door to build through, the place
 * the image is built on and what a builder there costs, and where the app it already serves answers. */
interface BesideHost {
  client: HostClient;
  place: { id: string; name: string };
  pricing: InitPricing;
  /** The provider that host forks on, which no flag of this run's can move; absent on a host of an earlier build,
   * which does not say. */
  forksOn?: string;
  /** Where the app that host already serves answers. */
  at: ServedAt;
}

/** The refusal a provider named on this line meets beside a serving host: that host runs the build, on the provider
 * it forks on, and a word on this line reaches no runtime of this run's. Nothing where it already forks where the
 * line names, which is the build that was asked for, and nothing where the host does not say which provider it is.
 * The word is compared and not the name typed, so a stand-in named for a cloud reads as that cloud on both sides.
 * The way back is this run's own wsp up line, composed where every other one this file hands over is, so it names
 * the state file, the ports and the provider as they were typed rather than the provider alone. */
export function providerBesideRefusal(lock: HostLock, opts: SharedOpts, forksOn: string | undefined, upCommand: string): Error | undefined {
  const given = opts.provider;
  if (given === undefined || forksOn === undefined || forksOn === wiredProviderId(opts.providerEnv)) return undefined;
  return usageRefusal(
    `wsp init: the wsp host serving ${opts.statePath} (pid ${lock.pid}) runs this build and forks on ${forksOn}, not ${given}`,
    `Drop --provider, or take that host down and start it again with ${upCommand}.`,
  );
}

/** Opens the door of the host serving this state, or refuses with the way back that needs no pid. The place, the price
 * and the builder disk come from that host: it owns the places, so a terminal that named none (or another) still
 * asks the person about the machine the build will really boot. `on` is the place --on named; absent, the host's
 * default place. `upCommand` is the wsp up line this run was given, which the provider refusal hands over. */
async function besideHost(lock: HostLock, opts: SharedOpts, upCommand: string, on?: string): Promise<BesideHost> {
  const statePath = opts.statePath;
  const refuse = (why: string): Error => Object.assign(new Error(initRefusal(lock, statePath, why)), { kind: "conflict" });
  let client: HostClient;
  try {
    // The host holding this state file's lock and no other: WSP_HOST and the account's one host aim a verb at another
    // computer, and the build belongs to the process that writes this file.
    // No starter is handed in: the lock was read before this call, and an init that started a host under itself
    // would be building through a host it is about to replace.
    client = await dialHost(statePath, { aim: { kind: "here" } });
  } catch (e) {
    throw refuse(e instanceof Error ? e.message : String(e));
  }
  try {
    const setup = InitSetup.parse((await client.request<{ setup: unknown }>("init.get", on === undefined ? {} : { on })).setup);
    // Before anything this run judges about that host: a provider this build cannot land on is the person's own to
    // fix, whether or not the host could build at all, so they read the word they typed and not a second round. A
    // place --on named that the host cannot build at is refused by the request above, and is read before this one.
    const refused = providerBesideRefusal(lock, opts, setup.forksOn, upCommand);
    if (refused !== undefined) throw refused;
    const job = setup.job;
    if (job !== null && !initJobOver(job.phase)) throw refuse(`a setup is already running there (${job.phase})`);
    if (setup.pricing === null || setup.place === undefined) throw Object.assign(new Error(noGoldenThroughHost(lock, statePath, setup.buildRefusal ?? NO_BUILD_PLACE_LINE)), { kind: "conflict" });
    const price = setup.pricing;
    return {
      client,
      place: setup.place,
      pricing: { rateUsdPerHour: () => price.rateUsdPerHour, defaultSize: price.size, ...(price.builderDiskGb !== undefined ? { builderDiskGb: price.builderDiskGb } : {}) },
      ...(setup.forksOn !== undefined ? { forksOn: setup.forksOn } : {}),
      at: { port: lock.port, address: lock.address },
    };
  } catch (e) {
    client.close();
    throw e;
  }
}

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

/** wsp init's flags that only mean something on the golden road, each with how it was given: the local road refuses
 * them rather than take them and do nothing. One row per flag, beside the table that parses them. */
const GOLDEN_FLAGS: readonly [string, (flags: { recipe?: string; project?: string; firstWorkspace?: string; importFolder?: string; on?: string; rebuild?: boolean }) => boolean][] = [
  ["--recipe", f => f.recipe !== undefined],
  ["--project", f => f.project !== undefined],
  ["--first-workspace", f => f.firstWorkspace !== undefined],
  ["--import", f => f.importFolder !== undefined],
  ["--on", f => f.on !== undefined],
  ["--rebuild", f => f.rebuild === true],
];

/** The build handed to the host serving this state: the workspace question is asked here, where the person is, and
 * everything from the first billed machine on happens in that host's job. Its own init job forks no workspace for
 * this computer, so the tick beside the question is not offered; a thread in the folder is that road. */
async function handOffTo(beside: BesideHost, statePath: string, screen: InitIO, interactive: boolean, flags: { yes: boolean; rebuild?: boolean; firstWorkspace?: string; importFolder?: string; on?: string }): Promise<number> {
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
  return buildBesideHost({ client: beside.client, io: screen, ...(fork !== undefined ? { fork } : {}), ...(flags.yes ? { yes: true } : {}), ...(flags.rebuild === true ? { rebuild: true } : {}), ...(flags.on !== undefined ? { on: flags.on } : {}), app: { at: beside.at, runDir: hostRunDir(statePath), interactive } });
}

/** How a line that says this computer forks nothing offers the way out of it: the variable the row a key typed here
 * would be put to, and nothing at all where no row reads a key. */
function orSetTheKey(env: ProviderEnv): string {
  const name = providerKeyRow(env)?.keyEnv;
  return name === undefined ? "" : `, or set ${name} first`;
}

export async function init(
  io: CliIO,
  opts: SharedOpts,
  flags: { yes: boolean; nonInteractive: boolean; json: boolean; noLocal: boolean; rebuild?: boolean; recipe?: string; project?: string; firstWorkspace?: string; importFolder?: string; on?: string; upCommand: string },
): Promise<number> {
  if (flags.json && flags.yes) throw usageRefusal("wsp init: --json prints the sign-ins as they are handed to you, and --yes skips the sign-ins, so there would be nothing to print.", "Drop one of them.");
  // With --on the build is always the host's, whose objects land on its job and not on this stdout, so the pair is
  // refused before a host is started for a run that could print nothing.
  if (flags.json && flags.on !== undefined) throw usageRefusal(`wsp init --json prints the build's own objects, and with --on the build is run by the host serving ${opts.statePath}: its sign-ins and stages ride its own setup, which wsp setup --json reads.`, "Drop --json, or drop --on to build on this computer's provider.");
  await adoptLoginPath(line => io.log(line));
  // The places are the serving host's: a run with none serving builds on its own provider and knows no other place.
  const held = flags.on === undefined ? servingHost(opts.statePath) : await heldOrStarted(opts.statePath, opts.start, line => io.error(line));
  if (held === undefined && flags.on !== undefined) throw usageRefusal(`wsp init: --on names a place of the host serving ${opts.statePath}, and none is serving it.`, "Start it with wsp up and run wsp init --on again, or drop --on to build on this computer's provider.");
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
  const beside = held === undefined ? undefined : await besideHost(held, opts, flags.upCommand, flags.on);
  opening(screen, { command: "init", version: VERSION, yes: flags.yes, statePath: opts.statePath });
  const { keys, env: providerEnv } =
    beside !== undefined ? { keys: keysFound(keySources(opts.providerEnv, opts.statePath)), env: opts.providerEnv } : await loadKeys(say, keySources(opts.providerEnv, opts.statePath), { anthropic: false, noProviderKey: "offer", checkSaved: true });
  // One wiring for every runtime this run builds and for the host it serves at the end: the links and the recipe
  // planner are the same on both roads below.
  const links = placeWiring(opts.statePath, opts.advertise);
  // The first screen names where the image is built: the host's place, or the provider this run itself forks on.
  const builds = beside !== undefined ? beside.place.name : forksNoMachines(providerBackendFor(providerEnv).capabilities) ? undefined : wiredProviderId(providerEnv);
  if (builds !== undefined) builtOn(screen, builds, beside === undefined ? undefined : imageHomeKeptLine(flags.on, beside.place));
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
        ports: { port: opts.port, named: opts.named, states: statesHere(opts.statePath) },
        address: opts.address,
        upCommand: flags.upCommand,
        runtime: () => makeRuntime(keys, opts.statePath, goldenRecipe(), providerEnv, undefined, undefined, links),
        roads: rt => workspaceRoads(rt, workspaceEnvsFor()),
        host: (rt, ports) => hostFor(rt, keys, { ...opts, port: ports.port, providerEnv, links }, say),
      },
      screen,
    );
    if (local.handle !== undefined) {
      stopOnSignals(local.handle, say);
      stayOnUncaught(say);
    }
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
        ...(flags.rebuild === true ? { rebuild: true } : {}),
        collect: collectThisComputer,
        recipe: (onHistory, onProject, onHistoryProgress) =>
          computeRecipe(nodeHost(), { threadAgents: THREAD_AGENTS, onHistory, onProject, onHistoryProgress, cache: historyCache(opts.statePath), ...(project !== undefined ? { folders: [project] } : {}) }),
        scanProject: async folder => {
          const { path, exists } = projectFolder(folder);
          return exists ? scanProject(nodeHost(), path) : undefined;
        },
        vault: () => vaultNow(opts.statePath),
        mintHere: runMintHere,
        saveKeys: set => writeEnvFile(envFileFor(opts.statePath), set),
        pricing: beside?.pricing ?? providerBackendFor(providerEnv).pricing,
        provider: wiredProviderId(providerEnv),
        statePath: opts.statePath,
        home: homedir(),
        secrets: keychainReader(),
        platform: hostPlatform(),
        brew: () => readBrewTable(nodeHost()),
        scan: alsoHere,
        runtime: recipe => makeRuntime(keys, opts.statePath, { ...recipe, deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE) }, providerEnv, undefined, undefined, links),
        bundleFile: () => missingBundleFile(),
        ports: { port: opts.port, named: opts.named, states: statesHere(opts.statePath) },
        address: opts.address,
        upCommand: flags.upCommand,
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
        roads: rt => workspaceRoads(rt, workspaceEnvsFor()),
        host: (rt, ports) => hostFor(rt, keys, { ...opts, port: ports.port, providerEnv, links }, say),
        ...(beside !== undefined ? { handOff: (o: { interactive: boolean }) => handOffTo(beside, opts.statePath, screen, o.interactive, flags) } : {}),
      },
      screen,
    );
  } finally {
    beside?.client.close();
  }
  if (result.handle !== undefined) {
    stopOnSignals(result.handle, say);
    stayOnUncaught(say);
  }
  return result.code;
}
