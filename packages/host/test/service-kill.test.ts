// SPDX-License-Identifier: AGPL-3.0-only
// The host's systemd unit against the real systemd: a process that leads a
// session of its own, as every turn does, is still running after the unit is
// stopped. Runs where systemd-run can start a transient unit, skipped elsewhere.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pidAlive } from "../src/host-lock.js";
import { SERVICE_MANAGERS, type ServiceAddress } from "../src/service.js";

/** The systemd this login can start a transient unit in: the machine's own for root, the login's otherwise. */
function systemdHere(): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  for (const scope of [[], ["--user"]]) {
    if (spawnSync("systemd-run", [...scope, "--quiet", "--collect", "--wait", "/bin/true"], { stdio: "ignore", timeout: 10_000 }).status === 0) return scope;
  }
  return undefined;
}
const scope = systemdHere();

const at: ServiceAddress = { statePath: "/tmp/wsp-kill/state.json", home: "/tmp/wsp-kill", uid: process.getuid?.() ?? 0 };

/** The lines of the host's unit that decide what a stop kills, as systemd-run properties. */
const killLines = (): string[] =>
  SERVICE_MANAGERS.systemd
    .text({ ...at, argv: ["/bin/true"], cwd: "/", env: {}, logPath: "/dev/null" })
    .split("\n")
    .filter(line => line.startsWith("Kill"))
    .flatMap(line => ["-p", line]);

describe.skipIf(scope === undefined)("the host's systemd unit under the real systemd", () => {
  const unit = `wsp-kill-test-${process.pid}`;
  let dir: string;
  let turn: number | undefined;
  afterEach(() => {
    spawnSync("systemctl", [...scope!, "stop", unit], { stdio: "ignore" });
    if (turn !== undefined && pidAlive(turn)) process.kill(turn, "SIGKILL");
    turn = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a stop leaves a process that leads its own session running, so the next host can re-open the turn", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-kill-"));
    const pidFile = join(dir, "turn.pid");
    // A file rather than -c: systemd expands $ in a unit's command line, and the turn's pid is the shell's own $$.
    const script = join(dir, "unit.sh");
    writeFileSync(script, `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 300' &\nexec sleep 300\n`);
    const started = spawnSync("systemd-run", [...scope!, "--quiet", "--collect", `--unit=${unit}`, ...killLines(), "/bin/sh", script], { encoding: "utf8" });
    expect(started.status, started.stderr).toBe(0);
    for (let tries = 0; !existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === ""; tries++) {
      expect(tries).toBeLessThan(100);
      await new Promise(r => setTimeout(r, 50));
    }
    turn = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(turn)).toBe(true);
    expect(spawnSync("systemctl", [...scope!, "stop", unit]).status).toBe(0);
    await new Promise(r => setTimeout(r, 300));
    expect(pidAlive(turn)).toBe(true);
  });
});
