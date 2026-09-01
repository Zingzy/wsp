// SPDX-License-Identifier: AGPL-3.0-only
// Golden images in two halves so the scripted pipeline and the first-run
// wizard share one road: prepareBuilder boots a fresh machine and installs the
// harness (nothing personal on it yet); sealGolden snapshots it, proves the
// snapshot boots by smoke-testing a fork, and appends a manifest version.
// Between the halves a person may sit on the builder's live screen for as
// long as they like, as long as nobody pauses it (snapshot-fresh rule).

import { createHash } from "node:crypto";
import type { GoldenManifest, GoldenStage, GoldenVersion } from "@wsp/protocol";
import { assertFirstLife } from "./lifecycle.js";
import type { Machine, MachineBackend, MachineKind } from "./machine.js";

export type { GoldenManifest, GoldenStage, GoldenVersion };

export type StageListener = (stage: GoldenStage, detail?: string) => void;

/** Solari's built-in templates are kind-specific (TemplateKindMismatch otherwise). */
const DEFAULT_TEMPLATE: Record<MachineKind, string> = { sandbox: "base", desktop: "default" };

/** How long a builder may sit with no API activity before it is killed. Whether
 * a live noVNC stream counts as activity is unmeasured, so this covers a person
 * reading docs on the builder screen; a forgotten builder costs under $1 at
 * Starter rates over this window. */
export const BUILDER_IDLE_MS = 6 * 60 * 60_000;

