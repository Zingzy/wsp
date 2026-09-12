// SPDX-License-Identifier: AGPL-3.0-only
// A provider that answers out of memory: every call lands here and nothing
// leaves the computer. It exists so a harness can serve a fixture state whose
// workspaces are forks, which no other module can do without a key and a
// network: a host with no provider refuses get() and every cloud record in the
// file fails to load. It sits behind the same MachineBackend seam the Solari
// module does, so nothing above the registry learns which one it holds.
//
// get() answers for an id it never minted, which is the one thing a fixture
// needs: a state file naming fk_c0ffee gets a running machine rather than a
// refusal, and one naming fk_c0ffee.paused gets a machine asleep. The guest is
// not simulated: exec and run answer exit 0 with nothing, and the machine lands
// no bytes, so the daemon deploy never starts and every road that needs a guest
// refuses by capability the way it does on a provider that has none.

import type { Capabilities, MachineFacts } from "@wsp/protocol";
import { randomBytes } from "node:crypto";
import type {
  BackendPricing,
  ExecResult,
  Lifecycle,
  Machine,
  MachineBackend,
  MachineShape,
  MachineSpec,
  MachineState,
  SnapshotRow,
  SnapshotStoragePricing,
} from "./machine.js";

/** The sizes this provider offers, small enough that no fixture reads as a machine nobody would buy. */
const SIZES = [
  { cpu: 2, memMb: 4096 },
  { cpu: 4, memMb: 8192 },
  { cpu: 8, memMb: 16_384 },
] as const;

/** A made-up price with the shape of a real one: it rises with the size, so a row that shows a rate shows a number
 * that moves when the size does. */
const rateUsdPerHour = (size: { cpu: number; memMb: number }): number => Number((size.cpu * 0.02 + (size.memMb / 1024) * 0.01).toFixed(4));

const SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 10, usdPerGbMonth: 0.15, billedFrom: "2026-01-01" };

const PRICING: BackendPricing = {
  rateUsdPerHour,
  defaultSize: { cpu: 4, memMb: 8192 },
  snapshotStorage: SNAPSHOT_STORAGE,
  builderDiskGb: 20,
};

/** Instant everywhere: a wake that never has to ask twice and a daemon that is never waited for. */
const LIFECYCLE: Lifecycle = { budgets: { wakeAttempts: 1, daemonAnswersMs: 1_000 } };

const NOTHING: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

const id = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

/** The suffix a machine id wears to come up asleep. A fixture is a file and this backend holds nothing between
 * runs, so the id is the only place a state can be written down where both the record and the provider read it;
 * without it every napping workspace in a fixture would hydrate awake, since the provider's word wins. */
export const FAKE_PAUSED_SUFFIX = ".paused";

const stateOf = (machineId: string): MachineState => (machineId.endsWith(FAKE_PAUSED_SUFFIX) ? "paused" : "running");

/** One machine this provider holds: a state, a shape and its labels, all of it in this process. */
class FakeMachine implements Machine {
  readonly kind = "sandbox" as const;
  readonly streamUrl = undefined;
  state_: MachineState;

  constructor(
    readonly id: string,
    readonly labels: Record<string, string>,
    private readonly shape: MachineShape,
    private readonly snapshots: (row: SnapshotRow) => void,
  ) {
    this.state_ = stateOf(id);
  }

  get seen(): { state: MachineState; createdAt?: string } {
    return { state: this.state_, ...(this.shape.createdAt !== undefined ? { createdAt: this.shape.createdAt } : {}) };
  }

  async exec(): Promise<ExecResult> {
    return NOTHING;
  }

  async run(): Promise<ExecResult> {
    return NOTHING;
  }

  async snapshot(name: string): Promise<string> {
    const row = { id: id("fksnap"), name, sizeBytes: 8 * 1024 ** 3, createdAt: new Date().toISOString() };
    this.snapshots(row);
    return row.id;
  }

  async pause(): Promise<void> {
    this.state_ = "paused";
  }

  async resume(): Promise<void> {
    this.state_ = "running";
  }

  async kill(): Promise<void> {
    this.state_ = "gone";
  }

  async state(): Promise<MachineState> {
    return this.state_;
  }

  async downloadUrl(): Promise<string> {
    throw new Error("this provider mints no signed download URL");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("this provider mints no signed upload URL");
  }

  async describe(): Promise<MachineShape> {
    return this.shape;
  }

  async facts(): Promise<MachineFacts> {
    return { os: "Debian GNU/Linux 12", uptimeMs: 3 * 3_600_000, folder: "/root" };
  }
}

export interface FakeBackendOptions {
  /** The shape every machine takes when a create names none; the pricing's default size otherwise. */
  size?: { cpu: number; memMb: number };
}

export class FakeBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: true,
    pauseMode: "memory",
    // No provider in this table gives a machine that exists a new size, so neither does this one: a fixture that
    // offered a size upgrade would put a control in front of a tester that no person has, and the confusion it
    // caused would be read as the product's.
    resize: false,
    replacesMachine: true,
    previewUrls: false,
    // No byte road and no signed URL: landsBytes reads false, so nothing tries to put a daemon on a machine that
    // has no guest behind it.
    signedUrls: false,
    containers: true,
    callbackRelay: false,
    diskSnapshots: true,
    snapshotListing: true,
    templates: false,
    sizes: SIZES.map(size => ({ ...size, rateUsdPerHour: rateUsdPerHour(size) })),
    kept: false,
  };

  readonly pricing = PRICING;
  readonly lifecycle = LIFECYCLE;

  private readonly held = new Map<string, FakeMachine>();
  private readonly rows: SnapshotRow[] = [];
  private readonly size: { cpu: number; memMb: number };

  constructor(opts: FakeBackendOptions = {}) {
    this.size = opts.size ?? PRICING.defaultSize;
  }

  private mint(machineId: string, spec: Partial<MachineSpec> = {}): FakeMachine {
    const machine = new FakeMachine(
      machineId,
      spec.labels ?? {},
      { cpu: spec.cpu ?? this.size.cpu, memMb: spec.memMb ?? this.size.memMb, diskGb: spec.diskGb ?? 20, createdAt: new Date().toISOString() },
      row => this.rows.push(row),
    );
    this.held.set(machineId, machine);
    return machine;
  }

  async create(spec: MachineSpec): Promise<Machine> {
    return this.mint(id("fk"), spec);
  }

  /** A machine this backend never minted is minted here in the state its id says: a fixture state names its
   * machines before any process has held them, and a refusal would be every one of its workspaces failing to load. */
  async get(machineId: string): Promise<Machine> {
    return this.held.get(machineId) ?? this.mint(machineId);
  }

  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [...this.held.values()].map(m => ({ id: m.id, state: m.state_, labels: m.labels ?? {} }));
  }

  async listSnapshots(): Promise<SnapshotRow[]> {
    return [...this.rows];
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const at = this.rows.findIndex(r => r.id === snapshotId);
    if (at !== -1) this.rows.splice(at, 1);
  }
}
