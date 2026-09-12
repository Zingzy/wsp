// SPDX-License-Identifier: AGPL-3.0-only
// One command on this machine, for a host that drives it over a link this
// machine opened rather than over a provider's API. It is the whole of what a
// place's backend needs: every script the runtime already sends a machine (a
// detached launch and its polls, a file's bytes on stdin, a token rotation, a
// roots file write) is one of these. bash -c, never a login shell, which would
// reset PATH; the daemon's own root and environment, which its unit states.
import { spawn } from "node:child_process";
import { EXEC_DEADLINE_EXIT, EXEC_OUTPUT_MAX, type DaemonExecReply } from "@wsp/protocol";

export interface ExecOptions {
  /** Past it the command's process group is killed and the reply carries what it had. */
  timeoutMs: number;
  /** Bytes written to the command's stdin, which is closed either way: a command left holding an open pipe waits
   * for a writer that never comes. */
  stdin?: Uint8Array;
  /** The combined cap on both streams; the protocol's unless a test shrinks it. */
  outputMax?: number;
}

/** Runs the command and answers what it said, its code, and whether the cap cut it. The cap counts both streams
 * together: a caller reads one reply, so one budget. */
export function runExec(root: string, env: Readonly<Record<string, string | undefined>>, cmd: string, opts: ExecOptions): Promise<DaemonExecReply> {
  const cap = opts.outputMax ?? EXEC_OUTPUT_MAX;
  return new Promise(done => {
    // Its own process group, so the deadline kills the children a script started and not the shell alone: a turn's
    // launch backgrounds a session, and a kill that took the shell would leave that session running for good.
    const child = spawn("bash", ["-c", cmd], { cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spent = 0;
    let truncated = false;
    let settled = false;
    const take = (chunk: Buffer, into: "out" | "err"): void => {
      const room = cap - spent;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.length > room ? chunk.subarray(0, room).toString("utf8") : chunk.toString("utf8");
      if (chunk.length > room) truncated = true;
      spent += Math.min(chunk.length, room);
      if (into === "out") stdout += text;
      else stderr += text;
    };
    child.stdout.on("data", (c: Buffer) => take(c, "out"));
    child.stderr.on("data", (c: Buffer) => take(c, "err"));
    // The group, not the pid: -pid reaches the session the script may have opened. A group that is already gone
    // throws ESRCH, which is the command having exited between the timer and this line.
    const killGroup = (): void => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      done({ exitCode: EXEC_DEADLINE_EXIT, stdout, stderr, truncated });
    }, opts.timeoutMs);
    const settle = (exitCode: number): void => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      done({ exitCode, stdout, stderr, truncated });
    };
    // A bash that could not be spawned at all is a machine without one, which is the same shape as a command that
    // could not run: the code says so and the reason is on stderr.
    child.on("error", (e: Error) => {
      stderr += e.message;
      settle(127);
    });
    child.on("close", code => settle(code ?? EXEC_DEADLINE_EXIT));
    child.stdin.on("error", () => {});
    if (opts.stdin !== undefined) child.stdin.write(Buffer.from(opts.stdin));
    child.stdin.end();
  });
}
