// SPDX-License-Identifier: AGPL-3.0-only
// The ssh road to a host on a box the person owns: one login reads the lock
// the way servingHost does, the host is started as that computer's own service
// when nothing serves, the box's port is forwarded to a free one here, and
// wsp pair over there prints the code the ordinary pairing then spends. Every
// ssh runs with a recorded pid; the forward lives until the host is
// disconnected or the app quits. WSP_SSH names the ssh to run, the way GIT_SSH
// does, so a key or a known-hosts file outside the person's own can be handed in.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import type { SshLogin } from "@wsp/host";
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

/** Where to log in: the ssh address as a person types it and the port when it is not ssh's own. */
export type Login = Pick<SshLogin, "address" | "port">;

export interface SshRoad {
  /** The whole road: the lock read, the service started when nothing serves, the forward, the code. */
  open(login: Login): Promise<{ url: string; code: string; hostPort: number }>;
  /** The box's port forwarded here, at the local port asked for when it is free; one forward per login. */
  forward(login: Login, hostPort: number, preferLocal?: number): Promise<string>;
  closeForward(key: string): void;
  closeAll(): void;
  /** Every ssh this road started that has not exited. */
  pids(): number[];
}

export const noWspLine = (address: string): string => `wsp is not installed on ${address}: run npm i -g @zingzy/wsp there, then connect again.`;
export const sshFailedLine = (address: string, why: string): string => `ssh to ${address} failed: ${why}`;

/** One forward per login: the same address and port name the same forward. */
export const forwardKey = (login: Login): string => (login.port !== undefined ? `${login.address}:${login.port}` : login.address);

/** What the box is asked first: whether wsp is there, and the lock of the host serving its wsp home, following the
 * current-home pointer the way the app does on this computer. A lock whose pid is gone reads as none. */
const PROBE = [
  "if ! command -v wsp >/dev/null 2>&1; then echo no-wsp; exit 0; fi",
  'home="${WSP_HOME:-$HOME/.wsp}"',
  'if [ -f "$home/current-home" ]; then p=$(cat "$home/current-home"); [ -f "$p/host.lock" ] && home="$p"; fi',
  'lock="$home/host.lock"',
  'if [ -f "$lock" ]; then pid=$(sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' "$lock"); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "lock $(cat "$lock")"; exit 0; fi; fi',
  "echo none",
].join("; ");
// Port 0: the box picks a free pair and its lock says which, read on every connection anyway; a unit that spelled
// the default pair would restart forever on a box where something else holds it.
const START = "wsp up --service --listen 127.0.0.1 --port 0";
const PAIR = "wsp pair";

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

function lockOf(out: string): { port: number } | undefined {
  const line = out.split("\n").find(l => l.startsWith("lock "));
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line.slice("lock ".length)) as { port?: unknown };
    return typeof parsed.port === "number" ? { port: parsed.port } : undefined;
  } catch {
    return undefined;
  }
}

export function sshRoad(deps: SshRoadDeps): SshRoad {
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const live = new Map<number, ChildLike>();
  const forwards = new Map<string, { url: string; child: ChildLike }>();

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

  const readLock = async (login: Login): Promise<{ port: number } | "no-wsp" | undefined> => {
    const probe = await remote(login, PROBE);
    if (probe.out.trim() === "no-wsp") return "no-wsp";
    return lockOf(probe.out);
  };

  const forwardOnce = async (login: Login, hostPort: number, local: number): Promise<{ url: string; child: ChildLike } | string> => {
    const child = start(["-N", ...COMMON, "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${local}:127.0.0.1:${hostPort}`, ...target(login)]);
    const err: string[] = [];
    collect(child.stderr, err);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return lastLine(err.join("")) || `the forward exited with ${child.exitCode}`;
      if (await deps.serves(local)) return { url: `http://127.0.0.1:${local}`, child };
      await sleep(POLL_MS);
    }
    child.kill();
    return `the forward to port ${hostPort} did not answer within ${waitMs} ms`;
  };

  const forward = async (login: Login, hostPort: number, preferLocal?: number): Promise<string> => {
    const key = forwardKey(login);
    const held = forwards.get(key);
    if (held !== undefined) return held.url;
    let made = preferLocal !== undefined ? await forwardOnce(login, hostPort, preferLocal) : undefined;
    // The port the record names is held by something else now: any free one does, and the record follows.
    if (made === undefined || typeof made === "string") made = await forwardOnce(login, hostPort, await deps.freePort());
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
      let lock = await readLock(login);
      if (lock === "no-wsp") throw new Error(noWspLine(login.address));
      if (lock === undefined) {
        const started = await remote(login, START);
        if (started.code !== 0) throw new Error(lastLine(started.err) || lastLine(started.out) || sshFailedLine(login.address, `${START} exited with ${started.code}`));
        const deadline = Date.now() + waitMs;
        while (lock === undefined && Date.now() < deadline) {
          await sleep(POLL_MS);
          const again = await readLock(login);
          lock = again === "no-wsp" ? undefined : again;
        }
        if (lock === undefined) throw new Error(sshFailedLine(login.address, `wsp started as a service there but no host wrote its lock within ${waitMs} ms`));
      }
      const url = await forward(login, lock.port);
      const paired = await remote(login, PAIR);
      if (paired.code !== 0) throw new Error(lastLine(paired.err) || lastLine(paired.out) || sshFailedLine(login.address, `${PAIR} exited with ${paired.code}`));
      const code = /^code\s+(\S+)/m.exec(paired.out)?.[1];
      if (code === undefined) throw new Error(sshFailedLine(login.address, `${PAIR} printed no code: ${lastLine(paired.out)}`));
      return { url, code, hostPort: lock.port };
    },
    forward,
    closeForward(key) {
      const held = forwards.get(key);
      if (held === undefined) return;
      forwards.delete(key);
      held.child.kill();
    },
    closeAll() {
      for (const key of [...forwards.keys()]) this.closeForward(key);
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
