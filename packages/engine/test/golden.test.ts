import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildGolden, forkGolden, rollback } from "../src/golden.js";
import type { ExecResult, Machine, MachineBackend, MachineSpec } from "../src/machine.js";

function recordingBackend(execResults: Record<string, ExecResult> = {}) {
  const created: MachineSpec[] = [];
  const snapshots: string[] = [];
  const killed: string[] = [];
  let nextId = 0;
  const backend: MachineBackend = {
    async create(spec) {
      created.push(spec);
      const id = `m${++nextId}`;
      const machine: Machine = {
        id, kind: spec.kind, streamUrl: undefined,
        exec: async (cmd) => execResults[cmd] ?? { exitCode: 0, stdout: "", stderr: "" },
        snapshot: async (name) => { snapshots.push(name); return `snap_${name}`; },
        pause: async () => {}, resume: async () => {},
        kill: async () => { killed.push(id); },
        state: async () => "running" as const,
        downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
      };
      return machine;
    },
    async get() { throw new Error("unused"); },
    async list() { return []; },
    async deleteSnapshot() {},
  };
  return { backend, created, snapshots, killed };
}

describe("golden pipeline", () => {
  it("refuses to snapshot when the smoke test fails", async () => {
    const { backend, snapshots, killed } = recordingBackend({
      "boom --version": { exitCode: 127, stdout: "", stderr: "not found" },
    });
    await expect(
      buildGolden({ backend, setup: "true", smoke: "boom --version" }),
    ).rejects.toThrow(/smoke/);
    expect(snapshots).toEqual([]); // Vorflux gate: no image from a machine that failed smoke
    expect(killed).toEqual(["m1"]); // builder never leaks
  });

  it("writes a complete manifest entry and kills the builder", async () => {
    const { backend, killed } = recordingBackend();
    const { manifest, version } = await buildGolden({
      backend, baseTemplate: "base", setup: "echo setup", smoke: "true",
    });
    expect(version.version).toBe(1);
    expect(version.snapshotId).toBe("snap_golden-v1");
    expect(version.baseTemplate).toBe("base");
    expect(version.setupSha).toBe(createHash("sha256").update("echo setup").digest("hex"));
    expect(version.smoke).toEqual({ cmd: "true", exitCode: 0 });
    expect(Date.parse(version.createdAt)).not.toBeNaN();
    expect(manifest.head).toBe(1);
    expect(manifest.versions).toEqual([version]);
    expect(killed).toEqual(["m1"]);
  });

  it("appends versions and rollback only moves head", async () => {
    const { backend } = recordingBackend();
    const one = await buildGolden({ backend, setup: "a", smoke: "true" });
    const two = await buildGolden({ backend, setup: "b", smoke: "true", manifest: one.manifest });
    expect(two.manifest.versions.map(v => v.version)).toEqual([1, 2]);
    expect(two.manifest.head).toBe(2);
    const rolled = rollback(two.manifest, 1);
    expect(rolled.head).toBe(1);
    expect(rolled.versions).toHaveLength(2);
    expect(two.manifest.head).toBe(2); // input untouched
  });

  it("fork passes envs/fromSnapshot and never mutates the manifest", async () => {
    const { backend, created } = recordingBackend();
    const { manifest } = await buildGolden({ backend, setup: "s", smoke: "true" });
    const before = JSON.stringify(manifest);
    const m = await forkGolden(backend, manifest, { envs: { FOO: "bar" }, labels: { wsp: "1" } });
    expect(m.id).toBe("m2");
    const forkSpec = created[1]!;
    expect(forkSpec.fromSnapshot).toBe("snap_golden-v1");
    expect(forkSpec.envs).toEqual({ FOO: "bar" });
    expect(forkSpec.labels).toEqual({ wsp: "1" });
    expect(forkSpec.template).toBeUndefined();
    expect(JSON.stringify(manifest)).toBe(before);
  });
});
