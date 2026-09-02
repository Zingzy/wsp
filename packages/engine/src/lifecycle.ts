import type { Machine, MachineSpec, PreviewReach } from "./machine.js";
import type { WspError } from "./errors.js";
import { DAEMON_PORT, refreshPreviewToken } from "./preview.js";

export interface WorkspaceHooks {
  goldenSnapshot: string;
  /** Fresh fork from the golden image; used when a paused machine vanished or on upgrade. */
  resurrect?: (spec?: Partial<MachineSpec>) => Promise<Machine>;
  /** Export durable state (vault) off a machine before it is replaced. */
  vaultExport?: (m: Machine) => Promise<Buffer>;
  /** Restore durable state (vault) onto a replacement machine. */
  vaultImport?: (m: Machine, payload: Buffer) => Promise<void>;
  /** Runs before every pause: keep a copy of the vault the machine may never hand back. */
  stashVault?: (m: Machine) => Promise<void>;
  /** Puts the last stashed vault onto a machine that replaced one that never came back. */
  restoreVault?: (m: Machine) => Promise<void>;
  /** Judges a resumed machine; undefined means healthy, a string names the fault. */
  wakeCheck?: (m: Machine) => Promise<string | undefined>;
}

export type WorkspacePhase = "running" | "napping" | "waking";

export interface WakeResult {
  resurrected: boolean;
  /** Present when the wake did not go straight through: every fault met on the way, in order. */
  reason?: string;
}

/** Resume, check, and one more resume+check before a machine is given up on. */
const WAKE_ATTEMPTS = 2;

/** Thrown when a snapshot is asked of a machine that has been resumed. Typed so
 * callers (the wizard) can tell "start over" from an ordinary failure. */
export class NotFirstLifeError extends Error {
  readonly kind = "notFirstLife" as const;
  constructor(
    readonly machineId: string,
    action: string,
  ) {
    super(`${action} refused: machine ${machineId} is not first-life (it was resumed); snapshots only come from fresh machines`);
    this.name = "NotFirstLifeError";
  }
}

/** The snapshot-fresh rule as one check: every snapshot in the engine goes through it. */
export function assertFirstLife(machineId: string, firstLife: boolean, action: string): void {
  if (!firstLife) throw new NotFirstLifeError(machineId, action);
}

function isMissing(e: unknown): boolean {
  return (e as WspError).kind === "missing";
}

export class Workspace {
  private machine: Machine;
  private phase: WorkspacePhase = "running";
  // Snapshot-fresh rule: Solari 502s deterministically when snapshotting a
  // machine that was ever resumed cross-host, and same-host vs cross-host is
  // invisible from outside. So any resume disqualifies direct snapshots.
  private firstLife = true;
  // Keyed by port under one machine id: pause+wake keeps a reach valid
  // (measured), but a resurrect/upgrade replaces the machine and voids them all.
  private preview: { machineId: string; byPort: Map<number, PreviewReach> } = { machineId: "", byPort: new Map() };

  constructor(
    machine: Machine,
    private readonly hooks: WorkspaceHooks,
    initial?: { phase?: WorkspacePhase; firstLife?: boolean },
  ) {
    this.machine = machine;
    this.phase = initial?.phase ?? "running";
    this.firstLife = initial?.firstLife ?? true;
  }

  get machineId(): string {
    return this.machine.id;
  }

  get currentPhase(): WorkspacePhase {
    return this.phase;
  }

  get isFirstLife(): boolean {
    return this.firstLife;
  }

  get goldenSnapshot(): string {
    return this.hooks.goldenSnapshot;
  }

  /** Reach for the in-guest daemon: the :7070 route through portReach. */
  async daemonReach(): Promise<PreviewReach> {
    return this.portReach(DAEMON_PORT);
  }

  /** Public route to one guest port, reusing the cached one while it is fresh
   * (under ~50 min old). Whether anything listens there is not checked here. */
  async portReach(port: number): Promise<PreviewReach> {
    if (this.preview.machineId !== this.machine.id) this.preview = { machineId: this.machine.id, byPort: new Map() };
    const reach = await refreshPreviewToken(this.machine, port, this.preview.byPort.get(port));
    this.preview.byPort.set(port, reach);
    return reach;
  }

  async nap(): Promise<void> {
    if (this.phase === "napping") return;
    await this.hooks.stashVault?.(this.machine);
    await this.machine.pause();
    this.phase = "napping";
  }

  /** Done when the resumed machine passes the wake check, not when resume()
   * returns: Solari has handed back a machine reporting running whose guest
   * never served again (resume fell back to a fresh host at default size).
   * Such a machine gets one more pause+resume, then a golden fork with the
   * stashed vault replaces it and the zombie is killed. */
  async wake(): Promise<WakeResult> {
    if (this.phase === "running") return { resurrected: false };
    this.phase = "waking";
    try {
      const faults: string[] = [];
      for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
        try {
          await this.machine.resume();
        } catch (e) {
          if (!isMissing(e)) throw e;
          // Paused machines can vanish after hours (PoC overnight-pause finding).
          faults.push(`machine ${this.machine.id} vanished while paused`);
          break;
        }
        this.firstLife = false;
        const fault = this.hooks.wakeCheck ? await this.hooks.wakeCheck(this.machine) : undefined;
        if (fault === undefined) {
          this.phase = "running";
          return faults.length === 0 ? { resurrected: false } : { resurrected: false, reason: faults.join("; ") };
        }
        faults.push(`attempt ${attempt}: ${fault}`);
        if (attempt < WAKE_ATTEMPTS) {
          await this.machine.pause().catch((e: unknown) => {
            faults.push(`re-pause failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }
      const reason = faults.join("; ");
      if (!this.hooks.resurrect) throw new Error(`wake failed: ${reason}`);
      const zombie = this.machine;
      this.machine = await this.hooks.resurrect();
      this.firstLife = true;
      await this.hooks.restoreVault?.(this.machine);
      await zombie.kill().catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
      this.phase = "running";
      return { resurrected: true, reason };
    } catch (e) {
      this.phase = "napping";
      throw e;
    }
  }

  async checkpoint(name: string): Promise<string> {
    assertFirstLife(this.machine.id, this.firstLife, `checkpoint(${name})`);
    return this.machine.snapshot(name);
  }

  /** Replace the machine with a fresh golden fork under a new spec, carrying vaulted state across. */
  async upgrade(spec?: Partial<MachineSpec>): Promise<void> {
    if (!this.hooks.resurrect) throw new Error("upgrade requires a resurrect hook");
    const payload = this.hooks.vaultExport ? await this.hooks.vaultExport(this.machine) : undefined;
    await this.machine.kill();
    this.machine = await this.hooks.resurrect(spec);
    if (payload !== undefined && this.hooks.vaultImport) {
      await this.hooks.vaultImport(this.machine, payload);
    }
    this.phase = "running";
    this.firstLife = true;
  }
}
