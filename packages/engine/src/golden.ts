// SPDX-License-Identifier: AGPL-3.0-only
// Golden images in two halves so the scripted pipeline and the first-run
// wizard share one road: prepareBuilder boots a fresh machine and installs the
// harness (nothing personal on it yet); sealGolden snapshots it, proves the
// snapshot boots by smoke-testing a fork, and appends a manifest version.
// Between the halves a person may sit on the builder's live screen for as
// long as they like, as long as nobody pauses it (snapshot-fresh rule).

import { createHash } from "node:crypto";
import { ROAD_STEPS } from "@wsp/catalog";
import { ALREADY_APPLIED, MCP_ID_PREFIX, fmtBytes, goldenHead, snapshotAttemptLine, snapshotFailedLine, type GoldenBaseTool, type GoldenLeftBehind, type GoldenLogin, type GoldenManifest, type GoldenMissingTool, type GoldenRetired, type GoldenStage, type GoldenStep, type GoldenVersion, type BuilderReading, type ProviderAnswer, type RecipeDigest } from "@wsp/protocol";
import { nameOf, rungOf } from "./golden-diff.js";
import { AGENT_INSTALLERS, NODE_PATH_LINE, type AgentInstall, type LoginShell, type NodeInstall, type ShellInstall, type SkippedPath, type ToolInstall } from "./golden-import.js";
import { PRELUDE } from "./dotfiles-presets.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { MIB, closing, freeBytes, freeNote, guardDeadlineMs, guarded, installTools, plural, reasonOf, sweepCaches, withRecordedPins, type ToolResult } from "./golden-tools.js";
import { installBase } from "./golden-base.js";
import { BUILDER_DISK_GB } from "./tool-sizes.js";
import { assertFirstLife } from "./lifecycle.js";
import { applyMcp, mcpTally, type McpPlan, type McpResult } from "./golden-mcp.js";
import { BROWSER_SHIM_PATH, applyMachineContext, type ContextResult } from "./machine-context.js";
import type { Machine, MachineBackend, MachineKind, MachineState } from "./machine.js";
import { isMissing } from "./errors.js";
import { BUILDER_LABEL, CREATED_AT_LABEL, SMOKE_LABEL } from "./labels.js";
import { importInto } from "./vault.js";

export { goldenHead, type GoldenLeftBehind, type GoldenLogin, type GoldenManifest, type GoldenMissingTool, type GoldenStage, type GoldenVersion };

export type StageListener = (stage: GoldenStage, detail?: string, step?: GoldenStep) => void;

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

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How often the seal asks for the snapshot the provider refused with its 502, and how long it waits between asks. */
export const SNAPSHOT_ATTEMPTS = 3;
export const SNAPSHOT_RETRY_MS = 60_000;

/** The snapshot was refused on every attempt the seal was willing to make, or the builder stopped reading running
 * between them, or the provider would not say. Typed so the wizard's words follow what the provider said: only a
 * builder it answers 404 for is gone at the provider's hand; every other one is left as it was. */
export class SnapshotFailedError extends Error {
  readonly kind = "snapshotFailed" as const;
  constructor(
    readonly machineId: string,
    readonly attempts: number,
    readonly answer: ProviderAnswer,
    readonly builderState: BuilderReading,
    /** Why the builder went unread: the GET's own failure. */
    readonly readError?: string,
  ) {
    super(snapshotFailedLine(attempts, answer, builderState, readError));
    this.name = "SnapshotFailedError";
  }
}

const isSnapshotRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "snapshotUnavailable";
const answerOf = (e: unknown): ProviderAnswer => {
  const { status, requestId } = e as { status?: number; requestId?: string };
  return { status: status ?? 502, message: messageOf(e), ...(requestId !== undefined ? { requestId } : {}), at: new Date().toISOString() };
};
/** What the provider says the machine is now, one read: a 404 reads as gone, any other failed read as unread with its reason. */
const readState = async (machine: Machine): Promise<{ state: BuilderReading; readError?: string }> => {
  try {
    return { state: await machine.state() };
  } catch (e) {
    return isMissing(e) ? { state: "gone" } : { state: "unread", readError: messageOf(e) };
  }
};

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
  /** Default sandbox (the wizard shows a terminal on it); desktop streams a display instead. */
  kind?: MachineKind;
  baseTemplate?: string;
  /** Host-owned step (the daemon bundle lives outside the engine); skipped when
   * absent. A returned string is reported as the deploying-daemon detail. */
  deployDaemon?: (machine: Machine) => Promise<void | string>;
  /** Harness install; its sha is recorded in the manifest. */
  setup: string;
  /** The person's files, agents and tools: files after the daemon, agents with the harness, tools last. */
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
  /** The golden snapshot this builder descends from, so the version it seals records its parent; absent on a fresh machine. */
  readonly parentSnapshotId?: string;
  /** The base tools' versions read on this machine after the base stage, or on the golden it was forked from. */
  readonly base?: GoldenBaseTool[];
  /** What this machine carries that its recipe no longer asks for, carried from the version it was forked from;
   * absent on a fresh machine, whose recipe asks for everything on it. */
  readonly retired?: GoldenRetired[];
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
  /** Commands the rc files call that the image does not have, once each; the pack defined each as a silent no-op. */
  silenced: string[];
  /** The skips a fork should know about, stamped on the sealed version: a hook whose script did not travel. */
  leftBehind?: GoldenLeftBehind[];
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
    /** Builds the archive. */
    pack: () => Promise<PackedFiles>;
    /** The planned files a tool rewrites while it runs, `~`-relative: they never decide the hash, so an
     * attach uploads the latest copy again. Absent when none was ticked. */
    volatile?: { paths: string[]; pack: () => Promise<PackedFiles> };
  };
  /** The person's login shell and its frameworks, put on the machine before the files land. */
  shell?: ShellInstall;
  tools: ToolInstall[];
  /** Runs once before the agents when a ticked agent's engines floor may be above the base image's Node. */
  node?: NodeInstall;
  agents: AgentInstall[];
  /** Ticked agents the plan set aside (no installer, no pinned Node); they count as ticked and land in the result. */
  skippedAgents?: { id: string; name: string; note: string }[];
  /** Ticked tools the plan set aside (no Linux bottle, a macOS app); they land in the result with the installs. */
  skippedTools?: { id: string; label: string; note: string }[];
  /** Ticked tools the base stage already put on every golden; they land in the result as installed, with the planner's note. */
  baseTools?: { id: string; label: string; note: string }[];
  /** The MCP servers to keep in or take out of each agent's config once it is on the machine; absent when no row is one. */
  mcp?: McpPlan;
  /** Called once per prepare that ran anything; a re-run that skipped every stage has nothing to report. */
  onResult?: (result: ImportResult) => void;
  /** Called when a pass that reports no result wrote the machine context, so the saved result can take the write's
   * outcome in place of the one the build recorded. */
  onContext?: (outcome: Pick<ImportResult, "context" | "contextFailure">) => void;
}

export type ImportStage = "applying-setup" | "uploading-files" | "installing-tools" | "installing-harness" | "installing-mcp";

export interface ImportLedger {
  recipeHash: string;
  recipe?: RecipeDigest;
  applied: ImportStage[];
  /** The version checks of the agents that installed, joined; the seal runs this on the fork. */
  smoke: string;
  /** The tools the tools stage did not put on the image, skipped or failed, and why; absent when every tool installed.
   * The seal stamps it on the version. */
  missingTools?: GoldenMissingTool[];
  /** The rc calls the pack silenced, once each; absent when every call has a command behind it. The seal stamps it on the version. */
  silenced?: string[];
  /** What the login shell printed to stderr on its first interactive start after the files landed, as the version records it; absent when it started quiet. */
  shellNoise?: string;
  /** What the pack left off the image and why; absent when everything ticked travelled. The seal stamps it on the version. */
  leftBehind?: GoldenLeftBehind[];
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
  mcp?: McpResult[];
  /** Only on an update: the rows it took out of the recipe and left on the image. */
  retired?: GoldenRetired[];
  /** The base stage's outcomes on a fresh builder; an update's fork carries its golden's. */
  base?: ToolResult[];
  /** The machine context each installed agent got, or why it did not; absent when no stage ran. */
  context?: ContextResult[];
  /** Why no machine context was written, when the probe or the upload failed; context is empty then. */
  contextFailure?: string;
}

