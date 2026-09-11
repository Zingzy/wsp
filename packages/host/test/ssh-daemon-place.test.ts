// SPDX-License-Identifier: AGPL-3.0-only
// Where a daemon lives on a machine, one value per kind. A fork's place must
// spell the script it always did, byte for byte, since the golden's content
// sha pins it and any drift rebuilds every golden on the account; a machine
// somebody owns must spell one that needs no root and touches nothing of
// theirs outside one folder under their home.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { machineLacksLine, machineLacksShort, machineNeverAnswered, NO_BUILD_TOOLS_LINE, NO_LINGER_LINE, sshDaemonPaths } from "@wsp/protocol";
import { putBytesScript } from "@wsp/engine";
import type { Machine } from "@wsp/engine";
import { BOOT_SCRIPT, CLOUD_PLACE, CONTAINER_PLACE, DAEMON_GONE_LINE, daemonLogCommand, guestPlace, SYSTEMD, deployDaemon, PREFLIGHT_OK_LINE, preflightScript, DAEMON_UNIT, daemonUnit, deployScript, removeDaemonScript, sshDaemonPlace, stageDaemonBundle, startMjs, stopDaemonScript } from "../src/doctor.js";

const LOGIN = { home: "/home/maya", path: "/usr/local/bin:/usr/bin:/bin" };

/** A machine that writes nothing and remembers what it was asked to write and run, so a deploy that must put
 * nothing on a machine can be held to it. */
function fakeMachine(over: { preflight?: { exitCode: number; stdout: string; stderr?: string } } = {}): { machine: Machine; wrote: string[]; ran: string[] } {
  const wrote: string[] = [];
  const ran: string[] = [];
  const machine = {
    id: "ssh://maya@box:2222",
    kind: "sandbox" as const,
    putBytes: async (path: string) => void wrote.push(path),
    run: async (script: string) => {
      ran.push(script);
      if (script.includes(PREFLIGHT_OK_LINE) && over.preflight !== undefined) return { stderr: "", ...over.preflight };
      return { exitCode: 0, stdout: script.includes(PREFLIGHT_OK_LINE) ? `${PREFLIGHT_OK_LINE}\n` : "", stderr: "" };
    },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  } as unknown as Machine;
  return { machine, wrote, ran };
}

/** A daemon folder with just enough in it to stage a bundle from. */
function emptyBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-bundle-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
  return dir;
}
const script = (): string => deployScript(sshDaemonPlace(LOGIN), "aabbcc");

describe("the place a fork keeps its daemon", () => {
  it("spells the guest's own layout: /root, a system unit, and the edge-reachable bind", () => {
    const cloud = deployScript(CLOUD_PLACE, "aabbcc");
    expect(cloud).toContain("mkdir -p /root/wsp-daemon /root/inbox");
    expect(cloud).toContain("tar -xzf /root/wsp-daemon.tgz -C /root/wsp-daemon");
    expect(cloud).toContain(`cat > /etc/systemd/system/${DAEMON_UNIT} <<'WSP_UNIT'`);
    expect(cloud).toContain(`systemctl restart ${DAEMON_UNIT}`);
    expect(cloud).not.toContain("systemctl --user");
    expect(startMjs(CLOUD_PLACE)).toContain('host: "0.0.0.0"');
    expect(daemonUnit(CLOUD_PLACE)).toContain("WantedBy=multi-user.target");
    // A fork always carries the base floor's node, so its bootstrap asks only that some node is there.
    expect(cloud).toContain("if ! command -v node >/dev/null 2>&1; then");
    // Nothing is read off the machine before the install: wsp built it and knows what is on it.
    expect(cloud).not.toContain(NO_BUILD_TOOLS_LINE.slice(0, NO_BUILD_TOOLS_LINE.indexOf(",")));
  });
});

