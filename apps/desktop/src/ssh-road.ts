// SPDX-License-Identifier: AGPL-3.0-only
// The ssh road to a host on a box the person owns. One login runs one sh
// script there: it finds wsp where PATH or npm put it, and reads the lock the
// way servingHost does, following current-home. When nothing serves, the host
// is started as that computer's own service; the box's port is forwarded to a
// free one here; wsp pair over there prints the code the ordinary pairing then
// spends. A saved host is reached by reading the lock again, so a service that
// came back on another port or another address is forwarded there and the
// forward is remade. Every ssh runs with a recorded pid and all of them go at
// quit; a forward lives until the host is disconnected or the app quits.
// WSP_SSH names the ssh to run, the way GIT_SSH does, so a key or a known-hosts
// file outside the person's own can be handed in.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { dialAddress, type SshLogin } from "@wsp/host";
import { authority } from "@wsp/protocol";
import { probeHost } from "./host-lifecycle.js";

/** As much of a child process as this road reads. */
export interface ChildLike {
  pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  exitCode: number | null;
  kill(): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface SshRoadDeps {
  spawn(command: string, args: string[]): ChildLike;
  sshCommand: string;
  freePort(): Promise<number>;
  /** Whether a wsp host answers on this port of this computer, which is the forward having come up. */
  serves(port: number): Promise<boolean>;
  /** How long a forward is given to answer and a service to write its lock. */
  waitMs?: number;
}

export type Login = SshLogin;

export interface SshRoad {
  /** The whole road the first time: the lock read, the service started when nothing serves, the forward, the code. */
  open(login: Login): Promise<{ url: string; code: string }>;
  /** A saved host: the lock read again and the forward made or remade to what it names, at the local port asked for
   * when it is free. */
  reach(login: Login, preferLocal?: number): Promise<string>;
  closeForward(key: string): void;
  /** Every ssh this road started, forwards and commands alike. */
  closeAll(): void;
  /** Every ssh this road started that has not exited. */
  pids(): number[];
}

export const noWspLine = (address: string): string => `wsp is not installed on ${address}: run npm i -g @zingzy/wsp there, then connect again.`;
export const sshFailedLine = (address: string, why: string): string => `ssh to ${address} failed: ${why}`;
export const nothingServingLine = (address: string): string => `no wsp host is serving on ${address}; run wsp up there, or disconnect this host and connect again to start one.`;

/** One forward per login: the same address and port name the same forward. */
export const forwardKey = (login: Login): string => (login.port !== undefined ? `${login.address}:${login.port}` : login.address);

/** What the box is asked, as one sh script so the login's own shell is not read: where wsp is (PATH first, then the
 * npm prefix, then the folders npm i -g lands in when PATH has not been told), and the lock of the host serving its
 * wsp home, following the current-home pointer the way the app does on this computer. A lock whose pid is gone reads
 * as none. */
const PROBE_SCRIPT = [
  'found=""',
  'if command -v wsp >/dev/null 2>&1; then found=$(command -v wsp); fi',
  'if [ -z "$found" ] && command -v npm >/dev/null 2>&1; then p="$(npm prefix -g 2>/dev/null)/bin/wsp"; [ -x "$p" ] && found="$p"; fi',
  'if [ -z "$found" ]; then for p in "$HOME/.npm-global/bin/wsp" "$HOME/.local/bin/wsp" "$HOME"/.nvm/versions/node/*/bin/wsp /usr/local/bin/wsp /opt/homebrew/bin/wsp; do if [ -x "$p" ]; then found="$p"; break; fi; done; fi',
  'if [ -z "$found" ]; then echo no-wsp; exit 0; fi',
  'echo "wsp $found"',
  'home="${WSP_HOME:-$HOME/.wsp}"',
  'if [ -f "$home/current-home" ]; then p=$(cat "$home/current-home"); [ -f "$p/host.lock" ] && home="$p"; fi',
  'lock="$home/host.lock"',
  'if [ -f "$lock" ]; then pid=$(sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' "$lock"); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "lock $(cat "$lock")"; exit 0; fi; fi',
  "echo none",
].join("\n");
/** The script travels base64 into sh: no quoting a fish or a zsh login could read differently. */
const PROBE = `echo ${Buffer.from(PROBE_SCRIPT).toString("base64")} | base64 -d | sh`;
// Port 0: the box picks a free pair and its lock says which, read on every connection; a unit that spelled the
// default pair would restart forever on a box where something else holds it.
const START_WORDS = "up --service --listen 127.0.0.1 --port 0";
const PAIR_WORDS = "pair";

