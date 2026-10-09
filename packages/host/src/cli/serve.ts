// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { computeRecipe, nodeHost, scanProject } from "@wsp/collect";
import type { HostSsh, PlaceWiring, RestartDoor, Runtime } from "@wsp/runtime";
import { writeOwn } from "@wsp/own-file";
import { GUEST_HOME, THREAD_AGENTS } from "@wsp/catalog";
import { forksNoMachines, isLoopback, listenBeyondLoopbackLine, loopbackThreadsLine, LOOPBACK, verbFailure } from "@wsp/protocol";
import { checkProviderKey } from "@wsp/engine";
import { providerBackendFor, providerEnvWithKey, providerKeyRow, providerKeyRows, providerKeySet, wiredProviderId, type ProviderEnv } from "../providers.js";
import { webDirFor } from "../assets.js";
import { DAEMON_DEPLOYED_LINE, deployDaemon, missingBundleFile } from "../doctor.js";
import { releaseUpdateLine } from "../daemon-fix.js";
import { agentsHere } from "../agents-here.js";
import { InitJobs } from "../init-job.js";
import { envFileFor, keyIn, savedEnv, writeEnvFile, type Keys } from "../env-keys.js";
import { keychainReader } from "../init-import.js";
import { adoptLoginPath } from "../login-path.js";
import { readBrewTable } from "../init-brew.js";
import { exitCodeOf } from "../init.js";
import { recipePath } from "../init-recipe.js";
import { historyCache } from "../recipe-file.js";
import { alsoHere } from "../scan.js";
import { startCallbackRelay, systemOpener, type UrlOpener } from "../relay.js";
import { addressLines, hostTokenPath, lockPathFor, programGone, releaseLock, rewriteLock, startedByEnv, STARTED_BY_ENV, takeLock, type HostStarted } from "../host-lock.js";
import { starterFor } from "../host-start.js";
import { hostRoadOf, restartRoads, type RestartingHost, type RestartRoad } from "../restart.js";
import { stopRecordedConnector } from "../connector.js";
import { admittedDevices, readRelayRecord, relayOnLoopbackLine, startRelay } from "../relay-link.js";
import { wspHome } from "../hosts.js";
import { hereUrl, type HereAt } from "../pairing.js";
import { placeWiring } from "../places.js";
import { startHost, workspaceRoads, type HostDoctorReaders, type HostHandle } from "../server.js";
import { installEach, mcpServerSpec, refreshSkills, runningWsp, serversRefreshedLine, refreshServers, skillsRefreshedLine, type RunningWsp } from "../mcp-install.js";
import { hostPlatform } from "../verbs.js";
import { installedVersion, VERSION } from "../version.js";
import { releaseWatch } from "../release.js";
import { analyticsOff, hostAnalytics } from "../analytics.js";
import { followUsage, hostCommon } from "../analytics-events.js";
import type { CliIO } from "./io.js";
import { keySources, providerEnvNow, loadKeys, vaultNow } from "./keys.js";
import { goldenRecipe, hostRecipeWatch, swapProvider, makeRuntime, collectThisComputer, projectFolder, workspaceEnvsFor } from "./wiring.js";

/** The init job on this computer for a serving host: wsp init's own readers and build pieces, the keys read off the
 * .env beside the state file this host serves and nothing else at each ask (a key in this process's environment or
 * a checkout's .env is the terminal's and never reads as saved on a screen), the provider module swapped into the
 * runtime once a key is saved, and the wsp tools written by the road wsp mcp install takes, under the command this
 * process runs as. */
