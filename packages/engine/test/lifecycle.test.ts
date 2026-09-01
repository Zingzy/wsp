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
