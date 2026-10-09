// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { STARTED_BY_ENV, accountAim, claudeKeyOnlyInThisShell, aimedAlias, aimedHost, computerNameHere, defaultHomeIn, devCheckoutState, dialAddress, dialHost, downCommand, homeNamed, hostLogPath, hostTokenFor, httpProbe, installService, keyOnlyInThisShell, lockPathFor, logTail, noManagerLine, ownPid, readHost, runAll, runFailureLine, serviceAddressHere, serviceEnv, serviceStartsAtLogin, servingHost, severalAccountHostsLine, stopService, vanishedHost, VERSION, type CliIO, type HostLock, type HostRecord, type HostProbe, type RunFailure, type ServiceDeps, type ServicePlan } from "@wsp/host";
import { BOOT_SCRIPT, LOOPBACK, THIS_COMPUTER, authority, bootLineOf, compareVersions, fmtDuration, holdsNothing, isLocalWorkspace, isLoopback, type BootPayload, type GoldenManifest, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { safeEqual, tokenDigest } from "@wsp/runtime";

export interface HostSession {
  url: string;
  port: number;
  /** True for a host on another computer, whose device token the shell holds. */
  remote: boolean;
  /** What the window and the menu call this host. */
  label: string;
  /** The hosts file's name for a host somewhere else; the app's own host has none. */
  alias?: string;
  /** The token this computer holds for that host, handed to the page over the bridge and never written into it. */
  deviceToken?: string;
}

/** How this app was launched, as everything that decides where its state file sits reads it. */
export interface Launch {
  /** app.isPackaged. A packaged app inherits whatever folder the person launched it from, so a checkout it happens
   * to open in says nothing about it; only a development run out of one means the checkout's state. */
  packaged: boolean;
  /** WSP_HOME as launched; a Finder launch has none. It names the home outright, over any launch folder. */
  env?: string;
  cwd: string;
}

/** This computer's own service manager and how long a start is given, as wsp up --service and wsp down read them. */
export type ServiceRoad = Pick<ServiceDeps, "platform" | "manager" | "run" | "waitMs">;

export interface OpenHostOptions {
  statePath: string;
  /** The wsp home the service runs in. */
  home: string;
  /** The wsp command this app writes, which the service runs. */
  shim: string;
  io: CliIO;
  /** How a host on the account is dialled, which is the command line's own dial. */
  dial?: typeof dialHost;
  service: ServiceDeps;
  /** Asks the person the question a host of another release with turns running puts, and answers whether to restart. */
  ask(prompt: ReplacePrompt): Promise<boolean>;
}

/** The page served at this authority, or nothing where nothing there answers. */
async function pageAt(at: string): Promise<string | undefined> {
  try {
    const res = await fetch(`http://${at}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** The boot object of the page served at this authority, or nothing where nothing there answers as a wsp host. */
async function bootAt(at: string): Promise<BootPayload | undefined> {
  const page = await pageAt(at);
  return page === undefined ? undefined : bootLineOf(page);
}

/** Which port a url answers on, read by every session built from an address rather than from a port this app
 * bound: a url with no port is the scheme's own. */
export const portOf = (url: string): number => Number(new URL(url).port) || 80;

/** A session on a host on another computer: the address it answers at, what the window and the menu call it, and
 * the device token the shell holds for it and hands the page over the bridge. Written once, since the window reaches
 * such a host by opening on it and by moving to it. */
export function remoteSession(alias: string, record: HostRecord, url: string): HostSession {
  return { url, port: portOf(url), remote: true, alias, label: alias, deviceToken: record.deviceToken };
}

function attached(port: number, url: string): HostSession {
  return { url, port, remote: false, label: computerNameHere() };
}

/** Whether a digest is the one of the token the host serving this state file holds, compared the one way this repo
 * compares a secret. The page carries the digest and this window holds the file, so the compare sends nothing and
 * a page a squatter serves learns nothing by being read. False where no host has written the file, so nothing
 * matches nothing. It lives here rather than beside the token file's own reader because the host package's MCP
 * server may reach no runtime. */
export function hostTokenMatches(statePath: string, digest: string): boolean {
  const held = hostTokenFor(statePath);
  return held !== undefined && safeEqual(tokenDigest(held), digest);
}

/** One sentence for every live lock this window will not attach to, whichever of the three reasons it is: the
 * owner's token is never sent to that page to settle the question, since a squatter would then have it, and the
 * page's digest of it is what is read instead. */
const wontAttach = (statePath: string, lock: HostLock, why: string): Error =>
  new Error(`a host (pid ${lock.pid}) holds ${lockPathFor(statePath)} on port ${lock.port} but ${why}: stop that process or run wsp down, then open wsp again`);

/** The bin's rule, read from the bin: a checkout of wsp in cwd marks a dev run on the checkout's own .wsp state. It
 * holds for a development run and nothing else, since a packaged app is launched from a folder it did not choose,
 * and WSP_HOME names the home over it in every case, which is what the locate doc says. */
export function statePathIn(home: string, launch: Launch): string {
  const dev = launch.packaged || homeNamed(launch.env) !== undefined ? undefined : devCheckoutState(launch.cwd);
  return dev ?? join(home, "state.json");
}

/** The host whose lock sits beside this state file, once this window has proof it is the owner's own, and the release
 * its page says it is. The lock is the whole road in: a page on a port carrying the boot line is anything any login
 * on this computer cares to serve. Its pid is this login's, and then one of two readings by the address it bound. A
 * host on loopback serves its page with the digest of its own token inlined, so the page is held to the digest of
 * the token file beside the state. A host bound beyond this computer serves a page with no digest by design, and the
 * lock alone is the reading for it. Either road is dialled where the lock says that host answers, which for a host
 * on ::1 or on 127.0.0.2 is there and nowhere else. Anything else is a refusal: this window starts no service on a
 * state file another process holds. */
async function lockedHost(statePath: string): Promise<{ session: HostSession; lock: HostLock; release?: string } | undefined> {
  const held = servingHost(statePath);
  if (held === undefined) return undefined;
  if (!ownPid(held.pid)) throw wontAttach(statePath, held, "that process is not this login's");
  const at = authority(dialAddress(held), held.port);
  const page = await pageAt(at);
  const boot = page === undefined ? undefined : bootLineOf(page);
  // A boot line of a shape this release does not read, or one naming no release, is a wsp from before pages named
  // theirs (0.2.0 wrote its token into the page and marked no lock), which wsp down cannot stop either.
  if (page !== undefined && BOOT_SCRIPT.test(page) && boot?.version === undefined) {
    throw new Error(`a wsp older than this app's ${VERSION} (pid ${held.pid}) serves ${statePath} on port ${held.port}, and its page names no release: stop that process, then open wsp again`);
  }
  if (isLoopback(held.address ?? LOOPBACK)) {
    if (boot === undefined) throw wontAttach(statePath, held, "no wsp host answers there");
    if (boot.tokenHash === undefined || !hostTokenMatches(statePath, boot.tokenHash)) throw wontAttach(statePath, held, "the page it serves carries another token's digest than the file beside this state");
  }
  return { session: attached(held.port, `http://${at}`), lock: held, ...(boot !== undefined ? { release: boot.version } : {}) };
}

/** The wsp home a launch means: WSP_HOME when it is set, else this computer's own. A window that should open on
 * another home is launched with WSP_HOME naming it, which is the one way any road here says which home it means. */
export function homeOf(launch: Launch): string {
  const env = homeNamed(launch.env);
  return env !== undefined ? resolve(env) : defaultHomeIn(homedir());
}

/** Where this app keeps Chromium's own files, its profile, caches and worker registrations: one folder beside the
 * state file the launch serves, so two apps on two homes never share one profile. A shared profile's databases
 * are locked by the first app to open them, and the second launch's page load never came back. */
export function userDataIn(launch: Launch): string {
  return join(dirname(statePathIn(homeOf(launch), launch)), "desktop");
}

/** How long this window's one dial at the account's host waits. A line at a terminal gives a relayed road fifteen
 * seconds, which is a window with nothing in it for that long; a person who opened the app is watching it, so a
 * host that has not answered is one the window opens without, with the host's own sentence in the log. The floor
 * under it is what that road was measured to hold: an edge whose tunnel has just come up answers a first frame at
 * 5.8 s, so anything shorter calls a box that is alive dead and opens here instead of on that host. */
const ACCOUNT_DIAL_MS = 8_000;

/** The host somewhere else this window opens on when nothing serves here: the alias the rule every line with no
 * name on it takes, which is the one host on the account this computer can reach. It is read through that same
 * rule, so a record holding a token and no key for the host is refused here as every verb refuses it, and dialled
 * once, which admits this computer over there and hands the page a token that opens. Nothing where the rule names
 * no alias, where several hosts on the account stand, or where the one it named refused or did not answer; the
 * window opens on the service here and the sentence is logged, since the screen that would ask which host is the
 * first run's. */
async function accountSession(opts: OpenHostOptions): Promise<HostSession | undefined> {
  const home = opts.home;
  const alias = aimedAlias(opts.statePath, home);
  if (alias === undefined) {
    const aim = accountAim(opts.statePath, home);
    if (aim.kind === "several") opts.io.error(severalAccountHostsLine(aim.aliases));
    return undefined;
  }
  try {
    const aim = aimedHost(opts.statePath, { host: alias, home });
    (await (opts.dial ?? dialHost)(opts.statePath, { aim, home, deadlineMs: ACCOUNT_DIAL_MS })).close();
  } catch (e) {
    opts.io.error(`${e instanceof Error ? e.message : String(e)}; this window is opening on the host here instead`);
    return undefined;
  }
  // What the dial left under that alias: the device token the host answered this computer's key with, which a
  // record off the account's listing held none of until now.
  const record = readHost(home, alias);
  return record === undefined ? undefined : remoteSession(alias, record, record.url);
}

/** What the service this app installs is told: the shim serving this state file, with the service mark, so every
 * other client on this computer starts this unit rather than a host of its own. HOME rides along because a unit is
 * started with the manager's own environment, and the unit sits under that home. */
function servicePlan(opts: Pick<OpenHostOptions, "statePath" | "home" | "shim">, words?: readonly string[]): ServicePlan {
  const at = serviceAddressHere(opts.statePath);
  return {
    ...at,
    argv: [opts.shim, ...(words ?? ["up", "--state", opts.statePath])],
    cwd: opts.home,
    env: { ...serviceEnv(process.env), HOME: at.home, [STARTED_BY_ENV]: "service" },
    logPath: hostLogPath(opts.statePath),
  };
}

const refused = (failure: RunFailure): Error => new Error(runFailureLine(failure));

/** Whether the host a lock names is the one this window will attach to: its page carries the digest of the token
 * beside the state. The host binds its page, then sweeps and lists before it writes that file, so a page read in
 * that gap is a start still in flight and the wait reads it again. A host bound beyond this computer serves no
 * digest, and its answer is the whole reading. */
const answersAsOwn =
  (statePath: string): HostProbe =>
  async lock => {
    if (!isLoopback(lock.address ?? LOOPBACK)) return httpProbe(lock);
    const boot = await bootAt(authority(dialAddress(lock), lock.port));
    return boot?.tokenHash !== undefined && hostTokenMatches(statePath, boot.tokenHash);
  };

/** Makes this computer's own manager serve the state file with the shim, and waits until wsp answers. A unit that
 * runs another program (another app's shim, the node a terminal's wsp up --service named) is stopped and written
 * again to run the shim, with the words it gave wsp up kept (its port, its address, its relay); one that runs this
 * shim is kept as it stands, and loaded where the manager has let it go, or where what it runs is a host whose
 * program has gone, which the manager reads as up. `rewrite` writes even that one again, which restarts the host it
 * serves. A unit the person set not to start at login is loaded all the same and left that way. Read only when
 * nothing serves, or to replace a host of another release, so a rewrite never restarts wsp under a window on it. */
export async function ensureService(opts: Pick<OpenHostOptions, "statePath" | "home" | "shim" | "service" | "io">, rewrite = false): Promise<void> {
  const { manager, run } = opts.service;
  if (manager === undefined) throw new Error(noManagerLine(opts.service.platform));
  // The service reads keys off the .env beside the state and in its own folder, never off the shell that launched
  // this app; a launch from a terminal holding one is told, as wsp up --service tells it.
  const sources = { env: process.env, cwd: opts.home, statePath: opts.statePath };
  for (const line of [keyOnlyInThisShell(sources), claudeKeyOnlyInThisShell(sources)]) if (line !== undefined) opts.io.error(line);
  const unit = manager.unit(serviceAddressHere(opts.statePath));
  const written = existsSync(unit.path) ? readFileSync(unit.path, "utf8") : undefined;
  const words = written === undefined ? undefined : manager.argv(written);
  const up = words?.indexOf("up") ?? -1;
  const plan = servicePlan(opts, up < 0 ? undefined : words!.slice(up));
  const held = async (): Promise<boolean> => manager.holding(await run(manager.holds(plan)));
  // A load starts the unit at login too, so a unit set to start only when asked is set back once it is loaded.
  const offAtLogin = written !== undefined && (await serviceStartsAtLogin(manager, plan, run)) === false;
  if (written === undefined || rewrite || !manager.runs(written, opts.shim)) {
    if (written !== undefined) {
      const stopped = await stopService(manager, plan, run);
      const failure = stopped.unsure ?? stopped.failure;
      if (failure !== undefined) throw refused(failure);
    }
    const { failure } = await installService(manager, plan, run);
    // A load refused because the manager holds the unit is another launch that loaded it a moment before: the same
    // service coming up. The refused install took back the file it wrote, which that service still needs.
    if (failure !== undefined) {
      if (!(await held())) throw refused(failure);
      if (!existsSync(unit.path)) writeFileSync(unit.path, manager.text(plan), { mode: 0o600 });
    }
  } else if (!(await held()) || vanishedHost(opts.statePath) !== undefined) {
    const failure = await runAll(manager.load(plan), run);
    if (failure !== undefined && !(await held())) throw refused(failure);
  }
  if (offAtLogin) {
    const failure = await runAll(manager.atLogin(plan, false), run);
    if (failure !== undefined) opts.io.error(runFailureLine(failure));
  }
  const started = Date.now();
  if ((await untilAttachable(opts.statePath, opts.service.waitMs)) === undefined) {
    throw new StartTimeout([`wsp did not start within ${fmtDuration(Date.now() - started)}; its log is ${plan.logPath}`, ...logTail(plan.logPath)].join("\n"));
  }
}

/** Whether the service serving this state file starts at every login, or only when the app or a line asks for it;
 * null where no service is registered for it or the manager's answer said neither. */
export async function loginStart(statePath: string, service: ServiceRoad): Promise<boolean | null> {
  return (await serviceStartsAtLogin(service.manager, serviceAddressHere(statePath), service.run)) ?? null;
}

/** Sets that, leaving the service running either way, and answers the reading after it; a refusal is the manager's
 * own line. */
export async function setLoginStart(statePath: string, on: boolean, service: ServiceRoad): Promise<boolean | null> {
  const { manager, run } = service;
  if (manager === undefined) throw new Error(noManagerLine(service.platform));
  const failure = await runAll(manager.atLogin(serviceAddressHere(statePath), on), run);
  if (failure !== undefined) throw refused(failure);
  return loginStart(statePath, service);
}

/** The service's host did not answer within the start's wait, which already covered a host still binding. */
class StartTimeout extends Error {}

/** Attaches to the host already serving this state file, which its lock names and this window has proof of, once it
 * is not of an earlier release, else opens on the host a line with no name on it takes, else makes this computer's
 * own service serve it and attaches to that. The window never serves a host itself, so closing it stops nothing, and
 * never draws the page of an earlier release: a host left by an older install is replaced first. A host of a later
 * release is the person's newer wsp, which this app would downgrade, so it is attached to and its page says the app
 * is older. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = await lockedHost(opts.statePath);
  if (held !== undefined) {
    const theirs = otherRelease(held.release);
    if (theirs === undefined || compareVersions(theirs, VERSION) > 0) return held.session;
    await replaceHost(opts, held.lock, theirs);
  } else {
    const away = await accountSession(opts);
    if (away !== undefined) return away;
    await ensureService(opts);
  }
  return ownServed(opts);
}

/** The session on the host serving after this app started or replaced one, which has to be this app's release. */
async function ownServed(opts: OpenHostOptions): Promise<HostSession> {
  const served = await lockedHost(opts.statePath);
  if (served === undefined) throw new Error(`wsp started and stopped again; its log is ${hostLogPath(opts.statePath)}`);
  const other = otherRelease(served.release);
  if (other !== undefined) throw new Error(`this app is wsp ${VERSION} and the host serving ${opts.statePath} came up as wsp ${other}; its log is ${hostLogPath(opts.statePath)}`);
  return served.session;
}

/** What the menu bar's check found: nothing to replace, a host it replaced, or a release it tried once already in this
 * run serving again, which it leaves (`first` the one time it says so, `failed` why that try failed where it did). */
export type Recheck = { kind: "none" } | { kind: "replaced"; session: HostSession } | { kind: "again"; release: string; first: boolean; failed?: string };

/** The check every dial of the menu bar's feed makes, its reconnects included, kept for one run of the app: a host of
 * an earlier release that came up after the window opened (an older wsp on PATH starting one once this app's had
 * stopped) is replaced as at start, asking first while turns run. Each older release is replaced once per run. One
 * that serves again after that is what this computer's wsp runs now (an install rolled back under the app), and
 * restarting it on every dial would stop every client each time, so it is left serving and said once. A lock this
 * window would refuse is left to the dial, which says why. */
export function earlierHostCheck(): (opts: OpenHostOptions) => Promise<Recheck> {
  // Each release tried, with why its replace failed where it did; a release is replaced only once replaceHost returns.
  const tried = new Map<string, string | undefined>();
  const told = new Set<string>();
  return async opts => {
    const held = await lockedHost(opts.statePath).catch(() => undefined);
    const theirs = otherRelease(held?.release);
    if (held === undefined || theirs === undefined || compareVersions(theirs, VERSION) > 0) return { kind: "none" };
    if (tried.has(theirs)) {
      const first = !told.has(theirs);
      told.add(theirs);
      const failed = tried.get(theirs);
      return { kind: "again", release: theirs, first, ...(failed !== undefined ? { failed } : {}) };
    }
    try {
      await replaceHost(opts, held.lock, theirs);
    } catch (e) {
      // The person kept it serving, which quits the app; any other failure is said once and not tried again.
      if (!(e instanceof KeptOtherRelease)) tried.set(theirs, e instanceof Error ? e.message : String(e));
      throw e;
    }
    tried.set(theirs, undefined);
    return { kind: "replaced", session: await ownServed(opts) };
  };
}

/** The notice for a release the check tried once and found serving again: what failed where the replace did, else
 * that it came back after the restart. */
export function servesAgainNotice(theirs: string, failed?: string): { message: string; detail: string } {
  if (failed !== undefined) {
    return {
      message: `wsp ${theirs} still serves your threads; this app could not restart it as ${VERSION}`,
      detail: `The restart failed: ${failed}. This app leaves wsp ${theirs} serving and tries no more until it opens again.`,
    };
  }
  return {
    message: `wsp ${theirs} is serving again after this app restarted it as ${VERSION}`,
    detail: `The wsp command on ${THIS_COMPUTER} runs ${theirs} now, so this app leaves it serving and restarts it no more. Open the app of that release, or install ${VERSION} again.`,
  };
}

/** Runs what it is handed one at a time, in the order handed: the open a launch or a Dock click makes and the menu
 * bar's check may each ask the person about an older host, and two at once asked twice and replaced twice. */
export function oneAtATime(): <T>(run: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return run => {
    const next = last.catch(() => {}).then(run);
    last = next;
    return next;
  };
}

/** The release a page names where it is not this app's own; nothing where it is, or where a host bound beyond this
 * computer served no page to read. */
const otherRelease = (release: string | undefined): string | undefined => (release === undefined || release === VERSION ? undefined : release);

/** The person said to leave the host of another release serving, so this app opens no window on it. */
export class KeptOtherRelease extends Error {}

export interface ReplacePrompt {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/** The question for a host of release `theirs` with `working` turns running on this computer, or a count it would
 * not give. */
export function replacePrompt(theirs: string, working: number | undefined): ReplacePrompt {
  const running = working === undefined ? "" : working === 1 ? `A thread is working on ${THIS_COMPUTER}. ` : `${working} threads are working on ${THIS_COMPUTER}. `;
  return {
    message: `wsp ${theirs} is still serving your threads; restart it as ${VERSION}?`,
    detail: `${running}Running turns carry on while wsp restarts. This app opens only on wsp ${VERSION}, so Quit leaves wsp ${theirs} serving and closes the app.`,
    buttons: [`Restart as ${VERSION}`, "Quit"],
    defaultId: 0,
    cancelId: 1,
  };
}

/** Replaces a host of another release than this app's by the road its lock names, so this app's own release serves
 * the state file after it. A turn on this computer leads a process group of its own, so the stop leaves it running and
 * the next host picks it up; while any runs, or where the old host would not say, the person is asked once and
 * nothing is stopped until they answer. A host nothing marked is served inside some process wsp cannot stop, and is
 * refused. A service keeps its unit, the words given to wsp up --service and its login setting: one running this
 * shim is restarted, which brings it back on this app's files, and one running another program has only that
 * program written over. Any other host is stopped by its pid and the service starts after it, from the unit already
 * there where there is one. */
async function replaceHost(opts: OpenHostOptions, lock: HostLock, theirs: string): Promise<void> {
  const { statePath, service } = opts;
  if (lock.startedBy === undefined) {
    throw new Error(`this app is wsp ${VERSION} and wsp ${theirs} (pid ${lock.pid}) serves ${statePath} from a process wsp did not start: stop it, then open wsp again`);
  }
  const working = await workingHere(statePath, opts.home, opts.dial).catch(() => undefined);
  if (working !== 0 && !(await opts.ask(replacePrompt(theirs, working)))) throw new KeptOtherRelease(`wsp ${theirs} keeps serving ${statePath}`);
  opts.io.log(`wsp ${theirs} (pid ${lock.pid}, started by ${lock.startedBy}) serves ${statePath}; restarting it as ${VERSION}`);
  if (lock.startedBy !== "service") {
    // Stopped by its own pid, read again off the lock just before the signal. wsp down would also take the unit file
    // beside it, and the words and the login setting the service below keeps with it.
    if (servingHost(statePath)?.pid === lock.pid) service.stop(lock.pid);
    for (const until = Date.now() + service.waitMs; servingHost(statePath)?.pid === lock.pid; await pause()) {
      if (Date.now() >= until) throw new Error(`wsp ${theirs} (pid ${lock.pid}) was stopped and still serves ${statePath} after ${fmtDuration(service.waitMs)}`);
    }
    return ensureService(opts);
  }
  const unit = service.manager?.unit(serviceAddressHere(statePath));
  const runsShim = unit !== undefined && existsSync(unit.path) && service.manager!.runs(readFileSync(unit.path, "utf8"), opts.shim);
  if (!runsShim || !(await restarted(opts, lock))) return ensureService(opts, runsShim);
  for (const until = Date.now() + service.waitMs; servingHost(statePath)?.pid === lock.pid; await pause()) {
    if (Date.now() >= until) throw new Error(`wsp ${theirs} (pid ${lock.pid}) took the restart and still serves ${statePath} after ${fmtDuration(service.waitMs)}`);
  }
  return ensureService(opts);
}

/** Asks the host the lock names to restart on the road it came up on, which for a service is its manager starting the
 * unit again; whether that host took the ask and closed. A host of another release is dialled all the same, since the
 * restart is what brings it level. */
async function restarted(opts: OpenHostOptions, lock: HostLock): Promise<boolean> {
  try {
    const client = await (opts.dial ?? dialHost)(opts.statePath, { aim: { kind: "here" }, home: opts.home, anyRelease: true });
    try {
      await client.request("host.restart");
      await Promise.race([client.closed, new Promise((_, no) => setTimeout(() => no(new Error("it took the ask and stayed open")), opts.service.waitMs))]);
      return true;
    } finally {
      client.close();
    }
  } catch (e) {
    opts.io.log(`wsp (pid ${lock.pid}) did not restart itself (${e instanceof Error ? e.message : String(e)}); its unit is written again`);
    return false;
  }
}

/** Whether the host here holds nothing to show, which is the app's first launch: asked of the host, since the state
 * file is its to read. */
export async function firstLaunch(statePath: string, home: string, dial: typeof dialHost = dialHost): Promise<boolean> {
  const client = await dial(statePath, { aim: { kind: "here" }, home });
  try {
    const { manifest } = await client.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
    const { workspaces } = await client.request<{ workspaces: unknown[] }>("workspaces.list");
    return holdsNothing(manifest, workspaces);
  } finally {
    client.close();
  }
}

/** How many of the start's waits a host that holds the lock is given to bind its page. A host reads its computers
 * between taking the lock and binding, which waits on every box that does not answer: 30 s on the dev home with four
 * unreachable boxes, past the start's own twenty. */
const STARTING_WAITS = 6;
const POLL_MS = 200;
const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, POLL_MS));

/** Waits for a host this window can attach to: one whose page answers with the digest of the token beside the state.
 * A live host holding the lock is one still starting, and is given the longer wait; nothing holding it, the start's. */
async function untilAttachable(statePath: string, waitMs: number): Promise<HostLock | undefined> {
  for (const from = Date.now(); ; await pause()) {
    const lock = servingHost(statePath);
    if (lock !== undefined && (await answersAsOwn(statePath)(lock))) return lock;
    if (Date.now() - from >= waitMs * (lock === undefined ? 1 : STARTING_WAITS)) return undefined;
  }
}

/** Waits, until `until`, for the lock to be gone or to answer as this window's own host: a host on its way out lets
 * go, and the one after it, which may already hold the lock, binds. A lock whose page answers as anything else is a
 * host that is up, and its refusal stands. */
async function settles(statePath: string, until: number): Promise<boolean> {
  for (;; await pause()) {
    if (Date.now() >= until) return false;
    const now = servingHost(statePath);
    if (now === undefined || (await answersAsOwn(statePath)(now))) return true;
    if (await httpProbe(now)) return false;
  }
}

/** The host the window opens on and whether it holds nothing yet, read across a restart. A launch that meets the
 * host on its way down (launchctl kickstart -k, a Restart host) finds its lock and its page still up for a moment,
 * attaches, and then reads nothing from it, or finds the lock with no page behind it; the host after it holds the
 * lock a while before its page answers. The launch waits for the lock to settle and attaches again, all within one
 * wait for a starting host; a host whose page answers keeps its refusal. */
export async function openHostReady(opts: OpenHostOptions, dial: typeof dialHost = dialHost): Promise<{ session: HostSession; first: boolean }> {
  const from = Date.now();
  const until = from + opts.service.waitMs * STARTING_WAITS;
  const gaveUp = (e: unknown): unknown => (Date.now() < until ? e : new Error(`after ${fmtDuration(Date.now() - from)} of waiting, ${e instanceof Error ? e.message : String(e)}`));
  for (;;) {
    let session: HostSession;
    try {
      session = await openHost(opts);
    } catch (e) {
      // A lock whose page answers is a host that is up and refused this window; one with nothing behind it is a host
      // closing or still binding. The start's own wait has already covered a host still binding.
      const lock = servingHost(opts.statePath);
      if (e instanceof StartTimeout || lock === undefined || (await httpProbe(lock))) throw e;
      if (!(await settles(opts.statePath, until))) throw gaveUp(e);
      continue;
    }
    if (session.remote) return { session, first: false };
    const answered = servingHost(opts.statePath);
    try {
      return { session, first: await firstLaunch(opts.statePath, opts.home, dial) };
    } catch (e) {
      // The host that answered and still serves refused the read. Any other failure is a host closing (its page
      // shuts before its lock goes) or the one after it still binding.
      const now = servingHost(opts.statePath);
      if (now !== undefined && now.pid === answered?.pid && (await httpProbe(now))) throw e;
      if (!(await settles(opts.statePath, until))) throw gaveUp(e);
    }
  }
}

/** The turns running on this computer's own workspaces, which stopping wsp would leave with nobody reading them. A
 * turn on a box runs on that box and goes on whether wsp here serves or not. */
export function runningHere(sessions: readonly Pick<SessionView, "id" | "workspaceId" | "status">[], workspaces: readonly Pick<WorkspaceView, "id" | "kind">[]): string[] {
  const here = new Set(workspaces.filter(isLocalWorkspace).map(w => w.id));
  return sessions.filter(s => s.status === "running" && here.has(s.workspaceId)).map(s => s.id);
}

async function runningOn(statePath: string, home: string, dial: typeof dialHost): Promise<{ client: Awaited<ReturnType<typeof dialHost>>; running: string[] } | undefined> {
  if (servingHost(statePath) === undefined) return undefined;
  // Any release: a host of another one is counted before it is replaced, and stopped by the quit all the same.
  const client = await dial(statePath, { aim: { kind: "here" }, home, anyRelease: true });
  try {
    const { sessions } = await client.request<{ sessions: SessionView[] }>("sessions.list");
    const { workspaces } = await client.request<{ workspaces: WorkspaceView[] }>("workspaces.list");
    return { client, running: runningHere(sessions, workspaces) };
  } catch (e) {
    client.close();
    throw e;
  }
}

/** How many turns stopping wsp would stop, for the question the quit asks; none where nothing serves. */
export async function workingHere(statePath: string, home: string, dial: typeof dialHost = dialHost): Promise<number> {
  const on = await runningOn(statePath, home, dial);
  on?.client.close();
  return on?.running.length ?? 0;
}

/** What wsp down's own road is handed here: its refusals kept for the error the caller throws, and nothing asked. */
const quietIO = (said: string[]): CliIO => ({ log: () => {}, error: line => said.push(line), ask: q => Promise.reject(new Error(q)), askSecret: q => Promise.reject(new Error(q)) });

/** Quit and stop wsp: every turn on this computer's workspaces is interrupted, then wsp down's own road stops what
 * serves the state file, the service and its unit or a host a line started. The lines it says are the answer where
 * something still serves after it. */
export async function stopWsp(statePath: string, home: string, service: ServiceDeps, dial: typeof dialHost = dialHost): Promise<void> {
  const on = await runningOn(statePath, home, dial);
  if (on !== undefined) {
    try {
      for (const sessionId of on.running) await on.client.request("sessions.interrupt", { sessionId });
    } finally {
      on.client.close();
    }
  }
  const said: string[] = [];
  if ((await downCommand(quietIO(said), { statePath }, service)) !== 0 && servingHost(statePath) !== undefined) throw new Error(said.join("\n"));
}
