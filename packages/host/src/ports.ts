// SPDX-License-Identifier: AGPL-3.0-only
// Whether the ports the app will bind are free on this computer, asked before
// a machine bills: an init that ends by serving the app learns of a clash
// before the build, not after it.
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { LOOPBACK } from "@wsp/runtime";

export interface PortListener {
  command: string;
  pid: number;
}

/** True when a bind on the port refuses with EADDRINUSE; any other bind error is thrown. Port 0 is always free. The
 * probe binds the address the host binds, so it fails the way the host would. */
export function portInUse(port: number, host = LOOPBACK): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(true) : reject(e)));
    server.listen(port, host, () => server.close(() => resolve(false)));
  });
}

/** The process listening on the port as lsof names it; nothing when lsof is missing, times out or names none. */
export function listenerOf(port: number): Promise<PortListener | undefined> {
  return new Promise(resolve => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 3_000 }, (_err, stdout) => {
      const pid = /^p(\d+)$/m.exec(stdout)?.[1];
      const command = /^c(.+)$/m.exec(stdout)?.[1];
      resolve(pid !== undefined && command !== undefined ? { command, pid: Number(pid) } : undefined);
    });
  });
}

/** The sentence for the first taken port, naming its holder when this computer can; nothing when every port is free. */
export async function portClash(ports: readonly number[], probe = portInUse, holder = listenerOf): Promise<string | undefined> {
  for (const port of ports) {
    if (!(await probe(port))) continue;
    const who = await holder(port);
    return `Port ${port} is in use on this computer by ${who === undefined ? "another process" : `${who.command} (pid ${who.pid})`}.`;
  }
  return undefined;
}
