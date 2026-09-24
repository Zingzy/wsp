// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noHomeRefusal, noRunuserRefusal } from "@wsp/protocol";
import { symlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecResult, Machine } from "../src/machine.js";
import { asLogin, landAsLogin, targetLogin, type TargetLogin } from "../src/target-line.js";

/** A computer's road that answers the probe with the lines given and records every command. */
function probed(lines: string[]): { machine: Pick<Machine, "exec">; ran: string[] } {
  const ran: string[] = [];
  return { ran, machine: { exec: async cmd => (ran.push(cmd), { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" }) } };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the line a computer runs as its login", () => {
  it("a root daemon hands every line to the owner of the home, never to root, with the home and PATH the computer reported", async () => {
    const { machine, ran } = probed(["Linux", "0", "root", "ada", "1", "/root", "/usr/bin:/bin"]);
    const login = await targetLogin(machine, { HOME: "/home/ada", PATH: "/opt/wsp/bin:/usr/bin" });
    expect(ran[0]).toContain("'/home/ada'");
    expect(login).toEqual({ platform: "linux", home: "/home/ada", path: "/opt/wsp/bin:/usr/bin", user: "ada", runAs: "ada" });
    const line = asLogin(login, "ls ~/.claude/skills");
    expect(line.startsWith("runuser -u 'ada' -- bash -c ")).toBe(true);
    expect(line).not.toMatch(/-u 'root'|-u root/);
    const { runAs: _handed, ...unwrapped } = login;
    expect(asLogin(unwrapped, "true")).toBe(`export HOME='/home/ada' PATH='/opt/wsp/bin:/usr/bin'; cd "$HOME" 2>/dev/null; true`);
  });

  it("a Mac, a login that is not root, and a fork whose home is root's own run the line as it is", async () => {
    const mac = await targetLogin(probed(["Darwin", "0", "root", "ada", "0", "/Users/ada", "/usr/bin"]).machine);
    expect(mac.runAs).toBeUndefined();
    expect(asLogin(mac, "true").startsWith("export HOME='/Users/ada'")).toBe(true);
    expect((await targetLogin(probed(["Linux", "1000", "ada", "ada", "1", "/home/ada", "/usr/bin"]).machine)).runAs).toBeUndefined();
    const fork = await targetLogin(probed(["Linux", "0", "root", "root", "1", "/root", "/usr/bin"]).machine);
    expect(fork).toMatchObject({ user: "root", home: "/root" });
    expect(fork.runAs).toBeUndefined();
  });

  it("refuses to read at all where the road is root, the home is somebody else's and there is no runuser", async () => {
    await expect(targetLogin(probed(["Linux", "0", "root", "ada", "0", "/root", "/usr/bin"]).machine, { HOME: "/home/ada" })).rejects.toThrow(noRunuserRefusal("ada"));
  });

  it("reads the owner of the folder a linked home points at, not of the link, so a link made by one user never names the lines' user", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-login-"));
    dirs.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    // A root daemon on Linux, as the probe asks it; stat is the real one, GNU on Linux and BSD on a Mac.
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Linux\n");
    writeFileSync(join(bin, "id"), '#!/bin/sh\ncase "$1" in -u) echo 0;; -un) echo root;; esac\n');
    for (const f of ["uname", "id"]) chmodSync(join(bin, f), 0o755);
    // The link is this test's own; the folder behind it is root's.
    const home = join(root, "home-link");
    symlinkSync("/", home);
    const machine: Pick<Machine, "exec"> = {
      exec: async cmd => {
        try {
          return { exitCode: 0, stdout: execFileSync("/bin/bash", ["-c", cmd], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }), stderr: "" };
        } catch (e) {
          return { exitCode: 1, stdout: "", stderr: String(e) };
        }
      },
    };
    const login = await targetLogin(machine, { HOME: home });
    expect(login.user).toBe("root");
    expect(login.runAs).toBeUndefined();
  });

  it("refuses where a root road names a home that is not there, rather than running as root", async () => {
    await expect(targetLogin(probed(["Linux", "0", "root", "", "1", "/root", "/usr/bin"]).machine, { HOME: "/home/gone" })).rejects.toThrow(noHomeRefusal("/home/gone"));
    // A login that is not root with no home still runs as itself.
    expect((await targetLogin(probed(["Linux", "1000", "ada", "", "1", "/home/ada", "/usr/bin"]).machine)).user).toBe("ada");
  });

  it("the wrapped line runs in bash as the login's own, quoting and all", () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-login-"));
    dirs.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const home = join(root, "it's home");
    mkdirSync(home);
    // runuser as a script: checks the words it is handed and runs what follows them, as the real one does.
    writeFileSync(join(bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
    chmodSync(join(bin, "runuser"), 0o755);
    const login: TargetLogin = { platform: "linux", home, path: `${bin}:/usr/bin:/bin`, user: "ada", runAs: "ada" };
    const out = execFileSync("/bin/bash", ["-c", asLogin(login, `printf '%s|%s' "$HOME" "$(pwd -P)"`)], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
    const [said, where] = out.split("|");
    expect(said).toBe(home);
    expect(where!.endsWith("it's home")).toBe(true);
  });
});

describe("bytes landed as the login", () => {
  const machineOf = (fail?: string): { machine: Machine; ran: string[]; landed: string[] } => {
    const ran: string[] = [];
    const landed: string[] = [];
    const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
    const machine = {
      id: "box",
      kind: "sandbox",
      exec: async (cmd: string) => (ran.push(cmd), fail !== undefined && cmd.includes(fail) ? { exitCode: 1, stdout: "", stderr: "Permission denied\n" } : ok),
      putBytes: async (path: string) => void landed.push(path),
    } as unknown as Machine;
    return { machine, ran, landed };
  };
  const login: TargetLogin = { platform: "linux", home: "/home/ada", user: "ada", runAs: "ada" };

  it("stages the bytes, writes them as the login where they go, and takes the staging file away", async () => {
    const { machine, ran, landed } = machineOf();
    await landAsLogin(machine, login, "/home/ada/.codex/config.toml", Buffer.from("x"));
    expect(landed).toHaveLength(1);
    const staging = landed[0]!;
    expect(staging.startsWith("/tmp/wsp-land-")).toBe(true);
    expect(ran[0]).toBe(`chmod 0644 '${staging}'`);
    expect(ran[1]!.startsWith("runuser -u 'ada' -- bash -c ")).toBe(true);
    expect(ran[1]).toContain("/home/ada/.codex/config.toml");
    expect(ran.at(-1)).toBe(`rm -f '${staging}'`);
  });

  it("unpacks a folder as the login, and a write the login is refused still takes the staging file away", async () => {
    const { machine, ran } = machineOf();
    await landAsLogin(machine, login, "/home/ada/.agents/skills/pdf", Buffer.from("tgz"), { unpack: true });
    expect(ran[1]).toContain("tar -xzf");
    const refused = machineOf("runuser");
    await expect(landAsLogin(refused.machine, login, "/home/ada/.claude.json", Buffer.from("{}"))).rejects.toThrow(/was not written as ada: Permission denied/);
    expect(refused.ran.at(-1)).toMatch(/^rm -f '\/tmp\/wsp-land-/);
  });

  it("writes a real file through the line it builds, keeping the mode a file there already had", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-land-"));
    dirs.push(root);
    const dest = join(root, "home", ".claude.json");
    mkdirSync(join(root, "home"));
    writeFileSync(dest, "{}");
    chmodSync(dest, 0o600);
    const run = (cmd: string): ExecResult => {
      try {
        return { exitCode: 0, stdout: execFileSync("/bin/bash", ["-c", cmd], { encoding: "utf8" }), stderr: "" };
      } catch (e) {
        return { exitCode: 1, stdout: "", stderr: String(e) };
      }
    };
    const machine = {
      id: "here",
      kind: "sandbox",
      exec: async (cmd: string) => run(cmd),
      putBytes: async (path: string, bytes: Uint8Array) => writeFileSync(path, bytes),
    } as unknown as Machine;
    await landAsLogin(machine, { platform: "darwin", home: join(root, "home"), user: "ada" }, dest, Buffer.from('{"mcpServers":{}}'));
    expect(readFileSync(dest, "utf8")).toBe('{"mcpServers":{}}');
    expect(execFileSync("/bin/bash", ["-c", `ls -l '${dest}'`], { encoding: "utf8" }).startsWith("-rw-------")).toBe(true);
  });
});
