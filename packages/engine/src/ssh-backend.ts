// SPDX-License-Identifier: AGPL-3.0-only
// The backend for a workspace on a machine reached over ssh: a machine that
// already exists, the person's own, dialled with their own key. It sits behind
// the same MachineBackend seam the Solari and local backends do, so the runtime
// never learns which kind it holds. Nothing here creates, forks, pauses,
// snapshots or resizes: every capability behind those is false, so each road
// refuses by capability before it reaches this file. exec and run carry one
// script over the ssh client, which is the only thing here that knows the
// machine is not in this process.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { shellQuote } from "@wsp/protocol";
import type { Capabilities } from "@wsp/protocol";
import { runChild } from "./child-exec.js";
import type { BackendPricing, ExecResult, Machine, MachineBackend, MachineShape, MachineState, RunOptions, SnapshotStoragePricing } from "./machine.js";

/** How the ssh client is dialled: who to log in as, where, on which port, and the person's own key when they named
 * one (absent leaves ssh its own config and agent, which is how most people already reach their machines). */
export interface SshReach {
  user: string;
  host: string;
  port: number;
  keyPath?: string;
}

/** The machine's login environment, read on the one call that recorded the workspace: where its home is, who a turn
 * runs as, and the PATH a login shell there gets, which is the only way a tool the person installed under their own
 * home is found by a turn (a non-interactive ssh command gets a bare one). Read once and recorded, the way a
 * golden's PATH is, rather than probed on every launch. */
export type SshLogin = Readonly<Record<string, string>> & { HOME: string; USER: string; PATH: string };

/** The port ssh uses when the person named none. */
export const SSH_DEFAULT_PORT = 22;

const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

/** The one written form of an ssh machine: its id on the record, which is also the dial. Everything a later host
 * process needs to reach it again is in here, so a record rehydrates with no second store to read and nothing but
 * this module ever looks inside it. */
export function sshMachineId(reach: SshReach): string {
  const url = new URL(`ssh://${encodeURIComponent(reach.user)}@${reach.host}:${reach.port}`);
  if (reach.keyPath !== undefined) url.searchParams.set("key", reach.keyPath);
  return url.toString();
}

/** The target an id names, or nothing when the id is not one of ours: a record from another backend, or a string
 * that was never an ssh address. */
export function parseSshMachineId(id: string): SshReach | undefined {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ssh:") return undefined;
  const user = decodeURIComponent(url.username);
  const key = url.searchParams.get("key");
  if (user === "" || url.hostname === "") return undefined;
  return { user, host: url.hostname, port: Number(url.port) || SSH_DEFAULT_PORT, ...(key !== null ? { keyPath: key } : {}) };
}

/** The dial a person's `user@host` word names, with the port they gave or ssh's own, and their key when they named
 * one. A word with no user is refused rather than guessed at: who a turn runs as on their machine is theirs to say. */
