// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import type { Runtime, Store } from "@wsp/runtime";
import { holdsNothing, fmtDuration, isLoopback, listenBeyondLoopbackLine, loopbackThreadsLine, portInsteadLine, PORT_TAKEN_REFUSAL, portTakenLine, usageRefusal } from "@wsp/protocol";
import { providerEnvWith, providerKeyRow, type ProviderEnv } from "../providers.js";
import { releaseUpdateLine } from "../daemon-fix.js";
import { envFileFor, keyIn } from "../env-keys.js";
import { adoptLoginPath } from "../login-path.js";
import { hereAnswering, hereLines, openHere, type HereWatch } from "../place-here.js";
import { watchBlock, watchOn, type Redraw, type WatchSignals } from "../watch.js";
import { addressLines, hostLogPath, SERVICE_WAIT_MS, servingHost, STARTED_BY_ENV, type HostLock, type HostStarted } from "../host-lock.js";
import { hostThereLines, httpProbe, installService, logTail, noManagerLine, runFailureLine, serviceAddressHere, serviceEnv, serviceManagerFor, serviceReading, statusLines, stopService, systemRunner, untilLock, untilServing, type HostProbe, type ServiceManager, type ServiceRunner } from "../service.js";
import { aimAddress, aimName, type HostPick, namedHost, stateIgnoredLine } from "../hosts.js";
import { hereUrl } from "../pairing.js";
import { placeWiring } from "../places.js";
import type { HostHandle } from "../server.js";
import { choosePorts, type PortProbes, type PortsPicked } from "../ports.js";
import { runningWsp, type RunningWsp } from "../mcp-install.js";
import { NO_PROJECT_YET, type DialOpts, dialHost, type HostClient } from "../verbs.js";
import { VERSION } from "../version.js";
import { latestWords, releaseReading } from "../release.js";
import type { CliIO } from "./io.js";
import { type KeySources, keyLayers, keySources, loadKeys } from "./keys.js";
import { statesHere, stateStore } from "./state.js";
import { type ServeAsked, SERVE_FLAGS, type SharedOpts } from "./flags.js";
import { goldenRecipe, makeRuntime } from "./wiring.js";
import { type ServeOptions, hostFor } from "./serve.js";

/** The state file read once, before anything else on this host reads it: a file written in a shape this build does
 * not read is refused at every collection read, and the readers a runtime builds meet that refusal in the middle of
 * their own work, where one of them warns with the whole error and its stack behind a line of its own. It comes
 * before the wiring a runtime is built with, which mints this host's pairing key beside the state file on its own
 * first read: a start refused here leaves the home as it found it. Read here, the refusal is this start's, thrown
 * once and printed once, and the store is handed on so the file is not read twice over. */
async function readOnce(statePath: string, env: Readonly<Record<string, string | undefined>>): Promise<Store> {
  const store = stateStore(statePath, env);
  await store.keys("workspaces");
  return store;
}

async function servesNothing(rt: Runtime): Promise<boolean> {
  return holdsNothing(await rt.golden.get(), await rt.workspaces.list());
}

