// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { MIB, TOOLS_DISK_FLOOR, installTools, ownedFloorBytes } from "../src/golden-tools.js";
import type { ToolInstall } from "../src/golden-import.js";
import type { ExecResult, Machine } from "../src/machine.js";

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