function hostInitDoor(rt: Runtime, statePath: string, run: RunningWsp, openUrl: UrlOpener, log: (line: string) => void, providerEnv: ProviderEnv): InitJobs {
  const home = homedir();
  const os = hostPlatform();
  return new InitJobs({
    rt,
    statePath,
    home,
    platform: os,
    saved: () => savedEnv(statePath),
    saveKeys: set => writeEnvFile(envFileFor(statePath), set),
    provider: saved => swapProvider(rt, saved),
    keysHeld: saved => Object.fromEntries(Object.entries(providerKeyRows()).map(([id, name]) => [id, keyIn(saved, name) !== undefined])),
    keySet: (key, provider) => providerKeySet(providerEnv, key, provider),
    keyProvider: () => providerKeyRow(providerEnv)?.id,
    // Read at each ask, as the pricing below is, and out of the same layers: a key saved while this host serves
    // swaps its module in, and a run beside it is told the provider it forks on now.
    forksOn: () => wiredProviderId(providerEnvNow(providerEnv, statePath)),
    checkKey: (key, provider) => checkProviderKey(providerBackendFor(providerEnvWithKey(providerEnv, key, provider))),
    // What this host's own provider charges and gives, not one provider's table: a host that forks containers has
    // no bill and no disk cap, and the screens read both off here.
    pricing: () => providerBackendFor(providerEnvNow(providerEnv, statePath)).pricing,
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
      scan: alsoHere,
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
      roads: () => workspaceRoads(rt, workspaceEnvsFor()),
      recipe: recipe => ({ ...recipe, deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE) }),
      bundleFile: () => missingBundleFile(),
    },
  });
}

/** The signals a serving host stops on. It is the only owner of them: nothing under it registers a handler of its
 * own, so no other listener can end this process while a close runs. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** What a stop needs of the process it is ending: where signals arrive and how it exits. The default is this
 * process; a test hands in its own, since a real signal would take the test runner with it. */
export interface StopProcess {
  /** The program this process runs, read again while it serves on Linux. */
  execPath: string;
  platform: string;
  on(signal: (typeof STOP_SIGNALS)[number], listener: () => void): unknown;
  exit(code: number): void;
}

/** How often a serving host checks that its own program is still there. */
export const OWN_FILES_POLL_MS = 5_000;

/** Every way a host is told to go ends the same: the lock removed and what this host holds open freed. The turns
 * running on this computer are not among them; each leads a process group of its own, so no signal arriving here
 * reaches one, and the host that comes next re-opens it. A hangup is one of these signals for that reason, and none
 * of them is left to node's default exit, which runs no close at all: a second signal, with a close still in
 * flight, exits at once, so a close that hangs cannot trap the terminal. On Linux a host whose own program has gone
 * (an AppImage's mount that went with its launch, a copy of the app since removed) stops the same way, since it
 * serves out of files it can no longer read; the lock reads it as holding nothing by the same fact. A Mac's app never
 * removes the files a host runs, so there a node upgrade under a host started by hand would be all it ever caught. */
export function stopOnSignals(handle: HostHandle, io: CliIO, self: StopProcess = process): void {
  let stopping: Promise<void> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  const stop = (sig: (typeof STOP_SIGNALS)[number]): void => {
    if (stopping !== undefined) {
      self.exit(exitCodeOf(sig));
      return;
    }
    clearInterval(watch);
    stopping = handle.close().then(
      () => self.exit(0),
      (e: unknown) => {
        io.error(`host close failed: ${e instanceof Error ? e.message : String(e)}`);
        self.exit(1);
      },
    );
  };
  for (const sig of STOP_SIGNALS) self.on(sig, () => stop(sig));
  if (self.platform !== "linux") return;
  watch = setInterval(() => {
    if (!programGone(self.execPath)) return;
    io.error(`${self.execPath}, which this host runs, is gone; it stops so the next start runs what the wsp command names now`);
    stop("SIGTERM");
  }, OWN_FILES_POLL_MS);
  watch.unref();
}

/** Where an error nothing caught arrives. The default is this process; a test hands in its own, since either event
 * on the real one would take the test runner with it. */
export interface UncaughtProcess {
  on(event: "unhandledRejection" | "uncaughtException", listener: (e: unknown) => void): unknown;
}

/** A serving host says an error nothing caught in one line and stays. Node's default ends the process on either,
 * and this process is every socket the host holds and every link it keeps to a machine, so a frame in a shape no
 * door read, or a promise a handler let go, would otherwise end all of it with nothing said. Installed only once a
 * host serves: a verb that runs and returns keeps the default, since its exit code has to say it failed. */
