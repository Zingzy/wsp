// SPDX-License-Identifier: AGPL-3.0-only
// The floor on a computer somebody owns carries the C toolchain only for a
// picked row that builds with it: the agents and the base rows never pull it,
// and the floor without it is a third of the size.
import { describe, expect, it } from "vitest";
import { BASE_FLOOR, COMPILER_ROW, floorBytes } from "@wsp/catalog";
import { baseInstalls, baseVersionsCmd } from "../src/golden-base.js";
import { TOOLS_PATH } from "../src/golden-import.js";
import { FREE_KB_CMD } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { newSetupRun, provisionStep, type ProvisionPlan } from "../src/provision.js";

/** A computer with nothing of the floor on it, which answers every run and records it. */
function bare(): { machine: Machine; runs: string[] } {
  const runs: string[] = [];
  const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
  const machine = {
    id: "spoo",
    kind: "sandbox",
    exec: async (cmd: string) => (cmd === FREE_KB_CMD ? { exitCode: 0, stdout: "9000000\n", stderr: "" } : cmd === baseVersionsCmd(TOOLS_PATH) ? ok : ok),
    run: async (script: string) => {
      runs.push(script);
      return ok;
    },
  } as unknown as Machine;
  return { machine, runs };
}

const plan = (compiler: boolean): ProvisionPlan => ({ recipeAt: "x", path: TOOLS_PATH, steps: [], skipped: [], agents: 0, compiler });

describe("the floor on a computer somebody owns", () => {
  it("leaves the C toolchain off the floor unless a picked row needs it, and keeps every other floor row", () => {
    const without = baseInstalls(new Set(), TOOLS_PATH, undefined, new Set([COMPILER_ROW])).map(s => s.id);
    const whole = baseInstalls(new Set(), TOOLS_PATH).map(s => s.id);
    expect(whole).toContain(`base/${COMPILER_ROW}`);
    expect(without).not.toContain(`base/${COMPILER_ROW}`);
    expect(whole.filter(id => id !== `base/${COMPILER_ROW}`)).toEqual(without);
  });

  it("installs build-essential as a setup's floor step only for a plan that needs a compiler", async () => {
    const off = bare();
    await provisionStep(off.machine, plan(false), "floor", newSetupRun(), () => {}, { home: "/root" });
    expect(off.runs.some(r => r.includes("build-essential"))).toBe(false);
    expect(off.runs.some(r => r.includes("ripgrep"))).toBe(true);
    const on = bare();
    await provisionStep(on.machine, plan(true), "floor", newSetupRun(), () => {}, { home: "/root" });
    expect(on.runs.some(r => r.includes("build-essential"))).toBe(true);
  });

  it("weighs 316 MiB without the toolchain and 785 MiB with it, by the catalog's own sizes", () => {
    expect(Math.round(floorBytes(false) / 2 ** 20)).toBe(316);
    expect(Math.round(floorBytes(true) / 2 ** 20)).toBe(785);
    expect(BASE_FLOOR.some(e => e.id === COMPILER_ROW)).toBe(true);
  });
});