export function parseSshAddress(address: string, opts: { port?: number; keyPath?: string } = {}): SshReach {
  const at = address.lastIndexOf("@");
  const user = at === -1 ? "" : address.slice(0, at);
  const rest = address.slice(at + 1);
  const colon = rest.lastIndexOf(":");
  const host = colon === -1 ? rest : rest.slice(0, colon);
  const named = colon === -1 ? undefined : Number(rest.slice(colon + 1));
  if (user === "" || host === "") throw new Error(`${address} is not an ssh address; name the machine as user@host`);
  const port = opts.port ?? named ?? SSH_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${address} names no port ssh can dial`);
  return { user, host, port, ...(opts.keyPath !== undefined ? { keyPath: opts.keyPath } : {}) };
}

/** What a machine reached over ssh is called when the person named no name: the host's own first label, and the
 * whole address where cutting at a dot would leave a number (an IPv4 address) or there is nothing to cut. */
export function sshMachineName(reach: SshReach): string {
  const dot = reach.host.indexOf(".");
  return dot === -1 || /^[\d.]+$/.test(reach.host) ? reach.host : reach.host.slice(0, dot);
}

/** How a script reaches the machine. The client below is the only implementation that leaves this computer; a test
 * hands its own and reads what the machine was asked to run. `hostKey` asks the client to log what the connection
 * saw, so the one dial that records a machine can quote the key it answered with; every other call leaves it off,
 * since the log would otherwise ride every command's stderr. */
export type SshTransport = (reach: SshReach, script: string, opts: { timeoutMs?: number; onLine?: (line: string) => void; hostKey?: boolean; stdin?: Uint8Array }) => Promise<ExecResult>;

/** How long the ssh client waits for the machine to answer the dial itself, before the script's own deadline starts
 * mattering: a machine that is off must fail rather than hang a turn. */
export const SSH_CONNECT_TIMEOUT_S = 10;

/** How long an idle master connection is kept after the last command through it. A turn polls its log every second
 * and a half, so without one every poll is a key exchange and a line in the machine's auth log (measured: seven
 * logins for one 2.4 second turn); with one, a turn is one login and the master goes when the work stops. */
export const SSH_CONTROL_PERSIST_S = 60;

/** The folder the master connections listen in: wsp's own under the person's home, never a folder every login on
 * this computer shares. Whoever holds a control socket holds every command that rides it, and a shared temp folder
 * is world writable on Linux with a name anyone can work out, so another account could sit on the path first. */
export function sshControlDir(home: string = homedir()): string {
  return join(home, ".wsp", "ssh");
}

/** The mode that folder is made and kept at: the person's own and nobody else's. */
export const SSH_CONTROL_DIR_MODE = 0o700;

/** Makes it before a dial can need it, and tightens one that was left looser, since a folder already there at other
 * modes would hand the sockets to whoever made it. */
export function makeSshControlDir(home?: string): string {
  const dir = sshControlDir(home);
  mkdirSync(dir, { recursive: true, mode: SSH_CONTROL_DIR_MODE });
  chmodSync(dir, SSH_CONTROL_DIR_MODE);
  return dir;
}

/** The socket the master connection for one machine listens on. Named by a hash of the dial rather than by the
 * address, since a unix socket path is capped near 104 characters and a host name is not; one per user, host and
 * port, so two records of one machine share the master and two machines never do. */
export function sshControlPath(reach: SshReach, dir: string = sshControlDir()): string {
  return join(dir, `wsp-ssh-${createHash("sha256").update(`${reach.user}@${reach.host}:${reach.port}`).digest("hex").slice(0, 16)}.sock`);
}

/** The ssh client's argv for one script. The script runs under `bash -c` as it does on a guest, never a login
 * shell, which would reset PATH. Every command rides one master connection per machine, so a turn's polls are one
 * login rather than one each. */
export function sshArgs(reach: SshReach, script: string, opts: { hostKey?: boolean; controlDir?: string; stdin?: boolean } = {}): string[] {
  return [
    // -n hands the script /dev/null for stdin; the one road that carries a file's bytes writes them there instead.
    ...(opts.stdin === true ? [] : ["-n"]),
    "-T",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${sshControlPath(reach, opts.controlDir)}`,
    "-o",
    `ControlPersist=${SSH_CONTROL_PERSIST_S}`,
    ...sshDialArgs(reach, opts),
    `${reach.user}@${reach.host}`,
    "bash",
    "-c",
    shellQuote(script),
  ];
}

/** How every ssh child this host starts is dialled, whatever it then does on the connection. BatchMode keeps a
 * machine that wants a passphrase from stopping a background host at a prompt nobody can see. Nobody can answer a
 * host key prompt there either, and a key that changed is still refused; the first dial records the key it was
 * given and the person is shown it to compare. The command road and the forward road both build on this, so how
 * wsp dials a machine is one rule and not two. */
export function sshDialArgs(reach: SshReach, opts: { hostKey?: boolean } = {}): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...(opts.hostKey === true ? ["-o", "LogLevel=DEBUG"] : []),
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    "-p",
    String(reach.port),
    ...(reach.keyPath !== undefined ? ["-i", reach.keyPath, "-o", "IdentitiesOnly=yes"] : []),
  ];
}

/** The ssh client on this computer, carrying one script to the machine. The folder its master socket lives in is
 * made here, on the way out, so no dial can be the first thing to need it. */
export const sshClient: SshTransport = (reach, script, opts) =>
  runChild("ssh", sshArgs(reach, script, { controlDir: makeSshControlDir(), ...(opts.hostKey !== undefined ? { hostKey: opts.hostKey } : {}), ...(opts.stdin !== undefined ? { stdin: true } : {}) }), {
    env: process.env,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });

