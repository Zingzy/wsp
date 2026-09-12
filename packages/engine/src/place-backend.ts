// SPDX-License-Identifier: AGPL-3.0-only
// The backend for a workspace on a computer the person joined: a computer that
// already exists, theirs, reached over the link it opened to this host. It sits
// behind the same MachineBackend seam the Solari, local and ssh backends do, so
// the runtime never learns which kind it holds. Nothing here creates, forks,
// pauses, snapshots or resizes: every capability behind those is false, so each
// road refuses by capability before it reaches this file. One call leaves this
// module, the transport, which is one `exec` frame on the link.

import { randomBytes } from "node:crypto";
import type { Capabilities, MachineFacts } from "@wsp/protocol";
import { execDetached } from "./exec-detached.js";
import { OS_READ, UPTIME_READ, HOME_READ, osNameOf, readValues, uptimeMsOf } from "./machine-facts.js";
import { SSH_BYTES_OK, putBytesScript } from "./ssh-backend.js";
import type { BackendPricing, ExecResult, Machine, MachineBackend, MachineShape, MachineState, RunOptions, SnapshotStoragePricing } from "./machine.js";

const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

/** The one written form of a place's machine: its id on the record, which names the place the link belongs to and
 * nothing else. Everything a later host process needs is the place record, so this is the whole id. */
export const placeMachineId = (placeId: string): string => `place:${placeId}`;

/** The place an id names, or nothing when the id is not one of ours: a record from another backend. */
export function parsePlaceMachineId(id: string): string | undefined {
  const placeId = id.startsWith("place:") ? id.slice("place:".length) : "";
  return placeId === "" ? undefined : placeId;
}

/** How a command reaches a place: one `exec` frame on the link that place is holding. The runtime hands this in,
 * since it is the runtime that holds the links; a place that is not connected is a rejection with the sentence
 * saying so, which is the same answer every road on an absent place gets. */
export type PlaceTransport = (placeId: string, cmd: string, opts: { timeoutMs?: number; stdin?: Uint8Array }) => Promise<ExecResult>;

/** What the machine says about itself on every status: the system it runs, how long it has been up, and the folder
 * a command starts in. The same three reads a machine over ssh answers, off one script, since what a computer says
 * about itself does not turn on how the host reached it. */
const FACTS_SCRIPT = [...OS_READ, ...UPTIME_READ, HOME_READ].join("\n");

/** How long the reads this module makes of its own accord get. A place answers over its link with no provider edge
 * in the way, so these are bounds on a busy computer and not on a gateway. */
const FACTS_MS = 10_000;
const DESCRIBE_MS = 10_000;

/** A computer the person joined, driven over its link: exec and run carry a script to it, and the moves only a
 * machine wsp forks takes throw, since the capability behind each is false and the runtime refuses them first. Its
 * own state is running: a place that is off is one the person turns on again, and nothing here calls a computer of
 * theirs gone. */
export class PlaceMachine implements Machine {
  readonly id: string;
  readonly kind = "sandbox" as const;
  readonly streamUrl = undefined;

