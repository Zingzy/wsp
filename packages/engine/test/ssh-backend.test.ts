// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ExecResult, Machine } from "../src/machine.js";
import { SSH_READ_SCRIPT, SshBackend, parseSshAddress, parseSshMachineId, hostKeyOf, sshArgs, sshIdentity, sshMachineId, sshMachineName, sshReachOf, type SshReach, type SshTransport } from "../src/ssh-backend.js";

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
      ramPreservingPause: false,
      resize: false,
      previewUrls: false,
      signedUrls: false,
      containers: false,
      callbackRelay: false,
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
    await expect(machine.snapshot("x")).rejects.toThrow("cannot be snapshotted");
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
