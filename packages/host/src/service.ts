// SPDX-License-Identifier: AGPL-3.0-only
// The host as a service of this computer's own manager: a launchd agent on a
// Mac, a systemd user unit on Linux. One module per manager, and adding one is
// its entry in SERVICE_MANAGERS and its module here; nothing outside this file
// decides by a manager's name. The unit file holds no key: a service reads the
// same .env a terminal run reads, so nothing secret lands in ~/Library.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authority, fmtDuration, shellQuote } from "@wsp/protocol";
import { addressLines, dialAddress, servingHost, type HostLock } from "./host-lock.js";
import { providerEnvNames } from "./providers.js";
import { publicHostname } from "./relay-link.js";

export type ServiceKind = "launchd" | "systemd";

/** Which service this is, for every manager that only has to name it: one service per state file. */
export interface ServiceAddress {
  /** The state file the service's host serves, absolute. */
  statePath: string;
  /** The person's home folder, where the manager reads unit files from. */
  home: string;
  /** The user the service runs as, which launchd names its domain by. */
  uid: number;
}

/** What the service runs, for a manager writing its unit file. */
export interface ServicePlan extends ServiceAddress {
  /** The line it runs, word by word: this node, this wsp, and the words that serve. */
  argv: readonly string[];
  /** The folder it runs in, so a `.env` beside a dev checkout stays the one the host reads. */
  cwd: string;
  /** The envs it starts with; a key is never one of them. */
  env: Readonly<Record<string, string>>;
  /** Where its output goes, since nobody is watching a terminal. */
  logPath: string;
}

export interface ServiceUnit {
  /** What the manager calls it. */
  name: string;
  /** The file the manager reads it from. */
  path: string;
}

/** What a manager's command answered: its exit code, and whatever it said on either stream. */
export interface RunResult {
  code: number;
  output: string;
}

export interface ServiceManager {
  /** How a person names it in a line: "launchd agent", "systemd user unit". */
  words: string;
  unit(at: ServiceAddress): ServiceUnit;
  /** The unit file's whole text. */
  text(plan: ServicePlan): string;
  /** Run in order once the file is written, so it serves now and again at login. */
  load(at: ServiceAddress): ReadonlyArray<readonly string[]>;
  /** Run in order to stop it and leave the manager holding nothing. */
  unload(at: ServiceAddress): ReadonlyArray<readonly string[]>;
  /** Exits 0 when the manager holds it, non-zero when it does not. */
  holds(at: ServiceAddress): readonly string[];
  /** Whether a non-zero `holds` answer is this manager saying it does not have the unit. A manager that is not on
   * PATH, or one that never reached the thing it asks, answers non-zero too and that is not the same sentence: wsp
   * leaves a service it cannot read alone rather than throwing away the file that names it. */
  absent(answer: RunResult): boolean;
  /** One line a person still has to act on after the load, for what this manager alone asks. */
  afterLoad?(at: ServiceAddress): string;
}

/** One service per state file: the manager's names carry the first eight hex of that path's digest, so two state
 * files never write the same unit into one home folder. */
export function serviceTag(statePath: string): string {
  return createHash("sha256").update(statePath).digest("hex").slice(0, 8);
}

/** A service inherits almost no environment, so a PATH the install never saw is the one it would get. */
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** The envs the service starts with: the PATH the install ran with, WSP_HOME when it moved the state folder, and
 * whichever provider variables the installing shell held, since a host that picks its provider out of an
 * environment naming none forks nothing. The keys stay out: the host reads them off the `.env` it would read at a
 * terminal, so a rotated key needs no new unit file and nothing secret is copied into the manager's own folder. */
export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const home = env["WSP_HOME"];
  return {
    PATH: env["PATH"] ?? FALLBACK_PATH,
    ...(home !== undefined ? { WSP_HOME: home } : {}),
    ...Object.fromEntries(providerEnvNames().flatMap(name => ((env[name] ?? "") === "" ? [] : [[name, env[name]!]]))),
  };
}

