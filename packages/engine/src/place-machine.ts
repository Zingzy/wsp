// SPDX-License-Identifier: AGPL-3.0-only
// The computer itself as something the engine can run steps on. Every other
// Machine here is a workspace: a machine wsp made, which can be paused,
// snapshotted and killed. A computer somebody joined is none of those, so this
// one carries the three calls a run needs (a command, a long command, bytes)
// over the exec frame its daemon already serves, and refuses the rest in one
// sentence rather than sending a frame nothing on the far side would take.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { DaemonExecReply, EXEC_TIMEOUT_MAX_MS, base64Length, cgroupJoinLine, placeProvisionPaths, shellQuote, type Capabilities } from "@wsp/protocol";
import { INLINE_EXEC_MS, execDetached, machineAnswer } from "./exec-detached.js";
import { LINK_MARGIN_MS, type MachineLink } from "./link-backend.js";
import type { BackendPricing, BytesLanded, ExecResult, Machine, MachineBackend, MachineKind, MachineListRow, MachineState, RunOptions } from "./machine.js";
import { asLogin, loginShellPath, targetLogin, type TargetLogin } from "./target-line.js";

/** What every call that belongs to a workspace refuses with on the computer itself. */
export const NOT_A_WORKSPACE = "this is the computer itself, not a workspace on it";

/** How much of a file one frame carries. The bytes ride the frame's stdin as base64, so a part this size is 1.4 MB
 * on the wire and crosses in 6.6 s at the rate below: under a quarter of the 30 s a daemon ends a link it has heard
 * nothing on after, so a link at a third of that rate still lands a part inside it. Twice the size would be half
 * that bound, with no room for a slower link. */
export const PLACE_PART_BYTES = 1024 * 1024;

/** The slowest this road has been measured at, in bytes a millisecond: 6.6 MB of daemon over a joined computer's
 * link in 31 s (2026-09-18), with the daemon's own restart inside that window, so the real rate is higher. Every
 * part's bound is read off it rather than off a number somebody picked. */
const LINK_BYTES_PER_MS = 213;

/** What one part's frame asks for: twice as long as its base64 takes to cross at the rate above, so a link at half
 * that rate still lands it, never under the bound a plain command gets and never over the cap the daemon holds its
 * own timer to. */
export function placePartBoundMs(bytes: number, floorMs: number = INLINE_EXEC_MS): number {
  return Math.min(Math.max(2 * Math.ceil(base64Length(bytes) / LINK_BYTES_PER_MS), floorMs), EXEC_TIMEOUT_MAX_MS);
}

/** One computer you own, driven over the link its daemon holds to this host: one exec frame per command, a
 * detached run under wsp's own folder there for anything longer, and bytes in parts on the frames' own stdin.
 * Nothing here pauses, snapshots or kills it: it is the computer the person is keeping, not a machine wsp made. */
export class PlaceMachine implements Machine {
  readonly id: string;
  readonly kind: MachineKind = "sandbox";
  readonly takesStdin = true;
  private readonly home: string;

  constructor(
    private readonly link: Pick<MachineLink, "request">,
    o: { id: string; home: string },
  ) {
    this.id = o.id;
    this.home = o.home;
  }

