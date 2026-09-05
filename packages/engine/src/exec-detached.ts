// SPDX-License-Identifier: AGPL-3.0-only
// One guest command that may outlive a single exec: the script goes to a file
// and starts in its own session with its streams and exit code on disk, then
// short execs read the files from where the last read stopped until the exit
// code is there or the deadline kills the session. A poll that fails (the
// machine napping) is retried after a pause; the deadline bounds that too.

import { randomBytes } from "node:crypto";
import type { ExecResult, Machine, RunOptions } from "./machine.js";

/** The longest one plain exec may take. The provider cuts any exec still running at about 29 s with a 502
 * (measured 2026-09-05), whatever its timeoutMs says; anything that can run longer goes through run(). */
export const INLINE_EXEC_MS = 20_000;
/** What a run past its deadline exits with, the same code the guest-side guard uses for its own timeout. */
export const DEADLINE_EXIT = 124;

const RUN_DIR = "/tmp/wsp-run";
/** One poll's read of each stream; a full read is followed by another at once. */
const CHUNK_BYTES = 262_144;
const POLL_MS = 2_000;
const FIRST_POLL_MS = 250;
const NO_EXIT_NOTE = "wsp: the command ended without reporting an exit code";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** The wrapper is the session leader: its pid is the group the deadline kills, and it writes the exit file
 * after the script's streams are closed, so an exit file always means the streams are complete. */
function launchCommand(runDir: string, base: string, script: string): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return [
    `mkdir -p ${runDir}`,
    `b=${base}`,
    // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second a no-op.
    `mkdir "$b.d" 2>/dev/null || { echo WSP_LAUNCHED; exit 0; }`,
    `printf %s '${b64}' | base64 -d > "$b.sh" || exit 1`,
    `setsid nohup bash -c 'bash "$0.sh" > "$0.out" 2> "$0.err" < /dev/null; echo $? > "$0.exit"' "$b" > /dev/null 2>&1 &`,
    'echo $! > "$b.pid"',
    "echo WSP_LAUNCHED",
  ].join("\n");
}

/** The exit file is read before the streams, so a poll that sees an exit code reads streams that are complete. */
function pollCommand(base: string, outOffset: number, errOffset: number): string {
  return [
    `b=${base}`,
    "echo WSP_POLL",
    `printf '%s\\n' "$(cat "$b.exit" 2>/dev/null)"`,
    `printf '%s\\n' "$(tail -c +${outOffset + 1} "$b.out" 2>/dev/null | head -c ${CHUNK_BYTES} | base64 -w0)"`,
    `printf '%s\\n' "$(tail -c +${errOffset + 1} "$b.err" 2>/dev/null | head -c ${CHUNK_BYTES} | base64 -w0)"`,
    `p=$(cat "$b.pid" 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo up; else echo down; fi`,
    "echo WSP_POLL_END",
  ].join("\n");
}

function killCommand(base: string): string {
  return `b=${base}; p=$(cat "$b.pid" 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- "-$p" "$p" 2>/dev/null; sleep 2; kill -KILL -- "-$p" "$p" 2>/dev/null; fi; true`;
}

function cleanCommand(base: string): string {
  return `rm -rf ${base}.sh ${base}.out ${base}.err ${base}.exit ${base}.pid ${base}.d`;
}

interface Poll {
  exit: string;
  out: Buffer;
  err: Buffer;
  up: boolean;
}

function parsePoll(stdout: string): Poll | undefined {
  const lines = stdout.split("\n");
  const at = lines.indexOf("WSP_POLL");
  if (at === -1 || lines[at + 5] !== "WSP_POLL_END") return undefined;
  return { exit: lines[at + 1]!.trim(), out: Buffer.from(lines[at + 2]!, "base64"), err: Buffer.from(lines[at + 3]!, "base64"), up: lines[at + 4] === "up" };
}

/** Bytes to complete lines for the listener; what follows the last newline waits for the next read. */
class LineStream {
  private readonly chunks: Buffer[] = [];
  private pending = Buffer.alloc(0);
  offset = 0;

  constructor(private readonly onLine: ((line: string) => void) | undefined) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.offset += chunk.length;
    if (this.onLine === undefined) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    let nl: number;
    while ((nl = this.pending.indexOf(0x0a)) !== -1) {
      const line = this.pending.subarray(0, nl).toString("utf8");
      this.pending = this.pending.subarray(nl + 1);
      if (line !== "") this.onLine(line);
    }
  }

  /** The tail with no newline after it, once nothing more is coming. */
  flush(): void {
    if (this.pending.length > 0 && this.onLine !== undefined) this.onLine(this.pending.toString("utf8"));
    this.pending = Buffer.alloc(0);
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Runs the script on the machine as run() promises: the result is shaped like one exec's, with exit 124 past
 * the deadline and -1 when the session ended without an exit code. `runDir` is for tests on a local bash. */
export async function execDetached(machine: Machine, script: string, opts: RunOptions, runDir = RUN_DIR): Promise<ExecResult> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const base = `${runDir}/${randomBytes(6).toString("hex")}`;
  const startedAt = Date.now();
  const exec = (cmd: string): Promise<ExecResult> => machine.exec(cmd, { timeoutMs: INLINE_EXEC_MS });

  const launch = await exec(launchCommand(runDir, base, script));
  if (launch.exitCode !== 0 || !launch.stdout.includes("WSP_LAUNCHED")) {
    throw new Error(`launch failed on ${machine.id} (exit ${launch.exitCode}): ${launch.stderr.trim() || launch.stdout.trim()}`);
  }

  const out = new LineStream(opts.onLine);
  const err = new LineStream(opts.onLine);
  const quiet = (p: Promise<unknown>): Promise<void> => p.then(() => undefined, () => undefined);
  const result = (exitCode: number, note?: string): ExecResult => {
    out.flush();
    err.flush();
    const stderr = err.text();
    return { exitCode, stdout: out.text(), stderr: note === undefined ? stderr : `${stderr}${stderr === "" || stderr.endsWith("\n") ? "" : "\n"}${note}\n` };
  };
  const read = (poll: Poll): boolean => {
    out.push(poll.out);
    err.push(poll.err);
    return poll.out.length === CHUNK_BYTES || poll.err.length === CHUNK_BYTES;
  };

  let wait = Math.min(FIRST_POLL_MS, pollMs);
  let downs = 0;
  while (true) {
    if (Date.now() - startedAt > opts.deadlineMs) {
      await quiet(exec(killCommand(base)));
      const last = await exec(pollCommand(base, out.offset, err.offset)).then(r => parsePoll(r.stdout), () => undefined);
      if (last !== undefined) read(last);
      await quiet(exec(cleanCommand(base)));
      return result(DEADLINE_EXIT);
    }
    let poll: Poll | undefined;
    try {
      poll = parsePoll((await exec(pollCommand(base, out.offset, err.offset))).stdout);
    } catch {
      poll = undefined;
    }
    if (poll === undefined) {
      await sleep(pollMs);
      continue;
    }
    if (read(poll)) continue;
    if (poll.exit !== "") {
      await quiet(exec(cleanCommand(base)));
      const code = Number(poll.exit);
      return Number.isInteger(code) ? result(code) : result(-1, NO_EXIT_NOTE);
    }
    // The pid is checked after the exit file: a leader that finished in between shows as down with no exit yet.
    if (!poll.up && ++downs > 1) {
      await quiet(exec(cleanCommand(base)));
      return result(-1, NO_EXIT_NOTE);
    }
    if (!poll.up) continue;
    await sleep(wait);
    wait = Math.min(pollMs, wait * 2);
  }
}
