// SPDX-License-Identifier: AGPL-3.0-only
// The road from this computer to a daemon on a machine reached over ssh. The
// daemon there binds the machine's own loopback and nothing else, so nothing
// on a machine somebody owns listens where the network can reach it; the host
// dials it through a port on this computer's loopback carried over ssh. One
// child per machine, kept for as long as a workspace stands on it, its pid
// recorded so the one thing ever killed is the child this host started.

import { spawn } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { LOOPBACK } from "@wsp/protocol";
import { sshDialArgs, type SshReach } from "./ssh-backend.js";

/** How long a forward has to start answering on its local port before it is given up and killed. */
export const FORWARD_READY_MS = 20_000;

/** The ssh child's argv for one forward. It runs on a connection of its own rather than the master every command
 * rides: a forward asked for over a master belongs to the master and outlives the child that asked for it
 * (measured 2026-09-11 against OpenSSH 10.2, the port still answering after the recorded pid was killed), which
 * would leave a port open with nothing able to close it. ExitOnForwardFailure turns a local port taken between
 * picking it and binding it into a child that ends, which the wait below reads as a failure rather than hanging.
 * The keepalives end a child whose machine went away, so the next dial makes a fresh one. */
export function sshForwardArgs(reach: SshReach, localPort: number, remotePort: number): string[] {
  return [
    "-N",
    "-T",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `${LOOPBACK}:${localPort}:${LOOPBACK}:${remotePort}`,
    ...sshDialArgs(reach),
    `${reach.user}@${reach.host}`,
  ];
}

/** One forward child as this host holds it: the pid it recorded, what the child said when it ended, and the one
 * way it is ever stopped. A test hands its own and never leaves this computer. */
export interface ForwardChild {
  readonly pid: number | undefined;
  /** Settles when the child is gone, carrying whatever it wrote on the way out. */
  readonly ended: Promise<string>;
  kill(): void;
}

export type ForwardSpawner = (reach: SshReach, localPort: number, remotePort: number) => ForwardChild;

/** The ssh client on this computer, holding one forward open. Only stderr is read, and only for the words a
 * failure is reported with. */
export const sshForwardChild: ForwardSpawner = (reach, localPort, remotePort) => {
  const child = spawn("ssh", sshForwardArgs(reach, localPort, remotePort), { stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (b: Buffer) => (said += b.toString("utf8")));
  child.on("error", e => (said += `${e instanceof Error ? e.message : String(e)}\n`));
  const ended = new Promise<string>(done => child.once("close", () => done(said.trim())));
  return {
    get pid() {
      return child.pid;
    },
    ended,
    kill: () => {
      // Only ever this pid, which this host started and recorded; nothing here looks a process up by port or name.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
};

/** A free port on this computer's loopback, asked of the kernel and handed straight on. The window between
 * closing this listener and ssh binding the port is the one race, and a child that loses it ends at once under
 * ExitOnForwardFailure rather than binding something else. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, LOOPBACK, () => {
      const found = server.address();
      const port = typeof found === "object" && found !== null ? found.port : 0;
      server.close(() => (port > 0 ? done(port) : fail(new Error("this computer offered no free port for an ssh forward"))));
    });
  });
}

/** Whether the forward is carrying yet: one connect to its local port, which answers as soon as ssh is listening. */
function reaches(port: number): Promise<boolean> {
  return new Promise(done => {
    let socket: Socket | undefined;
    const settle = (ok: boolean): void => {
      socket?.destroy();
      done(ok);
    };
    socket = connect({ port, host: LOOPBACK }, () => settle(true));
    socket.once("error", () => settle(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface Held {
  remotePort: number;
  localPort: number;
  child: ForwardChild;
  gone: boolean;
}

export interface SshForwardsOptions {
  spawn?: ForwardSpawner;
  freePort?: () => Promise<number>;
  readyMs?: number;
  /** Between tries while the child is coming up. */
  pollMs?: number;
}

/** Every forward this host holds, one per machine. A second dial of the same machine takes the child already
 * there; a dial after the daemon moved to another port replaces it, since the old child carries to a port nothing
 * listens on. Closing a workspace's forward and closing the host both end the same way: the recorded pid is
 * killed, and nothing else ever is. */
export class SshForwards {
  private readonly held = new Map<string, Promise<Held>>();
  private readonly spawner: ForwardSpawner;
  private readonly freePort: () => Promise<number>;
  private readonly readyMs: number;
  private readonly pollMs: number;
  private closing = false;

  constructor(opts: SshForwardsOptions = {}) {
    this.spawner = opts.spawn ?? sshForwardChild;
    this.freePort = opts.freePort ?? freeLoopbackPort;
    this.readyMs = opts.readyMs ?? FORWARD_READY_MS;
    this.pollMs = opts.pollMs ?? 50;
  }

  /** The local port that carries to `remotePort` on this machine, opening a child the first time and answering
   * with the one already open after that. */
  async forward(machineId: string, reach: SshReach, remotePort: number): Promise<{ localPort: number }> {
    if (this.closing) throw new Error("this host is closing; it holds open no road to a machine over ssh");
    const standing = this.held.get(machineId);
    if (standing !== undefined) {
      const found = await standing.catch(() => undefined);
      if (found !== undefined && !found.gone && found.remotePort === remotePort) return { localPort: found.localPort };
      await this.drop(machineId);
    }
    const making = this.open(reach, remotePort);
    this.held.set(machineId, making);
    try {
      const { localPort } = await making;
      return { localPort };
    } catch (e) {
      if (this.held.get(machineId) === making) this.held.delete(machineId);
      throw e;
    }
  }

  private async open(reach: SshReach, remotePort: number): Promise<Held> {
    const localPort = await this.freePort();
    const child = this.spawner(reach, localPort, remotePort);
    const held: Held = { remotePort, localPort, child, gone: false };
    // A child that ends on its own (the machine rebooted, the connection dropped past its keepalives) marks the
    // record rather than being noticed at the next dial, so the next dial makes a fresh one.
    void child.ended.then(() => (held.gone = true));
    const until = Date.now() + this.readyMs;
    for (;;) {
      if (await reaches(localPort)) return held;
      if (held.gone) throw new Error(`the road to ${reach.user}@${reach.host}:${remotePort} closed as it opened: ${(await child.ended).slice(-300)}`);
      if (Date.now() >= until) {
        child.kill();
        throw new Error(`the road to ${reach.user}@${reach.host}:${remotePort} did not open within ${this.readyMs} ms`);
      }
      await sleep(this.pollMs);
    }
  }

  /** The pid this host recorded for one machine's forward, for a caller that has to say what it is about to stop. */
  async pidOf(machineId: string): Promise<number | undefined> {
    return (await this.held.get(machineId)?.catch(() => undefined))?.child.pid;
  }

  /** Ends the forward to one machine: its workspace is gone, or its daemon moved. */
  async drop(machineId: string): Promise<void> {
    const going = this.held.get(machineId);
    if (going === undefined) return;
    this.held.delete(machineId);
    const found = await going.catch(() => undefined);
    if (found === undefined) return;
    found.child.kill();
    await found.child.ended;
  }

  /** Ends every forward: the host is closing, and a child it started must not outlive it. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.held.keys()].map(id => this.drop(id)));
  }
}
