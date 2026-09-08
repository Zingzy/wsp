// SPDX-License-Identifier: AGPL-3.0-only
// The ExecStreamFactory a harness turn on a local workspace runs through: a
// real child process on this computer, not the guest's detached-and-polled
// road. machineExecStream is written for a Linux guest reached over REST
// (setsid, base64 -w0, /proc), which cannot drive a binary on this Mac, so a
// local machine has its own factory. A turn is one child: bash -c the command,
// its stdout and stderr merged to the line stream in arrival order, its exit
// code on `exited`. A stream started with an input channel gets the child's
// stdin, seeded with the launch's lines and appended to by write(); one
// started without gets no stdin at all, so the binary reads EOF rather than
// hanging on a silent open pipe. The turn runs under the same two limits a
// cloud turn does, idle and wall, read from the one rule machine-exec reads,
// so a hung agent ends with the same line on either kind. The child leads a
// process group of its own and every signal goes to that group, never to the
// leader alone: a harness leaves its own children behind when it goes, and a
// grandchild that outlives the leader holds the inherited stdout pipe, so a
// signal to the leader alone left the stream unended and the harness running
// (seven such processes were found on one box, the oldest fourteen hours past
// its turn's reply). The group is taken at every ending, the leader's own exit
// included, which is what the cloud road's reap does at the same point. Its own
// group also means a turn no longer takes the terminal's Ctrl-C with the host,
// so the host ends what is running here as it stops (endLocalRuns). The run
// dies with the host that launched it, so the factory offers no attach and no
// sweep.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TURN_IDLE_MS, TURN_WALL_MS } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { turnCut, type MachineExecOptions } from "./machine-exec.js";

export interface LocalExecOptions extends Pick<MachineExecOptions, "idleMs" | "deadlineMs" | "now" | "pollMs"> {
  /** The folder the child starts in; the command may cd elsewhere, as a harness turn's does. */
  root: string;
}

/** How often the limits are read against the clock; the cloud road reads them at its poll. */
const CHECK_MS = 1_000;
/** How long a turn on this computer gets to end itself when the host stops, before its group is killed. */
const STOP_GRACE_MS = 2_000;

/** Every process group a turn on this computer is running in, across every factory this process made: a turn leads
 * a group of its own, so nothing else on this computer knows where to find it. */
const groups = new Set<number>();

/** One turn's whole group, by the pid its spawn recorded: the child leads the group, so a negative pid is every
 * process the turn started. A group whose last member is already gone answers ESRCH, which is the same nothing to
 * do as no group at all. */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    return;
  }
}

/**
 * Ends every turn running on this computer and everything those turns started: SIGTERM to each group, SIGKILL to
 * whatever is still there once the grace passes. What a host calls as it stops, since a local turn's process cannot
 * be re-opened by the host that comes next and answers nobody after this one goes.
 */
export async function endLocalRuns(graceMs = STOP_GRACE_MS): Promise<void> {
  const ending = [...groups];
  if (ending.length === 0) return;
  for (const pid of ending) signalGroup(pid, "SIGTERM");
  await new Promise<void>(resolve => setTimeout(resolve, graceMs));
  for (const pid of ending) signalGroup(pid, "SIGKILL");
}

/** One complete line at a time out of a growing byte stream: what precedes each newline is yielded, the tail waits
 * for more, and the final tail with no newline is yielded when the streams close. Two streams share one queue so
 * stdout and stderr interleave in the order the child wrote them. */
class Lines {
  private readonly queue: string[] = [];
  private pendingOut = "";
  private pendingErr = "";
  private wake: (() => void) | undefined;
  private done = false;
  private error: Error | undefined;

  private push(line: string): void {
    this.queue.push(line);
    this.wake?.();
    this.wake = undefined;
  }

