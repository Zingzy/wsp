// SPDX-License-Identifier: AGPL-3.0-only
// The ssh client a test dials with: it never leaves this computer, so a road
// that records or drives a machine over ssh is proved against the real
// SshBackend and the real address rules with nothing on the network. One home
// for it, read by the runtime's own tests and by the host's keyless roads.
import { SSH_READ_SCRIPT, SshBackend, parseSshAddress, sshIdentity, sshMachineName, type ExecResult, type SshReach, type SshTransport } from "@wsp/engine";
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
export function fakeSsh(answer: (script: string, reach: SshReach) => Partial<ExecResult> = () => ({})): { wiring: SshWiring; carried: { reach: SshReach; script: string }[] } {
  const carried: { reach: SshReach; script: string }[] = [];
  const transport: SshTransport = async (reach, script, opts) => {
    carried.push({ reach, script });
    const machine = MACHINES[reach.host];
    if (machine === undefined) return { exitCode: 255, stdout: "", stderr: `ssh: Could not resolve hostname ${reach.host}\n` };
    if (script === SSH_READ_SCRIPT) {
      // The client logs what the connection saw on stderr when the read asks it to; that is where the host key is read.
      const log = opts.hostKey === true ? `debug1: Server host key: ${machine.key}\ndebug1: Authenticating to ${reach.host}\n` : "";
      const store = machine.store === undefined ? "" : `store:CLAUDE_CONFIG_DIR ${machine.store}\n`;
      return { exitCode: 0, stdout: `home ${machine.home}\nuser ${machine.user}\npath ${machine.path}\n${store}cpu ${machine.cpu}\nmemkb ${machine.memkb}\n`, stderr: log };
    }
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
    },
    carried,
  };
}
