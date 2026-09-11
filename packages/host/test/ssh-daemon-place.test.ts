// SPDX-License-Identifier: AGPL-3.0-only
// Where a daemon lives on a machine, one value per kind. A fork's place must
// spell the script it always did, byte for byte, since the golden's content
// sha pins it and any drift rebuilds every golden on the account; a machine
// somebody owns must spell one that needs no root and touches nothing of
// theirs outside one folder under their home.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NO_BUILD_TOOLS_LINE, sshDaemonPaths } from "@wsp/protocol";
import { CLOUD_PLACE, DAEMON_GONE_LINE, DAEMON_UNIT, daemonUnit, deployScript, removeDaemonScript, sshDaemonPlace, stageDaemonBundle, startMjs, stopDaemonScript } from "../src/doctor.js";

const LOGIN = { home: "/home/maya", path: "/usr/local/bin:/usr/bin:/bin" };
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

describe("the place a machine reached over ssh keeps its daemon", () => {
  it("puts every path under the login's own home and nothing under /root", () => {
    const at = sshDaemonPaths(LOGIN.home);
    const s = script();
    expect(s).toContain(`mkdir -p ${at.dir} ${at.inbox} ${at.binDir} ${at.nodeDir} ${at.unitDir}`);
    expect(s).toContain(`tar -xzf ${at.bundle} -C ${at.dir}`);
    expect(s).toContain(`mv -f ${at.tokenPath}.next ${at.tokenPath}`);
    expect(s).toContain(`install -m 0755 ${at.dir}/wsp-open ${at.binDir}/wsp-open`);
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
    expect(s).toContain(`cat > /home/maya/.config/systemd/user/${DAEMON_UNIT} <<'WSP_UNIT'`);
    for (const verb of ["daemon-reload", `enable ${DAEMON_UNIT}`, `restart ${DAEMON_UNIT}`]) expect(s).toContain(`systemctl --user ${verb}`);
    expect(s).toContain(`journalctl --user -u ${DAEMON_UNIT}`);
    expect(daemonUnit(sshDaemonPlace(LOGIN))).toContain("WantedBy=default.target");
    expect(daemonUnit(sshDaemonPlace(LOGIN))).toContain("Environment=HOME=/home/maya");
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
    expect(s.indexOf("rm -f /home/maya/.wsp/daemon.port")).toBeLessThan(s.indexOf(`systemctl --user restart ${DAEMON_UNIT}`));
    expect(s).toContain("for _ in $(seq 80); do [ -s /home/maya/.wsp/daemon.port ] && break; sleep 0.25; done");
    // iproute2 is on a guest wsp built and on nothing else in particular, so the port file and the supervisor
    // are what say the daemon is up.
    expect(stopDaemonScript(sshDaemonPlace(LOGIN))).not.toContain("ss -");
    expect(s).toContain(`systemctl --user is-active --quiet ${DAEMON_UNIT} && echo "DAEMON_PORT $p"`);
  });

  it("refuses a machine with no compiler before it installs anything, since node-pty ships no Linux prebuild", () => {
    const s = script();
    // The sentence rides the script quoted, so what is looked for is the clause a shell quote leaves alone.
    const said = NO_BUILD_TOOLS_LINE.slice(0, NO_BUILD_TOOLS_LINE.indexOf(","));
    const lines = s.split("\n");
    const refusal = lines.find(l => l.includes(said));
    expect(refusal).toContain("for t in cc make python3");
    // It ends the deploy itself. A guard written as `|| { ...; false; }` does not: bash ignores set -e inside a
    // compound command that is part of an || list, so the script runs on (measured 2026-09-11 on bash 5.2).
    expect(refusal).toContain("exit 1");
    expect(lines.findIndex(l => l.includes(said))).toBeLessThan(lines.findIndex(l => l.startsWith("mkdir -p")));
  });

  it("takes the machine's own node when it is new enough and installs one under the home when it is not", () => {
    const s = script();
    expect(s).toContain(`|| [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]`);
    expect(s).toContain("-C /home/maya/.wsp/node --strip-components=1");
    expect(s).toContain('case "$(command -v node)" in /home/maya/.wsp/node/bin/node) export npm_config_nodedir=/home/maya/.wsp/node ;; esac');
    // Its bin goes first on the deploy's PATH and on the unit's, so the node installed is the node that runs.
    expect(s).toContain('export PATH="/home/maya/.wsp/node/bin:/home/maya/.local/bin:$PATH"');
    expect(daemonUnit(sshDaemonPlace(LOGIN))).toContain("Environment=PATH=/home/maya/.wsp/node/bin:/home/maya/.local/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("adds its BROWSER line to the person's own login file once, behind its own name", () => {
    const s = script();
    expect(s).toContain("printf 'export BROWSER=%s\\nunset DISPLAY\\n' /home/maya/.local/bin/wsp-open > /home/maya/.wsp/profile.sh");
    // Their .profile is theirs: the line is added only when it is not there, so a second deploy adds nothing.
    expect(s).toContain("grep -q '/home/maya/.wsp/profile.sh' /home/maya/.profile 2>/dev/null || printf '. %s\\n' /home/maya/.wsp/profile.sh >> /home/maya/.profile");
  });

  it("takes everything it put on the machine off again, so nothing of wsp's outlives the record", () => {
    const at = sshDaemonPaths(LOGIN.home);
    const off = removeDaemonScript(sshDaemonPlace(LOGIN));
    expect(off).toContain(`systemctl --user disable --now ${DAEMON_UNIT}`);
    expect(off).toContain(`rm -f ${at.unitDir}/${DAEMON_UNIT}`);
    for (const path of [at.dir, at.bundle, at.inbox, at.tokenPath, at.rootsPath, at.nodeDir, at.profileFile, at.openSocket, at.portFile, at.runDir, `${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`]) {
      expect(off, path).toContain(path);
    }
    // The one line wsp added to their own login file goes too: left behind it would print an error at every
    // login for a file that is no longer there.
    expect(off).toContain(`grep -vF '. ${at.profileFile}' /home/maya/.profile`);
    // The working copy goes whether the rewrite landed or not: a read that failed must not leave them an empty
    // login file, and must not leave a file of wsp's beside their own either.
    expect(off).toContain("rm -f /home/maya/.profile.wsp-out");
    expect(off).toContain(`echo ${DAEMON_GONE_LINE}`);
    // Only what wsp put there, each path named. Their home, their bin folder and their login file stay, and so
    // does wsp's own folder itself: another road of wsp keeps things beside the daemon in it, and a machine on
    // this test's own box once held one builder's file there while another's record was being deleted.
    expect(off).not.toMatch(/rm -rf [^\n]*\/home\/maya(\s|$)/);
    expect(off).not.toMatch(new RegExp(`rm -rf [^\n]*${at.wsp}(\\s|$)`));
    expect(off).not.toContain(`rm -rf ${at.binDir}`);
    expect(off).not.toMatch(/rm -[rf]+ [^\n]*\/home\/maya\/\.profile(\s|$)/);
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
      expect(readFileSync(join(stage, "wsp-open"), "utf8")).toContain(`--unix-socket ${at.openSocket}`);
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
