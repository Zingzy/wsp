// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { STARTED_BY_ENV, accountAim, claudeKeyOnlyInThisShell, aimedAlias, aimedHost, computerNameHere, defaultHomeIn, devCheckoutState, dialAddress, dialHost, downCommand, homeNamed, hostLogPath, hostTokenFor, httpProbe, installService, keyOnlyInThisShell, lockPathFor, logTail, noManagerLine, ownPid, readHost, runAll, runFailureLine, serviceAddressHere, serviceEnv, serviceStartsAtLogin, servingHost, severalAccountHostsLine, stopService, type CliIO, type HostLock, type HostRecord, type HostProbe, type RunFailure, type ServiceDeps, type ServicePlan } from "@wsp/host";
import { LOOPBACK, authority, bootLineOf, fmtDuration, holdsNothing, isLocalWorkspace, isLoopback, type BootPayload, type GoldenManifest, type SessionView, type WorkspaceView } from "@wsp/protocol";
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
  service: ServiceRoad;
}

/** The boot object of the page served at this authority, or nothing where nothing there answers as a wsp host. */
async function bootAt(at: string): Promise<BootPayload | undefined> {
  try {
    const res = await fetch(`http://${at}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? bootLineOf(await res.text()) : undefined;
  } catch {
    return undefined;
  }
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

/** The bin's rule, read from the bin: a checkout of wsp in cwd marks a dev run whose .wsp state is shared with wspx. It
 * holds for a development run and nothing else, since a packaged app is launched from a folder it did not choose,
 * and WSP_HOME names the home over it in every case, which is what the locate doc says. */
export function statePathIn(home: string, launch: Launch): string {
  const dev = launch.packaged || homeNamed(launch.env) !== undefined ? undefined : devCheckoutState(launch.cwd);
  return dev ?? join(home, "state.json");
}

/** The host whose lock sits beside this state file, once this window has proof it is the owner's own. The lock is
 * the whole road in: a page on a port carrying the boot line is anything any login on this computer cares to
 * serve. Its pid is this login's, and then one of two readings by the address it bound. A host on loopback serves
 * its page with the digest of its own token inlined, so the page is held to the digest of the token file beside
 * the state. A host bound beyond this computer serves a page with no digest by design, and the lock alone is the
 * reading for it. Either road is dialled where the lock says that host answers, which for a host on ::1 or on
 * 127.0.0.2 is there and nowhere else. Anything else is a refusal: this window starts no service on a state file
 * another process holds. */
async function lockedHost(statePath: string): Promise<HostSession | undefined> {
  const held = servingHost(statePath);
  if (held === undefined) return undefined;
  if (!ownPid(held.pid)) throw wontAttach(statePath, held, "that process is not this login's");
  const at = authority(dialAddress(held), held.port);
  if (!isLoopback(held.address ?? LOOPBACK)) return attached(held.port, `http://${at}`);
  const boot = await bootAt(at);
  if (boot === undefined) throw wontAttach(statePath, held, "no wsp host answers there");
  if (boot.tokenHash === undefined || !hostTokenMatches(statePath, boot.tokenHash)) throw wontAttach(statePath, held, "the page it serves carries another token's digest than the file beside this state");
  return attached(held.port, `http://${at}`);
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
function servicePlan(opts: Pick<OpenHostOptions, "statePath" | "home" | "shim">): ServicePlan {
  const at = serviceAddressHere(opts.statePath);
  return {
    ...at,
    argv: [opts.shim, "up", "--state", opts.statePath],
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
 * again; one that runs this shim is kept as it stands, whatever words a terminal gave it, and loaded where the
 * manager has let it go. A unit the person set not to start at login is loaded all the same and left that way.
 * Read only when nothing serves, so a rewrite never restarts wsp under a window on it. */
export async function ensureService(opts: Pick<OpenHostOptions, "statePath" | "home" | "shim" | "service" | "io">): Promise<void> {
  const { manager, run } = opts.service;
  if (manager === undefined) throw new Error(noManagerLine(opts.service.platform));
  // The service reads keys off the .env beside the state and in its own folder, never off the shell that launched
  // this app; a launch from a terminal holding one is told, as wsp up --service tells it.
  const sources = { env: process.env, cwd: opts.home, statePath: opts.statePath };
  for (const line of [keyOnlyInThisShell(sources), claudeKeyOnlyInThisShell(sources)]) if (line !== undefined) opts.io.error(line);
  const plan = servicePlan(opts);
  const unit = manager.unit(plan);
  const written = existsSync(unit.path) ? readFileSync(unit.path, "utf8") : undefined;
  const held = async (): Promise<boolean> => (await run(manager.holds(plan))).code === 0;
  // A load starts the unit at login too, so a unit set to start only when asked is set back once it is loaded.
  const offAtLogin = written !== undefined && (await serviceStartsAtLogin(manager, plan, run)) === false;
  if (written === undefined || !manager.runs(written, opts.shim)) {
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
  } else if (!(await held())) {
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

/** Attaches to the host already serving this state file, which its lock names and this window has proof of, else
 * opens on the host a line with no name on it takes, else makes this computer's own service serve it and attaches
 * to that. The window never serves a host itself, so closing it stops nothing. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = await lockedHost(opts.statePath);
  if (held !== undefined) return held;
  const away = await accountSession(opts);
  if (away !== undefined) return away;
  await ensureService(opts);
  const served = await lockedHost(opts.statePath);
  if (served === undefined) throw new Error(`wsp started and stopped again; its log is ${hostLogPath(opts.statePath)}`);
  return served;
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
  const client = await dial(statePath, { aim: { kind: "here" }, home });
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
  const quiet: CliIO = { log: () => {}, error: line => said.push(line), ask: q => Promise.reject(new Error(q)), askSecret: q => Promise.reject(new Error(q)) };
  if ((await downCommand(quiet, { statePath }, service)) !== 0 && servingHost(statePath) !== undefined) throw new Error(said.join("\n"));
}