const SSH_FAILED = 255;
const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 200;
const COMMON = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

const lastLine = (text: string): string => text.trim().split("\n").filter(l => l.trim() !== "").at(-1)?.trim() ?? "";

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

/** What the probe found: the wsp on the box, and the lock of the host serving there, when one does. */
interface Probed {
  wsp: string;
  lock: { port: number; address?: string } | undefined;
}

function collect(stream: Readable | null, into: string[]): void {
  stream?.on("data", (chunk: Buffer | string) => into.push(String(chunk)));
}

/** Runs a child to its exit; a child that cannot be started at all (no ssh on this computer) is the failure. */
function run(child: ChildLike): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const err: string[] = [];
    collect(child.stdout, out);
    collect(child.stderr, err);
    child.on("error", reject);
    child.on("exit", code => resolve({ code, out: out.join(""), err: err.join("") }));
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** What the probe printed, read by its marked lines wherever they sit: a login shell may print a banner first. When
 * no line marks wsp, what the box said on stderr (no base64, a sh that refused the script) is the sentence. */
function probedOf(address: string, out: string, err = ""): Probed {
  const lines = out.split("\n").map(l => l.trim());
  if (lines.includes("no-wsp")) throw new Error(noWspLine(address));
  const wsp = lines.find(l => l.startsWith("wsp "))?.slice("wsp ".length);
  if (wsp === undefined || wsp === "") throw new Error(sshFailedLine(address, lastLine(err) || `the probe answered ${JSON.stringify(lastLine(out))}`));
  const lockLine = lines.find(l => l.startsWith("lock "));
  if (lockLine === undefined) return { wsp, lock: undefined };
  try {
    const parsed = JSON.parse(lockLine.slice("lock ".length)) as { port?: unknown; address?: unknown };
    return { wsp, lock: typeof parsed.port === "number" ? { port: parsed.port, ...(typeof parsed.address === "string" ? { address: parsed.address } : {}) } : undefined };
  } catch {
    return { wsp, lock: undefined };
  }
}

