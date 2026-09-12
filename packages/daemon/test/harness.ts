// SPDX-License-Identifier: AGPL-3.0-only
// The daemon under test, started the way the suite is told to: in this
// process from the sources, or as a child of the binary WSP_DAEMON_BIN names,
// given the same flags. A test holds one handle either way and asks it
// nothing a binary could not answer, so this suite is the contract every
// daemon that speaks the wire is held to.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonListeningLine } from "@wsp/protocol";
import { daemonArgv, daemonOptions, type DaemonArgs } from "../src/args.js";
import { startDaemon } from "../src/main.js";

export interface DaemonUnderTest {
  port: number;
  /** The daemon's own pid and its parent's, the two proc.kill protects beside init. */
  pid: number;
  parentPid: number;
  /** Every line the daemon has logged so far. */
  log(): string[];
  /** Settles when the daemon ended of its own accord: a leave it answered, or the child exiting. */
  exited: Promise<void>;
  close(): Promise<void>;
}

/** The flags, plus a token to write into a file for --token-path, since no daemon takes a token on its command line. */
export type DaemonUnderTestArgs = DaemonArgs & { token?: string };

/** The binary the suite drives, or nothing for the daemon in this process. */
export function daemonBin(): string | undefined {
  const bin = process.env["WSP_DAEMON_BIN"];
  return bin === undefined || bin === "" ? undefined : resolve(bin);
}

export async function daemonUnderTest(given: DaemonUnderTestArgs): Promise<DaemonUnderTest> {
  const { token, ...args } = given;
  let tokenDir: string | undefined;
  if (token !== undefined) {
    tokenDir = mkdtempSync(join(tmpdir(), "wsp-daemon-token-"));
    args.tokenPath = join(tokenDir, "token");
    writeFileSync(args.tokenPath, `${token}\n`);
  }
  const bin = daemonBin();
  const daemon = bin === undefined ? await inProcess(args) : await spawnDaemon(bin, args);
  const dir = tokenDir;
  if (dir === undefined) return daemon;
  return {
    ...daemon,
    close: async () => {
      await daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function inProcess(args: DaemonArgs): Promise<DaemonUnderTest> {
  const lines: string[] = [];
  let ended!: () => void;
  const exited = new Promise<void>(done => (ended = done));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= handle.close());
  const handle = await startDaemon(
    daemonOptions(args, {
      log: line => lines.push(line),
      exit: () => {
        ended();
        void close();
      },
    }),
  );
  return { port: handle.port, pid: process.pid, parentPid: process.ppid, log: () => [...lines], exited, close };
}

/** How long a binary gets to print its listening line. */
const START_MS = 10_000;

/** The two waits a spawned daemon gets, for a test of the harness itself to shorten. */
export interface SpawnWaits {
  startMs?: number;
  stopMs?: number;
}
/** How long a child gets to leave on SIGTERM before it is killed outright. */
const STOP_MS = 5_000;

/** The listening line as a pattern that reads the port off it, whatever host the daemon printed. */
const LISTENING = new RegExp(
  daemonListeningLine("HOST", "PORT")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("HOST", ".*")
    .replace("PORT", "(\\d+)"),
);

/** The binary as the daemon under test: spawned with the flags, its port read off its listening line, its stderr
 * kept, and nothing of it left running once the test is done with it or gave up on it. */
export async function spawnDaemon(bin: string, args: DaemonArgs, waits: SpawnWaits = {}): Promise<DaemonUnderTest> {
  const startMs = waits.startMs ?? START_MS;
  const stopMs = waits.stopMs ?? STOP_MS;
  const child = spawn(bin, daemonArgv(args), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const lines: string[] = [];
  let rest = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const parts = `${rest}${chunk}`.split("\n");
    rest = parts.pop() ?? "";
    lines.push(...parts);
  });
  let gone = false;
  // exit, not close: a child of the daemon that inherited its stderr (an exec, a probe) would hold close open.
  const exited = new Promise<void>(done =>
    child.once("exit", () => {
      gone = true;
      if (rest !== "") lines.push(rest);
      done();
    }),
  );
  const said = (): string => lines.join("\n");
  // Nothing a test started outlives it: a binary that bound and never printed its line is killed before the wait ends.
  const stop = async (): Promise<void> => {
    if (gone) return;
    child.kill("SIGTERM");
    const hard = setTimeout(() => child.kill("SIGKILL"), stopMs);
    await exited;
    clearTimeout(hard);
  };
  const port = await new Promise<number>((done, fail) => {
    let out = "";
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      void stop().then(() => fail(new Error(`${bin} did not print its listening line within ${startMs} ms:\n${said()}`)));
    }, startMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const m = LISTENING.exec(out);
      if (m === null) return;
      clearTimeout(timer);
      done(Number(m[1]));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      // A child the timeout took down is reported by the timeout, with what it said.
      if (!gaveUp) fail(new Error(`${bin} exited with ${code} before it listened:\n${said()}`));
    });
    child.once("error", e => {
      clearTimeout(timer);
      void stop().then(() => fail(e));
    });
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${bin} started without a pid`);
  return {
    port,
    pid,
    // The child is this process's own, so its parent is this process.
    parentPid: process.pid,
    log: () => [...lines],
    exited,
    close: stop,
  };
}
