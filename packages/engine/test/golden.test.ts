import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editorInstallsFor, recipeDigest, toolInstallsFor, type BrewTable, type RecipeEntry } from "../src/golden-import.js";
import { diffRecipes, removalsFor, rowsToApply } from "../src/golden-diff.js";
import { BUILDER_IDLE_MS, MachineAliveError, applyDelta, applyGoldenImport, buildGolden, forkGolden, nextSetupSha, nextSmoke, prepareBuilder, rollback, sealGolden, upgradeBuilder, type GoldenDelta, type GoldenImport, type GoldenStage, type GoldenVersion, type ImportResult, type PackedFiles } from "../src/golden.js";
import { BUILDER_DISK_GB } from "../src/tool-sizes.js";
import type { RecipeDigest } from "@wsp/protocol";
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
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: false },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" } },
    async create(spec) {
      created.push(spec);
      const id = `m${++nextId}`;
      timeline.push(`create ${id}`);
      const machine: Machine = {
        id, kind: spec.kind, streamUrl: spec.kind === "desktop" ? `wss://fake/stream/${id}` : undefined,
        exec: async (cmd) => opts.exec?.(cmd) ?? execResults[cmd] ?? (cmd === "echo ok" ? REACH_OK : { exitCode: 0, stdout: "", stderr: "" }),
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
/** What a machine that still serves answers the reach check with. */
const REACH_OK: ExecResult = { exitCode: 0, stdout: "ok\n", stderr: "" };

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
    expect(created[0]).toMatchObject({ kind: "sandbox", template: "base", onIdle: "kill", diskGb: 20 });
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

describe("golden disk", () => {
  it("every create asks for the 20 GB disk: the builder, the smoke fork, a workspace fork and an upgrade fork", async () => {
    const { backend, created } = recordingBackend();
    const builder = await prepareBuilder({ backend, setup: "true" });
    const { manifest, version } = await sealGolden(builder, { backend, smoke: "true" });
    await forkGolden(backend, manifest);
    await upgradeBuilder({ backend, head: version, delta: { import: { recipeHash: "h2", tools: [], agents: [] }, removals: [] }, setup: "true" });
    expect(created.map(c => c.diskGb)).toEqual([BUILDER_DISK_GB, BUILDER_DISK_GB, BUILDER_DISK_GB, BUILDER_DISK_GB]);
    expect(BUILDER_DISK_GB).toBe(20);
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
  function backendFor(answers: [string, ExecResult | (() => ExecResult)][] = [], free: string | (() => string) = mb(3000)) {
    const cmds: string[] = [];
    const puts: Buffer[] = [];
    const rb = recordingBackend({}, {
      exec: cmd => {
        cmds.push(cmd);
        const hit = answers.find(([needle]) => cmd.includes(needle));
        if (hit) return typeof hit[1] === "function" ? hit[1]() : hit[1];
        if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${typeof free === "function" ? free() : free}\n`, stderr: "" };
        if (cmd === "echo ok") return REACH_OK;
        return ok;
      },
    });
    const fetchStub: typeof fetch = async (_url, init) => {
      puts.push(Buffer.from(init?.body as Uint8Array));
      return new Response(null, { status: 200 });
    };
    return { ...rb, cmds, puts, fetch: fetchStub };
  }

  it("editor steps run in the tools stage under the guard: apt for neovim, the pinned helix tarball, and the extension list written as a file", async () => {
    const { backend, cmds, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const editors = editorInstallsFor([
      { rung: "editors", id: "editors/nvim", label: "neovim, installed with your config", paths: ["~/.config/nvim"], bytes: 10, default: "bring", bring: true },
      { rung: "editors", id: "editors/helix", label: "helix, installed", paths: [], bytes: 0, default: "bring", bring: true },
      { rung: "editors", id: "editors/vscode-ext/ms-python.python", label: "ms-python.python", paths: [], bytes: 0, default: "skip", bring: true },
    ]);
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: [...editors.installs, ...importOf().tools], onResult: r => void results.push(r) }) });
    expect(stages.filter(s => s.startsWith("installing-tools"))).toEqual([
      "installing-tools:neovim (1/6)", "installing-tools:helix (2/6)", "installing-tools:VS Code extension list (3/6)",
      "installing-tools:Homebrew (4/6)", "installing-tools:gh (5/6)", "installing-tools:bun@1.4.0 (6/6)",
      "installing-tools:6 installed",
    ]);
    const nvim = cmds.find(c => c.includes("apt-get install -y -qq neovim"))!;
    expect(nvim).toMatch(/\nsetsid bash -c 'set -euo pipefail\n/);
    expect(nvim).toMatch(/while \[ \$t -lt 600 \]/);
    const helix = cmds.find(c => c.includes("helix-editor/helix/releases/download"))!;
    expect(helix).toContain("sha256sum -c -");
    expect(helix).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    const list = cmds.find(c => c.includes(".vscode-server/extensions.txt"))!;
    expect(list).toContain(`'\\''ms-python.python'\\'' > "$HOME/.vscode-server/extensions.txt"`);
    expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([
      ["editors/nvim", "installed"], ["editors/helix", "installed"], ["editors/vscode-ext", "installed"],
      ["tools/homebrew", "installed"], ["tools/brew/gh", "installed"], ["tools/npm/bun", "installed"],
    ]);
  });

  it("an archive over one upload part says how many parts it went up in", async () => {
    const { backend, puts, fetch } = backendFor();
    const stages: string[] = [];
    const big = importOf({ files: { ...importOf().files!, pack: async () => ({ tar: Buffer.alloc(33 * 1024 * 1024), bytes: 33 * 1024 * 1024, unpacked: 4096, skipped: [], cut: [] }) } });
    await prepareBuilder({ backend, setup: "true", fetch, onStage: (s, d) => void stages.push(`${s}:${d ?? ""}`), import: big });
    expect(puts).toHaveLength(2);
    expect(stages).toContainEqual("uploading-files:part 1 of 2, 32 MB of 33 MB");
    expect(stages).toContainEqual("uploading-files:part 2 of 2, 33 MB of 33 MB");
    expect(stages).toContainEqual(expect.stringMatching(/^uploading-files:33 MB in 2 parts in \d+(\.\d)?s$/));
  });

  it("runs setup, upload, agents and then tools in order after the daemon, with a detail on every frame, and checks the machine still answers", async () => {
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
      "installing-harness",
      "installing-harness:Claude Code (1/2)", "installing-harness:Codex (2/2)",
      "installing-harness:Claude Code, Codex installed",
      "installing-tools:Homebrew (1/3)", "installing-tools:gh (2/3)", "installing-tools:bun@1.4.0 (3/3)",
      "installing-tools:3 installed",
      "installing-mcp:none configured",
      "ready",
    ]);
    expect(puts).toEqual([Buffer.from("tgz-bytes")]);
    const untar = cmds.find(c => c.includes("tar xzf"))!;
    expect(untar).toMatch(/-C '\/root' --no-same-owner/);
    expect(cmds.indexOf(FREE_KB_CMD)).toBeLessThan(cmds.indexOf(untar));
    const tool = cmds.find(c => c.includes("brew install gh"))!;
    expect(tool).toMatch(/\nsetsid bash -c 'brew install gh' &\np=\$!\n/);
    expect(tool).toMatch(/while \[ \$t -lt 600 \]/);
    expect(cmds.filter(c => c.includes("brew install gh") || c.includes("brew-bootstrap") || c.includes("bun@1.4.0"))).toHaveLength(3);
    const agent = cmds.find(c => c.includes("codex-install"))!;
    expect(agent).toMatch(/\nsetsid bash -c 'set -euo pipefail\nexport PATH="\/usr\/local\/bin:\$PATH"\n/);
    expect(agent).toMatch(/while \[ \$t -lt 900 \]/);
    // Agents and their checks run with the Node the golden installed ahead of any the image shipped.
    expect(cmds).toContain('export PATH="/usr/local/bin:$PATH"\nclaude --version');
    expect(cmds).toContain('export PATH="/usr/local/bin:$PATH"\ncodex --version');
    expect(cmds.indexOf("true")).toBeLessThan(cmds.indexOf(agent));
    // Agents are the point and tools the long tail: the agents go on first, so a tools stage that fills the disk cannot starve them.
    expect(cmds.indexOf(agent)).toBeLessThan(cmds.indexOf(tool));
    // The reach check is the last thing on the machine before the hand-off.
    expect(cmds.at(-1)).toBe("echo ok");
    expect(builder.import).toEqual({ recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "claude --version && codex --version" });
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

  it("the shell step runs after the pack and before the files land, guarded on the guest, and names what it did on the setup frame", async () => {
    const { backend, cmds, fetch } = backendFor();
    const { stages, onStage } = stageRecorder();
    const shell = { shell: "zsh" as const, frameworks: ["shell/oh-my-zsh", "shell/antidote"], cmd: "set -euo pipefail\ninstall-zsh-and-frameworks" };
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ shell }) });
    const step = cmds.find(c => c.includes("install-zsh-and-frameworks"))!;
    expect(step).toMatch(/\nsetsid bash -c 'set -euo pipefail\ninstall-zsh-and-frameworks' &\np=\$!\n/);
    expect(step).toContain("while [ $t -lt 300 ]");
    const untar = cmds.find(c => c.includes("tar xzf"))!;
    expect(cmds.indexOf(step)).toBeLessThan(cmds.indexOf(untar));
    expect(cmds.indexOf(step)).toBeLessThan(cmds.indexOf(cmds.find(c => c.includes("claude-install"))!));
    expect(stages.slice(stages.indexOf("applying-setup:1.2 KB packed; skipped ~/.bashrc (no longer on this computer)"), stages.indexOf("uploading-files:1.2 KB") + 1)).toEqual([
      "applying-setup:1.2 KB packed; skipped ~/.bashrc (no longer on this computer)",
      "applying-setup:zsh: installing, with shell/oh-my-zsh, shell/antidote",
      "applying-setup:zsh installed as the login shell; shell/oh-my-zsh, shell/antidote reinstalled",
      "uploading-files:1.2 KB",
    ]);
  });

  it("a shell step that fails is a warning on the setup frame with its reason; the files still land and the build goes on", async () => {
    const { backend, cmds, fetch } = backendFor([["install-zsh", { exitCode: 100, stdout: "", stderr: "E: Unable to locate package zsh\n" }]]);
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ shell: { shell: "zsh", frameworks: [], cmd: "install-zsh" } }) });
    expect(stages).toContain("applying-setup:zsh step failed, chsh skipped: E: Unable to locate package zsh");
    expect(cmds.some(c => c.includes("tar xzf"))).toBe(true);
    expect(stages.at(-1)).toBe("ready");
    expect(builder.import?.applied).toContain("uploading-files");
  });

  it("a builder that already carries the files does not run the shell step again", async () => {
    const { backend, cmds, fetch } = backendFor();
    const imp = importOf({ shell: { shell: "zsh", frameworks: [], cmd: "install-zsh" } });
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: imp });
    expect(cmds.filter(c => c.includes("install-zsh"))).toHaveLength(1);
    await applyGoldenImport(builder.machine, { import: imp, setup: "true", ledger: builder.import, fetch });
    expect(cmds.filter(c => c.includes("install-zsh"))).toHaveLength(1);
  });

  it("a tool that fails is a warning in the detail and the next one still runs; the build and the seal go on", async () => {
    const { backend, fetch } = backendFor([
      // stdout ends on a progress line; the reason is the last stderr line, not that.
      ["brew install gh", { exitCode: 1, stdout: "==> Installing gh dependency: oniguruma\n", stderr: "Error: gh: no bottle available!\n" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(stages).toContain("installing-tools:2 installed, 1 failed: gh (Error: gh: no bottle available!)");
    expect(results[0]!.tools[1]).toEqual({ id: "tools/brew/gh", label: "gh", outcome: "failed", note: "Error: gh: no bottle available!", ms: expect.any(Number) });
    const { version } = await sealGolden(builder, { backend, smoke: "should-not-run" });
    expect(version.smoke.cmd).toBe("claude --version && codex --version");
  });

  it("a road install names the road it took: the result carries it and the stage summary says so", async () => {
    const { backend, fetch } = backendFor([
      ["releases/tags/v0.1.0", { exitCode: 0, stdout: `WSP_ROAD release diskbloom_0.1.0_linux_amd64.tar.gz ${"a".repeat(64)} v0.1.0\n`, stderr: "" }],
      ["releases/tags/v1.13.1", { exitCode: 0, stdout: "go: downloading\nWSP_ROAD go github.com/TheZoraiz/ascii-image-converter@v1.13.1\n", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const roads = [
      { id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", manager: "github" as const, cmd: "curl https://api.github.com/repos/Zingzy/diskbloom/releases/tags/v0.1.0" },
      { id: "tools/brew/thezoraiz/ascii-image-converter/ascii-image-converter", label: "ascii-image-converter", manager: "github" as const, cmd: "curl https://api.github.com/repos/TheZoraiz/ascii-image-converter/releases/tags/v1.13.1" },
    ];
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ tools: [...importOf().tools, ...roads], onResult: r => void results.push(r) }) });
    expect(stages).toContain("installing-tools:5 installed (diskbloom from the GitHub release, ascii-image-converter with go install)");
    expect(results[0]!.tools.slice(3)).toEqual([
      { id: roads[0]!.id, label: "diskbloom", outcome: "installed", road: { kind: "release", from: "diskbloom_0.1.0_linux_amd64.tar.gz", sha256: "a".repeat(64), tag: "v0.1.0" }, ms: expect.any(Number) },
      { id: roads[1]!.id, label: "ascii-image-converter", outcome: "installed", road: { kind: "go", from: "github.com/TheZoraiz/ascii-image-converter@v1.13.1" }, ms: expect.any(Number) },
    ]);
    // A brew install carries no road: it took the one its plan named.
    expect(results[0]!.tools[1]).not.toHaveProperty("road");
  });

  it("an agent that fails refuses the seal with the installer's reason, kills the builder, reports the result, and never starts the tools", async () => {
    const { backend, cmds, killed, fetch } = backendFor([["codex-install", { exitCode: 124, stdout: "", stderr: "" }]]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/an agent did not install/);
    expect(stages.at(-1)).toBe("failed:an agent did not install, so nothing is sealed:\nCodex: timed out after 900s");
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.agents).toEqual([
      { id: "agents/claude", name: "Claude Code", outcome: "installed", ms: expect.any(Number) },
      { id: "agents/codex", name: "Codex", outcome: "failed", note: "timed out after 900s", ms: expect.any(Number) },
    ]);
    expect(cmds.some(c => c.includes("brew-bootstrap") || c.includes("brew install gh") || c.includes("bun@1.4.0"))).toBe(false);
  });

  it("when every ticked agent fails the build stops, names each agent and its reason, kills the builder, and still reports the result", async () => {
    const { backend, killed, fetch } = backendFor([
      ["claude-install", { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host" }],
      ["codex-install", { exitCode: 124, stdout: "", stderr: "" }],
    ]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/2 agents did not install/);
    expect(stages.at(-1)).toBe(["failed:2 agents did not install, so nothing is sealed:", "Claude Code: curl: (6) Could not resolve host", "Codex: timed out after 900s"].join("\n"));
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.agents.map(a => a.outcome)).toEqual(["failed", "failed"]);
  });

  it("a machine that stops answering after the installs is not sealed: the builder is killed and the result still reported", async () => {
    const { backend, cmds, killed, fetch } = backendFor([["echo ok", { exitCode: 1, stdout: "", stderr: "" }]]);
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow(/stopped answering commands after the installs \(exit 1\)/);
    expect(stages.at(-1)).toBe("failed:the machine stopped answering commands after the installs (exit 1); nothing is sealed");
    expect(killed).toEqual(["m1"]);
    expect(results[0]!.tools.map(t => t.outcome)).toEqual(["installed", "installed", "installed"]);
    // Every install ran before the check; the check is what the hand-off would have trusted.
    expect(cmds.indexOf("echo ok")).toBeGreaterThan(cmds.findIndex(c => c.includes("bun@1.4.0")));
    // A machine that answers with exit 0 and the wrong words is not serving either.
    const mute = backendFor([["echo ok", { exitCode: 0, stdout: "", stderr: "" }]]);
    await expect(prepareBuilder({ backend: mute.backend, setup: "true", fetch: mute.fetch, import: importOf() })).rejects.toThrow(/stopped answering commands after the installs \(exit 0\)/);
  });

  it("the Node step runs once before the agents: kept when the guest meets the floor, installed and said so when not, and a failure fails the agents above the guest's major and with them the seal", async () => {
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
      "installing-harness:Codex (1/2)", "installing-harness:Pi (2/2)", "installing-harness:Codex, Pi installed",
      "installing-tools:Homebrew (1/3)", "installing-tools:gh (2/3)", "installing-tools:bun@1.4.0 (3/3)", "installing-tools:3 installed", "installing-mcp:none configured", "ready",
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
    await expect(prepareBuilder({ backend: failed.backend, setup: "true", fetch: failed.fetch, onStage: f.onStage, import: importOf({ node, agents, onResult: r => void results.push(r) }) })).rejects.toThrow(/an agent did not install/);
    expect(f.stages).toContain("installing-harness:Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404");
    expect(f.stages.at(-1)).toBe("failed:an agent did not install, so nothing is sealed:\nPi: Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404");
    expect(failed.cmds.some(c => c.includes("pi-install"))).toBe(false);
    expect(failed.cmds.some(c => c.includes("codex-install"))).toBe(true);
    expect(results[0]!.agents).toEqual([
      { id: "agents/codex", name: "Codex", outcome: "installed", ms: expect.any(Number) },
      { id: "agents/pi", name: "Pi", outcome: "failed", note: "Node 22.23.2 did not install: curl: (22) The requested URL returned error: 404", ms: 0 },
    ]);
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
    expect(stages).toContain("installing-harness:Claude Code, Codex installed; Zed skipped (no installer known)");
    expect(b.import?.smoke).toBe("claude --version && codex --version");

    const only = backendFor();
    const rec = stageRecorder();
    await expect(prepareBuilder({ backend: only.backend, setup: "true", fetch: only.fetch, onStage: rec.onStage, import: importOf({ agents: [], skippedAgents: aside }) })).rejects.toThrow(/no agent installed/);
    expect(rec.stages.at(-1)).toBe("failed:no agent installed, so there is nothing to seal:\nZed: no installer known");
    expect(only.killed).toEqual(["m1"]);
  });

  it("an agent does not start under the agents' floor: it is recorded failed with the reading, which ends the build as any missing agent does", async () => {
    let agentsStarted = false;
    const { backend, cmds, killed, fetch } = backendFor([["claude-install", () => ((agentsStarted = true), ok)]], () => mb(agentsStarted ? 500 : 3000));
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) })).rejects.toThrow("an agent did not install, so nothing is sealed:\nCodex: 500 MB free, keeping 800 MB free");
    expect(results[0]!.agents.map(a => [a.id, a.outcome, a.note])).toEqual([
      ["agents/claude", "installed", undefined],
      ["agents/codex", "failed", "500 MB free, keeping 800 MB free"],
    ]);
    expect(cmds.some(c => c.includes("codex-install"))).toBe(false);
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toBe("failed:an agent did not install, so nothing is sealed:\nCodex: 500 MB free, keeping 800 MB free");
  });

  it("when Homebrew itself fails, every brew formula is skipped rather than tried", async () => {
    const { backend, cmds, fetch } = backendFor([["brew-bootstrap", { exitCode: 1, stdout: "", stderr: "git: not found" }]]);
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages).toContain("installing-tools:1 installed, 1 failed: Homebrew (git: not found), 1 skipped");
    // No Homebrew, nothing of its to clean.
    expect(cmds.some(c => c.includes("brew autoremove") || c.includes("brew cleanup"))).toBe(false);
  });

  it("a tool that hits its timeout is recorded failed with the seconds, the guard kills its session and every descendant before the next tool, and the next tool runs", async () => {
    const { backend, cmds, fetch } = backendFor([["brew install gh", { exitCode: 124, stdout: "==> Downloading gh\n", stderr: "" }]]);
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(results[0]!.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["tools/homebrew", "installed", undefined],
      ["tools/brew/gh", "failed", "timed out after 600s"],
      ["tools/npm/bun", "installed", undefined],
    ]);
    expect(stages).toContain("installing-tools:2 installed, 1 failed: gh (timed out after 600s)");
    const guard = cmds.find(c => c.includes("brew install gh"))!;
    // The install runs in its own session; at the timeout that session's group and everything descended from it
    // (found through /proc by parent pid, since su starts its command in a session of its own) get TERM, then KILL.
    expect(guard).toMatch(/^tree\(\) \{\n/);
    expect(guard).toContain("for f in /proc/[0-9]*/stat");
    expect(guard).toMatch(/\nsetsid bash -c '.*' &\np=\$!\n/s);
    expect(guard).toContain('v="$p $(tree $p)"\n  kill -TERM -- -$p $v');
    expect(guard).toContain("kill -KILL -- -$p $v");
    // The guard returns 124 only once the tree is gone, so the next brew never meets a lock the last one still holds.
    expect(guard).toMatch(/kill -KILL[^\n]*\n\s+t=0; while \[ \$t -lt 10 \] && kill -0 \$v[^\n]*\n\s+exit 124\n/);
    expect(guard).not.toMatch(/pkill|killall/);
  });

  it("a cellar lock error waits once for every Homebrew lock to clear, then tries the tool once more", async () => {
    let tries = 0;
    const locked = { exitCode: 1, stdout: "", stderr: "Error: A `brew install glibc` process has already locked /home/linuxbrew/.linuxbrew/Cellar/linux-headers@6.8.\nPlease wait for it to finish or terminate it to continue." };
    const { backend, cmds, fetch } = backendFor([["brew install gh", () => (++tries === 1 ? locked : ok)]]);
    const results: ImportResult[] = [];
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf({ onResult: r => void results.push(r) }) });
    expect(tries).toBe(2);
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    const wait = cmds.find(c => c.includes("flock -w"))!;
    expect(wait).toBe('for l in /home/linuxbrew/.linuxbrew/var/homebrew/locks/*.lock; do [ -e "$l" ] && flock -w 600 "$l" true; done; true');
    expect(cmds.filter(c => c.includes("flock -w"))).toHaveLength(1);
    expect(at("brew install gh")).toBeLessThan(at("flock -w"));
    expect(cmds.lastIndexOf(cmds.find(c => c.includes("brew install gh"))!)).toBeGreaterThan(at("flock -w"));
    expect(stages).toContain("installing-tools:gh: another brew holds its cellar; waiting for it, then once more");
    expect(results[0]!.tools.find(t => t.id === "tools/brew/gh")).toMatchObject({ outcome: "installed" });
    // A second lock error is the tool's failure, with Homebrew's line as the reason.
    const again = backendFor([["brew install gh", locked]]);
    const more: ImportResult[] = [];
    await prepareBuilder({ backend: again.backend, setup: "true", fetch: again.fetch, import: importOf({ onResult: r => void more.push(r) }) });
    expect(again.cmds.filter(c => c.includes("flock -w"))).toHaveLength(1);
    expect(again.cmds.filter(c => c.includes("brew install gh"))).toHaveLength(2);
    expect(more[0]!.tools.find(t => t.id === "tools/brew/gh")).toMatchObject({ outcome: "failed", note: "Error: A `brew install glibc` process has already locked /home/linuxbrew/.linuxbrew/Cellar/linux-headers@6.8." });
  });

  it("after the loop Homebrew autoremoves then cleans up, both guarded, and the detail says what that freed; archives a failed export left in /tmp go before the first tool", async () => {
    let cleaned = false;
    const { backend, cmds, fetch } = backendFor(
      [["brew cleanup -s --prune=all", () => ((cleaned = true), ok)]],
      () => mb(cleaned ? 4000 : 3000),
    );
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    const at = (needle: string) => cmds.findIndex(c => c.includes(needle));
    const autoremove = cmds[at("brew autoremove")]!;
    expect(autoremove).toMatch(/^tree\(\) \{\n/);
    expect(autoremove).toMatch(/\nsetsid bash -c 'export PATH=.*su -s \/bin\/bash linuxbrew -c .*brew autoremove.* &\np=\$!\n/s);
    expect(autoremove).not.toContain("HOMEBREW_NO_INSTALL_CLEANUP");
    expect(at("bun@1.4.0")).toBeLessThan(at("brew autoremove"));
    expect(at("brew autoremove")).toBeLessThan(at("brew cleanup -s --prune=all"));
    expect(at("brew cleanup -s --prune=all")).toBeLessThan(cmds.indexOf("echo ok"));
    expect(stages).toContain("installing-tools:3 installed; Homebrew cleanup freed 1000 MB");
    const sweep = cmds.indexOf("rm -f /tmp/wsp-vault-*.tgz");
    expect(sweep).toBeGreaterThan(at("tar xzf"));
    expect(sweep).toBeLessThan(at("brew-bootstrap"));
    // A cleanup that fails is named, and the tools it followed still count.
    const failing = backendFor([["brew cleanup -s --prune=all", { exitCode: 1, stdout: "", stderr: "Error: Permission denied @ apply2files" }]]);
    const rec = stageRecorder();
    await prepareBuilder({ backend: failing.backend, setup: "true", fetch: failing.fetch, onStage: rec.onStage, import: importOf() });
    expect(rec.stages).toContain("installing-tools:3 installed; Homebrew cleanup failed (Error: Permission denied @ apply2files)");
  });

  it("stops installing tools when the disk drops under the tools floor", async () => {
    let dfCalls = 0;
    // The upload, the two agents and Homebrew read a roomy disk; the first formula reads it low.
    const { backend, cmds, fetch } = backendFor([], () => mb(++dfCalls <= 4 ? 3000 : 500));
    const { stages, onStage } = stageRecorder();
    await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(cmds.some(c => c.includes("brew-bootstrap"))).toBe(true);
    expect(cmds.some(c => c.includes("brew install gh"))).toBe(false);
    expect(stages).toContain("installing-tools:1 installed, 2 skipped (500 MB free, keeping 2048 MB free)");
    // The floor stops installs, not the housekeeping that gives the disk back.
    expect(cmds.some(c => c.includes("brew cleanup -s --prune=all"))).toBe(true);
  });

  it("refuses to upload when the archive and its contents would not fit, kills the builder, and says why", async () => {
    const { backend, killed, puts, fetch } = backendFor([], mb(100));
    const { stages, onStage } = stageRecorder();
    await expect(prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() })).rejects.toThrow(/1\.2 KB packed and 4\.0 KB unpacked.*256 MB.*100 MB free/);
    expect(puts).toEqual([]);
    expect(killed).toEqual(["m1"]);
    expect(stages.at(-1)).toMatch(/^failed:your files need 1\.2 KB packed and 4\.0 KB unpacked, plus 256 MB of headroom, but the machine has 100 MB free/);
    // The check reads the archive, not the recipe's estimate: a small tar of a large estimate still fits.
    const roomy = backendFor([], mb(3000));
    await expect(prepareBuilder({ backend: roomy.backend, setup: "true", fetch: roomy.fetch, import: importOf({ files: { ...importOf().files!, bytes: 10 * 1024 * 1024 * 1024 } }) })).resolves.toBeDefined();
  });

  it("a df that fails is a warning that names itself, once per stage, and the build goes on", async () => {
    const { backend, cmds, puts, fetch } = backendFor([[FREE_KB_CMD, { exitCode: 1, stdout: "", stderr: "df: /root: No such file or directory" }]]);
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, onStage, import: importOf() });
    expect(stages).toContain("uploading-files:free disk unknown (df failed: df: /root: No such file or directory); uploading 1.2 KB anyway");
    expect(stages.filter(s => s.startsWith("installing-tools:free disk unknown"))).toEqual(["installing-tools:free disk unknown (df failed: df: /root: No such file or directory); installing without the 2048 MB floor"]);
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
      "installing-harness",
      "installing-harness:no agent ticked",
      "installing-tools:nothing ticked",
      "installing-mcp:none configured",
      "ready",
    ]);
    expect(puts).toEqual([]);
    // The harness ran, so the machine is asked whether it still answers before the hand-off.
    expect(cmds).toEqual(["true", "echo ok"]);
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
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
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

  it("an attach with an MCP plan runs the config edit and the reach check, and still reports no result: the saved list from the build stands", async () => {
    const { backend, cmds, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = cmds.length;
    const { stages, onStage } = stageRecorder();
    const results: ImportResult[] = [];
    const mcp = { agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: ["/root/.claude-cfg/.claude.json"], format: "claude" as const, keep: ["github"], drop: [] }], aside: [] }], guestHome: "/root", rewrites: [], binDirs: [] };
    await applyGoldenImport(builder.machine, { import: importOf({ mcp, onResult: r => void results.push(r) }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(results).toEqual([]);
    expect(stages.slice(0, 5)).toEqual(["applying-setup:already applied", "uploading-files:already applied", "installing-harness:already applied", "installing-tools:already applied", "installing-mcp:Claude Code 1"]);
    expect(stages.at(-1)).toBe("installing-mcp:github skipped (the config edit did not run (exit 0))");
    expect(cmds.length).toBeGreaterThan(before);
    expect(cmds.at(-1)).toBe("echo ok");
  });

  it("applying the same recipe to a builder that has it uploads its volatile files again, so the golden carries the latest copy; nothing else runs", async () => {
    const { backend, cmds, puts, fetch } = backendFor();
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = { cmds: cmds.length, puts: puts.length };
    const { stages, onStage } = stageRecorder();
    const volatile = {
      paths: ["~/.claude.json", "~/.claude/plugins/installed_plugins.json"],
      pack: async () => ({ tar: Buffer.from("volatile-tgz"), bytes: 300, unpacked: 2048, skipped: [], cut: [] }),
    };
    const results: ImportResult[] = [];
    const again = await applyGoldenImport(builder.machine, { import: importOf({ files: { ...importOf().files!, volatile }, onResult: r => void results.push(r) }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(puts.slice(before.puts).map(b => b.toString())).toEqual(["volatile-tgz"]);
    expect(cmds.slice(before.cmds).filter(c => c.includes("tar xzf"))).toHaveLength(1);
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:2 volatile files, 300 B",
      expect.stringMatching(/^uploading-files:~\/\.claude\.json, ~\/\.claude\/plugins\/installed_plugins\.json re-imported, 300 B in \d+\.\ds$/),
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
    ]);
    expect(again.ledger).toEqual(builder.import);
    // The saved result from the first run stands: a re-import of state files changes no cut and no install.
    expect(results).toEqual([]);
  });

  it("a volatile re-import that fails on attach is reported on the stage and never fails the attach: the ledger stands and nothing else runs", async () => {
    let free = mb(3000);
    const { backend, cmds, puts, fetch } = backendFor([], () => free);
    const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf() });
    const before = { cmds: cmds.length, puts: puts.length };
    // A default recipe leaves about 250 MB free after the install stages, under the 256 MiB upload headroom.
    free = mb(200);
    const volatile = { paths: ["~/.claude.json"], pack: async () => ({ tar: Buffer.from("volatile-tgz"), bytes: 300, unpacked: 2048, skipped: [], cut: [] }) };
    const { stages, onStage } = stageRecorder();
    const again = await applyGoldenImport(builder.machine, { import: importOf({ files: { ...importOf().files!, volatile } }), setup: "true", ledger: builder.import, fetch, onStage });
    expect(puts.length).toBe(before.puts);
    expect(stages).toEqual([
      "applying-setup:already applied",
      "uploading-files:1 volatile file, 300 B",
      expect.stringMatching(/^uploading-files:~\/\.claude\.json not re-imported: your files need 300 B packed and 2\.0 KB unpacked, plus 256 MB of headroom, but the machine has 200 MB free$/),
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
    ]);
    expect(again.ledger).toEqual(builder.import);
    // A pack that throws takes the same road.
    const broken = { paths: ["~/.claude.json"], pack: async (): Promise<PackedFiles> => { throw new Error("EACCES: permission denied"); } };
    const rec = stageRecorder();
    await applyGoldenImport(builder.machine, { import: importOf({ files: { ...importOf().files!, volatile: broken } }), setup: "true", ledger: builder.import, fetch, onStage: rec.onStage });
    expect(rec.stages).toContain("uploading-files:~/.claude.json not re-imported: EACCES: permission denied");
  });

  it("without an import the harness path is unchanged", async () => {
    const { backend } = recordingBackend();
    const { stages, onStage } = stageRecorder();
    const builder = await prepareBuilder({ backend, setup: "echo setup", onStage });
    expect(stages).toEqual(["creating:sandbox from base", "installing-harness", "ready"]);
    expect(builder.import).toBeUndefined();
    expect(builder.setupSha).toBe(createHash("sha256").update("echo setup").digest("hex"));
  });

  describe("golden update", () => {
    const SNAPSHOT: RecipeDigest = { ticks: [], files: [] };
    const head: GoldenVersion = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", kind: "desktop", setupSha: "s1", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "claude --version && gemini --version", exitCode: 0 }, size: { cpu: 2, memMb: 8192 } };
    const deltaOf = (over: Partial<GoldenDelta> = {}): GoldenDelta => ({
      import: importOf({ recipeHash: "h2", recipe: SNAPSHOT, tools: [{ id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "brew install jq" }], agents: [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version" }] }),
      removals: [
        { what: "file", id: "shell/zshrc", label: "~/.zshrc", cmd: "rm -rf -- '/root/.zshrc'" },
        { what: "tool", id: "tools/npm/bun", label: "bun", cmd: "npm uninstall -g bun" },
        { what: "agent", id: "agents/gemini", label: "Gemini CLI", cmd: "npm uninstall -g @google/gemini-cli", smoke: "gemini --version" },
        { what: "agent", id: "agents/claude", label: "Claude Code", note: "Claude Code has no uninstaller; left on the machine", smoke: "claude --version" },
      ],
      ...over,
    });

    it("a seal that keeps the builder snapshots it, boots and kills the fork, and leaves the builder running", async () => {
      const { backend, killed, timeline, fetch } = backendFor();
      const builder = await prepareBuilder({ backend, setup: "true", fetch, import: importOf({ recipe: SNAPSHOT }) });
      const { stages, onStage } = stageRecorder();
      const result = await sealGolden(builder, { backend, smoke: "unused", keepBuilder: true, onStage });
      expect(result.builderKept).toBe(true);
      expect(result.version.version).toBe(1);
      expect(killed).toEqual(["m2"]);
      expect(timeline).toEqual(["create m1", "snapshot m1", "create m2", "kill m2"]);
      expect(stages.at(-1)).toBe("sealed:v1; builder kept for one more change");
      expect(builder.import?.recipe).toEqual(SNAPSHOT);
    });

    it("a seal without the option consumes the builder as before, and says nothing about keeping it", async () => {
      const { backend, killed } = recordingBackend();
      const builder = await prepareBuilder({ backend, setup: "true" });
      const { stages, onStage } = stageRecorder();
      const result = await sealGolden(builder, { backend, smoke: "true", onStage });
      expect(result.builderKept).toBe(false);
      expect(killed).toEqual(["m1", "m2"]);
      expect(stages.at(-1)).toBe("sealed:v1");
    });

    it("when the account cap refuses the fork beside a kept builder, the builder is killed first and the fork tried again", async () => {
      const { backend, killed, timeline } = recordingBackend();
      let refused = false;
      const capped = {
        ...backend,
        create: async (spec: Parameters<typeof backend.create>[0]) => {
          if (spec.fromSnapshot !== undefined && !refused) {
            refused = true;
            throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
          }
          return backend.create(spec);
        },
      };
      const builder = await prepareBuilder({ backend: capped, setup: "true" });
      const { stages, onStage } = stageRecorder();
      const result = await sealGolden(builder, { backend: capped, smoke: "true", keepBuilder: true, onStage });
      expect(result.builderKept).toBe(false);
      expect(killed).toEqual(["m1", "m2"]);
      expect(timeline).toEqual(["create m1", "snapshot m1", "kill m1", "create m2", "kill m2"]);
      expect(stages).toContain("smoke-forking:true; the account is at its machine cap, so the builder is not kept");
      expect(stages.at(-1)).toBe("sealed:v1");
    });

    it("a smoke that fails on a kept builder still kills the builder and drops the snapshot", async () => {
      const { backend, killed, deletedSnapshots } = recordingBackend({ "boom --version": { exitCode: 127, stdout: "", stderr: "not found" } });
      const builder = await prepareBuilder({ backend, setup: "true" });
      await expect(sealGolden(builder, { backend, smoke: "boom --version", keepBuilder: true })).rejects.toThrow(/smoke/);
      expect(killed).toEqual(["m1", "m2"]);
      expect(deletedSnapshots).toEqual(["snap_golden-v1"]);
    });

    it("applyDelta takes the removals off first, one guarded command each with failures and notes in the detail, then runs the delta's stages and folds the smoke", async () => {
      const { backend, cmds, fetch } = backendFor([["npm uninstall -g bun", { exitCode: 1, stdout: "", stderr: "npm ERR! not installed" }]]);
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const { stages, onStage } = stageRecorder();
      const { ledger } = await applyDelta(machine, deltaOf(), { setup: "true", previousSmoke: head.smoke.cmd, fetch, onStage });
      expect(stages.slice(0, 2)).toEqual([
        "applying-setup:removing 4 items",
        "applying-setup:removed ~/.zshrc, Gemini CLI; bun not removed (npm ERR! not installed); Claude Code: Claude Code has no uninstaller; left on the machine",
      ]);
      expect(stages.slice(2)).toEqual([
        "applying-setup:3 files: identity 1, shell 2",
        "applying-setup:1.2 KB packed; skipped ~/.bashrc (no longer on this computer)",
        "uploading-files:1.2 KB",
        expect.stringMatching(/^uploading-files:1\.2 KB in /),
        "installing-harness",
        "installing-harness:Codex (1/1)",
        "installing-harness:Codex installed",
        "installing-tools:jq (1/1)",
        "installing-tools:1 installed",
        "installing-mcp:none configured",
      ]);
      const removals = cmds.slice(0, 3);
      expect(removals.every(c => /\nsetsid bash -c '.*' &\np=\$!\n/s.test(c) && c.includes("while [ $t -lt 600 ]"))).toBe(true);
      expect(removals[0]).toContain("rm -rf -- '\\''/root/.zshrc'\\''");
      expect(removals[2]).toContain("npm uninstall -g @google/gemini-cli");
      expect(cmds.indexOf(FREE_KB_CMD)).toBeGreaterThan(2);
      // Claude Code was removed from the recipe even though nothing could uninstall it, so its check leaves the smoke.
      expect(ledger).toEqual({ recipeHash: "h2", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "codex --version", recipe: SNAPSHOT });
    });

    it("a delta with nothing to remove goes straight to the stages", async () => {
      const { backend, cmds, fetch } = backendFor();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const { stages, onStage } = stageRecorder();
      await applyDelta(machine, deltaOf({ removals: [] }), { setup: "true", previousSmoke: "true", fetch, onStage });
      expect(stages[0]).toBe("applying-setup:3 files: identity 1, shell 2");
      expect(cmds[0]).toBe(FREE_KB_CMD);
    });

    it.each([
      ["true", [], "true", "true"],
      ["a --version && b --version", ["b --version"], "true", "a --version"],
      ["a --version", [], "a --version && c --version", "a --version && c --version"],
      ["true", [], "x --version", "x --version"],
      ["a --version", ["a --version"], "true", "true"],
    ])("nextSmoke(%j, %j, %j) is %j", (previous, removed, added, want) => {
      expect(nextSmoke(previous, removed, added)).toBe(want);
    });

    it("upgradeBuilder forks the head at its kind and size as a builder, applies only the delta, and returns a first-life builder with the new ledger", async () => {
      const { backend, created, cmds, fetch } = backendFor();
      const { stages, onStage } = stageRecorder();
      const labels = { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_me", createdAt: "2026-09-04T00:00:00.000Z" };
      const builder = await upgradeBuilder({ backend, head, delta: deltaOf({ removals: [] }), setup: "true", fetch, onStage, labels });
      expect(created[0]).toMatchObject({ kind: "desktop", fromSnapshot: "snap_golden-v1", cpu: 2, memMb: 8192, onIdle: "kill", idleTimeoutMs: BUILDER_IDLE_MS, labels });
      expect(created[0]!.template).toBeUndefined();
      expect(stages[0]).toBe("creating:fork of golden v1");
      expect(stages.at(-1)).toBe("ready");
      expect(cmds.filter(c => c.includes("brew install jq"))).toHaveLength(1);
      expect(cmds.some(c => c.includes("brew-bootstrap"))).toBe(false);
      expect(builder).toMatchObject({ kind: "desktop", baseTemplate: "base", firstLife: true, size: { cpu: 2, memMb: 8192 } });
      expect(builder.import).toEqual({ recipeHash: "h2", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "claude --version && gemini --version && codex --version", recipe: SNAPSHOT });
      // The version's sha chains the previous version's with what this delta ran, so v(n+1)'s sha says both.
      expect(builder.setupSha).toBe(nextSetupSha("s1", "true", deltaOf({ removals: [] }).import));
      expect(builder.setupSha).toBe(createHash("sha256").update(`s1\n${createHash("sha256").update("true\ncodex-install").digest("hex")}`).digest("hex"));
    });

    it("an upgrade whose delta fails kills the fork and reports the failure", async () => {
      const { backend, killed, fetch } = backendFor([], mb(1));
      const { stages, onStage } = stageRecorder();
      await expect(upgradeBuilder({ backend, head, delta: deltaOf(), setup: "true", fetch, onStage })).rejects.toThrow(/your files need/);
      expect(killed).toEqual(["m1"]);
      expect(stages.at(-1)).toMatch(/^failed:your files need/);
    });

    const ROAD_TABLE: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], macosOnly: false, source: { repo: "zingzy/diskbloom", tag: "v1.2.0" } }]]);
    const entry = (rung: string, id: string, over: Partial<RecipeEntry> = {}): RecipeEntry => ({ rung, id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over });
    const planOf = (rows: RecipeEntry[], recipeHash: string, results: ImportResult[]): GoldenImport => ({
      recipeHash,
      recipe: recipeDigest(rows),
      tools: [...editorInstallsFor(rows).installs, ...toolInstallsFor(rows, ROAD_TABLE).installs],
      agents: [],
      onResult: r => void results.push(r),
    });
    /** As wsp init plans an update: the rows the diff names, planned like a first build, hashed as the whole recipe. */
    const deltaBetween = (from: RecipeEntry[], to: RecipeEntry[], recipeHash: string, results: ImportResult[] = []): GoldenDelta => {
      const diff = diffRecipes(recipeDigest(from), recipeDigest(to));
      const rows = rowsToApply(diff);
      return { import: { ...planOf(to.filter(e => rows.has(e.id)), recipeHash, results), recipe: recipeDigest(to) }, removals: removalsFor(diff, recipeDigest(from)) };
    };

    it("a binary row toggled after the seal: ticked, the next version installs it; unticked, the version after takes it off; an editor, a Homebrew formula and a road tool each way", async () => {
      const { backend, cmds, fetch } = backendFor();
      const { stages, onStage } = stageRecorder();
      const results: ImportResult[] = [];
      const base = [entry("shell", "shell/zshrc", { paths: ["~/.zshrc"], bytes: 10 })];
      const binaries = [entry("editors", "editors/vim", { label: "vim, installed" }), entry("tools", "tools/brew/jq", { linux: "yes" }), entry("tools", "tools/brew/zingzy/tap/diskbloom", { linux: "unknown" })];
      const guardedCmds = (from: number) => cmds.slice(from).filter(c => c.includes("setsid bash -c"));

      const v1 = await sealGolden(await prepareBuilder({ backend, setup: "true", fetch, import: planOf(base, "h1", results) }), { backend, smoke: "true" });
      const n1 = cmds.length;
      expect(cmds.some(c => c.includes("apt-get install -y -qq vim"))).toBe(false);

      const up = deltaBetween(base, [...base, ...binaries], "h2", results);
      expect(up.removals).toEqual([]);
      const b2 = await upgradeBuilder({ backend, head: v1.version, delta: up, setup: "true", fetch, onStage });
      const installs = guardedCmds(n1);
      expect(installs.some(c => c.includes("apt-get install -y -qq vim"))).toBe(true);
      expect(installs.some(c => c.includes("brew install jq"))).toBe(true);
      expect(installs.some(c => c.includes("name='\\''diskbloom'\\''") && c.includes('install -m 0755 "$bin" "/usr/local/bin/$name"'))).toBe(true);
      expect(installs.some(c => c.includes("uninstall") || c.includes("apt-get purge"))).toBe(false);
      expect(results.at(-1)!.tools.filter(t => binaries.some(b => b.id === t.id)).map(t => [t.id, t.outcome])).toEqual([["editors/vim", "installed"], ["tools/brew/jq", "installed"], ["tools/brew/zingzy/tap/diskbloom", "installed"]]);
      expect(results.at(-1)!.removed).toBeUndefined();
      const v2 = await sealGolden(b2, { backend, smoke: "true", manifest: v1.manifest });
      expect(v2.version.version).toBe(2);

      const n2 = cmds.length;
      stages.length = 0;
      const down = deltaBetween([...base, ...binaries], base, "h3", results);
      expect(down.import.tools).toEqual([]);
      expect(down.import.files).toBeUndefined();
      const b3 = await upgradeBuilder({ backend, head: v2.version, delta: down, setup: "true", fetch, onStage });
      const removals = guardedCmds(n2);
      expect(removals).toHaveLength(3);
      expect(removals[0]).toContain("brew uninstall jq");
      expect(removals[1]).toContain("rm -f /usr/local/bin/'\\''diskbloom'\\''");
      expect(removals[2]).toContain("apt-get purge -y -qq vim");
      expect(cmds.slice(n2).some(c => c.includes("apt-get install") || c.includes("brew install"))).toBe(false);
      expect(stages).toContain("applying-setup:removed jq, diskbloom, vim");
      expect(results.at(-1)).toEqual({
        recipeHash: "h3",
        files: { bytes: 0, skipped: [] },
        tools: [],
        agents: [],
        removed: [
          { what: "tool", id: "tools/brew/jq", label: "jq", outcome: "removed" },
          { what: "tool", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", outcome: "removed" },
          { what: "editor", id: "editors/vim", label: "vim", outcome: "removed" },
        ],
      });
      const v3 = await sealGolden(b3, { backend, smoke: "true", manifest: v2.manifest });
      expect(v3.version.version).toBe(3);
      expect(b3.import).toEqual({ recipeHash: "h3", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "true", recipe: recipeDigest(base) });
    });

    it("an extension ticked or unticked after the seal rewrites the whole list from every ticked sibling; the last one unticked takes the list file off", async () => {
      const { backend, cmds, fetch } = backendFor();
      const { stages, onStage } = stageRecorder();
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const ext = (id: string) => entry("editors", `editors/vscode-ext/${id}`);
      const one = [ext("ms-python.python")];
      const two = [...one, ext("esbenp.prettier-vscode")];
      const listWrites = (from: number) => cmds.slice(from).filter(c => c.includes("setsid bash -c") && c.includes('> "$HOME/.vscode-server/extensions.txt"'));
      const apply = (delta: GoldenDelta) => applyDelta(machine, delta, { setup: "true", previousSmoke: "true", fetch, onStage });

      const n0 = cmds.length;
      const more = deltaBetween(one, two, "h2");
      expect(more.removals).toEqual([]);
      await apply(more);
      expect(listWrites(n0)).toHaveLength(1);
      expect(listWrites(n0)[0]).toContain(`'\\''ms-python.python'\\'' '\\''esbenp.prettier-vscode'\\'' > "$HOME/.vscode-server/extensions.txt"`);

      const n1 = cmds.length;
      const fewer = deltaBetween(two, one, "h3");
      expect(fewer.removals).toEqual([]);
      await apply(fewer);
      expect(listWrites(n1)).toHaveLength(1);
      expect(listWrites(n1)[0]).toContain(`'\\''ms-python.python'\\'' > "$HOME/.vscode-server/extensions.txt"`);
      expect(listWrites(n1)[0]).not.toContain("prettier");

      const n2 = cmds.length;
      const none = deltaBetween(one, [], "h4");
      expect(none.import.tools).toEqual([]);
      expect(none.removals).toEqual([{ what: "editor", id: "editors/vscode-ext", label: "VS Code extension list", cmd: "rm -f -- '/root/.vscode-server/extensions.txt'" }]);
      await apply(none);
      expect(listWrites(n2)).toHaveLength(0);
      expect(cmds.slice(n2).filter(c => c.includes("rm -f -- '\\''/root/.vscode-server/extensions.txt'\\''"))).toHaveLength(1);
      expect(stages).toContain("applying-setup:removed VS Code extension list");
    });

    it("a removal that fails or has no road is in the result as such, beside what the delta installed", async () => {
      const { backend, fetch } = backendFor([["npm uninstall -g bun", { exitCode: 1, stdout: "", stderr: "npm ERR! not installed" }]]);
      const machine = await backend.create({ kind: "sandbox", template: "base" });
      const results: ImportResult[] = [];
      const delta = deltaOf();
      delta.import.onResult = r => void results.push(r);
      await applyDelta(machine, delta, { setup: "true", previousSmoke: head.smoke.cmd, fetch });
      expect(results).toHaveLength(1);
      expect(results[0]!.tools.map(t => [t.id, t.outcome])).toEqual([["tools/brew/jq", "installed"]]);
      expect(results[0]!.removed).toEqual([
        { what: "file", id: "shell/zshrc", label: "~/.zshrc", outcome: "removed" },
        { what: "tool", id: "tools/npm/bun", label: "bun", outcome: "failed", note: "npm ERR! not installed" },
        { what: "agent", id: "agents/gemini", label: "Gemini CLI", outcome: "removed" },
        { what: "agent", id: "agents/claude", label: "Claude Code", outcome: "kept", note: "Claude Code has no uninstaller; left on the machine" },
      ]);
    });
  });
});
