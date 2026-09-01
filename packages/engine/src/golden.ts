import { createHash } from "node:crypto";
import type { Machine, MachineBackend, MachineKind } from "./machine.js";

export interface GoldenVersion {
  version: number;
  snapshotId: string;
  baseTemplate: string;
  setupSha: string;
  createdAt: string;
  smoke: { cmd: string; exitCode: number };
}

export interface GoldenManifest {
  head: number;
  versions: GoldenVersion[];
}

export interface BuildGoldenOptions {
  backend: MachineBackend;
  setup: string;
  smoke: string;
  baseTemplate?: string;
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  manifest?: GoldenManifest;
  keepBuilder?: boolean;
  setupTimeoutMs?: number;
  smokeTimeoutMs?: number;
}

export interface ForkOverrides {
  kind?: MachineKind;
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
}

// Every build runs on a machine created here and snapshotted before any
// pause/resume, so images always obey the snapshot-fresh rule.
export async function buildGolden(
  opts: BuildGoldenOptions,
): Promise<{ manifest: GoldenManifest; version: GoldenVersion; builder?: Machine }> {
  const baseTemplate = opts.baseTemplate ?? "base";
  const prior = opts.manifest?.versions ?? [];
  const versionNum = (prior[prior.length - 1]?.version ?? 0) + 1;

  const builder = await opts.backend.create({
    kind: "sandbox",
    template: baseTemplate,
    ...(opts.cpu ? { cpu: opts.cpu } : {}),
    ...(opts.memMb ? { memMb: opts.memMb } : {}),
    ...(opts.envs ? { envs: opts.envs } : {}),
    ...(opts.labels ? { labels: opts.labels } : {}),
  });

  try {
    const setupRes = await builder.exec(opts.setup, { timeoutMs: opts.setupTimeoutMs ?? 300_000 });
    if (setupRes.exitCode !== 0) {
      throw new Error(`golden setup failed (exit ${setupRes.exitCode}): ${setupRes.stderr.slice(-500)}`);
    }
    const smokeRes = await builder.exec(opts.smoke, { timeoutMs: opts.smokeTimeoutMs ?? 120_000 });
    if (smokeRes.exitCode !== 0) {
      throw new Error(
        `golden smoke failed (exit ${smokeRes.exitCode}) for ${JSON.stringify(opts.smoke)}: ${smokeRes.stderr.slice(-500)}`,
      );
    }

    const snapshotId = await builder.snapshot(`golden-v${versionNum}`);
    const version: GoldenVersion = {
      version: versionNum,
      snapshotId,
      baseTemplate,
      setupSha: createHash("sha256").update(opts.setup).digest("hex"),
      createdAt: new Date().toISOString(),
      smoke: { cmd: opts.smoke, exitCode: smokeRes.exitCode },
    };
    const manifest: GoldenManifest = { head: versionNum, versions: [...prior, version] };

    if (opts.keepBuilder) return { manifest, version, builder };
    await builder.kill();
    return { manifest, version };
  } catch (e) {
    if (!opts.keepBuilder) await builder.kill().catch(() => {});
    throw e;
  }
}

export async function forkGolden(
  backend: MachineBackend,
  manifest: GoldenManifest,
  overrides: ForkOverrides = {},
): Promise<Machine> {
  const head = manifest.versions.find(v => v.version === manifest.head);
  if (!head) throw new Error(`manifest head ${manifest.head} has no version entry`);
  return backend.create({
    kind: overrides.kind ?? "sandbox",
    fromSnapshot: head.snapshotId,
    ...(overrides.cpu ? { cpu: overrides.cpu } : {}),
    ...(overrides.memMb ? { memMb: overrides.memMb } : {}),
    ...(overrides.envs ? { envs: overrides.envs } : {}),
    ...(overrides.labels ? { labels: overrides.labels } : {}),
  });
}

export function rollback(manifest: GoldenManifest, version: number): GoldenManifest {
  if (!manifest.versions.some(v => v.version === version)) {
    throw new Error(`rollback target v${version} not in manifest`);
  }
  return { ...manifest, head: version };
}
