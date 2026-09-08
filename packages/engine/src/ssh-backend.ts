// SPDX-License-Identifier: AGPL-3.0-only
// The backend for a workspace on a machine reached over ssh: a machine that
// already exists, the person's own, dialled with their own key. It sits behind
// the same MachineBackend seam the Solari and local backends do, so the runtime
// never learns which kind it holds. Nothing here creates, forks, pauses,
// snapshots or resizes: every capability behind those is false, so each road
// refuses by capability before it reaches this file. exec and run carry one
// script over the ssh client, which is the only thing here that knows the
// machine is not in this process.

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
export type SshTransport = (reach: SshReach, script: string, opts: { timeoutMs?: number; onLine?: (line: string) => void; hostKey?: boolean }) => Promise<ExecResult>;

/** How long the ssh client waits for the machine to answer the dial itself, before the script's own deadline starts
 * mattering: a machine that is off must fail rather than hang a turn. */
export const SSH_CONNECT_TIMEOUT_S = 10;

/** The ssh client's argv for one script. BatchMode keeps a machine that wants a passphrase from stopping a
 * background host at a prompt nobody can see; the script runs under `bash -c` as it does on a guest, never a login
 * shell, which would reset PATH. */
export function sshArgs(reach: SshReach, script: string, opts: { hostKey?: boolean } = {}): string[] {
  return [
    "-n",
    "-T",
    "-o",
    "BatchMode=yes",
    // Nobody can answer a host key prompt on a host that runs in the background, and a key that changed is still
    // refused; the first dial records the key it was given and the person is shown it to compare.
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...(opts.hostKey === true ? ["-o", "LogLevel=DEBUG"] : []),
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    "-p",
    String(reach.port),
    ...(reach.keyPath !== undefined ? ["-i", reach.keyPath, "-o", "IdentitiesOnly=yes"] : []),
    `${reach.user}@${reach.host}`,
    "bash",
    "-c",
    shellQuote(script),
  ];
}

/** The ssh client on this computer, carrying one script to the machine. */
export const sshClient: SshTransport = (reach, script, opts) =>
  runChild("ssh", sshArgs(reach, script, { ...(opts.hostKey !== undefined ? { hostKey: opts.hostKey } : {}) }), {
    env: process.env,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
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

/** What one dial reads off a machine before its record exists: its login environment and the size the row shows.
 * The PATH is a login shell's, asked for on purpose and once: on the person's own machine the tools a turn runs are
 * where their own shell finds them, not where a golden put them. Linux answers the first branch of each pair,
 * macOS the second. */
export const SSH_READ_SCRIPT = [
  'printf "home %s\\n" "$HOME"',
  'printf "user %s\\n" "$(id -un)"',
  'printf "path %s\\n" "$(bash -lc \'printf %s "$PATH"\' 2>/dev/null)"',
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
  if (home === undefined || !home.startsWith("/")) throw new Error(`${reach.user}@${reach.host} answered over ssh with no home folder for ${reach.user}`);
  const cpu = Number(values["cpu"] ?? 0);
  const memMb = Math.round(Number(values["memkb"] ?? 0) / 1024);
  const path = values["path"];
  const hostKey = hostKeyOf(res.stderr);
  return {
    login: { HOME: home, USER: values["user"] ?? reach.user, PATH: path === undefined || path === "" ? DEFAULT_REMOTE_PATH : path },
    shape: { cpu, memMb },
    ...(hostKey !== undefined ? { hostKey } : {}),
  };
}

/** What a turn's PATH falls back to when the machine's own login shell printed none: what a POSIX login gives
 * anyway, so a harness the person installed elsewhere is missing rather than every command being. */
export const DEFAULT_REMOTE_PATH = "/usr/local/bin:/usr/bin:/bin";

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
    ramPreservingPause: false,
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