  /** The daemon's own exec frame, held under the cap the daemon holds its own timer to, with the link given the
   * frame's wait and the margin the road takes on top of it. Bytes a caller has for the command's own stdin ride
   * the frame's own field, so nothing of them is in the command and the exec body's cap is not what bounds them. */
  async exec(cmd: string, opts?: { timeoutMs?: number; idempotencyKey?: string; stdin?: Uint8Array }): Promise<ExecResult> {
    const timeoutMs = Math.min(opts?.timeoutMs ?? INLINE_EXEC_MS, EXEC_TIMEOUT_MAX_MS);
    const answer = await this.link.request(
      "exec",
      { cmd, timeoutMs, ...(opts?.stdin !== undefined ? { stdin: Buffer.from(opts.stdin).toString("base64") } : {}) },
      { timeoutMs: timeoutMs + LINK_MARGIN_MS, ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}) },
    );
    const reply = DaemonExecReply.parse(answer);
    return { exitCode: reply.exitCode, stdout: reply.stdout, stderr: reply.stderr };
  }

  /** A step that may run for minutes: the same detached launch and polls every machine without a long-lived
   * channel takes, under wsp's own folder on that computer rather than a folder every login there shares. */
  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return execDetached(this, script, opts, placeProvisionPaths(this.home).runDir);
  }

  /** Bytes through the one road this machine has: the file in parts, each one exec frame carrying its part on the
   * frame's own stdin, and a last frame joining the parts in order and taking them away. A part is written over
   * rather than appended and the join is skipped once the parts are gone, so a frame whose answer the link lost is
   * sent again and the file still reads the same bytes once. The parts are what a trip over this road costs, and
   * they ride back on the answer. Every part and the file are the login's alone, whatever mask the daemon runs under,
   * since what lands this way is often a config or a secret; a caller that wants the file shared sets its mode. */
  async putBytes(path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<BytesLanded> {
    const at = shellQuote(path);
    const parts = Math.max(1, Math.ceil(bytes.length / PLACE_PART_BYTES));
    const names = `${at}.part{0..${parts - 1}}`;
    const put = randomBytes(6).toString("hex");
    try {
      for (let i = 0; i < parts; i++) {
        const part = bytes.subarray(i * PLACE_PART_BYTES, Math.min((i + 1) * PLACE_PART_BYTES, bytes.length));
        const res = await this.exec(["umask 077", `mkdir -p ${shellQuote(posix.dirname(path))}`, `cat > ${at}.part${i}`].join("\n"), {
          timeoutMs: placePartBoundMs(part.length, opts?.timeoutMs),
          idempotencyKey: `${put}/${i}`,
          stdin: part,
        });
        if (res.exitCode !== 0) throw new Error(`part ${i + 1} of ${parts} did not land at ${path} on ${this.id}: ${machineAnswer(res)}`);
      }
      const joined = await this.exec(`umask 077; if [ -e ${at}.part0 ]; then cat ${names} > ${at} && rm -f ${names}; fi`, {
        idempotencyKey: `${put}/join`,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (joined.exitCode !== 0) throw new Error(`${path} did not land on ${this.id}: ${machineAnswer(joined)}`);
    } catch (e) {
      // Every part name, not only the ones that answered: a part can be written on that computer and its answer
      // lost, and a file's worth of parts under wsp's own folder there is what a failed round would leave for good.
      await this.exec(`rm -f ${names}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
      throw e;
    }
    return { pieces: parts };
  }

  state(): Promise<MachineState> {
    return Promise.resolve("running");
  }

  snapshot(): Promise<string> {
    return Promise.reject(new Error(NOT_A_WORKSPACE));
  }

  pause(): Promise<void> {
    return Promise.reject(new Error(NOT_A_WORKSPACE));
  }

  resume(): Promise<void> {
    return Promise.reject(new Error(NOT_A_WORKSPACE));
  }

  kill(): Promise<void> {
    return Promise.reject(new Error(NOT_A_WORKSPACE));
  }

  downloadUrl(): Promise<string> {
    return Promise.reject(new Error(NOT_A_WORKSPACE));
  }

  uploadUrl(): Promise<string> {
    return Promise.reject(new Error(NOT_A_WORKSPACE));
  }
}

/** The computer a thread in a folder on it runs on: every command runs as the owner of the home the computer was
 * joined with, in that home, as targetLogin reads it once at the first command, so a thread there is the person's
 * login as it is on the computer they sit at, and nothing it writes is root's where the login is not. The daemon's
 * own frames go up the same link naming no machine, which is that computer's daemon answering for itself. */
export class PlaceFolderMachine extends PlaceMachine {
  private login?: Promise<TargetLogin>;
  private readonly given: { HOME: string; PATH?: string };

  constructor(
    private readonly road: Pick<MachineLink, "request">,
    o: { id: string; home: string; path?: string },
  ) {
    super(road, o);
    this.given = { HOME: o.home, ...(o.path !== undefined ? { PATH: o.path } : {}) };
  }

  /** Who every command runs as, with the PATH that login's own shell gives it, read once, so the add and every
   * thread there run one toolchain; a read that failed is read again at the next command. */
  loginOf(): Promise<TargetLogin> {
    const road = { exec: (cmd: string, opts?: { timeoutMs?: number }) => super.exec(cmd, opts) };
    this.login ??= targetLogin(road, this.given)
      .then(async at => {
        const path = await loginShellPath(road, at);
        return path === undefined ? at : { ...at, path };
      })
      .catch((e: unknown) => {
        this.login = undefined;
        throw e;
      });
    return this.login;
  }

  /** A folder's record going takes nothing off the computer: the computer and the folder both stay. */
  override kill(): Promise<void> {
    return Promise.resolve();
  }

  override async exec(cmd: string, opts?: { timeoutMs?: number; idempotencyKey?: string; stdin?: Uint8Array }): Promise<ExecResult> {
    return super.exec(asLogin(await this.loginOf(), cmd), opts);
  }

  /** This computer as a turn's launch reaches it: each line still runs as the login, from a shell that first stands
   * itself in the thread's cgroup as the daemon's root, so the run and everything it starts stand there too; a
   * folder named goes in front of the login's PATH for those lines alone. */
  inCgroup(cgroup: string, pathFirst?: string): Machine {
    const join = cgroupJoinLine(cgroup);
    const path = pathFirst === undefined ? "" : `export PATH=${shellQuote(pathFirst)}:"$PATH"; `;
    const grouped = Object.create(this) as PlaceFolderMachine;
    grouped.exec = async (cmd, opts) => PlaceMachine.prototype.exec.call(this, `${join}\n${asLogin(await this.loginOf(), `${path}${cmd}`)}`, opts);
    return grouped;
  }

  /** One daemon frame answered by that computer's own daemon, naming no machine. A refusal comes back as the reply
   * it was, with its code, as every machine whose daemon is its computer's answers one. */
  async daemonFrame(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { op, ...params } = frame as { op: string };
    try {
      return { ok: true, ...(await this.road.request(op, params)) };
    } catch (e) {
      const said = e as { message?: string; code?: unknown };
      return { ok: false, error: said.message ?? String(e), ...(typeof said.code === "string" ? { code: said.code } : {}) };
    }
  }
}

/** The backend a folder on a computer the person joined stands on: that computer, as one machine that is always
 * there, which wsp never makes, pauses, sizes or images. */
export function placeFolderBackend(machine: () => Machine, shape: { cpu: number; memMb: number }): MachineBackend {
  const capabilities: Capabilities = {
    liveCloneForks: false,
    replacesMachine: false,
    previewUrls: false,
    signedUrls: false,
    callbackRelay: false,
    diskSnapshots: false,
    images: false,
    snapshotsAnyLife: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    // The person's own computer: nothing on it was made by wsp, so a turn's access starts where its harness asks.
    kept: true,
    copies: false,
    ownNetwork: false,
  };
  const pricing: BackendPricing = { rateUsdPerHour: () => 0, defaultSize: shape, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } };
  return {
    capabilities,
    pricing,
    create: () => Promise.reject(new Error(NOT_A_WORKSPACE)),
    get: async () => machine(),
    list: async (): Promise<MachineListRow[]> => [],
    deleteSnapshot: () => Promise.reject(new Error(NOT_A_WORKSPACE)),
  };
}