  feed(which: "out" | "err", chunk: string): void {
    let pending = (which === "out" ? this.pendingOut : this.pendingErr) + chunk;
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      this.push(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
    if (which === "out") this.pendingOut = pending;
    else this.pendingErr = pending;
  }

  /** Ends the stream with an error once everything already read is out: what a cut turn's reader sees last. */
  fail(error: Error): void {
    this.error = error;
    this.end();
  }

  end(): void {
    if (this.pendingOut !== "") {
      this.push(this.pendingOut);
      this.pendingOut = "";
    }
    if (this.pendingErr !== "") {
      this.push(this.pendingErr);
      this.pendingErr = "";
    }
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  async *iterate(): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }
}

export function localExecStream(opts: LocalExecOptions): ExecStreamFactory {
  const limits = { idleMs: opts.idleMs ?? TURN_IDLE_MS, deadlineMs: opts.deadlineMs ?? TURN_WALL_MS };
  const now = opts.now ?? Date.now;
  const checkMs = opts.pollMs ?? CHECK_MS;
  const factory: ExecStreamFactory = (command, { env, input }) => {
    const child: ChildProcessWithoutNullStreams = spawn("bash", ["-c", command], {
      cwd: opts.root,
      env: { ...env },
      // No input channel means stdin is EOF, never a silent open pipe.
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Its own process group, so a signal can reach what the turn started without reaching this host.
      detached: true,
    }) as ChildProcessWithoutNullStreams;

    if (child.pid !== undefined) groups.add(child.pid);
    const signal = (sig: NodeJS.Signals): void => {
      if (child.pid !== undefined) signalGroup(child.pid, sig);
    };

    const lines = new Lines();
    const startedAt = now();
    let lastByteAt = startedAt;
    const feed = (which: "out" | "err", b: Buffer): void => {
      lastByteAt = now();
      lines.feed(which, b.toString("utf8"));
    };
    child.stdout.on("data", (b: Buffer) => feed("out", b));
    child.stderr.on("data", (b: Buffer) => feed("err", b));

    let finished: number | null | undefined;
    let cut: Error | undefined;
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const settle = (code: number | null): void => {
      if (finished !== undefined) return;
      clearInterval(check);
      if (child.pid !== undefined) groups.delete(child.pid);
      finished = cut === undefined ? code : null;
      if (cut === undefined) lines.end();
      else lines.fail(cut);
      resolveExit(finished);
    };
    // A limit that passes kills the turn's group; the close that follows ends the stream with the cut's words.
    const check = setInterval(() => {
      cut = turnCut(limits, now() - startedAt, now() - lastByteAt);
      if (cut !== undefined) {
        clearInterval(check);
        signal("SIGKILL");
      }
    }, checkMs);
    check.unref();
    child.on("error", () => settle(null));
    // The leader is gone and what it started is not: those processes hold the stdout it handed them, so close waits
    // on them and the turn would read as still running. The group goes here, at the one ending every other passes
    // through, so no ending has to remember to take it.
    child.on("exit", () => signal("SIGKILL"));
    child.on("close", (code, exitSignal) => settle(code ?? (exitSignal !== null ? -1 : 0)));

    let inputClosed = false;
    if (input !== undefined) {
      for (const line of input) child.stdin.write(`${line}\n`);
    }

    return {
      lines: lines.iterate(),
      teardown: () => signal("SIGTERM"),
      kill: () => signal("SIGKILL"),
      write: async line => {
        if (input === undefined) throw new Error("this stream has no input channel");
        if (finished !== undefined || inputClosed) return "gone";
        return new Promise<"written" | "gone">(resolve => {
          child.stdin.write(`${line}\n`, err => {
            // The person just acted, so the turn gets its idle time over, as on a cloud turn.
            if (!err) lastByteAt = now();
            resolve(err ? "gone" : "written");
          });
        });
      },
      closeInput: () => {
        if (input === undefined || inputClosed || finished !== undefined) return;
        inputClosed = true;
        child.stdin.end();
      },
      exited,
    } satisfies ExecStream;
  };
  return factory;
}