  constructor(
    readonly placeId: string,
    private readonly transport: PlaceTransport,
    /** Where a long run's script, log and exit code go on that computer: wsp's own folder under the login's home,
     * off the report the place sent. A folder every account on the machine shares is one another account could sit
     * in first, so a place with no home on record takes no long run rather than guessing one. */
    private readonly runDir?: string,
  ) {
    this.id = placeMachineId(placeId);
  }

  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.transport(this.placeId, cmd, { ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  }

  /** A command that may run for minutes: launched detached under wsp's own folder on that computer and polled by
   * short execs, the road every machine without a long-lived channel takes. */
  run(script: string, opts: RunOptions): Promise<ExecResult> {
    if (this.runDir === undefined) throw new Error(`${this.id} has no run folder on record, so nothing long can be launched there; it is recorded again when the place reports its login`);
    return execDetached(this, script, opts, this.runDir);
  }

  async snapshot(): Promise<string> {
    throw new Error("a computer you joined cannot be snapshotted");
  }

  async pause(): Promise<void> {
    throw new Error("a computer you joined cannot be paused");
  }

  async resume(): Promise<void> {
    throw new Error("a computer you joined cannot be resumed");
  }

  /** Deleting a place's workspace drops its record: the computer is the person's own and wsp never made it. What
   * comes off that computer is the remove's own business, over the link. */
  async kill(): Promise<void> {}

  async state(): Promise<MachineState> {
    return "running";
  }

  async describe(): Promise<MachineShape> {
    const read = await this.exec('printf "cpu %s\\n" "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"\nprintf "memkb %s\\n" "$(awk \'/MemTotal/{print $2}\' /proc/meminfo 2>/dev/null || echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 )))"', { timeoutMs: DESCRIBE_MS });
    const values = readValues(read.stdout);
    return { cpu: Number(values["cpu"] ?? 0), memMb: Math.round(Number(values["memkb"] ?? 0) / 1024) };
  }

  /** Read over the link on every status: nothing here is remembered, since a computer somebody owns is rebooted
   * and upgraded under wsp rather than by it. */
  async facts(): Promise<MachineFacts> {
    const res = await this.exec(FACTS_SCRIPT, { timeoutMs: FACTS_MS });
    const values = res.exitCode === 0 ? readValues(res.stdout) : {};
    const os = osNameOf(values);
    const uptimeMs = uptimeMsOf(values, Date.now());
    const folder = values["home"];
    if (os === undefined || uptimeMs === undefined || folder === undefined || folder === "") {
      throw new Error(`${this.id} did not say what it is over its link (exit ${res.exitCode}): ${(res.stderr.trim() || res.stdout.trim()).slice(-300)}`);
    }
    return { os, uptimeMs, folder };
  }

  async downloadUrl(): Promise<string> {
    throw new Error("a computer you joined serves no signed download URL; its files are read over its link");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("a computer you joined serves no signed upload URL; its files are written over its link");
  }

  /** The machine's own road for bytes, which is the link itself: the file rides the exec op's stdin under the same
   * script the ssh road writes with, since nothing here mints a URL anything could PUT to. */
  async putBytes(path: string, bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<void> {
    const tmp = `${path}.wsp-in-${randomBytes(6).toString("hex")}`;
    const res = await this.transport(this.placeId, putBytesScript(path, bytes.length, tmp), {
      stdin: bytes,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (res.exitCode !== 0 || !res.stdout.includes(SSH_BYTES_OK)) {
      throw new Error(`${bytes.length} bytes did not land at ${path} over the link (exit ${res.exitCode}): ${(res.stderr.trim() || res.stdout.trim()).slice(-300)}`);
    }
  }
}

/** The backend for every place a host holds a record of. It holds no fleet of its own: a computer that already
 * exists is known by the record that names it, so get answers from the id and list answers with nothing. */
export class PlaceBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false,
    resize: false,
    replacesMachine: false, // the computer is the person's own: wsp made it no image and throws it away for nothing
    previewUrls: false,
    signedUrls: false,
    containers: false,
    callbackRelay: false,
    diskSnapshots: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    // The computer is the person's own: nothing on it was made by wsp and nothing on it is thrown away, so a turn's
    // access starts at what its harness asks for rather than at skip-everything.
    kept: true,
  };

  /** Nothing wsp runs is billed here, and no size is a default on a computer that already exists: every record
   * carries what its own place reported. */
  readonly pricing: BackendPricing = {
    rateUsdPerHour: () => 0,
    defaultSize: { cpu: 0, memMb: 0 },
    snapshotStorage: NO_SNAPSHOT_STORAGE,
  };

  constructor(
    private readonly transport: PlaceTransport,
    /** Where a long run's files go on one place, off the login that place reported; the runtime holds the records,
     * so it answers. */
    private readonly runDir?: (placeId: string) => string | undefined,
  ) {}

  async create(): Promise<Machine> {
    throw new Error("a computer you joined already exists; wsp records it, it does not make it");
  }

  async get(id: string): Promise<Machine> {
    const placeId = parsePlaceMachineId(id);
    if (placeId === undefined) throw new Error(`${id} is not a machine this host reaches as a place`);
    const runDir = this.runDir?.(placeId);
    return new PlaceMachine(placeId, this.transport, runDir);
  }

  /** The persisted records are the fleet: nothing on the far side lists the computers a person joined. */
  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [];
  }

  async deleteSnapshot(): Promise<void> {
    throw new Error("a computer you joined holds no snapshots");
  }
}
