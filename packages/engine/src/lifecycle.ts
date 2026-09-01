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
}

export type WorkspacePhase = "running" | "napping";

export class Workspace {
  private machine: Machine;
  private phase: WorkspacePhase = "running";
  // Snapshot-fresh rule: Solari 502s deterministically when snapshotting a
  // machine that was ever resumed cross-host, and same-host vs cross-host is
  // invisible from outside. So any resume disqualifies direct snapshots.
  private firstLife = true;
  // Keyed by machine id: pause+wake keeps a reach valid (measured), but a
  // resurrect/upgrade replaces the machine and voids it.
  private preview?: { machineId: string; reach: PreviewReach };

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

  /** Reach for the in-guest daemon: mints the :7070 preview URL, reusing the
   * cached one while it is fresh (under ~50 min old). */
  async daemonReach(): Promise<PreviewReach> {
    const cached = this.preview?.machineId === this.machine.id ? this.preview.reach : undefined;
    const reach = await refreshPreviewToken(this.machine, DAEMON_PORT, cached);
    this.preview = { machineId: this.machine.id, reach };
    return reach;
  }

  async nap(): Promise<void> {
    if (this.phase === "napping") return;
    await this.machine.pause();
    this.phase = "napping";
  }

  async wake(): Promise<void> {
    if (this.phase === "running") return;
    try {
      await this.machine.resume();
      this.firstLife = false;
    } catch (e) {
      if ((e as WspError).kind !== "missing" || !this.hooks.resurrect) throw e;
      // Paused machines can vanish after hours (PoC overnight-pause finding).
      this.machine = await this.hooks.resurrect();
      this.firstLife = true;
    }
    this.phase = "running";
  }

  async checkpoint(name: string): Promise<string> {
    if (!this.firstLife) {
      throw new Error(
        `checkpoint(${name}) refused: machine ${this.machine.id} is not first-life (was resumed); build images via the golden pipeline instead`,
      );
    }
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
