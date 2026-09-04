// SPDX-License-Identifier: AGPL-3.0-only
// Golden images in two halves so the scripted pipeline and the first-run
// wizard share one road: prepareBuilder boots a fresh machine and installs the
// harness (nothing personal on it yet); sealGolden snapshots it, proves the
// snapshot boots by smoke-testing a fork, and appends a manifest version.
// Between the halves a person may sit on the builder's live screen for as
// long as they like, as long as nobody pauses it (snapshot-fresh rule).

import { createHash } from "node:crypto";
import { ALREADY_APPLIED, type GoldenLogin, type GoldenManifest, type GoldenStage, type GoldenVersion, type RecipeDigest } from "@wsp/protocol";
import { HOMEBREW, NODE_PATH_LINE, type AgentInstall, type NodeInstall, type SkippedPath, type ToolInstall } from "./golden-import.js";
import { assertFirstLife } from "./lifecycle.js";
import type { ExecResult, Machine, MachineBackend, MachineKind, MachineState } from "./machine.js";
import { importInto } from "./vault.js";

export type { GoldenLogin, GoldenManifest, GoldenStage, GoldenVersion };

export type StageListener = (stage: GoldenStage, detail?: string) => void;

/** How long to wait for the provider to report a killed machine gone before
 * killing again; two rounds, then the caller fails. Tests shrink both. */
export interface KillConfirm {
  graceMs?: number;
  pollMs?: number;
}

/** A machine that answered two kills with a success status and is still there.
 * Typed so the wizard can say "still billing, reap it" rather than "try again". */
export class MachineAliveError extends Error {
  readonly kind = "machineAlive" as const;
  constructor(
    readonly machineId: string,
    readonly state: MachineState,
  ) {
    super(`machine ${machineId} is still ${state} after two kills; it bills until reap or a kill by hand takes`);
    this.name = "MachineAliveError";
  }
}

const isMissing = (e: unknown): boolean => (e as { kind?: unknown }).kind === "missing";
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The provider's kill acknowledges the request, not the machine's death: a live
 * wizard run reported its seal done and the builder was still running 25 minutes
 * later, so a kill is only done once get(id) reads the machine gone. */
export async function killUntilGone(backend: MachineBackend, machine: Machine, confirm: KillConfirm = {}): Promise<void> {
  const graceMs = confirm.graceMs ?? 30_000;
  const pollMs = confirm.pollMs ?? 1_000;
  let state: MachineState = "running";
  for (let attempt = 0; attempt < 2; attempt++) {
    await machine.kill().catch((e: unknown) => {
      if (!isMissing(e)) throw e;
    });
    const deadline = Date.now() + graceMs;
    do {
      state = await backend.get(machine.id).then(
        m => m.state(),
        (e: unknown) => (isMissing(e) ? "gone" : Promise.reject(e)),
      );
      if (state === "gone") return;
      await new Promise(r => setTimeout(r, pollMs));
    } while (Date.now() < deadline);
  }
  throw new MachineAliveError(machine.id, state);
}

/** Solari's built-in templates are kind-specific (TemplateKindMismatch otherwise). */
const DEFAULT_TEMPLATE: Record<MachineKind, string> = { sandbox: "base", desktop: "default" };

/** Mirrors @wsp/daemon's OPEN_SHIM_PATH (the engine cannot import the daemon package, which only runs inside guests); a host test pins the two equal. */
export const BROWSER_SHIM_PATH = "/usr/local/bin/wsp-open";

/** How long a builder may sit with no API activity before it is killed. Whether
 * a live noVNC stream counts as activity is unmeasured, so this covers a person
 * reading docs on the builder screen; a forgotten builder costs under $1 at
 * Starter rates over this window. */
export const BUILDER_IDLE_MS = 6 * 60 * 60_000;

/** Every desktop template boots with ~570 MB free, which the harness install
 * (~410 MB peak) plus the daemon (~280 MB) cannot fit; the base sandbox boots
 * with ~2.2 GB free and does. Builders default to sandbox and ask for this
 * disk, which Solari ignores today (both kinds stay at 4 GB) but may honor. */
