// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { TOOL_PREFIX } from "@wsp/protocol";
import { MIB, TOOLS_DISK_FLOOR, installTools, ownedFloorBytes } from "../src/golden-tools.js";
import type { ToolInstall } from "../src/golden-import.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { newSetupRun, provisionStep } from "../src/provision.js";
import { writeStub } from "../../protocol/test/stub-script.js";

/** A machine whose df reads what is free, and each install takes the bytes its step says it will. */
function disk(freeBytes: number, takes: Record<string, number>): Machine & { ran: string[] } {
  let free = freeBytes;
  const ran: string[] = [];
  const answer = (text: string): ExecResult => {
    if (text.startsWith("df ")) return { exitCode: 0, stdout: text.includes("$3") ? `${Math.floor((50_000 * MIB) / 1024)} ${Math.floor(free / 1024)}\n` : `${Math.floor(free / 1024)}\n`, stderr: "" };
    for (const [cmd, bytes] of Object.entries(takes))
      if (text.includes(cmd)) {
        ran.push(cmd);
        free -= bytes;
      }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    id: "m1",
    kind: "sandbox",
    exec: async cmd => answer(cmd),
    run: async script => answer(script),
    snapshot: async () => "snap",
    pause: async () => {},
    resume: async () => {},
    kill: async () => {},
    state: async () => "running",
    downloadUrl: async () => "https://x",
    uploadUrl: async () => "https://x",
    ran,
  };
}

describe("the disk the tools loop keeps free", () => {
  it("skips an install too big for the room above the floor, alone, and installs what fits after it", async () => {
    const zig: ToolInstall = { id: "tools/brew/zig", label: "zig", manager: "brew", cmd: "install-zig", bytes: 2400 * MIB };
    const jq: ToolInstall = { id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "install-jq", bytes: 2 * MIB };
    const machine = disk(TOOLS_DISK_FLOOR + 1000 * MIB, { "install-zig": 2400 * MIB, "install-jq": 2 * MIB });
    const out = await installTools(machine, [zig, jq], () => {}, "installing-tools", { caches: "keep" });
    expect(out.tools.map(t => [t.label, t.outcome])).toEqual([
      ["zig", "skipped"],
      ["jq", "installed"],
    ]);
    expect(out.tools[0]!.note).toMatch(/^needs about 2\.3 GB, 3(\.0)? GB free, keeping 2(\.0)? GB free$/);
    expect(machine.ran).toEqual(["install-jq"]);
  });

  it("holds back a tenth of the disk on a computer somebody owns, where that is more than the floor", () => {
    expect(ownedFloorBytes(75 * 1024 * MIB)).toBe(Math.floor((75 * 1024 * MIB) / 10));
    expect(ownedFloorBytes(10 * 1024 * MIB)).toBe(TOOLS_DISK_FLOOR);
    expect(ownedFloorBytes(undefined)).toBe(TOOLS_DISK_FLOOR);
  });
});

describe("the volume the tools loop reads on a computer somebody owns", () => {
  /** A box whose /root sits on a 100 GB volume with 50 GB free and whose every other folder, wsp's install folder
   * among them, sits on a 20 GB one with 3 GB free. Every df the run sends goes to a real bash, whose PATH finds a df
   * answering by the folder it is handed; anything else answers nothing. */
  function twoVolumes(): Machine & { handed: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), "wsp-volumes-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const handed = join(dir, "handed");
    writeStub(
      join(dir, "df"),
      [
        "#!/bin/sh",
        `echo "$2" >> ${handed}`,
        'case "$2" in /root|/root/*) size=104857600 free=52428800 ;; *) size=20971520 free=3145728 ;; esac',
        'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
        'echo "fake $size $((size - free)) $free 50% /"',
        "",
      ].join("\n"),
    );
    const answer = (cmd: string): ExecResult => {
      if (!cmd.includes("df -Pk")) return { exitCode: 0, stdout: "", stderr: "" };
      const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      return { exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
    };
    return { id: "box", kind: "sandbox", exec: async (cmd: string) => answer(cmd), run: async (script: string) => answer(script), handed: () => readFileSync(handed, "utf8").trim().split("\n") } as unknown as Machine & { handed: () => string[] };
  }

  it("keeps its floor and reads what is free on the volume wsp installs onto, not the one /root sits on", async () => {
    const big: ToolInstall = { id: "tools/custom/big", label: "big", manager: "script", cmd: "install-big", bytes: 2048 * MIB };
    const machine = twoVolumes();
    const plan = { recipeAt: "2026-10-05T10:00:00.000Z", path: "/usr/bin:/bin", prefix: TOOL_PREFIX, steps: [big], skipped: [], agents: 0, compiler: false };
    const rows = await provisionStep(machine, plan, "clis", newSetupRun(), () => {}, { home: "/root" });
    // 3 GB free less the 2 GB it takes leaves less than the 2 GB a 20 GB disk keeps; /root's volume would have let it in.
    expect(rows.map(r => [r.id, r.outcome, r.note])).toEqual([["tools/custom/big", "skipped", "needs about 2 GB, 3 GB free, keeping 2 GB free"]]);
    // Every df was handed wsp's install folder, or the nearest folder above it that is there.
    const above = (dir: string): string[] => (dir === "/" ? ["/"] : [dir, ...above(dirname(dir))]);
    for (const folder of machine.handed()) {
      expect(above(TOOL_PREFIX)).toContain(folder);
      expect(existsSync(folder)).toBe(true);
    }
  });
});
