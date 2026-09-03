// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_NAMES, type HostExec, READ_LIMIT, nodeMachine, nodeMachineFs } from "../../src/index.js";

describe("the live machine", () => {
  it("carries only the seven environment names the passes read", () => {
    const m = nodeMachine();
    expect(Object.keys(m.env).every(k => (ENV_NAMES as readonly string[]).includes(k))).toBe(true);
    expect(Object.keys(m.env)).not.toContain("PATH");
    const exec: HostExec = m.exec;
    expect(typeof exec.which).toBe("function");
  });

  it("readText is bounded at 1 MiB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wsp-collect-"));
    try {
      await writeFile(join(dir, "small.txt"), "x = 1\n");
      await writeFile(join(dir, "big.txt"), Buffer.alloc(READ_LIMIT + 1, 0x61));
      expect(await nodeMachineFs.readText(join(dir, "small.txt"))).toBe("x = 1\n");
      expect(await nodeMachineFs.readText(join(dir, "big.txt"))).toBeUndefined();
      expect(await nodeMachineFs.readText(join(dir, "missing.txt"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