/** The key the machine answered the connection with, as the client logged it: its type and the SHA256 fingerprint
 * every other ssh tool prints. Absent when the client logged none, which leaves the record without an identity of
 * the machine's own rather than inventing one. */
export function hostKeyOf(clientLog: string): string | undefined {
  return /^debug\d+: Server host key: (\S+ SHA256:\S+)/m.exec(clientLog)?.[1];
}

/** What a machine over ssh is, as the machine itself answers: the key it holds and the login a turn runs as. Two
 * records of the same machine under different keys, ports, aliases or addresses answer with this same string, which
 * is what keeps one workspace on one machine. */
export function sshIdentity(hostKey: string, user: string): string {
  return `${hostKey} as ${user}`;
}

/** The client's own words with its debug log taken out: what a person can act on when a dial fails. */
function clientWords(text: string): string {
  return text
    .split("\n")
    .filter(line => !/^debug\d+:/.test(line))
    .join("\n")
    .trim();
}

/** The store variable each harness reads, by name, as the catalog gives them. The shape rule is what keeps a
 * catalog entry out of the read as shell: the name is interpolated into a printf inside the login shell, so a name
 * that is not a plain variable name is left out rather than carried there. */
export const SSH_STORE_VARS: readonly string[] = CATALOG_AGENTS.map(a => a.stateHomeEnv).filter((name): name is string => name !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(name));

/** The one login shell the read opens: the PATH a turn runs under, and the store variable each harness reads, so a
 * machine whose person points their harness at another folder is signed in for a turn the way it is for them. */
const LOGIN_READ = ["printf \"path %s\\n\" \"$PATH\"", ...SSH_STORE_VARS.map(name => `printf "store:${name} %s\\n" "$${name}"`)].join("; ");

/** What one dial reads off a machine before its record exists: its login environment and the size the row shows.
 * The PATH and the stores come from a login shell, asked for on purpose and once: on the person's own machine the
 * tools a turn runs and the folder their harness reads are where their own shell finds them, not where a golden put
 * them. Linux answers the first branch of each size pair, macOS the second. */
export const SSH_READ_SCRIPT = [
  'printf "home %s\\n" "$HOME"',
  'printf "user %s\\n" "$(id -un)"',
  `bash -lc ${shellQuote(LOGIN_READ)} 2>/dev/null`,
  'printf "cpu %s\\n" "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"',
  'printf "memkb %s\\n" "$(awk \'/MemTotal/{print $2}\' /proc/meminfo 2>/dev/null || echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 )))"',
].join("\n");

function readValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) values[line.slice(0, space)] = line.slice(space + 1).trim();
  }
  return values;
}

/** One dial that both proves the machine answers and records what wsp needs of it. A dial that fails carries the
 * client's own words back, since they are what tells the person whether it was the key, the host or the network. */
export async function readSshMachine(reach: SshReach, transport: SshTransport = sshClient): Promise<{ login: SshLogin; shape: MachineShape; hostKey?: string }> {
  const res = await transport(reach, SSH_READ_SCRIPT, { timeoutMs: 30_000, hostKey: true });
  if (res.exitCode !== 0) throw new Error(`${reach.user}@${reach.host} did not answer over ssh: ${(clientWords(res.stderr) || res.stdout.trim()).slice(-300)}`);
  const values = readValues(res.stdout);
  const home = values["home"];
  if (home === undefined || !isPlainPath(home)) throw new Error(homeRefusal(reach, home));
  const stores: Record<string, string> = {};
  for (const name of SSH_STORE_VARS) {
    const folder = values[`store:${name}`];
    // A store the person points elsewhere is a path a turn's command carries, so it is held to the same rule the
    // home is: a plain absolute path, or the harness's default under the home stands instead.
    if (folder !== undefined && folder !== "" && isPlainPath(folder)) stores[name] = folder;
  }
  const cpu = Number(values["cpu"] ?? 0);
  const memMb = Math.round(Number(values["memkb"] ?? 0) / 1024);
  const hostKey = hostKeyOf(res.stderr);
  return {
    login: { ...stores, HOME: home, USER: values["user"] ?? reach.user, PATH: plainPath(values["path"]) },
    shape: { cpu, memMb },
    ...(hostKey !== undefined ? { hostKey } : {}),
  };
}

