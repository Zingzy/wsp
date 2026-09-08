// SPDX-License-Identifier: AGPL-3.0-only
// The daemon surface for a local workspace, in-process. A cloud fork reaches
// its daemon over the previewUrl edge; this computer has no edge, so the same
// daemon runs here bound to loopback and is reached by the same link
// (connectDaemon), so every caller that dials a workspace's daemon dials this
// one unchanged. It serves the ptys, port watch, inbox, process manifest and
// files a cloud daemon does, rooted at the workspace's folder. The host owns
// it, since the runtime never imports the daemon package (that runs in guests).

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { procNetTcpSource, startDaemon, type DaemonHandle, type PortSnapshotSource } from "@wsp/daemon";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
import type { DaemonEvent } from "@wsp/protocol";

/** Loopback only: a firewall prompt on macOS or Windows is a wall a local workspace must never hit, and nothing off
 * this computer has any business on its daemon. */
const LOOPBACK = "127.0.0.1";

/** The daemon reads listening ports from /proc/net/tcp, which only Linux has; on this person's own macOS the port
 * pane reads empty rather than failing the connect. The Linux read is the guest's road, kept for a Linux host. */
const portSource = (): PortSnapshotSource => (platform() === "linux" ? procNetTcpSource() : async () => []);

export interface LocalDaemonOptions {
  /** The folder the daemon's files and git ops resolve inside, and its ptys start in: the workspace's folder. */
  root: string;
}

/** The in-process daemon for this computer's workspace: it starts on loopback with a fresh token and hands out the
 * same link a cloud workspace's daemon is reached by. Close it with close(); the links it handed out close with it. */
export class LocalDaemon {
  private constructor(
    private readonly handle: DaemonHandle,
    private readonly token: string,
    readonly root: string,
  ) {}

  static async start(opts: LocalDaemonOptions): Promise<LocalDaemon> {
    const token = randomBytes(24).toString("hex");
    // The inbox dir must exist before the watcher reads it; a cloud guest ships one, this computer makes its own.
    const inboxDir = join(opts.root, ".wsp-inbox");
    mkdirSync(inboxDir, { recursive: true });
    const handle = await startDaemon({ host: LOOPBACK, port: 0, token, root: opts.root, inboxDir, portsSource: portSource() });
    return new LocalDaemon(handle, token, opts.root);
  }

  /** The port the daemon bound; 0 asked for a free one. */
  get port(): number {
    return this.handle.port;
  }

  /** A link to this daemon, the same one a cloud workspace's daemon is reached by. The caller owns it and closes it;
   * closing the daemon cuts every link it handed out. */
  link(onEvent: (e: DaemonEvent) => void = () => {}): DaemonReach {
    return connectDaemon({ previewUrl: `ws://${LOOPBACK}:${this.handle.port}`, token: this.token, onEvent });
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
