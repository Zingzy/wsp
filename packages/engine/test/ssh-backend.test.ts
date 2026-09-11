// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OS_READ, UPTIME_READ } from "../src/machine-facts.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { SSH_CONTROL_PERSIST_S, SSH_FACTS_SCRIPT, SSH_READ_SCRIPT, SSH_STORE_VARS, SshBackend, makeSshControlDir, sshControlDir, sshControlPath, parseSshAddress, parseSshMachineId, hostKeyOf, plainPath, DEFAULT_REMOTE_PATH, sshArgs, sshIdentity, sshMachineId, sshMachineName, sshReachOf, type SshReach, type SshTransport } from "../src/ssh-backend.js";

/** An ssh client that never leaves this computer: it answers the read every adopt makes, records every script it was
 * asked to carry, and lets a case script the answer for anything else. */
function fakeSsh(answer: (script: string) => Partial<ExecResult> = () => ({})): { transport: SshTransport; carried: { reach: SshReach; script: string }[] } {
  const carried: { reach: SshReach; script: string }[] = [];
  const transport: SshTransport = async (reach, script, opts) => {
    carried.push({ reach, script });
    if (script === SSH_READ_SCRIPT) {
      const log = opts.hostKey === true ? "debug1: Connecting to 10.0.0.5\ndebug1: Server host key: ssh-ed25519 SHA256:AbCd1234\n" : "";
      return { exitCode: 0, stdout: "home /home/dev\nuser dev\npath /home/dev/.local/bin:/usr/bin\ncpu 8\nmemkb 16384000\n", stderr: log };
    }
    const scripted = { exitCode: 0, stdout: "", stderr: "", ...answer(script) };
    for (const line of scripted.stdout.split("\n").slice(0, -1)) opts.onLine?.(line);
    return scripted;
  };
  return { transport, carried };
}

const REACH: SshReach = { user: "dev", host: "10.0.0.5", port: 2222, keyPath: "/tmp/k/id_ed25519" };