/** Every folder a turn's paths are built from is held to this: absolute, and made of what a path is made of. A
 * machine can answer with anything, and what it answers lands in the commands a turn runs there, so a home carrying
 * a semicolon, a quote, a backtick or a glob is refused at the one door rather than quoted at each of twenty places
 * (the paths are quoted too; this is what keeps a machine from deciding what those paths mean). A space is a path
 * on macOS and stays allowed. */
export function isPlainPath(path: string): boolean {
  return path.startsWith("/") && /^[A-Za-z0-9 ._+@:,/-]+$/.test(path) && !path.includes("//");
}

function homeRefusal(reach: SshReach, home: string | undefined): string {
  const said = home === undefined || home === "" ? "no home folder" : `${JSON.stringify(home)}, which is not a plain path`;
  return `${reach.user}@${reach.host} answered over ssh with ${said} for ${reach.user}`;
}

/** Loopback names and addresses, and the suffix a Mac gives its own name on the local network: what a dial that
 * names the computer wsp runs on looks like. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Whether this dial reaches the computer wsp is running on: the same machine as the local workspace, under another
 * name. A request relayed from a machine may drive a workspace over ssh, and this is the one such workspace it may
 * not, since it is this computer wearing another kind's clothes. `names` is what this computer answers to. */
export function sshDialsThisComputer(reach: SshReach, names: readonly string[]): boolean {
  const host = reach.host.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK.has(host) || host.startsWith("127.")) return true;
  const own = names.map(n => n.toLowerCase().replace(/\.$/, "")).filter(n => n !== "");
  return own.some(name => host === name || host === `${name}.local` || `${host}.local` === name);
}

/** What a turn's PATH falls back to when the machine's own login shell printed none: what a POSIX login gives
 * anyway, so a harness the person installed elsewhere is missing rather than every command being. */
export const DEFAULT_REMOTE_PATH = "/usr/local/bin:/usr/bin:/bin";

/** The machine's own login PATH, each folder in it held to the rule the home is held to. It is the last thing the
 * machine answers with that ends up written rather than run: a turn exports it, and the daemon's unit states it,
 * where systemd splits an Environment= line on whitespace and reads a quote as quoting. A folder carrying a quote
 * or a space is dropped rather than escaped at each of those, and a PATH with nothing left in it falls back, so a
 * machine that answers with something unusable leaves a harness missing rather than every command. */
export function plainPath(path: string | undefined): string {
  const kept = (path ?? "").split(":").filter(folder => folder !== "" && isPlainPath(folder) && !/\s/.test(folder));
  return kept.length === 0 ? DEFAULT_REMOTE_PATH : kept.join(":");
}

/** What the write answers with once the bytes are on disk under their own name. */
export const SSH_BYTES_OK = "WSP_BYTES_OK";

/** The script that takes a file's bytes off the connection's stdin. The bytes land beside the target under a name
 * of their own and are moved into place only once the byte count matches, so a connection cut halfway leaves the
 * target as it was rather than a file that looks whole. `wc` pads its count on some systems, so the spaces go.
 * Nothing of the file's content is named in the command, which is the point of this road for a secret: a command
 * sits in /proc/<pid>/cmdline for its own length, and every account on the machine can read it there. */
export function putBytesScript(path: string, size: number, tmp: string): string {
  return [
    "set -e",
    // The file is the writer's alone until something widens it: a machine somebody owns may carry other accounts,
    // and what travels this road is a daemon token as often as it is an archive.
    "umask 077",
    `mkdir -p ${shellQuote(posix.dirname(path))}`,
    `cat > ${shellQuote(tmp)}`,
    `[ "$(wc -c < ${shellQuote(tmp)} | tr -d ' ')" = ${size} ] || { rm -f ${shellQuote(tmp)}; echo WSP_BYTES_SHORT; exit 1; }`,
    `mv -f ${shellQuote(tmp)} ${shellQuote(path)}`,
    `echo ${SSH_BYTES_OK}`,
  ].join("\n");
}

/** A machine reached over ssh: exec and run carry a script to it, and the moves only a machine wsp forks takes
 * throw, since the capability behind each is false and the runtime refuses them first. It carries no preview route,
 * no signed URL and no snapshot, and its own state is running: nothing here may call the person's own machine gone
 * on a dial that failed, since a machine that is off is one they turn on again. */
export class SshMachine implements Machine {
  readonly id: string;
  readonly kind = "sandbox" as const;
  readonly streamUrl = undefined;

