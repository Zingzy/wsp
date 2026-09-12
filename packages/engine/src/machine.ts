// The seam every backend sits behind. The data a backend takes and answers is
// the protocol's, since the same shapes travel a link when one computer drives
// another's machines and two copies would drift the day a field is added on
// one side; what stays here is the interfaces with methods, which no wire
// carries.
import type {
  Capabilities,
  DaemonSupervisor,
  ExecResult,
  LifecycleBudgets,
  MachineFacts,
  MachineKind,
  MachineLife,
  MachineListRow,
  MachineShape,
  MachineSpec,
  MachineState,
  PlaceCapacity,
  PreviewReach,
  SnapshotRow,
  SnapshotStoragePricing,
  TemplateRow,
} from "@wsp/protocol";

export type {
  DaemonSupervisor,
  ExecResult,
  LifecycleBudgets,
  MachineKind,
  MachineLife,
  MachineListRow,
  MachineShape,
  MachineSpec,
  MachineState,
  PreviewReach,
  SnapshotRow,
  SnapshotStoragePricing,
  TemplateRow,
};

export interface RunOptions {
  /** Past it the command's session is killed, pid and group, and the result is exit 124 with the output so far. */
  deadlineMs: number;
  /** Each complete line the command writes, stdout and stderr alike, as it is read. */
  onLine?: (line: string) => void;
  /** Between reads of the command's output; the backend's own pace unless a test shortens it. */
  pollMs?: number;
}



export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly streamUrl?: string;
  /** The labels the provider reported when this handle was made; absent on backends that carry none. */
  readonly labels?: Record<string, string>;
  /** The provider's view when get() made this handle, so a caller needs no second read; absent on a handle from
   * create(). Its createdAt moves on a running machine nobody touched (+306 s at ten minutes, canary 2026-09-04 UTC)
   * with no lifecycle event behind it, so nothing decides on it; state is the field worth reading. */
  readonly seen?: { state: MachineState; createdAt?: string };
  /** On a handle from create(): the provider answered from an earlier create under the same key instead of booting. */
  readonly replayed?: boolean;
  /** One short command; a backend's exec has a hard ceiling, so anything that can run longer goes through run(). */
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>; // always REST path
  /** A command that may run for minutes: started detached on the guest and read until it exits or the deadline
   * kills it; the result is shaped like exec's. */
  run(script: string, opts: RunOptions): Promise<ExecResult>;
  /** Answers when the provider holds the snapshot. A backend that refuses one of a resumed machine throws
   * NotFirstLifeError before any call; one whose snapshot copies the disk from any life ignores `life`. */
  snapshot(name: string, life: MachineLife): Promise<string>;
  pause(): Promise<void>;
  /** `signal` ends the call where the caller has stopped waiting on it, so a resume nobody is waiting on is not left
   * running behind them; the backend's own cap on how long it waits for an answer is its business, not the caller's. */
  resume(signal?: AbortSignal): Promise<void>;
  kill(): Promise<void>;
  state(): Promise<MachineState>;
  downloadUrl(path: string): Promise<string>;
  uploadUrl(path: string): Promise<string>;
  /** Optional: the backends that have a route to a guest port at all. */
  previewUrl?(port: number): Promise<PreviewReach>;
  /** Optional: whether the daemon inside the guest is listening, asked over the road this machine's own calls take
   * rather than by dialling a route from here. Present where a route this computer dials is not the truth about
   * the guest: a container's published port lands on the loopback of the computer its Docker daemon runs on, which
   * is not always the one asking, and a host that is not that computer reads silence off a live daemon. Absent
   * leaves the reach to previewUrl, which on a backend with a public edge is the same road a client takes. The
   * caller's bound is the whole call's, as it is on exec and putBytes. */
  daemonAnswers?(opts?: { timeoutMs?: number }): Promise<boolean>;
  /** Optional: where a process inside this machine dials the computer this host runs on, for the port that host
   * listens on. Only a backend whose machines have a road back to it answers: a container on this computer's own
   * daemon is created with a name for the gateway it reaches this computer through. Absent leaves the address the
   * host advertises, which is what a machine somewhere else dials. */
  hostUrl?(port: number): string;
  /** Optional: bytes onto the machine on a backend that mints no signed upload URL. `landBytes` is what reads it,
   * so no caller picks between the two roads itself. */
  putBytes?(path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<void>;
  /** Optional: what keeps a process running on this machine, read by the daemon deploy. Absent means the guest has
   * a service manager and the deploy registers a unit with it. */
  readonly daemonSupervisor?: DaemonSupervisor;
  /** Optional: backends that expose size and creation time per machine. */
  describe?(): Promise<MachineShape>;
  /** Optional: a machine that already existed before wsp says what it is; the status poll carries the answer. */
  facts?(): Promise<MachineFacts>;
  /** Optional: backends whose host reports live usage per machine. Answers when the host still knows the VM; a
   * missing answer while state() still says running is the host having lost it, ahead of the gateway's own record.
   * The numbers themselves are read nowhere yet, so none are typed. */
  metrics?(): Promise<void>;
}