export interface MachineSize {
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface PrepareBuilderOptions extends MachineSize {
  backend: MachineBackend;
  /** Default sandbox (the wizard shows a terminal on it); desktop streams a display instead. */
  kind?: MachineKind;
  baseTemplate?: string;
  /** Host-owned step (the daemon bundle lives outside the engine); skipped when
   * absent. A returned string is reported as the deploying-daemon detail. */
  deployDaemon?: (machine: Machine) => Promise<void | string>;
  /** Harness install; its sha is recorded in the manifest. */
  setup: string;
  setupTimeoutMs?: number;
  /** The person's files, tools and agents, applied between the daemon and the harness. */
  import?: GoldenImport;
  /** The upload's transport; tests inject one. */
  fetch?: typeof globalThis.fetch;
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
  /** What the provider built, read back after create (it may clamp the request); the sealed version records it. */
  readonly size: { cpu: number; memMb: number };
  /** What of the recipe is on this machine; absent when it was built without an import. */
  readonly import?: ImportLedger;
}

// --- golden import: the person's files, tools and agents on the builder ------

/** An rc file the pack shipped without its secret exports: where it lands under the guest home and the names it lost. */
export interface CutNames {
  path: string;
  names: string[];
}

export interface PackedFiles {
  tar: Buffer;
  /** The archive's size, what the upload moves. */
  bytes: number;
  /** What the archive holds once extracted, what the guest disk has to take on top. */
  unpacked: number;
  skipped: SkippedPath[];
  /** The rc files stripped at pack time, so the checklist names what to set from what actually left. */
  cut: CutNames[];
}

export interface GoldenImport {
  /** Identifies the ticks this plan came from; a builder carrying the same hash needs nothing re-applied. */
  recipeHash: string;
  /** The parts behind recipeHash; recorded on the builder so a later run can say what changed. */
  recipe?: RecipeDigest;
  /** Absent when no file was ticked. `pack` reads this computer and builds the archive; it runs on applying-setup. */
  files?: {
    /** Files and secrets that will be packed; zero when every ticked path is gone from this computer. */
    count: number;
    rungs: Record<string, number>;
    bytes: number;
    /** Ticked paths the plan set aside (missing on disk, a private key), reported before packing. */
    skipped: SkippedPath[];
    pack: () => Promise<PackedFiles>;
    /** The planned files a tool rewrites while it runs, `~`-relative: they never decide the hash, so an
     * attach uploads the latest copy again. Absent when none was ticked. */
    volatile?: { paths: string[]; pack: () => Promise<PackedFiles> };
  };
  tools: ToolInstall[];
  /** Runs once before the agents when a ticked agent's engines floor may be above the base image's Node. */
  node?: NodeInstall;
  agents: AgentInstall[];
  /** Ticked agents the plan set aside (no installer, no pinned Node); they count as ticked and land in the result. */
  skippedAgents?: { id: string; name: string; note: string }[];
  /** Called once per prepare that ran anything; a re-run that skipped every stage has nothing to report. */
  onResult?: (result: ImportResult) => void;
}

export type ImportStage = "applying-setup" | "uploading-files" | "installing-tools" | "installing-harness";

export interface ImportLedger {
  recipeHash: string;
  recipe?: RecipeDigest;
  applied: ImportStage[];
  /** The version checks of the agents that installed, joined; the seal runs this on the fork. */
  smoke: string;
}

export interface ToolResult {
  id: string;
  label: string;
  outcome: "installed" | "failed" | "skipped";
  note?: string;
  ms?: number;
}

export interface AgentResult {
  id: string;
  name: string;
  outcome: "installed" | "failed" | "skipped";
  note?: string;
  ms?: number;
}

export interface ImportResult {
  recipeHash: string;
  files?: { bytes: number; skipped: SkippedPath[]; cut?: CutNames[] };
  /** The Homebrew checkout the formulae installed under, when the tools stage put one on the machine. */
  homebrew?: { tag: string; commit: string };
  tools: ToolResult[];
  agents: AgentResult[];
}

export interface ApplyImportOptions {
  import?: GoldenImport;
  setup: string;
  setupTimeoutMs?: number;
  /** Stages this builder already carries; those for the same recipe hash are skipped. */
  ledger?: ImportLedger;
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

const FREE_KB_CMD = "df -Pk /root | awk 'NR==2{print $4}'";
const MIB = 1024 * 1024;
/** Extraction needs the archive and its contents at once, plus what the agents install after. */
const UPLOAD_HEADROOM = 256 * MIB;
/** The Claude installer peaks near 410 MB and every other agent adds to it; tools stop before eating into it. */
const TOOLS_DISK_FLOOR = 800 * MIB;
const TOOL_TIMEOUT_S = 600;
const AGENT_TIMEOUT_S = 900;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MIB) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n / MIB)} MB`;
}

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The line that names the failure, for a warning: the last `Error:` line on stderr (Homebrew
 * follows its error with advice), else the last stderr line, else stdout's; 124 is the guest-side timeout. */
function reasonOf(res: ExecResult, timeoutS: number): string {
  if (res.exitCode === 124) return `timed out after ${timeoutS}s`;
  const lines = (text: string): string[] => text.split("\n").map(l => l.trim()).filter(l => l !== "");
  const err = lines(res.stderr);
  return (err.filter(l => l.startsWith("Error:")).at(-1) ?? err.at(-1) ?? lines(res.stdout).at(-1) ?? `exit ${res.exitCode}`).slice(0, 160);
}

type FreeDisk = { kind: "free"; bytes: number } | { kind: "unknown"; reason: string };

/** What df says is free under /root; a df that fails or prints nothing is reported, never assumed. */
async function freeBytes(machine: Machine): Promise<FreeDisk> {
  const res = await machine.exec(FREE_KB_CMD, { timeoutMs: 30_000 });
  const kb = Number(res.stdout.trim());
  if (res.exitCode === 0 && Number.isFinite(kb) && kb > 0) return { kind: "free", bytes: kb * 1024 };
  return { kind: "unknown", reason: `df failed: ${reasonOf(res, 30)}` };
}

// The guest kills a runaway install itself (timeout), so a tool that hangs
// never leaves a second one racing it for the same lock.
function guarded(script: string, timeoutS: number): string {
  return `timeout -k 10 ${timeoutS} bash -c ${squote(script)}`;
}

/** Runs the import stages and the harness on a builder, skipping what the
 * ledger says is already there for the same recipe. Files and upload fail the
 * build; each tool and agent fails alone and is named in the stage detail. */
export async function applyGoldenImport(machine: Machine, opts: ApplyImportOptions): Promise<{ ledger: ImportLedger; result: ImportResult }> {
  const stage = opts.onStage ?? (() => {});
  const imp = opts.import ?? { recipeHash: "", tools: [], agents: [] };
  const prior = opts.ledger?.recipeHash === imp.recipeHash ? opts.ledger : undefined;
  const ledger: ImportLedger = { recipeHash: imp.recipeHash, ...(imp.recipe !== undefined ? { recipe: imp.recipe } : {}), applied: [...(prior?.applied ?? [])], smoke: prior?.smoke ?? "true" };
  const result: ImportResult = { recipeHash: imp.recipeHash, tools: [], agents: [] };
  const done = (s: ImportStage): boolean => ledger.applied.includes(s);
  const mark = (s: ImportStage): void => {
    if (!done(s)) ledger.applied.push(s);
  };
  const only = opts.import === undefined;
  let ran = false;
  const upload = async (packed: PackedFiles, label: string): Promise<void> => {
    const free = await freeBytes(machine);
    const need = packed.bytes + packed.unpacked + UPLOAD_HEADROOM;
    if (free.kind === "unknown") {
      stage("uploading-files", `free disk unknown (${free.reason}); uploading ${fmtBytes(packed.bytes)} anyway`);
    } else if (need > free.bytes) {
      throw new Error(`your files need ${fmtBytes(packed.bytes)} packed and ${fmtBytes(packed.unpacked)} unpacked, plus ${fmtBytes(UPLOAD_HEADROOM)} of headroom, but the machine has ${fmtBytes(free.bytes)} free`);
    }
    const t0 = Date.now();
    const { parts } = await importInto(machine, packed.tar, "/root", {
      overlay: true,
      timeoutMs: 300_000,
      onPart: p => {
        if (p.parts > 1) stage("uploading-files", `part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}`);
      },
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    stage("uploading-files", `${label}${fmtBytes(packed.bytes)}${parts > 1 ? ` in ${parts} parts` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };

  if (!only) {
    if (done("uploading-files")) {
      stage("applying-setup", ALREADY_APPLIED);
      const volatile = imp.files?.volatile;
      if (volatile === undefined) {
        stage("uploading-files", ALREADY_APPLIED);
      } else {
        // A volatile file is not in the hash, so the builder may hold an older copy; the latest one goes up again. The
        // saved result stands: no rc file is volatile, so the cuts and installs it lists are still what the builder has.
        // A re-import that fails leaves a builder that is still the same golden with an older copy: it is reported,
        // never failed, since the caller kills a builder whose stages fail.
        try {
          const packed = await volatile.pack();
          stage("uploading-files", `${volatile.paths.length} volatile file${volatile.paths.length === 1 ? "" : "s"}, ${fmtBytes(packed.bytes)}`);
          await upload(packed, `${volatile.paths.join(", ")} re-imported, `);
        } catch (e) {
          stage("uploading-files", `${volatile.paths.join(", ")} not re-imported: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (!imp.files || imp.files.count === 0) {
      const notes = (imp.files?.skipped ?? []).map(s => `${s.path} (${s.note})`);
      stage("applying-setup", notes.length > 0 ? `nothing left to pack; skipped ${notes.join(", ")}` : "nothing ticked");
      stage("uploading-files", "nothing to upload");
      // No pack ran, so nothing is known about cuts; a reader falls back to the recipe's own names.
      result.files = { bytes: 0, skipped: imp.files?.skipped ?? [] };
      mark("applying-setup");
      mark("uploading-files");
    } else {
      const rungs = Object.entries(imp.files.rungs).map(([r, n]) => `${r} ${n}`).join(", ");
      stage("applying-setup", `${imp.files.count} file${imp.files.count === 1 ? "" : "s"}: ${rungs}`);
      const packed = await imp.files.pack();
      packed.skipped = [...imp.files.skipped, ...packed.skipped];
      const notes = packed.skipped.map(s => `${s.path} (${s.note})`);
      stage("applying-setup", `${fmtBytes(packed.bytes)} packed${notes.length > 0 ? `; skipped ${notes.join(", ")}` : ""}`);
      mark("applying-setup");

      stage("uploading-files", fmtBytes(packed.bytes));
      ran = true;
      await upload(packed, "");
      result.files = { bytes: packed.bytes, skipped: packed.skipped, cut: packed.cut };
      mark("uploading-files");
    }

    if (done("installing-tools")) {
      stage("installing-tools", ALREADY_APPLIED);
    } else if (imp.tools.length === 0) {
      stage("installing-tools", "nothing ticked");
      mark("installing-tools");
    } else {
      ran = true;
      const installed = new Set<string>();
      const labelOf = (id: string): string => imp.tools.find(t => t.id === id)?.label ?? id;
      let floor: string | undefined;
      let dfWarned = false;
      for (const [i, tool] of imp.tools.entries()) {
        if (tool.after !== undefined && !installed.has(tool.after)) {
          result.tools.push({ id: tool.id, label: tool.label, outcome: "skipped", note: `${labelOf(tool.after)} did not install` });
          continue;
        }
        if (floor !== undefined) {
          result.tools.push({ id: tool.id, label: tool.label, outcome: "skipped", note: floor });
          continue;
        }
        const free = await freeBytes(machine);
        if (free.kind === "unknown" && !dfWarned) {
          dfWarned = true;
          stage("installing-tools", `free disk unknown (${free.reason}); installing without the ${fmtBytes(TOOLS_DISK_FLOOR)} floor`);
        } else if (free.kind === "free" && free.bytes < TOOLS_DISK_FLOOR) {
          floor = `${fmtBytes(free.bytes)} free, keeping ${fmtBytes(TOOLS_DISK_FLOOR)} for the agents`;
          result.tools.push({ id: tool.id, label: tool.label, outcome: "skipped", note: floor });
          continue;
        }
        stage("installing-tools", `${tool.label} (${i + 1}/${imp.tools.length})`);
        const t0 = Date.now();
        const res = await machine.exec(guarded(tool.cmd, TOOL_TIMEOUT_S), { timeoutMs: (TOOL_TIMEOUT_S + 30) * 1000 });
        const ms = Date.now() - t0;
        if (res.exitCode === 0) {
          installed.add(tool.id);
          if (tool.id === "tools/homebrew") result.homebrew = { ...HOMEBREW };
          result.tools.push({ id: tool.id, label: tool.label, outcome: "installed", ms });
        } else {
          result.tools.push({ id: tool.id, label: tool.label, outcome: "failed", note: reasonOf(res, TOOL_TIMEOUT_S), ms });
        }
      }
      stage("installing-tools", summarize(result.tools, floor));
      mark("installing-tools");
    }
  }

  if (done("installing-harness")) {
    stage("installing-harness", ALREADY_APPLIED);
  } else {
    stage("installing-harness");
    const res = await machine.exec(opts.setup, { timeoutMs: opts.setupTimeoutMs ?? 300_000 });
    if (res.exitCode !== 0) {
      throw new Error(`golden setup failed (exit ${res.exitCode}): ${res.stderr.slice(-500)}`);
    }
    if (!only) {
      ran = true;
      const node = imp.node !== undefined ? await installNode(machine, imp.node, stage) : undefined;
      for (const a of imp.skippedAgents ?? []) result.agents.push({ id: a.id, name: a.name, outcome: "skipped", note: a.note });
      for (const [i, agent] of imp.agents.entries()) {
        const t0 = Date.now();
        if (node?.failed !== undefined && agent.node !== undefined && agent.node > node.haveMajor) {
          result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: node.failed, ms: 0 });
          continue;
        }
        stage("installing-harness", `${agent.name} (${i + 1}/${imp.agents.length})`);
        const install = await machine.exec(guarded(`set -euo pipefail\n${NODE_PATH_LINE}\n${agent.install}`, AGENT_TIMEOUT_S), { timeoutMs: (AGENT_TIMEOUT_S + 30) * 1000 });
        const check = install.exitCode === 0 ? await machine.exec(`${NODE_PATH_LINE}\n${agent.smoke}`, { timeoutMs: 60_000 }) : install;
        const ms = Date.now() - t0;
        if (check.exitCode === 0) result.agents.push({ id: agent.id, name: agent.name, outcome: "installed", ms });
        else result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: reasonOf(check, AGENT_TIMEOUT_S), ms });
      }
      const installed = imp.agents.filter(a => result.agents.some(r => r.id === a.id && r.outcome === "installed"));
      if (result.agents.length > 0 && installed.length === 0) {
        imp.onResult?.(result);
        throw new Error(["no agent installed, so there is nothing to seal:", ...result.agents.map(a => `${a.name}: ${a.note ?? "unknown reason"}`)].join("\n"));
      }
      ledger.smoke = installed.length > 0 ? installed.map(a => a.smoke).join(" && ") : "true";
      stage("installing-harness", result.agents.length === 0 ? "no agent ticked" : summarizeAgents(result.agents));
    }
    mark("installing-harness");
  }
  if (!only && ran && imp.onResult) imp.onResult(result);
  return { ledger, result };
}

/** The Node step, once: kept when the guest's major already meets the floor,
 * else the pinned release; a failed install names itself and fails only the
 * agents whose floor the guest's Node does not meet. */
async function installNode(machine: Machine, node: NodeInstall, stage: StageListener): Promise<{ haveMajor: number; failed?: string }> {
  stage("installing-harness", `Node for ${node.agents.join(", ")}`);
  const res = await machine.exec(guarded(`set -euo pipefail\n${node.cmd}`, AGENT_TIMEOUT_S), { timeoutMs: (AGENT_TIMEOUT_S + 30) * 1000 });
  const have = /NODE_HAVE v(\d+)/.exec(res.stdout)?.[1];
  const haveMajor = have === undefined ? 0 : Number(have);
  const kept = /NODE_KEPT (v\S+)/.exec(res.stdout)?.[1];
  const got = /NODE_INSTALLED (v\S+)/.exec(res.stdout)?.[1];
  if (res.exitCode === 0 && kept !== undefined) {
    stage("installing-harness", `Node ${kept} kept; ${node.agents.join(", ")} run on it`);
    return { haveMajor };
  }
  if (res.exitCode === 0 && got !== undefined) {
    stage("installing-harness", `Node ${got} installed for ${node.agents.join(", ")} (the base had v${haveMajor})`);
    return { haveMajor: Number(got.slice(1).split(".")[0]) };
  }
  const failed = `Node ${node.version} did not install: ${reasonOf({ ...res, stdout: res.stdout.split("\n").filter(l => !l.startsWith("NODE_")).join("\n") }, AGENT_TIMEOUT_S)}`;
  stage("installing-harness", failed);
  return { haveMajor, failed };
}

function summarize(tools: ToolResult[], floor: string | undefined): string {
  const parts: string[] = [];
  const n = (o: ToolResult["outcome"]) => tools.filter(t => t.outcome === o);
  parts.push(`${n("installed").length} installed`);
  const failed = n("failed");
  if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.map(t => `${t.label} (${t.note})`).join(", ")}`);
  const skipped = n("skipped");
  if (skipped.length > 0) parts.push(`${skipped.length} skipped${floor !== undefined ? ` (${floor})` : ""}`);
  return parts.join(", ");
}

function summarizeAgents(agents: AgentResult[]): string {
  const ok = agents.filter(a => a.outcome === "installed").map(a => a.name);
  const bad = agents.filter(a => a.outcome === "failed").map(a => `${a.name} failed (${a.note})`);
  const aside = agents.filter(a => a.outcome === "skipped").map(a => `${a.name} skipped (${a.note})`);
  return [ok.length > 0 ? `${ok.join(", ")} installed` : "", ...bad, ...aside].filter(s => s !== "").join("; ");
}

/** Pins which installers ran: the harness line and every agent's. */
function setupShaOf(setup: string, imp: GoldenImport | undefined): string {
  const h = createHash("sha256").update(setup);
  if (imp?.node !== undefined) h.update(`\n${imp.node.cmd}`);
  for (const a of imp?.agents ?? []) h.update(`\n${a.install}`);
  return h.digest("hex");
}

export interface SealGoldenOptions extends MachineSize {
  backend: MachineBackend;
  /** Runs on a fork of the fresh snapshot; a non-zero exit means no version is sealed. */
  smoke: string;
  smokeTimeoutMs?: number;
  manifest?: GoldenManifest;
  onStage?: StageListener;
  killConfirm?: KillConfirm;
  /** How each sign-in asked of the builder ended; stamped on the version as given. */
  logins?: GoldenLogin[];
}

export interface BuildGoldenOptions extends MachineSize {
  backend: MachineBackend;
  setup: string;
  smoke: string;
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

/** Always explicit: a create that names no size gets the provider's own
 * default (2048 MB on Solari), which is not what the pricing default assumes. */
function sizeAsked(backend: MachineBackend, o: MachineSize, inherit?: { cpu: number; memMb: number }): { cpu: number; memMb: number } {
  return {
    cpu: o.cpu ?? inherit?.cpu ?? backend.pricing.defaultSize.cpu,
    memMb: o.memMb ?? inherit?.memMb ?? backend.pricing.defaultSize.memMb,
  };
}

function envSpec(o: MachineSize) {
  return {
    ...(o.envs ? { envs: o.envs } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
  };
}

/** The provider's word on what it built, falling back to the request where it has none. */
async function sizeBuilt(machine: Machine, asked: { cpu: number; memMb: number }): Promise<{ cpu: number; memMb: number }> {
  const shape = await machine.describe?.().catch(() => undefined);
  return { cpu: shape?.cpu ?? asked.cpu, memMb: shape?.memMb ?? asked.memMb };
}

export async function prepareBuilder(opts: PrepareBuilderOptions): Promise<Builder> {
  const stage = opts.onStage ?? (() => {});
  const kind = opts.kind ?? "sandbox";
  const baseTemplate = opts.baseTemplate ?? DEFAULT_TEMPLATE[kind];

  stage("creating", `${kind} from ${baseTemplate}`);
  // A builder that idle-pauses resumes not first-life, so its seal would 502 and
  // consume it anyway; killing on idle loses the same work but fails loud and free.
  const asked = sizeAsked(opts.backend, opts);
  // Taken before the create, so the age a person reads matches the createdAt label the sweep ages by.
  const createdAt = new Date().toISOString();
  const machine = await opts.backend.create({
    kind,
    template: baseTemplate,
    onIdle: "kill",
    idleTimeoutMs: BUILDER_IDLE_MS,
    ...asked,
    ...envSpec(opts),
  });
  try {
    const size = await sizeBuilt(machine, asked);
    if (opts.deployDaemon) {
      stage("deploying-daemon");
      const detail = await opts.deployDaemon(machine);
      if (detail !== undefined) stage("deploying-daemon", detail);
    }
    const applied = await applyGoldenImport(machine, {
      setup: opts.setup,
      onStage: stage,
      ...(opts.import !== undefined ? { import: opts.import } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.setupTimeoutMs !== undefined ? { setupTimeoutMs: opts.setupTimeoutMs } : {}),
    });
    stage("ready");
    return {
      machine,
      kind,
      baseTemplate,
      setupSha: setupShaOf(opts.setup, opts.import),
      createdAt,
      firstLife: true,
      size,
      ...(opts.import !== undefined ? { import: applied.ledger } : {}),
    };
  } catch (e) {
    // Nothing records this machine yet, so one that survives here is reap's to sweep.
    let detail = messageOf(e);
    await killUntilGone(opts.backend, machine).catch((k: unknown) => {
      detail += `; ${messageOf(k)}`;
    });
    stage("failed", detail);
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
  const smoke = builder.import?.smoke ?? opts.smoke;

  const prior = opts.manifest?.versions ?? [];
  const versionNum = (prior[prior.length - 1]?.version ?? 0) + 1;
  let snapshotId: string | undefined;
  let builderAlive = true;
  let fork: Machine | undefined;
  const kill = (m: Machine) => killUntilGone(opts.backend, m, opts.killConfirm);
  try {
    stage("snapshotting", `golden-v${versionNum}`);
    snapshotId = await builder.machine.snapshot(`golden-v${versionNum}`);
    await kill(builder.machine);
    builderAlive = false;

    stage("smoke-forking", smoke);
    fork = await opts.backend.create({
      kind: builder.kind,
      fromSnapshot: snapshotId,
      ...sizeAsked(opts.backend, opts, builder.size),
      ...envSpec(opts),
    });
    const smokeRes = await fork.exec(smoke, { timeoutMs: opts.smokeTimeoutMs ?? 120_000 });
    if (smokeRes.exitCode !== 0) {
      throw new Error(
        `golden smoke failed (exit ${smokeRes.exitCode}) for ${JSON.stringify(smoke)}: ${smokeRes.stderr.slice(-500)}`,
      );
    }
    // Read on the fork, which is the image: forks of this version get BROWSER only when the shim is there.
    const browserShim = (await fork.exec(`test -x ${BROWSER_SHIM_PATH}`)).exitCode === 0;
    // The image is proven by now; a fork that outlives its kills is a leak to
    // name, not a reason to throw the person's setup away.
    let leak: string | undefined;
    await kill(fork).catch((k: unknown) => {
      leak = messageOf(k);
    });

    const version: GoldenVersion = {
      version: versionNum,
      snapshotId,
      baseTemplate: builder.baseTemplate,
      kind: builder.kind,
      setupSha: builder.setupSha,
      createdAt: new Date().toISOString(),
      smoke: { cmd: smoke, exitCode: smokeRes.exitCode },
      size: builder.size,
      browserShim,
      ...(opts.logins !== undefined ? { logins: opts.logins } : {}),
    };
    stage("sealed", leak === undefined ? `v${versionNum}` : `v${versionNum}; ${leak}`);
    return { manifest: { head: versionNum, versions: [...prior, version] }, version };
  } catch (e) {
    let detail = messageOf(e);
    const leaked = (k: unknown) => {
      detail += `; ${messageOf(k)}`;
    };
    if (builderAlive && !(e instanceof MachineAliveError)) await kill(builder.machine).catch(leaked);
    if (fork) await kill(fork).catch(leaked);
    if (snapshotId !== undefined) await opts.backend.deleteSnapshot(snapshotId).catch(() => {});
    stage("failed", detail);
    throw e;
  }
}

/** The scripted pipeline: prepare then seal, no one in between. */
export async function buildGolden(
  opts: BuildGoldenOptions,
): Promise<{ manifest: GoldenManifest; version: GoldenVersion }> {
  const { backend, setup, smoke, kind, baseTemplate, manifest, setupTimeoutMs, smokeTimeoutMs, onStage, labels, ...size } = opts;
  const builder = await prepareBuilder({
    backend,
    setup,
    ...size,
    labels: { ...labels, "wsp-builder": "1" },
    ...(kind !== undefined ? { kind } : {}),
    ...(baseTemplate !== undefined ? { baseTemplate } : {}),
    ...(setupTimeoutMs !== undefined ? { setupTimeoutMs } : {}),
    ...(onStage !== undefined ? { onStage } : {}),
  });
  return sealGolden(builder, {
    backend,
    smoke,
    ...size,
    labels: { ...labels, "wsp-smoke": "1", createdAt: new Date().toISOString() },
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
    ...sizeAsked(backend, overrides, head.size),
    ...envSpec(overrides),
  });
}

export function rollback(manifest: GoldenManifest, version: number): GoldenManifest {
  if (!manifest.versions.some(v => v.version === version)) {
    throw new Error(`rollback target v${version} not in manifest`);
  }
  return { ...manifest, head: version };
}