export function stayOnUncaught(io: CliIO, self: UncaughtProcess = process): void {
  self.on("unhandledRejection", e => io.error(`unhandled rejection, kept serving: ${verbFailure(e).error}${faultSite(e)}`));
  self.on("uncaughtException", e => io.error(`uncaught exception, kept serving: ${verbFailure(e).error}${faultSite(e)}`));
}

/** Where an error the host kept serving through came from, as the first frame of its stack, so the fault can be
 * found in the log; a thrown value with no stack names nothing. */
function faultSite(e: unknown): string {
  const frame = e instanceof Error ? e.stack?.split("\n").map(line => line.trim()).find(line => line.startsWith("at ")) : undefined;
  return frame === undefined ? "" : `, ${frame}`;
}

export interface ServeOptions {
  port: number;
  /** The address the host binds; this computer alone when absent. */
  address?: string;
  /** The address the person named with --advertise: a computer being joined dials this host there. Absent leaves
   * the join to the relay's name or what this computer answers on. A fork's turn dials nothing, its wsp rides its
   * daemon's link. */
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
  /** Which command line road brought this host up, written into its lock so wsp down can stop it. The wsp up road
   * hands in its own word; a host served inside another process hands in none, and nothing stops it from a terminal. */
  startedBy?: HostStarted;
  /** How this host restarts itself where no command line road brought it up. */
  restart?: RestartRoad;
  /** How an editor's ssh reaches a workspace; the host's own road through its relay when absent. */
  ssh?: HostSsh;
  /** Filled with the loopback address a turn on this computer dials once the host binds. A caller that hands in its
   * own runtime hands in the cell that runtime's reach reads; absent, the host makes one for the runtime it builds. */
  here?: HereAt;
  /** The wsp home this host reads and writes as its own, its device key, ssh door and account among it; the home
   * WSP_HOME names, else the person's own, when absent. */
  home?: string;
}

/** A host served inside the calling process, over wsp up's key reading: a computer with no provider key serves the
 * machines it does have rather than being asked for one. */
export async function serve(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  await adoptLoginPath(line => io.log(line));
  const { keys, env: providerEnv } = await loadKeys(io, keySources(opts.providerEnv ?? process.env, opts.statePath), { anthropic: false, noProviderKey: "local" });
  // One wiring for the runtime and for the host over it, so the links this host holds and the recipe its doctor
  // reads come from the same place.
  const links = placeWiring(opts.statePath, opts.advertise);
  const here = opts.here ?? {};
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath, goldenRecipe(), providerEnv, { here, ...(opts.running !== undefined ? { run: opts.running } : {}) }, undefined, links);
  return hostFor(rt, keys, { ...opts, providerEnv, links, here }, io, opts.running);
}

/** What a host with no Claude key says as it starts. A host that forks machines gives each fork the key as an env,
 * so a missing one is a fork with no credentials; a host that forks none runs its turns under the person's own
 * login and their harness's own store, where the sign-in they already made is the one a turn uses. */
export function noClaudeKeyNote(forksNothing: boolean): string {
  const what = forksNothing ? "a thread on this computer signs in as your own agents do" : "new workspaces fork without claude credentials";
  return `note: no ANTHROPIC_API_KEY found; ${what}`;
}