export async function up(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  await adoptLoginPath(line => io.log(line));
  // A state file with nothing but this computer in it is served with no provider key: wsp init's local road is
  // what wrote it, and asking for a key to serve it would take that road away the next morning.
  const { keys, env: providerEnv } = await loadKeys(io, keySources(opts.providerEnv ?? process.env, opts.statePath), { anthropic: false, noProviderKey: "local" });
  // Read first, for the reason readOnce carries. A runtime handed in holds its own store, so no other is read.
  const store = opts.runtime === undefined ? await readOnce(opts.statePath, providerEnv) : undefined;
  const links = placeWiring(opts.statePath, opts.advertise);
  const here = opts.here ?? {};
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath, goldenRecipe(), providerEnv, { here, ...(opts.running !== undefined ? { run: opts.running } : {}) }, undefined, links, store);
  try {
    // A state with nothing in it serves as it is: a workspace is one project's copy, so a host with no project has
    // no workspace to record, and wsp add is the road. The host listens for pairing either way.
    if (await servesNothing(rt)) io.log(NO_PROJECT_YET);
    // The road is written into the lock here and nowhere else: this is wsp up, so wsp down stops what it serves.
    return await hostFor(rt, keys, { ...opts, providerEnv, links, here, startedBy: opts.startedBy ?? "up" }, io, opts.running);
  } catch (e) {
    // A refusal thrown past a runtime this start built leaves the daemon that listing the workspaces dialled and
    // the timers behind it running, and the process stays up on them after the sentence is printed. A runtime a
    // caller handed in is that caller's to close.
    if (opts.runtime === undefined) await rt.close().catch(() => {});
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
   * answer a test hands over rather than the folder the test runner happens to sit in. The state file is not among
   * them: it is the command's own, and the .env beside it is what the host this unit starts will read. */
  keys: Omit<KeySources, "statePath">;
  /** Whether the host the lock names answers on its port. */
  answers: HostProbe;
  /** The one dial, for the status of a host on another computer: nothing on this computer says whether it is up. */
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  /** Asks the pid the lock recorded to end, for a host a verb started and no terminal holds. */
  stop(pid: number): void;
  /** The link to this computer's own daemon when it is joined to somebody else's wsp, and nothing when it is joined
   * to none: opened off its own place file, with no host anywhere in the road. The caller closes it. */
  here(home: string): Promise<HereWatch | undefined>;
  /** Where a --watch's stop arrives. This process by default; a test hands in its own, since a real signal would
   * take the test runner with it. */
  signals?: WatchSignals;
}

/** Which line brought a host up, in the words every sentence about it uses: a person who typed wsp up reads their
 * own line back, a host a verb started for itself is nobody's line, and the one this computer's manager holds up
 * is the service. */
const HOST_ROAD_WORDS: Readonly<Record<HostStarted, string>> = { up: "wsp up", verb: "a verb", service: "the service" };
export const hostRoadWord = (started: HostStarted): string => HOST_ROAD_WORDS[started];

/** What wsp down says for a host the command line brought up, whichever of its two roads did: the same shape the
 * service's own stop line takes, naming the road. */
export const hostStoppedLine = (started: HostStarted, pid: number, statePath: string): string =>
  `stopped the host ${hostRoadWord(started)} started (pid ${pid}); nothing serves ${statePath} now`;

export function systemService(): ServiceDeps {
  const os = platform();
  return { platform: os, manager: serviceManagerFor(os), run: systemRunner, waitMs: SERVICE_WAIT_MS, keys: { env: process.env, cwd: process.cwd() }, answers: httpProbe, dial: dialHost, stop: pid => process.kill(pid, "SIGTERM"), here: home => openHere(home) };
}

/** The line the service runs: this node and this wsp, or the app's shim where this wsp runs behind one, serving the
 * state file, the ports, the address and the provider the install was given. Every word is spelled out, since a
 * service has no cwd of the person's to read a default from and no shell of theirs to read a variable from. The
 * shim is the app's program because the app's binary is node only under the variable the shim sets, which a unit
 * naming that binary would start without, and because the shim's path outlives an update that moves the bundle. */
