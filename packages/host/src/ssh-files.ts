// SPDX-License-Identifier: AGPL-3.0-only
// The files on this computer an editor's ssh into a workspace reads. Every one is under the wsp home but the one line
// in the person's own ~/.ssh/config that points at wsp's config, which goes in only when they say yes.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SSH_ALIAS_PREFIX, SSH_HOST_KEY_LINE, shellLine, sshAlias } from "@wsp/protocol";
import type { HostSsh } from "@wsp/runtime";
import { NoSshLinkError, type CallbackRelay } from "./relay.js";

const execFileAsync = promisify(execFile);

export interface SshFiles {
  /** The public half of the one key wsp makes on this computer, made the first time it is asked for. */
  publicKey(): Promise<string>;
  /** Trusts this key, and no other, for the alias. */
  pin(alias: string, hostKey: string): Promise<void>;
  /** Writes wsp's own config, which sends every wsp- alias through `<wsp> ssh`. */
  writeConfig(wsp: readonly string[]): Promise<void>;
  /** Whether the person's ~/.ssh/config reads wsp's config. */
  include(): Promise<boolean>;
  /** Puts the line in or takes it out, and answers whether it stands. */
  setInclude(on: boolean): Promise<boolean>;
}

const quoted = (path: string): string => `"${path}"`;

/** The wsp an ssh config's ProxyCommand runs, on the state the host that wrote it serves. ssh runs that line later
 * from whatever folder the person is in, and a line naming no state resolves one of its own there, a checkout's own
 * among them, so the state is always named, as it is on every agent's tool server line. */
export function proxyWsp(wsp: readonly string[], statePath: string | undefined): string[] {
  return statePath === undefined ? [...wsp] : [...wsp, "--state", statePath];
}

export function sshFiles(o: { wspHome: string; personHome: string; keygen?: string }): SshFiles {
  const dir = join(o.wspHome, "ssh");
  const key = join(dir, "id_ed25519");
  const knownHosts = join(dir, "known_hosts");
  const config = join(o.wspHome, "ssh_config");
  const personDir = join(o.personHome, ".ssh");
  const personConfig = join(personDir, "config");
  const line = `Include ${quoted(config)}`;
  const own = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  };
  const theirs = (): string => (existsSync(personConfig) ? readFileSync(personConfig, "utf8") : "");
  const stands = (text: string): boolean => text.split("\n").includes(line);

  return {
    async publicKey() {
      if (!existsSync(`${key}.pub`)) {
        own();
        await execFileAsync(o.keygen ?? "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `wsp on ${hostname()}`, "-f", key]);
      }
      return readFileSync(`${key}.pub`, "utf8").trim();
    },
    async pin(alias, hostKey) {
      if (!SSH_HOST_KEY_LINE.test(hostKey)) throw new Error(`the host key for ${alias} is not one ed25519 line, so it is not pinned`);
      own();
      const kept = existsSync(knownHosts) ? readFileSync(knownHosts, "utf8").split("\n").filter(l => l !== "" && l.split(" ")[0] !== alias) : [];
      writeFileSync(knownHosts, [...kept, `${alias} ${hostKey}`].map(l => `${l}\n`).join(""), { mode: 0o600 });
    },
    async writeConfig(wsp) {
      own();
      const text = [
        `Host ${SSH_ALIAS_PREFIX}*`,
        // OpenSSH expands % tokens across the whole line before a shell reads it, inside quotes too, so a % the
        // command's own words carry is doubled; the %n after them is ssh's.
        `  ProxyCommand ${shellLine(wsp).replaceAll("%", "%%")} ssh %n`,
        "  User root",
        `  IdentityFile ${quoted(key)}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${quoted(knownHosts)}`,
        "  StrictHostKeyChecking yes",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  ServerAliveInterval 15",
      ];
      writeFileSync(config, text.map(l => `${l}\n`).join(""), { mode: 0o600 });
    },
    async include() {
      return stands(theirs());
    },
    async setInclude(on) {
      const text = theirs();
      if (stands(text) === on) return on;
      if (on) {
        // First: an Include below a Host block belongs to that block alone.
        if (!existsSync(personDir)) mkdirSync(personDir, { mode: 0o700 });
        const made = !existsSync(personConfig);
        writeFileSync(personConfig, `${line}\n${text}`);
        if (made) chmodSync(personConfig, 0o600);
        return true;
      }
      writeFileSync(personConfig, text.split("\n").filter(l => l !== line).join("\n"));
      return false;
    },
  };
}

/** How long an ssh road waits for the link to a workspace that was just woken. */
export const SSH_LINK_WAIT_MS = 60_000;

/** The host's ssh door: this computer's key allowed on the workspace's server, the server's key pinned under the
 * workspace's alias, and the port the relay carries to it. wsp's own config is written again on every road and every
 * Include, since the command it names moves with an update and a host start is no time to write a person's files. */
export function sshDoor(relay: Pick<CallbackRelay, "sshPort">, files: SshFiles, wsp: () => readonly string[], waitMs = SSH_LINK_WAIT_MS): HostSsh {
  return {
    async port(workspace) {
      await files.writeConfig(wsp());
      const key = await files.publicKey();
      const deadline = Date.now() + waitMs;
      for (;;) {
        try {
          const { port, hostKey } = await relay.sshPort(workspace.id, key);
          await files.pin(sshAlias(workspace.name), hostKey);
          return port;
        } catch (e) {
          if (!(e instanceof NoSshLinkError) || Date.now() >= deadline) throw e;
          await new Promise(r => setTimeout(r, 250));
        }
      }
    },
    include: () => files.include(),
    setInclude: async on => {
      if (on) await files.writeConfig(wsp());
      return files.setInclude(on);
    },
  };
}
