// SPDX-License-Identifier: AGPL-3.0-only
// Root over a login that is not root. Every script the ssh client carries runs
// as root: as the login where it is root, else under sudo, told never to ask,
// or told to read the one password line the client puts ahead of the script's
// own input. The read of which road a login has runs as the login itself.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";
import { SSH_SUDO_READ, SSH_SUDO_TRY, SshBackend, readSshSudo, sshArgs, sshClient, sshDial, trySshSudo, type SshReach, type SshTransport } from "../src/index.js";

const REACH: SshReach = { user: "maya", host: "box", port: 2222 };

let dir: string;
let saved: { PATH?: string; HOME?: string };

/** A folder of stand-ins put first on PATH: an ssh that runs what follows the login here, as sshd hands it to a
 * shell; an id that answers the login's uid; and a sudo that writes down how it was asked and the line it read
 * where it was told to read one, then runs the command. */
function stubs(uid: number, sudo: "runs" | "refuses" | "absent" | "wants-tty" | "mixed" = "runs"): void {
  const put = (name: string, body: string): void => void writeStub(join(dir, name), `#!/bin/sh\n${body}\n`);
  put("ssh", 'while [ $# -gt 0 ]; do case "$1" in *@*) shift; break ;; esac; shift; done\nexec /bin/sh -c "$*"');
  put("id", `[ "$1" = -u ] && echo ${uid} || /usr/bin/id "$@"`);
  if (sudo === "absent") return rmSync(join(dir, "sudo"), { force: true });
  put(
    "sudo",
    [
      `printf '%s\\n' "$*" > ${dir}/sudo-args`,
      ...(sudo === "refuses" ? ["echo 'sudo: a password is required' >&2", "exit 1"] : []),
      ...(sudo === "wants-tty" ? ["echo 'sudo: sorry, you must have a tty to run sudo' >&2", "exit 1"] : []),
      // One NOPASSWD entry among password ones: the list passes, the validate wants the password.
      ...(sudo === "mixed" ? [`case "$*" in "-n -v") echo 'sudo: a password is required' >&2; exit 1 ;; "-n -l bash -c true") echo /usr/bin/bash; exit 0 ;; esac`] : []),
      `case "$1" in -S) IFS= read -r line; printf '%s' "$line" > ${dir}/sudo-read ;; esac`,
      'while [ $# -gt 0 ] && [ "$1" != bash ]; do shift; done',
      'exec "$@"',
    ].join("\n"),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-ssh-sudo-"));
  saved = { PATH: process.env["PATH"], HOME: process.env["HOME"] };
  process.env["PATH"] = `${dir}:${saved.PATH ?? ""}`;
  // The client makes its master socket folder under the home; this one is the test's own.
  process.env["HOME"] = dir;
});

