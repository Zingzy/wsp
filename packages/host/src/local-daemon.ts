// SPDX-License-Identifier: AGPL-3.0-only
// The daemon for this computer's own workspace: the same static binary every
// machine wsp forks runs, spawned here bound to loopback and reached by the
// same link (connectDaemon), so every caller that dials a workspace's daemon
// dials this one unchanged. It serves the ptys, port watch, inbox, process
// manifest and files a cloud daemon does, rooted at the workspace's folder,
// and told the local kind so it reads this computer's own load and processes
// rather than a guest's /proc.
//
// A caller may name the file it reads its token off. A stand-in provider's
// machine does: the runtime rotates a machine's token by writing it through
// that machine's own exec, which is a shell in that machine's folder, so the
// file has to be one this daemon reads and that shell can write.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
// LOOPBACK is the protocol's, which every road that binds or dials this computer reads. Here the reason is also
// that a firewall prompt on macOS or Windows is a wall a local workspace must never hit.
import { LOOPBACK, daemonListeningLine, rootsPathIn, type DaemonEvent, type DaemonReachView, type SysSample } from "@wsp/protocol";
import { daemonBinaryHere } from "./assets.js";

/** The loopback token is minted when the daemon starts and lives as long as the process holding it, so the road to
 * it never expires; the view's expiry is a number, so it carries the furthest one. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** How long the binary gets to print its listening line, and how long it gets to leave on SIGTERM before SIGKILL. */
const START_MS = 10_000;
const STOP_MS = 5_000;

/** The listening line as a pattern that reads the port off it, whatever address the daemon printed. */
const LISTENING = new RegExp(
  daemonListeningLine("HOST", "PORT")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("HOST", ".*")
    .replace("PORT", "(\\d+)"),
);

export interface LocalDaemonOptions {
  /** The folder the daemon's files and git ops resolve inside, and its ptys start in: the workspace's folder. */
  root: string;
  /** The folder turns write in, whose volume the Machine tab's disk row reads. */
  workFolder: string;
  /** The binary to spawn; this computer's own out of the daemon asset when none is named. */
  binary?: string;
  /** The file this daemon reads its token from, for a daemon whose token something else rotates: a stand-in
   * provider's machine, whose token the runtime writes through that machine's own exec. The first token is minted
   * here and written there, and every later frame is checked against the file as it is then. Without one the file
   * is this daemon's own and its token lives as long as it does. */
  tokenPath?: string;
}

/** One watch on this computer's readings, shared by every pane that asks: the link, its listeners, and the watch
 * request the first one waited on. */
interface SharedSamples {
  link: DaemonReach;
  listeners: Set<(s: SysSample) => void>;
  watching: Promise<unknown>;
}

/** The daemon for this computer's workspace: the binary on loopback with a fresh token, handing out the same link a
 * cloud workspace's daemon is reached by. Close it with close(); the links it handed out close with it. */
export class LocalDaemon {
  private samples: SharedSamples | undefined;

  private constructor(
    private readonly child: ChildProcess,
    private readonly exited: Promise<void>,
    /** The folder holding the token file and the manifest, this daemon's alone, gone with it. */
    private readonly ownDir: string,
    private readonly minted: string,
    readonly port: number,
    readonly root: string,
    /** The file the token is read back off where a caller named one; this daemon's own otherwise. */
    private readonly tokenPath?: string,
  ) {}

  /** The token this daemon opens on now: the file's contents where a caller named the file, since whatever named it
   * rotates it and this daemon reads it at every auth frame; the minted one otherwise, which nothing rewrites. */
  private get token(): string {
    if (this.tokenPath === undefined) return this.minted;
    try {
      return readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      return this.minted;
    }
  }

