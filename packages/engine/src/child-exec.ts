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
}

/** The child's own exit code, or 127 when it could not be started at all, the code a shell answers a missing
 * command with. */
export const CHILD_UNSTARTABLE = 127;
export const CHILD_TIMED_OUT = 124;

export function runChild(file: string, args: readonly string[], opts: ChildOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>(resolve => {
    const child = spawn(file, [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const feed = (chunk: string): void => {
      if (opts.onLine === undefined) return;
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        opts.onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    };
    let timedOut = false;
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const text = (b: Buffer): string => b.toString("utf8");
    child.stdout.on("data", (b: Buffer) => {
      const chunk = text(b);
      stdout += chunk;
      feed(chunk);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += text(b);
    });
    const done = (exitCode: number): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (opts.onLine !== undefined && pending !== "") opts.onLine(pending);
      resolve({ exitCode, stdout, stderr });
    };
    child.on("error", e => {
      stderr += `${e instanceof Error ? e.message : String(e)}\n`;
      done(CHILD_UNSTARTABLE);
    });
    child.on("close", (code, signal) => {
      if (timedOut) return done(CHILD_TIMED_OUT);
      done(code ?? (signal !== null ? -1 : 0));
    });
  });
}