describe("what keeps the daemon running is a module, not a question the deploy asks", () => {
  it("registers one module per way and one place per kind, and no line of a script names either", () => {
    // A fork and a machine over ssh are kept up by the same service manager, told a different scope; a container
    // whose only lasting process is its own boot gets the script that loop-restarts the daemon.
    expect(CLOUD_PLACE.supervise).toBe(SYSTEMD);
    expect(sshDaemonPlace(LOGIN).supervise).toBe(SYSTEMD);
    expect(CONTAINER_PLACE.supervise).toBe(BOOT_SCRIPT);
    expect([CLOUD_PLACE.scope, sshDaemonPlace(LOGIN).scope]).toEqual(["system", "user"]);

    // The one place a supervisor id is matched to a place, which is what a machine's own answer picks.
    expect(guestPlace("systemd")).toBe(CLOUD_PLACE);
    expect(guestPlace("entrypoint")).toBe(CONTAINER_PLACE);

    // And nothing a place writes names a supervisor or a kind: the place answers, the script does not ask.
    for (const place of [CLOUD_PLACE, CONTAINER_PLACE, sshDaemonPlace(LOGIN)]) {
      for (const script of [deployScript(place, "aabbcc"), removeDaemonScript(place), preflightScript(place)]) {
        for (const word of ["entrypoint", "systemd ", "supervisor ===", '"cloud"', '"ssh"']) expect(script, word).not.toContain(word);
      }
    }
  });

  it("gives each way its own answer to whether the daemon came up, in words that machine can say", () => {
    // A guest has iproute2; a container image ships neither ss nor curl, so bash's own network road answers.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).toContain("ss -ltnH 'sport = :7070'");
    expect(deployScript(CONTAINER_PLACE, "aabbcc")).toContain("exec 3<>/dev/tcp/127.0.0.1/7070");
    expect(deployScript(CONTAINER_PLACE, "aabbcc")).not.toContain("ss -ltn");
    // A machine somebody owns let its daemon pick the port, so the file it wrote is what says it bound.
    expect(deployScript(sshDaemonPlace(LOGIN), "aabbcc")).toContain("'/home/maya/.wsp/daemon.port'");
    // And each reads the log its own supervision bounds.
    expect(daemonLogCommand(CLOUD_PLACE, 50)).toContain("journalctl -u");
    expect(daemonLogCommand(sshDaemonPlace(LOGIN), 50)).toContain("journalctl --user -u");
    expect(daemonLogCommand(CONTAINER_PLACE, 50)).toContain("tail -n 50");
  });
});