  static async start(opts: LocalDaemonOptions): Promise<LocalDaemon> {
    const bin = opts.binary ?? daemonBinaryHere();
    const token = randomBytes(24).toString("hex");
    // The inbox dir must exist before the watcher reads it; a cloud guest ships one, this computer makes its own.
    const inboxDir = join(opts.root, ".wsp-inbox");
    mkdirSync(inboxDir, { recursive: true });
    // The daemon reads its token off a file at every auth frame and takes none on its command line, so the file is
    // made in a folder of this daemon's own, never beside the host's files under the person's home. The manifest
    // of what a person started sits beside it: every file the daemon reads or writes is named, and nothing is left
    // to a default under /root this computer has not got.
    const ownDir = mkdtempSync(join(tmpdir(), "wsp-local-daemon-"));
    const tokenPath = opts.tokenPath ?? join(ownDir, "token");
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    // This daemon's root is the person's home, so rootsPathIn names its roots file; the binary's default names the
    // guest's, /root, which on a Linux computer is another user's folder and answers EACCES on every op. Loopback
    // only, and port 0: the machine picks, and the listening line says which. The kind is what picks the modules the
    // Live rows and the Processes tab read: this computer answers for itself, with ps, df and the memory road the
    // platform has, where a guest daemon reads the /proc a Mac does not have.
    const argv = ["--kind", "local", "--host", LOOPBACK, "--port", "0", "--token-path", tokenPath, "--root", opts.root, "--roots-path", rootsPathIn(opts.root), "--inbox", inboxDir, "--work-folder", opts.workFolder, "--manifest", join(ownDir, "manifest.json")];
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    const said: string[] = [];
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      said.push(chunk);
      if (said.length > 20) said.shift();
      process.stderr.write(chunk);
    });
    let gone = false;
    const exited = new Promise<void>(done => child.once("exit", () => ((gone = true), done())));
    const stop = async (): Promise<void> => {
      if (gone) return;
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
      await exited;
      clearTimeout(hard);
    };
    try {
      const port = await new Promise<number>((done, fail) => {
        let out = "";
        const timer = setTimeout(() => fail(new Error(`${bin} did not print its listening line within ${START_MS} ms: ${said.join("").trim()}`)), START_MS);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          out += chunk;
          const m = LISTENING.exec(out);
          if (m === null) return;
          clearTimeout(timer);
          done(Number(m[1]));
        });
        child.once("exit", code => {
          clearTimeout(timer);
          fail(new Error(`${bin} exited with ${code} before it listened: ${said.join("").trim()}`));
        });
        child.once("error", e => {
          clearTimeout(timer);
          fail(e);
        });
      });
      return new LocalDaemon(child, exited, ownDir, token, port, opts.root, opts.tokenPath);
    } catch (e) {
      await stop();
      rmSync(ownDir, { recursive: true, force: true });
      throw e;
    }
  }

  /** The daemon's own process id, for whoever reads its memory. */
  get pid(): number {
    return this.child.pid!;
  }

  /** How anything on this computer dials this daemon: the loopback route and the token that opens it, in the shape a
   * cloud workspace's preview route arrives in, so the browser's link and the status probe read one view. The route
   * is http, which the probe fetches (the socket answers 426 to a plain GET) and every link turns into ws. */
  get road(): DaemonReachView {
    return { url: `http://${LOOPBACK}:${this.port}`, expiresAt: NEVER, daemonToken: this.token };
  }

  /** A link to this daemon, the same one a cloud workspace's daemon is reached by. The caller owns it and closes it;
   * closing the daemon cuts every link it handed out. */
  link(onEvent: (e: DaemonEvent) => void = () => {}): DaemonReach {
    return connectDaemon({ previewUrl: this.road.url, token: this.token, onEvent });
  }

  /** This computer's cpu, memory and disk, pushed to the listener on every sample until the returned detach runs.
   * One watch on one link however many panes listen; it opens with the first and closes with the last, so the
   * daemon's sampler runs only while somebody is reading it. */
  async sysSamples(fn: (s: SysSample) => void): Promise<() => void> {
    if (this.samples === undefined) {
      const listeners = new Set<(s: SysSample) => void>();
      const link = this.link(e => {
        if (e.type !== "sys.sample") return;
        for (const listener of listeners) listener(e);
      });
      const shared: SharedSamples = { link, listeners, watching: link.ready.then(() => link.request("sys.watch")) };
      // A watch that never opened is not kept: the next listener dials again rather than inheriting the refusal.
      shared.watching.catch(() => {
        if (this.samples === shared) this.samples = undefined;
        link.close();
      });
      this.samples = shared;
    }
    const shared = this.samples;
    shared.listeners.add(fn);
    await shared.watching;
    return () => {
      shared.listeners.delete(fn);
      if (shared.listeners.size !== 0 || this.samples !== shared) return;
      this.samples = undefined;
      shared.link.close();
    };
  }

  async close(): Promise<void> {
    this.samples?.link.close();
    this.samples = undefined;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      const hard = setTimeout(() => this.child.kill("SIGKILL"), STOP_MS);
      await this.exited;
      clearTimeout(hard);
    }
    rmSync(this.ownDir, { recursive: true, force: true });
  }
}
