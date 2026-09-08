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
// hanging on a silent open pipe. The run dies with the host that launched it,
// so the factory offers no attach.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";

export interface LocalExecOptions {
  /** The folder the child starts in; the command may cd elsewhere, as a harness turn's does. */
  root: string;
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
      if (this.done) return;
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }
}

export function localExecStream(opts: LocalExecOptions): ExecStreamFactory {
  const factory: ExecStreamFactory = (command, { env, input }) => {
    const child: ChildProcessWithoutNullStreams = spawn("bash", ["-c", command], {
      cwd: opts.root,
      env: { ...env },
      // No input channel means stdin is EOF, never a silent open pipe.
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const lines = new Lines();
    child.stdout.on("data", (b: Buffer) => lines.feed("out", b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => lines.feed("err", b.toString("utf8")));

    let finished: number | null | undefined;
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => {
      resolveExit = resolve;
    });
    const settle = (code: number | null): void => {
      if (finished !== undefined) return;
      finished = code;
      lines.end();
      resolveExit(code);
    };
    child.on("error", () => settle(null));
    child.on("close", (code, signal) => settle(code ?? (signal !== null ? -1 : 0)));

    let inputClosed = false;
    if (input !== undefined) {
      for (const line of input) child.stdin.write(`${line}\n`);
    }

    return {
      lines: lines.iterate(),
      teardown: () => {
        child.kill("SIGTERM");
      },
      kill: () => {
        child.kill("SIGKILL");
      },
      write: async line => {
        if (input === undefined) throw new Error("this stream has no input channel");
        if (finished !== undefined || inputClosed) return "gone";
        return new Promise<"written" | "gone">(resolve => {
          child.stdin.write(`${line}\n`, err => resolve(err ? "gone" : "written"));
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
