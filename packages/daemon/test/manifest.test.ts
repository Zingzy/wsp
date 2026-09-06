import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProcessManifest } from "../src/manifest.js";

const tmp = mkdtempSync(join(tmpdir(), "wsp-manifest-"));
const pidsToKill: number[] = [];

afterAll(() => {
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("ProcessManifest", () => {
  it("records entries, dedupes on cmd+cwd, and persists to disk", () => {
    const path = join(tmp, "manifest.json");
    const m = new ProcessManifest({ path });
    m.record({ cmd: "pnpm dev", cwd: "/root/app", port: 8080 });
    m.record({ cmd: "node worker.js", cwd: "/root/app" });
    m.record({ cmd: "pnpm dev", cwd: "/root/app", port: 3000 }); // same cmd+cwd: update, not duplicate
    expect(m.entries()).toHaveLength(2);
    expect(m.entries()[0]?.port).toBe(3000);

    const reloaded = new ProcessManifest({ path });
    expect(reloaded.entries()).toHaveLength(2);
    expect(reloaded.entries().map(e => e.cmd)).toEqual(["pnpm dev", "node worker.js"]);
  });

  it("generates a restart script with a listen guard for port entries", () => {
    const m = new ProcessManifest();
    m.record({ cmd: "pnpm dev", cwd: "/root/app", port: 8080 });
    const script = m.toRestartScript();
    expect(script).toContain("port_listening '1F90'"); // 8080 in the /proc/net/tcp hex form
    expect(script).toContain('":$1 [0-9A-F]+:[0-9A-F]+ 0A "'); // LISTEN-state grep over /proc/net/tcp
    expect(script).toContain("cd '/root/app'");
    expect(script).toContain("pnpm dev");
  });

  it("restart script is idempotent: a second run does not double-start", () => {
    const runDir = join(tmp, "run");
    const marker = join(tmp, "marker.txt");
    const m = new ProcessManifest({ runDir, logDir: join(tmp, "logs") });
    m.record({ cmd: `echo started >> '${marker}' && sleep 30`, cwd: tmp });
    const scriptPath = join(tmp, "restart.sh");
    writeFileSync(scriptPath, m.toRestartScript());

    execFileSync("bash", [scriptPath]);
    execFileSync("bash", [scriptPath]);
    // settle: nohup'd child writes marker+pidfile asynchronously on first run
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) execFileSync("sleep", ["0.05"]);

    const entryId = m.entries()[0]!.id;
    const pid = Number(readFileSync(join(runDir, `${entryId}.pid`), "utf8").trim());
    pidsToKill.push(pid);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    expect(() => process.kill(pid, 0)).not.toThrow(); // the survivor is alive
  });
});
