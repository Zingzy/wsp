// SPDX-License-Identifier: AGPL-3.0-only
// The files on this computer an editor's ssh into a workspace reads: the one key wsp makes, the host keys it pins,
// its own ssh config, and the one line in the person's ~/.ssh/config that points at it. Every case works in a
// throwaway home and runs the real ssh-keygen.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoSshLinkError } from "../src/relay.js";
import { sshDoor, sshFiles } from "../src/ssh-files.js";

let root: string;
let files: ReturnType<typeof sshFiles>;
const wspHome = (): string => join(root, ".wsp");
const personConfig = (): string => join(root, ".ssh", "config");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wsp-ssh-files-"));
  files = sshFiles({ wspHome: wspHome(), personHome: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the key wsp makes", () => {
  it("is made once, private at mode 600, and its public half is one ed25519 line", async () => {
    const key = await files.publicKey();
    expect(key).toMatch(/^ssh-ed25519 AAAA\S+ \S/);
    expect(statSync(join(wspHome(), "ssh", "id_ed25519")).mode & 0o777).toBe(0o600);
    expect(await files.publicKey()).toBe(key);
  });
});

describe("the host keys wsp pins", () => {
  it("replaces the alias's own line and leaves every other alias's", async () => {
    await files.pin("wsp-cart", "ssh-ed25519 AAAAone cart");
    await files.pin("wsp-search", "ssh-ed25519 AAAAtwo search");
    await files.pin("wsp-cart", "ssh-ed25519 AAAAthree cart");
    expect(readFileSync(join(wspHome(), "ssh", "known_hosts"), "utf8")).toBe("wsp-search ssh-ed25519 AAAAtwo search\nwsp-cart ssh-ed25519 AAAAthree cart\n");
  });
});

describe("a host key that is not one ed25519 line", () => {
  it("is never pinned: a line of its own would be trusted for every wsp- alias", async () => {
    await files.pin("wsp-cart", "ssh-ed25519 AAAAone cart");
    for (const bad of ["ssh-ed25519 AAAAtwo cart\n@cert-authority wsp-* ssh-ed25519 AAAAevil", "ssh-rsa AAAAthree", ""]) {
      await expect(files.pin("wsp-cart", bad), JSON.stringify(bad)).rejects.toThrow("not one ed25519 line");
    }
    expect(readFileSync(join(wspHome(), "ssh", "known_hosts"), "utf8")).toBe("wsp-cart ssh-ed25519 AAAAone cart\n");
  });
});

describe("wsp's own ssh config", () => {
  it("sends every wsp- alias through wsp ssh with wsp's key, and trusts only the host keys wsp pinned", async () => {
    await files.writeConfig(["/Applications/wsp.app/bin/wsp"]);
    const text = readFileSync(join(wspHome(), "ssh_config"), "utf8");
    expect(text.split("\n")[0]).toBe("Host wsp-*");
    expect(text).toContain("  ProxyCommand /Applications/wsp.app/bin/wsp ssh %n\n");
    expect(text).toContain(`  IdentityFile "${join(wspHome(), "ssh", "id_ed25519")}"\n`);
    expect(text).toContain(`  UserKnownHostsFile "${join(wspHome(), "ssh", "known_hosts")}"\n`);
    expect(text).toContain("  StrictHostKeyChecking yes\n");
    expect(text).toContain("  IdentitiesOnly yes\n");
    expect(text).toContain("  User root\n");
  });

  it("quotes a command whose words have spaces in them", async () => {
    await files.writeConfig(["/Users/a b/node", "/Users/a b/wsp/bin.js"]);
    expect(readFileSync(join(wspHome(), "ssh_config"), "utf8")).toContain("  ProxyCommand '/Users/a b/node' '/Users/a b/wsp/bin.js' ssh %n\n");
  });
});

describe("the one line in the person's ssh config", () => {
  const line = (): string => `Include "${join(wspHome(), "ssh_config")}"`;

  it("goes in first, above everything the person wrote, and comes out leaving every other byte", async () => {
    mkdirSync(join(root, ".ssh"), { mode: 0o700 });
    const theirs = "Host box\n  HostName 10.0.0.2\n\n# mine\nHost *\n  ServerAliveInterval 30\n";
    writeFileSync(personConfig(), theirs);
    // Chmod rather than a mode on the write, which the umask would take bits off.
    chmodSync(personConfig(), 0o644);
    expect(await files.include()).toBe(false);
    expect(await files.setInclude(true)).toBe(true);
    expect(readFileSync(personConfig(), "utf8")).toBe(`${line()}\n${theirs}`);
    expect(statSync(personConfig()).mode & 0o777).toBe(0o644);
    expect(await files.include()).toBe(true);
    expect(await files.setInclude(false)).toBe(false);
    expect(readFileSync(personConfig(), "utf8")).toBe(theirs);
  });

  it("is written once however often it is asked for", async () => {
    await files.setInclude(true);
    await files.setInclude(true);
    expect(readFileSync(personConfig(), "utf8")).toBe(`${line()}\n`);
  });

  it("makes the folder and the file private where the person has neither", async () => {
    expect(await files.setInclude(true)).toBe(true);
    expect(statSync(join(root, ".ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(personConfig()).mode & 0o777).toBe(0o600);
    expect(await files.setInclude(false)).toBe(false);
    expect(readFileSync(personConfig(), "utf8")).toBe("");
  });
});

describe("the host's ssh door", () => {
  it("allows this computer's key, pins the server's key under the workspace's alias, and waits out a link a wake has not brought up yet", async () => {
    const asked: [string, string][] = [];
    let tries = 0;
    const relay = {
      sshPort: async (id: string, key: string) => {
        asked.push([id, key]);
        if (++tries < 3) throw new NoSshLinkError(`${id}: this host holds no link to that workspace`);
        return { port: 51022, hostKey: "ssh-ed25519 AAAAfork cart" };
      },
    };
    const door = sshDoor(relay, files, () => ["/usr/local/bin/wsp"]);
    expect(await door.port({ id: "ws_cart", name: "Cart rounding, v2" })).toBe(51022);
    const key = await files.publicKey();
    expect(asked).toEqual([["ws_cart", key], ["ws_cart", key], ["ws_cart", key]]);
    expect(readFileSync(join(wspHome(), "ssh", "known_hosts"), "utf8")).toBe("wsp-cart-rounding-v2 ssh-ed25519 AAAAfork cart\n");
    expect(readFileSync(join(wspHome(), "ssh_config"), "utf8")).toContain("  ProxyCommand /usr/local/bin/wsp ssh %n\n");
  });

  it("gives up on a link that never comes, and passes any other refusal on at once", async () => {
    const never = sshDoor({ sshPort: async () => Promise.reject(new NoSshLinkError("ws_cart: this host holds no link to that workspace")) }, files, () => ["wsp"], 300);
    await expect(never.port({ id: "ws_cart", name: "cart" })).rejects.toThrow("no link");
    let asks = 0;
    const refused = sshDoor({ sshPort: async () => Promise.reject(new Error(`cart: ${++asks} this image has no ssh server`)) }, files, () => ["wsp"]);
    await expect(refused.port({ id: "ws_cart", name: "cart" })).rejects.toThrow("1 this image has no ssh server");
  });
});