  constructor(
    readonly reach: SshReach,
    private readonly transport: SshTransport,
  ) {
    this.id = sshMachineId(reach);
  }

  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.transport(this.reach, cmd, { ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return this.transport(this.reach, script, { timeoutMs: opts.deadlineMs, ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}) });
  }

  async snapshot(): Promise<string> {
    throw new Error("a machine reached over ssh cannot be snapshotted");
  }

  async pause(): Promise<void> {
    throw new Error("a machine reached over ssh cannot be paused");
  }

  async resume(): Promise<void> {
    throw new Error("a machine reached over ssh cannot be resumed");
  }

  /** Deleting an ssh workspace drops its record: the machine is the person's own and wsp never made it. */
  async kill(): Promise<void> {}

  async state(): Promise<MachineState> {
    return "running";
  }

  async describe(): Promise<MachineShape> {
    return (await readSshMachine(this.reach, this.transport)).shape;
  }

  async downloadUrl(): Promise<string> {
    throw new Error("a machine reached over ssh serves no signed download URL; its files are read over the connection");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("a machine reached over ssh serves no signed upload URL; its files are written over the connection");
  }

  /** The machine's own road for bytes, which is the connection itself: the file rides stdin under a script that
   * writes it, since nothing here mints a URL anything could PUT to. */
  async putBytes(path: string, bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<void> {
    const tmp = `${path}.wsp-in-${randomBytes(6).toString("hex")}`;
    const res = await this.transport(this.reach, putBytesScript(path, bytes.length, tmp), { stdin: bytes, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (res.exitCode !== 0 || !res.stdout.includes(SSH_BYTES_OK)) {
      throw new Error(`${bytes.length} bytes did not land at ${path} over ssh (exit ${res.exitCode}): ${(clientWords(res.stderr) || res.stdout.trim()).slice(-300)}`);
    }
  }
}

export interface SshBackendOptions {
  /** How a script reaches a machine; the ssh client on this computer unless a test hands its own. */
  transport?: SshTransport;
}

/** The backend for every ssh machine a host has a record of. It holds no fleet of its own: a machine that already
 * exists is known by the record that names it, so get answers from the id and list answers with nothing. */
export class SshBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false,
    resize: false,
    previewUrls: false,
    signedUrls: false,
    containers: false,
    callbackRelay: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    // The machine is the person's own: nothing on it was made by wsp and nothing on it is thrown away, so a turn's
    // access starts at what its harness asks for rather than at skip-everything.
    kept: true,
  };

  /** Nothing wsp runs is billed here, and no size is a default on a machine that already exists: every record
   * carries what its own machine answered with. */
  readonly pricing: BackendPricing = {
    rateUsdPerHour: () => 0,
    defaultSize: { cpu: 0, memMb: 0 },
    snapshotStorage: NO_SNAPSHOT_STORAGE,
  };

  private readonly transport: SshTransport;

  constructor(opts: SshBackendOptions = {}) {
    this.transport = opts.transport ?? sshClient;
  }

  async create(): Promise<Machine> {
    throw new Error("a machine reached over ssh already exists; wsp records it, it does not make it");
  }

  async get(id: string): Promise<Machine> {
    const reach = parseSshMachineId(id);
    if (reach === undefined) throw new Error(`${id} is not a machine this host reaches over ssh`);
    return new SshMachine(reach, this.transport);
  }

  /** The persisted records are the fleet: nothing on the far side lists the machines a person reaches over ssh. */
  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [];
  }

  async deleteSnapshot(): Promise<void> {
    throw new Error("a machine reached over ssh holds no snapshots");
  }

  /** Reads a machine over ssh and hands back the handle its record stands on, so the one call that records a
   * workspace is also the one that proves the dial works. */
  async adopt(reach: SshReach): Promise<{ machine: SshMachine; login: SshLogin; shape: MachineShape; hostKey?: string }> {
    const { login, shape, hostKey } = await readSshMachine(reach, this.transport);
    return { machine: new SshMachine(reach, this.transport), login, shape, ...(hostKey !== undefined ? { hostKey } : {}) };
  }
}

/** The dial behind a machine handle, read off its id, which is the same fact whoever holds the handle. */
export function sshReachOf(machine: Machine): SshReach | undefined {
  return parseSshMachineId(machine.id);
}
