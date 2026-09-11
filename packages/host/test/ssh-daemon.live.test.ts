// SPDX-License-Identifier: AGPL-3.0-only
// The whole road against a real Linux machine the person reaches over ssh:
// record it, put the daemon on it under its own login, dial that daemon
// through the forward, look at its files, open a shell on it, land a folder,
// and take everything off again. Gated on WSP_SSH_LIVE=1 with the dial named
// in the environment, so nothing here runs in an ordinary gate.
//
//   WSP_SSH_LIVE=1 WSP_SSH_ADDRESS=maya@127.0.0.1 WSP_SSH_PORT=2222 \
//   WSP_SSH_KEY=/path/to/id_ed25519 pnpm exec vitest run packages/host/test/ssh-daemon.live.test.ts
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SshBackend, parseSshAddress, type Machine } from "@wsp/engine";
import { sshDaemonPaths } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { sshWiring } from "../src/cli.js";
import { connectDaemonSocket } from "../src/doctor.js";
import { projectBundler } from "../src/project-bundle.js";

const LIVE = process.env["WSP_SSH_LIVE"] === "1";
const ADDRESS = process.env["WSP_SSH_ADDRESS"] ?? "";
const ASKED = {
  ...(process.env["WSP_SSH_PORT"] !== undefined ? { port: Number(process.env["WSP_SSH_PORT"]) } : {}),
  ...(process.env["WSP_SSH_KEY"] !== undefined ? { keyPath: process.env["WSP_SSH_KEY"] } : {}),
};

/** Everything this run put on the machine, taken off at the end whether it passed or not: the machine is
 * somebody's own and nothing of wsp's may be left standing on it. */
const TEARDOWN = (home: string): string => {
  const at = sshDaemonPaths(home);
  return [
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    "systemctl --user disable --now wsp-daemon.service 2>/dev/null || true",
    `rm -f ${at.unitDir}/wsp-daemon.service`,
    "systemctl --user daemon-reload 2>/dev/null || true",
    `rm -rf ${at.wsp} ${at.binDir}/wsp-open ${at.binDir}/xdg-open`,
    "echo TORN_DOWN",
  ].join("\n");
};

describe.runIf(LIVE && ADDRESS !== "")("a machine reached over ssh, end to end (live)", () => {
  let rt: Runtime | undefined;
  let machine: Machine | undefined;
  let home = "";
  const folder = mkdtempSync(join(tmpdir(), "wsp-ssh-live-"));

  afterAll(async () => {
    if (machine !== undefined && home !== "") await machine.run(TEARDOWN(home), { deadlineMs: 60_000 }).catch(() => {});
    await rt?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it(
    "records the machine, puts a daemon under its own login, and serves its files and a shell through the forward",
    { timeout: 600_000 },
    async () => {
      // A backend of this test's own, for the teardown above and to leave the machine as it was found.
      const reach = parseSshAddress(ADDRESS, ASKED);
      machine = await new SshBackend().get(`ssh://${encodeURIComponent(reach.user)}@${reach.host}:${reach.port}${reach.keyPath === undefined ? "" : `?key=${reach.keyPath}`}`);
      const read = await machine.exec("printf %s \"$HOME\"", { timeoutMs: 30_000 });
      expect(read.exitCode).toBe(0);
      home = read.stdout.trim();
      await machine.run(TEARDOWN(home), { deadlineMs: 60_000 });

      rt = createRuntime({ backend: new SshBackend(), store: memoryStore(), adapters: {}, ssh: sshWiring() });
      const ws = await rt.workspaces.createSsh(ADDRESS, ASKED);
      expect(ws.kind).toBe("ssh");
      expect(ws.notice ?? "").not.toContain("wsp workspaces daemon update");

      // Nothing on the machine listens past its own loopback: the daemon's port is bound on 127.0.0.1 there.
      const at = sshDaemonPaths(home);
      const bound = await machine.exec(`cat ${at.portFile}`, { timeoutMs: 30_000 });
      const port = Number(bound.stdout.trim());
      expect(port).toBeGreaterThan(0);
      const listening = await machine.exec(`ss -ltnH 2>/dev/null | grep ":${port}" || true`, { timeoutMs: 30_000 });
      if (listening.stdout.trim() !== "") expect(listening.stdout).toContain(`127.0.0.1:${port}`);

      // The road the panes take: a port on this computer carried over ssh to that one.
      const road = await rt.workspaces.daemonReach(ws.id);
      expect(road.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(new URL(road.url).port).not.toBe(String(port));
      expect(road.daemonToken).toBeTruthy();

      const sock = await connectDaemonSocket({ url: road.url, token: road.daemonToken! });
      try {
        // Files: its own home, browsed through the daemon on it.
        const listed = (await sock.op("fs.list", { path: home })) as { entries?: { name: string }[] };
        expect(Array.isArray(listed["entries"])).toBe(true);
        expect(listed.entries!.some(e => e.name === ".wsp")).toBe(true);

        // A shell on the machine, through the same daemon.
        const mark = `wsp-live-${randomBytes(4).toString("hex")}`;
        const pty = (await sock.op("pty.create", { cols: 80, rows: 24 })) as { ptyId?: string };
        expect(pty.ptyId).toBeTruthy();
        await sock.op("pty.write", { ptyId: pty.ptyId, data: `echo ${mark}-$(id -un)\r` });
        await new Promise(r => setTimeout(r, 2_000));
        await sock.op("pty.kill", { ptyId: pty.ptyId });

        // Load and processes, which this kind reads off that machine's own /proc.
        expect(await sock.op("proc.watch")).toBeTruthy();
      } finally {
        sock.close();
      }

      // A folder from this computer, landed on the machine over the connection that carries its commands.
      writeFileSync(join(folder, "hello.txt"), "from the Mac\n");
      mkdirSync(join(folder, "sub"), { recursive: true });
      writeFileSync(join(folder, "sub", "two.txt"), "two\n");
      const dest = `${home}/wsp-live-import`;
      await machine.exec(`rm -rf ${dest}`, { timeoutMs: 30_000 });
      const landed = await rt.projects.import({ workspaceId: ws.id, source: folder, dest, bundler: projectBundler(folder, {}) });
      expect(landed.dest).toBe(dest);
      const there = await machine.exec(`cat ${dest}/hello.txt; cat ${dest}/sub/two.txt`, { timeoutMs: 30_000 });
      expect(there.stdout).toContain("from the Mac");
      expect(there.stdout).toContain("two");
      await machine.exec(`rm -rf ${dest}`, { timeoutMs: 30_000 });

      // Deleting the workspace drops the record, the forward and the daemon: the machine itself is left running
      // and carries nothing of wsp's, which is how wsp found it.
      await rt.workspaces.delete(ws.id);
      expect(await rt.workspaces.list()).toEqual([]);
      const unit = await machine.exec("systemctl --user is-active wsp-daemon.service 2>&1 || true", { timeoutMs: 30_000 });
      expect(unit.stdout.trim()).not.toBe("active");
      const left = await machine.exec(`ls -d ${at.dir} ${at.runDir} ${at.unitDir}/wsp-daemon.service 2>&1 | grep -c "No such file" || true`, { timeoutMs: 30_000 });
      expect(left.stdout.trim()).toBe("3");
      // The line wsp added to their own login file goes with it, so no login prints an error for a missing file.
      const profile = await machine.exec(`grep -F ${JSON.stringify(`. ${at.profileFile}`)} ${home}/.profile 2>/dev/null | wc -l | tr -d " "`, { timeoutMs: 30_000 });
      expect(profile.stdout.trim()).toBe("0");
    },
  );
});