export async function hostFor(
  rt: Runtime,
  keys: Keys,
  opts: {
    port: number;
    address?: string;
    statePath: string;
    webDir?: string;
    openUrl?: UrlOpener;
    /** The address the person named with --advertise, which leads the addresses a computer you own is told to dial. */
    advertise?: string;
    /** Whether a linked box runs its connector; false is `wsp up --no-relay`, which serves without a tunnel. */
    relay?: boolean;
    /** Required here, not defaulted: the host's runtime and its init door must pick a provider out of one
     * environment, and two defaults are two places for them to drift apart. */
    providerEnv: ProviderEnv;
    /** Which command line road brought this host up, for the lock; absent is the app's own road. */
    startedBy?: HostStarted;
    /** The place wiring the runtime was built with, so the doctor's road on this host reads the recipe through the
     * planner the recipe job runs and not a second one of its own. Built here for a caller that handed none. */
    links?: PlaceWiring;
    /** The restart road the caller holds, which stands above the one the command line road names. */
    restart?: RestartRoad;
    ssh?: HostSsh;
    /** The cell the runtime's reach reads the loopback address from, filled once the host binds. */
    here?: HereAt;
    /** The wsp home whose device key a linked host trusts; the person's own when absent. */
    home?: string;
  },
  io: CliIO,
  run: RunningWsp = runningWsp(),
): Promise<HostHandle> {
  const address = opts.address ?? LOOPBACK;
  const links = opts.links ?? placeWiring(opts.statePath, opts.advertise);
  const lockPath = lockPathFor(opts.statePath);
  const started = startedByEnv(process.env) ?? opts.startedBy;
  const lock = takeLock(lockPath, opts.statePath, { port: opts.port, address, ...(started !== undefined ? { startedBy: started } : {}) });
  // The mark says what started this host and the lock has it now, so it comes off the process here: a thread, the
  // local daemon and every pane's shell start from this environment, and a wsp line typed in one is not the service.
  delete process.env[STARTED_BY_ENV];
  // Read before the host serves a byte, for the line that says what a linked box is open to; the page's token is
  // withheld per request, off what the connector puts on the ones it forwards, so a connector an earlier run left
  // behind changes nothing here.
  const linked = readRelayRecord(opts.statePath) !== undefined;
  // A computer that already joined dials the port its place file names, so the door binds as this host starts
  // rather than waiting for somebody to open the Add a computer sheet again.
  const joined = (await rt.places?.list(Date.now()).catch(() => []))?.some(p => p.kind === "computer" && p.joinedAt !== undefined) === true;
  // The account's own computers, read by the door and written by the beats below: made here because the door is
  // wired as the host starts and the beats only begin once it serves.
  const admitted = admittedDevices(opts.statePath);
  const road =
    opts.restart ??
    (started === undefined
      ? undefined
      : restartRoads({ exit: code => process.exit(code), respawn: ports => starterFor(run)(opts.statePath, line => io.log(line), ports), log: line => io.log(line) })[started]);
  // Handed out before the host serves and read only once a request arrives, which is after it serves.
  let serving: RestartingHost | undefined;
  const restart: RestartDoor | undefined =
    road === undefined
      ? undefined
      : {
          ...(road.refusal !== undefined ? { refusal: road.refusal } : {}),
          restart: () => (serving === undefined ? Promise.reject(new Error("the host is still starting")) : road.restart(serving)),
        };
  // Built and followed before the host binds, so nothing the host does once it serves goes uncounted; a build with no
  // key, or a host the environment holds off, gets the client that does nothing.
  const usageOff = analyticsOff(opts.statePath, process.env);
  const analytics = hostAnalytics({
    off: usageOff,
    common: hostCommon(VERSION, started),
    log: line => io.log(line),
  });
  const init = hostInitDoor(rt, opts.statePath, run, opts.openUrl ?? systemOpener(), line => io.log(line), opts.providerEnv);
  const usage = followUsage(analytics, rt, init);
  try {
    // Written before startHost binds: a client can read the page while the host is still listing at the provider.
    const authToken = randomBytes(24).toString("base64url");
    const tokenPath = hostTokenPath(opts.statePath);
    writeOwn(dirname(tokenPath), basename(tokenPath), authToken);
    const handle = await startHost({
      runtime: rt,
      authToken,
      port: opts.port,
      listen: address,
      ...(opts.advertise !== undefined ? { advertise: opts.advertise } : {}),
      ...(opts.here !== undefined ? { here: opts.here } : {}),
      ...(opts.ssh !== undefined ? { ssh: opts.ssh } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      door: joined ? "open" : "closed",
      doorLine: line => io.log(line),
      ...(links.back !== undefined ? { back: links.back } : {}),
      webDir: opts.webDir ?? webDirFor(),
      // Read at each fork, not once at start: the init job saves a key while this host serves.
      workspaceEnvs: golden => workspaceEnvsFor().workspaceEnvs(golden),
      ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
      log: line => io.log(line),
      recipePath: recipePath(opts.statePath),
      statePath: opts.statePath,
      init,
      doctor: hostDoctorReaders(links, opts.statePath),
      // The row this host forks on, so a host wired to none asks its account nothing at all.
      provider: wiredProviderId(opts.providerEnv),
      admitted,
      release: releaseWatch({
        statePath: opts.statePath,
        ...(started !== undefined ? { shape: started } : {}),
        running: VERSION,
        installed: installedVersion,
        ...(road !== undefined ? { restart: road } : {}),
        update: version => releaseUpdateLine(run, version),
        log: line => io.log(line),
      }),
      ...(restart !== undefined ? { restart } : {}),
      road: hostRoadOf(run, started),
      failed: usage.failed,
      ...(usageOff !== undefined ? { productUsageOff: usageOff } : {}),
    });
    rewriteLock(lockPath, { ...lock, port: handle.port, address });
    usage.begin();
    // A skill copy an install wrote once falls behind the binary at the next release, and the agent reading it
    // calls verbs that are gone. Only the agents whose wsp entry names this state file are brought up to date: a
    // host for a proof, on a state no entry names, writes nothing under the person's home.
    const refreshed = refreshSkills(homedir(), opts.statePath);
    if (refreshed.length > 0) io.log(skillsRefreshedLine(refreshed));
    const servers = refreshServers(homedir(), opts.statePath, run);
    if (servers.length > 0) io.log(serversRefreshedLine(servers));

    for (const line of addressLines(opts.statePath, { ...handle, address })) io.log(line);
    if (!isLoopback(address)) io.log(listenBeyondLoopbackLine(address));
    else if (linked) io.log(relayOnLoopbackLine());
    if (hereUrl(address, handle.port) === undefined) io.log(loopbackThreadsLine(address));
    if (keys.anthropic === undefined) io.log(noClaudeKeyNote(forksNoMachines(rt.backend.capabilities)));
    // The tunnel carries to this host's own app port, so a box on loopback alone is still reachable through the
    // relay and nothing else about how it binds has to change.
    const relay =
      linked && opts.relay !== false
        ? await startRelay({
            statePath: opts.statePath,
            home: opts.home ?? wspHome(),
            port: handle.port,
            log: line => io.log(line),
            admitted,
            // The revoke the reconcile takes is the op's own, so a device the account dropped loses its sockets
            // here exactly as one revoked at this terminal does.
            devices: { list: () => rt.devices.list(), revoke: id => handle.revokeDevice(id) },
          })
        : undefined;
    if (linked && opts.relay === false) await stopRecordedConnector(dirname(opts.statePath));
    const watcher = hostRecipeWatch(rt);
    const host: HostHandle = {
      ...handle,
      close: async () => {
        watcher?.close();
        usage.close();
        await relay?.close();
        await handle.close();
        await analytics.close();
        releaseLock(lockPath);
      },
    };
    serving = host;
    return host;
  } catch (e) {
    usage.close();
    await analytics.close();
    releaseLock(lockPath);
    throw e;
  }
}

/** What the doctor's computer road reads on a serving host beside the runtime: the keys as they stand at the ask,
 * and the recipe off the one planner that host's places wiring already holds. Written here so the recipe job and
 * this road read this computer through one planner and no road can grow a second. */
export function hostDoctorReaders(links: PlaceWiring, statePath: string): HostDoctorReaders {
  const provision = links.provision;
  return {
    vault: () => vaultNow(statePath),
    ...(provision !== undefined ? { plan: computer => (computer?.picks !== undefined ? provision.setup(computer.picks, { home: GUEST_HOME }) : provision.plan({ home: GUEST_HOME })) } : {}),
  };
}
