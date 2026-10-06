// SPDX-License-Identifier: AGPL-3.0-only
// One child process, read to its end: the shape both backends whose machine is
// reached by running a command need, this computer's own shell and the ssh
// client that carries a script to a machine that already exists. The exit code
// stands for the command's, a negative one for a signal, and a run cut at its
// deadline answers 124, the code a cut guest exec answers with.

import { spawn } from "node:child_process";
import type { ExecResult } from "./machine.js";

export interface ChildOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Past it the child is killed and the result is 124 with the output so far. */
  timeoutMs?: number;
  /** Each complete line the child writes on stdout, as it is read; the last partial line follows at the end. */
  onLine?: (line: string) => void;
  /** Bytes written to the child's stdin, which is then closed. Absent leaves stdin as the caller found it, which for
   * the ssh client is /dev/null: it is given -n on every road but the one that carries a file's bytes. */
  stdin?: Uint8Array;
}

/** The child's own exit code, or 127 when it could not be started at all, the code a shell answers a missing
 * command with. */
export const CHILD_UNSTARTABLE = 127;
export const CHILD_TIMED_OUT = 124;
/** How long the pipes may stay quiet after a command exits before its answer goes without their close. */
const DRAIN_MS = 200;
/** How long after a command exits its answer waits on pipes something it left running keeps writing to. */
const DRAIN_CAP_MS = 1_000;

/** Kills a child's whole process group, which it leads since it was spawned detached. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/** A stream's chunks as lines, the last partial one held until its newline or the flush; past `keep` characters
 * only its tail is held, so a writer that never ends a line cannot grow the reader. */
export function lineFeed(onLine: (line: string) => void, keep = Infinity): { feed(chunk: string): void; flush(): void } {
  let pending = "";
  return {
    feed: chunk => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      if (pending.length > keep) pending = pending.slice(-keep);
    },
    flush: () => {
      if (pending !== "") onLine(pending);
      pending = "";
    },
  };
}

export function runChild(file: string, args: readonly string[], opts: ChildOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>(resolve => {
    // Its own process group, so the deadline ends the group, not bash alone: an installer wrapper's download held the
    // pipes open past a SIGKILL of bash and ran on as an orphan (97 s on Omarchy, 2026-10-05). A descendant that made
    // a session of its own is outside the group and runs on.
    const child = spawn(file, [...args], {
      detached: true,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
    if (opts.stdin !== undefined) {
      // A child that closes its stdin early (a refused ssh dial) breaks the pipe under the write, which is the
      // dial's own failure to report, not this one's.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }
    let stdout = "";
    let stderr = "";
    const lines = opts.onLine === undefined ? undefined : lineFeed(opts.onLine);
    let timedOut = false;
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, opts.timeoutMs);
    const text = (b: Buffer): string => b.toString("utf8");
    child.stdout.on("data", (b: Buffer) => {
      const chunk = text(b);
      stdout += chunk;
      lines?.feed(chunk);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += text(b);
    });
    let answered = false;
    let drain: NodeJS.Timeout | undefined;
    const done = (exitCode: number): void => {
      if (answered) return;
      answered = true;
      if (timer !== undefined) clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      lines?.flush();
      resolve({ exitCode, stdout, stderr });
    };
    const codeOf = (code: number | null, signal: NodeJS.Signals | null): number => (timedOut ? CHILD_TIMED_OUT : (code ?? (signal !== null ? -1 : 0)));
    child.on("error", e => {
      stderr += `${e instanceof Error ? e.message : String(e)}\n`;
      done(CHILD_UNSTARTABLE);
    });
    // The command's exit is its answer, its code read then and its deadline over: its output is read until the pipes
    // close, go quiet for DRAIN_MS, or DRAIN_CAP_MS has passed, so a child it left running that still holds them does
    // not hold the answer with them, writing or not.
    let exited: (() => void) | undefined;
    let cap: NodeJS.Timeout | undefined;
    const quiet = (): void => {
      if (exited === undefined) return;
      if (drain !== undefined) clearTimeout(drain);
      drain = setTimeout(exited, DRAIN_MS);
    };
    child.stdout.on("data", quiet);
    child.stderr.on("data", quiet);
    child.on("exit", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      const answer = codeOf(code, signal);
      exited = () => {
        if (cap !== undefined) clearTimeout(cap);
        child.stdout.destroy();
        child.stderr.destroy();
        done(answer);
      };
      cap = setTimeout(exited, DRAIN_CAP_MS);
      quiet();
    });
    child.on("close", (code, signal) => {
      if (cap !== undefined) clearTimeout(cap);
      done(codeOf(code, signal));
    });
  });
}