/** What a size costs on this provider, and the shape a spec gets when it
 * names none. Local arithmetic until provider billing APIs are integrated. */
export interface BackendPricing {
  rateUsdPerHour(size: { cpu: number; memMb: number }): number;
  defaultSize: { cpu: number; memMb: number };
  snapshotStorage: SnapshotStoragePricing;
  /** The root disk every builder and fork asks for on this provider, in GiB; absent where a machine takes no disk
   * request at all (a container's disk is the box's, and a quota on one needs a filesystem most boxes do not run). */
  builderDiskGb?: number;
}


/** What the runtime reads to drive a machine through naps and wakes on this provider. Present exactly when the
 * capabilities carry a pauseMode; a registry test holds the two together. */
export interface Lifecycle {
  budgets: LifecycleBudgets;
  /** Optional: the instant by which the provider may stop this running machine if this host is gone, computed by
   * the runtime's own backstop policy and handed over whenever the idle window is armed, for a provider whose
   * backstop is pushed rather than set once at create. Never called for a machine the runtime has napped or
   * forgotten. Called from the policy's own arming and not awaited: a rejection is logged, and the backend decides
   * whether a given instant is worth a call, since the window is armed on every streamed chunk. */
  backstop?(machine: Machine, until: number): Promise<void>;
}

export interface MachineBackend {
  readonly capabilities: Capabilities;
  readonly pricing: BackendPricing;
  /** Present on every backend whose capabilities carry a pauseMode. */
  readonly lifecycle?: Lifecycle;
  /** Optional: what a machine of each kind boots from on this provider when nothing names a template. Absent leaves
   * the built-in names the engine knows. */
  readonly baseTemplates?: Readonly<Record<MachineKind, string>>;
  create(spec: MachineSpec): Promise<Machine>;
  /** Optional: only backends the person holds a key for. One cheap authenticated read that boots nothing and touches
   * no machine's idle clock, so a key the provider refuses is known before anything is saved or billed. Rejects with
   * the provider's own WspError; `checkProviderKey` is what reads that answer. */
  checkKey?(): Promise<void>;
  get(id: string): Promise<Machine>;
  /** size comes off the listing itself; a per-machine GET would reset that machine's idle timer. */
  list(labels?: Record<string, string>): Promise<MachineListRow[]>;
  deleteSnapshot(id: string): Promise<void>;
  /** Optional: what the computer holding this backend has left for one more machine. Only a backend on a computer
   * the person owns answers; a provider's room is its own cap and its own refusal. */
  capacity?(): Promise<PlaceCapacity>;
  /** Optional: only backends whose capabilities include snapshotListing have it. Every snapshot on the account, with its size. */
  listSnapshots?(): Promise<SnapshotRow[]>;
  /** Optional, the four together: only backends whose capabilities include templates have them. Promotes a snapshot
   * to a durable template under the name and answers the template's id; the snapshot stays and cannot be deleted
   * while the template exists. */
  promoteSnapshot?(snapshotId: string, name: string): Promise<string>;
  getTemplate?(id: string): Promise<TemplateRow>;
  /** Every template the account can boot from, the provider's built-ins included. */
  listTemplates?(): Promise<TemplateRow[]>;
  deleteTemplate?(id: string): Promise<void>;
}