export interface ApplyImportOptions {
  import?: GoldenImport;
  setup: string;
  /** What the base stage did on this builder, so a floor row that did not land is in the result with the person's tools. */
  base?: ToolResult[];
  /** Stages this builder already carries; those for the same recipe hash are skipped. */
  ledger?: ImportLedger;
  /** Only on an update: the rows the recipe stopped asking for, so the result names what the image still carries. */
  retired?: GoldenRetired[];
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** Extraction needs the archive and its contents at once, plus what the agents install after. */
const UPLOAD_HEADROOM = 256 * MIB;
/** The Claude installer peaks near 410 MB (measured 2026-09-02); an agent does not start under this. */
const AGENTS_DISK_FLOOR = 800 * MIB;
const AGENT_TIMEOUT_S = 900;
const SHELL_TIMEOUT_S = 300;
/** A harness-stage install under the guard, with every road's network lines ahead of it: the setup line, the Node
 * floor and the agents' installers type the bare curl the road table's function defines, and may type any manager. */
const guardedHarness = (script: string): string => guarded([...ROAD_STEPS.script.env, script].join("\n"), AGENT_TIMEOUT_S);
const SHELL_CHECK_S = 60;

/** One start of the login shell the way the app's pty runs it, a login shell (profile.d puts the tools on PATH before
 * the rc files) and interactive (the rc files are read): what it prints to stderr is what the person sees before the
 * first prompt. The guest exec has no HOME, so the prelude sets it. */
const shellCheck = (shell: LoginShell): string => `${PRELUDE}\nTERM=xterm-256color ${shell} -lic true </dev/null || true`;

/** Runs the import stages and the harness on a builder, skipping what the
 * ledger says is already there for the same recipe. Files and upload fail the
 * build; each tool and agent fails alone and is named in the stage detail. */
export async function applyGoldenImport(machine: Machine, opts: ApplyImportOptions): Promise<{ ledger: ImportLedger; result: ImportResult }> {
  const stage = opts.onStage ?? (() => {});
  const imp = opts.import ?? { recipeHash: "", tools: [], agents: [] };
  const prior = opts.ledger?.recipeHash === imp.recipeHash ? opts.ledger : undefined;
  const recipe = imp.recipe ?? prior?.recipe;
  const ledger: ImportLedger = {
    recipeHash: imp.recipeHash,
    applied: [...(prior?.applied ?? [])],
    smoke: prior?.smoke ?? "true",
    ...(recipe !== undefined ? { recipe } : {}),
    ...(prior?.missingTools !== undefined ? { missingTools: prior.missingTools } : {}),
    ...(prior?.silenced !== undefined ? { silenced: prior.silenced } : {}),
    ...(prior?.shellNoise !== undefined ? { shellNoise: prior.shellNoise } : {}),
    ...(prior?.leftBehind !== undefined ? { leftBehind: prior.leftBehind } : {}),
  };
  const result: ImportResult = { recipeHash: imp.recipeHash, tools: [], agents: [], ...(opts.base !== undefined ? { base: opts.base } : {}), ...(opts.retired !== undefined ? { retired: opts.retired } : {}) };
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
    stage("uploading-files", closing(`${label}${fmtBytes(packed.bytes)}${parts > 1 ? ` in ${parts} parts` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, await freeNote(machine)));
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
      delete ledger.leftBehind;
      mark("applying-setup");
      mark("uploading-files");
    } else {
      const rungs = Object.entries(imp.files.rungs).map(([r, n]) => `${r} ${n}`).join(", ");
      stage("applying-setup", `${imp.files.count} file${imp.files.count === 1 ? "" : "s"}: ${rungs}`);
      const packed = await imp.files.pack();
      packed.skipped = [...imp.files.skipped, ...packed.skipped];
      if (packed.leftBehind !== undefined && packed.leftBehind.length > 0) ledger.leftBehind = packed.leftBehind;
      else delete ledger.leftBehind;
      const notes = packed.skipped.map(s => `${s.path} (${s.note})`);
      const silenced = packed.silenced.length > 0 ? `; silenced in the shell: ${packed.silenced.join(", ")}` : "";
      stage("applying-setup", `${fmtBytes(packed.bytes)} packed${notes.length > 0 ? `; skipped ${notes.join(", ")}` : ""}${silenced}`);
      if (packed.silenced.length > 0) ledger.silenced = packed.silenced;
      else delete ledger.silenced;
      mark("applying-setup");
      // The frameworks clone into empty homes, so the shell goes on before the files land; the upload's mark covers it.
      if (imp.shell !== undefined) {
        const { shell, frameworks, cmd } = imp.shell;
        const named = frameworks.join(", ");
        stage("applying-setup", `${shell}: installing${named !== "" ? `, with ${named}` : ""}`);
        const res = await machine.run(guarded(cmd, SHELL_TIMEOUT_S), { deadlineMs: guardDeadlineMs(SHELL_TIMEOUT_S), onLine: line => stage("applying-setup", `${shell}: ${line}`) });
        if (res.exitCode === 0) stage("applying-setup", closing(`${shell} installed as the login shell${named !== "" ? `; ${named} reinstalled` : ""}`, await freeNote(machine)));
        else stage("applying-setup", `${shell} step failed, chsh skipped: ${reasonOf(res, SHELL_TIMEOUT_S)}`);
      }

      stage("uploading-files", fmtBytes(packed.bytes));
      ran = true;
      await upload(packed, "");
      result.files = { bytes: packed.bytes, skipped: packed.skipped, cut: packed.cut };
      mark("uploading-files");
    }
  }

  const harnessRan = !done("installing-harness");
  if (!harnessRan) {
    stage("installing-harness", ALREADY_APPLIED);
  } else {
    stage("installing-harness");
    const res = await machine.run(guardedHarness(opts.setup), { deadlineMs: guardDeadlineMs(AGENT_TIMEOUT_S), onLine: line => stage("installing-harness", line) });
    if (res.exitCode !== 0) throw new Error(`golden setup failed: ${reasonOf(res, AGENT_TIMEOUT_S)}`);
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
        const free = await freeBytes(machine);
        if (free.kind === "free" && free.bytes < AGENTS_DISK_FLOOR) {
          result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: `${fmtBytes(free.bytes)} free, keeping ${fmtBytes(AGENTS_DISK_FLOOR)} free`, ms: 0 });
          continue;
        }
        stage("installing-harness", `${agent.name} (${i + 1}/${imp.agents.length})`);
        const install = await machine.run(guardedHarness(`${NODE_PATH_LINE}\n${agent.install}`), { deadlineMs: guardDeadlineMs(AGENT_TIMEOUT_S), onLine: line => stage("installing-harness", `${agent.name}: ${line}`) });
        const check = install.exitCode === 0 ? await machine.run(`${NODE_PATH_LINE}\n${agent.smoke}`, { deadlineMs: 60_000 }) : install;
        const ms = Date.now() - t0;
        if (check.exitCode === 0) result.agents.push({ id: agent.id, name: agent.name, outcome: "installed", ms });
        else result.agents.push({ id: agent.id, name: agent.name, outcome: "failed", note: reasonOf(check, AGENT_TIMEOUT_S), ms });
      }
      const installed = imp.agents.filter(a => result.agents.some(r => r.id === a.id && r.outcome === "installed"));
      const failed = result.agents.filter(r => r.outcome === "failed");
      // A golden with an agent missing is not sealed: the person ticked it, and the hand-off would open a terminal
      // on a machine without it. All-skipped is the same refusal with the plan's reasons.
      if (failed.length > 0 || (result.agents.length > 0 && installed.length === 0)) {
        imp.onResult?.(result);
        const header = failed.length > 0 ? `${failed.length === 1 ? "an agent" : `${failed.length} agents`} did not install, so nothing is sealed:` : "no agent installed, so there is nothing to seal:";
        throw new Error([header, ...result.agents.filter(r => r.outcome !== "installed").map(a => `${a.name}: ${a.note ?? "unknown reason"}`)].join("\n"));
      }
      ledger.smoke = joinSmoke(installed.map(a => a.smoke));
      const summary = result.agents.length === 0 ? "no agent ticked" : summarizeAgents(result.agents);
      stage("installing-harness", imp.agents.length > 0 || node !== undefined ? closing(summary, await sweepCaches(machine), await freeNote(machine)) : summary);
    }
    mark("installing-harness");
  }

  const toolsRan = !only && !done("installing-tools");
  if (!only) {
    if (!toolsRan) {
      stage("installing-tools", ALREADY_APPLIED);
    } else {
      for (const t of imp.skippedTools ?? []) result.tools.push({ id: t.id, label: t.label, outcome: "skipped", note: t.note });
      for (const t of imp.baseTools ?? []) result.tools.push({ id: t.id, label: t.label, outcome: "installed", note: t.note });
      if (imp.tools.length === 0) {
        stage("installing-tools", "nothing ticked");
      } else {
        ran = true;
        const tools = await installTools(machine, imp.tools, stage);
        result.tools.push(...tools.tools);
        if (tools.homebrew !== undefined) result.homebrew = tools.homebrew;
        if (ledger.recipe !== undefined) ledger.recipe = withRecordedPins(ledger.recipe, tools.tools);
      }
      const missing = missingToolsOf([...(result.base ?? []), ...result.tools]);
      if (missing.length > 0) ledger.missingTools = missing;
      else delete ledger.missingTools;
      mark("installing-tools");
    }
    // What the person sees before the first prompt: the rc files call tools and agents, so the shell starts once
    // everything that installs is on the machine, and only on a pass that changed it.
    let shellLine: string | undefined;
    if (imp.shell !== undefined && (ran || harnessRan)) {
      const res = await machine.run(guarded(shellCheck(imp.shell.shell), SHELL_CHECK_S), { deadlineMs: guardDeadlineMs(SHELL_CHECK_S) });
      const noise = res.exitCode === 124 ? [reasonOf(res, SHELL_CHECK_S)] : res.stderr.split("\n").filter(l => l.trim() !== "");
      if (noise.length === 0) {
        shellLine = `${imp.shell.shell} starts quiet`;
        delete ledger.shellNoise;
      } else {
        ledger.shellNoise = res.exitCode === 124 ? noise[0]! : `${noise[0]}, ${plural(noise.length, "line")}`;
        shellLine = `shell noise: ${ledger.shellNoise}`;
      }
    }
    // The edit runs on every pass that has a plan: an attach re-uploads the volatile ~/.claude.json, which brings every
    // laptop definition back as it was. It is idempotent and touches only the servers the plan names. It does not count
    // as a run for the result: on an attach the saved result from the build stands, tools and agents included.
    let edited = false;
    let servers: string | undefined;
    if (imp.mcp !== undefined) {
      edited = true;
      result.mcp = await applyMcp(machine, imp.mcp, stage, result.tools);
      servers = mcpTally(result.mcp);
    } else if (done("installing-mcp")) {
      stage("installing-mcp", ALREADY_APPLIED);
    } else {
      stage("installing-mcp", "none configured");
    }
    // The stage is applied once the context is on the machine, so an attach after a failed write runs it again.
    const contextWasOn = done("installing-mcp");
    if (harnessRan || ran || edited || !contextWasOn) {
      // After the tools, so the document can name what did not install.
      const context = await applyMachineContext(machine, { result: withSkippedStages(result, ledger, imp, { tools: toolsRan, harness: harnessRan }), ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}) });
      result.context = context.context;
      if (context.failure !== undefined) result.contextFailure = context.failure;
      else mark("installing-mcp");
      // A refused rewrite over a document that landed leaves the saved result true: the machine still holds it.
      if (!ran && (context.failure === undefined || !contextWasOn)) imp.onContext?.({ context: context.context, ...(context.failure !== undefined ? { contextFailure: context.failure } : {}) });
      // The stage's last detail is what the terminal keeps as its end line, so the servers' tally and the shell's first start ride with the context.
      stage("installing-mcp", closing(servers, shellLine, `machine context: ${context.summary}`));
    }
    if (ran || edited) {
      // A builder whose exec died (a full disk did it once) would be sealed and handed off answering nothing.
      const answer = await machine.exec("echo ok", { timeoutMs: INLINE_EXEC_MS });
      if (answer.exitCode !== 0 || answer.stdout.trim() !== "ok") {
        imp.onResult?.(result);
        throw new Error(`the machine stopped answering commands after the installs (exit ${answer.exitCode}); nothing is sealed`);
      }
    }
  }
  if (!only && ran && imp.onResult) imp.onResult(result);
  return { ledger, result };
}

/** The Node step, once: kept when the guest's major already meets the floor,
 * else the pinned release; a failed install names itself and fails only the
 * agents whose floor the guest's Node does not meet. */
async function installNode(machine: Machine, node: NodeInstall, stage: StageListener): Promise<{ haveMajor: number; failed?: string }> {
  stage("installing-harness", `Node for ${node.agents.join(", ")}`);
  const res = await machine.run(guardedHarness(node.cmd), { deadlineMs: guardDeadlineMs(AGENT_TIMEOUT_S), onLine: line => stage("installing-harness", `Node: ${line}`) });
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

function missingToolsOf(tools: readonly ToolResult[]): GoldenMissingTool[] {
  return tools.flatMap(t => (t.outcome === "installed" ? [] : [{ id: t.id, name: t.label, outcome: t.outcome, note: t.note ?? "no reason recorded" }]));
}

/** A stage this pass skipped has no outcomes in the result, but what it left off the machine is known: the ledger
 * keeps the tools, the plan the agents and files it set aside. The context's facts read this, the report the result. */
function withSkippedStages(result: ImportResult, ledger: ImportLedger, imp: GoldenImport, ran: { tools: boolean; harness: boolean }): ImportResult {
  return {
    ...result,
    tools: ran.tools ? result.tools : (ledger.missingTools ?? []).map(m => ({ id: m.id, label: m.name, outcome: m.outcome, note: m.note })),
    agents: ran.harness ? result.agents : (imp.skippedAgents ?? []).map(a => ({ id: a.id, name: a.name, outcome: "skipped" as const, note: a.note })),
    ...(result.files === undefined && imp.files !== undefined ? { files: { bytes: 0, skipped: imp.files.skipped } } : {}),
  };
}

function summarizeAgents(agents: AgentResult[]): string {
  const ok = agents.filter(a => a.outcome === "installed").map(a => a.name);
  const bad = agents.filter(a => a.outcome === "failed").map(a => `${a.name} failed (${a.note})`);
  const aside = agents.filter(a => a.outcome === "skipped").map(a => `${a.name} skipped (${a.note})`);
  return [ok.length > 0 ? `${ok.join(", ")} installed` : "", ...bad, ...aside].filter(s => s !== "").join("; ");
}

/** An updated version's sha chains the version it came from with what the delta ran, so it names both. */
export function nextSetupSha(previous: string, setup: string, imp: GoldenImport): string {
  return createHash("sha256").update(`${previous}\n${setupShaOf(setup, imp)}`).digest("hex");
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
  /** Leave the builder running after the snapshot (snapshotting does not end first-life, measured), so one more
   * change can re-snapshot it. When the account cap refuses the smoke fork beside it, the builder is killed first
   * and the fork tried once more, as a seal without this option does. */
  keepBuilder?: boolean;
  /** How long the seal waits between snapshot attempts the provider refused (tests shrink it). */
  snapshotRetryMs?: number;
}

export interface SealResult {
  manifest: GoldenManifest;
  version: GoldenVersion;
  /** True when keepBuilder was asked and the builder is still running. */
  builderKept: boolean;
}

export interface BuildGoldenOptions extends MachineSize {
  backend: MachineBackend;
  setup: string;
  smoke: string;
  kind?: MachineKind;
  baseTemplate?: string;
  manifest?: GoldenManifest;
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
    diskGb: BUILDER_DISK_GB,
    ...asked,
    ...envSpec(opts),
  });
  try {
    const size = await sizeBuilt(machine, asked);
    stage("deploying-daemon");
    // The floor goes on before the daemon, whose native module compiles against the Node it finds first on PATH.
    const base = await installBase(machine, stage);
    const deployed = opts.deployDaemon ? await opts.deployDaemon(machine) : undefined;
    const detail = closing(base.line, typeof deployed === "string" ? deployed : undefined, await freeNote(machine));
    if (detail !== "") stage("deploying-daemon", detail);
    const applied = await applyGoldenImport(machine, {
      setup: opts.setup,
      base: base.tools,
      onStage: stage,
      ...(opts.import !== undefined ? { import: opts.import } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
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
      base: base.versions,
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

const isCapRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "concurrency";

// Sequenced for a two-machine cap: unless the builder is kept, it dies before
// the smoke fork boots, so the seal itself never holds more than one machine.
export async function sealGolden(builder: Builder, opts: SealGoldenOptions): Promise<SealResult> {
  const stage = opts.onStage ?? (() => {});
  assertFirstLife(builder.machine.id, builder.firstLife, "seal");
  const smoke = builder.import?.smoke ?? opts.smoke;

  const prior = opts.manifest?.versions ?? [];
  const versionNum = (prior[prior.length - 1]?.version ?? 0) + 1;
  let snapshotId: string | undefined;
  let builderAlive = true;
  let fork: Machine | undefined;
  const kill = (m: Machine) => killUntilGone(opts.backend, m, opts.killConfirm);
  const forkSpec = () => ({
    kind: builder.kind,
    fromSnapshot: snapshotId!,
    diskGb: BUILDER_DISK_GB,
    ...sizeAsked(opts.backend, opts, builder.size),
    ...envSpec(opts),
  });
  const retryMs = opts.snapshotRetryMs ?? SNAPSHOT_RETRY_MS;
  // The 502 is asked again only while the provider still reads the builder running; one that reads otherwise is
  // never snapshotted, so the seal stops at once and says what the provider said.
  const takeSnapshot = async (): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await builder.machine.snapshot(`golden-v${versionNum}`);
      } catch (e) {
        if (!isSnapshotRefusal(e)) throw e;
        const answer = answerOf(e);
        const read = await readState(builder.machine);
        if (read.state !== "running" || attempt >= SNAPSHOT_ATTEMPTS) throw new SnapshotFailedError(builder.machine.id, attempt, answer, read.state, read.readError);
        stage("snapshotting", snapshotAttemptLine(attempt, SNAPSHOT_ATTEMPTS, answer, read.state, retryMs));
        await new Promise(r => setTimeout(r, retryMs));
      }
    }
  };
  try {
    stage("snapshotting", `golden-v${versionNum}`);
    snapshotId = await takeSnapshot();
    if (opts.keepBuilder !== true) {
      await kill(builder.machine);
      builderAlive = false;
    }

    stage("smoke-forking", smoke);
    try {
      fork = await opts.backend.create(forkSpec());
    } catch (e) {
      if (!builderAlive || !isCapRefusal(e)) throw e;
      stage("smoke-forking", `${smoke}; the account is at its machine cap, so the builder is not kept`);
      await kill(builder.machine);
      builderAlive = false;
      fork = await opts.backend.create(forkSpec());
    }
    const smokeRes = await fork.run(smoke, { deadlineMs: opts.smokeTimeoutMs ?? 120_000, onLine: line => stage("smoke-forking", line) });
    if (smokeRes.exitCode !== 0) {
      throw new Error(
        `golden smoke failed (exit ${smokeRes.exitCode}) for ${JSON.stringify(smoke)}: ${smokeRes.stderr.slice(-500)}`,
      );
    }
    // The stage's last detail is what the terminal keeps as its end line, so the tally follows the agents' output.
    stage("smoke-forking", smokeTally(smoke));
    // Read on the fork, which is the image: forks of this version get BROWSER only when the shim is there.
    const browserShim = (await fork.exec(`test -x ${BROWSER_SHIM_PATH}`, { timeoutMs: INLINE_EXEC_MS })).exitCode === 0;
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
      ...(builder.parentSnapshotId !== undefined ? { parentSnapshotId: builder.parentSnapshotId } : {}),
      createdAt: new Date().toISOString(),
      smoke: { cmd: smoke, exitCode: smokeRes.exitCode },
      size: builder.size,
      browserShim,
      ...(opts.logins !== undefined ? { logins: opts.logins } : {}),
      ...(builder.import?.missingTools !== undefined ? { missingTools: builder.import.missingTools } : {}),
      ...(builder.import?.silenced !== undefined ? { silenced: builder.import.silenced } : {}),
      ...(builder.import?.shellNoise !== undefined ? { shellNoise: builder.import.shellNoise } : {}),
      ...(builder.import?.leftBehind !== undefined ? { leftBehind: builder.import.leftBehind } : {}),
      ...(builder.base !== undefined ? { base: builder.base } : {}),
      ...(builder.retired !== undefined && builder.retired.length > 0 ? { retired: builder.retired } : {}),
    };
    const kept = builderAlive ? "; builder kept for one more change" : "";
    stage("sealed", leak === undefined ? `v${versionNum}${kept}` : `v${versionNum}${kept}; ${leak}`);
    return { manifest: { head: versionNum, versions: [...prior, version] }, version, builderKept: builderAlive };
  } catch (e) {
    let detail = messageOf(e);
    const leaked = (k: unknown) => {
      detail += `; ${messageOf(k)}`;
    };
    // A refused snapshot changed nothing on the builder: it is left as the person set it up, for the next attach.
    if (builderAlive && !(e instanceof MachineAliveError) && !(e instanceof SnapshotFailedError)) await kill(builder.machine).catch(leaked);
    if (fork) await kill(fork).catch(leaked);
    if (snapshotId !== undefined) await opts.backend.deleteSnapshot(snapshotId).catch(() => {});
    stage("failed", detail);
    throw e;
  }
}

// --- golden update: the recipe delta on a fork of the golden, or on the kept builder --

/** What changed between the recipe a golden was built from and the recipe now:
 * rows to apply, planned like a first build and hashed as the whole new
 * recipe, and the rows it stops asking for. */
export interface GoldenDelta {
  import: GoldenImport;
  /** The rows this delta takes out of the recipe. Nothing is taken off the image for them; this is what the run
   * says it is doing, so it names only what changed now. */
  retired: GoldenRetired[];
  /** Every row the next version's image carries that its recipe does not ask for: this delta's, plus the ones the
   * version being updated already carried, less any this delta installs again. What the version records, which is
   * a longer list than the run's words and must not be read as them. */
  retiredOnImage: GoldenRetired[];
}

export interface ApplyDeltaOptions {
  setup: string;
  /** The smoke of the version being updated; removed agents leave it, added ones join it. */
  previousSmoke: string;
  /** The tools missing from the version being updated; those the delta neither retires nor plans again stay missing. */
  previousMissing?: readonly GoldenMissingTool[];
  /** What the version being updated left off its image; the rows the delta neither removes nor plans again keep their notes. */
  previousLeftBehind?: readonly GoldenLeftBehind[];
  /** The base tools read on the version being updated; a version sealed before they existed has none and is refused. */
  previousBase: readonly GoldenBaseTool[] | undefined;
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** A version without the base tools never ran them, so a delta on it would report covered rows it does not have. */
function refusePreFloor(base: readonly GoldenBaseTool[] | undefined, which: string): asserts base is readonly GoldenBaseTool[] {
  if (base === undefined) throw new Error(`${which} was sealed before the base tools existed and cannot take an update; run wsp init and pick the rebuild`);
}

const SMOKE_JOIN = " && ";
/** The agents' version checks as one command for the fork; none is `true`, so the fork still boots and runs. */
function joinSmoke(checks: readonly string[]): string {
  return checks.length === 0 ? "true" : checks.join(SMOKE_JOIN);
}
function smokeChecks(smoke: string): string[] {
  return smoke.split(SMOKE_JOIN).filter(p => p !== "true");
}

/** The version checks of what is on the image after the delta: the previous
 * smoke without the removed agents', joined with the added agents'. */
export function nextSmoke(previous: string, removed: readonly string[], added: string): string {
  const parts = smokeChecks(previous).filter(p => !removed.includes(p));
  for (const p of smokeChecks(added)) if (!parts.includes(p)) parts.push(p);
  return joinSmoke(parts);
}

/** What a passed smoke proved, for the stage's end line: each check's agent, named by the installer table the
 * check came from; a check the table does not know is shown as itself. */
export function smokeTally(smoke: string): string {
  const checks = smokeChecks(smoke);
  if (checks.length === 0) return "no agent to check; the fork booted";
  const names = checks.map(c => Object.values(AGENT_INSTALLERS).find(i => i.smoke === c)?.name ?? c);
  return `${plural(checks.length, "agent")} ${checks.length === 1 ? "answers" : "answer"}: ${names.join(", ")}`;
}

/** The recipe rows a delta addresses: what it retires and what it plans again, tools and agents alike. */
function touchedBy(delta: GoldenDelta): Set<string> {
  return new Set([...delta.retired, ...delta.import.tools, ...(delta.import.skippedTools ?? []), ...delta.import.agents, ...(delta.import.skippedAgents ?? [])].map(t => t.id));
}

/** What an updated image is missing: the previous version's missing tools the delta neither retired nor planned again,
 * then what this delta's tools stage skipped or failed. A retired tool leaves the list; the recipe stopped asking
 * for it, so a fork has nothing to explain. */
export function nextMissing(previous: readonly GoldenMissingTool[], delta: GoldenDelta, fresh: readonly GoldenMissingTool[]): GoldenMissingTool[] {
  const touched = touchedBy(delta);
  return [...previous.filter(p => !touched.has(p.id)), ...fresh];
}

/** What an updated image is without: the previous version's notes for rows the delta neither retired nor planned
 * again, then what this delta's pack left behind. */
export function nextLeftBehind(previous: readonly GoldenLeftBehind[], delta: GoldenDelta, fresh: readonly GoldenLeftBehind[]): GoldenLeftBehind[] {
  const touched = touchedBy(delta);
  return [...previous.filter(p => !touched.has(p.id)), ...fresh];
}


/** Runs the delta through the import stages. Nothing is taken off the machine:
 * a row the recipe dropped keeps its bytes and rides the version's retired
 * list, so the update only ever adds. The files and upload fail the update as
 * they fail a build; each tool and agent fails alone. */
export async function applyDelta(machine: Machine, delta: GoldenDelta, opts: ApplyDeltaOptions): Promise<{ ledger: ImportLedger; result: ImportResult }> {
  refusePreFloor(opts.previousBase, "this golden");
  const stage = opts.onStage ?? (() => {});
  const retired = delta.retired;
  if (retired.length > 0) stage("applying-setup", `${plural(retired.length, "row")} left on the image, retired: ${retired.map(r => r.name).join(", ")}`);
  // The stages report only when one of them ran; a delta that only retires rows still has them to report.
  const report = delta.import.onResult;
  let reported = false;
  const imp: GoldenImport = { ...delta.import, ...(report !== undefined ? { onResult: (r: ImportResult) => { reported = true; report(r); } } : {}) };
  const applied = await applyGoldenImport(machine, {
    import: imp,
    setup: opts.setup,
    onStage: stage,
    ...(retired.length > 0 ? { retired } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  const result = applied.result;
  if (!reported && retired.length > 0) report?.(result);
  // A retired agent is still on the image, but the recipe stopped asking for it, so its check leaves the smoke:
  // the next version is only ever held to what its own recipe claims. The rung decides, never the id's last
  // segment: a tools row may end in an agent's name and must not take that agent's check with it.
  const gone = retired.flatMap(r => {
    const installer = rungOf(r.id) === "agents" && !r.id.startsWith(MCP_ID_PREFIX) ? AGENT_INSTALLERS[nameOf(r.id)] : undefined;
    return installer !== undefined ? [installer.smoke] : [];
  });
  applied.ledger.smoke = nextSmoke(opts.previousSmoke, gone, applied.ledger.smoke);
  const missing = nextMissing(opts.previousMissing ?? [], delta, applied.ledger.missingTools ?? []);
  if (missing.length > 0) applied.ledger.missingTools = missing;
  else delete applied.ledger.missingTools;
  const left = nextLeftBehind(opts.previousLeftBehind ?? [], delta, applied.ledger.leftBehind ?? []);
  if (left.length > 0) applied.ledger.leftBehind = left;
  else delete applied.ledger.leftBehind;
  return { ledger: applied.ledger, result };
}

export interface UpgradeBuilderOptions extends MachineSize {
  backend: MachineBackend;
  /** The version being updated; the fork boots from its snapshot at its size and kind. */
  head: GoldenVersion;
  delta: GoldenDelta;
  setup: string;
  fetch?: typeof globalThis.fetch;
  onStage?: StageListener;
}

/** Forks the golden into a fresh first-life machine and applies the delta on
 * it: a builder to seal as the next version. The fork carries the daemon and
 * everything the recipe already put there, so nothing but the delta runs. */
export async function upgradeBuilder(opts: UpgradeBuilderOptions): Promise<Builder> {
  refusePreFloor(opts.head.base, `golden v${opts.head.version}`);
  const stage = opts.onStage ?? (() => {});
  const kind = opts.head.kind ?? "sandbox";
  stage("creating", `fork of golden v${opts.head.version}`);
  const asked = sizeAsked(opts.backend, opts, opts.head.size);
  const createdAt = new Date().toISOString();
  const machine = await opts.backend.create({
    kind,
    fromSnapshot: opts.head.snapshotId,
    onIdle: "kill",
    idleTimeoutMs: BUILDER_IDLE_MS,
    diskGb: BUILDER_DISK_GB,
    ...asked,
    ...envSpec(opts),
  });
  try {
    const size = await sizeBuilt(machine, asked);
    const applied = await applyDelta(machine, opts.delta, {
      setup: opts.setup,
      previousSmoke: opts.head.smoke.cmd,
      previousBase: opts.head.base,
      ...(opts.head.missingTools !== undefined ? { previousMissing: opts.head.missingTools } : {}),
      ...(opts.head.leftBehind !== undefined ? { previousLeftBehind: opts.head.leftBehind } : {}),
      onStage: stage,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    stage("ready");
    return {
      machine,
      kind,
      baseTemplate: opts.head.baseTemplate,
      setupSha: nextSetupSha(opts.head.setupSha, opts.setup, opts.delta.import),
      createdAt,
      firstLife: true,
      size,
      import: applied.ledger,
      parentSnapshotId: opts.head.snapshotId,
      base: [...opts.head.base],
      retired: opts.delta.retiredOnImage,
    };
  } catch (e) {
    let detail = messageOf(e);
    await killUntilGone(opts.backend, machine).catch((k: unknown) => {
      detail += `; ${messageOf(k)}`;
    });
    stage("failed", detail);
    throw e;
  }
}

/** The scripted pipeline: prepare then seal, no one in between. */
export async function buildGolden(
  opts: BuildGoldenOptions,
): Promise<{ manifest: GoldenManifest; version: GoldenVersion }> {
  const { backend, setup, smoke, kind, baseTemplate, manifest, smokeTimeoutMs, onStage, labels, ...size } = opts;
  const builder = await prepareBuilder({
    backend,
    setup,
    ...size,
    labels: { ...labels, [BUILDER_LABEL]: "1" },
    ...(kind !== undefined ? { kind } : {}),
    ...(baseTemplate !== undefined ? { baseTemplate } : {}),
    ...(onStage !== undefined ? { onStage } : {}),
  });
  return sealGolden(builder, {
    backend,
    smoke,
    ...size,
    labels: { ...labels, [SMOKE_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
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
  const head = goldenHead(manifest);
  if (!head) throw new Error(`manifest head ${manifest.head} has no version entry`);
  return backend.create({
    kind: overrides.kind ?? head.kind ?? "sandbox",
    fromSnapshot: head.snapshotId,
    diskGb: BUILDER_DISK_GB,
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
