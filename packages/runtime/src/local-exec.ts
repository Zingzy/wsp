// SPDX-License-Identifier: AGPL-3.0-only
// The ExecStreamFactory a harness turn on a local workspace runs through: a
// real child process on this computer, not the guest's detached-and-polled
// road. machineExecStream is written for a Linux guest reached over REST
// (setsid, base64 -w0, /proc), which cannot drive a binary on this Mac, so a
// local machine has its own factory. A turn is one command: bash -c it, its
// stdout and stderr merged to the line stream in arrival order, its exit code
// on `exited`. A stream started with an input channel gets the child's stdin,
// seeded with the launch's lines and appended to by write(); one started
// without gets no stdin at all, so the binary reads EOF rather than hanging on
// a silent open pipe. That command leads a process group of its own, as the
// guest's setsid leader does, because a turn is a tree and not one process:
// the harness starts test workers and packagers that a signal to the shell
// alone leaves burning the computer's cores, so teardown, kill and a cut all
// end the group. A group of its own is a group no terminal signal reaches, so
// the host ends every one of them through endLocalTurnGroups as it stops,
// before its close and again on a second signal, and this module keeps the
// set and one exit sweep for the app that quits without a signal at all. Only
// a host killed outright leaves a turn behind, as it did before the group. The
// turn runs under the same two limits a cloud turn does, idle and wall, read
// from the one rule machine-exec reads, so a hung agent ends with the same
// line on either kind, and the idle limit reads the same activity on both:
// bytes, the person's messages, and the work the turn's own tree is doing
// while it prints nothing. Nothing outlives the host on purpose, so the
// factory offers no attach.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TURN_IDLE_MS, TURN_WALL_MS } from "@wsp/protocol";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { readsWork, turnActivity, turnCut, type MachineExecOptions } from "./machine-exec.js";

export interface LocalExecOptions extends Pick<MachineExecOptions, "idleMs" | "deadlineMs" | "now" | "pollMs"> {
  /** The folder the child starts in; the command may cd elsewhere, as a harness turn's does. */
  root: string;
}

/** How often the limits are read against the clock, and the turn's tree with them; the cloud road reads both at its
 * poll. */
const CHECK_MS = 1_000;

/** Cumulative CPU as ps prints it, in the ticks the activity clock counts: `[dd-][hh:]mm:ss[.cc]`, where this Mac's
 * ps carries hundredths and Linux's whole seconds. Anything else reads as no CPU at all. */
function cpuTicks(time: string): number {
  const dash = time.indexOf("-");
  const days = dash === -1 ? 0 : Number(time.slice(0, dash));
  let seconds = 0;
  for (const part of time.slice(dash + 1).split(":")) seconds = seconds * 60 + Number(part);
  const ticks = Math.round((days * 86_400 + seconds) * 100);
  return Number.isSafeInteger(ticks) ? ticks : 0;
}

/** The work the turn's own process group has done, as this computer's ps reports it: the group's cumulative CPU,
 * which is every process the turn started and nothing else. Neither ps reports a process's I/O, so a local turn's
 * reading is CPU alone where a guest's counts bytes moved too. Nothing here may reach the timer that calls it:
 * node hands only five errnos to a spawn's async error path and throws the rest (EPERM where ps is out of reach,
 * ENOMEM on a full box) straight out of execFile, so both roads answer with no reading, and a turn whose tree
 * cannot be read is left on its stream alone. */
function readGroupWork(pgid: number, then: (ticks: number | undefined) => void): void {
  const sum = (stdout: string): number => {
    let ticks = 0;
    for (const row of stdout.split("\n")) {
      const [group = "", time = ""] = row.trim().split(/\s+/);
      if (Number(group) === pgid) ticks += cpuTicks(time);
    }
    return ticks;
  };
  try {
    execFile("ps", ["-eo", "pgid=,time="], (err, stdout) => then(err === null ? sum(stdout) : undefined));
  } catch {
    then(undefined);
  }
}

/** Every turn group this process started that is still running. A group of the turn's own is one no signal at the
 * host reaches, so ending them is the host's to ask for: its stop calls endLocalTurnGroups before it closes. This
 * module handles no signal itself. Two owners of one signal cannot both be right about what it means, and nothing
 * during an emit can tell whose signal it is: a `once` wrapper has already unregistered itself by the time its own
 * handler runs, so a listener count read there says nothing about who else was there. */
const liveGroups = new Set<number>();
let hooked = false;

/** Ends every live turn's process group: what the host's stop calls before it closes, and again on a second signal
 * while that close runs. A turn that ended on its own is already out of the set, so nothing is signalled twice. */
export function endLocalTurnGroups(): void {
  for (const group of liveGroups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      continue;
    }
  }
  liveGroups.clear();
}

/** The last sweep, and not a signal handler: an app that quits its own window closes the host and exits with no
 * signal ever arriving, and whatever teardown's SIGTERM left behind goes here. */
function sweepGroupsOnExit(pgid: number): void {
  liveGroups.add(pgid);
  if (hooked) return;
  hooked = true;
  process.once("exit", endLocalTurnGroups);
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
      // The turn leads its own process group, so one signal reaches everything it started.
      detached: true,
      // No input channel means stdin is EOF, never a silent open pipe.
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const pgid = child.pid;
    if (pgid !== undefined) sweepGroupsOnExit(pgid);

    /** The whole group, not the shell that leads it: a SIGKILL to the leader alone left this turn's test workers and
     * packagers running on a machine until it sat at load 25 (2026-09-08). Nothing goes out once the child has been
     * reaped, since the group id is a pid the computer is free to hand to someone else. */
    const endGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
      if (pgid === undefined || finished !== undefined) return;
      try {
        process.kill(-pgid, signal);
      } catch {
        // the group ended before the signal reached it
      }
    };

    const lines = new Lines();
    const startedAt = now();
    const activity = turnActivity(startedAt);
    const feed = (which: "out" | "err", b: Buffer): void => {
      activity.touch(now());
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
      if (pgid !== undefined) liveGroups.delete(pgid);
      finished = cut === undefined ? code : null;
      if (cut === undefined) lines.end();
      else lines.fail(cut);
      resolveExit(finished);
    };
    // A limit that passes kills the group; the close that follows ends the stream with the cut's words.
    let reading = false;
    const check = setInterval(() => {
      const at = now();
      const quietMs = activity.quietMs(at);
      if (pgid !== undefined && !reading && readsWork(limits.idleMs, quietMs)) {
        reading = true;
        readGroupWork(pgid, ticks => {
          reading = false;
          if (ticks !== undefined) activity.read(ticks, at);
        });
      }
      cut = turnCut(limits, at - startedAt, quietMs);
      if (cut !== undefined) {
        clearInterval(check);
        endGroup("SIGKILL");
      }
    }, checkMs);
    check.unref();
    child.on("error", () => settle(null));
    child.on("close", (code, signal) => settle(code ?? (signal !== null ? -1 : 0)));

    let inputClosed = false;
    if (input !== undefined) {
      for (const line of input) child.stdin.write(`${line}\n`);
    }

    return {
      lines: lines.iterate(),
      teardown: () => endGroup("SIGTERM"),
      kill: () => endGroup("SIGKILL"),
      write: async line => {
        if (input === undefined) throw new Error("this stream has no input channel");
        if (finished !== undefined || inputClosed) return "gone";
        return new Promise<"written" | "gone">(resolve => {
          child.stdin.write(`${line}\n`, err => {
            // The person just acted, so the turn gets its idle time over, as on a cloud turn.
            if (!err) activity.touch(now());
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
