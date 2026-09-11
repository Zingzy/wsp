// SPDX-License-Identifier: AGPL-3.0-only
// The ssh client a test dials with: it never leaves this computer, so a road
// that records or drives a machine over ssh is proved against the real
// SshBackend and the real address rules with nothing on the network. One home
// for it, read by the runtime's own tests and by the host's keyless roads.
import { SSH_BYTES_OK, SSH_READ_SCRIPT, SshBackend, parseSshAddress, sshIdentity, sshMachineName, type ExecResult, type SshReach, type SshTransport } from "@wsp/engine";
import { sshDaemonPaths } from "@wsp/protocol";
import type { SshWiring } from "../src/runtime.js";

/** Two machines a person could reach over ssh, each with a home and a PATH of its own, so a road that reads one
 * machine's facts for another is a failure rather than a coincidence. */
const MACHINES: Record<string, { home: string; user: string; path: string; cpu: number; memkb: number; key: string; store?: string }> = {
  box: { home: "/home/dev", user: "dev", path: "/home/dev/.local/bin:/usr/bin", cpu: 8, memkb: 16_384_000, key: "ssh-ed25519 SHA256:boxboxboxboxboxboxboxboxboxboxboxboxbox" },
  // The same machine as box, under the address a person might use for it instead: one machine, one host key.
  "10.0.0.9": { home: "/home/dev", user: "dev", path: "/home/dev/.local/bin:/usr/bin", cpu: 8, memkb: 16_384_000, key: "ssh-ed25519 SHA256:boxboxboxboxboxboxboxboxboxboxboxboxbox" },
  "10.0.0.7": { home: "/root", user: "root", path: "/root/.bun/bin:/usr/bin", cpu: 2, memkb: 4_096_000, key: "ssh-ed25519 SHA256:sevensevensevensevensevensevenseven" },
  // A machine whose person points their harness at another folder, which is where their sign-in is.
  moved: { home: "/root", user: "root", path: "/usr/bin", cpu: 1, memkb: 1_024_000, key: "ssh-ed25519 SHA256:movedmovedmovedmovedmovedmoved", store: "/root/.claude-cfg" },
  // A machine whose home is a path with a space in it, which is a home on macOS.
  spaced: { home: "/Users/John Smith", user: "john", path: "/usr/bin", cpu: 4, memkb: 8_192_000, key: "ssh-ed25519 SHA256:spacedspacedspacedspacedspaced" },
  // The computer wsp is running on, reached the way any other machine is.
  "127.0.0.1": { home: "/root", user: "root", path: "/usr/bin", cpu: 2, memkb: 4_096_000, key: "ssh-ed25519 SHA256:hereherehereherehereherehere" },
};

/** An ssh client that never leaves this computer: each machine answers the read with its own facts, every script it
 * was asked to carry is recorded, and a case scripts the answers. */