const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const launchdName = (at: ServiceAddress): string => `com.wsp.host.${serviceTag(at.statePath)}`;
const launchdUnit = (at: ServiceAddress): ServiceUnit => ({ name: launchdName(at), path: join(at.home, "Library", "LaunchAgents", `${launchdName(at)}.plist`) });

const launchd: ServiceManager = {
  words: "launchd agent",
  unit: launchdUnit,
  // KeepAlive brings the host back when it dies; RunAtLoad starts it now and again at every login.
  text: plan =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${xml(launchdName(plan))}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...plan.argv.map(word => `    <string>${xml(word)}</string>`),
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...Object.entries(plan.env).map(([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`),
      "  </dict>",
      `  <key>WorkingDirectory</key><string>${xml(plan.cwd)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      `  <key>StandardOutPath</key><string>${xml(plan.logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(plan.logPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  load: at => [["launchctl", "bootstrap", `gui/${at.uid}`, launchdUnit(at).path]],
  unload: at => [["launchctl", "bootout", `gui/${at.uid}/${launchdName(at)}`]],
  holds: at => ["launchctl", "print", `gui/${at.uid}/${launchdName(at)}`],
  // launchctl answers 113 and says it could not find the service for a label the domain does not have; every other
  // answer is a domain it would not read or a launchctl that is not there.
  absent: answer => answer.code === 113 || /could not find service/i.test(answer.output),
};

const systemdName = (at: ServiceAddress): string => `wsp-host-${serviceTag(at.statePath)}.service`;
const systemdUnit = (at: ServiceAddress): ServiceUnit => ({ name: systemdName(at), path: join(at.home, ".config", "systemd", "user", systemdName(at)) });

const systemd: ServiceManager = {
  words: "systemd user unit",
  unit: systemdUnit,
  text: plan =>
    [
      "[Unit]",
      `Description=wsp host serving ${plan.statePath}`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${plan.argv.map(shellQuote).join(" ")}`,
      // A bare path: systemd reads a quoted WorkingDirectory as not absolute and refuses the whole unit.
      `WorkingDirectory=${plan.cwd}`,
      ...Object.entries(plan.env).map(([name, value]) => `Environment=${shellQuote(`${name}=${value}`)}`),
      "Restart=always",
      "RestartSec=5",
      `StandardOutput=append:${plan.logPath}`,
      `StandardError=append:${plan.logPath}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  load: at => [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", systemdName(at)],
  ],
  unload: at => [
    ["systemctl", "--user", "disable", "--now", systemdName(at)],
    ["systemctl", "--user", "daemon-reload"],
  ],
  holds: at => ["systemctl", "--user", "is-enabled", systemdName(at)],
  // is-enabled exits 1 both for a unit systemd does not have and for a systemctl that never reached the user bus
  // ("Failed to connect to bus: No medium found" on a box without one), so the word it printed is the answer and
  // the code is not.
  absent: answer => {
    const said = answer.output.trim().split("\n").at(-1)?.trim() ?? "";
    return said === "disabled" || said === "not-found" || /no such file or directory/i.test(said);
  },
  // A user unit runs while the person is logged in and no longer, which is what default.target means.
  afterLoad: () => "It comes back at every login; `loginctl enable-linger` keeps it up between them.",
};

export const SERVICE_MANAGERS: { readonly [K in ServiceKind]: ServiceManager } = { launchd, systemd };

/** The manager each platform's own init system is; a platform absent here has none wsp writes units for. */
const BY_PLATFORM: Readonly<Record<string, ServiceKind>> = { darwin: "launchd", linux: "systemd" };

export function serviceManagerFor(platform: string): ServiceManager | undefined {
  const kind = BY_PLATFORM[platform];
  return kind === undefined ? undefined : SERVICE_MANAGERS[kind];
}

/** The one line for a computer wsp writes no unit for, naming what it does write units for. */
export function noManagerLine(platform: string): string {
  const words = Object.entries(BY_PLATFORM).map(([os, kind]) => `a ${SERVICE_MANAGERS[kind].words} on ${os}`);
  return `wsp writes no service on ${platform}; it writes ${words.join(" and ")}. Run wsp up in a terminal that stays open instead.`;
}

export interface ServiceRunner {
  (argv: readonly string[]): Promise<RunResult>;
}

/** A manager's command on this computer. A binary that is not there answers 127 with the same shape, so a Mac
 * without launchctl reads as a refusal rather than a thrown error. */
export const systemRunner: ServiceRunner = argv =>
  new Promise(resolve => {
    execFile(argv[0]!, [...argv.slice(1)], { timeout: 15_000 }, (error, stdout, stderr) => {
      const said = `${stdout}${stderr}`.trim();
      if (error === null) return resolve({ code: 0, output: said });
      const code = "code" in error && typeof error.code === "number" ? error.code : 127;
      resolve({ code, output: said === "" ? error.message : said });
    });
  });

/** The command that failed and what it said, or nothing when every one of them answered 0. */
export interface RunFailure {
  argv: readonly string[];
  result: RunResult;
}

async function runAll(commands: ReadonlyArray<readonly string[]>, run: ServiceRunner): Promise<RunFailure | undefined> {
  for (const argv of commands) {
    const result = await run(argv);
    if (result.code !== 0) return { argv, result };
  }
  return undefined;
}

/** The line a failed manager command reads as: what wsp ran, its code and what it said. */
export function runFailureLine(failure: RunFailure): string {
  const said = failure.result.output === "" ? "and said nothing" : `and said: ${failure.result.output}`;
  return `${failure.argv.join(" ")} exited ${failure.result.code} ${said}`;
}

/** Writes the unit file and hands it to the manager. The file is the person's own: it names their paths, and a
 * manager refuses a unit anyone else could rewrite. */
export async function installService(
  manager: ServiceManager,
  plan: ServicePlan,
  run: ServiceRunner,
): Promise<{ unit: ServiceUnit; installed: boolean; failure?: RunFailure }> {
  const unit = manager.unit(plan);
  mkdirSync(dirname(unit.path), { recursive: true });
  // A refused load only takes back a file this call wrote. One that was already there names a service the manager
  // may still hold, and a manager holding a service with no file is one wsp down can no longer take away.
  const wrote = !existsSync(unit.path);
  writeFileSync(unit.path, manager.text(plan), { mode: 0o600 });
  const failure = await runAll(manager.load(plan), run);
  if (failure !== undefined && wrote) rmSync(unit.path, { force: true });
  return { unit, installed: existsSync(unit.path), ...(failure !== undefined ? { failure } : {}) };
}

/** What a stop did: whether the manager had it, the answer wsp could not read, and the command that refused. */
export interface StopReading {
  unit: ServiceUnit;
  /** Whether the manager answered that it holds it, and so was asked to unload it. */
  held: boolean;
  /** The `holds` answer that was neither "I have it" nor "I do not": nothing was unloaded and the file stands. */
  unsure?: RunFailure;
  failure?: RunFailure;
}

/** Stops the service and takes its unit file away, so nothing brings the host back at the next login. A manager
 * that says it no longer holds it is not asked to stop it, since every one of them refuses a service it does not
 * have; the file still goes, so the next install writes a fresh one. An answer that says neither leaves both the
 * service and its file exactly as they were, for the caller to say so. */
export async function stopService(manager: ServiceManager, at: ServiceAddress, run: ServiceRunner): Promise<StopReading> {
  const unit = manager.unit(at);
  const argv = manager.holds(at);
  const answer = await run(argv);
  const held = answer.code === 0;
  if (!held && !manager.absent(answer)) return { unit, held, unsure: { argv, result: answer } };
  const failure = held ? await runAll(manager.unload(at), run) : undefined;
  if (failure === undefined) rmSync(unit.path, { force: true });
  return { unit, held, ...(failure !== undefined ? { failure } : {}) };
}

/** The `service` row of wsp status: what the manager holds, what is installed and it does not, or that none is. */
export async function serviceReading(manager: ServiceManager | undefined, at: ServiceAddress, run: ServiceRunner, platform: string): Promise<string> {
  if (manager === undefined) return `none; wsp writes no service on ${platform}`;
  const unit = manager.unit(at);
  if (!existsSync(unit.path)) return `none; wsp up --service installs a ${manager.words}`;
  const held = (await run(manager.holds(at))).code === 0;
  return `${manager.words} ${unit.name}, ${held ? "loaded" : "installed and not loaded"} (${unit.path})`;
}

const POLL_MS = 200;

const wait = (ms: number): Promise<void> => new Promise(done => void setTimeout(done, ms));

/** Whether the host a lock names is answering where the lock says it is. The lock is taken before the host binds
 * anything, so the lock alone is a claim and one GET is the proof; any answer at all means something bound it. */
export interface HostProbe {
  (lock: HostLock): Promise<boolean>;
}

const PROBE_MS = 2_000;

export const httpProbe: HostProbe = async lock => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), PROBE_MS);
  try {
    // The lock's address, through the same rule the command line dials by: a host bound to one address answers
    // only there, and probing loopback would report a healthy host as dead.
    await fetch(`http://${authority(dialAddress(lock), lock.port)}/`, { signal: stop.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** Polls until a host holds the lock and answers on the port it names, or the wait runs out. A host that cannot bind
 * takes the lock and dies under KeepAlive or Restart=always, over and over, so a lock that came and went is not a
 * host serving anything. */
export async function untilServing(statePath: string, waitMs: number, answers: HostProbe, sleep: (ms: number) => Promise<void> = wait): Promise<HostLock | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = servingHost(statePath);
    if (lock !== undefined && (await answers(lock))) return lock;
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_MS);
  }
}

/** Polls the lock until it says what the caller waited for, or the wait runs out; the lock as it stands either way,
 * so the caller reads whether it got there from the value and not from a timer. */
export async function untilLock(statePath: string, serving: boolean, waitMs: number, sleep: (ms: number) => Promise<void> = wait): Promise<HostLock | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = servingHost(statePath);
    if ((lock !== undefined) === serving) return lock;
    if (Date.now() >= deadline) return lock;
    await sleep(POLL_MS);
  }
}

