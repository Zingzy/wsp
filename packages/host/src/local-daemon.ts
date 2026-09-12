// SPDX-License-Identifier: AGPL-3.0-only
// The daemon surface for a local workspace, in-process. A cloud fork reaches
// its daemon over the previewUrl edge; this computer has no edge, so the same
// daemon runs here bound to loopback and is reached by the same link
// (connectDaemon), so every caller that dials a workspace's daemon dials this
// one unchanged. It serves the ptys, port watch, inbox, process manifest and
// files a cloud daemon does, rooted at the workspace's folder, and it reads
// this computer's own load and processes rather than a guest's /proc. The host owns
// it, since the runtime never imports the daemon package (that runs in guests).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
// LOOPBACK is the protocol's, which every road that binds or dials this computer reads. Here the reason is also
// that a firewall prompt on macOS or Windows is a wall a local workspace must never hit.
import { LOOPBACK, rootsPathIn, type DaemonEvent, type DaemonReachView } from "@wsp/protocol";

/** The loopback token is minted when the daemon starts and lives as long as the process holding it, so the road to
 * it never expires; the view's expiry is a number, so it carries the furthest one. */
const NEVER = Number.MAX_SAFE_INTEGER;

export interface LocalDaemonOptions {
  /** The folder the daemon's files and git ops resolve inside, and its ptys start in: the workspace's folder. */
  root: string;
  /** The folder turns write in, whose volume the Machine tab's disk row reads. */
  workFolder: string;
  /** The file this daemon reads its token from at every auth frame, for a daemon whose token something else
   * rotates: a stand-in provider's machine, whose token the runtime writes through the machine's own exec. The
   * first token is minted here and written there. Without one the token lives in this process alone. */
  tokenPath?: string;
}

/** The in-process daemon for this computer's workspace: it starts on loopback with a fresh token and hands out the
 * same link a cloud workspace's daemon is reached by. Close it with close(); the links it handed out close with it. */
export class LocalDaemon {
  private constructor(
    private readonly handle: DaemonHandle,
    private readonly minted: string,
    readonly root: string,
    private readonly tokenPath?: string,
  ) {}

  static async start(opts: LocalDaemonOptions): Promise<LocalDaemon> {
    const token = randomBytes(24).toString("hex");
    // The inbox dir must exist before the watcher reads it; a cloud guest ships one, this computer makes its own.
    const inboxDir = join(opts.root, ".wsp-inbox");
    mkdirSync(inboxDir, { recursive: true });
    // This daemon's root is the person's home, so rootsPathIn names its roots file; the option's default names the
    // guest's, /root, which on a Linux computer is another user's folder and answers EACCES on every op.
    const rootsPath = rootsPathIn(opts.root);
    // Written before the daemon starts, since it refuses to start with no token to read; from then on the file is
    // the token, and whatever rotates it is answered without this daemon being restarted.
    if (opts.tokenPath !== undefined) {
      mkdirSync(dirname(opts.tokenPath), { recursive: true });
      writeFileSync(opts.tokenPath, token, { mode: 0o600 });
    }
    // Loopback only: a firewall prompt on macOS or Windows is a wall a local workspace must never hit, and nothing
    // off this computer has any business on its daemon.
    //
    // The kind is what picks the modules the Live rows and the Processes tab read: this computer answers for itself,
    // with os, df and ps, where a guest daemon reads the /proc a Mac does not have.
    const handle = await startDaemon({
      host: LOOPBACK,
      port: 0,
      kind: "local",
      root: opts.root,
      workFolder: opts.workFolder,
      inboxDir,
      rootsPath,
      ...(opts.tokenPath === undefined ? { token } : { tokenPath: opts.tokenPath }),
    });
    return new LocalDaemon(handle, token, opts.root, opts.tokenPath);
  }

  /** The token this daemon opens on now: the file's where one was named, since something else may have rotated it. */
  private get token(): string {
    if (this.tokenPath === undefined) return this.minted;
    try {
      return readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      return this.minted;
    }
  }

  /** The port the daemon bound; 0 asked for a free one. */
  get port(): number {
    return this.handle.port;
  }

  /** How anything on this computer dials this daemon: the loopback route and the token that opens it, in the shape a
   * cloud workspace's preview route arrives in, so the browser's link and the status probe read one view. The route
   * is http, which the probe fetches (the socket answers 426 to a plain GET) and every link turns into ws. */
  get road(): DaemonReachView {
    return { url: `http://${LOOPBACK}:${this.handle.port}`, expiresAt: NEVER, daemonToken: this.token };
  }

  /** A link to this daemon, the same one a cloud workspace's daemon is reached by. The caller owns it and closes it;
   * closing the daemon cuts every link it handed out. */
  link(onEvent: (e: DaemonEvent) => void = () => {}): DaemonReach {
    return connectDaemon({ previewUrl: this.road.url, token: this.token, onEvent });
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