describe("ssh backend", () => {
  it("every capability a machine wsp forks has and one it only reaches does not is false, and it says the machine is kept", () => {
    const backend = new SshBackend();
    expect(backend.capabilities).toEqual({
      liveCloneForks: false,
      resize: false,
      replacesMachine: false,
      previewUrls: false,
      signedUrls: false,
      containers: false,
      callbackRelay: false,
      diskSnapshots: false,
      snapshotListing: false,
      templates: false,
      kept: true,
      sizes: [],
    });
    expect(backend.pricing.rateUsdPerHour({ cpu: 8, memMb: 16384 })).toBe(0);
  });

  it("the machine id is the dial: user, host, port and key go in and come back out", () => {
    expect(parseSshMachineId(sshMachineId(REACH))).toEqual(REACH);
    expect(parseSshMachineId(sshMachineId({ user: "dev", host: "box", port: 22 }))).toEqual({ user: "dev", host: "box", port: 22 });
    expect(parseSshMachineId("local")).toBeUndefined();
    expect(parseSshMachineId("m_ab12cd")).toBeUndefined();
  });

  it("user@host names the dial, with the port and key the person gave", () => {
    expect(parseSshAddress("dev@box")).toEqual({ user: "dev", host: "box", port: 22 });
    expect(parseSshAddress("dev@box:2222")).toEqual({ user: "dev", host: "box", port: 2222 });
    expect(parseSshAddress("dev@box", { port: 2200, keyPath: "/tmp/k" })).toEqual({ user: "dev", host: "box", port: 2200, keyPath: "/tmp/k" });
    expect(() => parseSshAddress("box")).toThrow("name the machine as user@host");
  });

  it("the client runs the script under bash -c on the machine, never a login shell, with the port and key asked for", () => {
    const args = sshArgs(REACH, "echo 'it works'");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "/tmp/k/id_ed25519"]);
    expect(args).not.toContain("-lc");
    // The script is one quoted word after the address, so a quote inside it reaches the machine as written.
    expect(args.slice(-4)).toEqual(["dev@10.0.0.5", "bash", "-c", `'echo '\\''it works'\\'''`]);
    expect(sshArgs({ user: "dev", host: "box", port: 22 }, "true")).not.toContain("-i");
  });

  it("a machine with no name given is called what its address calls it", () => {
    expect(sshMachineName({ user: "dev", host: "box.example.com", port: 22 })).toBe("box");
    expect(sshMachineName({ user: "dev", host: "box", port: 22 })).toBe("box");
    expect(sshMachineName({ user: "dev", host: "10.0.0.5", port: 22 })).toBe("10.0.0.5");
  });

  it("adopt dials once, reads the machine's own login and size, and hands back the handle the record stands on", async () => {
    const { transport, carried } = fakeSsh();
    const backend = new SshBackend({ transport });
    const { machine, login, shape } = await backend.adopt(REACH);
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT]);
    expect(shape).toEqual({ cpu: 8, memMb: 16000 });
    // The turn's environment is the machine's own login: its home, who it runs as, and the PATH their shell gives.
    expect(login).toEqual({ HOME: "/home/dev", USER: "dev", PATH: "/home/dev/.local/bin:/usr/bin" });
    expect(sshReachOf(machine)).toEqual(REACH);
    // The record keeps the id alone, and a later host process reaches the same machine from it.
    expect(sshReachOf(await backend.get(machine.id))).toEqual(REACH);
  });

  it("holds each folder of the machine's own PATH to the rule the home is held to, and falls back with nothing left", () => {
    // The PATH is the last thing the machine answers with that is written rather than run: a turn exports it and
    // the daemon's unit states it, where systemd splits an Environment= line on whitespace and reads a quote as
    // quoting. A folder carrying either is dropped at this door, so nothing downstream escapes it twenty times.
    expect(plainPath("/home/dev/.local/bin:/usr/bin")).toBe("/home/dev/.local/bin:/usr/bin");
    expect(plainPath('/usr/bin:/opt/a"b/bin:/bin')).toBe("/usr/bin:/bin");
    expect(plainPath("/usr/bin:/opt/my tools/bin")).toBe("/usr/bin");
    expect(plainPath("/usr/bin:/opt/$(id)/bin:/opt/`id`/bin")).toBe("/usr/bin");
    // An empty entry is the working directory, which is a folder nobody meant to put on a PATH.
    expect(plainPath("/usr/bin::/bin")).toBe("/usr/bin:/bin");
    expect(plainPath("./bin:/bin")).toBe("/bin");
    // A machine that answers with nothing usable leaves a harness missing rather than every command missing.
    for (const answered of [undefined, "", "relative:also/relative", '"'])
      expect(plainPath(answered), JSON.stringify(answered)).toBe(DEFAULT_REMOTE_PATH);
  });

  it("a machine that does not answer the dial is refused with the client's own words, not its debug log", async () => {
    const transport: SshTransport = async () => ({
      exitCode: 255,
      stdout: "",
      stderr: "debug1: Offering public key: /tmp/k/id_ed25519\ndebug1: No more authentication methods to try.\ndev@10.0.0.5: Permission denied (publickey).\n",
    });
    const failed = await new SshBackend({ transport }).adopt(REACH).then(() => "", (e: unknown) => (e as Error).message);
    expect(failed).toContain("Permission denied (publickey).");
    expect(failed).not.toContain("debug1:");
  });

  it("the read dial asks the client what key the machine answered with, and no other call does", async () => {
    const { transport, carried } = fakeSsh();
    const backend = new SshBackend({ transport });
    const { machine, hostKey } = await backend.adopt(REACH);
    expect(hostKey).toBe("ssh-ed25519 SHA256:AbCd1234");
    // Two machines are the same machine when they answer with the same key as the same login, whatever the address.
    expect(sshIdentity(hostKey!, "dev")).toBe("ssh-ed25519 SHA256:AbCd1234 as dev");
    // Only the read carries the log flag: every other command would otherwise put the client's debug on its stderr.
    expect(sshArgs(REACH, "true", { hostKey: true })).toContain("LogLevel=DEBUG");
    expect(sshArgs(REACH, "true")).not.toContain("LogLevel=DEBUG");
    await machine.exec("true");
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT, "true"]);
  });

  it("a client that logged no key leaves the machine without an identity of its own rather than inventing one", () => {
    expect(hostKeyOf("debug1: Authenticating to box\n")).toBeUndefined();
    expect(hostKeyOf("debug1: Server host key: ssh-rsa SHA256:zzz\ndebug1: next line\n")).toBe("ssh-rsa SHA256:zzz");
  });

  it("the machine's own words for its home are held to a plain path, since every path a turn runs is built from it", async () => {
    const home = (answer: string): Promise<unknown> => {
      const transport: SshTransport = async () => ({ exitCode: 0, stdout: `home ${answer}\nuser dev\npath /usr/bin\ncpu 1\nmemkb 1024\n`, stderr: "" });
      return new SshBackend({ transport }).adopt(REACH).then(a => a.login["HOME"], (e: unknown) => (e as Error).message);
    };
    // What a machine answering with shell in its home would land in the launch: refused at the one door instead.
    expect(await home("/home/dev x; touch /tmp/pwned")).toContain("is not a plain path");
    expect(await home("/home/$(id -un)")).toContain("is not a plain path");
    expect(await home("/home/dev`whoami`")).toContain("is not a plain path");
    expect(await home("relative/home")).toContain("is not a plain path");
    expect(await home("")).toContain("no home folder");
    // A space is a home on macOS and stays a home: the paths built from it are quoted where they land in a command.
    expect(await home("/Users/John Smith")).toBe("/Users/John Smith");
    expect(await home("/root")).toBe("/root");
  });

  it("the store folder each harness reads is asked of the machine's own login shell, and held to the same rule", async () => {
    const read = (line: string): Promise<Record<string, string>> => {
      const transport: SshTransport = async () => ({ exitCode: 0, stdout: `home /root\nuser root\npath /usr/bin\n${line}cpu 1\nmemkb 1024\n`, stderr: "" });
      return new SshBackend({ transport }).adopt(REACH).then(a => ({ ...a.login }));
    };
    expect(SSH_STORE_VARS).toContain("CLAUDE_CONFIG_DIR");
    // The read asks a login shell for each store variable the catalog names, in the same call that asks for PATH.
    expect(SSH_READ_SCRIPT).toContain("bash -lc");
    expect(SSH_READ_SCRIPT).toContain('printf "store:CLAUDE_CONFIG_DIR %s');
    expect(await read("store:CLAUDE_CONFIG_DIR /root/.claude-cfg\n")).toMatchObject({ HOME: "/root", CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
    // A machine that names none leaves the harness on its default, and one that names shell is left there too.
    expect((await read(""))["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect((await read("store:CLAUDE_CONFIG_DIR /root/x; id\n"))["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("every command to one machine rides one master connection, and two machines never share one", () => {
    const args = sshArgs(REACH, "true");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain(`ControlPersist=${SSH_CONTROL_PERSIST_S}`);
    expect(args).toContain(`ControlPath=${sshControlPath(REACH)}`);
    // One socket per machine, named by the dial and short enough for a unix socket whatever the host name is.
    expect(sshControlPath({ ...REACH, keyPath: "/tmp/k/other" })).toBe(sshControlPath(REACH));
    expect(sshControlPath({ ...REACH, port: 22 })).not.toBe(sshControlPath(REACH));
    expect(sshControlPath({ user: "dev", host: "a".repeat(200), port: 22 }, "/tmp").length).toBeLessThan(100);
  });

  it("the master sockets live in a folder only the person can read, made and kept at that mode", () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-ssh-home-"));
    try {
      // Whoever holds a control socket holds every command that rides it, so the folder is wsp's own and nobody
      // else's: not the shared temp folder, whose name anyone could work out and sit on first.
      const dir = makeSshControlDir(home);
      expect(dir).toBe(join(home, ".wsp", "ssh"));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(sshControlPath(REACH, dir).startsWith(`${dir}/`)).toBe(true);
      // With no home named it is the person's own, never the folder every login on this computer shares.
      expect(sshControlDir()).toBe(join(homedir(), ".wsp", "ssh"));
      // A folder left looser by something else is tightened rather than trusted.
      chmodSync(dir, 0o755);
      expect(statSync(makeSshControlDir(home)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exec and run carry the script to the machine, and run streams each line", async () => {
    const { transport, carried } = fakeSsh(script => (script === "exit 7" ? { exitCode: 7 } : { stdout: "a\nb\n" }));
    const backend = new SshBackend({ transport });
    const { machine } = await backend.adopt(REACH);
    expect((await machine.exec("exit 7")).exitCode).toBe(7);
    const lines: string[] = [];
    const res = await machine.run("printf 'a\\nb\\n'", { deadlineMs: 5_000, onLine: l => lines.push(l) });
    expect(lines).toEqual(["a", "b"]);
    expect(res.exitCode).toBe(0);
    expect(carried.map(c => c.script).slice(1)).toEqual(["exit 7", "printf 'a\\nb\\n'"]);
    expect(carried.every(c => c.reach.user === "dev" && c.reach.host === "10.0.0.5" && c.reach.port === 2222 && c.reach.keyPath === REACH.keyPath)).toBe(true);
  });

  it("the moves only a machine wsp forks takes are refused, and it serves no preview or signed URL", async () => {
    const { transport } = fakeSsh();
    const backend = new SshBackend({ transport });
    // Read as the runtime holds it, through the seam, so a refusal is proven on the interface every road calls.
    const machine: Machine = (await backend.adopt(REACH)).machine;
    await expect(machine.snapshot("x", { firstLife: true })).rejects.toThrow("cannot be snapshotted");
    await expect(machine.pause()).rejects.toThrow("cannot be paused");
    await expect(machine.resume()).rejects.toThrow("cannot be resumed");
    expect(machine.previewUrl).toBeUndefined();
    await expect(machine.downloadUrl("/x")).rejects.toThrow("no signed download URL");
    await expect(machine.uploadUrl("/x")).rejects.toThrow("no signed upload URL");
    await expect(backend.create()).rejects.toThrow("already exists");
    await expect(backend.deleteSnapshot()).rejects.toThrow("no snapshots");
    await expect(backend.get("local")).rejects.toThrow("is not a machine this host reaches over ssh");
    // Deleting an ssh workspace drops its record only: kill is a no-op, and nothing lists the person's machines.
    await expect(machine.kill()).resolves.toBeUndefined();
    expect(await machine.state()).toBe("running");
    expect(await backend.list()).toEqual([]);
  });
});

describe("what a machine over ssh says it is", () => {
  /** What an Ubuntu box prints for the facts script, as its own shell would. */
  const UBUNTU = "pretty Ubuntu 24.04.3 LTS\nmac \nkernel Linux 6.8.0-79-generic\nuptime 96521.42\nboot \nhome /home/dev\n";

  /** The machine handle as the runtime holds it, through the seam every kind answers on. */
  async function machineOf(answer: (script: string) => Partial<ExecResult>): Promise<{ machine: Machine; carried: { script: string }[] }> {
    const { transport, carried } = fakeSsh(answer);
    const { machine } = await new SshBackend({ transport }).adopt(REACH);
    return { machine, carried };
  }

  it("the three the pane waits on are read off the machine itself, in one script over the connection", async () => {
    const { machine, carried } = await machineOf(script => (script === SSH_FACTS_SCRIPT ? { stdout: UBUNTU } : {}));
    expect(machine.facts).toBeDefined();
    expect(await machine.facts!()).toEqual({ os: "Ubuntu 24.04.3 LTS", uptimeMs: 96_521_420, folder: "/home/dev" });
    // One round trip per read, and the same lines this computer's own machine is read with: one reader, two callers.
    expect(carried.map(c => c.script).slice(1)).toEqual([SSH_FACTS_SCRIPT]);
    expect(SSH_FACTS_SCRIPT).toContain(OS_READ.join("\n"));
    expect(SSH_FACTS_SCRIPT).toContain(UPTIME_READ.join("\n"));
    // Nothing is held: a machine somebody owns is rebooted and upgraded under wsp rather than by it.
    await machine.facts!();
    expect(carried.map(c => c.script).slice(1)).toEqual([SSH_FACTS_SCRIPT, SSH_FACTS_SCRIPT]);
  });

  it("a Mac over ssh says when it booted rather than how long it has been up, and the row gets a length either way", async () => {
    const bootSec = Math.floor(Date.now() / 1000) - 7_200;
    const mac = `pretty \nmac 15.6.1\nkernel Darwin 24.6.0\nuptime \nboot { sec = ${bootSec}, usec = 12 } Thu Sep 10 17:24:09 2026\nhome /Users/maya\n`;
    const { machine } = await machineOf(script => (script === SSH_FACTS_SCRIPT ? { stdout: mac } : {}));
    const facts = await machine.facts!();
    expect(facts.os).toBe("macOS 15.6.1");
    expect(facts.folder).toBe("/Users/maya");
    expect(facts.uptimeMs).toBeGreaterThanOrEqual(7_200_000);
    expect(facts.uptimeMs).toBeLessThan(7_205_000);
  });

  it("says why the rows sit at pending once for a machine, and again only when the machine says something else", async () => {
    let stderr = "ssh: connect to host 10.0.0.5 port 2222: Connection refused\n";
    const { machine } = await machineOf(script => (script === SSH_FACTS_SCRIPT ? { exitCode: 255, stderr } : {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The caller shows pending and swallows the refusal, so a read that fails every 15 seconds would otherwise
      // say nothing anywhere; it says it here, and not four times an hour.
      for (let i = 0; i < 3; i++) await machine.facts!().catch(() => {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("Connection refused");
      stderr = "ssh: Permission denied (publickey).\n";
      await machine.facts!().catch(() => {});
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]![0]).toContain("Permission denied");
    } finally {
      warn.mockRestore();
    }
  });

  it("a machine that did not answer leaves the rows waiting rather than showing this computer's own answers for it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { machine } = await machineOf(script =>
        script === SSH_FACTS_SCRIPT ? { exitCode: 255, stderr: "debug1: Connecting to 10.0.0.5\nssh: connect to host 10.0.0.5 port 2222: Connection refused\n" } : {},
      );
      const refused = await machine.facts!().then(() => "", (e: unknown) => (e as Error).message);
      expect(refused).toContain("Connection refused");
      expect(refused).not.toContain("debug1:");
      // A machine that answered the dial but not the lines is the same: no name of this computer's stands in for it.
      const { machine: quiet } = await machineOf(() => ({ stdout: "\n" }));
      await expect(quiet.facts!()).rejects.toThrow("did not say what it is over ssh");
    } finally {
      warn.mockRestore();
    }
  });
});