/** Both managers append to the log for as long as the service lives and nothing rotates it, so only its end is
 * read. A line the window cut in half is not a line and goes. */
const TAIL_BYTES = 64 * 1024;

/** The last lines of the service's log, for a start that never took: nothing when there is no log yet. */
export function logTail(logPath: string, lines = 20): string[] {
  if (!existsSync(logPath)) return [];
  const fd = openSync(logPath, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const from = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const read = buffer.toString("utf8");
    text = from === 0 ? read : read.slice(read.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
  return text.split("\n").filter(line => line.trim() !== "").slice(-lines);
}

/** A host that took the lock, and whether it answered on the port the lock names. */
export interface HostReading {
  lock: HostLock;
  answering: boolean;
}

/** What wsp status prints: whether a host serves this state file and where, then what keeps it there. Every row is
 * label and value, so a person reads the same columns wsp up prints when it starts. A host that took the lock and
 * answers nothing is a crash loop rewriting that lock, and the row says which of the two it is. */
export function statusLines(statePath: string, host: HostReading | undefined, service: string, now = Date.now()): string[] {
  if (host === undefined) return ["host        not running", `state       ${statePath}`, `service     ${service}`];
  const { lock } = host;
  const publicAt = publicHostname(statePath);
  const up = `pid ${lock.pid}, up ${fmtDuration(now - Date.parse(lock.startedAt))}`;
  return [
    host.answering ? `host        running (${up})` : `host        not answering on port ${lock.port} (${up})`,
    ...addressLines(statePath, lock, publicAt),
    `service     ${service}`,
  ];
}