export function sshRoad(deps: SshRoadDeps): SshRoad {
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const live = new Map<number, ChildLike>();
  /** The forward held per login, and where on the box it points, so a lock that moved is seen as a move. */
  const forwards = new Map<string, { url: string; local: number; to: string; child: ChildLike }>();

  const start = (args: string[]): ChildLike => {
    const child = deps.spawn(deps.sshCommand, args);
    if (child.pid !== undefined) {
      live.set(child.pid, child);
      const pid = child.pid;
      child.on("exit", () => live.delete(pid));
    }
    return child;
  };
  const target = (login: Login): string[] => [...(login.port !== undefined ? ["-p", String(login.port)] : []), login.address];

  /** One command on the box. ssh answers 255 for what went wrong on its side (no route, a refused key, a host key it
   * does not know); any other code is the box's command speaking, and its words are the caller's to read. */
  const remote = async (login: Login, command: string): Promise<Ran> => {
    const ran = await run(start(["-T", ...COMMON, ...target(login), command]));
    if (ran.code === SSH_FAILED) throw new Error(sshFailedLine(login.address, lastLine(ran.err) || `exit ${ran.code}`));
    return ran;
  };
  const probe = async (login: Login): Promise<Probed> => {
    const ran = await remote(login, PROBE);
    return probedOf(login.address, ran.out, ran.err);
  };
  /** Where the box's own tools dial the host: the address its lock names, loopback for the wildcard. */
  const targetOf = (lock: NonNullable<Probed["lock"]>): string => authority(dialAddress(lock), lock.port);

  const forwardOnce = async (login: Login, to: string, local: number): Promise<{ url: string; local: number; to: string; child: ChildLike } | string> => {
    const child = start(["-N", ...COMMON, "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${local}:${to}`, ...target(login)]);
    const err: string[] = [];
    collect(child.stderr, err);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return lastLine(err.join("")) || `the forward exited with ${child.exitCode}`;
      if (await deps.serves(local)) return { url: `http://127.0.0.1:${local}`, local, to, child };
      await sleep(POLL_MS);
    }
    child.kill();
    return `the forward to ${to} did not answer within ${waitMs} ms`;
  };

  const closeForward = (key: string): void => {
    const held = forwards.get(key);
    if (held === undefined) return;
    forwards.delete(key);
    held.child.kill();
  };

  /** The forward to where the lock says the host is: the one held when it points there already, remade at the same
   * local port when the host moved, made at the port asked for when it is free and any free one otherwise. */
  const forward = async (login: Login, to: string, preferLocal?: number): Promise<string> => {
    const key = forwardKey(login);
    const held = forwards.get(key);
    if (held !== undefined && held.to === to) return held.url;
    if (held !== undefined) {
      closeForward(key);
      preferLocal = held.local;
    }
    let made = preferLocal !== undefined ? await forwardOnce(login, to, preferLocal) : undefined;
    // The port the record names is held by something else now: any free one does, and the record follows.
    if (made === undefined || typeof made === "string") made = await forwardOnce(login, to, await deps.freePort());
    if (typeof made === "string") throw new Error(sshFailedLine(login.address, made));
    forwards.set(key, made);
    const child = made.child;
    child.on("exit", () => {
      if (forwards.get(key)?.child === child) forwards.delete(key);
    });
    return made.url;
  };

  return {
    async open(login) {
      let { wsp, lock } = await probe(login);
      if (lock === undefined) {
        const started = await remote(login, `${wsp} ${START_WORDS}`);
        if (started.code !== 0) throw new Error(lastLine(started.err) || lastLine(started.out) || sshFailedLine(login.address, `${wsp} ${START_WORDS} exited with ${started.code}`));
        const deadline = Date.now() + waitMs;
        while (lock === undefined && Date.now() < deadline) {
          await sleep(POLL_MS);
          lock = (await probe(login)).lock;
        }
        if (lock === undefined) throw new Error(sshFailedLine(login.address, `wsp started as a service there but no host wrote its lock within ${waitMs} ms`));
      }
      const url = await forward(login, targetOf(lock));
      const paired = await remote(login, `${wsp} ${PAIR_WORDS}`);
      if (paired.code !== 0) throw new Error(lastLine(paired.err) || lastLine(paired.out) || sshFailedLine(login.address, `${wsp} ${PAIR_WORDS} exited with ${paired.code}`));
      const code = /^code\s+(\S+)/m.exec(paired.out)?.[1];
      if (code === undefined) throw new Error(sshFailedLine(login.address, `${wsp} ${PAIR_WORDS} printed no code: ${lastLine(paired.out)}`));
      return { url, code };
    },
    async reach(login, preferLocal) {
      const { lock } = await probe(login);
      if (lock === undefined) throw new Error(nothingServingLine(login.address));
      return forward(login, targetOf(lock), preferLocal);
    },
    closeForward,
    closeAll() {
      forwards.clear();
      for (const child of [...live.values()]) child.kill();
    },
    pids: () => [...live.keys()],
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** The road as the app runs it: this computer's ssh, or the one WSP_SSH names. */
export function systemSshDeps(env: Record<string, string | undefined> = process.env): SshRoadDeps {
  return {
    spawn: (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
    sshCommand: env["WSP_SSH"] ?? "ssh",
    freePort,
    serves: async port => (await probeHost(port)) === "wsp",
  };
}
