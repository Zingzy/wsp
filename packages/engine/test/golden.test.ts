import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILDER_IDLE_MS, MachineAliveError, applyGoldenImport, buildGolden, forkGolden, prepareBuilder, rollback, sealGolden, type GoldenImport, type GoldenStage, type ImportResult } from "../src/golden.js";
import { NotFirstLifeError } from "../src/lifecycle.js";
import { HOMEBREW, type ToolInstall } from "../src/golden-import.js";
import type { ExecResult, Machine, MachineBackend, MachineShape, MachineSpec } from "../src/machine.js";

/** A fake whose kill() resolves like the provider's DELETE does: a call for
 * which `ignoreKill` answers true is accepted and changes nothing. */
function recordingBackend(
  execResults: Record<string, ExecResult> = {},
  opts: { ignoreKill?: (id: string, nth: number) => boolean; built?: (spec: MachineSpec) => MachineShape; exec?: (cmd: string) => ExecResult } = {},
) {
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
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 } },
    async create(spec) {
      created.push(spec);
      const id = `m${++nextId}`;
      timeline.push(`create ${id}`);
      const machine: Machine = {
        id, kind: spec.kind, streamUrl: spec.kind === "desktop" ? `wss://fake/stream/${id}` : undefined,
        exec: async (cmd) => opts.exec?.(cmd) ?? execResults[cmd] ?? { exitCode: 0, stdout: "", stderr: "" },
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
        ...(opts.built ? { describe: async () => opts.built!(spec) } : {}),
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

  it("stamps the builder as wsp-builder and the smoke fork as wsp-smoke with its own createdAt", async () => {
    const { backend, created } = recordingBackend();
    const labels = { wsp: "1", "wsp-owner": "h_me", createdAt: "2026-09-01T00:00:00.000Z" };
    await buildGolden({ backend, setup: "true", smoke: "true", labels });
    expect(created[0]!.labels).toEqual({ ...labels, "wsp-builder": "1" });
    expect(created[1]!.labels).toMatchObject({ wsp: "1", "wsp-owner": "h_me", "wsp-smoke": "1" });
    expect(created[1]!.labels).not.toHaveProperty("wsp-builder");
    expect(Date.parse(created[1]!.labels!["createdAt"]!)).toBeGreaterThan(Date.parse(labels.createdAt));
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
    expect(created[0]).toMatchObject({ kind: "sandbox", template: "base", onIdle: "kill" });
    expect(created[0]).not.toHaveProperty("diskGb");
    expect(builder.kind).toBe("sandbox");
    expect(builder.firstLife).toBe(true);
    expect(builder.machine.streamUrl).toBeUndefined();
    expect(daemonOn).toEqual(["m1"]);
    expect(stages).toEqual(["creating:sandbox from base", "deploying-daemon", "installing-harness", "ready"]);
    expect(timeline).toEqual(["create m1"]); // alive and waiting for the person
  });

  it("the builder's createdAt is taken before the create, so the age a person reads covers the whole prepare", async () => {
    const { backend } = recordingBackend();
    let createCalledAt = 0;
    const realCreate = backend.create.bind(backend);
    backend.create = async spec => {
      createCalledAt = Date.now();
      return realCreate(spec);
    };
    const builder = await prepareBuilder({ backend, setup: "true", deployDaemon: () => new Promise(r => setTimeout(r, 15)) });
    expect(Date.parse(builder.createdAt)).toBeLessThanOrEqual(createCalledAt);
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
    expect(created[0]).toMatchObject({ kind: "desktop", template: "default" });
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

  it("seal records whether the image carries the browser shim, read on the smoke fork", async () => {
    const withShim = recordingBackend({}, { exec: cmd => (cmd === "test -x /usr/local/bin/wsp-open" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) });
    const b1 = await prepareBuilder({ backend: withShim.backend, setup: "true" });
    expect((await sealGolden(b1, { backend: withShim.backend, smoke: "true" })).version.browserShim).toBe(true);

    const without = recordingBackend({}, { exec: cmd => (cmd === "test -x /usr/local/bin/wsp-open" ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) });
    const b2 = await prepareBuilder({ backend: without.backend, setup: "true" });
    expect((await sealGolden(b2, { backend: without.backend, smoke: "true" })).version.browserShim).toBe(false);
  });

  it("seal stamps the logins it is given onto the version, name and state only", async () => {
    const { backend } = recordingBackend();
    const b = await prepareBuilder({ backend, setup: "true" });
    const logins = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "skipped" as const }];
    const { version } = await sealGolden(b, { backend, smoke: "true", logins });
    expect(version.logins).toEqual(logins);
    const b2 = await prepareBuilder({ backend, setup: "true" });
    expect((await sealGolden(b2, { backend, smoke: "true" })).version.logins).toBeUndefined();
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

describe("golden size", () => {
  /** A provider that clamps memory to 2048 MB whatever is asked. */
  const clamped = (spec: MachineSpec): MachineShape => ({ cpu: spec.cpu ?? 2, memMb: 2048, createdAt: "2026-09-02T00:00:00.000Z" });

  it("prepare asks for an explicit size, the pricing default when none is named, and records what the provider built", async () => {
    const { backend, created } = recordingBackend({}, { built: clamped });
    const builder = await prepareBuilder({ backend, setup: "true" });
    expect(created[0]).toMatchObject({ cpu: 2, memMb: 4096 });
    expect(builder.size).toEqual({ cpu: 2, memMb: 2048 });
  });

  it("a backend that cannot describe machines is taken at its word on the request", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true", memMb: 8192 });
    expect(created[0]).toMatchObject({ cpu: 2, memMb: 8192 });
    expect(builder.size).toEqual({ cpu: 2, memMb: 8192 });
  });

  it("seal forks the smoke at the builder's size and records that size on the version", async () => {
    const { backend, created } = recordingBackend({}, { built: clamped });
    const builder = await prepareBuilder({ backend, setup: "true", memMb: 8192 });
    const { version } = await sealGolden(builder, { backend, smoke: "true" });
    expect(created[1]).toMatchObject({ fromSnapshot: "snap_golden-v1", cpu: 2, memMb: 2048 });
    expect(version.size).toEqual({ cpu: 2, memMb: 2048 });
  });

  it("forkGolden inherits the sealed size unless overridden", async () => {
    const { backend, created } = recordingBackend();
    const { manifest } = await buildGolden({ backend, setup: "s", smoke: "true", memMb: 8192 });
    expect(manifest.versions[0]!.size).toEqual({ cpu: 2, memMb: 8192 });
    await forkGolden(backend, manifest);
    await forkGolden(backend, manifest, { cpu: 4 });
    expect(created[2]).toMatchObject({ cpu: 2, memMb: 8192 });
    expect(created[3]).toMatchObject({ cpu: 4, memMb: 8192 });
  });
});

describe("golden import stages", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const FREE_KB_CMD = "df -Pk /root | awk 'NR==2{print $4}'";
  const mb = (n: number) => String(n * 1024);

  function importOf(over: Partial<GoldenImport> = {}): GoldenImport {
    return {
      recipeHash: "h1",
      files: {
        count: 3,
        rungs: { identity: 1, shell: 2 },
        bytes: 4096,
        skipped: [{ id: "shell/bashrc", path: "~/.bashrc", note: "no longer on this computer" }],
        pack: async () => ({ tar: Buffer.from("tgz-bytes"), bytes: 1200, unpacked: 4096, skipped: [], cut: [] }),
      },
      tools: [
        { id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: "brew-bootstrap" },
        { id: "tools/brew/gh", label: "gh", manager: "brew", cmd: "brew install gh", after: "tools/homebrew" },
        { id: "tools/npm/bun", label: "bun@1.4.0", manager: "npm", cmd: "npm install -g bun@1.4.0" },
      ],
      agents: [
        { id: "agents/claude", name: "Claude Code", install: "claude-install", smoke: "claude --version" },
        { id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version" },
      ],
      ...over,
    };
  }

  /** The fake answers exec by substring match, first hit wins; `free` is what df reports. */
  function backendFor(answers: [string, ExecResult][] = [], free: string | (() => string) = mb(2000)) {
    const cmds: string[] = [];
    const puts: Buffer[] = [];
    const rb = recordingBackend({}, {
      exec: cmd => {
        cmds.push(cmd);
        const hit = answers.find(([needle]) => cmd.includes(needle));
        if (hit) return hit[1];
        if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${typeof free === "function" ? free() : free}\n`, stderr: "" };
        return ok;
      },
    });
    const fetchStub: typeof fetch = async (_url, init) => {
      puts.push(Buffer.from(init?.body as Uint8Array));
      return new Response(null, { status: 200 });
    };
    return { ...rb, cmds, puts, fetch: fetchStub };
  }

  it("runs setup, upload, tools and agents in order after the daemon, with a detail on every frame", async () => {
    const { backend, cmds, puts, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({
      backend, setup: "true", deployDaemon: async () => "node v22", fetch, onStage,
      import: importOf({ onResult: r => void results.push(r) }),
    });
    expect(stages).toEqual([
      "creating:sandbox from base",
      "deploying-daemon", "deploying-daemon:node v22",
      "applying-setup:3 files: identity 1, shell 2",
      "applying-setup:1.2 KB packed; skipped ~/.bashrc (no longer on this computer)",
      "uploading-files:1.2 KB",
      expect.stringMatching(/^uploading-files:1\.2 KB in \d+(\.\d)?s$/),
      "installing-tools:Homebrew (1/3)", "installing-tools:gh (2/3)", "installing-tools:bun@1.4.0 (3/3)",
      "installing-tools:3 installed",
      "installing-harness",
      "installing-harness:Claude Code (1/2)", "installing-harness:Codex (2/2)",
      "installing-harness:Claude Code, Codex installed",
      "ready",
    ]);
    expect(puts).toEqual([Buffer.from("tgz-bytes")]);
    const untar = cmds.find(c => c.includes("tar xzf"))!;
    expect(untar).toMatch(/-C '\/root' --no-same-owner/);
    expect(cmds.indexOf(FREE_KB_CMD)).toBeLessThan(cmds.indexOf(untar));
    const tool = cmds.find(c => c.includes("brew install gh"))!;
    expect(tool).toMatch(/^timeout -k 10 600 bash -c '/);
    expect(cmds.filter(c => c.includes("brew install gh") || c.includes("brew-bootstrap") || c.includes("bun@1.4.0"))).toHaveLength(3);
    const agent = cmds.find(c => c.includes("codex-install"))!;
    expect(agent).toMatch(/^timeout -k 10 900 bash -c 'set -euo pipefail\nexport PATH="\/usr\/local\/bin:\$PATH"\n/);
    // Agents and their checks run with the Node the golden installed ahead of any the image shipped.
    expect(cmds).toContain('export PATH="/usr/local/bin:$PATH"\nclaude --version');
    expect(cmds).toContain('export PATH="/usr/local/bin:$PATH"\ncodex --version');
    expect(cmds.indexOf("true")).toBeLessThan(cmds.indexOf(agent));
    expect(cmds.indexOf(tool)).toBeLessThan(cmds.indexOf("true"));
    expect(builder.import).toEqual({ recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-tools", "installing-harness"], smoke: "claude --version && codex --version" });
    expect(builder.setupSha).toBe(createHash("sha256").update("true\nclaude-install\ncodex-install").digest("hex"));
    expect(results).toEqual([{
      recipeHash: "h1",
      files: { bytes: 1200, skipped: [{ id: "shell/bashrc", path: "~/.bashrc", note: "no longer on this computer" }], cut: [] },
      homebrew: HOMEBREW,
      tools: [
        { id: "tools/homebrew", label: "Homebrew", outcome: "installed", ms: expect.any(Number) },
        { id: "tools/brew/gh", label: "gh", outcome: "installed", ms: expect.any(Number) },
        { id: "tools/npm/bun", label: "bun@1.4.0", outcome: "installed", ms: expect.any(Number) },
      ],
      agents: [
        { id: "agents/claude", name: "Claude Code", outcome: "installed", ms: expect.any(Number) },
        { id: "agents/codex", name: "Codex", outcome: "installed", ms: expect.any(Number) },
      ],
    }]);
  });

  it("a tool that fails is a warning in the detail and the next one still runs; the seal smoke names only agents that installed", async () => {
    const { backend, fetch } = backendFor([
      // stdout ends on a progress line; the reason is the last stderr line, not that.
      ["brew install gh", { exitCode: 1, stdout: "==> Installing gh dependency: oniguruma\n", stderr: "Error: gh: no bottle available!\n" }],
      ["codex-install", { exitCode: 124, stdout: "", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(stages).toContain("installing-tools:2 installed, 1 failed: gh (Error: gh: no bottle available!)");
    expect(stages).toContain("installing-harness:Claude Code installed; Codex failed (timed out after 900s)");
    expect(builder.import?.smoke).toBe("claude --version");
    expect(results[0]!.tools[1]).toEqual({ id: "tools/brew/gh", label: "gh", outcome: "failed", note: "Error: gh: no bottle available!", ms: expect.any(Number) });
    expect(results[0]!.agents[1]).toEqual({ id: "agents/codex", name: "Codex", outcome: "failed", note: "timed out after 900s", ms: expect.any(Number) });
    const { version } = await sealGolden(builder, { backend, smoke: "should-not-run" });
    expect(version.smoke.cmd).toBe("claude --version");
  });

  it("when every ticked agent fails the build stops, names each agent and its reason, kills the builder, and still reports the result", async () => {
    const { backend, killed, fetch } = backendFor([
      ["claude-install", { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" }],
      ["codex-install", { exitCode: 124, stdout: "", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/no agent installed/);
    expect(stages.at(-1)).toBe(["failed:no agent installed, so there is nothing to seal:", "Claude Code: curl: (6) Could not resolve host", "Codex: timed out after 900s"].join("\n"));
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.agents.map(a => a.outcome)).toEqual(["failed", "failed"]);
  });

  it("the Node step runs once before the agents: kept when the guest meets the floor, installed and said so when not, and a failure fails only the agents above the guest's major", async () => {
    const node = { floor: 22, version: "22.23.2", agents: ["Pi"], cmd: "node-step" };
    const agents = [
      { id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version", node: 16 },
      { id: "agents/pi", name: "Pi", install: "pi-install", smoke: "pi --version", node: 22 },
    ];
    const kept = backendFor([["node-step", { exitCode: 0, stdout: "NODE_HAVE v22.1.0\nNODE_KEPT v22.1.0\n", stderr: "" }]]);
    const k = stageRecorder();
    const b1 = await prepareBuilder({ backend: kept.backend, setup: "true", fetch: kept.fetch, onStage: k.onStage, import: importOf({ node, agents }) });
    expect(k.stages.slice(k.stages.indexOf("installing-harness"))).toEqual([
      "installing-harness", "installing-harness:Node for Pi", "installing-harness:Node v22.1.0 kept; Pi run on it",
      "installing-harness:Codex (1/2)", "installing-harness:Pi (2/2)", "installing-harness:Codex, Pi installed", "ready",
    ]);
    expect(kept.cmds.indexOf(kept.cmds.find(c => c.includes("node-step"))!)).toBeLessThan(kept.cmds.indexOf(kept.cmds.find(c => c.includes("codex-install"))!));
    expect(b1.setupSha).toBe(createHash("sha256").update("true\nnode-step\ncodex-install\npi-install").digest("hex"));

    const installed = backendFor([["node-step", { exitCode: 0, stdout: "NODE_HAVE v18.20.4\nNODE_INSTALLED v22.23.2\n", stderr: "" }]]);
    const i = stageRecorder();
    await prepareBuilder({ backend: installed.backend, setup: "true", fetch: installed.fetch, onStage: i.onStage, import: importOf({ node, agents }) });
    expect(i.stages).toContain("installing-harness:Node v22.23.2 installed for Pi (the base had v18)");

    const failed = backendFor([["node-step", { exitCode: 22, stdout: "NODE_HAVE v18.20.4\n", stderr: "curl: (22) The requested URL returned error: 404" }]]);
    const f = stageRecorder();
    const results: ImportResult[] = [];
    const b3 = await prepareBuilder({ backend: failed.backend, setup: "true", fetch: failed.fetch, onStage: f.onStage, import: importOf({ node, agents, onResult: r => void results.push(r) }) });
    expect(f.stages).toContain("installing-harness:Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404");
    expect(failed.cmds.some(c => c.includes("pi-install"))).toBe(false);
    expect(failed.cmds.some(c => c.includes("codex-install"))).toBe(true);
    expect(results[0]!.agents).toEqual([
      { id: "agents/codex", name: "Codex", outcome: "installed", ms: expect.any(Number) },
      { id: "agents/pi", name: "Pi", outcome: "failed", note: "Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404", ms: 0 },
    ]);
    expect(b3.import?.smoke).toBe("codex --version");
  });

  it("a failure's reason is Homebrew's Error: line, not the advice line that follows it", async () => {
    const { backend, fetch } = backendFor([
      ["brew install gh", { exitCode: 1, stdout: "==> Fetching downloads for: gh\n", stderr: "Error: gh: A `brew install gh` process has already locked /home/linuxbrew/.linuxbrew/Cellar/gcc.\nPlease wait for it to finish or terminate it to continue.\n" }],
    ]);
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ onResult: r => void results.push(r) }) });
    expect(results[0]!.tools[1]!.note).toBe("Error: gh: A `brew install gh` process has already locked /home/linuxbrew/.linuxbrew/Cellar/gcc.");
  });

  it("an agent set aside at plan time lands in the result as skipped, counts as ticked for the zero check, and is named in the detail", async () => {
    const aside = [{ id: "agents/zed", name: "Zed", note: "no installer known" }];
    const { backend, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const b = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ skippedAgents: aside, onResult: r => void results.push(r) }) });
    expect(results[0]!.agents[0]).toEqual({ id: "agents/zed", name: "Zed", outcome: "skipped", note: "no installer known" });
    expect(stages.at(-2)).toBe("installing-harness:Claude Code, Codex installed; Zed skipped (no installer known)");
    expect(b.import?.smoke).toBe("claude --version && codex --version");

    const only = backendFor();
    const rec = stageRecorder();
    await expect(prepareBuilder({ backend: only.backend, setup: "true", fetch: only.fetch, onStage: rec.onStage, import: importOf({ agents: [], skippedAgents: aside }) })).rejects.toThrow(/no agent installed/);
    expect(rec.stages.at(-1)).toBe("failed:no agent installed, so there is nothing to seal:\nZed: no installer known");
    expect(only.killed).toEqual(["m1"]);
  });

  it("when Homebrew itself fails, every brew formula is skipped rather than tried", async () => {
    const { backend, cmds, fetch } = backendFor([["brew-bootstrap", { exitCode: 1, stdout: "", stderr: "git: not found" }]]);
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages).toContain("installing-tools:1 installed, 1 failed: Homebrew (git: not found), 1 skipped");
  });

  it("stops installing tools when the disk drops under the floor kept for the agents", async () => {
    let dfCalls = 0;
    const { backend, cmds, fetch } = backendFor([], () => mb(++dfCalls <= 2 ? 2000 : 500));
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(cmds.some(c => c.includes("brew-bootstrap"))).toBe(true);
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages).toContain("installing-tools:1 installed, 2 skipped (500 MB free, keeping 800 MB for the agents)");
  });

  it("refuses to upload when the archive and its contents would not fit, kills the builder, and says why", async () => {
    const { backend, killed, puts, fetch } = backendFor([], mb(100));
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() })).rejects.toThrow(/1\.2 KB packed and 4\.0 KB unpacked.*256 MB.*100 MB free/);
    expect(puts).toEqual([]);
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toMatch(/^failed:your files need 1\.2 KB packed and 4\.0 KB unpacked, plus 256 MB of headroom, but the machine has 100 MB free/);
    // The check reads the archive, not the recipe's estimate: a small tar of a large estimate still fits.
    const roomy = backendFor([], mb(2000));
    await expect(prepareBuilder({ backend: roomy.backend, setup: "true", fetch: roomy.fetch, import: importOf({ files: { ...importOf().files!, bytes: 10 * 1024 * 1024 * 1024 } }) })).resolves.toBeDefined();
  });

  it("a df that fails is a warning that names itself, once per stage, and the build goes on", async () => {
    const { backend, cmds, puts, fetch } = backendFor([[FREE_KB_CMD, { exitCode: 1, stdout: "", stderr: "df: /root: No such file or directory" }]]);
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(stages).toContain("uploading-files:free disk unknown (df failed: df: /root: No such file or directory); uploading 1.2 KB anyway");
    expect(stages.filter(s => s.startsWith("installing-tools:free disk unknown"))).toEqual(["installing-tools:free disk unknown (df failed: df: /root: No such file or directory); installing without the 800 MB floor"]);
    expect(puts).toHaveLength(1);
    expect(cmds.filter(c => c.includes("brew install gh") || c.includes("brew-bootstrap") || c.includes("bun@1.4.0"))).toHaveLength(3);
    expect(builder.import?.applied).toContain("installing-harness");
  });

  it("a tool waits on the install it needs: a manager that did not install skips its rows with the manager's name", async () => {
    const tools: ToolInstall[] = [
      { id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: "brew-bootstrap" },
      { id: "tools/manager/pipx", label: "pipx", manager: "brew", cmd: "brew install pipx", after: "tools/homebrew" },
      { id: "tools/pipx/black", label: "black 24.1.0", manager: "pipx", cmd: "pipx install black==24.1.0", after: "tools/manager/pipx" },
      { id: "tools/npm/bun", label: "bun@1.4.0", manager: "npm", cmd: "npm install -g bun@1.4.0" },
    ];
    const { backend, cmds, fetch } = backendFor([["brew install pipx", { exitCode: 1, stdout: "", stderr: "Error: pipx: no bottle" }]]);
    const results: ImportResult[] = [];
    await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ tools, onResult: r => void results.push(r) }) });
    expect(cmds.some(c => c.includes("pipx install black"))).toBe(false);
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/manager/pipx", "failed", "Error: pipx: no bottle"],
      ["tools/pipx/black", "skipped", "pipx did not install"],
      ["tools/npm/bun", "installed", undefined],
    ]);
  });

  it("a failure packing or extracting the files is fatal with its reason", async () => {
    const packFails = importOf({ files: { count: 1, rungs: { shell: 1 }, bytes: 10, skipped: [], pack: async () => { throw new Error("Keychain: user cancelled"); } } });
    const a = backendFor();
    await expect(prepareBuilder({ backend: a.backend, setup: "true", fetch: a.fetch, import: packFails })).rejects.toThrow(/Keychain: user cancelled/);
    expect(a.killed).toEqual(["m1"]);

    const b = backendFor([["tar xzf", { exitCode: 2, stdout: "", stderr: "gzip: stdin: not in gzip format" }]]);
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend: b.backend, setup: "true", fetch: b.fetch, onStage, import: importOf() })).rejects.toThrow(/not in gzip format/);
    expect(stages.at(-1)).toMatch(/^failed:vault import untar failed/);
    expect(b.killed).toEqual(["m1"]);
  });

  it("with nothing ticked the file stages still report, and no agent means a smoke of true", async () => {
    const { backend, cmds, puts, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: { recipeHash: "h0", tools: [], agents: [] } });
    expect(stages).toEqual([
      "creating:sandbox from base",
      "applying-setup:nothing ticked",
      "uploading-files:nothing to upload",
      "installing-tools:nothing ticked",
      "installing-harness",
      "installing-harness:no agent ticked",
      "ready",
    ]);
    expect(puts).toEqual([]);
    expect(cmds).toEqual(["true"]);
    expect(builder.import?.smoke).toBe("true");

    let result: ImportResult | undefined;
    const gone = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ files: { count: 0, rungs: {}, bytes: 0, skipped: [{ id: "shell/zshrc", path: "~/.zshrc", note: "no longer on this computer" }], pack: async () => { throw new Error("must not pack"); } }, onResult: r => (result = r) }) });
    expect(stages).toContain("applying-setup:nothing left to pack; skipped ~/.zshrc (no longer on this computer)");
    expect(gone.import?.applied).toContain("uploading-files");
    // No pack ran, so nothing was cut: the result says nothing about it rather than claiming an empty cut.
    expect(result?.files).toEqual({ bytes: 0, skipped: [{ id: "shell/zshrc", path: "~/.zshrc", note: "no longer on this computer" }] });
    expect(result?.files).not.toHaveProperty("cut");
  });

  it("applying the same recipe again to a builder that has it skips every stage and runs nothing", async () => {
    const { backend, cmds, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = cmds.length;
    const { stages, onStage } = stageRecorder();
    const again = await applyGoldenImport(builder.machine, { import: importOf(), setup: "true", ledger: builder.import, fetch, onStage });
    expect(cmds.length).toBe(before);
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:already applied",
      "installing-tools:already applied",
      "installing-harness:already applied",
    ]);
    expect(again.ledger).toEqual(builder.import);
    // Nothing ran, so there is no result to report; the saved list from the first run stands.
    const results: ImportResult[] = [];
    await applyGoldenImport(builder.machine, { import: importOf({ onResult: r => void results.push(r) }), setup: "true", ledger: builder.import, fetch });
    expect(results).toEqual([]);

    const other = await applyGoldenImport(builder.machine, { import: importOf({ recipeHash: "h2" }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(cmds.length).toBeGreaterThan(before);
    expect(other.ledger.recipeHash).toBe("h2");
  });

  it("without an import the harness path is unchanged", async () => {
    const { backend } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "echo setup", onStage });
    expect(stages).toEqual(["creating:sandbox from base", "installing-harness", "ready"]);
    expect(builder.import).toBeUndefined();
    expect(builder.setupSha).toBe(createHash("sha256").update("echo setup").digest("hex"));
  });
});