describe("the place a machine reached over ssh keeps its daemon", () => {
  it("puts every path under the login's own home and nothing under /root", () => {
    const at = sshDaemonPaths(LOGIN.home);
    const s = script();
    expect(s).toContain(`mkdir -p '${at.dir}' '${at.inbox}' '${at.binDir}' '${at.nodeDir}' '${at.unitDir}'`);
    expect(s).toContain(`tar -xzf '${at.bundle}' -C '${at.dir}'`);
    // The token is not in this script at all now: it lands over the byte road, which the case below pins.
    expect(s).not.toContain(at.tokenPath);
    expect(s).toContain(`install -m 0755 '${at.dir}/wsp-open' '${at.binDir}/wsp-open'`);
    // The one rule for where these sit is the protocol's, so the deploy that writes them and the runtime that
    // reads the token and the port back cannot spell one path two ways.
    expect(at.tokenPath).toBe("/home/maya/.wsp/daemon-token");
    expect(at.portFile).toBe("/home/maya/.wsp/daemon.port");
    // Nothing on the machine is root's to write: every path the place names sits under the login's own home, and
    // the only file of the person's own touched outside wsp's folder is one line in their .profile.
    const place = sshDaemonPlace(LOGIN);
    const named = [place.dir, place.bundle, place.inbox, place.tokenPath, place.rootsPath, place.root, place.scratch, place.nodeDir, place.binDir, place.openShim, place.openSocket, place.profileFile, place.unitPath, ...place.make];
    expect(named.filter(path => !path.startsWith("/home/maya/") && path !== "/home/maya")).toEqual([]);
    expect(place.profileSource).toBe("/home/maya/.profile");
    expect(s).not.toContain("/root");
    expect(s).not.toContain("/etc/");
    // The person's PATH carries /usr/local/bin and rides the unit, but nothing is installed there or anywhere
    // else this login does not own, and no line asks for another one's rights.
    expect(s.split("\n").filter(line => /(^|[;&|(] *)sudo /.test(line))).toEqual([]);
    expect(s.split("\n").filter(line => /(> *|-C +|install [^\n]* )\/(usr|etc|opt|var)\//.test(line))).toEqual([]);
  });

  it("runs under the login's own systemd, enabled so a reboot brings it back", () => {
    const s = script();
    expect(s).toContain(`cat > '/home/maya/.config/systemd/user/${DAEMON_UNIT}' <<'WSP_UNIT'`);
    for (const verb of ["daemon-reload", `enable ${DAEMON_UNIT}`, `restart ${DAEMON_UNIT}`]) expect(s).toContain(`systemctl --user ${verb}`);
    expect(s).toContain(`journalctl --user -u ${DAEMON_UNIT}`);
    expect(daemonUnit(sshDaemonPlace(LOGIN))).toContain("WantedBy=default.target");
    expect(daemonUnit(sshDaemonPlace(LOGIN))).toContain('Environment="HOME=/home/maya"');
    // A login that arrives with no session bus cannot reach its own systemd at all, so the address is settled
    // before the first systemctl rather than every line failing at the bus.
    const lines = s.split("\n");
    expect(lines.findIndex(l => l.startsWith("export XDG_RUNTIME_DIR="))).toBeLessThan(lines.findIndex(l => l.includes("systemctl --user")));
  });

  it("binds the machine's own loopback on a port it picks, and writes that port down", () => {
    const start = startMjs(sshDaemonPlace(LOGIN));
    expect(start).toContain('host: "127.0.0.1"');
    expect(start).toContain("port: 0");
    expect(start).toContain('kind: "ssh"');
    expect(start).toContain('writeFileSync("/home/maya/.wsp/daemon.port", String(d.port))');
    expect(start).not.toContain("0.0.0.0");
    const s = script();
    // The old port file goes before the restart, so the wait cannot read the port of the daemon just replaced.
    expect(s.indexOf("rm -f '/home/maya/.wsp/daemon.port'")).toBeLessThan(s.indexOf(`systemctl --user restart ${DAEMON_UNIT}`));
    expect(s).toContain("for _ in $(seq 80); do [ -s '/home/maya/.wsp/daemon.port' ] && break; sleep 0.25; done");
    // iproute2 is on a guest wsp built and on nothing else in particular, so the port file and the supervisor
    // are what say the daemon is up.
    expect(stopDaemonScript(sshDaemonPlace(LOGIN))).not.toContain("ss -");
    expect(s).toContain(`systemctl --user is-active --quiet ${DAEMON_UNIT} && echo "DAEMON_PORT $p"`);
  });

  it("refuses a machine with no compiler before it installs anything, since node-pty ships no Linux prebuild", () => {
    const s = preflightScript(sshDaemonPlace(LOGIN));
    // The sentence rides the script quoted, so what is looked for is the clause a shell quote leaves alone.
    const said = NO_BUILD_TOOLS_LINE.slice(0, NO_BUILD_TOOLS_LINE.indexOf(","));
    const lines = s.split("\n");
    const refusal = lines.find(l => l.includes(said));
    expect(refusal).toContain("for t in cc make python3");
    // It ends the deploy itself. A guard written as `|| { ...; false; }` does not: bash ignores set -e inside a
    // compound command that is part of an || list, so the script runs on (measured 2026-09-11 on bash 5.2).
    expect(refusal).toContain("exit 1");
    // Nothing of the install is in this script at all: it is asked on its own, before anything is packed or sent.
    expect(s).not.toContain("mkdir -p");
    expect(s).not.toContain("npm install");
  });

  it("takes the machine's own node when it is new enough and installs one under the home when it is not", () => {
    const s = script();
    expect(s).toContain(`|| [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]`);
    expect(s).toContain("-C '/home/maya/.wsp/node' --strip-components=1");
    expect(s).toContain(`if [ "$(command -v node)" = '/home/maya/.wsp/node/bin/node' ] && grep -qx "#define NODE_MAJOR_VERSION $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" '/home/maya/.wsp/node/include/node/node_version.h' 2>/dev/null; then export npm_config_nodedir='/home/maya/.wsp/node'; fi`);
    // Its bin goes first on the deploy's PATH and on the unit's, so the node installed is the node that runs.
    expect(s).toContain('export PATH="/home/maya/.wsp/node/bin:/home/maya/.local/bin:$PATH"');
    expect(daemonUnit(sshDaemonPlace(LOGIN))).toContain('Environment="PATH=/home/maya/.wsp/node/bin:/home/maya/.local/bin:/usr/local/bin:/usr/bin:/bin"');
  });

  it("adds its BROWSER line to the person's own login file once, behind its own name", () => {
    const s = script();
    expect(s).toContain("printf 'export BROWSER=%s\\nunset DISPLAY\\n' '/home/maya/.local/bin/wsp-open' > '/home/maya/.wsp/profile.sh'");
    // Their .profile is theirs: the line is added only when it is not there, so a second deploy adds nothing.
    expect(s).toContain("grep -q '/home/maya/.wsp/profile.sh' '/home/maya/.profile' 2>/dev/null || printf '. %s\\n' '/home/maya/.wsp/profile.sh' >> '/home/maya/.profile'");
  });

  it("never writes the token into a command, since every account on the machine can read a running one", () => {
    const s = script();
    // /proc/<pid>/cmdline is world readable, and a machine somebody owns may carry other accounts: the token
    // lands over the byte road before this script runs, so the script names the file and never its content.
    expect(s).not.toContain("aabbcc");
    expect(s).not.toContain("WSP_DAEMON_TOKEN");
    // A fork is root's alone and keeps the write in its script, which is what the golden's sha pins.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).toContain("WSP_DAEMON_TOKEN='aabbcc'");
    expect(sshDaemonPlace(LOGIN).tokenRoad).toBe("bytes");
    expect(CLOUD_PLACE.tokenRoad).toBe("script");
    // What that road writes is the writer's alone from the moment it exists.
    expect(putBytesScript("/home/maya/.wsp/daemon-token", 24, "/home/maya/.wsp/t")).toContain("umask 077");
  });

  it("quotes every path it writes, since the home came from the machine and may hold a space", () => {
    const spaced = sshDaemonPlace({ home: "/home/Jane Doe", path: "/usr/bin" });
    const off = removeDaemonScript(spaced);
    // Unquoted, this line is `rm -rf /home/Jane Doe/.wsp/daemon`, which is /home/Jane and a relative path.
    expect(off).toContain("rm -rf '/home/Jane Doe/.wsp/daemon'");
    expect(off).not.toMatch(/rm -[rf]+ [^'\n]*\/home\/Jane Doe/);
    const on = deployScript(spaced, "aabbcc");
    for (const line of [...on.split("\n"), ...off.split("\n")]) {
      // Every naked mention of the home is inside single quotes; the two exceptions are the PATH exports, which
      // are double quoted already, and the unit heredoc, which is systemd's language and quoted below.
      if (!line.includes("/home/Jane Doe")) continue;
      if (line.startsWith("export PATH=") || line.startsWith("WorkingDirectory=")) continue;
      expect(line, line).toMatch(/['"][^'"]*\/home\/Jane Doe/);
    }
    // The unit is systemd's own quoting, and each setting wants its own. WorkingDirectory takes the rest of the
    // line, so a quote there is read as part of the path (measured on systemd 255: "path is not absolute");
    // Environment is split on whitespace, so a value with a space in it is quoted.
    const unit = daemonUnit(spaced);
    expect(unit).toContain("WorkingDirectory=/home/Jane Doe/.wsp/daemon");
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).toContain('Environment="HOME=/home/Jane Doe"');
    expect(unit).toContain(`ExecStart=/bin/sh -c 'exec node "/home/Jane Doe/.wsp/daemon/start.mjs"'`);
    // A fork chose its own paths and its script is pinned byte for byte, so nothing there is quoted.
    expect(CLOUD_PLACE.quotePaths).toBe(false);
    expect(daemonUnit(CLOUD_PLACE)).toContain("WorkingDirectory=/root/wsp-daemon");
  });

  it("asks the machine before a byte of wsp's lands on it, so one that refuses keeps nothing", async () => {
    const place = sshDaemonPlace(LOGIN);
    // The checks are their own command now, not lines inside the deploy: nothing is packed, uploaded or written
    // until the machine has passed them, so a machine that refuses is left exactly as it was found.
    const ask = preflightScript(place);
    expect(ask).toContain("for t in cc make python3");
    expect(ask).toContain("Linger");
    expect(ask.trim().endsWith(PREFLIGHT_OK_LINE)).toBe(true);
    const s = deployScript(place, "aabbcc");
    expect(s).not.toContain("for t in cc make python3");
    expect(s).not.toContain("Linger");

    // A machine that refuses is told what it needs, and had nothing put on it: no write, no run but the ask.
    const refused = fakeMachine({ preflight: { exitCode: 1, stdout: `${NO_BUILD_TOOLS_LINE}\n` } });
    await expect(deployDaemon(refused.machine, { place, daemonDir: emptyBundle() })).rejects.toThrow(NO_BUILD_TOOLS_LINE);
    expect(refused.wrote).toEqual([]);
    expect(refused.ran).toEqual([ask]);

    // A place with nothing to ask does not spend a round trip on it, which is every fork.
    expect(CLOUD_PLACE.preflight).toEqual([]);
    const guest = fakeMachine();
    await deployDaemon(guest.machine, { place: CLOUD_PLACE, daemonDir: emptyBundle() }).catch(() => {});
    expect(guest.ran.some(r => r.includes(PREFLIGHT_OK_LINE))).toBe(false);
  });

  it("marks the machine's own refusal apart from a check that never reached the machine", async () => {
    const place = sshDaemonPlace(LOGIN);
    // The refusing line echoes its sentence and exits 1, so the words are the machine's own and are marked as
    // what it has not got: that is the sentence a row shows.
    const refused = await deployDaemon(fakeMachine({ preflight: { exitCode: 1, stdout: `${NO_BUILD_TOOLS_LINE}\n` } }).machine, { place, daemonDir: emptyBundle() }).catch((e: unknown) => e);
    expect(machineLacksLine(refused)).toBe(NO_BUILD_TOOLS_LINE);
    expect(machineNeverAnswered(refused)).toBe(false);

    // A box that is switched off: nothing ran on it, so ssh answers 255 with its own words on stderr and nothing
    // on stdout. Those words say nothing about what that machine has, so they carry no lack and never reach a row.
    const off = await deployDaemon(fakeMachine({ preflight: { exitCode: 255, stdout: "", stderr: "ssh: connect to host box port 2222: Connection refused\n" } }).machine, { place, daemonDir: emptyBundle() }).catch((e: unknown) => e);
    expect(machineLacksLine(off)).toBeUndefined();
    expect(machineNeverAnswered(off)).toBe(true);
    expect((off as Error).message).toContain("Connection refused");
  });

  it("refuses a login whose services stop with it, naming the one command that turns that off", () => {
    const s = preflightScript(sshDaemonPlace(LOGIN));
    const line = s.split("\n").find(l => l.includes("Linger"));
    expect(line).toContain("loginctl show-user");
    expect(line).toContain("exit 1");
    expect(line).toContain(machineLacksShort(NO_LINGER_LINE));
    expect(NO_LINGER_LINE).toContain("loginctl enable-linger");
    // Asked only where the machine can answer: a machine with no loginctl is not refused for lacking one.
    expect(line).toContain("command -v loginctl");
    // A fork's own systemd is the machine's, so nothing there asks about a login, and its place asks nothing at all.
    expect(preflightScript(CLOUD_PLACE)).not.toContain("Linger");
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("Linger");
  });

  it("takes everything it put on the machine off again, so nothing of wsp's outlives the record", () => {
    const at = sshDaemonPaths(LOGIN.home);
    const off = removeDaemonScript(sshDaemonPlace(LOGIN));
    expect(off).toContain(`systemctl --user disable --now ${DAEMON_UNIT}`);
    expect(off).toContain(`rm -f '${at.unitDir}/${DAEMON_UNIT}'`);
    for (const path of [at.dir, at.bundle, at.inbox, at.tokenPath, at.rootsPath, at.nodeDir, at.profileFile, at.openSocket, at.portFile, at.runDir, `${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`]) {
      expect(off, path).toContain(`'${path}'`);
    }
    // The one line wsp added to their own login file goes too: left behind it would print an error at every
    // login for a file that is no longer there.
    expect(off).toContain(`grep -vF '. ${at.profileFile}' '/home/maya/.profile'`);
    // The working copy goes whether the rewrite landed or not: a read that failed must not leave them an empty
    // login file, and must not leave a file of wsp's beside their own either.
    expect(off).toContain("rm -f '/home/maya/.profile.wsp-out'");
    expect(off).toContain(`echo ${DAEMON_GONE_LINE}`);
    // Only what wsp put there, each path named. Their home, their bin folder and their login file stay, and so
    // does wsp's own folder itself: another road of wsp keeps things beside the daemon in it, and a machine on
    // this test's own box once held one builder's file there while another's record was being deleted.
    expect(off).not.toMatch(/rm -rf [^\n]*\/home\/maya(\s|$)/);
    expect(off).not.toMatch(new RegExp(`rm -rf [^\n]*${at.wsp}(\\s|$)`));
    expect(off).not.toContain(`rm -rf ${at.binDir}`);
    expect(off).not.toMatch(/rm -[rf]+ [^\n]*\/home\/maya\/\.profile(\s|$)/);
  });

  it("leaves a login file it never wrote to byte for byte as it was, symlink and all", async () => {
    // The sweep runs on every machine recorded over ssh now, including one whose deploy never landed, so the
    // removal must not touch a login file wsp put no line in. Run for real: their .profile is a symlink into a
    // dotfiles checkout on many machines, and a rewrite that replaces the file turns it into a plain one.
    const dir = mkdtempSync(join(tmpdir(), "wsp-profile-"));
    try {
      const home = join(dir, "home");
      const dotfiles = join(dir, "dotfiles");
      mkdirSync(home, { recursive: true });
      mkdirSync(dotfiles, { recursive: true });
      const real = join(dotfiles, "profile");
      const theirs = "# mine\nexport EDITOR=vim\n";
      writeFileSync(real, theirs);
      symlinkSync(real, join(home, ".profile"));
      const before = statSync(real);

      await promisify(execFile)("bash", ["-c", removeDaemonScript(sshDaemonPlace({ home, path: "/usr/bin" }))]);

      // Byte for byte, the same inode, and still a symlink.
      expect(readFileSync(real, "utf8")).toBe(theirs);
      expect(statSync(real).ino).toBe(before.ino);
      expect(lstatSync(join(home, ".profile")).isSymbolicLink()).toBe(true);
      expect(existsSync(`${join(home, ".profile")}.wsp-out`)).toBe(false);

      // And with wsp's line in it, the line goes and everything else stays, the symlink and inode with it.
      const at = sshDaemonPaths(home);
      writeFileSync(real, `# mine\n. ${at.profileFile}\nexport EDITOR=vim\n`);
      const kept = statSync(real).ino;
      await promisify(execFile)("bash", ["-c", removeDaemonScript(sshDaemonPlace({ home, path: "/usr/bin" }))]);
      expect(readFileSync(real, "utf8")).toBe(theirs);
      expect(statSync(real).ino).toBe(kept);
      expect(lstatSync(join(home, ".profile")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages a bundle whose start script and browser shim are that machine's own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-ssh-stage-"));
    try {
      const daemonDir = join(dir, "daemon");
      mkdirSync(join(daemonDir, "dist"), { recursive: true });
      writeFileSync(join(daemonDir, "package.json"), JSON.stringify({ dependencies: { ws: "^8" } }));
      // A stand-in daemon that reports what start.mjs asked of it, so the options the machine gets are read and
      // not only the text of the file.
      writeFileSync(join(daemonDir, "dist", "index.js"), 'export const OPEN_SOCKET_PATH = "/root/.wsp/open.sock";\nexport async function startDaemon(o) { console.log(JSON.stringify(o)); return { port: 41234 }; }\n');
      // Run under a home on this computer, so the start script's own writes land somewhere this test owns.
      const home = join(dir, "home");
      const at = sshDaemonPaths(home);
      mkdirSync(at.wsp, { recursive: true });
      const stage = join(dir, "stage");
      await stageDaemonBundle(stage, sshDaemonPlace({ home, path: LOGIN.path }), daemonDir);
      expect(readFileSync(join(stage, "wsp-open"), "utf8")).toContain(`--unix-socket '${at.openSocket}'`);
      const { stdout } = await promisify(execFile)(process.execPath, [join(stage, "start.mjs")], { env: { PATH: process.env["PATH"] ?? "", HOME: home } });
      expect(JSON.parse(stdout.split("\n")[0]!)).toEqual({
        host: "127.0.0.1",
        port: 0,
        kind: "ssh",
        root: home,
        rootsPath: at.rootsPath,
        tokenPath: at.tokenPath,
        inboxDir: at.inbox,
        manifest: { path: at.manifestPath },
        openSocketPath: at.openSocket,
      });
      expect(stdout).toContain("wsp-daemon listening on 127.0.0.1:41234");
      // The port it bound is written where the host reads it: the one thing the host cannot know beforehand.
      expect(readFileSync(at.portFile, "utf8")).toBe("41234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
