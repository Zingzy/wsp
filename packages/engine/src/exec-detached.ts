// SPDX-License-Identifier: AGPL-3.0-only
// One guest command that may outlive a single exec: the script goes to a file
// and starts in its own session with its streams and exit code on disk, then
// short execs read the files from where the last read stopped until the exit
// code is there or the deadline kills the session. A poll that fails (the
// machine napping) is retried after a pause; the deadline bounds that too.

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { EXEC_BODY_MAX, EXEC_CHUNK_BYTES, shellQuote } from "@wsp/protocol";
import type { ExecResult, Machine, RunOptions } from "./machine.js";

/** The longest one plain exec may take. The provider cuts any exec still running at about 29 s with a 502
 * (measured 2026-09-05), whatever its timeoutMs says; anything that can run longer goes through run(). */
export const INLINE_EXEC_MS = 20_000;
/** What a run past its deadline exits with, the same code the guest-side guard uses for its own timeout. */
export const DEADLINE_EXIT = 124;

/** The folder a machine wsp made keeps wsp's own working files in. The whole disk there is wsp's, so the shared
 * temporary folder is wsp's too; a machine somebody else owns names its own, since a folder every account on it
 * shares is one another account could sit in first. */
export const GUEST_TMP = "/tmp";
/** Where a run's script, its streams and its exit code live on a machine wsp made. A machine somebody else owns
 * names its own under their home, since a folder every account on it shares is one another account could sit in
 * first; both roads read one rule rather than each spelling a path. */
export const RUN_DIR = `${GUEST_TMP}/wsp-run`;
/** Room left under the cap for what a backend wraps around the command on the wire: its JSON keys, its exec env line,
 * one escape byte per newline. */
const EXEC_ENVELOPE_BYTES = 512;
const POLL_MS = 2_000;
const FIRST_POLL_MS = 250;
const NO_EXIT_NOTE = "wsp: the command ended without reporting an exit code";

/** Whether one command fits an exec body, the backend's wrapper counted: the one place the measured cap is read, so
 * every road that builds a command out of a list pages it against the same rule. A body over the cap is refused with
 * 413 by the provider, which reads as the road failing rather than as the command being too long. */