export function fakeSsh(answer: (script: string, reach: SshReach) => Partial<ExecResult> = () => ({}), deployed?: FakeSshDaemon): { wiring: SshWiring; carried: { reach: SshReach; script: string; stdin?: Uint8Array }[] } {
  const carried: { reach: SshReach; script: string; stdin?: Uint8Array }[] = [];
  /** What is on the machine, as the writes this fake saw left it. */
  const files = new Set<string>();
  const transport: SshTransport = async (reach, script, opts) => {
    carried.push({ reach, script, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const machine = MACHINES[reach.host];
    if (machine === undefined) return { exitCode: 255, stdout: "", stderr: `ssh: Could not resolve hostname ${reach.host}\n` };
    if (script === SSH_READ_SCRIPT) {
      // The client logs what the connection saw on stderr when the read asks it to; that is where the host key is read.
      const log = opts.hostKey === true ? `debug1: Server host key: ${machine.key}\ndebug1: Authenticating to ${reach.host}\n` : "";
      const store = machine.store === undefined ? "" : `store:CLAUDE_CONFIG_DIR ${machine.store}\n`;
      return { exitCode: 0, stdout: `home ${machine.home}\nuser ${machine.user}\npath ${machine.path}\n${store}cpu ${machine.cpu}\nmemkb ${machine.memkb}\n`, stderr: log };
    }
    // The machine's own byte road: the script the ssh machine writes a file with answers the way that machine's
    // shell would, so a road that lands bytes over the connection is proved with nothing on the network. What
    // landed is remembered, since the roads that ask whether a file is there read what an earlier write left.
    if (opts.stdin !== undefined) {
      const landed = /\nmv -f '[^']*' '([^']*)'\n/.exec(script)?.[1];
      if (landed !== undefined) files.add(landed);
      return { exitCode: 0, stdout: `${SSH_BYTES_OK}\n`, stderr: "", ...answer(script, reach) };
    }
    // `test -f '<path>' && echo A || echo B`, the one shape anything here asks a file about.
    const asked = /^test -f '([^']*)' && echo (\S+) \|\| echo (\S+)$/.exec(script.trim());
    if (asked !== null) return { exitCode: 0, stdout: `${files.has(asked[1]!) ? asked[2]! : asked[3]!}\n`, stderr: "", ...answer(script, reach) };
    return { exitCode: 0, stdout: "", stderr: "", ...answer(script, reach) };
  };
  const backend = new SshBackend({ transport });
  return {
    wiring: {
      backend,
      adopt: async (address, opts) => {
        const reach = parseSshAddress(address, opts);
        const { machine, login, shape, hostKey } = await backend.adopt(reach);
        return { machine, name: sshMachineName(reach), login, shape, ...(hostKey !== undefined ? { identity: sshIdentity(hostKey, login.USER), hostKey } : {}) };
      },
      ...(deployed === undefined
        ? {}
        : {
            deployDaemon: async (machine, login) => {
              deployed.deploys.push({ machineId: machine.id, ...login });
              if (deployed.refuse !== undefined) throw new Error(deployed.refuse);
              // The real deploy lands the token file over this same road before it starts the daemon, and the
              // rotation afterwards reads that the file is there; a fake that skipped it would prove neither.
              await machine.putBytes!(sshDaemonPaths(login.home).tokenPath, new TextEncoder().encode("0".repeat(48)));
              return "daemon on node v22.23.2";
            },
            forward: async (machine, remotePort) => {
              const held = deployed.forwards.find(f => f.machineId === machine.id && !f.dropped);
              if (held !== undefined && held.remotePort === remotePort) return { localPort: held.localPort };
              const made = { machineId: machine.id, remotePort, localPort: 40000 + deployed.forwards.length, dropped: false };
              deployed.forwards.push(made);
              return { localPort: made.localPort };
            },
            removeDaemon: async (machine, login) => {
              deployed.removals.push({ machineId: machine.id, ...login });
            },
            dropForward: async machine => {
              for (const f of deployed.forwards) if (f.machineId === machine.id) f.dropped = true;
            },
            close: async () => {
              for (const f of deployed.forwards) f.dropped = true;
              deployed.closed = true;
            },
          }),
    },
    carried,
  };
}

/** A host that puts daemons on machines over ssh and holds the forwards to them, all in this process: what was
 * deployed and where, every forward it opened and whether it was dropped, and whether the host closed. */
export interface FakeSshDaemon {
  deploys: { machineId: string; home: string; path: string }[];
  /** Every machine the daemon was taken off again, in order. */
  removals: { machineId: string; home: string; path: string }[];
  forwards: { machineId: string; remotePort: number; localPort: number; dropped: boolean }[];
  closed: boolean;
  /** Set to make the deploy refuse, the way a machine with no compiler does. */
  refuse?: string;
}

export const fakeSshDaemon = (over: Partial<FakeSshDaemon> = {}): FakeSshDaemon => ({ deploys: [], removals: [], forwards: [], closed: false, ...over });
