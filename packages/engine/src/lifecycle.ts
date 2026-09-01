import type { Machine, MachineSpec } from "./machine.js";
import type { WspError } from "./errors.js";

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

  constructor(machine: Machine, private readonly hooks: WorkspaceHooks) {
    this.machine = machine;
  }

  get machineId(): string {
    return this.machine.id;
  }

  get goldenSnapshot(): string {
    return this.hooks.goldenSnapshot;
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
