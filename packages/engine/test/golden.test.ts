import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILDER_DISK_GB, BUILDER_IDLE_MS, MachineAliveError, buildGolden, forkGolden, prepareBuilder, rollback, sealGolden, type GoldenStage } from "../src/golden.js";
import { NotFirstLifeError } from "../src/lifecycle.js";
import type { ExecResult, Machine, MachineBackend, MachineSpec } from "../src/machine.js";

/** A fake whose kill() resolves like the provider's DELETE does: a call for
 * which `ignoreKill` answers true is accepted and changes nothing. */
function recordingBackend(execResults: Record<string, ExecResult> = {}, opts: { ignoreKill?: (id: string, nth: number) => boolean } = {}) {
  const created: MachineSpec[] = [];
  const snapshots: string[] = [];
  const killed: string[] = [];
  const deletedSnapshots: string[] = [];
  /** Every create/kill/snapshot in order, so sequencing under the machine cap is provable. */
  const timeline: string[] = [];
  const machines = new Map<string, Machine>();
  const gone = new Set<string>();
  let nextId = 0;
  const killCount = new Map<string, number>();
  const backend: MachineBackend = {
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 } },
    async create(spec) {
      created.push(spec);
      const id = `m${++nextId}`;
      timeline.push(`create ${id}`);
      const machine: Machine = {
        id, kind: spec.kind, streamUrl: spec.kind === "desktop" ? `wss://fake/stream/${id}` : undefined,
        exec: async (cmd) => execResults[cmd] ?? { exitCode: 0, stdout: "", stderr: "" },
        snapshot: async (name) => { snapshots.push(name); timeline.push(`snapshot ${id}`); return `snap_${name}`; },
        pause: async () => {}, resume: async () => {},
        kill: async () => {
          killed.push(id);
          timeline.push(`kill ${id}`);
          const nth = (killCount.get(id) ?? 0) + 1;
          killCount.set(id, nth);
          if (!opts.ignoreKill?.(id, nth)) gone.add(id);
        },
        state: async () => (gone.has(id) ? "gone" : "running"),
        downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
      };
      machines.set(id, machine);
      return machine;
    },
    async get(id) {
      const m = machines.get(id);
      if (!m || gone.has(id)) throw Object.assign(new Error(`no machine ${id}`), { kind: "missing", status: 404 });
      return m;
    },
    async list() { return []; },
    async deleteSnapshot(id) { deletedSnapshots.push(id); },
  };
  return { backend, created, snapshots, killed, deletedSnapshots, timeline };
}

const FAST_KILL = { graceMs: 20, pollMs: 1 };

function stageRecorder() {
  const stages: string[] = [];
  const onStage = (stage: GoldenStage, detail?: string) => {
    stages.push(detail === undefined ? stage : `${stage}:${detail}`);
  };
  return { stages, onStage };
}