export function serviceArgv(asked: ServeAsked, run: Pick<RunningWsp, "shim"> = {}): string[] {
  const serving = ["up", ...SERVE_FLAGS.flatMap(flag => flag.words(asked))];
  if (run.shim !== undefined) return [run.shim, ...serving];
  const bin = process.argv[1];
  if (bin === undefined) throw new Error("wsp up --service needs the path wsp was started from, and this process has none");
  return [process.execPath, resolve(bin), ...serving];
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
export function keyOnlyInThisShell(sources: KeySources, env: ProviderEnv = sources.env): string | undefined {
  const name = providerKeyRow(env)?.keyEnv;
  if (name === undefined || !onlyInThisShell(name, sources)) return undefined;
  return `wsp up --service: a service starts without your shell, so it reads its provider key from a file. ${name} is only in this shell's environment; put it in ${envFileFor(sources.statePath)} first.`;
}

/** The Claude key is not needed to serve, so it is a word rather than a refusal; without it every workspace the
 * service forks has no claude credentials, and the installing shell is the one place the reading looks complete. */
export function claudeKeyOnlyInThisShell(sources: KeySources): string | undefined {
  if (!onlyInThisShell("ANTHROPIC_API_KEY", sources)) return undefined;
  return `note: ANTHROPIC_API_KEY is only in this shell's environment, so the service starts without it and the workspaces it forks get no claude credentials. Put it in ${envFileFor(sources.statePath)} to carry it over.`;
}

export async function upServiceCommand(io: CliIO, opts: ServeAsked & Pick<SharedOpts, "running">, deps: ServiceDeps): Promise<number> {
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
  // The layers this unit's host will read: the shell installing it, its folder, and the .env beside the state file
  // the unit is being written to serve. The row is picked out of all three, as that host will pick it at its own
  // start: read off the shell alone, this preflight would weigh a key for a provider the host it installs is not
  // wired to, and let the one it is wired to go with the shell.
  const sources: KeySources = { ...deps.keys, statePath: opts.statePath };
  const shellOnly = keyOnlyInThisShell(sources, providerEnvWith(opts, sources.env, keyLayers(sources)));
  if (shellOnly !== undefined) {
    io.error(shellOnly);
    return 1;
  }
  const claudeOnly = claudeKeyOnlyInThisShell(sources);
  if (claudeOnly !== undefined) io.log(claudeOnly);
  const at = serviceAddressHere(opts.statePath);
  const logPath = hostLogPath(opts.statePath);
  // The word the host this unit starts carries: it is the one registered to serve that state file, so it serves
  // where every other client on this computer is told to start the service instead. It is the host's own mark and
  // not a service's, so the agent on a joined computer, whose unit comes out of the same serviceEnv, carries none.
  const env = { ...serviceEnv(process.env), [STARTED_BY_ENV]: "service" };
  const { unit, installed, failure } = await installService(manager, { ...at, argv: serviceArgv(opts, opts.running), cwd: process.cwd(), env, logPath }, deps.run);
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
  if (hereUrl(opts.address, lock.port) === undefined) io.log(loopbackThreadsLine(opts.address));
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
  const at = serviceAddressHere(opts.statePath);
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
  const serving = servingHost(opts.statePath);
  // A host a line started holds the lock whatever unit the manager has, and only its pid stops it.
  const lineStarted = serving?.startedBy !== undefined && serving.startedBy !== "service";
  if ((!held && !installed) || lineStarted) {
    // A host the command line brought up is wsp down's to stop, whether a verb started it for itself or a person
    // typed wsp up: up and down are a pair. The pid comes off the lock that host wrote, never off a search for a
    // process that looks like it.
    if (serving?.startedBy !== undefined) {
      deps.stop(serving.pid);
      const left = await untilLock(opts.statePath, false, deps.waitMs);
      if (left !== undefined) {
        io.error(`wsp down: the host ${hostRoadWord(serving.startedBy)} started (pid ${left.pid}) is still serving ${opts.statePath}.`);
        return 1;
      }
      io.log(hostStoppedLine(serving.startedBy, serving.pid, opts.statePath));
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
  io.log(`${manager.words} ${unit.name} stopped; nothing serves ${opts.statePath} now, and its running turns keep going until the next host adopts them`);
  return 0;
}

/** The latest row's words off the file the host keeps, asking no host; nothing where no ask was ever kept. */
export function latestHere(statePath: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const reading = releaseReading(statePath, env);
  return reading === undefined ? undefined : latestWords(reading, VERSION, version => releaseUpdateLine(runningWsp(), version));
}

export async function statusCommand(io: CliIO, opts: { statePath: string; state?: string; watch?: boolean } & HostPick, deps: ServiceDeps): Promise<number> {
  // The one line that leaves this computer only when a person named a host: --host or WSP_HOST and nothing else.
  // A verb has a host to speak to whatever the line said, so it follows the fallbacks under those two, the default
  // alias among them; this line is the question whether the host here is serving, and an alias answering for a box
  // would hide the one thing it was run to learn.
  const aim = namedHost(opts);
  // A watch follows the agent on the computer it is typed at. Neither a host aimed at from here nor the host
  // serving here has one, so a --watch on either is refused rather than quietly printing one frame and stopping.
  if (opts.watch === true && aim !== undefined) {
    throw usageRefusal(`wsp status --watch reads the agent on the computer you are sitting at, and this line is aimed at the host on ${aimName(aim)}.`, `Run wsp status --watch in a terminal on that computer.`);
  }
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
  // A computer joined to somebody else's wsp runs no host and never will: what wsp is doing there is the agent it
  // joined with, so that is what this line reads, and nothing about a host it would only ever say was not running.
  // The refusal before the dial: a --watch with nowhere to redraw must not open a link to the daemon to say so.
  const watching = opts.watch === true ? watchOn("wsp status", { json: false, redraw: io.redraw }) : undefined;
  if (watching !== undefined && "refusal" in watching) throw watching.refusal;
  const home = opts.home ?? homedir();
  const joined = await deps.here(home);
  if (joined !== undefined) return hereStatus(io, joined, watching?.redraw, () => deps.here(home), deps.signals);
  if (opts.watch === true) {
    throw usageRefusal("wsp status --watch reads the agent on a computer joined to somebody's wsp, and this computer is joined to none.", "Run wsp status without --watch for the host serving here, or wsp threads --watch to follow what it runs.");
  }
  const reading = await serviceReading(deps.manager, serviceAddressHere(opts.statePath), deps.run, deps.platform);
  const lock = servingHost(opts.statePath);
  const host = lock === undefined ? undefined : { lock, answering: await deps.answers(lock) };
  for (const line of statusLines(opts.statePath, host, reading, Date.now(), latestHere(opts.statePath, opts.env ?? process.env))) io.log(line);
  return host?.answering === true ? 0 : 1;
}

/** The rows for a computer joined as a place, printed once or redrawn where they stand until Ctrl-C. The link is
 * the one `here` opened and it is held for every frame: the daemon's samplers stop with their last subscriber, so a
 * watch that dialled again per frame would stop them, wait out the whole of the first sample's interval again and
 * draw at a third of the rate every word about the flag promises. The frames come as the daemon pushes, with the
 * tick under them as the floor. Closed on every road out, the refusal's included. */
async function hereStatus(io: CliIO, first: HereWatch, redraw: Redraw | undefined, again: () => Promise<HereWatch | undefined>, signals?: WatchSignals): Promise<number> {
  let held = first;
  try {
    if (redraw === undefined) {
      const reading = held.reading();
      for (const line of hereLines(reading)) io.log(line);
      return hereAnswering(reading) ? 0 : 1;
    }
    // Nothing to hold means nothing to wait on, so a watch there would draw the same sentence for as long as
    // somebody looked at it. The one thing a person watches for after a join is the agent coming up, so the open is
    // tried again beside the frames rather than in them: a dial that takes its whole wait must not hold the tick.
    let reopening: Promise<void> | undefined;
    await watchBlock(
      async () => {
        if (!held.linked && reopening === undefined) {
          reopening = again()
            .then(next => {
              if (next === undefined) return;
              held.close();
              held = next;
            })
            .catch(() => undefined)
            .finally(() => (reopening = undefined));
        }
        return hereLines(held.reading());
      },
      { ...redraw, until: () => held.next(), ...(signals !== undefined ? { signals } : {}) },
    );
    return hereAnswering(held.reading()) ? 0 : 1;
  } finally {
    held.close();
  }
}

/** The pair wsp up binds: the one asked for when both ports are free, the next free pair with the port it stepped
 * over handed back for the caller to say once it serves, and nothing where a port a person named is held, which is
 * the whole run's refusal. The step is picked in silence because every refusal a start throws is thrown after this,
 * and a refusal is one sentence with nothing above it. The refusals here are the run's end, so they are printed
 * where they are read. The sentences are the protocol's, the same three wsp init's road prints, and a held port
 * never reaches the person as the bind's own error. */
export async function pickUpPorts(io: CliIO, opts: ServeAsked, probes: PortProbes = {}): Promise<PortsPicked | undefined> {
  const asked = { port: opts.port, named: opts.named };
  const where = { states: statesHere(opts.statePath), ...probes };
  const chosen = await choosePorts(asked, where);
  if (!("taken" in chosen)) return chosen;
  io.error(portTakenLine(chosen.taken.port, chosen.taken.holder));
  // The pair a person could have had, found the same way the unnamed road finds one, so the refusal hands over a
  // line to type rather than a number to guess.
  const free = await choosePorts({ ...asked, named: false }, where);
  io.error("taken" in free ? PORT_TAKEN_REFUSAL : portInsteadLine(free.ports));
  return undefined;
}