export interface MachineSize {
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface PrepareBuilderOptions extends MachineSize {
  backend: MachineBackend;
  /** Default desktop: the builder's own noVNC stream is what the wizard shows. */
  kind?: MachineKind;
  baseTemplate?: string;
  /** Host-owned step (the daemon bundle lives outside the engine); skipped when absent. */
  deployDaemon?: (machine: Machine) => Promise<void>;
  /** Harness install; its sha is recorded in the manifest. */
  setup: string;
  setupTimeoutMs?: number;
  onStage?: StageListener;
}

/** A first-life machine with the harness installed, waiting to be sealed. */
export interface Builder {
  readonly machine: Machine;
  readonly kind: MachineKind;
  readonly baseTemplate: string;
  readonly setupSha: string;
  readonly createdAt: string;
  /** False once the machine has ever been resumed; sealGolden refuses it then. */
  readonly firstLife: boolean;
}

export interface SealGoldenOptions extends MachineSize {
  backend: MachineBackend;
  /** Runs on a fork of the fresh snapshot; a non-zero exit means no version is sealed. */
  smoke: string;
  smokeTimeoutMs?: number;
  manifest?: GoldenManifest;
  onStage?: StageListener;
}

export interface BuildGoldenOptions extends MachineSize {
  backend: MachineBackend;
  setup: string;
  smoke: string;
  /** The scripted pipeline keeps its historical default; the wizard passes desktop. */
  kind?: MachineKind;
  baseTemplate?: string;
  manifest?: GoldenManifest;
  setupTimeoutMs?: number;
  smokeTimeoutMs?: number;
  onStage?: StageListener;
}

export interface ForkOverrides extends MachineSize {
  kind?: MachineKind;
}

function sizeSpec(o: MachineSize) {
  return {
    ...(o.cpu ? { cpu: o.cpu } : {}),
    ...(o.memMb ? { memMb: o.memMb } : {}),
    ...(o.envs ? { envs: o.envs } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
  };
}

export async function prepareBuilder(opts: PrepareBuilderOptions): Promise<Builder> {
  const stage = opts.onStage ?? (() => {});
  const kind = opts.kind ?? "desktop";
  const baseTemplate = opts.baseTemplate ?? DEFAULT_TEMPLATE[kind];

  stage("creating", `${kind} from ${baseTemplate}`);
  // A builder that idle-pauses resumes not first-life, so its seal would 502 and
  // consume it anyway; killing on idle loses the same work but fails loud and free.
  const machine = await opts.backend.create({
    kind,
    template: baseTemplate,
    onIdle: "kill",
    idleTimeoutMs: BUILDER_IDLE_MS,
    ...sizeSpec(opts),
  });
  try {
    if (opts.deployDaemon) {
      stage("deploying-daemon");
      await opts.deployDaemon(machine);
    }
    stage("installing-harness");
    const res = await machine.exec(opts.setup, { timeoutMs: opts.setupTimeoutMs ?? 300_000 });
    if (res.exitCode !== 0) {
      throw new Error(`golden setup failed (exit ${res.exitCode}): ${res.stderr.slice(-500)}`);
    }
    stage("ready");
    return {
      machine,
      kind,
      baseTemplate,
      setupSha: createHash("sha256").update(opts.setup).digest("hex"),
      createdAt: new Date().toISOString(),
      firstLife: true,
    };
  } catch (e) {
    await machine.kill().catch(() => {});
    stage("failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// Sequenced for a two-machine cap: the builder dies before the smoke fork
// boots, so the seal itself never holds more than one machine.
export async function sealGolden(
  builder: Builder,
  opts: SealGoldenOptions,
): Promise<{ manifest: GoldenManifest; version: GoldenVersion }> {
  const stage = opts.onStage ?? (() => {});
  assertFirstLife(builder.machine.id, builder.firstLife, "seal");

  const prior = opts.manifest?.versions ?? [];
  const versionNum = (prior[prior.length - 1]?.version ?? 0) + 1;
  let snapshotId: string | undefined;
  let builderAlive = true;
  let fork: Machine | undefined;
  try {
    stage("snapshotting", `golden-v${versionNum}`);
    snapshotId = await builder.machine.snapshot(`golden-v${versionNum}`);
    await builder.machine.kill();
    builderAlive = false;

    stage("smoke-forking", opts.smoke);
    fork = await opts.backend.create({ kind: builder.kind, fromSnapshot: snapshotId, ...sizeSpec(opts) });
    const smokeRes = await fork.exec(opts.smoke, { timeoutMs: opts.smokeTimeoutMs ?? 120_000 });
    if (smokeRes.exitCode !== 0) {
      throw new Error(
        `golden smoke failed (exit ${smokeRes.exitCode}) for ${JSON.stringify(opts.smoke)}: ${smokeRes.stderr.slice(-500)}`,
      );
    }
    await fork.kill();

    const version: GoldenVersion = {
      version: versionNum,
      snapshotId,
      baseTemplate: builder.baseTemplate,
      kind: builder.kind,
      setupSha: builder.setupSha,
      createdAt: new Date().toISOString(),
      smoke: { cmd: opts.smoke, exitCode: smokeRes.exitCode },
    };
    stage("sealed", `v${versionNum}`);
    return { manifest: { head: versionNum, versions: [...prior, version] }, version };
  } catch (e) {
    if (builderAlive) await builder.machine.kill().catch(() => {});
    await fork?.kill().catch(() => {});
    if (snapshotId !== undefined) await opts.backend.deleteSnapshot(snapshotId).catch(() => {});
    stage("failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** The scripted pipeline: prepare then seal, no one in between. */
export async function buildGolden(
  opts: BuildGoldenOptions,
): Promise<{ manifest: GoldenManifest; version: GoldenVersion }> {
  const { backend, setup, smoke, kind, baseTemplate, manifest, setupTimeoutMs, smokeTimeoutMs, onStage, ...size } = opts;
  const builder = await prepareBuilder({
    backend,
    kind: kind ?? "sandbox",
    setup,
    ...size,
    ...(baseTemplate !== undefined ? { baseTemplate } : {}),
    ...(setupTimeoutMs !== undefined ? { setupTimeoutMs } : {}),
    ...(onStage !== undefined ? { onStage } : {}),
  });
  return sealGolden(builder, {
    backend,
    smoke,
    ...size,
    ...(manifest !== undefined ? { manifest } : {}),
    ...(smokeTimeoutMs !== undefined ? { smokeTimeoutMs } : {}),
    ...(onStage !== undefined ? { onStage } : {}),
  });
}

export async function forkGolden(
  backend: MachineBackend,
  manifest: GoldenManifest,
  overrides: ForkOverrides = {},
): Promise<Machine> {
  const head = manifest.versions.find(v => v.version === manifest.head);
  if (!head) throw new Error(`manifest head ${manifest.head} has no version entry`);
  return backend.create({
    kind: overrides.kind ?? head.kind ?? "sandbox",
    fromSnapshot: head.snapshotId,
    ...sizeSpec(overrides),
  });
}

export function rollback(manifest: GoldenManifest, version: number): GoldenManifest {
  if (!manifest.versions.some(v => v.version === version)) {
    throw new Error(`rollback target v${version} not in manifest`);
  }
  return { ...manifest, head: version };
}