export function execFits(command: string): boolean {
  return Buffer.byteLength(command) + EXEC_ENVELOPE_BYTES <= EXEC_BODY_MAX;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface GuestWrite {
  /** Where on the guest; its directory is made if missing. */
  path: string;
  text: string;
  /** Add to the file's end instead of replacing it. */
  append?: boolean;
}

export interface PutFilesOptions {
  /** Lines the last exec runs before any file lands. */
  before?: string[];
  /** Lines the last exec runs once every file is on disk. */
  after?: string[];
  timeoutMs?: number;
}

/** The execs that put the files on the guest, every body under the cap. The last exec runs `before`, lands each file,
 * then runs `after`, so a caller's launch shares it. A file whose base64 fits that exec goes in it as one printf; a
 * larger one goes up first in numbered pieces, each written whole to its own file so a retried exec lands it once, and
 * the last exec joins them under pipefail so a missing piece fails the write instead of landing a spliced file. An
 * append lands once behind a marker file of its own, since exec honours no idempotency key and a lost answer is
 * retried; the marker, and the pieces of an append that `before` turned away, stay beside the file until the run's
 * cleanup removes them. */
function uploadSequence(files: GuestWrite[], before: string[], after: string[]): string[] {
  const head = `mkdir -p ${[...new Set(files.map(f => posix.dirname(f.path)))].map(shellQuote).join(" ")}`;
  const plan = files.map(f => ({ ...f, b64: Buffer.from(f.text, "utf8").toString("base64"), pieces: 0, mark: `${f.path}.a${randomBytes(6).toString("hex")}` }));
  type Planned = (typeof plan)[number];
  const land = (f: Planned): string[] => {
    const names = `${shellQuote(f.path)}.{0..${f.pieces - 1}}`;
    const decode = `${f.pieces === 0 ? `printf %s ${shellQuote(f.b64)}` : `cat ${names}`} | base64 -d ${f.append ? ">>" : ">"} ${shellQuote(f.path)}`;
    const write = f.append ? `[ -e ${shellQuote(f.mark)} ] || { ${decode} && : > ${shellQuote(f.mark)}; } || exit 1` : `${decode} || exit 1`;
    return f.pieces === 0 ? [write] : [write, `rm -f ${names}`];
  };
  const last = (): string => [head, ...before, "set -o pipefail", ...plan.flatMap(land), ...after].join("\n");
  const piece = (path: string, i: number, part: string): string => [head, `printf %s ${shellQuote(part)} > ${shellQuote(path)}.${i} || exit 1`, "echo WSP_PIECE"].join("\n");
  const execs: string[] = [];
  while (!execFits(last())) {
    const f = plan.filter(f => f.pieces === 0).sort((a, b) => b.b64.length - a.b64.length)[0];
    if (f === undefined) throw new Error("the lines around the upload do not fit one exec body");
    // Base64 decodes in groups of four, so a piece boundary on a multiple of four keeps the joined text decodable.
    const size = Math.floor((EXEC_BODY_MAX - EXEC_ENVELOPE_BYTES - Buffer.byteLength(piece(f.path, f.b64.length, ""))) / 4) * 4;
    f.pieces = Math.max(1, Math.ceil(f.b64.length / size));
    for (let i = 0; i < f.pieces; i++) execs.push(piece(f.path, i, f.b64.slice(i * size, (i + 1) * size)));
  }
  return [...execs, last()];
}

/** The one way bytes go onto a guest through exec: sends the upload's execs in order, each piece confirmed before the
 * next goes, and answers with the last exec's result, which the caller reads for its own marker. */
export async function putFiles(machine: Machine, files: GuestWrite[], opts: PutFilesOptions = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? INLINE_EXEC_MS;
  const execs = uploadSequence(files, opts.before ?? [], opts.after ?? []);
  for (const cmd of execs.slice(0, -1)) {
    const res = await machine.exec(cmd, { timeoutMs });
    if (res.exitCode !== 0 || !res.stdout.includes("WSP_PIECE")) {
      throw new Error(`a piece did not land on ${machine.id} (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
  }
  return machine.exec(execs.at(-1)!, { timeoutMs });
}

/** The wrapper is the session leader: its pid is the group the deadline kills, and it writes the exit file
 * after the script's streams are closed, so an exit file always means the streams are complete. */
function launch(machine: Machine, base: string, script: string): Promise<ExecResult> {
  return putFiles(machine, [{ path: `${base}.sh`, text: script }], {
    // exec honours no idempotency key and a launch whose answer was lost is retried; the claim makes the second a no-op.
    before: [`b=${base}`, `mkdir "$b.d" 2>/dev/null || { echo WSP_LAUNCHED; exit 0; }`],
    after: [
      `setsid nohup bash -c 'bash "$0.sh" > "$0.out" 2> "$0.err" < /dev/null; echo $? > "$0.exit"' "$b" > /dev/null 2>&1 &`,
      'echo $! > "$b.pid"',
      "echo WSP_LAUNCHED",
    ],
  });
}

/** The exit file is read before the streams, so a poll that sees an exit code reads streams that are complete. */
function pollCommand(base: string, outOffset: number, errOffset: number): string {
  return [
    `b=${base}`,
    "echo WSP_POLL",
    `printf '%s\\n' "$(cat "$b.exit" 2>/dev/null)"`,
    `printf '%s\\n' "$(tail -c +${outOffset + 1} "$b.out" 2>/dev/null | head -c ${EXEC_CHUNK_BYTES} | base64 -w0)"`,
    `printf '%s\\n' "$(tail -c +${errOffset + 1} "$b.err" 2>/dev/null | head -c ${EXEC_CHUNK_BYTES} | base64 -w0)"`,
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

  const launched = await launch(machine, base, script);
  if (launched.exitCode !== 0 || !launched.stdout.includes("WSP_LAUNCHED")) {
    throw new Error(`launch failed on ${machine.id} (exit ${launched.exitCode}): ${launched.stderr.trim() || launched.stdout.trim()}`);
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
    return poll.out.length === EXEC_CHUNK_BYTES || poll.err.length === EXEC_CHUNK_BYTES;
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
