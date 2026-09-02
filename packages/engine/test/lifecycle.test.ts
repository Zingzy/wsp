import { describe, expect, it } from "vitest";
import { Workspace } from "../src/lifecycle.js";
import type { Machine } from "../src/machine.js";

function stubMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1", kind: "sandbox",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    snapshot: async () => "snap_x", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
    streamUrl: undefined, ...overrides,
  };
}

describe("Workspace lifecycle", () => {
  it("refuses direct snapshot after any resume (snapshot-fresh rule)", async () => {
    const ws = new Workspace(stubMachine(), { goldenSnapshot: "snap_g" });
    await ws.nap();
    await ws.wake();
    await expect(ws.checkpoint("v2")).rejects.toThrow(/first-life/);
  });
  it("allows checkpoint while first-life", async () => {
    const ws = new Workspace(stubMachine(), { goldenSnapshot: "snap_g" });
    await expect(ws.checkpoint("v1")).resolves.toBe("snap_x");
  });
  it("wake resurrects from golden when the paused machine vanished", async () => {
    const dead = stubMachine({ resume: async () => { throw Object.assign(new Error("gone"), { kind: "missing" }); } });
    let resurrected = false;
    const ws = new Workspace(dead, {
      goldenSnapshot: "snap_g",
      resurrect: async () => { resurrected = true; return stubMachine({ id: "m2" }); },
    });
    await ws.nap();
    await ws.wake();
    expect(resurrected).toBe(true);
    expect(ws.machineId).toBe("m2");
  });
});

describe("Workspace verified wake", () => {
  function counting(overrides: Partial<Machine> = {}) {
    const calls = { pause: 0, resume: 0, kill: 0 };
    const machine = stubMachine({
      pause: async () => { calls.pause++; },
      resume: async () => { calls.resume++; },
      kill: async () => { calls.kill++; },
      ...overrides,
    });
    return { machine, calls };
  }

  it("holds the phase at waking until the check passes, then stays on the same machine", async () => {
    const { machine, calls } = counting();
    const seen: string[] = [];
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      resurrect: async () => stubMachine({ id: "m2" }),
      wakeCheck: async () => { seen.push(ws.currentPhase); return undefined; },
    });
    await ws.nap();
    const result = await ws.wake();
    expect(seen).toEqual(["waking"]);
    expect(ws.currentPhase).toBe("running");
    expect(ws.machineId).toBe("m1");
    expect(result).toEqual({ resurrected: false });
    expect(calls.resume).toBe(1);
  });

  it("a check that fails once is paused and resumed again, and a passing second try keeps the machine", async () => {
    const { machine, calls } = counting();
    let checks = 0;
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      resurrect: async () => stubMachine({ id: "m2" }),
      wakeCheck: async () => (++checks === 1 ? "daemon did not answer" : undefined),
    });
    await ws.nap();
    const result = await ws.wake();
    expect(calls).toEqual({ pause: 2, resume: 2, kill: 0 });
    expect(ws.machineId).toBe("m1");
    expect(result.resurrected).toBe(false);
    expect(result.reason).toContain("daemon did not answer");
  });

  it("two failed checks resurrect from golden, restore the stashed vault, then kill the zombie", async () => {
    const { machine, calls } = counting();
    const order: string[] = [];
    const replacement = stubMachine({ id: "m2" });
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      resurrect: async () => { order.push("resurrect"); return replacement; },
      restoreVault: async m => { order.push(`restore:${m.id}`); },
      wakeCheck: async m => `memMb 2048 != 4096 on ${m.id}`,
    });
    await ws.nap();
    const result = await ws.wake();
    expect(calls).toEqual({ pause: 2, resume: 2, kill: 1 });
    expect(order).toEqual(["resurrect", "restore:m2"]);
    expect(ws.machineId).toBe("m2");
    expect(ws.isFirstLife).toBe(true);
    expect(ws.currentPhase).toBe("running");
    expect(result.resurrected).toBe(true);
    expect(result.reason).toMatch(/attempt 1: memMb 2048 != 4096 on m1; attempt 2: memMb 2048/);
  });

  it("nap stashes the vault before the pause", async () => {
    const order: string[] = [];
    const machine = stubMachine({ pause: async () => { order.push("pause"); } });
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", stashVault: async () => { order.push("stash"); } });
    await ws.nap();
    expect(order).toEqual(["stash", "pause"]);
  });

  it("a machine that vanished while paused is replaced and gets the stashed vault too", async () => {
    const dead = stubMachine({ resume: async () => { throw Object.assign(new Error("gone"), { kind: "missing" }); } });
    const restored: string[] = [];
    const ws = new Workspace(dead, {
      goldenSnapshot: "snap_g",
      resurrect: async () => stubMachine({ id: "m2" }),
      restoreVault: async m => { restored.push(m.id); },
    });
    await ws.nap();
    const result = await ws.wake();
    expect(restored).toEqual(["m2"]);
    expect(result.resurrected).toBe(true);
    expect(result.reason).toContain("vanished");
  });

  it("a failed wake with no resurrect hook throws and leaves the workspace napping", async () => {
    const { machine } = counting();
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeCheck: async () => "no daemon" });
    await ws.nap();
    await expect(ws.wake()).rejects.toThrow(/no daemon/);
    expect(ws.currentPhase).toBe("napping");
  });
});