afterEach(() => {
  process.env["PATH"] = saved.PATH;
  process.env["HOME"] = saved.HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("a script over ssh runs as root", () => {
  it("as it is on a root login, with sudo never asked", async () => {
    stubs(0);
    const said = await sshClient(REACH, "echo \"it's $((1 + 1))\"", {});
    expect(said).toMatchObject({ exitCode: 0, stdout: "it's 2\n" });
    expect(() => readFileSync(join(dir, "sudo-args"))).toThrow();
  });

  it("under sudo -n on a login that is not root, sudo's own marks dropped and the script quoted once", async () => {
    stubs(1000);
    process.env["SUDO_USER"] = "maya";
    try {
      const said = await sshClient(REACH, "echo \"[$SUDO_USER] it's $((1 + 1))\"", {});
      expect(said).toMatchObject({ exitCode: 0, stdout: "[] it's 2\n" });
    } finally {
      delete process.env["SUDO_USER"];
    }
    expect(readFileSync(join(dir, "sudo-args"), "utf8")).toMatch(/^-n bash -c /);
  });

  it("with a password, sudo reads the one line ahead of the script's input and the script reads its own bytes whole", async () => {
    stubs(1000);
    const bytes = Buffer.from("line one\nline two, no newline at the end");
    const said = await sshClient(REACH, `cat > ${dir}/landed; echo done`, { sudoPassword: "Tq not-a-real pw!", stdin: bytes });
    expect(said).toMatchObject({ exitCode: 0, stdout: "done\n" });
    expect(readFileSync(join(dir, "sudo-read"), "utf8")).toBe("Tq not-a-real pw!");
    expect(readFileSync(join(dir, "landed"))).toEqual(bytes);
    // Told to read the password off its input, to say nothing as it asks, and to ask again whatever it cached, so
    // the line is always sudo's.
    expect(readFileSync(join(dir, "sudo-args"), "utf8")).toMatch(/^-S -k -p {2}bash -c /);
  });

  it("a password never rides the command line", () => {
    const args = sshArgs(REACH, "true", { as: "root-by-password", stdin: true });
    expect(args.join(" ")).not.toContain("Tq");
    expect(args).not.toContain("-n");
  });

  it("as the login itself for the reads that ask about the login, and for the dial that only proves it stands", async () => {
    stubs(1000, "refuses");
    expect(await sshClient(REACH, "id -u", { asLogin: true })).toMatchObject({ exitCode: 0, stdout: "1000\n" });
    await sshDial(REACH);
    expect(() => readFileSync(join(dir, "sudo-args"))).toThrow();
    expect(sshArgs(REACH, "id -u", { as: "login" }).slice(-3)).toEqual(["bash", "-c", "'id -u'"]);
  });

  it("stops with sudo's own line on a login whose sudo asks, rather than running as the login", async () => {
    stubs(1000, "refuses");
    const said = await sshClient(REACH, "echo ran", {});
    expect(said.exitCode).toBe(1);
    expect(said.stdout).toBe("");
    expect(said.stderr).toContain("a password is required");
  });
});

describe("which road to root a login has", () => {
  /** The read run by a shell here against the stand-ins, with PATH holding nothing else where sudo is absent. */
  const read = (uid: number, sudo: "runs" | "refuses" | "absent" | "wants-tty" | "mixed"): string => {
    stubs(uid, sudo);
    const ran = spawnSync("/bin/sh", ["-c", SSH_SUDO_READ], { encoding: "utf8", env: { PATH: sudo === "absent" ? dir : `${dir}:/usr/bin:/bin` } });
    return ran.stdout.trim();
  };

  it("reads root, a sudo that asks for nothing, one that asks, one that wants a terminal, and none", () => {
    expect(read(0, "refuses")).toBe("WSP_SUDO root");
    expect(read(1000, "runs")).toBe("WSP_SUDO free");
    // A list of the command, never the command: the read runs before the box's key is compared and opens no
    // session as root.
    expect(readFileSync(join(dir, "sudo-args"), "utf8")).toBe("-n -l bash -c true\n");
    expect(read(1000, "refuses")).toBe("WSP_SUDO asks");
    // A sudoers that mixes one NOPASSWD command with password ones lists bash without a password and validates
    // only with one: it asks, since every script after the read is refused under sudo -n.
    expect(read(1000, "mixed")).toBe("WSP_SUDO asks");
    // Defaults requiretty: sudo -n says so in its own line before any password is in play.
    expect(read(1000, "wants-tty")).toBe("WSP_SUDO tty");
    expect(read(1000, "absent")).toBe("WSP_SUDO none");
  });

  /** A transport that answers the read with `road` and the try of a password the way sudo would. */
  function box(road: string, tried: { stdout?: string; stderr?: string } = {}) {
    const asked: { script: string; opts: Parameters<SshTransport>[2] }[] = [];
    const transport: SshTransport = async (_reach, script, opts) => {
      asked.push({ script, opts });
      if (script === SSH_SUDO_READ) return { exitCode: 0, stdout: `WSP_SUDO ${road}\n`, stderr: "" };
      return { exitCode: tried.stdout === undefined ? 1 : 0, stdout: tried.stdout ?? "", stderr: tried.stderr ?? "" };
    };
    return { transport, asked };
  }

  it("reads the road as the login with nothing of the person's, and tries a password as its own one input line", async () => {
    const taken = box("asks", { stdout: "WSP_SUDO taken\n" });
    expect(await readSshSudo(REACH, taken.transport)).toBe("asks");
    expect(taken.asked).toEqual([{ script: SSH_SUDO_READ, opts: { timeoutMs: expect.any(Number), asLogin: true } }]);
    expect(await trySshSudo(REACH, "pw one", taken.transport)).toBe("taken");
    expect(taken.asked[1]!.script).toBe(SSH_SUDO_TRY);
    expect(taken.asked[1]!.opts.asLogin).toBe(true);
    expect(Buffer.from(taken.asked[1]!.opts.stdin!).toString()).toBe("pw one\n");
    expect(SSH_SUDO_TRY).not.toContain("pw one");

    expect(await trySshSudo(REACH, "pw", box("asks", { stderr: "Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n" }).transport)).toBe("wrong");
    expect(await trySshSudo(REACH, "pw", box("asks", { stderr: "maya is not in the sudoers file.\n" }).transport)).toBe("none");
    expect(await trySshSudo(REACH, "pw", box("asks", { stderr: "sudo: sorry, you must have a tty to run sudo\n" }).transport)).toBe("tty");
    for (const road of ["root", "free", "tty", "none"]) expect(await readSshSudo(REACH, box(road).transport)).toBe(road);
  });

  it("says ssh's own line where the login does not stand", async () => {
    const refused: SshTransport = async () => ({ exitCode: 255, stdout: "", stderr: "maya@box: Permission denied (publickey).\n" });
    await expect(readSshSudo(REACH, refused)).rejects.toThrow("Permission denied (publickey).");
  });

  it("a backend riding a password hands it to every script it carries, and the machine it adopts keeps riding it", async () => {
    const asked: Parameters<SshTransport>[2][] = [];
    const transport: SshTransport = async (_reach, _script, opts) => {
      asked.push(opts);
      return { exitCode: 0, stdout: "home /root\n", stderr: "" };
    };
    const base = new SshBackend({ transport, hostKey: async () => undefined });
    const { machine } = await base.riding({ sudoPassword: "pw" }).adopt(REACH);
    await machine.run("true", { deadlineMs: 1000 });
    expect(asked.map(o => o.sudoPassword)).toEqual(["pw", "pw"]);
    // The backend it came from carries none, and a read as the login through the riding one carries none either.
    await base.adopt(REACH);
    expect(asked.at(-1)!.sudoPassword).toBeUndefined();
    await base.riding({ sudoPassword: "pw" }).sudoFor(REACH).catch(() => undefined);
    expect(asked.at(-1)).toMatchObject({ asLogin: true });
    expect(asked.at(-1)!.sudoPassword).toBeUndefined();
  });

  it("puts the password ahead of the script's input only on the road that runs it under sudo", async () => {
    stubs(1000, "refuses");
    // The type has no room for a read as the login that carries a password; a caller that forces one is still read
    // as the login and its input carries nothing of the password.
    // @ts-expect-error asLogin with a password is refused by the option type
    const said = await sshClient(REACH, "cat; echo end", { asLogin: true, sudoPassword: "Tq-pw", stdin: Buffer.from("own\n") });
    expect(said).toMatchObject({ exitCode: 0, stdout: "own\nend\n" });
  });
});
