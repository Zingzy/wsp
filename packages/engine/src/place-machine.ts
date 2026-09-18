// SPDX-License-Identifier: AGPL-3.0-only
// The computer itself as something the engine can run steps on. Every other
// Machine here is a workspace: a machine wsp made, which can be paused,
// snapshotted and killed. A computer somebody joined is none of those, so this
// one carries the three calls a run needs (a command, a long command, bytes)
// over the exec frame its daemon already serves, and refuses the rest in one
// sentence rather than sending a frame nothing on the far side would take.
import { DaemonExecReply, EXEC_TIMEOUT_MAX_MS, placeProvisionPaths, shellQuote } from "@wsp/protocol";
import { INLINE_EXEC_MS, execDetached, putFiles } from "./exec-detached.js";
import { LINK_MARGIN_MS, type MachineLink } from "./link-backend.js";
import type { BytesLanded, ExecResult, Machine, MachineKind, MachineState, RunOptions } from "./machine.js";

/** What every call that belongs to a workspace refuses with on the computer itself. */
export const NOT_A_WORKSPACE = "this is the computer itself, not a workspace on it";

/** One computer you own, driven over the link its daemon holds to this host: one exec frame per command, a
 * detached run under wsp's own folder there for anything longer, and bytes landed as base64 text. Nothing here
 * pauses, snapshots or kills it: it is the computer the person is keeping, not a machine wsp made. */
export class PlaceMachine implements Machine {
  readonly id: string;
  readonly kind: MachineKind = "sandbox";
  private readonly home: string;

  constructor(
    private readonly link: Pick<MachineLink, "request">,
    o: { id: string; home: string },
  ) {
    this.id = o.id;
    this.home = o.home;
  }

  /** The daemon's own exec frame, held under the cap the daemon holds its own timer to, with the link given the
   * frame's wait and the margin the road takes on top of it. */
  async exec(cmd: string, opts?: { timeoutMs?: number; idempotencyKey?: string }): Promise<ExecResult> {
    const timeoutMs = Math.min(opts?.timeoutMs ?? INLINE_EXEC_MS, EXEC_TIMEOUT_MAX_MS);
    const answer = await this.link.request(
      "exec",
      { cmd, timeoutMs },
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

  /** Bytes through the one road this machine has: the base64 as text beside the file, decoded in place by the
   * same exec that landed it, so nothing stays on the computer that the write did not put there. The pieces that
   * text was cut into ride back on the answer: each is an exec frame of its own over the link, which is what a
   * trip over this road costs. */
  async putBytes(path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<BytesLanded> {
    const at = shellQuote(path);
    const landed = await putFiles(
      this,
      [{ path: `${path}.b64`, text: Buffer.from(bytes).toString("base64") }],
      { after: [`base64 -d < ${at}.b64 > ${at} && rm -f ${at}.b64`], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
    );
    return { pieces: landed.pieces };
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