describe("golden pipeline", () => {
  it("seals no version when the smoke fork fails, and leaves no machine or snapshot behind", async () => {
    const { backend, killed, deletedSnapshots } = recordingBackend({
      "boom --version": { exitCode: 127, stdout: "", stderr: "not found" },
    });
    await expect(
      buildGolden({ backend, setup: "true", smoke: "boom --version" }),
    ).rejects.toThrow(/smoke/);
    expect(deletedSnapshots).toEqual(["snap_golden-v1"]); // the image that failed smoke does not survive
    expect(killed).toEqual(["m1", "m2"]); // builder and smoke fork both gone
  });

  it("writes a complete manifest entry, sandbox kind by default, and kills builder and fork", async () => {
    const { backend, created, killed } = recordingBackend();
    const { manifest, version } = await buildGolden({
      backend, baseTemplate: "base", setup: "echo setup", smoke: "true",
    });
    expect(version.version).toBe(1);
    expect(version.snapshotId).toBe("snap_golden-v1");
    expect(version.baseTemplate).toBe("base");
    expect(version.kind).toBe("sandbox");
    expect(version.setupSha).toBe(createHash("sha256").update("echo setup").digest("hex"));
    expect(version.smoke).toEqual({ cmd: "true", exitCode: 0 });
    expect(Date.parse(version.createdAt)).not.toBeNaN();
    expect(manifest.head).toBe(1);
    expect(manifest.versions).toEqual([version]);
    expect(created.map(c => c.kind)).toEqual(["sandbox", "sandbox"]);
    expect(created[1]!.fromSnapshot).toBe("snap_golden-v1");
    expect(killed).toEqual(["m1", "m2"]);
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

  it("fork passes envs/fromSnapshot, restores the sealed kind, and never mutates the manifest", async () => {
    const { backend, created } = recordingBackend();
    const { manifest } = await buildGolden({ backend, kind: "desktop", setup: "s", smoke: "true" });
    const before = JSON.stringify(manifest);
    const m = await forkGolden(backend, manifest, { envs: { FOO: "bar" }, labels: { wsp: "1" } });
    expect(m.id).toBe("m3");
    expect(m.kind).toBe("desktop");
    const forkSpec = created[2]!;
    expect(forkSpec.fromSnapshot).toBe("snap_golden-v1");
    expect(forkSpec.envs).toEqual({ FOO: "bar" });
    expect(forkSpec.labels).toEqual({ wsp: "1" });
    expect(forkSpec.template).toBeUndefined();
    expect(JSON.stringify(manifest)).toBe(before);
  });
});

describe("interactive golden: prepare then seal", () => {
  it("prepare boots a sandbox from the sandbox template with the builder disk, runs daemon then harness, and reports stages", async () => {
    const { backend, created, timeline } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const daemonOn: string[] = [];
    const builder = await prepareBuilder({
      backend,
      setup: "install harness",
      deployDaemon: async m => { daemonOn.push(m.id); },
      onStage,
    });
    // An idle-paused builder resumes not first-life and the seal would 502; kill fails loud instead.
    expect(created[0]).toMatchObject({ kind: "sandbox", template: "base", diskGb: BUILDER_DISK_GB, onIdle: "kill" });
    expect(BUILDER_DISK_GB).toBe(20);
    expect(builder.kind).toBe("sandbox");
    expect(builder.firstLife).toBe(true);
    expect(builder.machine.streamUrl).toBeUndefined();
    expect(daemonOn).toEqual(["m1"]);
    expect(stages).toEqual(["creating:sandbox from base", "deploying-daemon", "installing-harness", "ready"]);
    expect(timeline).toEqual(["create m1"]); // alive and waiting for the person
  });

  it("a daemon hook that reports a detail gets it on a second deploying-daemon frame", async () => {
    const { backend } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", deployDaemon: async () => "node v22.23.2", onStage });
    expect(stages).toEqual(["creating:sandbox from base", "deploying-daemon", "deploying-daemon:node v22.23.2", "installing-harness", "ready"]);
  });

  it("prepare with kind desktop picks the desktop template and streams a display", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, kind: "desktop", setup: "true" });
    expect(created[0]).toMatchObject({ kind: "desktop", template: "default", diskGb: BUILDER_DISK_GB });
    expect(builder.kind).toBe("desktop");
    expect(builder.machine.streamUrl).toBe("wss://fake/stream/m1");
  });

  it("only the builder idles to kill, after a window long enough for a person; the smoke fork keeps the provider default", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true" });
    await sealGolden(builder, { backend, smoke: "true" });
    expect(created[0]).toMatchObject({ onIdle: "kill", idleTimeoutMs: BUILDER_IDLE_MS });
    expect(BUILDER_IDLE_MS).toBeGreaterThanOrEqual(4 * 60 * 60_000);
    expect(created[1]).toMatchObject({ fromSnapshot: "snap_golden-v1" });
    expect(created[1]!.onIdle).toBeUndefined();
    expect(created[1]!.idleTimeoutMs).toBeUndefined();
  });

  it("prepare kills the machine and reports failed when the harness install fails", async () => {
    const { backend, killed } = recordingBackend({ "bad install": { exitCode: 1, stdout: "", stderr: "nope" } });
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "bad install", onStage })).rejects.toThrow(/setup failed/);
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toMatch(/^failed:golden setup failed/);
  });

  it("seal snapshots, kills the builder before the smoke fork boots, and records the kind", async () => {
    const { backend, created, timeline } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, kind: "desktop", setup: "echo setup", onStage });
    const { manifest, version } = await sealGolden(builder, { backend, smoke: "claude --version", onStage });
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "create m2", "kill m2"]);
    expect(created[1]).toMatchObject({ kind: "desktop", fromSnapshot: "snap_golden-v1" });
    expect(version).toMatchObject({ version: 1, kind: "desktop", baseTemplate: "default", snapshotId: "snap_golden-v1" });
    expect(version.setupSha).toBe(builder.setupSha);
    expect(manifest.head).toBe(1);
    expect(stages).toEqual([
      "creating:desktop from default", "installing-harness", "ready",
      "snapshotting:golden-v1", "smoke-forking:claude --version", "sealed:v1",
    ]);
  });

  it("seal retries a kill the provider accepted without acting on, and forks only once the builder reads gone", async () => {
    const { backend, timeline } = recordingBackend({}, { ignoreKill: (id, nth) => id === "m1" && nth === 1 });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { version } = await sealGolden(builder, { backend, smoke: "true", killConfirm: FAST_KILL, onStage });
    expect(version.version).toBe(1);
    expect(stages.at(-1)).toBe("sealed:v1");
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "kill m1", "create m2", "kill m2"]);
    expect(await builder.machine.state()).toBe("gone");
  });

  it("seal fails with a typed error when the builder outlives two kills, and never boots the smoke fork", async () => {
    const { backend, created, timeline, deletedSnapshots } = recordingBackend({}, { ignoreKill: () => true });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const err = await sealGolden(builder, { backend, smoke: "true", killConfirm: FAST_KILL, onStage }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(MachineAliveError);
    expect(err).toMatchObject({ kind: "machineAlive", machineId: "m1", state: "running" });
    expect((err as Error).message).toMatch(/m1/);
    expect(created).toHaveLength(1);
    expect(timeline.filter(t => t === "kill m1").length).toBeGreaterThanOrEqual(2);
    expect(deletedSnapshots).toEqual(["snap_golden-v1"]);
    expect(stages.at(-1)).toMatch(/^failed:/);
  });

  it("a smoke fork that outlives its kills still seals the proven image, and the sealed stage names the leak", async () => {
    const { backend, timeline, deletedSnapshots } = recordingBackend({}, { ignoreKill: id => id === "m2" });
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { manifest } = await sealGolden(builder, { backend, smoke: "true", killConfirm: FAST_KILL, onStage });
    expect(manifest.head).toBe(1);
    expect(deletedSnapshots).toEqual([]);
    expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "create m2", "kill m2", "kill m2"]);
    expect(stages.at(-1)).toMatch(/^sealed:v1; machine m2 is still running after two kills/);
  });

  it("seal refuses a builder that is not first-life with a typed error and touches nothing", async () => {
    const { backend, timeline, snapshots } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const err = await sealGolden({ ...builder, firstLife: false }, { backend, smoke: "true" }).catch(e => e as unknown);
    expect(err).toBeInstanceOf(NotFirstLifeError);
    expect((err as NotFirstLifeError).kind).toBe("notFirstLife");
    expect((err as NotFirstLifeError).machineId).toBe("m1");
    expect(snapshots).toEqual([]);
    expect(timeline).toEqual(["create m1"]);
  });

  it("a failed seal kills every machine, drops the snapshot, and leaves the prior manifest untouched", async () => {
    const { backend, killed, deletedSnapshots } = recordingBackend({ smoke: { exitCode: 2, stdout: "", stderr: "broken" } });
    const { stages, onStage } = stageRecorder();
    const one = await buildGolden({ backend, setup: "a", smoke: "true" });
    const before = JSON.stringify(one.manifest);
    const builder = await prepareBuilder({ backend, setup: "b" });
    await expect(sealGolden(builder, { backend, smoke: "smoke", manifest: one.manifest, onStage })).rejects.toThrow(/smoke failed/);
    expect(JSON.stringify(one.manifest)).toBe(before);
    expect(killed).toEqual(["m1", "m2", "m3", "m4"]);
    expect(deletedSnapshots).toEqual(["snap_golden-v2"]);
    expect(stages.at(-1)).toMatch(/^failed:golden smoke failed/);
  });
});
